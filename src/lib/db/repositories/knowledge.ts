/**
 * The knowledge base (0038) — the browsable, writable reference the Coach cites
 * (docs/knowledge-subapp.md).
 *
 * Two stores, one table for retrieval:
 *
 *   `knowledge_entries`  the AUTHORING unit. Documents the user writes, imports
 *                        from an article, or approves the Coach saving. Browsed,
 *                        edited, archived, restored — always round-tripped
 *                        verbatim.
 *   `knowledge_chunks`   the RETRIEVAL unit (0025), now fed by two owners: the
 *                        curated pack (src/lib/rag/corpus.ts) and entries. Chunks
 *                        are cheap DERIVED data — deleted and re-derived freely,
 *                        never authored directly.
 *
 * ## The ownership invariant (0038's header; pinned by db/knowledge.test.mjs)
 *
 *   pack chunks   source = 'arc-longevity-v1'   entry_id NULL       pack_version NOT NULL
 *   entry chunks  source = 'user-knowledge'     entry_id NOT NULL   pack_version NULL
 *
 * Everything this module writes uses {@link USER_KNOWLEDGE_SOURCE} and always
 * sets `entryId`, so `ingestCorpus`'s `DELETE ... WHERE source = 'arc-longevity-v1'`
 * can never reach a row written here. That is the one thing in this feature that
 * must not be got wrong: a pack version bump is a routine event, and a routine
 * event that silently eats the user's own writing is unrecoverable.
 *
 * ## Replace-by-entry, and why this is synchronous
 *
 * Editing an entry replaces its chunks wholesale (`ingestMemory`'s exact shape
 * with `entry_id` as the origin key instead of `(origin_table, origin_id)`).
 * Unlike `ingestMemory` this is SYNCHRONOUS and never calls the embedder, for
 * the same reason `ingestCorpus` doesn't: content is stored always, vectors are
 * backfilled when the embedder ships (docs/rag-embeddings.md), and one backfill
 * sweep over `knowledge_chunks` covers pack and entry rows alike with no
 * knowledge-specific work. Vectors are only ever DELETED here — guarded, and a
 * no-op wherever vec0 is absent.
 *
 * Depends only on the {@link Database} interface — never op-sqlite — so the same
 * code runs on device and against node:sqlite in db/knowledge.test.mjs.
 */
import type { Database } from '../database';
import { newId } from '../id';
import type { Timestamp } from '../types';
import { queryTerms } from '@/lib/ai/history-search';
import { chunkText, estimateTokens } from '@/lib/rag/chunk';
import { CORPUS_SOURCE } from '@/lib/rag/corpus';
import { deleteVectors, insertKnowledgeChunk } from './rag';

/**
 * The `knowledge_chunks.source` value every user-owned chunk carries — a
 * reserved constant, deliberately NOT a pack id. The pack's replacement query
 * filters on its own source, so this value is the firewall.
 */
export const USER_KNOWLEDGE_SOURCE = 'user-knowledge';

/** How an entry got here (0038 CHECK vocabulary). */
export type KnowledgeEntrySource = 'user' | 'import' | 'coach';

/**
 * Which half of the base an entry belongs to (0044 CHECK vocabulary).
 *
 *   'scientific'  how the WORLD works — the shipped pack's subject matter, an
 *                 imported article, a stance the user commits to.
 *   'personal'    a page about THE USER — a surgical history, how he reacts to
 *                 something, a constraint he has settled on.
 *
 * Orthogonal to {@link KnowledgeEntrySource}: where a document came from and
 * what it is about are two questions, and a personal entry can be written,
 * saved from a Coach turn, or (rarely) imported.
 *
 * The relationship to `coach_memories` (0030) is INDEX and FILE, not overlap: a
 * one-line fact the Coach must never have to look up is a memory, injected into
 * every turn; a page about the user, too long to carry every turn, is a personal
 * entry, retrieved when it is relevant. See 0044's header for why merging the
 * two stores would have to break one of them.
 */
export type KnowledgeSection = 'scientific' | 'personal';

/** The two sections, in the order the hub draws them. */
export const KNOWLEDGE_SECTIONS = ['personal', 'scientific'] as const;

