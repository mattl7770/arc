/**
 * The Protocols data layer: versioned stacks and routines, treated like code.
 *
 * The `protocols` row is the stable identity (slug never changes after
 * creation, like a repo name); every content change is a NEW immutable
 * `protocol_versions` row, and `current_version_id` points at what is live
 * (both tables ship in 0001_init.sql). Deleting a protocol cascades its
 * versions but SET-NULLs `log_entries.protocol_id`, so execution history is
 * never destroyed.
 *
 * THE MISSION-GENERATOR SEAM lives next door, in mission-generate.ts: it turns
 * the active protocols' live versions into a day's `log_entries`, picking each
 * protocol's live PHASE from `started_on` and each item's day from its cadence.
 * This repo owns the protocol records and the phase clock; it does not decide
 * what a day contains.
 *
 * Like every repository, this depends only on the {@link Database} interface —
 * never op-sqlite — so the same code runs on device and against node:sqlite in
 * db/protocols.test.mjs.
 */
import type { Database } from '../database';
import { todayISODate } from '../date';
import { newId } from '../id';
import type {
  Authorship,
  CheckoffMode,
  ProtocolRow,
  ProtocolType,
  ProtocolVersionRow,
  SqliteBool,
  Timestamp,
} from '../types';
import { allItems, parseProtocolContent } from '@/lib/protocols/content';
import { fieldPatch, rebaseContent, type ProtocolFields } from '@/lib/protocols/rebase';
import type { NewProtocol, ProtocolContent, ProtocolListItem } from '@/lib/protocols/types';

/**
 * `^[a-z0-9_]+$` from a display name — the repository owns the slug shape the
 * Postgres CHECK used to enforce (see the 0001 header note). A name with no
 * usable characters falls back to 'protocol'.
 */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base || 'protocol';
}

/** slug is UNIQUE — on collision, suffix _2, _3, … like a filename. */
function uniqueSlug(db: Database, name: string): string {
  const base = slugify(name);
  let slug = base;
  for (let n = 2; db.get('SELECT 1 FROM protocols WHERE slug = ?', [slug]); n++) {
    slug = `${base}_${n}`;
  }
  return slug;
}

/**
 * The un-transactioned inserts. Database.transaction is a plain BEGIN — it
 * does not nest — so every composed write below wraps exactly one transaction
 * around these; never call them outside one.
 */
function insertProtocolRow(db: Database, id: string, input: NewProtocol): void {
  db.run(
    `INSERT INTO protocols (id, slug, name, description, type, started_on, carry_over, checkoff_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      uniqueSlug(db, input.name),
      input.name.trim(),
      input.description ?? null,
      input.type,
      // Deliberately NULL unless the caller names a day: there is exactly ONE
      // place a phase clock gets anchored, {@link ensureStartedOn}, and it runs
      // at the top of every mission generation. So a protocol's phase 1 begins
      // on the first day it actually plans something, not on the day its record
      // was typed — which is the only reading that cannot start the user
      // mid-titration after a gap between creating a protocol and running it.
      // Only the editor passes a date, and only for a phased protocol.
      input.startedOn ?? null,
      // Execution policy (0050). Passed explicitly rather than left to the
      // column defaults so the create path and the edit path write the same
      // two facts through the same two arguments.
      input.carryOver === true ? 1 : 0,
      input.checkoffMode ?? 'strict',
    ]
  );
}

function insertVersionRow(
  db: Database,
  protocolId: string,
  content: ProtocolContent,
  changeNotes: string | null,
  createdBy: Authorship
): string {
  const id = newId(db);
  const row = db.get<{ next: number }>(
    'SELECT coalesce(max(version_number), 0) + 1 AS next FROM protocol_versions WHERE protocol_id = ?',
    [protocolId]
  );
  db.run(
    `INSERT INTO protocol_versions (id, protocol_id, version_number, content, change_notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, protocolId, row?.next ?? 1, JSON.stringify(content), changeNotes, createdBy]
  );
  db.run('UPDATE protocols SET current_version_id = ? WHERE id = ?', [id, protocolId]);
  return id;
}

/**
 * Create the protocol identity — active by default, no version yet
 * (`current_version_id` NULL until the first {@link addVersion}). Returns the
 * new protocol id. Prefer {@link createProtocolWithVersion} when the first
 * version is in hand, so a mid-sequence failure can't strand a version-less
 * protocol.
 */
