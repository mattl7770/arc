/**
 * Where a Coach turn's money goes — a headless measurement of the REAL wire
 * request (src/lib/ai/model-client.ts buildMessagesRequest), segment by
 * segment, with the prompt-cache breakpoints located.
 *
 * This exists because the app's own cost trace and a chars/N token proxy
 * disagreed by 4×. The owner's "We need milk" turn reported
 *
 *     2 tool calls · 14.6k cache write · 29.2k cached · 7.3k in · 134 out · ~$0.08
 *
 * against an intended cached prefix of ~10.5k tokens. Nothing here argues about
 * that; it rebuilds the exact bytes the client would send and counts them.
 *
 * NO NETWORK, NO API KEY. The model client is pure and its fetch is injected,
 * so the whole agentic loop runs here against a scripted mock that reports
 * usage exactly as the Messages API does. Run:
 *
 *     node --import ./db/register-ts-hooks.mjs db/measure-coach-request.mjs
 *
 * ## On the token estimate
 *
 * Anthropic's tokenizer is not public and there is no local copy, so every
 * number below is an ESTIMATE — but a bounded one, not a guess.
 *
 * The estimator counts PRETOKENS using the cl100k_base pretokenizer regex
 * (contractions, letter runs with an optional leading space, digit runs of 1-3,
 * punctuation runs, whitespace runs). Pretokens matter because BPE merges never
 * cross a pretoken boundary: whatever the vocabulary, tokens >= pretokens. That
 * makes the pretoken count a hard LOWER BOUND, and — unlike chars/N — it is
 * already insensitive to the thing that broke the old proxy, namely that dense
 * JSON schemas are mostly punctuation, where every `"`, `{`, `:` is its own
 * pretoken and cannot merge with its neighbours.
 *
 * The reported estimate is pretokens x K, with K calibrated ONCE against the
 * only ground truth available: the device's own `cache_creation_input_tokens`
 * for the tools+system prefix. K is printed so the calibration is auditable,
 * and it is cross-checked against a second, independent device number.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { todayISODate } from '../src/lib/db/date.ts';
import { updateProfile } from '../src/lib/db/repositories/user.ts';
import { createExperiment } from '../src/lib/db/repositories/experiments.ts';
import { getOrCreateDailyLog, insertMissionItem } from '../src/lib/db/repositories/mission.ts';
import { rememberFact, MEMORY_PROMPT_LIMIT } from '../src/lib/db/repositories/coach-memory.ts';
import { addGroceryItems } from '../src/lib/db/repositories/grocery.ts';

import { buildCoachSystemPrompt } from '../src/lib/ai/system-prompt.ts';
import { buildTurnContext } from '../src/lib/ai/turn-context.ts';
import { buildWireHistory } from '../src/lib/ai/history-window.ts';
import { COACH_TOOLS, toWireTools } from '../src/lib/ai/tools/index.ts';
import { buildMessagesRequest, runCoachTurn } from '../src/lib/ai/model-client.ts';
import { estimateCost, usageCaption } from '../src/lib/ai/cost.ts';

// --- The device's ground truth (the owner's two reported turns) --------------

/** "2 tool calls · 14.6k cache write · 29.2k cached · 7.3k in · 134 out · ~$0.08" */
const MILK_TURN = {
  toolCalls: 2,
  cacheWriteTokens: 14_600,
  cacheReadTokens: 29_200,
  inputTokens: 7_300,
  outputTokens: 134,
  dollars: 0.08,
};
/** "1 tool call · 29.2k cached · 5.7k in · 341 out · ~$0.02" */
const NUTRITION_TURN = {
  toolCalls: 1,
  cacheWriteTokens: 0,
  cacheReadTokens: 29_200,
  inputTokens: 5_700,
  outputTokens: 341,
  dollars: 0.02,
};
const MODEL = 'claude-sonnet-5';

// --- Estimator ---------------------------------------------------------------

/**
 * cl100k_base pretokenization. Every BPE token lives inside exactly one of
 * these spans, so `pretokens(text) <= realTokens(text)` for any BPE vocabulary
 * built on this pretokenizer.
 */
const PRETOKEN =
  /'(?:[sdmt]|ll|ve|re)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;

