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
 * THE MISSION-GENERATOR SEAM (not built here, integrator territory): turning
 * the active protocols' live versions into a day's `log_entries` belongs next
 * to mission.ts / seed.ts and Home. This repo only owns the protocol records;
 * `ProtocolItem.scheduled_time` already matches `log_entries.scheduled_time`
 * so the generator is a mapping, not a migration.
 *
 * Like every repository, this depends only on the {@link Database} interface —
 * never op-sqlite — so the same code runs on device and against node:sqlite in
 * db/protocols.test.mjs.
 */
import type { Database } from '../database';
import { newId } from '../id';
import type {
  Authorship,
  ProtocolRow,
  ProtocolType,
  ProtocolVersionRow,
  SqliteBool,
} from '../types';
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
    `INSERT INTO protocols (id, slug, name, description, type)
     VALUES (?, ?, ?, ?, ?)`,
    [id, uniqueSlug(db, input.name), input.name.trim(), input.description ?? null, input.type]
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
 * Every protocol for the list screen — active first, then by name — each with
 * its live version number and item count (json1 counts `$.items` in SQL, so
 * the list never parses content). Empty-safe.
 */
export function listProtocols(db: Database): ProtocolListItem[] {
  const rows = db.all<ProtocolRow & { version_number: number | null; item_count: number | null }>(
    `SELECT p.*, v.version_number AS version_number,
            json_array_length(v.content, '$.items') AS item_count
     FROM protocols p
     LEFT JOIN protocol_versions v ON v.id = p.current_version_id
     ORDER BY p.is_active DESC, p.name COLLATE NOCASE, p.id`
  );
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    type: r.type,
    isActive: r.is_active === 1,
    versionNumber: r.version_number,
    itemCount: r.item_count ?? 0,
    updatedAt: r.updated_at,
  }));
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

/** Pause / resume a protocol. Paused protocols keep every version. */
export function setActive(db: Database, id: string, active: boolean): void {
  const flag: SqliteBool = active ? 1 : 0;
  db.run('UPDATE protocols SET is_active = ? WHERE id = ?', [flag, id]);
}

/**
 * Delete a protocol and (via ON DELETE CASCADE) its versions. Execution
 * history survives by schema design: `log_entries.protocol_id` is ON DELETE
 * SET NULL, so logged days keep their entries, just unlinked.
 */
export function deleteProtocol(db: Database, id: string): void {
  db.run('DELETE FROM protocols WHERE id = ?', [id]);
}