export type KnowledgeEntryRow = {
  id: string;
  title: string;
  topic: string;
  body: string;
  section: KnowledgeSection;
  source: KnowledgeEntrySource;
  source_url: string | null;
  source_author: string | null;
  source_note: string | null;
  archived_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type NewKnowledgeEntry = {
  title: string;
  topic?: string;
  body: string;
  /** Defaults to 'scientific' — the DB default, and the honest one. */
  section?: KnowledgeSection;
  source?: KnowledgeEntrySource;
  sourceUrl?: string | null;
  sourceAuthor?: string | null;
  sourceNote?: string | null;
};

/**
 * One entry of the shipped reference pack, reconstituted from its chunk row.
 *
 * The pack is ingested one row per entry (corpus.ts passes each whole body to
 * `insertKnowledgeChunk` rather than through `chunkText`), so a pack entry IS a
 * chunk and its identity is that chunk's id. If the pack ever grows entries long
 * enough to want real chunking, this becomes a group-by — which is exactly why
 * the reader takes a `kind` rather than assuming ids are interchangeable.
 */
export type PackEntry = {
  id: string;
  title: string;
  topic: string;
  body: string;
  pack_version: string | null;
};

/**
 * The topics the editor offers as chips: the pack's eight, plus every topic a
 * user entry already uses. Data-owned vocabulary (0038 leaves `topic` free
 * text), so this is a query and not a constant.
 */
export const PACK_TOPICS = [
  'cardiovascular',
  'recovery',
  'training',
  'sleep',
  'metabolic',
  'method',
  'supplements',
  'lifestyle',
] as const;

// --- Normalization ------------------------------------------------------------

/** Trim + collapse a title to one line. Throws on empty (the DB CHECK agrees). */
function normalizeTitle(title: string): string {
  const trimmed = title.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) throw new Error('An entry needs a title.');
  return trimmed;
}

/**
 * The body, trimmed but otherwise UNTOUCHED — blank lines and paragraph breaks
 * are the document's structure and the reader renders them. (The chunker
 * normalizes whitespace on its own copy; that is the derived data's business,
 * not the entry's.)
 */
function normalizeBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) throw new Error('An entry needs a body.');
  return trimmed;
}