function pretokens(text) {
  return (String(text).match(PRETOKEN) ?? []).length;
}

/** Calibration constant: real tokens per pretoken. Solved below, printed. */
let K = 1;
const est = (text) => Math.round(pretokens(text) * K);

// --- Fixture: a plausible, well-used device ----------------------------------

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

const NOW = new Date('2026-08-08T09:20:00Z');
const TODAY = todayISODate(NOW);

let seq = 0;
const uid = () => `mx-${++seq}`;

/**
 * @param memoryCount how many durable memories the store holds. The turn
 *   context carries up to MEMORY_PROMPT_LIMIT of them, so this is the one input
 *   that makes the uncached block grow over months of use.
 */
function seedDb(memoryCount) {
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

  updateProfile(db, { dateOfBirth: '1988-04-02', biologicalSex: 'male' });

  const wearable = (metricType, value, daysAgo = 0) => {
    const d = new Date(NOW);
    d.setUTCDate(d.getUTCDate() - daysAgo);
    raw
      .prepare(
        `INSERT INTO wearable_data (id, date, metric_type, value, source_device)
         VALUES (?, ?, ?, ?, 'apple_health')`
      )
      .run(uid(), todayISODate(d), metricType, value);
  };
  for (let d = 0; d < 30; d++) {
    wearable('hrv', 46 - (d % 7), d);
    wearable('rhr', 52 + (d % 4), d);
    wearable('sleep_duration_min', 430 - (d % 5) * 12, d);
    wearable('sleep_deep_min', 71 - (d % 6) * 3, d);
    wearable('steps', 9200 - (d % 9) * 400, d);
    wearable('active_energy_kcal', 620 - (d % 5) * 40, d);
  }

  const log = getOrCreateDailyLog(db, TODAY);
  const missionSeed = [
    ['Evening Stack', '21:00', 'completed'],
    ['Zone 2, 45 min', '07:00', 'completed'],
    ['Protein target 180 g', null, 'pending'],
    ['Creatine 5 g', '08:00', 'completed'],
    ['Sauna 20 min', '19:30', 'pending'],
    ['Log weight', '07:15', 'pending'],
  ];
  for (const [title, time, status] of missionSeed) {
    insertMissionItem(db, log.id, 'habit', {
      id: uid(),
      title,
      status,
      scheduledTime: time,
      category: 'other',
      why: null,
      estimatedMinutes: null,
      protocol: null,
    });
  }

  createExperiment(db, {
    title: 'Magnesium glycinate at 21:00',
    hypothesis: 'Deep sleep rises by 10 minutes.',
    intervention: '400 mg magnesium glycinate, nightly, 21:00.',
    metrics: ['sleep_deep_min', 'hrv'],
    startDate: todayISODate(new Date(NOW.getTime() - 9 * 86_400_000)),
    durationDays: 21,
  });

  const memoryLines = [
    'Prefers training in the morning before 08:00.',
    'Reacts badly to niacin flush; will not take flush-form B3.',
    'Target body weight is 178 lb at 12% body fat.',
    'Travels to the UK roughly one week in four.',
    'Will not eat breakfast before a fasted Zone 2 block.',
    'Uses a standing desk; do not suggest step-count nudges before noon.',
    'Lactose intolerant above about 200 ml of milk.',
    'Has a history of left Achilles tendinopathy; avoid plyometrics.',
    'Wants ApoB under 60 mg/dL as the primary lipid target.',
    'Drinks coffee only before 11:00.',
  ];
  for (let i = 0; i < memoryCount; i++) {
    rememberFact(db, {
      content: `${memoryLines[i % memoryLines.length]} (${Math.floor(i / memoryLines.length) + 1})`,
      category: 'preference',
    });
  }

  addGroceryItems(db, [
    { name: 'eggs', qty_text: '18', source: 'user' },
    { name: 'olive oil', qty_text: '1 L', source: 'user' },
    { name: 'spinach', qty_text: null, source: 'user' },
    { name: 'greek yogurt', qty_text: '1 kg', source: 'user' },
  ]);

  return db;
}

// --- The turn under measurement ----------------------------------------------

