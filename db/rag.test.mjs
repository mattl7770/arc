/**
 * Headless test of the RAG layer against real SQLite via node:sqlite:
 *   - chunk-content CRUD (regular tables 0025) — runs everywhere;
 *   - the vec0 vector layer's GUARDED degradation — node:sqlite has no `vec0`
 *     module, so ensureVectorTable/knnSearch/upsertVector must no-op (never
 *     throw), exactly as they will off a dev build;
 *   - the embedder's pure preprocessing (prompts, L2 normalize, MRL truncate);
 *   - retrieval + the search_knowledge tool + memory ingestion degrading
 *     honestly to "not available" while still persisting chunk content.
 * op-sqlite and the ONNX model are never loaded. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  countChunks,
  deleteMemoryChunks,
  ensureVectorTable,
  getKnowledgeChunks,
  getMemoryChunks,
  insertKnowledgeChunk,
  insertMemoryChunk,
  knnSearch,
  memoryChunkIdsForOrigin,
  resetVectorTableProbe,
  upsertVector,
} from '../src/lib/db/repositories/rag.ts';
import {
  documentPrompt,
  embedderStatus,
  embedQuery,
  EMBED_DIM,
  l2normalize,
  queryPrompt,
  truncateEmbedding,
} from '../src/lib/rag/embedder.ts';
import { retrievePassages } from '../src/lib/rag/retrieve.ts';
import { ingestMemory } from '../src/lib/rag/memory.ts';
import { toolByName } from '../src/lib/ai/tools/index.ts';

let pass = 0;
let fail = 0;
const ok = (n) => {
  pass++;
  console.log(`  ok   ${n}`);
};
const bad = (n, e) => {
  fail++;
  console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`);
};
const near = (a, b, eps = 1e-9) => typeof a === 'number' && Math.abs(a - b) < eps;

function makeDb(raw) {
  return {
    run: (sql, params = []) => {
      raw.prepare(sql).run(...params);
    },
    all: (sql, params = []) => raw.prepare(sql).all(...params),
    get: (sql, params = []) => raw.prepare(sql).get(...params),
    transaction: (fn) => {
      raw.exec('BEGIN');
      try {
        fn();
        raw.exec('COMMIT');
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

function freshDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const db = makeDb(raw);
  migrate(
    {
      exec: (sql) => raw.exec(sql),
      getUserVersion: () => raw.prepare('PRAGMA user_version').get().user_version,
      setUserVersion: (n) => raw.exec(`PRAGMA user_version = ${n}`),
      transaction: db.transaction,
    },
    MIGRATIONS
  );
  resetVectorTableProbe(); // each DB re-probes vec0 fresh
  return { raw, db };
}

console.log('0. migration 0025 created the two content tables');
{
  const { raw } = freshDb();
  const tables = raw
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_chunks'`)
    .all()
    .map((r) => r.name)
    .sort();
  tables.join(',') === 'knowledge_chunks,memory_chunks'
    ? ok('knowledge_chunks + memory_chunks exist (vec_chunks is device-only, not here)')
    : bad('chunk tables', tables.join(','));
}

console.log('1. knowledge + memory chunk CRUD, id order preserved on fetch');
{
  const { db } = freshDb();
  const a = insertKnowledgeChunk(db, {
    source: 'longevity-v1',
    title: 'ApoB',
    topic: 'cardiovascular',
    body: 'ApoB counts atherogenic particles.',
    chunkIndex: 0,
    tokenEstimate: 6,
  });
  const b = insertKnowledgeChunk(db, {
    source: 'longevity-v1',
    title: 'HRV',
    body: 'HRV reflects autonomic recovery.',
  });
  countChunks(db, 'knowledge') === 2 ? ok('two knowledge chunks stored') : bad('knowledge count');

  // getKnowledgeChunks preserves the requested id order (KNN rank), drops misses.
  const rows = getKnowledgeChunks(db, [b, a, 'missing']);
  rows.length === 2 && rows[0].id === b && rows[1].id === a && rows[0].title === 'HRV'
    ? ok('fetch preserves requested id order and silently drops a missing id')
    : bad('order', JSON.stringify(rows.map((r) => r.title)));

  const m = insertMemoryChunk(db, {
    kind: 'note',
    originTable: 'daily_logs',
    originId: 'log-1',
    refDate: '2026-07-20',
    body: 'Slept badly, 3am wake.',
  });
  countChunks(db, 'memory') === 1 && getMemoryChunks(db, [m])[0].kind === 'note'
    ? ok('memory chunk stored with kind + provenance')
    : bad('memory chunk');
}

console.log('2. memory re-ingestion: find + delete a source’s prior chunks by origin');
{
  const { db } = freshDb();
  insertMemoryChunk(db, { kind: 'day', originTable: 'daily_logs', originId: 'log-9', body: 'v1' });
  insertMemoryChunk(db, { kind: 'day', originTable: 'daily_logs', originId: 'log-9', body: 'v1b' });
  insertMemoryChunk(db, { kind: 'day', originTable: 'daily_logs', originId: 'other', body: 'x' });
  const ids = memoryChunkIdsForOrigin(db, 'daily_logs', 'log-9');
  ids.length === 2
    ? ok('memoryChunkIdsForOrigin finds exactly that source’s chunks')
    : bad('origin ids');
  deleteMemoryChunks(db, ids);
  countChunks(db, 'memory') === 1 && memoryChunkIdsForOrigin(db, 'daily_logs', 'log-9').length === 0
    ? ok('deleting them leaves the other source untouched')
    : bad('delete by origin');
}

console.log('3. vec0 layer degrades safely where the extension is absent (node:sqlite)');
{
  const { db } = freshDb();
  ensureVectorTable(db) === false
    ? ok('ensureVectorTable returns false (no vec0 module), does not throw')
    : bad('ensureVectorTable should be false headless');
  const vec = new Array(EMBED_DIM).fill(0.01);
  upsertVector(db, { chunkId: 'c1', corpus: 'memory', source: 'note', embedding: vec }) === false
    ? ok('upsertVector no-ops (returns false) without vec0')
    : bad('upsertVector should no-op');
  knnSearch(db, { corpus: 'knowledge', queryVec: vec, k: 5 }).length === 0
    ? ok('knnSearch returns [] without vec0 (never throws)')
    : bad('knnSearch should be empty');
}

console.log('4. embedder preprocessing: prompts, L2 normalize, MRL truncate');
{
  queryPrompt('why apob') === 'task: search result | query: why apob' &&
  documentPrompt('ApoB is a particle count.') === 'title: none | text: ApoB is a particle count.'
    ? ok('query + document prompt prefixes are exact')
    : bad('prompts');

  const n = l2normalize([3, 4]);
  near(Math.hypot(n[0], n[1]), 1) && near(n[0], 0.6) && near(n[1], 0.8)
    ? ok('l2normalize scales to unit length (3,4 → 0.6,0.8)')
    : bad('l2normalize', JSON.stringify(n));
  l2normalize([0, 0]).every((x) => x === 0)
    ? ok('a zero vector normalizes to itself (no divide-by-zero)')
    : bad('zero vector');

  const t = truncateEmbedding([3, 4, 12, 0], 2);
  t.length === 2 && near(Math.hypot(t[0], t[1]), 1)
    ? ok('truncateEmbedding keeps the first N dims and re-normalizes to unit length')
    : bad('truncate', JSON.stringify(t));
}

console.log('5. embedder is not wired yet → embedQuery is null, status is honest');
{
  const status = embedderStatus();
  const vec = await embedQuery('anything');
  status === 'model_not_installed' && vec === null
    ? ok('embedQuery returns null and status is model_not_installed (no fake vector)')
    : bad('embedder status', JSON.stringify({ status, vec }));
}

console.log('6. retrievePassages + search_knowledge degrade to an honest "not available"');
{
  const { db } = freshDb();
  insertKnowledgeChunk(db, { source: 's', body: 'content exists but cannot be searched yet' });

  const result = await retrievePassages(db, 'anything');
  result.available === false && typeof result.reason === 'string' && result.reason.length > 0
    ? ok('retrievePassages reports available:false with a reason (embedder not wired)')
    : bad('retrieve fallback', JSON.stringify(result));

  const tool = toolByName('search_knowledge');
  const out = JSON.parse(
    await tool.execute(db, { query: 'why does ApoB matter' }, { now: new Date() })
  );
  out.available === false && out.passages.length === 0 && typeof out.note === 'string'
    ? ok('search_knowledge tool returns available:false + empty passages + a note (never invents)')
    : bad('tool fallback', JSON.stringify(out));
  tool.readOnly === true
    ? ok('search_knowledge is readOnly (no confirmation gate)')
    : bad('readOnly');
}

console.log('7. ingestMemory persists chunk content even with no embedder (backfill later)');
{
  const { db } = freshDb();
  // Long enough to chunk into several passages (target ~1200 chars/passage).
  const longNote =
    'Started magnesium glycinate at 400 mg in the evening. ' +
    'Sleep onset felt faster within a week and I woke less at night. '.repeat(70);
  const res = await ingestMemory(db, {
    kind: 'note',
    text: longNote,
    originTable: 'notes',
    originId: 'n1',
    refDate: '2026-07-25',
  });
  res.chunkIds.length >= 2 &&
  res.embedded === 0 &&
  countChunks(db, 'memory') === res.chunkIds.length
    ? ok(
        `content chunked + stored (${res.chunkIds.length}), 0 embedded (embedder off) — vectors backfill later`
      )
    : bad('ingest', JSON.stringify(res));

  // Re-ingesting the same origin REPLACES its prior chunks: the count becomes
  // exactly the new chunk set (not old + new), proving no accumulation.
  const res2 = await ingestMemory(db, {
    kind: 'note',
    text: 'Shorter revised note.',
    originTable: 'notes',
    originId: 'n1',
  });
  const after = countChunks(db, 'memory');
  after === res2.chunkIds.length && res2.chunkIds.length < res.chunkIds.length
    ? ok('re-ingesting the same origin replaces its prior chunks (no duplication)')
    : bad('re-ingest', JSON.stringify({ after, first: res.chunkIds.length, res2 }));

  // An EMPTY re-ingest is a no-op — it must NOT wipe the origin's memory.
  const preserved = countChunks(db, 'memory');
  const emptyRes = await ingestMemory(db, {
    kind: 'note',
    text: '   \n\n  ',
    originTable: 'notes',
    originId: 'n1',
  });
  emptyRes.chunkIds.length === 0 && countChunks(db, 'memory') === preserved
    ? ok('an empty re-ingest is a no-op — prior memory for the origin is preserved, not wiped')
    : bad(
        'empty re-ingest wiped memory',
        JSON.stringify({ preserved, now: countChunks(db, 'memory') })
      );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
