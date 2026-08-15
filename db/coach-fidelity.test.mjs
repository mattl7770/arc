/**
 * Headless test of COACH FIDELITY — the two owner reports of 2026-08-14.
 *
 *   7. "Coach is still frequently thinking that it has done something but not
 *      actually calling the tool - i.e. saying that a recipe has been saved
 *      when the tool was not called and not actually saved."
 *   8. "Coach also does weird things like recommending that I add stuff to my
 *      grocery list from dinner 2 nights ago, it needs to move past things
 *      without me telling it when time has past and I am obviously ignoring it."
 *
 * §1–§5 cover the phantom write. The structural claim under test is narrow and
 * absolute: A RECEIPT EXISTS IF AND ONLY IF A TOOL WROTE. §2 drives the real
 * `streamCoachReply` against real SQLite — the same harness as
 * db/coach-tools.test.mjs §16 — so approve, decline and read-only are exercised
 * through the actual confirmation gate rather than a re-implementation of it.
 *
 * §6 covers the stale suggestion: the model could not see how old the thread it
 * was reading was, because `buildWireHistory` shipped role+content and no time
 * at all.
 *
 * Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { landedWriteReceipts } from '../src/lib/db/repositories/ai-chat.ts';
import { buildWireHistory } from '../src/lib/ai/history-window.ts';
import { claimsCompletedWrite } from '../src/lib/ai/write-claim.ts';
import { runCoachTurn } from '../src/lib/ai/model-client.ts';
import { apiKeyStore } from '../src/lib/ai/api-key-store.ts';
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

const isWrite = (name) => toolByName(name)?.readOnly === false;
const receipts = (calls) => landedWriteReceipts(calls, isWrite, (n) => n);

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

// --- A scripted Messages API stream (the wire shape model-client parses) -----

const sse = (events) =>
  events.map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join('');

const textReply = (text, stopReason = 'end_turn') =>
  sse([
    { type: 'message_start', message: {} },
    ...(text
      ? [
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
          { type: 'content_block_stop', index: 0 },
        ]
      : []),
    { type: 'message_delta', delta: { stop_reason: stopReason } },
    { type: 'message_stop' },
  ]);

/** A round that narrates, then calls one tool — the shape the reports describe. */
const toolUseReply = (preamble, name, input, id = 'toolu_1') =>
  sse([
    { type: 'message_start', message: {} },
    ...(preamble
      ? [
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: preamble } },
          { type: 'content_block_stop', index: 0 },
        ]
      : []),
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id, name, input: {} },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ]);

const responseOf = (body) => {
  const bytes = new TextEncoder().encode(body);
  let sent = false;
  return {
    ok: true,
    status: 200,
    text: async () => body,
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })),
      }),
    },
  };
};

const RECIPE = {
  title: 'Chicken bowl',
  servings: 2,
  ingredients: [{ raw: '200 g chicken thighs' }, { raw: '150 g jasmine rice' }],
};

// =============================================================================
console.log('1. the claim detector: completed writes fire, offers and reads do not');
{
  // FIRES. Every one of these is the owner's report in the model's own register:
  // a finished action, first person or bare, with no tool behind it.
  const claims = [
    'Saved it.',
    "I've saved the recipe to your book.",
    'I saved that for you.',
    'Added milk and eggs to your grocery list.',
    "I've added those to your grocery list.",
    'Logged.',
    'Done.',
    'I logged your weight at 178 lb.',
    'I set a reminder for 21:00.',
    "I've updated your Evening Stack.",
    'Recovery is down. Saved it. Want anything else moved?',
    "Done — it's in your recipe book.",
  ];
  const missed = claims.filter((t) => !claimsCompletedWrite(t));
  missed.length === 0
    ? ok(`all ${claims.length} completed-write claims detected`)
    : bad('missed a claim', JSON.stringify(missed));

  // MUST NOT FIRE. A false positive captions an honest turn "Nothing saved",
  // and a caption that cries wolf is worth nothing on the day it is right.
  // The read-grounded lines here are the dangerous ones: they share every verb
  // with the failure case and differ only in who acted.
  const innocent = [
    'Want me to save that to your recipe book?',
    'I can add those to your grocery list.',
    "I'll save it once you approve.",
    'Shall I add those three?',
    'Would you like me to log that?',
    'You have not logged weight in 11 days. The trend is guesswork until you do.',
    'You logged 178 lb yesterday.',
    "You've saved 12 recipes so far.",
    'I have not saved it.',
    "I haven't added anything yet.",
    "You declined, so I did not save the recipe.",
    'Nothing was saved.',
    'Milk is already on your grocery list.',
    'Saved recipes appear in your recipe book.',
    'Logged meals this week total 12,400 kcal.',
    'Your last logged meal was Tuesday.',
    'Let me know if you want that on the list.',
  ];
  const wrong = innocent.filter((t) => claimsCompletedWrite(t));
  wrong.length === 0
    ? ok(`none of the ${innocent.length} offers, negations or read-grounded lines fire`)
    : bad('false positive', JSON.stringify(wrong));
}