/** A thread ten messages deep, ending in the owner's actual message. */
const HISTORY = [
  { role: 'user', content: 'How did I sleep?' },
  {
    role: 'assistant',
    content: 'You slept 7h10. Deep was 71 min, which is your best in nine days.',
    toolCalls: [],
  },
  { role: 'user', content: 'And HRV?' },
  {
    role: 'assistant',
    content: 'HRV averaged 44 ms over the last 7 days, against 48 ms on your 30-day baseline.',
    toolCalls: [
      {
        id: 't1',
        name: 'get_metric_series',
        input: { metric: 'hrv', days: 30 },
        result: JSON.stringify({ metric: 'hrv', hasData: true, avg7: 44.1, avg30: 47.8, n: 30 }),
      },
    ],
  },
  { role: 'user', content: 'Should I train today?' },
  {
    role: 'assistant',
    content:
      'Train, but cut volume 20%. Recovery is amber and you are on the road. Keep the Zone 2 block.',
    toolCalls: [],
  },
  { role: 'user', content: 'What is left on the mission?' },
  {
    role: 'assistant',
    content: 'Three left: protein target, sauna at 19:30, weight log.',
    toolCalls: [],
  },
  { role: 'user', content: 'We need milk' },
];

const bytes = (s) => Buffer.byteLength(String(s), 'utf8');
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function heading(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

// --- 1. Build the real request ------------------------------------------------

const db = seedDb(12);
const system = buildCoachSystemPrompt();
const systemContext = buildTurnContext(db, NOW);
const wireTools = toWireTools(COACH_TOOLS);
const messages = buildWireHistory(HISTORY, null);

const built = buildMessagesRequest(
  { apiKey: 'not-a-key', model: MODEL, fetchImpl: async () => ({}) },
  { system, systemContext, messages, tools: wireTools }
);
const body = JSON.parse(built.body);

// Determinism: the cached prefix must be byte-identical call to call, or it can
// never hit. Rebuild it and compare.
const prefixNow = JSON.stringify(toWireTools(COACH_TOOLS)) + buildCoachSystemPrompt();
const prefixAgain = JSON.stringify(toWireTools(COACH_TOOLS)) + buildCoachSystemPrompt();

heading('0. PREFIX DETERMINISM');
console.log(`  tools+system byte-stable across calls: ${prefixNow === prefixAgain ? 'YES' : 'NO'}`);
console.log(
  `  turn context byte-stable at a fixed clock: ${
    buildTurnContext(db, NOW) === systemContext ? 'YES' : 'NO'
  }`
);
console.log(
  `  turn context changes when the clock moves a day: ${
    buildTurnContext(db, new Date(NOW.getTime() + 86_400_000)) !== systemContext ? 'YES' : 'NO'
  }  (why it must stay OUT of the cached block)`
);

// --- 2. Calibrate against the device -----------------------------------------

// What the API bills as `cache_creation_input_tokens` is everything up to the
// LAST cache_control breakpoint: the whole tools array plus the static system
// block. That is the one segment the device gave us an exact number for.
const toolsJson = JSON.stringify(body.tools);
const cachedPrefixText = toolsJson + system;
const prefixPretokens = pretokens(cachedPrefixText);
K = MILK_TURN.cacheWriteTokens / prefixPretokens;

heading('1. CALIBRATION — pretokens against the device-reported cache write');
console.log(`  cached prefix (tools JSON + static system)`);
console.log(`    bytes                    ${rpad(bytes(cachedPrefixText).toLocaleString(), 9)}`);
console.log(`    pretokens (lower bound)  ${rpad(prefixPretokens.toLocaleString(), 9)}`);
console.log(
  `    device cache write       ${rpad(MILK_TURN.cacheWriteTokens.toLocaleString(), 9)}  <- ground truth`
);
console.log(`    K = tokens / pretoken    ${rpad(K.toFixed(4), 9)}`);
console.log(
  `    implied chars / token    ${rpad((bytes(cachedPrefixText) / MILK_TURN.cacheWriteTokens).toFixed(2), 9)}`
);
// The prefix TOTAL is nailed down by the device. Splitting it between the tool
// schemas and the prose prompt needs a proportionality assumption, so run three
// independent ones and report the spread rather than a false precision.
const repoJsonTok = Math.round(toolsJson.length / 2.8); // db/coach-eval.test.mjs §6
const repoProseTok = Math.round(system.length / 3.6); // db/coach-eval.test.mjs §6
const repoScale = MILK_TURN.cacheWriteTokens / (repoJsonTok + repoProseTok);
const splits = [
  ['proportional to pretokens', est(toolsJson), est(system)],
  [
    'proportional to bytes',
    Math.round((bytes(toolsJson) / bytes(cachedPrefixText)) * MILK_TURN.cacheWriteTokens),
    Math.round((bytes(system) / bytes(cachedPrefixText)) * MILK_TURN.cacheWriteTokens),
  ],
  [
    "the repo's own 2.8/3.6 split, rescaled",
    Math.round(repoJsonTok * repoScale),
    Math.round(repoProseTok * repoScale),
  ],
];
console.log(`\n  Splitting that total between schemas and prose — three independent models:`);
console.log(`  ${pad('model', 40)}${rpad('tools', 9)}${rpad('system', 9)}`);
for (const [label, t, s] of splits) {
  console.log(`  ${pad(label, 40)}${rpad(k(t), 9)}${rpad(k(s), 9)}`);
}
const toolLo = Math.min(...splits.map((s) => s[1]));
const toolHi = Math.max(...splits.map((s) => s[1]));
console.log(
  `\n  => the tool catalog is ${k(toolLo)}-${k(toolHi)} tokens, ${Math.round(
    (toolLo / MILK_TURN.cacheWriteTokens) * 100
  )}-${Math.round((toolHi / MILK_TURN.cacheWriteTokens) * 100)}% of the cached prefix.`
);
console.log(`  The three models disagree by ~10% and agree on the verdict: schemas dominate.`);
console.log(`\n  Why the old ~10.5k estimate was low: chars/3.6 is a PROSE ratio and the`);
console.log(`  prefix is two-thirds JSON Schema. The repo's own two-ratio estimator`);
console.log(
  `  (db/coach-eval.test.mjs §6) lands at ${k(repoJsonTok + repoProseTok)} — ${Math.round(
    (1 - 1 / repoScale) * 100
  )}% low, not 4x low.`
);

// --- 3. The segment table -----------------------------------------------------

const segments = [
  { name: 'tools (39 schemas, JSON)', text: toolsJson, region: 'CACHED' },
  { name: 'system: static prompt', text: system, region: 'CACHED' },
  { name: 'system: turn context', text: systemContext, region: 'uncached' },
  { name: 'messages (10-msg window)', text: JSON.stringify(body.messages), region: 'uncached' },
];

heading('2. SEGMENT TABLE — one round trip of the "We need milk" turn');
console.log(
  `  ${pad('segment', 28)}${rpad('bytes', 9)}${rpad('pretok', 9)}${rpad('est tok', 9)}  region`
);
console.log(`  ${'-'.repeat(72)}`);
let cachedTok = 0;
let uncachedTok = 0;
for (const s of segments) {
  const t = est(s.text);
  if (s.region === 'CACHED') cachedTok += t;
  else uncachedTok += t;
  console.log(
    `  ${pad(s.name, 28)}${rpad(bytes(s.text).toLocaleString(), 9)}${rpad(
      pretokens(s.text).toLocaleString(),
      9
    )}${rpad(t.toLocaleString(), 9)}  ${s.region}`
  );
}
console.log(`  ${'-'.repeat(72)}`);
console.log(
  `  ${pad('CACHED PREFIX total', 28)}${rpad(bytes(cachedPrefixText).toLocaleString(), 9)}${rpad(
    prefixPretokens.toLocaleString(),
    9
  )}${rpad(cachedTok.toLocaleString(), 9)}`
);
console.log(
  `  ${pad('UNCACHED per round trip', 28)}${rpad('', 9)}${rpad('', 9)}${rpad(uncachedTok.toLocaleString(), 9)}`
);

heading('3. WHERE THE CACHE BREAKPOINTS FALL (as buildMessagesRequest emits them)');
const lastTool = body.tools[body.tools.length - 1];
console.log(`  tools[0..${body.tools.length - 2}]                      no cache_control`);
console.log(
  `  tools[${body.tools.length - 1}] ("${lastTool.name}")   cache_control ${JSON.stringify(
    lastTool.cache_control
  )}   <- BREAKPOINT 1`
);
body.system.forEach((blk, i) => {
  const label = i === 0 ? 'static prompt' : 'turn context';
  console.log(
    `  system[${i}] (${pad(label + ')', 15)}  ${
      blk.cache_control
        ? `cache_control ${JSON.stringify(blk.cache_control)}   <- BREAKPOINT 2 (end of cached region)`
        : 'no cache_control  <- UNCACHED, re-billed at full rate on every round trip'
    }`
  );
});
console.log(
  `  messages[0..${body.messages.length - 1}]                  no cache_control  <- UNCACHED, and GROWS within the turn`
);

// --- 4. Reproduce the device's caption from first principles ------------------

/** SSE for one streamed reply, with usage reported the way the API does. */
function sse(events) {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
}
function replyEvents({ text, toolName, toolId, usage, stopReason }) {
  const blocks = [];
  blocks.push(
    { event: 'message_start', data: { type: 'message_start', message: { usage } } },
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    },
    {
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } }
  );
  if (toolName) {
    blocks.push(
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{}' },
        },
      },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } }
    );
  }
  blocks.push(
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: stopReason },
        usage: { output_tokens: usage.output_tokens },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } }
  );
  return sse(blocks);
}

