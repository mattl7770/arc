/**
 * Headless test of the AI chat data layer — ai_conversations + ai_messages
 * (0008_ai_chat.sql, + turn_outcome in 0028_ai_message_turn_outcome.sql) and
 * their repository (ai-chat.ts) — against real SQLite via node:sqlite. Mirrors
 * db/nutrition.test.mjs; op-sqlite is never loaded. Run: npm run db:test.
 *
 * Sections 9-12 cover the turn-outcome audit trail: the 0028 back-fill over
 * rows written before it existed, the outcome vocabulary round-tripping, the
 * stop-reason mapping, and the retry path — which must APPEND beside the
 * fragment it replaces, never delete it, so a reload shows what the record
 * holds.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  appendMessage,
  createConversation,
  getOrCreateActiveConversation,
  landedWriteCalls,
  latestConversation,
  listMessages,
  listThread,
  markSupersededTurns,
  outcomeForStopReason,
  parseToolCalls,
  setConversationTitle,
} from '../src/lib/db/repositories/ai-chat.ts';

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

/**
 * A migrated in-memory database. `upTo` stops the runner at a version so a
 * later migration can be tested as an UPGRADE over rows that already exist —
 * `migrateAll()` then finishes the job.
 */
function freshDb(upTo = Infinity) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const db = makeDb(raw);
  const executor = {
    exec: (sql) => raw.exec(sql),
    getUserVersion: () => raw.prepare('PRAGMA user_version').get().user_version,
    setUserVersion: (n) => raw.exec(`PRAGMA user_version = ${n}`),
    transaction: db.transaction,
  };
  const migrateAll = () => migrate(executor, MIGRATIONS);
  migrate(
    executor,
    MIGRATIONS.filter((m) => m.version <= upTo)
  );
  return { raw, db, migrateAll };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

console.log('0. migrations: 0008 (ai chat) applies; both tables exist');
{
  const { raw } = freshDb();
  const version = raw.prepare('PRAGMA user_version').get().user_version;
  version >= 5 ? ok(`user_version is ${version} (>= 5)`) : bad('user_version', version);
  const tables = raw
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ai_conversations','ai_messages') ORDER BY name`
    )
    .all()
    .map((r) => r.name);
  JSON.stringify(tables) === JSON.stringify(['ai_conversations', 'ai_messages'])
    ? ok('ai_conversations + ai_messages exist')
    : bad('tables', JSON.stringify(tables));
}

console.log('1. ai_messages is append-only by design: no updated_at column');
{
  const { raw } = freshDb();
  const columns = raw
    .prepare(`SELECT name FROM pragma_table_info('ai_messages')`)
    .all()
    .map((r) => r.name);
  columns.includes('created_at') && !columns.includes('updated_at')
    ? ok('created_at only, like protocol_versions')
    : bad('columns', JSON.stringify(columns));
}

console.log('2. getOrCreateActiveConversation creates once, then resumes');
{
  const { db } = freshDb();
  const first = getOrCreateActiveConversation(db);
  UUID_RE.test(first.id) ? ok('created id is a v4 UUID') : bad('id shape', first.id);
  const second = getOrCreateActiveConversation(db);
  second.id === first.id ? ok('second call resumes the same thread') : bad('resume', second.id);
}

console.log('3. appendMessage persists role/content/tool_calls and returns its id');
{
  const { db, raw } = freshDb();
  const convo = createConversation(db);
  const calls = [
    { id: 'toolu_1', name: 'get_metric_series', input: { metric: 'hrv' }, result: '{"x":1}' },
  ];
  const userId = appendMessage(db, convo, 'user', 'How is my HRV?');
  const assistantId = appendMessage(db, convo, 'assistant', 'Down 12%.', calls);

  const userRow = raw.prepare('SELECT * FROM ai_messages WHERE id = ?').get(userId);
  userRow &&
  userRow.role === 'user' &&
  userRow.content === 'How is my HRV?' &&
  userRow.tool_calls === null &&
  userRow.created_at
    ? ok('plain user turn stored, tool_calls NULL')
    : bad('user row', JSON.stringify(userRow));

  const assistantRow = raw.prepare('SELECT * FROM ai_messages WHERE id = ?').get(assistantId);
  assistantRow && JSON.stringify(JSON.parse(assistantRow.tool_calls)) === JSON.stringify(calls)
    ? ok('assistant turn stores its tool-call record as JSON')
    : bad('assistant row', JSON.stringify(assistantRow));

  const empty = appendMessage(db, convo, 'assistant', 'plain', []);
  raw.prepare('SELECT tool_calls FROM ai_messages WHERE id = ?').get(empty).tool_calls === null
    ? ok('an empty tool-call array stores as NULL, not "[]"')
    : bad('empty array storage');
}

