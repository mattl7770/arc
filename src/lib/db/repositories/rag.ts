/**
 * RAG data layer (docs/rag-embeddings.md §5) — two halves with different testability:
 *
 *  - CHUNK CONTENT (regular tables `knowledge_chunks` / `memory_chunks`, 0025):
 *    plain CRUD over the {@link Database} interface, so it runs on device AND
 *    against node:sqlite in db/rag.test.mjs like every other repository.
 *
 *  - VECTORS (the `sqlite-vec` `vec0` virtual table `vec_chunks`): op-sqlite has
 *    `vec0`; node:sqlite does not — every statement here would throw "no such
 *    module: vec0" headless. So the vector table is created LAZILY on-device
 *    ({@link ensureVectorTable}, `CREATE VIRTUAL TABLE IF NOT EXISTS`) and every
 *    vector op is GUARDED (try/catch) to no-op where vec0 is absent — the same
 *    degrade-don't-crash contract as the HealthKit / notification seams. A KNN
 *    hit returns only `chunk_id` + `distance`; the text is joined back from the
 *    content tables by id.
 *
 * DDL/queries follow the sqlite-vec reference: TEXT PRIMARY KEY as the join id
 * (vec0 keeps its own rowid mapping), a `corpus` PARTITION KEY, cosine distance,
 * JSON-string vector binding, and `MATCH ... AND k = ?` for KNN. Vector width is
 * {@link EMBED_DIM} (EmbeddingGemma). Confirm the bundled sqlite-vec with
 * `select vec_version()` on the first dev build before trusting edge syntax.
 */
import type { Database } from '../database';
import { newId } from '../id';
import { EMBED_DIM } from '@/lib/rag/embedder';
import type { Corpus, KnowledgeChunkRow, MemoryChunkRow, MemoryKind } from '@/lib/rag/types';

// --- Chunk content (regular tables — testable everywhere) ---------------------

export type NewKnowledgeChunk = {
  source: string;
  packVersion?: string | null;
  title?: string | null;
  topic?: string | null;
  body: string;
  chunkIndex?: number;
  tokenEstimate?: number | null;
  /**
   * The `knowledge_entries` row this passage was derived from (0035), for chunks
   * the USER owns. Pack chunks leave it null and carry `packVersion` instead —
   * the two-owner split that makes `ingestCorpus`'s DELETE-by-source
   * structurally unable to eat user content. See 0035's header; pinned by
   * db/knowledge.test.mjs.
   */
  entryId?: string | null;
};

/** Insert one knowledge passage; returns its id (also the vec0 join key). */
export function insertKnowledgeChunk(db: Database, chunk: NewKnowledgeChunk): string {
  const id = newId(db);
  db.run(
    `INSERT INTO knowledge_chunks
       (id, source, pack_version, title, topic, body, chunk_index, token_estimate, entry_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      chunk.source,
      chunk.packVersion ?? null,
      chunk.title ?? null,
      chunk.topic ?? null,
      chunk.body,
      chunk.chunkIndex ?? 0,
      chunk.tokenEstimate ?? null,
      chunk.entryId ?? null,
    ]
  );
  return id;
}

export type NewMemoryChunk = {
  kind: MemoryKind;
  originTable?: string | null;
  originId?: string | null;
  refDate?: string | null;
  body: string;
  tokenEstimate?: number | null;
};

/** Insert one memory passage; returns its id (also the vec0 join key). */
export function insertMemoryChunk(db: Database, chunk: NewMemoryChunk): string {
  const id = newId(db);
  db.run(
    `INSERT INTO memory_chunks
       (id, kind, origin_table, origin_id, ref_date, body, token_estimate)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      chunk.kind,
      chunk.originTable ?? null,
      chunk.originId ?? null,
      chunk.refDate ?? null,
      chunk.body,
      chunk.tokenEstimate ?? null,
    ]
  );
  return id;
}

/** Fetch knowledge chunks by id, preserving the caller's id order (KNN rank). */
export function getKnowledgeChunks(db: Database, ids: string[]): KnowledgeChunkRow[] {
  return fetchByIds<KnowledgeChunkRow>(db, 'knowledge_chunks', ids);
}

/** Fetch memory chunks by id, preserving the caller's id order (KNN rank). */
export function getMemoryChunks(db: Database, ids: string[]): MemoryChunkRow[] {
  return fetchByIds<MemoryChunkRow>(db, 'memory_chunks', ids);
}