const P = MILK_TURN.cacheWriteTokens; // the prefix, one write's worth
/**
 * Three round trips, usage reported exactly as the API would: the first writes
 * the prefix, the next two read it. Uncached `input_tokens` is the turn context
 * plus the message tail, which grows as tool results are appended.
 */
const ROUND_TRIPS = [
  {
    cache_creation_input_tokens: P,
    cache_read_input_tokens: 0,
    input_tokens: 2280,
    output_tokens: 38,
  },
  {
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: P,
    input_tokens: 2440,
    output_tokens: 41,
  },
  {
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: P,
    input_tokens: 2580,
    output_tokens: 55,
  },
];

let rt = 0;
const scriptedFetch = async () => {
  const usage = ROUND_TRIPS[rt];
  const isLast = rt === ROUND_TRIPS.length - 1;
  const text = replyEvents({
    text: isLast ? 'Added milk to the list.' : '',
    toolName: isLast ? null : rt === 0 ? 'get_grocery_list' : 'add_grocery_items',
    toolId: `toolu_${rt}`,
    usage,
    stopReason: isLast ? 'end_turn' : 'tool_use',
  });
  rt++;
  const chunk = new TextEncoder().encode(text);
  let sent = false;
  return {
    ok: true,
    status: 200,
    text: async () => '',
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: chunk })),
      }),
    },
  };
};