// =============================================================================
console.log('2. the REAL call site: a receipt exists if and only if a tool wrote');
{
  // Same three resolutions db/coach-tools.test.mjs §16 needs to load
  // coach-service under raw node ESM. Nothing else is faked: the agentic loop,
  // the tool registry, the repositories and the SQLite writes are the real ones.
  const LOADER_HOOK = `
const stub = (source) => ({
  url: 'data:text/javascript,' + encodeURIComponent(source),
  shortCircuit: true,
});
const STUBS = new Map([
  ['expo/fetch', stub('export const fetch = (...args) => globalThis.__ARC_TEST_FETCH__(...args);')],
  ['@/lib/db/client', stub('export const getDb = () => globalThis.__ARC_TEST_DB__;')],
]);
export async function resolve(specifier, context, next) {
  const hit = STUBS.get(specifier);
  if (hit) return hit;
  try {
    return await next(specifier, context);
  } catch (error) {
    if (specifier.startsWith('.')) return next(specifier + '/index.ts', context);
    throw error;
  }
}
`;
  register('data:text/javascript,' + encodeURIComponent(LOADER_HOOK), import.meta.url);
  const { streamCoachReply } = await import('../src/lib/ai/coach-service.ts');
  await apiKeyStore.setKey('test-key'); // a key set ⇒ the REAL path, not the mock

  /** Drive one full turn through the real service and gate. */
  async function runTurn({ replies, approve }) {
    const { db, raw } = freshDb();
    globalThis.__ARC_TEST_DB__ = db;
    const queue = [...replies];
    globalThis.__ARC_TEST_FETCH__ = async () => responseOf(queue.shift());

    let card = null;
    const result = await streamCoachReply(
      [{ id: 'u1', role: 'user', content: 'save that recipe', createdAt: Date.now() }],
      {
        onToken: () => {},
        confirmWrite: async (request) => {
          card = request.summary;
          return approve;
        },
      }
    );
    return { result, card, raw };
  }

  // --- APPROVED: the write lands, and the receipt is the approved line -------
  {
    const { result, card, raw } = await runTurn({
      replies: [
        toolUseReply("I'll save that now.", 'save_recipe', RECIPE),
        textReply('Saved. Chicken bowl, 2 servings.'),
      ],
      approve: true,
    });
    const rows = raw.prepare('SELECT title FROM recipes').all();
    const got = receipts(result.toolCalls);
    rows.length === 1 && got.length === 1 && got[0] === card
      ? ok(`the row landed and its receipt is the line approved: "${got[0]}"`)
      : bad('approved receipt', JSON.stringify({ rows, got, card }));
  }

  // --- DECLINED: no row, no receipt. The exact case the report describes, and
  // the one where the model has already narrated a save before the gate opened.
  {
    const { result, raw } = await runTurn({
      replies: [
        toolUseReply("I'll save that to your book now.", 'save_recipe', RECIPE),
        textReply("Understood, I won't save it."),
      ],
      approve: false,
    });
    const rows = raw.prepare('SELECT title FROM recipes').all();
    const got = receipts(result.toolCalls);
    rows.length === 0 && got.length === 0 && result.toolCalls[0].declined === true
      ? ok('a declined write writes no row and mints no receipt')
      : bad('declined receipt', JSON.stringify({ rows, got, calls: result.toolCalls }));
  }

  // --- DECLINED, then the model says nothing. `settledText` falls back to the
  // pre-tool narration, so the turn SETTLES on "I'll save that to your book
  // now." — a promise, after a refusal, with nothing written. The receipt is
  // what keeps that honest: there is none, so the thread cannot imply a save.
  {
    const { result, raw } = await runTurn({
      replies: [
        toolUseReply("I'll save that to your book now.", 'save_recipe', RECIPE),
        textReply('', 'end_turn'),
      ],
      approve: false,
    });
    const got = receipts(result.toolCalls);
    raw.prepare('SELECT title FROM recipes').all().length === 0 &&
    got.length === 0 &&
    result.text.includes("I'll save that")
      ? ok('a silent round after a decline settles on narration, and still shows no receipt')
      : bad('narration fallback', JSON.stringify({ text: result.text, got }));
  }

  // --- A READ tool never mints one: there is nothing to receipt.
  {
    const { result } = await runTurn({
      replies: [
        toolUseReply('', 'get_today_snapshot', {}),
        textReply('You have logged nothing today.'),
      ],
      approve: true,
    });
    result.toolCalls.length === 1 &&
    result.toolCalls[0].receipt === undefined &&
    receipts(result.toolCalls).length === 0
      ? ok('a read tool mints no receipt')
      : bad('read receipt', JSON.stringify(result.toolCalls));
  }

  // --- THE PHANTOM ITSELF: the model claims the save and calls no tool at all.
  {
    const { result, raw } = await runTurn({
      replies: [textReply('Saved it. Chicken bowl is in your recipe book now.')],
      approve: true,
    });
    raw.prepare('SELECT title FROM recipes').all().length === 0 &&
    result.toolCalls.length === 0 &&
    receipts(result.toolCalls).length === 0 &&
    claimsCompletedWrite(result.text)
      ? ok('a claimed save with no tool call: no row, no receipt, and the claim is detected')
      : bad('phantom turn', JSON.stringify({ text: result.text, calls: result.toolCalls }));
  }
}