export function createProtocol(db: Database, input: NewProtocol): string {
  const id = newId(db);
  insertProtocolRow(db, id, input);
  return id;
}

/**
 * Create the protocol AND its first version in ONE transaction — the editor's
 * create path. Either both rows land or neither does; a failure can't leave an
 * orphan protocol that a retry would duplicate. Returns the protocol id.
 */
export function createProtocolWithVersion(
  db: Database,
  input: NewProtocol,
  content: ProtocolContent,
  changeNotes: string | null = null,
  createdBy: Authorship = 'user'
): string {
  const id = newId(db);
  db.transaction(() => {
    insertProtocolRow(db, id, input);
    insertVersionRow(db, id, content, changeNotes, createdBy);
  });
  return id;
}

/**
 * Write a NEW immutable version — next version_number, content as JSON — and
 * bump `current_version_id` to it, in one transaction so the pointer can never
 * point at a version that failed to insert. Returns the new version id.
 * `createdBy` defaults to 'user'; the Coach's protocol tool will pass 'ai'.
 */
export function addVersion(
  db: Database,
  protocolId: string,
  content: ProtocolContent,
  changeNotes: string | null = null,
  createdBy: Authorship = 'user'
): string {
  let id = '';
  db.transaction(() => {
    id = insertVersionRow(db, protocolId, content, changeNotes, createdBy);
  });
  return id;
}

/** Everything one editor Save can change, applied atomically by {@link reviseProtocol}. */
export type ProtocolRevision = {
  name: string;
  type: ProtocolType;
  description: string | null;
  active: boolean;
  /** New version content, or null to leave the live version untouched. */
  content: ProtocolContent | null;
  /**
   * Where the phase clock is anchored (0043). Only the editor sets it, and only
   * for a protocol with more than one phase — that is the sole case where being
   * wrong about the start date changes what lands on a day. Omit to leave the
   * existing anchor alone.
   */
  startedOn?: string | null;
  /**
   * Execution policy (0050). Omit either to leave it alone — the Coach's
   * `update_protocol` revises the PLAN and has no business flipping how the
   * plan is run, so "unset" has to mean "unchanged" and not "back to default".
   */
  carryOver?: boolean;
  checkoffMode?: CheckoffMode;
  changeNotes?: string | null;
  createdBy?: Authorship;
};

/**
 * The editor's edit-path Save: identity fields, active flag, and (when
 * `content` is non-null) a new version, in ONE transaction — a failure rolls
 * everything back rather than leaving a renamed protocol with stale items.
 * Returns the new version id, or null when no version was written.
 */
export function reviseProtocol(
  db: Database,
  id: string,
  revision: ProtocolRevision
): string | null {
  let versionId: string | null = null;
  db.transaction(() => {
    db.run('UPDATE protocols SET name = ?, description = ?, type = ?, is_active = ? WHERE id = ?', [
      revision.name.trim(),
      revision.description ?? null,
      revision.type,
      revision.active ? 1 : 0,
      id,
    ]);
    // Anchoring is separate from the identity UPDATE so that omitting it means
    // "leave it alone" rather than "clear it" — clearing would restart a
    // titration on the next generation, which is the one thing a rename must
    // never do.
    if (revision.startedOn != null) {
      db.run('UPDATE protocols SET started_on = ? WHERE id = ?', [revision.startedOn, id]);
    } else if (revision.active) {
      db.run('UPDATE protocols SET started_on = ? WHERE id = ? AND started_on IS NULL', [
        todayISODate(),
        id,
      ]);
    }
    // Policy, same "omitted means unchanged" rule as the anchor above — and
    // deliberately OUTSIDE the version write: turning carry-over on is not a
    // revision of the plan, and must not write one.
    if (revision.carryOver !== undefined) {
      db.run('UPDATE protocols SET carry_over = ? WHERE id = ?', [revision.carryOver ? 1 : 0, id]);
    }
    if (revision.checkoffMode !== undefined) {
      db.run('UPDATE protocols SET checkoff_mode = ? WHERE id = ?', [revision.checkoffMode, id]);
    }
    if (revision.content !== null) {
      versionId = insertVersionRow(
        db,
        id,
        revision.content,
        revision.changeNotes ?? null,
        revision.createdBy ?? 'user'
      );
    }
  });
  return versionId;
}