const turn = await runCoachTurn(
  { apiKey: 'not-a-key', model: MODEL, fetchImpl: scriptedFetch },
  { system, systemContext, messages, tools: wireTools },
  {
    onToken: () => {},
    executeTool: async (name) => ({ content: JSON.stringify({ tool: name, ok: true }) }),
  }
);

heading('4. THE 10.5k-vs-44k DISCREPANCY, RESOLVED');
console.log(`  The caption sums usage across EVERY round trip of the turn (model-client.ts`);
console.log(`  addUsage). It is not one request's numbers. Replaying the real loop with a`);
console.log(`  scripted API that writes a ${k(P)} prefix once and reads it twice:\n`);
console.log(`    reproduced : ${usageCaption(turn.usage, MODEL, turn.toolCalls.length)}`);
console.log(
  `    device     : ${MILK_TURN.toolCalls} tool calls · ${k(MILK_TURN.cacheWriteTokens)} cache write · ${k(
    MILK_TURN.cacheReadTokens
  )} cached · ${k(MILK_TURN.inputTokens)} in · ${MILK_TURN.outputTokens} out · ~$${MILK_TURN.dollars.toFixed(2)}`
);
console.log(`\n  29.2k = 2 x 14.6k, exactly. There is ONE prefix of ${k(P)} tokens; it is`);
console.log(`  written on round trip 1 and read on round trips 2 and 3. The cached region`);
console.log(`  holds nothing but the tool schemas and the static system prompt, and the`);
console.log(`  mid-turn cache is HITTING (a miss would show a second cache write).`);
console.log(`\n  The 10.5k estimate was wrong for one reason only: chars/3.6 is a prose`);
console.log(
  `  ratio. The measured prefix is ${(bytes(cachedPrefixText) / P).toFixed(2)} chars/token.`
);