console.log('4. appendMessage touches the conversation, so "latest" tracks activity');
{
  const { db, raw } = freshDb();
  // Seed two backdated threads via INSERT — the updated_at trigger only fires
  // on UPDATE, so explicit values stick (an UPDATE-based backdate would be
  // restamped to "now" and make the assertion a same-millisecond coin flip).
  raw
    .prepare(
      `INSERT INTO ai_conversations (id, created_at, updated_at)
       VALUES ('older', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z'),
              ('newer', '2000-01-02T00:00:00.000Z', '2000-01-02T00:00:00.000Z')`
    )
    .run();
  latestConversation(db).id === 'newer' ? ok('seeded: newer is latest') : bad('seed order');
  appendMessage(db, 'older', 'user', 'hello again');
  latestConversation(db).id === 'older'
    ? ok('appending resurfaces the thread (updated_at trigger restamps)')
    : bad('latest ordering');
}

console.log('5. listMessages returns the thread oldest-first, insertion-stable');
{
  const { db } = freshDb();
  const convo = createConversation(db);
  appendMessage(db, convo, 'user', 'one');
  appendMessage(db, convo, 'assistant', 'two');
  appendMessage(db, convo, 'user', 'three');
  const other = createConversation(db);
  appendMessage(db, other, 'user', 'other thread');

  const contents = listMessages(db, convo).map((m) => m.content);
  JSON.stringify(contents) === JSON.stringify(['one', 'two', 'three'])
    ? ok('ordered oldest-first even within the same millisecond')
    : bad('order', JSON.stringify(contents));
}

console.log('6. deleting a conversation cascades to its messages');
{
  const { db, raw } = freshDb();
  const convo = createConversation(db);
  appendMessage(db, convo, 'user', 'soon gone');
  raw.prepare('DELETE FROM ai_conversations WHERE id = ?').run(convo);
  raw.prepare('SELECT count(*) c FROM ai_messages').get().c === 0
    ? ok('messages deleted with their conversation (FK CASCADE)')
    : bad('cascade');
}

console.log('7. CHECK constraints reject bad data at the DB layer');
{
  const { db, raw } = freshDb();
  const convo = createConversation(db);
  throws(() =>
    raw
      .prepare(
        `INSERT INTO ai_messages (id, conversation_id, role, content) VALUES ('x', ?, 'coach', 'hi')`
      )
      .run(convo)
  )
    ? ok('unknown role rejected by the enum CHECK')
    : bad('unknown role accepted');
  throws(() =>
    raw
      .prepare(
        `INSERT INTO ai_messages (id, conversation_id, role, content, tool_calls) VALUES ('y', ?, 'assistant', 'hi', 'not json')`
      )
      .run(convo)
  )
    ? ok('non-JSON tool_calls rejected by json_valid')
    : bad('bad json accepted');
  throws(() =>
    raw
      .prepare(`INSERT INTO ai_messages (id, conversation_id, role) VALUES ('z', ?, 'user')`)
      .run(convo)
  )
    ? ok('a message with no content rejected (content NOT NULL)')
    : bad('contentless message accepted');
  throws(() => appendMessage(db, 'no-such-conversation', 'user', 'orphan'))
    ? ok('orphan message rejected (FK enforced)')
    : bad('orphan accepted');
}