/** What the one protocol editor (app/protocol-edit.tsx) hands its Save. */
export type ProtocolEdit = {
  /** The document the form opened on, canonical. */
  base: ProtocolContent;
  /** The document the form now holds, canonical, every id already minted. */
  content: ProtocolContent;
  /** Typed change notes, or null. A typed note forces a version: it is user data. */
  changeNotes: string | null;
  /** The row fields as the form opened on them. */
  opened: ProtocolFields;
  /** The row fields as the form now holds them. */
  fields: ProtocolFields;
};

export type ProtocolEditResult =
  | {
      ok: true;
      /** The new version's id, or null when the document did not change. */
      versionId: string | null;
      /** The row fields this save wrote — only the ones the form changed. */
      wrote: (keyof ProtocolFields)[];
    }
  | { ok: false; refusal: string };

const FIELD_COLUMNS: Record<keyof ProtocolFields, string> = {
  name: 'name',
  description: 'description',
  type: 'type',
  startedOn: 'started_on',
  carryOver: 'carry_over',
  checkoffMode: 'checkoff_mode',
};

/**
 * The row's editable fields, in the form's shape — the same trim the form
 * applies to what it writes, so a stored value and an untouched field compare
 * equal and Save stays inert at rest.
 */
export function protocolFieldsOf(row: ProtocolRow): ProtocolFields {
  return {
    name: row.name.trim(),
    description: row.description?.trim() || null,
    type: row.type,
    startedOn: row.started_on,
    carryOver: row.carry_over === 1,
    checkoffMode: row.checkoff_mode,
  };
}

/**
 * **The editor's Save: ONE transaction that writes only what changed**, onto the
 * protocol as it is at the moment of saving.
 *
 * The row and the live version are re-read inside the transaction, and the
 * form's changes are merged onto them by `rebaseContent` and `fieldPatch`
 * (src/lib/protocols/rebase.ts) — so a Coach edit approved while the form was
 * open is kept rather than reverted, and a change that collides with it is
 * refused with a sentence and writes nothing at all.
 *
 * What it writes, and nothing else:
 *   - a new version, only when the merged document differs from the live one or
 *     a note was typed — no no-op versions from opening a form and closing it;
 *   - each row field the form changed, one column at a time. A settings-only
 *     save therefore writes no version, and a document-only save leaves every
 *     row column byte-identical (db/protocols.test.mjs §12b, §12c).
 *
 * `is_active` is never written here: pausing is its own act
 * (src/lib/protocols/pause.ts). It never re-derives today either — that is the
 * caller's, after the commit, exactly as every other protocol write.
 */
export function saveProtocolEdit(
  db: Database,
  id: string,
  edit: ProtocolEdit
): ProtocolEditResult {
  let result: ProtocolEditResult = { ok: false, refusal: 'This protocol no longer exists.' };
  db.transaction(() => {
    const row = getProtocol(db, id);
    if (!row) return;
    const liveRow = getCurrentVersion(db, id);
    const live = parseProtocolContent(liveRow?.content ?? null);
    const merged = rebaseContent(edit.base, edit.content, live);
    if (!merged.ok) {
      result = merged;
      return;
    }
    const fields = fieldPatch(edit.opened, edit.fields, protocolFieldsOf(row));
    if (!fields.ok) {
      result = fields;
      return;
    }
    const wrote = Object.keys(fields.patch) as (keyof ProtocolFields)[];
    for (const key of wrote) {
      const value = fields.patch[key];
      // The column names come from the fixed table above, never from input.
      db.run(`UPDATE protocols SET ${FIELD_COLUMNS[key]} = ? WHERE id = ?`, [
        typeof value === 'boolean' ? (value ? 1 : 0) : (value ?? null),
        id,
      ]);
    }
    const notes = edit.changeNotes?.trim() || null;
    const changed = JSON.stringify(merged.content) !== JSON.stringify(live);
    const versionId =
      changed || notes !== null ? insertVersionRow(db, id, merged.content, notes, 'user') : null;
    result = { ok: true, versionId, wrote };
  });
  return result;
}

export function getProtocol(db: Database, id: string): ProtocolRow | undefined {
  return db.get<ProtocolRow>('SELECT * FROM protocols WHERE id = ?', [id]);
}

/** By its stable slug (how the Coach addresses a protocol). slug is UNIQUE. */
export function getProtocolBySlug(db: Database, slug: string): ProtocolRow | undefined {
  return db.get<ProtocolRow>('SELECT * FROM protocols WHERE slug = ?', [slug]);
}