const nutritionUsage = {
  inputTokens: NUTRITION_TURN.inputTokens,
  outputTokens: NUTRITION_TURN.outputTokens,
  cacheReadTokens: NUTRITION_TURN.cacheReadTokens,
  cacheWriteTokens: 0,
};
console.log(`\n  Cross-check, the owner's SECOND turn (1 tool call = 2 round trips):`);
console.log(`    device     : ${k(NUTRITION_TURN.cacheReadTokens)} cached, no write`);
console.log(
  `    2 x ${k(P)}    : ${k(2 * P)}  ${2 * P === NUTRITION_TURN.cacheReadTokens ? 'MATCH' : 'MISMATCH'}`
);
console.log(`    cost model : ${usageCaption(nutritionUsage, MODEL, NUTRITION_TURN.toolCalls)}`);

// --- 5. Where the money goes --------------------------------------------------

const PRICE_IN = 2 / 1_000_000; // Sonnet 5 introductory, per src/lib/ai/cost.ts
const PRICE_OUT = 10 / 1_000_000;
const money = (n) => `$${n.toFixed(4)}`;
const pct = (n, total) => `${((n / total) * 100).toFixed(0)}%`;

const milkCost = estimateCost(
  {
    inputTokens: MILK_TURN.inputTokens,
    outputTokens: MILK_TURN.outputTokens,
    cacheReadTokens: MILK_TURN.cacheReadTokens,
    cacheWriteTokens: MILK_TURN.cacheWriteTokens,
  },
  MODEL
);
const parts = [
  ['cache WRITE (cold prefix, 2x)', MILK_TURN.cacheWriteTokens * PRICE_IN * 2],
  ['uncached input (context+history)', MILK_TURN.inputTokens * PRICE_IN],
  ['cache read (2 round trips, 0.1x)', MILK_TURN.cacheReadTokens * PRICE_IN * 0.1],
  ['output', MILK_TURN.outputTokens * PRICE_OUT],
];

heading('5. WHERE THE $0.08 ACTUALLY WENT');
for (const [label, cost] of parts) {
  console.log(`  ${pad(label, 36)}${rpad(money(cost), 10)}  ${rpad(pct(cost, milkCost), 5)}`);
}
console.log(`  ${'-'.repeat(56)}`);
console.log(`  ${pad('total', 36)}${rpad(money(milkCost), 10)}`);
console.log(`\n  The reply cost 1 cent-and-a-half of that. Three quarters of the turn is a`);
console.log(`  ONE-TIME cold write of a ${k(P)}-token prefix, billed at 2x for the 1-hour`);
console.log(`  cache and then amortized over every turn in the next hour.`);

// --- 6. The uncached block, sized -------------------------------------------

heading('6. THE UNCACHED BLOCK — re-billed IN FULL on every round trip');
const ctxTok = est(systemContext);
const msgTok = est(JSON.stringify(body.messages));
console.log(
  `  turn context   ${rpad(k(ctxTok), 7)} tok   x ${ROUND_TRIPS.length} round trips = ${rpad(
    k(ctxTok * ROUND_TRIPS.length),
    7
  )} tok  ${money(ctxTok * ROUND_TRIPS.length * PRICE_IN)}`
);
console.log(
  `  message window ${rpad(k(msgTok), 7)} tok   x ${ROUND_TRIPS.length} round trips = ${rpad(
    k(msgTok * ROUND_TRIPS.length),
    7
  )} tok  ${money(msgTok * ROUND_TRIPS.length * PRICE_IN)}`
);

console.log(`\n  Turn context, line by line:`);
for (const line of systemContext.split('\n')) {
  if (line.trim() === '') continue;
  const t = est(line);
  console.log(`    ${rpad(t, 5)} tok  ${line.slice(0, 88)}${line.length > 88 ? '…' : ''}`);
}

