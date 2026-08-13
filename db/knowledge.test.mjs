/**
 * Headless test of the knowledge base (0035) against real SQLite via
 * node:sqlite — docs/knowledge-subapp.md §10.
 *
 * The load-bearing assertion in this file is §4's PACK-PROTECTION INVARIANT.
 * SQLite's ALTER TABLE cannot add a CHECK, so the two-owner split of
 * `knowledge_chunks` (pack rows vs entry rows) is enforced by construction in
 * the repository and by this test — nowhere else. A pack version bump is a
 * routine event; a routine event that silently eats the user's own writing is
 * unrecoverable, so the test bumps the version, re-ingests, and demands the
 * entry chunks come back BYTE-IDENTICAL.
 *
 * Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  archiveKnowledgeEntry,
  chunkIdsForEntry,
  countKnowledgeEntries,
  deleteKnowledgeEntry,
  getKnowledgeEntry,
  getPackEntry,
  listKnowledgeEntries,
  listKnowledgeTopics,
  listPackEntries,
  restoreKnowledgeEntry,
  saveKnowledgeEntry,
  updateKnowledgeEntry,
  USER_KNOWLEDGE_SOURCE,
} from '../src/lib/db/repositories/knowledge.ts';
import { CORPUS, CORPUS_SOURCE, ingestCorpus } from '../src/lib/rag/corpus.ts';
import { insertKnowledgeChunk } from '../src/lib/db/repositories/rag.ts';
import { searchUserHistory } from '../src/lib/ai/history-search.ts';
import { resetVectorTableProbe } from '../src/lib/db/repositories/rag.ts';

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
  resetVectorTableProbe();
  return { raw, db };
}

const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

// A body long enough that chunkText splits it into more than one passage —
// the multi-chunk cases (dedupe, replace-by-entry) need a real multi-chunk row.
const LONG_BODY = Array.from(
  { length: 14 },
  (_, i) =>
    `Magnesium glycinate is the form ARC reaches for first, sentence ${i + 1} of a deliberately ` +
    `long passage about absorption, gastrointestinal tolerance, and why the citrate form is ` +
    `notably laxative at the doses people actually take it at.`
).join(' ');

console.log('0. migration 0035 applied over head');
{
  const { raw } = freshDb();
  const cols = raw
    .prepare(`PRAGMA table_info(knowledge_entries)`)
    .all()
    .map((c) => c.name)
    .sort()
    .join(',');
  cols ===
  'archived_at,body,created_at,id,source,source_author,source_note,source_url,title,topic,updated_at'
    ? ok('knowledge_entries has the specified columns')
    : bad('knowledge_entries columns', cols);

  const chunkCols = raw
    .prepare(`PRAGMA table_info(knowledge_chunks)`)
    .all()
    .map((c) => c.name);
  chunkCols.includes('entry_id')
    ? ok('knowledge_chunks.entry_id added by ALTER')
    : bad('entry_id missing', chunkCols.join(','));

  const version = raw.prepare('PRAGMA user_version').get().user_version;
  version >= 35 ? ok(`user_version stamped ${version}`) : bad('user_version', version);
}

console.log('1. CHECKs reject what the repository would never write');
{
  const { db, raw } = freshDb();
  throws(() => saveKnowledgeEntry(db, { title: '   ', body: 'x' }))
    ? ok('blank title rejected')
    : bad('blank title accepted');
  throws(() => saveKnowledgeEntry(db, { title: 'x', body: '  \n ' }))
    ? ok('blank body rejected')
    : bad('blank body accepted');
  throws(() =>
    raw
      .prepare(
        `INSERT INTO knowledge_entries (id, title, body, source) VALUES ('e', 't', 'b', 'nope')`
      )
      .run()
  )
    ? ok('bad source rejected by CHECK')
    : bad('bad source accepted');
  throws(() =>
    raw
      .prepare(`INSERT INTO knowledge_entries (id, title, body) VALUES (NULL, 't', 'b')`)
      .run()
  )
    ? ok('NULL id rejected (PRIMARY KEY NOT NULL)')
    : bad('NULL id accepted');
}

console.log('2. save writes the entry AND its chunks, under the reserved source');
{
  const { db } = freshDb();
  const id = saveKnowledgeEntry(db, {
    title: 'Magnesium forms differ in absorption',
    topic: 'supplements',
    body: LONG_BODY,
  });
  const entry = getKnowledgeEntry(db, id);
  entry && entry.body === LONG_BODY.trim()
    ? ok('the entry round-trips its body verbatim (chunking is lossy; the entry is not)')
    : bad('body did not round-trip');
  entry.source === 'user' && entry.topic === 'supplements'
    ? ok("defaults: source 'user', topic as given")
    : bad('entry defaults', JSON.stringify(entry));

  const chunks = db.all(
    `SELECT source, pack_version, entry_id, chunk_index, title, topic, token_estimate
     FROM knowledge_chunks WHERE entry_id = ? ORDER BY chunk_index`,
    [id]
  );
  chunks.length > 1 ? ok(`entry chunked into ${chunks.length} passages`) : bad('expected >1 chunk');
  chunks.every((c) => c.source === USER_KNOWLEDGE_SOURCE)
    ? ok(`every entry chunk carries source='${USER_KNOWLEDGE_SOURCE}'`)
    : bad('entry chunk source drifted');
  chunks.every((c) => c.pack_version === null)
    ? ok('every entry chunk has pack_version NULL (the ownership invariant)')
    : bad('entry chunk carried a pack_version');
  chunks.every((c, i) => c.chunk_index === i)
    ? ok('chunk_index is passage-position within the entry')
    : bad('chunk_index not ordered');
  chunks.every((c) => c.title === 'Magnesium forms differ in absorption' && c.topic === 'supplements')
    ? ok('citation metadata copied onto every chunk')
    : bad('chunk citation metadata missing');
  chunks.every((c) => typeof c.token_estimate === 'number' && c.token_estimate > 0)
    ? ok('token_estimate stamped')
    : bad('token_estimate missing');
}

console.log('3. the pack still owns its own rows, and the invariant holds both ways');
{
  const { db } = freshDb();
  ingestCorpus(db);
  const packRows = db.all(
    `SELECT entry_id, pack_version FROM knowledge_chunks WHERE source = ?`,
    [CORPUS_SOURCE]
  );
  packRows.length === CORPUS.length
    ? ok(`pack ingested ${packRows.length} rows`)
    : bad('pack row count', packRows.length);
  packRows.every((r) => r.entry_id === null && r.pack_version !== null)
    ? ok('every pack chunk: entry_id NULL, pack_version NOT NULL')
    : bad('pack invariant broken');

  const packEntries = listPackEntries(db);
  packEntries.length === CORPUS.length && packEntries[0].title === CORPUS[0].title
    ? ok('listPackEntries reads the pack in pack order')
    : bad('listPackEntries', JSON.stringify(packEntries.slice(0, 1)));
  getPackEntry(db, packEntries[0].id)?.title === CORPUS[0].title
    ? ok('getPackEntry resolves one pack entry by chunk id')
    : bad('getPackEntry missed');
}

console.log('4. THE PACK-PROTECTION INVARIANT — a version bump cannot eat user content');
{
  const { db } = freshDb();
  ingestCorpus(db);
  const entryId = saveKnowledgeEntry(db, {
    title: 'My own take on Zone 2',
    topic: 'training',
    body: LONG_BODY,
  });
  const before = db.all(
    `SELECT id, source, pack_version, entry_id, chunk_index, title, topic, body, token_estimate
     FROM knowledge_chunks WHERE entry_id = ? ORDER BY chunk_index`,
    [entryId]
  );

  // Simulate a pack version bump exactly as ingestCorpus does it: the DELETE is
  // by SOURCE, and this is the statement the whole two-owner split exists to
  // make safe.
  db.transaction(() => {
    db.run(`DELETE FROM knowledge_chunks WHERE source = ?`, [CORPUS_SOURCE]);
    CORPUS.forEach((e, index) => {
      insertKnowledgeChunk(db, {
        source: CORPUS_SOURCE,
        packVersion: '2',
        title: e.title,
        topic: e.topic,
        body: e.body,
        chunkIndex: index,
      });
    });
  });

  const after = db.all(
    `SELECT id, source, pack_version, entry_id, chunk_index, title, topic, body, token_estimate
     FROM knowledge_chunks WHERE entry_id = ? ORDER BY chunk_index`,
    [entryId]
  );
  JSON.stringify(before) === JSON.stringify(after)
    ? ok('entry chunks are BYTE-IDENTICAL after a pack version bump + re-ingest')
    : bad('a pack re-ingest disturbed entry chunks', JSON.stringify({ before, after }));
  getKnowledgeEntry(db, entryId) ? ok('the entry row itself survives') : bad('entry row destroyed');
  db.get(`SELECT count(*) c FROM knowledge_chunks WHERE source = ? AND pack_version = '2'`, [
    CORPUS_SOURCE,
  ]).c === CORPUS.length
    ? ok('the new pack version did land')
    : bad('pack re-ingest did not write');
}

console.log('5. edit = replace-by-entry (the ingestMemory mirror)');
{
  const { db } = freshDb();
  const a = saveKnowledgeEntry(db, { title: 'A', topic: 'sleep', body: LONG_BODY });
  const b = saveKnowledgeEntry(db, { title: 'B', topic: 'sleep', body: 'A short second entry.' });
  const priorA = chunkIdsForEntry(db, a);
  const priorB = chunkIdsForEntry(db, b);

  updateKnowledgeEntry(db, a, { body: 'Rewritten, and much shorter than it was.' });
  const nowA = chunkIdsForEntry(db, a);
  nowA.length === 1 ? ok('edit re-chunked to one passage') : bad('rechunk count', nowA.length);
  nowA.every((id) => !priorA.includes(id))
    ? ok('every prior chunk of the edited entry is gone (replace, never append)')
    : bad('stale chunk survived the edit');
  db.get(`SELECT body FROM knowledge_chunks WHERE entry_id = ?`, [a]).body ===
  'Rewritten, and much shorter than it was.'
    ? ok('the new body is what is retrievable')
    : bad('new body not chunked');
  JSON.stringify(chunkIdsForEntry(db, b)) === JSON.stringify(priorB)
    ? ok('a different entry is untouched by the edit')
    : bad('edit leaked across entries');

  updateKnowledgeEntry(db, a, { title: 'A renamed' });
  db.get(`SELECT title FROM knowledge_chunks WHERE entry_id = ?`, [a]).title === 'A renamed'
    ? ok('a rename re-stamps the citation title on the chunks')
    : bad('chunk title went stale after rename');
  updateKnowledgeEntry(db, 'no-such-id', { title: 'x' }) === false
    ? ok('editing an unknown id returns false, not a phantom success')
    : bad('unknown-id edit claimed success');
}

console.log('6. archive drops chunks and keeps the entry; restore re-chunks');
{
  const { db } = freshDb();
  const id = saveKnowledgeEntry(db, { title: 'Retracted', topic: 'method', body: LONG_BODY });
  const chunkCount = chunkIdsForEntry(db, id).length;

  archiveKnowledgeEntry(db, id) ? ok('archive returned true') : bad('archive returned false');
  chunkIdsForEntry(db, id).length === 0
    ? ok('archiving deleted every chunk — retracted doctrine is unreachable by every reader')
    : bad('archived entry kept chunks');
  const archived = getKnowledgeEntry(db, id);
  archived && archived.archived_at !== null
    ? ok('the entry row survives with archived_at set (soft delete)')
    : bad('archive destroyed the entry');
  listKnowledgeEntries(db).some((e) => e.id === id) === false
    ? ok('archived entries are out of the active list')
    : bad('archived entry still active');
  listKnowledgeEntries(db, { archived: true }).some((e) => e.id === id)
    ? ok('archived entries are in the archived list')
    : bad('archived entry missing from archived list');
  archiveKnowledgeEntry(db, id) === false
    ? ok('archiving twice returns false')
    : bad('double archive claimed success');

  // An edit while archived must not resurrect it into search.
  updateKnowledgeEntry(db, id, { body: 'Edited while archived.' });
  chunkIdsForEntry(db, id).length === 0
    ? ok('editing an archived entry does NOT re-chunk it back into search')
    : bad('an archived entry became retrievable via edit');

  restoreKnowledgeEntry(db, id) ? ok('restore returned true') : bad('restore returned false');
  chunkIdsForEntry(db, id).length === 1
    ? ok('restore re-chunked from the CURRENT body')
    : bad('restore chunk count', chunkIdsForEntry(db, id).length);
  getKnowledgeEntry(db, id).archived_at === null
    ? ok('archived_at cleared on restore')
    : bad('archived_at survived restore');
  chunkCount > 1 ? ok('(the original body really was multi-chunk)') : bad('fixture too short');
}

console.log('7. hard delete: vectors by id, then CASCADE takes the chunks');
{
  const { db } = freshDb();
  ingestCorpus(db);
  const id = saveKnowledgeEntry(db, { title: 'Gone', topic: 'other', body: LONG_BODY });
  const other = saveKnowledgeEntry(db, { title: 'Stays', topic: 'other', body: 'Still here.' });
  deleteKnowledgeEntry(db, id);
  getKnowledgeEntry(db, id) === undefined ? ok('entry deleted') : bad('entry survived delete');
  db.get(`SELECT count(*) c FROM knowledge_chunks WHERE entry_id = ?`, [id]).c === 0
    ? ok('ON DELETE CASCADE took the chunks')
    : bad('orphan chunks left behind');
  chunkIdsForEntry(db, other).length === 1
    ? ok('a sibling entry is untouched')
    : bad('delete leaked across entries');
  db.get(`SELECT count(*) c FROM knowledge_chunks WHERE source = ?`, [CORPUS_SOURCE]).c ===
  CORPUS.length
    ? ok('the pack is untouched by an entry delete')
    : bad('entry delete reached the pack');
}

console.log('8. listing, counting, topics');
{
  const { db } = freshDb();
  ingestCorpus(db);
  countKnowledgeEntries(db) === 0 ? ok('count starts at 0') : bad('count not 0');
  const first = saveKnowledgeEntry(db, { title: 'First', topic: 'sleep', body: 'One.' });
  saveKnowledgeEntry(db, { title: 'Second', topic: 'dental', body: 'Two.' });
  countKnowledgeEntries(db) === 2 ? ok('count reflects active entries') : bad('count wrong');

  // ORDER BY updated_at DESC. Asserted as the RULE, not as a specific pair —
  // an earlier version of this test created two entries, touched the first, and
  // demanded it be at the head. That passed four runs in five: SQLite stamps
  // `updated_at` to the millisecond, and all three writes land inside one
  // millisecond often enough to tie, at which point the order is decided by the
  // secondary keys and not by the update at all. The rule is what the screen
  // depends on, so the rule is what is pinned.
  updateKnowledgeEntry(db, first, { body: 'One, revised.' });
  const listed = listKnowledgeEntries(db);
  listed.every((e, i) => i === 0 || listed[i - 1].updated_at >= e.updated_at)
    ? ok('active list is sorted most-recently-updated first')
    : bad('list not sorted', listed.map((e) => `${e.title}@${e.updated_at}`).join(','));
  getKnowledgeEntry(db, first).updated_at >= listed[listed.length - 1].updated_at
    ? ok('an edit bumps updated_at (the AFTER UPDATE trigger fires)')
    : bad('updated_at not bumped by an edit');

  // And the ORDER BY itself, pinned deterministically: rows inserted with
  // explicit, distinct timestamps. INSERT does not fire the AFTER UPDATE
  // trigger, so these values survive — which is the only way to backdate a row
  // here, since any UPDATE re-stamps updated_at to 'now' by design.
  const { db: od } = freshDb();
  for (const [id, title, when] of [
    ['k1', 'Oldest', '2026-01-01T00:00:00.000Z'],
    ['k2', 'Newest', '2026-06-01T00:00:00.000Z'],
    ['k3', 'Middle', '2026-03-01T00:00:00.000Z'],
  ]) {
    od.run(
      `INSERT INTO knowledge_entries (id, title, topic, body, created_at, updated_at)
       VALUES (?, ?, 'other', 'body', ?, ?)`,
      [id, title, when, when]
    );
  }
  listKnowledgeEntries(od)
    .map((e) => e.title)
    .join(',') === 'Newest,Middle,Oldest'
    ? ok('ORDER BY updated_at DESC, exactly')
    : bad('order by', listKnowledgeEntries(od).map((e) => e.title).join(','));

  const topics = listKnowledgeTopics(db);
  topics.includes('dental') && topics.includes('cardiovascular') && topics.includes('sleep')
    ? ok('topic vocabulary is the pack eight plus whatever the user has used')
    : bad('topics', topics.join(','));

  const hits = listKnowledgeEntries(db, { query: 'revised' });
  hits.length === 1 && hits[0].id === first
    ? ok('hub search filters entries by keyword')
    : bad('entry search', hits.length);
  listPackEntries(db, 'apob').length === 1
    ? ok('hub search filters the pack by keyword')
    : bad('pack search', listPackEntries(db, 'apob').length);
  listPackEntries(db, 'zzzznothing').length === 0
    ? ok('a miss is a miss (no silent fallback to everything)')
    : bad('empty search returned rows');
}

console.log('9. searchUserHistory: provenance labels, entry-over-pack, per-entry dedupe');
{
  const { db } = freshDb();
  ingestCorpus(db);
  // The pack's supplements entry already discusses magnesium citrate vs
  // glycinate — so this query hits BOTH stores, which is the case the labels
  // and the ordering exist for.
  const entryId = saveKnowledgeEntry(db, {
    title: 'Magnesium: what I actually take',
    topic: 'supplements',
    body: LONG_BODY,
  });
  const hits = searchUserHistory(db, 'magnesium glycinate');

  const mine = hits.filter((h) => h.source.startsWith('your knowledge'));
  const pack = hits.filter((h) => h.source.startsWith('ARC reference'));
  mine.length > 0 ? ok('user entries are cited "your knowledge · <topic>"') : bad('no entry hits');
  pack.length > 0 ? ok('pack rows are still cited "ARC reference · <topic>"') : bad('no pack hits');
  mine[0]?.source === 'your knowledge · supplements'
    ? ok('the entry label carries its topic')
    : bad('entry label', mine[0]?.source);
  mine.every((h) => h.date === 'reference') && pack.every((h) => h.date === 'reference')
    ? ok("both keep the 'reference' sentinel — an entry is doctrine, not an event")
    : bad('reference sentinel lost');

  mine.length === 1
    ? ok('a multi-chunk entry dedupes to its best passage (one long entry cannot flood the budget)')
    : bad('per-entry dedupe failed', mine.length);

  const firstMine = hits.findIndex((h) => h.source.startsWith('your knowledge'));
  const firstPack = hits.findIndex((h) => h.source.startsWith('ARC reference'));
  firstMine < firstPack
    ? ok('among references, the user’s own entry outranks the shipped pack')
    : bad('pack outranked the user entry', JSON.stringify({ firstMine, firstPack }));

  mine[0].text.length > 300 && mine[0].text.length <= 520
    ? ok(`knowledge excerpts run to ~500 chars (got ${mine[0].text.length})`)
    : bad('knowledge excerpt cap', mine[0].text.length);

  // Archiving must remove it from the Coach's recall with no query change.
  archiveKnowledgeEntry(db, entryId);
  searchUserHistory(db, 'magnesium glycinate').some((h) => h.source.startsWith('your knowledge'))
    ? bad('an archived entry is still retrievable by the Coach')
    : ok('archiving removes the entry from searchUserHistory with zero query changes');
}

console.log('9b. a prolific writer cannot crowd the ARC reference out of recall');
{
  // THE REGRESSION THIS PINS. The per-entry dedupe runs in JS, AFTER SQL has
  // applied its LIMIT. With ONE shared window over both owners of
  // knowledge_chunks, enough user chunks fill it, the dedupe collapses them,
  // and the pack contributes NOTHING — silently, and worse the more the user
  // writes. Separate per-owner windows are what make that impossible.
  const { db } = freshDb();
  ingestCorpus(db);
  // The query is chosen to match MANY pack entries (sleep, both training
  // entries, alcohol/lifestyle, recovery) as well as every user entry, so the
  // two owners compete directly for the window — the case a single shared
  // window loses. Each user entry is several passages, and each passage repeats
  // the same terms, so they dominate on raw row count.
  const COMPETING = Array.from(
    { length: 16 },
    (_, i) =>
      `Sleep, training and alcohol interact, passage ${i + 1}: recovery is the variable that ` +
      `pays for everything else, and a night of alcohol costs the next day's training more ` +
      `than the session itself ever gave back.`
  ).join(' ');
  for (let i = 0; i < 25; i++) {
    saveKnowledgeEntry(db, { title: `My note ${i}`, topic: 'lifestyle', body: COMPETING });
  }
  const hits = searchUserHistory(db, 'sleep training alcohol recovery', 40);
  const pack = hits.filter((h) => h.source.startsWith('ARC reference'));
  const mine = hits.filter((h) => h.source.startsWith('your knowledge'));
  pack.length >= 3
    ? ok(`the ARC reference still surfaces (${pack.length} hits) beside ${mine.length} of the user's`)
    : bad(
        '25 user entries crowded the shipped reference out of recall',
        `pack=${pack.length} mine=${mine.length}`
      );
  new Set(mine.map((h) => h.text)).size === mine.length
    ? ok('and every user hit is a distinct entry — no entry appears twice')
    : bad('per-entry dedupe leaked duplicates');
}

console.log('10. own history still outranks reference at equal relevance');
{
  const { db } = freshDb();
  ingestCorpus(db);
  saveKnowledgeEntry(db, { title: 'Alcohol notes', topic: 'lifestyle', body: 'Alcohol and HRV.' });
  db.run(`INSERT INTO daily_logs (id, date) VALUES ('dl1', '2026-08-01')`);
  db.run(
    `INSERT INTO log_entries (id, daily_log_id, type, title) VALUES ('le1', 'dl1', 'note', 'Alcohol and HRV.')`
  );
  const hits = searchUserHistory(db, 'alcohol hrv');
  hits[0].date !== 'reference'
    ? ok('the user’s own log still comes first — the tie-break above references is unchanged')
    : bad('reference outranked a log entry', JSON.stringify(hits[0]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