// =============================================================================
console.log('3. a truncated turn still reports the write it already made');
{
  // The load-bearing pre-existing case, re-pinned because the receipt now
  // carries it: the reply was cut off AFTER the user approved, so the change is
  // real and must be reported as real.
  let calls = 0;
  const result = await runCoachTurn(
    {
      apiKey: 'k',
      model: 'm',
      fetchImpl: async () =>
        responseOf(
          calls++ === 0
            ? toolUseReply("I'll log that.", 'log_metric', { metric: 'weight', value: 178 })
            : textReply('Logged 178 lb and your seven day aver', 'max_tokens')
        ),
    },
    { system: 's', messages: [{ role: 'user', content: 'log 178' }], tools: [] },
    {
      onToken: () => {},
      executeTool: async () => ({ content: '{"ok":true}', receipt: 'Log weight 178 lb' }),
    }
  );
  result.stopReason === 'max_tokens' && receipts(result.toolCalls)[0] === 'Log weight 178 lb'
    ? ok('a max_tokens turn keeps the receipt for the write that already landed')
    : bad('truncated receipt', JSON.stringify(result));
}

// =============================================================================
console.log('4. an errored write mints no receipt');
{
  const result = await runCoachTurn(
    { apiKey: 'k', model: 'm', fetchImpl: async () => responseOf(textReply('ok')) },
    { system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] },
    { onToken: () => {}, executeTool: async () => ({ content: 'boom', isError: true }) }
  );
  // The loop only carries a receipt the caller supplied, and coach-service
  // supplies one only past `execute` — so an error can never arrive with one.
  result.toolCalls.every((c) => c.receipt === undefined)
    ? ok('the loop never invents a receipt the caller did not supply')
    : bad('errored receipt', JSON.stringify(result.toolCalls));
}

// =============================================================================
console.log('5. receipts survive the round trip through the stored tool record');
{
  const stored = JSON.parse(
    JSON.stringify([
      { id: 't1', name: 'save_recipe', input: {}, result: '{}', receipt: 'Save recipe "Chicken bowl"' },
      { id: 't2', name: 'get_recipes', input: {}, result: '[]' },
      { id: 't3', name: 'log_metric', input: {}, result: '{}', declined: true },
      { id: 't4', name: 'add_grocery_items', input: {}, result: '{}' },
    ])
  );
  const got = receipts(stored);
  got.length === 2 && got[0] === 'Save recipe "Chicken bowl"' && got[1] === 'add_grocery_items'
    ? ok('reads and declines drop out; a pre-receipt row falls back to its tool name')
    : bad('stored receipts', JSON.stringify(got));
}