/** The live version (what `current_version_id` points at), if any exists yet. */
export function getCurrentVersion(
  db: Database,
  protocolId: string
): ProtocolVersionRow | undefined {
  return db.get<ProtocolVersionRow>(
    `SELECT v.*
     FROM protocols p
     JOIN protocol_versions v ON v.id = p.current_version_id
     WHERE p.id = ?`,
    [protocolId]
  );
}

/**
 * Whether a version's content is a document this app can read AT ALL — i.e. it
 * carries a `phases` array (schema 2) or an `items` array (schema 1). Requires
 * the `protocol_versions` table to be aliased `v`.
 *
 * It exists so an item count can stay NULL — not 0 — for a foreign-shaped
 * version, which reads as an em-dash rather than as a fabricated zero. The
 * count itself is no longer a SQL expression: `parseProtocolContent` has to run
 * anyway to normalise a v1 document into phases, and a second, SQL-shaped
 * definition of "how many items" would be a second answer to the same question
 * the moment either schema moves again.
 *
 * `coalesce` on each side because `json_type` returns NULL for an absent path,
 * and `NULL OR 0` is NULL — which would make an ordinary v1 row look illegible.
 */
const CONTENT_LEGIBLE_COLUMN = `(coalesce(json_type(v.content, '$.phases') = 'array', 0)
             + coalesce(json_type(v.content, '$.items') = 'array', 0)) AS legible`;

/**
 * One row of the version-history screen: the immutable version record, its item
 * count, and its PARSED content.
 *
 * The content used to be withheld here on the argument that the history screen
 * reads the shape of each version and never its contents. That stopped being
 * true when the screen gained a diff between adjacent versions — which is the
 * whole payoff of keeping history — so the blob crosses the boundary now, once,
 * already normalised.
 */
export type ProtocolVersionListItem = {
  id: string;
  versionNumber: number;
  changeNotes: string | null;
  createdBy: Authorship;
  createdAt: Timestamp;
  /**
   * Items in that version's content across all phases, or null when the content
   * is not a document this app can read. Deliberately NOT coalesced to 0: an
   * absent count is not a count of none, and the screen draws the difference.
   */
  itemCount: number | null;
  /** Phases in that version — 1 for everything written before schema 2. */
  phaseCount: number;
  /** The normalised document, ready to diff against its neighbour. */
  content: ProtocolContent;
};

/**
 * The full version history of one protocol, **newest first** — what the version
 * screen reads. `version_number` is unique per protocol and monotonic, so it is
 * the real ordering; `created_at` only breaks a tie that the schema's UNIQUE
 * (protocol_id, version_number) already makes impossible, and is kept as a
 * belt-and-braces second key. Unknown protocol ids and version-less protocols
 * both read as [].
 */
export function listVersions(db: Database, protocolId: string): ProtocolVersionListItem[] {
  const rows = db.all<{
    id: string;
    version_number: number;
    change_notes: string | null;
    created_by: Authorship;
    created_at: Timestamp;
    content: string;
    legible: number;
  }>(
    `SELECT v.id, v.version_number, v.change_notes, v.created_by, v.created_at, v.content,
            ${CONTENT_LEGIBLE_COLUMN}
     FROM protocol_versions v
     WHERE v.protocol_id = ?
     ORDER BY v.version_number DESC, v.created_at DESC`,
    [protocolId]
  );
  return rows.map((r) => {
    const content = parseProtocolContent(r.content);
    return {
      id: r.id,
      versionNumber: r.version_number,
      changeNotes: r.change_notes,
      createdBy: r.created_by,
      createdAt: r.created_at,
      itemCount: r.legible > 0 ? allItems(content).length : null,
      phaseCount: content.phases.length,
      content,
    };
  });
}

/**
 * Every protocol for the hub — active first, then by name — each with its live
 * version number, item and phase counts, and the day its phase clock started.
 * Empty-safe.
 */