/** Lowercase single-word-ish topic; empty falls back to 'other' (the default). */
function normalizeTopic(topic: string | undefined): string {
  const trimmed = (topic ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return trimmed === '' ? 'other' : trimmed;
}

/**
 * The section, defaulting to 'scientific'. Unlike `topic`, this vocabulary is
 * CLOSED (a 0044 CHECK), so an unrecognised value falls back rather than
 * reaching the database — an entry filed under a typo would be invisible in
 * both sections, which is worse than being filed in the commoner one.
 */
function normalizeSection(section: string | undefined): KnowledgeSection {
  return section === 'personal' ? 'personal' : 'scientific';
}

function nullable(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// --- Chunk derivation (replace-by-entry) --------------------------------------

/** The chunk ids derived from one entry — so vectors can be cleared by id. */
export function chunkIdsForEntry(db: Database, entryId: string): string[] {
  return db
    .all<{ id: string }>(`SELECT id FROM knowledge_chunks WHERE entry_id = ?`, [entryId])
    .map((r) => r.id);
}

/**
 * Drop an entry's derived chunks — vectors FIRST (they are keyed by chunk id and
 * live in a virtual table no foreign key can reach), then the content rows.
 * Order matters: once the content rows are gone their ids are unrecoverable and
 * the vectors would be orphaned forever.
 */
export function clearEntryChunks(db: Database, entryId: string): void {
  const ids = chunkIdsForEntry(db, entryId);
  if (ids.length === 0) return;
  deleteVectors(db, ids);
  db.run(`DELETE FROM knowledge_chunks WHERE entry_id = ?`, [entryId]);
}

/**
 * Re-derive one entry's chunks from its current body: clear, then insert the
 * passages in order. Returns how many chunks the entry now has.
 *
 * The `ingestMemory` mirror — replace by origin, never append — so an edit can
 * never leave a stale passage behind to be retrieved and cited. Caller supplies
 * the transaction; every mutator below wraps this.
 *
 * Takes the four fields it derives from rather than a whole row, so a caller
 * mid-insert (which has no row to read back yet) passes exactly what it knows.
 */
export function rechunkEntry(
  db: Database,
  entry: { id: string; title: string; topic: string; body: string }
): number {
  clearEntryChunks(db, entry.id);
  const chunks = chunkText(entry.body);
  for (const chunk of chunks) {
    insertKnowledgeChunk(db, {
      source: USER_KNOWLEDGE_SOURCE,
      packVersion: null,
      entryId: entry.id,
      title: entry.title,
      topic: entry.topic,
      body: chunk.text,
      chunkIndex: chunk.index,
      tokenEstimate: estimateTokens(chunk.text),
    });
  }
  return chunks.length;
}

// --- Writes -------------------------------------------------------------------

/**
 * Write a new entry and its chunks in ONE transaction — an entry that exists
 * without its chunks is invisible to every reader that matters (the Coach's
 * `search_history` today, `search_knowledge` later), which is a worse state than
 * not having saved at all.
 *
 * Returns the new entry's id. Shared by the editor, the import review screen and
 * the Coach's `save_knowledge_entry` tool: one write path, three doors.
 */
export function saveKnowledgeEntry(db: Database, input: NewKnowledgeEntry): string {
  const title = normalizeTitle(input.title);
  const body = normalizeBody(input.body);
  const topic = normalizeTopic(input.topic);
  const section = normalizeSection(input.section);
  const id = newId(db);
  db.transaction(() => {
    db.run(
      `INSERT INTO knowledge_entries
         (id, title, topic, body, section, source, source_url, source_author, source_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        title,
        topic,
        body,
        section,
        input.source ?? 'user',
        nullable(input.sourceUrl),
        nullable(input.sourceAuthor),
        nullable(input.sourceNote),
      ]
    );
    rechunkEntry(db, { id, title, topic, body });
  });
  return id;
}

export type KnowledgeEntryPatch = {
  title?: string;
  topic?: string;
  body?: string;
  /** Re-filing an entry from one section to the other (0044). */
  section?: KnowledgeSection;
};

/**
 * Edit an entry: update the row, then replace its chunks from the NEW body.
 * Returns false when the id is unknown (the caller reports honestly rather than
 * claiming a phantom success).
 *
 * Re-chunks on ANY change, not only a body change: `title` and `topic` are
 * copied onto every chunk row as citation metadata, so a renamed entry whose
 * chunks kept the old title would be cited under a name the user no longer sees.
 */
export function updateKnowledgeEntry(
  db: Database,
  id: string,
  patch: KnowledgeEntryPatch
): boolean {
  const existing = getKnowledgeEntry(db, id);
  if (!existing) return false;
  const title = patch.title === undefined ? existing.title : normalizeTitle(patch.title);
  const body = patch.body === undefined ? existing.body : normalizeBody(patch.body);
  const topic = patch.topic === undefined ? existing.topic : normalizeTopic(patch.topic);
  // Re-filing is a plain UPDATE and deliberately nothing more: the section is a
  // property of the ENTRY, and the derived chunks never carry it — retrieval
  // joins back for it (src/lib/ai/history-search.ts). So moving an entry between
  // sections cannot leave a stale copy behind in the other one.
  const section = patch.section === undefined ? existing.section : normalizeSection(patch.section);

  db.transaction(() => {
    db.run(
      `UPDATE knowledge_entries SET title = ?, topic = ?, body = ?, section = ? WHERE id = ?`,
      [title, topic, body, section, id]
    );
    // Archived entries stay chunk-less until restored — editing one must not
    // resurrect it into search behind the user's back.
    if (existing.archived_at === null) rechunkEntry(db, { id, title, topic, body });
  });
  return true;
}

/**
 * Archive an entry — a SOFT delete that keeps the document and drops its chunks.
 *
 * Deleting the chunks is what makes archiving mean something: it makes EVERY
 * downstream reader — `searchUserHistory` today, `search_knowledge` when the
 * embedder ships, anything added later — automatically blind to retracted
 * doctrine with zero query changes and no `archived_at` join to remember. Chunks
 * are cheap derived data; restore re-derives them.
 *
 * Returns false when the id is unknown or already archived.
 */
export function archiveKnowledgeEntry(db: Database, id: string): boolean {
  const row = db.get<{ id: string }>(
    `SELECT id FROM knowledge_entries WHERE id = ? AND archived_at IS NULL`,
    [id]
  );
  if (!row) return false;
  db.transaction(() => {
    db.run(
      `UPDATE knowledge_entries SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      [id]
    );
    clearEntryChunks(db, id);
  });
  return true;
}

/** Restore an archived entry and re-derive its chunks. False if not archived. */
export function restoreKnowledgeEntry(db: Database, id: string): boolean {
  const entry = db.get<KnowledgeEntryRow>(
    `SELECT * FROM knowledge_entries WHERE id = ? AND archived_at IS NOT NULL`,
    [id]
  );
  if (!entry) return false;
  db.transaction(() => {
    db.run(`UPDATE knowledge_entries SET archived_at = NULL WHERE id = ?`, [id]);
    rechunkEntry(db, { id, title: entry.title, topic: entry.topic, body: entry.body });
  });
  return true;
}

/**
 * Permanently delete an entry. Vectors go by id FIRST (vec0 is a virtual table —
 * no foreign key reaches it), then the entry row, and the `ON DELETE CASCADE` on
 * `knowledge_chunks.entry_id` takes the content chunks.
 *
 * The cascade is the belt: even a caller that bypasses this function cannot
 * leave retrievable chunks behind for a retracted entry.
 */
export function deleteKnowledgeEntry(db: Database, id: string): void {
  db.transaction(() => {
    const ids = chunkIdsForEntry(db, id);
    if (ids.length > 0) deleteVectors(db, ids);
    db.run(`DELETE FROM knowledge_entries WHERE id = ?`, [id]);
  });
}

// --- Reads --------------------------------------------------------------------

export function getKnowledgeEntry(db: Database, id: string): KnowledgeEntryRow | undefined {
  return db.get<KnowledgeEntryRow>(`SELECT * FROM knowledge_entries WHERE id = ?`, [id]);
}

/**
 * The hub's keyword filter — DELIBERATELY not `searchUserHistory`.
 *
 * That function is the Coach's cross-source recall tool, ranking six stores
 * against each other; this is one screen filtering the two lists it draws. A row
 * matches when it contains ANY term, and ranks by how many DISTINCT terms it
 * contains — the same rule as `searchUserHistory`, so the two never disagree
 * about what "matches" means, without the hub inheriting a tool's concerns.
 *
 * Terms come from `queryTerms` (the one splitter), and the LIKEs are
 * parameterised — never interpolated.
 */
function termFilter(terms: string[], columns: string[]): { where: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  for (const column of columns) {
    for (const term of terms) {
      clauses.push(`lower(${column}) LIKE ?`);
      params.push(`%${term}%`);
    }
  }
  return { where: clauses.join(' OR '), params };
}

/** Distinct terms present across an entry's searchable text. */
function termScore(terms: string[], ...fields: (string | null)[]): number {
  const haystack = fields
    .filter((f): f is string => f !== null)
    .join(' ')
    .toLowerCase();
  return terms.filter((t) => haystack.includes(t)).length;
}

/**
 * Active entries, most recently updated first — the hub's per-section order.
 * `section` narrows to one half of the base (0044) and is what the hub's two
 * runs are drawn from; omitting it returns both, which is what the Archived
 * section at the foot wants — an archived entry is out of every search either
 * way, so splitting the foot by section would be three headings saying one
 * thing. `archived` flips to that foot; `query` filters and re-ranks by
 * distinct-term count.
 */
export function listKnowledgeEntries(
  db: Database,
  opts: {
    archived?: boolean;
    limit?: number;
    query?: string;
    section?: KnowledgeSection;
  } = {}
): KnowledgeEntryRow[] {
  const archived = opts.archived ?? false;
  const limit = opts.limit ?? 500;
  const terms = queryTerms(opts.query ?? '');
  // Parameterised, never interpolated — and narrowed to the closed vocabulary
  // by the type, so a caller cannot ask for a section the CHECK forbids.
  const sectionWhere = opts.section ? ' AND section = ?' : '';
  const sectionParams = opts.section ? [opts.section] : [];
  // `archived` is an internal boolean, never user input — the ternaries below
  // pick between two fixed literals, not between caller-supplied SQL.
  const state = archived ? 'NOT NULL' : 'NULL';
  // Timestamps are millisecond-precision, so two rows written in the same
  // millisecond tie. `created_at` is the second key so such a tie falls back to
  // something MEANINGFUL (creation order) rather than to `id`, which is a random
  // UUID and would order them arbitrarily. `id` stays last only to make the sort
  // total, so a list can never reshuffle between two renders of the same data.
  // (No human produces that tie; a seeded fixture or an import loop does.)
  const order = archived ? 'archived_at DESC, created_at DESC' : 'updated_at DESC, created_at DESC';

  if (terms.length === 0) {
    return db.all<KnowledgeEntryRow>(
      `SELECT * FROM knowledge_entries
       WHERE archived_at IS ${state}${sectionWhere}
       ORDER BY ${order}, id
       LIMIT ?`,
      [...sectionParams, limit]
    );
  }

  const { where, params } = termFilter(terms, ['title', 'topic', 'body']);
  const rows = db.all<KnowledgeEntryRow>(
    `SELECT * FROM knowledge_entries
     WHERE archived_at IS ${state}${sectionWhere} AND (${where})
     ORDER BY ${order}, id`,
    [...sectionParams, ...params]
  );
  return rows
    .map((row) => ({ row, score: termScore(terms, row.title, row.topic, row.body) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.row);
}

/** How many entries the user has written (the Data-tab row's tally). */
export function countKnowledgeEntries(db: Database): number {
  return (
    db.get<{ c: number }>(
      `SELECT count(*) c FROM knowledge_entries WHERE archived_at IS NULL`
    )?.c ?? 0
  );
}

/** The shipped reference pack, entry by entry, in pack order (filtered by `query`). */
export function listPackEntries(db: Database, query = ''): PackEntry[] {
  const terms = queryTerms(query);
  if (terms.length === 0) {
    return db.all<PackEntry>(
      `SELECT id, title, topic, body, pack_version FROM knowledge_chunks
       WHERE source = ? AND entry_id IS NULL
       ORDER BY chunk_index, id`,
      [CORPUS_SOURCE]
    );
  }
  const { where, params } = termFilter(terms, ['title', 'topic', 'body']);
  const rows = db.all<PackEntry>(
    `SELECT id, title, topic, body, pack_version FROM knowledge_chunks
     WHERE source = ? AND entry_id IS NULL AND (${where})
     ORDER BY chunk_index, id`,
    [CORPUS_SOURCE, ...params]
  );
  return rows
    .map((row) => ({ row, score: termScore(terms, row.title, row.topic, row.body) }))
    .sort((a, b) => b.score - a.score)
    .map((r) => r.row);
}

/** One pack entry by its chunk id (the reader's `kind='pack'` path). */
export function getPackEntry(db: Database, id: string): PackEntry | undefined {
  return db.get<PackEntry>(
    `SELECT id, title, topic, body, pack_version FROM knowledge_chunks
     WHERE id = ? AND source = ? AND entry_id IS NULL`,
    [id, CORPUS_SOURCE]
  );
}

/**
 * Every topic in use, pack + entries, for the editor's chips. The pack's eight
 * are seeded unconditionally so the chips are the same before and after the
 * corpus has been ingested; user topics are appended in use order.
 */
export function listKnowledgeTopics(db: Database): string[] {
  const topics = new Set<string>(PACK_TOPICS);
  for (const row of db.all<{ topic: string | null }>(
    `SELECT DISTINCT topic FROM knowledge_entries WHERE topic IS NOT NULL`
  )) {
    if (row.topic) topics.add(row.topic);
  }
  for (const row of db.all<{ topic: string | null }>(
    `SELECT DISTINCT topic FROM knowledge_chunks WHERE source = ? AND topic IS NOT NULL`,
    [CORPUS_SOURCE]
  )) {
    if (row.topic) topics.add(row.topic);
  }
  return [...topics];
}