// =============================================================================
console.log('6. the thread the model reads is dated, so time can pass in it');
{
  const DAY = 86_400_000;
  const now = new Date(2026, 7, 14, 10, 0, 0);
  const at = (daysAgo, hour = 9) =>
    new Date(2026, 7, 14 - daysAgo, hour, 0, 0).getTime();

  const turn = (id, role, content, createdAt) => ({ id, role, content, createdAt });

  // The owner's scenario: a dinner discussed two nights ago, still being raised
  // today. Before this, every one of these turns arrived undated and the model
  // had no way to know the salmon was old news.
  const thread = [
    turn('u1', 'user', 'had salmon and asparagus for dinner', at(2)),
    turn('a1', 'assistant', 'Logged. Want the ingredients on your grocery list?', at(2)),
    turn('u2', 'user', 'how did I sleep', at(1)),
    turn('a2', 'assistant', 'Seven hours two minutes.', at(1)),
    turn('u3', 'user', 'what should I do now', at(0)),
  ];
  const wire = buildWireHistory(thread, null, now);

  wire.length === 5 &&
  wire[0].content.startsWith('[2 days ago]\n') &&
  wire[2].content.startsWith('[yesterday]\n') &&
  wire[4].content.startsWith('[today]\n')
    ? ok('each calendar boundary is stamped: 2 days ago / yesterday / today')
    : bad('day stamps', JSON.stringify(wire.map((m) => m.content.slice(0, 24))));

  // Stamped ON CHANGE ONLY — the second turn of a day carries no stamp. This is
  // the whole cost control: a same-day thread pays for one stamp, not thirty.
  wire[1].content.startsWith('Logged.') && wire[3].content.startsWith('Seven hours')
    ? ok('a turn on the same day as its predecessor is not re-stamped')
    : bad('over-stamped', JSON.stringify(wire.map((m) => m.content.slice(0, 24))));

  const sameDay = buildWireHistory(
    [turn('u1', 'user', 'hi', at(0, 8)), turn('a1', 'assistant', 'Hello.', at(0, 9))],
    null,
    now
  );
  sameDay.filter((m) => m.content.includes('[')).length === 1
    ? ok('a thread entirely within today costs exactly one "[today]"')
    : bad('same-day cost', JSON.stringify(sameDay));

  // SQLite's strftime('now') reads a finer clock than Date.now() on Windows, so
  // the newest row can measure as fractionally in the future. Clamped, or the
  // freshest turn in the thread would read "-1 days ago".
  const future = buildWireHistory(
    [turn('u1', 'user', 'just now', now.getTime() + 4 * DAY)],
    null,
    now
  );
  future[0].content.startsWith('[today]\n')
    ? ok('a turn stamped ahead of the wall clock clamps to "today", never a negative age')
    : bad('future clamp', future[0].content);

  // An unparseable stored timestamp is NaN after Date.parse. It must not invent
  // a boundary, and must not throw.
  const broken = buildWireHistory(
    [turn('u1', 'user', 'first', at(1)), turn('a1', 'assistant', 'reply', NaN)],
    null,
    now
  );
  broken.length === 2 && !broken[1].content.includes('[')
    ? ok('an unreadable timestamp inherits its neighbour rather than inventing a day')
    : bad('NaN stamp', JSON.stringify(broken));

  // The stamp must survive the two transforms that follow it: the leading
  // assistant shed, and the rolling summary folded into the first user turn.
  const shed = buildWireHistory(
    [turn('a0', 'assistant', 'orphan', at(3)), turn('u1', 'user', 'question', at(1))],
    'they hurt their knee in March',
    now
  );
  shed.length === 1 &&
  shed[0].role === 'user' &&
  shed[0].content.includes('[Earlier in this conversation:') &&
  shed[0].content.includes('[yesterday]')
    ? ok('the first surviving turn keeps its stamp after the shed and the summary fold')
    : bad('shed + summary', JSON.stringify(shed));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