export function listProtocols(db: Database): ProtocolListItem[] {
  const rows = db.all<ProtocolRow & { version_number: number | null; content: string | null }>(
    `SELECT p.*, v.version_number AS version_number, v.content AS content
     FROM protocols p
     LEFT JOIN protocol_versions v ON v.id = p.current_version_id
     ORDER BY p.is_active DESC, p.name COLLATE NOCASE, p.id`
  );
  return rows.map((r) => {
    const content = r.content === null ? null : parseProtocolContent(r.content);
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      description: r.description,
      type: r.type,
      isActive: r.is_active === 1,
      versionNumber: r.version_number,
      itemCount: content === null ? 0 : allItems(content).length,
      phaseCount: content === null ? 0 : content.phases.length,
      startedOn: r.started_on,
      carryOver: r.carry_over === 1,
      checkoffMode: r.checkoff_mode,
      updatedAt: r.updated_at,
    };
  });
}

/**
 * Rename / re-describe / re-type the identity row. Deliberately NOT a new
 * version — versions snapshot content, not labels — and the slug stays stable
 * (it's the identity, like renaming a repo keeps its remotes).
 */
export function updateProtocolMeta(
  db: Database,
  id: string,
  meta: Pick<NewProtocol, 'name' | 'type' | 'description'>
): void {
  db.run('UPDATE protocols SET name = ?, description = ?, type = ? WHERE id = ?', [
    meta.name.trim(),
    meta.description ?? null,
    meta.type,
    id,
  ]);
}

/**
 * Pause / resume a protocol. Paused protocols keep every version.
 *
 * Resuming ANCHORS the phase clock if it has never been anchored (0043), and
 * deliberately leaves an existing anchor alone: pausing a titration for a
 * fortnight and resuming it must not put the user back on week 1 of a course
 * they are six weeks into. Restarting a phase clock is a start-date edit, and
 * the editor is where that lives.
 */
export function setActive(
  db: Database,
  id: string,
  active: boolean,
  today: string = todayISODate()
): void {
  const flag: SqliteBool = active ? 1 : 0;
  db.run('UPDATE protocols SET is_active = ? WHERE id = ?', [flag, id]);
  if (active) {
    db.run('UPDATE protocols SET started_on = ? WHERE id = ? AND started_on IS NULL', [today, id]);
  }
}

/** Move a protocol's phase clock. The editor's Start date field writes this. */
export function setStartedOn(db: Database, id: string, date: string): void {
  db.run('UPDATE protocols SET started_on = ? WHERE id = ?', [date, id]);
}

/**
 * Anchor every ACTIVE protocol whose phase clock has never been set, to `date`.
 *
 * Called at the top of both mission generation paths, so an active protocol's
 * phase 1 begins on the first day it actually plans something. That is the only
 * reading of a NULL anchor that cannot silently skip a phase: dating the clock
 * to a creation or an import the user never ran would start them mid-titration.
 *
 * Idempotent, and never touches a protocol that already has an anchor.
 */
export function ensureStartedOn(db: Database, date: string): void {
  db.run(
    'UPDATE protocols SET started_on = ? WHERE is_active = 1 AND started_on IS NULL',
    [date]
  );
}

/**
 * Make an OLD version live again, as a NEW version carrying its content.
 *
 * History is immutable, so "restore" cannot mean "move the pointer back": that
 * would leave the versions written since dangling above a live pointer that had
 * moved down, and the next save would collide with their numbers. It means
 * exactly what reverting a commit means — a new revision whose content is the
 * old content, authored by the user, with the note filled in.
 *
 * Content is re-normalised on the way through, so a restored v1 lands as a
 * canonical schema-2 document. That is lossless (v1 items are daily items in a
 * single open-ended phase, which is what they always were) and it keeps one
 * shape going forward.
 *
 * Returns the new version id, or null when the named version does not belong to
 * this protocol.
 */
export function restoreVersion(
  db: Database,
  protocolId: string,
  versionId: string,
  changeNotes?: string | null
): string | null {
  const target = db.get<{ version_number: number; content: string }>(
    'SELECT version_number, content FROM protocol_versions WHERE id = ? AND protocol_id = ?',
    [versionId, protocolId]
  );
  if (!target) return null;
  return addVersion(
    db,
    protocolId,
    parseProtocolContent(target.content),
    changeNotes ?? `Restored v${target.version_number}`,
    'user'
  );
}

/**
 * Delete a protocol and (via ON DELETE CASCADE) its versions. Execution
 * history survives by schema design: `log_entries.protocol_id` is ON DELETE
 * SET NULL, so logged days keep their entries, just unlinked.
 */
export function deleteProtocol(db: Database, id: string): void {
  db.run('DELETE FROM protocols WHERE id = ?', [id]);
}