console.log('8. setConversationTitle + parseToolCalls round-trip');
{
  const { db } = freshDb();
  const convo = createConversation(db);
  setConversationTitle(db, convo, 'HRV deep-dive');
  latestConversation(db).title === 'HRV deep-dive' ? ok('title set') : bad('title');

  const calls = [
    { id: 't1', name: 'set_reminder', input: { title: 'Mg' }, result: '{}', declined: true },
  ];
  JSON.stringify(parseToolCalls(JSON.stringify(calls))) === JSON.stringify(calls)
    ? ok('parseToolCalls round-trips')
    : bad('round-trip');
  parseToolCalls(null).length === 0 && parseToolCalls('{"not":"array"}').length === 0
    ? ok('NULL and non-array parse to empty, never throw')
    : bad('lenient parse');
}

console.log('9. 0028: turn_outcome back-fills every pre-existing row as complete');
{
  // Build the database as it stood BEFORE 0028, write turns into it, then
  // upgrade — the real shape of an existing install taking this migration.
  const { raw, db, migrateAll } = freshDb(27);
  raw.prepare('PRAGMA user_version').get().user_version === 27
    ? ok('staged at user_version 27 (pre-0028)')
    : bad('stage version', raw.prepare('PRAGMA user_version').get().user_version);
  !raw
    .prepare(`SELECT name FROM pragma_table_info('ai_messages')`)
    .all()
    .map((r) => r.name)
    .includes('turn_outcome')
    ? ok('turn_outcome absent before 0028')
    : bad('column present too early');

  // Seeded with raw SQL: the repository writes turn_outcome now, and the whole
  // point is rows written by the OLD code path, which did not know the column.
  const convo = createConversation(db);
  const oldUser = 'legacy-user';
  const oldReply = 'legacy-reply';
  raw
    .prepare(
      `INSERT INTO ai_messages (id, conversation_id, role, content)
       VALUES (?, ?, 'user', 'legacy question'), (?, ?, 'assistant', 'legacy answer')`
    )
    .run(oldUser, convo, oldReply, convo);

  migrateAll();
  const version = raw.prepare('PRAGMA user_version').get().user_version;
  version >= 28 ? ok(`upgraded to user_version ${version} (>= 28)`) : bad('upgrade', version);

  const outcomes = raw
    .prepare('SELECT id, turn_outcome FROM ai_messages WHERE id IN (?, ?)')
    .all(oldUser, oldReply)
    .map((r) => r.turn_outcome);
  outcomes.length === 2 && outcomes.every((o) => o === 'complete')
    ? ok('pre-existing rows read as complete, never NULL or unknown')
    : bad('back-fill', JSON.stringify(outcomes));

  const column = raw
    .prepare(`SELECT * FROM pragma_table_info('ai_messages') WHERE name = 'turn_outcome'`)
    .get();
  column && column.notnull === 1 && column.dflt_value === `'complete'`
    ? ok("column is NOT NULL DEFAULT 'complete'")
    : bad('column shape', JSON.stringify(column));
}

console.log('10. every turn_outcome round-trips; the CHECK rejects anything else');
{
  const { db, raw } = freshDb();
  const convo = createConversation(db);
  const vocabulary = ['complete', 'truncated', 'tool_limit', 'refused', 'failed'];
  const ids = vocabulary.map((outcome) =>
    appendMessage(db, convo, 'assistant', `ended ${outcome}`, null, outcome)
  );
  const stored = listMessages(db, convo).map((m) => m.turn_outcome);
  JSON.stringify(stored) === JSON.stringify(vocabulary)
    ? ok('all five outcomes survive a write/read cycle')
    : bad('round-trip', JSON.stringify(stored));
  ids.every((id) => typeof id === 'string' && id.length > 0)
    ? ok('appendMessage still returns the new id')
    : bad('ids');

  appendMessage(db, convo, 'user', 'plain ask') &&
  raw.prepare(`SELECT turn_outcome o FROM ai_messages WHERE content = 'plain ask'`).get().o ===
    'complete'
    ? ok('a user turn defaults to complete without the caller saying so')
    : bad('default arg');

  throws(() => appendMessage(db, convo, 'assistant', 'bogus', null, 'partial'))
    ? ok('an outcome outside the vocabulary is rejected by the CHECK')
    : bad('bad outcome accepted');
  throws(() =>
    raw
      .prepare(
        `INSERT INTO ai_messages (id, conversation_id, role, content, turn_outcome) VALUES ('n', ?, 'assistant', 'x', NULL)`
      )
      .run(convo)
  )
    ? ok('NULL turn_outcome rejected (NOT NULL)')
    : bad('null outcome accepted');
}