function fetchByIds<T extends { id: string }>(db: Database, table: string, ids: string[]): T[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  // `table` is a fixed internal literal, never user/model input.
  const rows = db.all<T>(`SELECT * FROM ${table} WHERE id IN (${placeholders})`, ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Reorder to the requested id order (SQL IN doesn't preserve it) and drop misses.
  return ids.map((id) => byId.get(id)).filter((r): r is T => r !== undefined);
}

/**
 * The memory chunks derived from one source row (for re-ingestion: delete these
 * chunks + their vectors, then re-insert). Returns ids so the caller can also
 * clear the vectors.
 */
export function memoryChunkIdsForOrigin(
  db: Database,
  originTable: string,
  originId: string
): string[] {
  return db
    .all<{ id: string }>(`SELECT id FROM memory_chunks WHERE origin_table = ? AND origin_id = ?`, [
      originTable,
      originId,
    ])
    .map((r) => r.id);
}

/** Delete memory chunks by id (content side; clear vectors separately). */
export function deleteMemoryChunks(db: Database, ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  db.run(`DELETE FROM memory_chunks WHERE id IN (${placeholders})`, ids);
}

/** Count content chunks in a corpus (the "is there anything to search" probe). */
export function countChunks(db: Database, corpus: Corpus): number {
  const table = corpus === 'knowledge' ? 'knowledge_chunks' : 'memory_chunks';
  return db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? 0;
}

// --- Vectors (vec0 — guarded, device-only) ------------------------------------

const VEC_TABLE = 'vec_chunks';

/**
 * The vec0 DDL, built with {@link EMBED_DIM} so the stored width can't drift
 * from the embedder. `chunk_size=512` (must be divisible by 8) suits a modest
 * on-device corpus; `distance_metric=cosine` matches normalized embeddings.
 */
const CREATE_VEC_TABLE =
  `CREATE VIRTUAL TABLE IF NOT EXISTS ${VEC_TABLE} USING vec0(\n` +
  `  chunk_id TEXT PRIMARY KEY,\n` +
  `  corpus TEXT PARTITION KEY,\n` +
  `  source TEXT,\n` +
  `  embedding FLOAT[${EMBED_DIM}] DISTANCE_METRIC=cosine,\n` +
  `  chunk_size=512\n` +
  `)`;

/** Once probed, cache whether vec0 exists so we don't try/catch on every call. */
let vectorTableReady: boolean | undefined;

/**
 * Create the vec0 table if it doesn't exist. Returns true where vec0 is
 * available (on device), false where it isn't (node/tests, or a build
 * predating op-sqlite) — never throws. Call once at RAG init before any
 * vector op.
 */
export function ensureVectorTable(db: Database): boolean {
  if (vectorTableReady !== undefined) return vectorTableReady;
  try {
    db.run(CREATE_VEC_TABLE);
    vectorTableReady = true;
  } catch (error) {
    // "no such module: vec0" is the EXPECTED off-device / node:sqlite case —
    // degrade quietly. ANY OTHER error means the bundled sqlite-vec rejected
    // this DDL (e.g. a version-sensitive PARTITION KEY / metadata column — see
    // the header caveat): surface THAT loudly, because it would otherwise
    // silently disable RAG forever even after the model ships, with no clue why.
    const message = error instanceof Error ? error.message : String(error);
    if (!/no such module: vec0/i.test(message)) {
      console.warn('[rag] vec0 table CREATE failed unexpectedly — RAG disabled:', message);
    }
    vectorTableReady = false;
  }
  return vectorTableReady;
}

/** Test-only: forget the cached probe so a fresh DB re-probes. */
export function resetVectorTableProbe(): void {
  vectorTableReady = undefined;
}

/**
 * Store (replace) the vector for a chunk. vec0 has no UPDATE, so delete-then-
 * insert. Guarded: a no-op where vec0 is absent. `embedding` is bound as a JSON
 * string (the sqlite-vec-documented path).
 */
export function upsertVector(
  db: Database,
  args: { chunkId: string; corpus: Corpus; source: string; embedding: number[] }
): boolean {
  if (!ensureVectorTable(db)) return false;
  try {
    db.run(`DELETE FROM ${VEC_TABLE} WHERE chunk_id = ?`, [args.chunkId]);
    db.run(`INSERT INTO ${VEC_TABLE}(chunk_id, corpus, source, embedding) VALUES (?, ?, ?, ?)`, [
      args.chunkId,
      args.corpus,
      args.source,
      JSON.stringify(args.embedding),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Delete vectors by chunk id (paired with content deletion). Guarded. */
export function deleteVectors(db: Database, ids: string[]): void {
  if (ids.length === 0 || !ensureVectorTable(db)) return;
  try {
    const placeholders = ids.map(() => '?').join(', ');
    db.run(`DELETE FROM ${VEC_TABLE} WHERE chunk_id IN (${placeholders})`, ids);
  } catch {
    // no-op off-device
  }
}

export type VectorHit = { chunkId: string; source: string; distance: number };

/**
 * K-nearest chunks to `queryVec` within a corpus, closest first. Returns [] when
 * vec0 is absent (off-device) — callers then report "not available". The query
 * vector binds as a JSON string; `k = ?` is the version-portable KNN form.
 */
export function knnSearch(
  db: Database,
  args: { corpus: Corpus; queryVec: number[]; k: number }
): VectorHit[] {
  if (!ensureVectorTable(db)) return [];
  try {
    return db.all<VectorHit>(
      `SELECT chunk_id AS chunkId, source, distance
       FROM ${VEC_TABLE}
       WHERE embedding MATCH ? AND corpus = ? AND k = ?
       ORDER BY distance`,
      [JSON.stringify(args.queryVec), args.corpus, args.k]
    );
  } catch {
    return [];
  }
}
