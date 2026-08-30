/**
 * Headless test of the AI chat data layer — ai_conversations + ai_messages
 * (0008_ai_chat.sql) and their repository (ai-chat.ts) — against real SQLite
 * via node:sqlite. Mirrors db/nutrition.test.mjs; op-sqlite is never loaded.
 * Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  appendMessage,
  createConversation,
  getOrCreateActiveConversation,
  latestConversation,
  listMessages,
  listThread,
  markTurnStatus,
  parseToolCalls,
  parseTurnStatus,
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

console.log('9. markTurnStatus records an unfinished turn without editing it');
{
  const { db, raw } = freshDb();
  const convo = createConversation(db);
  appendMessage(db, convo, 'user', 'Log my weight at 178 and summarise the week.');
  const calls = [
    {
      id: 'toolu_w',
      name: 'log_body_metric',
      input: { metric: 'weight', value: 178 },
      result: '{}',
    },
  ];
  const partial = appendMessage(db, convo, 'assistant', 'Logged 178 lb. Now looking at', calls);
  markTurnStatus(db, convo, partial, 'tool_use_limit');

  const row = raw.prepare('SELECT * FROM ai_messages WHERE id = ?').get(partial);
  row.content === 'Logged 178 lb. Now looking at' &&
  JSON.stringify(JSON.parse(row.tool_calls)) === JSON.stringify(calls)
    ? ok('the annotated turn is untouched — content and audit record intact')
    : bad('partial row mutated', JSON.stringify(row));

  const markers = raw.prepare(`SELECT * FROM ai_messages WHERE role = 'system'`).all();
  markers.length === 1 && parseTurnStatus(markers[0])?.status === 'tool_use_limit'
    ? ok('the marker is a separate append-only system row')
    : bad('marker row', JSON.stringify(markers));

  const thread = listThread(db, convo);
  thread.length === 2 &&
  thread[0].status === null &&
  thread[1].message.id === partial &&
  thread[1].status === 'tool_use_limit'
    ? ok('listThread hides marker rows and folds the status onto its turn')
    : bad('thread fold', JSON.stringify(thread.map((t) => [t.message.role, t.status])));
}

console.log('10. retry supersedes rather than deletes: the fragment survives, marked');
{
  const { db, raw } = freshDb();
  const convo = createConversation(db);
  appendMessage(db, convo, 'user', 'Set a reminder.');
  const partial = appendMessage(db, convo, 'assistant', 'Reminder set. I was about', [
    { id: 't', name: 'set_reminder', input: { title: 'Mg' }, result: '{}' },
  ]);
  markTurnStatus(db, convo, partial, 'failed');
  markTurnStatus(db, convo, partial, 'superseded'); // the user retried
  appendMessage(db, convo, 'assistant', 'Reminder set for 21:00.');

  listThread(db, convo).find((t) => t.message.id === partial)?.status === 'superseded'
    ? ok('the last marker wins (failed → superseded)')
    : bad('marker precedence');
  raw.prepare('SELECT count(*) c FROM ai_messages WHERE id = ?').get(partial).c === 1
    ? ok('the partial turn is never DELETEd — the write audit trail survives retry')
    : bad('partial deleted');
  const roles = listThread(db, convo).map((t) => t.message.role);
  JSON.stringify(roles) === JSON.stringify(['user', 'assistant', 'assistant'])
    ? ok('the retry reply follows the marked fragment, in order')
    : bad('thread order', JSON.stringify(roles));
}

console.log('11. parseTurnStatus is strict about what counts as a marker');
{
  const { db } = freshDb();
  const convo = createConversation(db);
  const row = (id, role, content) => ({
    id,
    conversation_id: convo,
    role,
    content,
    tool_calls: null,
    created_at: '2026-01-01T00:00:00.000Z',
  });

  parseTurnStatus(
    row(
      'a',
      'assistant',
      JSON.stringify({ marker: 'arc.turn_status', messageId: 'm', status: 'failed' })
    )
  ) === null
    ? ok('an assistant turn is never a marker, whatever its text says')
    : bad('assistant treated as marker');
  parseTurnStatus(row('b', 'system', 'you are a helpful coach')) === null &&
  parseTurnStatus(row('c', 'system', '{"marker":"something-else"}')) === null
    ? ok('plain and foreign system rows are not markers, and never throw')
    : bad('loose marker parse');
  parseTurnStatus(
    row(
      'd',
      'system',
      JSON.stringify({ marker: 'arc.turn_status', messageId: 'm', status: 'exploded' })
    )
  ) === null
    ? ok('an unknown status is ignored rather than trusted')
    : bad('unknown status accepted');

  const id = markTurnStatus(db, convo, 'some-message', 'max_tokens');
  const stored = listMessages(db, convo).find((m) => m.id === id);
  JSON.stringify(parseTurnStatus(stored)) ===
  JSON.stringify({ messageId: 'some-message', status: 'max_tokens' })
    ? ok('markTurnStatus round-trips through parseTurnStatus')
    : bad('round-trip', stored?.content);
  // A marker for a message that isn't in the thread must not invent a turn.
  listThread(db, convo).length === 0
    ? ok('a dangling marker renders nothing')
    : bad('dangling marker rendered');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