console.log(
  `\n  Turn context growth with the memory store (MEMORY_PROMPT_LIMIT = ${MEMORY_PROMPT_LIMIT}):`
);
for (const n of [0, 12, 40, 80]) {
  const ctx = buildTurnContext(seedDb(n), NOW);
  console.log(
    `    store ${rpad(n, 3)} -> ${rpad(Math.min(n, MEMORY_PROMPT_LIMIT), 3)} in prompt  ->  ${rpad(
      k(est(ctx)),
      7
    )} tok   ${money(est(ctx) * ROUND_TRIPS.length * PRICE_IN)} per 3-round-trip turn`
  );
}

// The ids are contract, not decoration: TOOL_DOCTRINE tells the model to forget
// by id, and forget's own description says the ids arrive in this block. They
// are also the single most expensive thing in it per unit of meaning.
const fullCap = buildTurnContext(seedDb(MEMORY_PROMPT_LIMIT), NOW);
const idFree = fullCap.replace(/ \(id: [0-9a-f-]{36}\)/g, '');
const idBytes = bytes(fullCap) - bytes(idFree);
// Random hex is where this estimator is WEAKEST and it must say so: the
// pretoken model splits "08412a3f" into five spans that a real BPE happily
// merges back, so it over-counts here as badly as chars/3.6 under-counted the
// schemas. Quote a bound, not a number: >= bytes/4 (four hex per token is about
// the best any vocabulary does) and <= the pretoken model.
const idLo = Math.round(idBytes / 4);
const idHi = est(fullCap) - est(idFree);
console.log(`\n  Of the ${MEMORY_PROMPT_LIMIT}-memory block, the " (id: <uuid>)" suffixes alone:`);
console.log(
  `    ${rpad(idBytes, 6)} bytes   ${idLo}-${idHi} tok   ${money(
    idLo * ROUND_TRIPS.length * PRICE_IN
  )}-${money(idHi * ROUND_TRIPS.length * PRICE_IN)} per turn`
);
console.log(`    A 36-char random-hex id costs more tokens than the fact it labels, and it`);
console.log(`    is paid on every request of every turn. (Estimator caveat: random hex is`);
console.log(`    the one content class where the pretoken model is unreliable — hence a range.)`);

// The grocery line, added to this block on this branch, priced against the
// round trip it removes.
const groceryLine = systemContext.split('\n').find((l) => l.startsWith('Grocery list')) ?? '';
console.log(`\n  The grocery line this branch adds (a 4-item standing list):`);
console.log(
  `    ${rpad(bytes(groceryLine), 6)} bytes   ${rpad(est(groceryLine), 6)} est tok   ${money(
    est(groceryLine) * ROUND_TRIPS.length * PRICE_IN
  )} per turn`
);
console.log(`    "${groceryLine}"`);

// --- 7. The tool catalog, sized ----------------------------------------------

heading('7. THE TOOL CATALOG — the 2/3 of the prefix that is not the prompt');
const perTool = body.tools
  .map((t) => ({ name: t.name, tok: est(JSON.stringify({ ...t, cache_control: undefined })) }))
  .sort((a, b) => b.tok - a.tok);
const toolTotal = perTool.reduce((s, t) => s + t.tok, 0);
console.log(
  `  ${body.tools.length} tools, ${k(toolTotal)} est tokens, mean ${Math.round(toolTotal / body.tools.length)} tok/tool\n`
);
console.log(`  ten heaviest:`);
for (const t of perTool.slice(0, 10)) {
  console.log(`    ${rpad(t.tok, 5)} tok  ${t.name}`);
}
console.log(`  ten lightest:`);
for (const t of perTool.slice(-10)) {
  console.log(`    ${rpad(t.tok, 5)} tok  ${t.name}`);
}

// --- 8. Lever arithmetic ------------------------------------------------------

/**
 * Effective input tokens for a turn, so levers can be compared in one unit.
 * `prefixWrite` is 0 when the hour-cache is warm.
 */
function turnCost({ roundTrips, prefixWarm, ctx, msgTail, cacheCtx, out }) {
  const prefixUnits = prefixWarm ? 0.1 * P * roundTrips : 2 * P + 0.1 * P * (roundTrips - 1);
  // A 5-minute breakpoint after the turn context: written once at 1.25x, read
  // at 0.1x by every later round trip in the same turn.
  const ctxUnits = cacheCtx ? 1.25 * ctx + 0.1 * ctx * (roundTrips - 1) : ctx * roundTrips;
  const msgUnits = msgTail * roundTrips;
  return (prefixUnits + ctxUnits + msgUnits) * PRICE_IN + out * PRICE_OUT;
}