console.log('11. outcomeForStopReason maps every wire stop reason');
{
  const expected = {
    end_turn: 'complete',
    max_tokens: 'truncated',
    tool_use_limit: 'tool_limit',
    refusal: 'refused',
  };
  const actual = Object.fromEntries(
    Object.keys(expected).map((reason) => [reason, outcomeForStopReason(reason)])
  );
  JSON.stringify(actual) === JSON.stringify(expected)
    ? ok('end_turn/max_tokens/tool_use_limit/refusal map as specified')
    : bad('mapping', JSON.stringify(actual));
  outcomeForStopReason('max_tokens') !== 'complete'
    ? ok('a cut-off turn can never be recorded as complete')
    : bad('max_tokens read as complete');
}

console.log('12. retry appends beside the fragment; the record matches the display');
{
  const { db, raw } = freshDb();
  const convo = createConversation(db);
  // The case that matters: the user approved a write, the tool ran, THEN the
  // model was cut off at max_tokens mid-sentence.
  const landedWrite = {
    id: 'toolu_w1',
    name: 'log_metric',
    input: { metric: 'weight', value: 178 },
    result: '{"ok":true}',
  };
  appendMessage(db, convo, 'user', 'log my weight at 178 and explain the trend');
  const fragmentId = appendMessage(
    db,
    convo,
    'assistant',
    'Logged. Your 7-day trend is',
    [landedWrite],
    'truncated'
  );
  // Retry: a NEW turn is appended. Nothing is deleted — there is no DELETE in
  // the repository at all, and the fragment must survive a reload.
  const retryId = appendMessage(db, convo, 'assistant', 'Logged. Trend is down 0.4 kg.', null);

  raw.prepare('SELECT count(*) c FROM ai_messages').get().c === 3
    ? ok('retry left all three rows in place (no delete)')
    : bad('row count', raw.prepare('SELECT count(*) c FROM ai_messages').get().c);
  raw.prepare('SELECT turn_outcome o FROM ai_messages WHERE id = ?').get(fragmentId).o ===
  'truncated'
    ? ok('the fragment is still on record, still marked truncated')
    : bad('fragment outcome');

  const thread = listThread(db, convo);
  JSON.stringify(thread.map((m) => m.superseded)) === JSON.stringify([false, true, false])
    ? ok('reload marks the fragment superseded, the retry live')
    : bad('superseded marks', JSON.stringify(thread.map((m) => m.superseded)));
  thread[1].id === fragmentId && thread[2].id === retryId
    ? ok('order preserved: fragment before its replacement')
    : bad('thread order');

  // What the screen derives live is the same rule over the same rows, so a
  // reloaded thread and an in-session one cannot disagree.
  const live = markSupersededTurns([
    { role: 'user' },
    { role: 'assistant' },
    { role: 'assistant' },
  ]);
  JSON.stringify(live.map((m) => m.superseded)) === JSON.stringify(thread.map((m) => m.superseded))
    ? ok('the live view-model derivation agrees with the stored thread')
    : bad('live vs stored', JSON.stringify(live.map((m) => m.superseded)));

  // The truncated turn must still be able to say the write landed.
  const isWrite = (name) => name.startsWith('log_') || name.startsWith('set_');
  const calls = parseToolCalls(
    raw.prepare('SELECT tool_calls FROM ai_messages WHERE id = ?').get(fragmentId).tool_calls
  );
  const landed = landedWriteCalls(calls, isWrite);
  landed.length === 1 && landed[0].name === 'log_metric'
    ? ok('the committed write survives on the truncated turn, readable after reload')
    : bad('landed writes', JSON.stringify(landed));
  landedWriteCalls(
    [
      { id: 'a', name: 'log_meal', input: {}, result: 'declined', declined: true },
      { id: 'b', name: 'log_workout', input: {}, result: 'boom', isError: true },
      { id: 'c', name: 'get_metric_series', input: {}, result: '{}' },
    ],
    isWrite
  ).length === 0
    ? ok('declined, errored and read-only calls are not reported as landed')
    : bad('landed filter too loose');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
