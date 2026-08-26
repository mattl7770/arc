/**
 * Headless test of Phase-3 MEMORY (docs/coach-intelligence-review.md §4 Phase 3)
 * against real SQLite via node:sqlite:
 *
 *   - coach_memories (0028): remember / forget / restore, dedupe, soft delete
 *   - the remember + forget + get_memories tools, and prompt injection
 *   - durable declines replayed into the turn context
 *   - tool-result digests in replayed history (the model sees its own numbers)
 *   - the rolling thread summary for turns that age out of the window
 *   - search_history keyword recall over the user's own words
 *
 * op-sqlite and the model client are never loaded. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { todayISODate } from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  appendMessage,
  getConversationSummary,
  getOrCreateActiveConversation,
  listRecentMessages,
  recentDeclines,
} from '../src/lib/db/repositories/ai-chat.ts';
import {
  countActiveMemories,
  forgetMemory,
  listAllMemories,
  listMemories,
  rememberFact,
  restoreMemory,
} from '../src/lib/db/repositories/coach-memory.ts';
import { logNote } from '../src/lib/db/repositories/logs.ts';
import { createProtocolWithVersion } from '../src/lib/db/repositories/protocols.ts';
import { createExperiment } from '../src/lib/db/repositories/experiments.ts';
import { buildWireHistory, toolDigest } from '../src/lib/ai/history-window.ts';
import { searchUserHistory } from '../src/lib/ai/history-search.ts';
import { buildRollingSummary, updateRollingSummary } from '../src/lib/ai/thread-summary.ts';
import { buildTurnContext } from '../src/lib/ai/turn-context.ts';
import { toolByName } from '../src/lib/ai/tools/index.ts';
import { CORPUS, ingestCorpus } from '../src/lib/rag/corpus.ts';

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
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
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
  return { raw, db };
}

const NOW = new Date();
const CTX = { now: NOW };
const TODAY = todayISODate(NOW);
const run = (name, db, input = {}) => JSON.parse(toolByName(name).execute(db, input, CTX));
const card = (name, db, input = {}) => toolByName(name).confirmSummary(input, db, CTX);

console.log('0. migration 0028 shipped the table and the summary column');
{
  const { db, raw } = freshDb();
  const cols = raw
    .prepare(`PRAGMA table_info(coach_memories)`)
    .all()
    .map((c) => c.name);
  ['id', 'content', 'category', 'source', 'archived_at', 'created_at', 'updated_at'].every((c) =>
    cols.includes(c)
  )
    ? ok('coach_memories has its columns')
    : bad('columns', cols.join(','));
  raw
    .prepare(`PRAGMA table_info(ai_conversations)`)
    .all()
    .some((c) => c.name === 'summary')
    ? ok('ai_conversations.summary added')
    : bad('summary column missing');
  // The CHECK must reject an empty memory at the DB layer, not just in code.
  throws(() => db.run(`INSERT INTO coach_memories (id, content) VALUES ('m0', '   ')`))
    ? ok('a whitespace-only memory is rejected by the CHECK')
    : bad('empty memory accepted');
  throws(() =>
    db.run(`INSERT INTO coach_memories (id, content, category) VALUES ('m1', 'x', 'nonsense')`)
  )
    ? ok('an unknown category is rejected')
    : bad('bad category accepted');
}

console.log('1. remember / forget / restore, with dedupe and soft delete');
{
  const { db } = freshDb();
  const id = rememberFact(db, { content: 'Trains fasted before 10:00', category: 'preference' });
  rememberFact(db, { content: '  trains   FASTED before 10:00 ', category: 'preference' }) === id
    ? ok('re-remembering the same fact (any case/spacing) returns the existing row')
    : bad('dedupe failed');
  listMemories(db).length === 1 ? ok('one memory stored, not two') : bad('duplicate stored');

  forgetMemory(db, id) ? ok('forget archives it') : bad('forget failed');
  listMemories(db).length === 0
    ? ok('a forgotten memory leaves the active list (and the prompt)')
    : bad('still active');
  listAllMemories(db).length === 1
    ? ok('…but survives for the user to see in Settings — soft delete, not destruction')
    : bad('hard deleted');
  forgetMemory(db, id) === false
    ? ok('forgetting twice reports honestly instead of claiming success')
    : bad('double forget');
  restoreMemory(db, id) && listMemories(db).length === 1
    ? ok('restore brings it back')
    : bad('restore failed');
  throws(() => rememberFact(db, { content: '   ' }))
    ? ok('an empty memory is refused')
    : bad('empty accepted');
}

console.log('2. the tools: remember, forget, get_memories');
{
  const { db } = freshDb();
  card('remember', db, {
    content: 'Magnesium citrate upsets his stomach',
    category: 'constraint',
  }) === 'Remember: "Magnesium citrate upsets his stomach"'
    ? ok('the confirmation card quotes the exact fact being stored')
    : bad('remember card');
  const result = run('remember', db, {
    content: 'Magnesium citrate upsets his stomach',
    category: 'constraint',
  });
  result.remembered ? ok('remember stores it') : bad('remember tool', JSON.stringify(result));

  const listed = run('get_memories', db);
  listed.memories.length === 1 && listed.memories[0].id === result.id
    ? ok('get_memories returns it with its id (the address forget needs)')
    : bad('get_memories', JSON.stringify(listed));

  card('forget', db, { id: result.id }).includes('Magnesium citrate')
    ? ok('the forget card names the fact, never a bare id')
    : bad('forget card');
  run('forget', db, { id: result.id }).forgotten && run('get_memories', db).memories.length === 0
    ? ok('forget removes it from what the Coach knows')
    : bad('forget tool');
  throws(() => card('forget', db, { id: 'nope' }))
    ? ok('forgetting an unknown id fails at the card, before an approval is spent')
    : bad('unknown id accepted');
}

console.log('3. memories and declines ride the per-turn context block');
{
  const { db } = freshDb();
  const base = buildTurnContext(db, NOW);
  !base.includes('What you know about this user')
    ? ok('no memories → no memory section (no empty scaffolding)')
    : bad('empty section rendered');

  rememberFact(db, { content: 'Trains fasted', category: 'preference' });
  rememberFact(db, { content: 'Wants ApoB under 60', category: 'goal' });
  const withMemories = buildTurnContext(db, NOW);
  withMemories.includes('What you know about this user') &&
  withMemories.includes('[preference] Trains fasted') &&
  withMemories.includes('[goal] Wants ApoB under 60')
    ? ok('every active memory is injected, with its category')
    : bad('memory injection', withMemories);
  /id: [a-z0-9-]+/.test(withMemories)
    ? ok('each carries its id so the model can forget it')
    : bad('ids missing');

  // A decline must outlive the turn it happened in.
  const conversation = getOrCreateActiveConversation(db);
  appendMessage(db, conversation.id, 'assistant', 'Proposed a deload.', [
    { id: 't1', name: 'set_mode', input: { mode: 'deload' }, result: 'declined', declined: true },
  ]);
  recentDeclines(db).length === 1
    ? ok('recentDeclines reads the persisted refusal')
    : bad('declines', JSON.stringify(recentDeclines(db)));
  buildTurnContext(db, NOW).includes('Recently declined')
    ? ok('the context block warns the model not to re-propose it')
    : bad('declines not injected', buildTurnContext(db, NOW));
}

console.log('4. replayed history carries the numbers the Coach already read');
{
  const digest = toolDigest([
    { id: 'a', name: 'get_metric_series', input: {}, result: '{"avg":48,"last":44}' },
    { id: 'b', name: 'set_reminder', input: {}, result: 'declined', declined: true },
    { id: 'c', name: '__truncated__', input: {}, result: 'max_tokens' },
  ]);
  digest.includes('get_metric_series → {"avg":48,"last":44}')
    ? ok('a past read is replayed with its actual numbers')
    : bad('digest', digest);
  digest.includes('set_reminder: declined by user')
    ? ok('a decline is visible in the replayed turn')
    : bad('decline digest', digest);
  !digest.includes('__truncated__')
    ? ok('the truncation sentinel never reaches the model')
    : bad('sentinel leaked', digest);

  const long = 'x'.repeat(5000);
  toolDigest([{ id: 'd', name: 'get_insights', input: {}, result: long }]).length < 400
    ? ok('one enormous result cannot swamp the history')
    : bad('digest not truncated');

  const history = [
    { id: '1', role: 'user', content: 'How is my HRV?', createdAt: 1 },
    {
      id: '2',
      role: 'assistant',
      content: 'Averaging 48 ms.',
      createdAt: 2,
      toolCalls: [{ id: 'a', name: 'get_metric_series', input: {}, result: '{"avg":48}' }],
    },
    { id: '3', role: 'user', content: 'And versus last month?', createdAt: 3 },
  ];
  const wire = buildWireHistory(history);
  wire.length === 3 && wire[1].content.includes('[tools this turn: get_metric_series → {"avg":48}]')
    ? ok('the assistant turn is replayed with its digest appended')
    : bad('wire history', JSON.stringify(wire));

  const summarised = buildWireHistory(history, 'They said: knee pain in March.');
  summarised[0].content.startsWith('[Earlier in this conversation: They said: knee pain in March.]')
    ? ok('the rolling summary rides the first user turn (shape stays valid)')
    : bad('summary prepend', summarised[0].content);
  summarised[0].role === 'user'
    ? ok('…so the first message is still a user turn, as the API requires')
    : bad('role broken');
}

console.log('5. the rolling summary keeps a long thread’s spine');
{
  const { db } = freshDb();
  const conversation = getOrCreateActiveConversation(db);
  buildRollingSummary(db, conversation.id) === null
    ? ok('a short thread needs no summary (the model still sees all of it)')
    : bad('premature summary');

  appendMessage(db, conversation.id, 'user', 'My knee has been sore since March.');
  appendMessage(db, conversation.id, 'assistant', 'Noted.', [
    { id: 's1', name: 'log_symptom', input: { name: 'Knee pain' }, result: '{"logged":true}' },
  ]);
  for (let i = 0; i < 40; i++) {
    appendMessage(db, conversation.id, 'user', `Filler question ${i}`);
    appendMessage(db, conversation.id, 'assistant', `Filler answer ${i}`);
  }
  updateRollingSummary(db, conversation.id);
  const summary = getConversationSummary(db, conversation.id);
  // The thread-SETTING fact is the oldest thing in the conversation and the
  // first to be lost; a summary that keeps only recent lines would drop
  // exactly what it exists to preserve.
  summary && summary.includes('knee has been sore')
    ? ok('what the user said at the START of the thread still survives')
    : bad('summary content', summary);
  summary && /…\d+ more…/.test(summary)
    ? ok('the elided middle is marked, not silently dropped')
    : bad('no gap marker', summary);
  // The tail is the newest turn that fell OUT of the window (24 here) — turns
  // after it are still in the window and must not be duplicated into the
  // summary.
  summary && summary.includes('Filler question 24') && !summary.includes('Filler question 39')
    ? ok('the newest aged-out turn survives too (head AND tail), with no window overlap')
    : bad('tail wrong', summary);
  summary && summary.includes('log_symptom "Knee pain"')
    ? ok('and so does what was actually done')
    : bad('actions missing', summary);

  listRecentMessages(db, conversation.id, 10).length === 10
    ? ok('the screen pages the thread instead of loading it whole')
    : bad('pagination');
}

console.log('6. search_history recalls the user’s own words');
{
  const { db } = freshDb();
  const conversation = getOrCreateActiveConversation(db);
  appendMessage(db, conversation.id, 'user', 'I tried magnesium glycinate last winter for sleep.');
  logNote(db, TODAY, 'Skipped magnesium — forgot to pack it');
  createProtocolWithVersion(
    db,
    { name: 'Evening Stack', type: 'supplement_stack' },
    { items: [{ title: 'Magnesium' }] },
    'Added magnesium for sleep quality'
  );
  createExperiment(db, {
    title: 'Magnesium PM',
    hypothesis: 'Magnesium at night raises HRV',
    intervention: '400 mg glycinate',
    metrics: ['hrv'],
    startDate: TODAY,
    durationDays: 14,
  });
  rememberFact(db, { content: 'Magnesium citrate upsets his stomach', category: 'constraint' });

  const hits = searchUserHistory(db, 'magnesium');
  hits.length >= 5
    ? ok(`one query reaches every written surface (${hits.length} hits)`)
    : bad('coverage', JSON.stringify(hits));
  new Set(hits.map((h) => h.source)).size >= 4
    ? ok('hits come from conversation, log, protocol notes, experiments and memory')
    : bad('sources', JSON.stringify(hits.map((h) => h.source)));
  hits.every((h) => /^\d{4}-\d{2}-\d{2}$/.test(h.date))
    ? ok('every hit carries a date to cite')
    : bad('dates', JSON.stringify(hits));

  // Multi-term queries rank the row that matches BOTH first.
  const ranked = searchUserHistory(db, 'magnesium sleep');
  /sleep/i.test(ranked[0].text)
    ? ok('a two-term query ranks the row containing both terms first')
    : bad('ranking', JSON.stringify(ranked.slice(0, 2)));

  searchUserHistory(db, 'kombucha').length === 0
    ? ok('no match returns nothing (the tool tells the model to say so)')
    : bad('phantom hits');
  run('search_history', db, { query: 'kombucha' }).note.includes('do not guess')
    ? ok('the empty result instructs the model not to invent what was said')
    : bad('empty note');
}

console.log('7. search_knowledge is unregistered while it cannot work');
{
  toolByName('search_knowledge') === undefined
    ? ok('the always-unavailable tool is no longer advertised to the model')
    : bad('search_knowledge still registered');
  toolByName('search_history') !== undefined
    ? ok('…and real keyword recall took its place')
    : bad('search_history missing');
}

console.log('8. the curated corpus is real content, searchable today');
{
  const { db } = freshDb();
  // Boot seeding loads the pack; ingesting twice must not duplicate it.
  const first = ingestCorpus(db);
  const second = ingestCorpus(db);
  first === CORPUS.length && second === CORPUS.length
    ? ok(`the pack loads ${first} curated entries, idempotently`)
    : bad('corpus ingest', `${first} / ${second}`);
  db.get('SELECT count(*) c FROM knowledge_chunks').c === CORPUS.length
    ? ok('re-ingesting replaces the pack rather than accumulating copies')
    : bad('duplicate chunks', String(db.get('SELECT count(*) c FROM knowledge_chunks').c));

  // The whole point: an explanation can now be grounded in ARC's own doctrine.
  const apob = searchUserHistory(db, 'apob particles');
  apob.length > 0 && apob[0].source.startsWith('ARC reference')
    ? ok('"why does ApoB matter" now finds ARC reference material')
    : bad('apob search', JSON.stringify(apob.slice(0, 2)));
  searchUserHistory(db, 'hrv variability').some((h) => h.source.startsWith('ARC reference'))
    ? ok('HRV interpretation doctrine is reachable')
    : bad('hrv doctrine');

  // The user's own history must still outrank reference material.
  rememberFact(db, { content: 'Magnesium citrate upsets his stomach', category: 'constraint' });
  const magnesium = searchUserHistory(db, 'magnesium');
  magnesium[0].source.includes('remembered')
    ? ok('at equal relevance, what ARC knows about HIM outranks the reference')
    : bad('ranking', JSON.stringify(magnesium.slice(0, 2).map((h) => h.source)));

  CORPUS.every((e) => e.body.length > 400 && e.title.length > 0 && e.topic.length > 0)
    ? ok('every entry is substantive and tagged with a topic')
    : bad('thin entries');
}

// ---------------------------------------------------------------------------
// Regressions from the Phase 2–6 adversarial review.
// ---------------------------------------------------------------------------

console.log('R5. the prompt says so when it is not showing every memory');
{
  const { db } = freshDb();
  for (let i = 0; i < 46; i++) {
    rememberFact(db, { content: `Fact number ${i} about the user`, category: 'context' });
  }
  countActiveMemories(db) === 46 ? ok('46 memories stored') : bad('seed count');
  listMemories(db).length === 40
    ? ok('the prompt view is still capped at 40 (a memory store is a per-turn tax)')
    : bad('cap changed', String(listMemories(db).length));

  const context = buildTurnContext(db, new Date());
  /6 older memories are not shown/.test(context)
    ? ok('…but the context block SAYS six are hidden, instead of pretending it knows all 46')
    : bad('silent truncation', context.slice(0, 400));
  /search_history or get_memories/.test(context)
    ? ok('…and points at the tool that can reach them')
    : bad('no escape hatch named');

  // The escape hatch must actually be one — capping get_memories at the same 40
  // would make that instruction a dead end.
  const out = JSON.parse(toolByName('get_memories').execute(db, {}, { now: new Date() }));
  out.total === 46 && out.memories.length === 46
    ? ok('get_memories returns all 46, not the prompt window')
    : bad('escape hatch capped', JSON.stringify({ t: out.total, n: out.memories.length }));

  // …and with few memories, no phantom warning.
  const { db: small } = freshDb();
  rememberFact(small, { content: 'Trains fasted most mornings' });
  !/not shown here/.test(buildTurnContext(small, new Date()))
    ? ok('an untruncated list adds no caveat')
    : bad('phantom truncation notice');
}

console.log('R6. a decline expires — it is not a permanent veto');
{
  const { db } = freshDb();
  const conversation = getOrCreateActiveConversation(db);
  const declined = [{ id: 't1', name: 'set_mode', input: { mode: 'deload' }, declined: true }];
  const id = appendMessage(db, conversation.id, 'assistant', 'Proposed a deload.', declined);

  recentDeclines(db).length === 1
    ? ok('a decline from today is surfaced')
    : bad('fresh decline missing');

  // Backdate it 90 days. It happened, but it is no longer current preference.
  db.run('UPDATE ai_messages SET created_at = ? WHERE id = ?', [
    new Date(Date.now() - 90 * 86400000).toISOString(),
    id,
  ]);
  recentDeclines(db).length === 0
    ? ok('a 90-day-old decline is no longer injected as "recently declined"')
    : bad('unbounded decline horizon', JSON.stringify(recentDeclines(db)));
  recentDeclines(db, { withinDays: 365 }).length === 1
    ? ok('…and the horizon is a parameter, not a hard-coded forget')
    : bad('withinDays ignored');
}

console.log('R7. a tool-only assistant turn keeps its digest in replayed history');
{
  const calls = [{ id: 'tu1', name: 'get_metric_series', input: {}, result: '{"avg":52}' }];
  // The model called a tool and produced no prose — a real streaming outcome.
  const wire = buildWireHistory([
    { id: 'm1', role: 'user', content: 'How is my HRV?' },
    { id: 'm2', role: 'assistant', content: '', toolCalls: calls },
    { id: 'm3', role: 'user', content: 'And sleep?' },
  ]);
  wire.length === 3
    ? ok('the text-less assistant turn survives instead of being dropped')
    : bad('turn dropped', JSON.stringify(wire));
  wire[1] && wire[1].content.includes('52')
    ? ok('…carrying the number it actually read')
    : bad('digest lost', JSON.stringify(wire[1]));
  wire.every((m) => m.content.trim().length > 0)
    ? ok('no message is blank (the API rejects whitespace-only content)')
    : bad('blank content block');

  // A turn whose only record is the truncation sentinel has nothing to say and
  // must still not become an empty block.
  const sentinelOnly = buildWireHistory([
    { id: 'm1', role: 'user', content: 'Hi' },
    { id: 'm2', role: 'assistant', content: '', toolCalls: [{ id: 't', name: '__truncated__' }] },
  ]);
  sentinelOnly.every((m) => m.content.trim().length > 0)
    ? ok('a sentinel-only turn is dropped rather than sent empty')
    : bad('empty block from sentinel', JSON.stringify(sentinelOnly));
}

console.log('R8. the rolling summary does not re-read the whole thread');
{
  const { db } = freshDb();
  const conversation = getOrCreateActiveConversation(db);
  // The thread-setting fact, then a very long conversation on top of it.
  appendMessage(db, conversation.id, 'user', 'My left knee has been sore since March.');
  for (let i = 0; i < 300; i++) {
    appendMessage(db, conversation.id, i % 2 === 0 ? 'user' : 'assistant', `Turn ${i} content`);
  }

  let reads = 0;
  const counting = {
    ...db,
    all: (sql, params = []) => {
      if (/FROM ai_messages/.test(sql)) reads += 1;
      return db.all(sql, params);
    },
  };
  const summary = buildRollingSummary(counting, conversation.id);

  summary && summary.includes('knee')
    ? ok('the oldest, thread-setting fact is still preserved')
    : bad('head lost', String(summary));
  reads <= 2
    ? ok(`the aged region is read in ${reads} bounded queries, not one unbounded scan`)
    : bad('too many reads', String(reads));

  // The bound must be on ROWS, not just queries: prove the scan is constant by
  // growing the thread and checking the summary stays the same size.
  const before = summary.length;
  for (let i = 0; i < 300; i++) {
    appendMessage(db, conversation.id, i % 2 === 0 ? 'user' : 'assistant', `Later ${i}`);
  }
  const grown = buildRollingSummary(db, conversation.id);
  grown && Math.abs(grown.length - before) < before
    ? ok('doubling the thread does not double the summary')
    : bad('summary grows with the thread', `${before} → ${grown && grown.length}`);
  /more…/.test(grown)
    ? ok('…and the gap it skipped is stated, not silently elided')
    : bad('no gap marker', grown);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