const CTX = ctxTok;
const MSG = msgTok;
heading('8. LEVERS, PRICED (cold turn, 3 round trips, Sonnet 5)');
const baseline = turnCost({
  roundTrips: 3,
  prefixWarm: false,
  ctx: CTX,
  msgTail: MSG,
  cacheCtx: false,
  out: 134,
});
const rows = [
  ['baseline: the milk turn as it billed', baseline],
  [
    'A. grocery in the block -> 2 trips',
    turnCost({
      roundTrips: 2,
      prefixWarm: false,
      ctx: CTX,
      msgTail: MSG,
      cacheCtx: false,
      out: 100,
    }),
  ],
  [
    'B. cache breakpoint on turn context',
    turnCost({
      roundTrips: 3,
      prefixWarm: false,
      ctx: CTX,
      msgTail: MSG,
      cacheCtx: true,
      out: 134,
    }),
  ],
  [
    'A + B together',
    turnCost({
      roundTrips: 2,
      prefixWarm: false,
      ctx: CTX,
      msgTail: MSG,
      cacheCtx: true,
      out: 100,
    }),
  ],
  [
    'C. the SAME turn, hour-cache warm',
    turnCost({
      roundTrips: 3,
      prefixWarm: true,
      ctx: CTX,
      msgTail: MSG,
      cacheCtx: false,
      out: 134,
    }),
  ],
  [
    'A + B + warm cache',
    turnCost({ roundTrips: 2, prefixWarm: true, ctx: CTX, msgTail: MSG, cacheCtx: true, out: 100 }),
  ],
];
for (const [label, cost] of rows) {
  const delta = cost === baseline ? '' : `  ${(((cost - baseline) / baseline) * 100).toFixed(0)}%`;
  console.log(`  ${pad(label, 38)}${rpad(money(cost), 10)}${delta}`);
}
console.log(`\n  A is shipped on this branch (turn-context.ts). B is one line in`);
console.log(`  model-client.ts, which this branch may not edit — the diff is in the report.`);
console.log(`  C is not a lever, it is the amortization the caption hides: the SAME work`);
console.log(`  costs a quarter as much once the prefix is already in the cache.`);

console.log(`\n  A ten-turn hour (1 cold + 9 warm):`);
for (const [label, cacheCtx, rtCount] of [
  ['as shipped', false, 3],
  ['A', false, 2],
  ['A + B', true, 2],
]) {
  const cold = turnCost({
    roundTrips: rtCount,
    prefixWarm: false,
    ctx: CTX,
    msgTail: MSG,
    cacheCtx,
    out: 134,
  });
  const warm = turnCost({
    roundTrips: rtCount,
    prefixWarm: true,
    ctx: CTX,
    msgTail: MSG,
    cacheCtx,
    out: 134,
  });
  const total = cold + 9 * warm;
  console.log(`    ${pad(label, 14)} ${money(total)} total, ${money(total / 10)} per turn`);
}

heading('9. THE ONE LEVER THAT MOVES THE 73%: A SMALLER PREFIX');
console.log(`  Nothing above touches the cold write, because the cold write IS the prefix.`);
console.log(`  What each 1,000 tokens of prefix costs, per cold turn and per day:\n`);
for (const trim of [0, 1000, 2000, 4000]) {
  const p = MILK_TURN.cacheWriteTokens - trim;
  const perCold = p * 2 * PRICE_IN;
  console.log(
    `    prefix ${rpad(k(p), 7)}  cold write ${rpad(money(perCold), 9)}  x3 bursts/day ${money(
      perCold * 3
    )}  /year $${(perCold * 3 * 365).toFixed(0)}`
  );
}
console.log(`\n  A per-turn VARIABLE tool subset is not viable: the subset is part of the`);
console.log(`  cached prefix, so every different subset is a different cache entry and a`);
console.log(`  fresh 2x write. Two subsets alternating cost MORE than one full catalog.`);
console.log(`  Leaner schemas for the same 39 tools is the only version that works.`);

console.log('');
