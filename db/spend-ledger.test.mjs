/**
 * Headless test of the spend ledger (2026-10-21, Track 0 item 2):
 * src/lib/ai/spend-ledger.ts (pure aggregation, pruning, `spentToday`),
 * src/lib/ai/spend-store.ts (the preferences read/write and the sink), and the
 * claim the whole feature rests on — that EVERY model call ARC makes is
 * recorded under its own call type.
 *
 * That claim is pinned twice. §4 reads the source: every file that calls
 * `runCoachTurn` is known, and passes the call type it should. §5 drives each
 * of the fourteen real entry points (chat, the pass, three estimators, three
 * recipe calls, the knowledge import, the lab parse, the photo reading, the
 * report read, the exercise and workout calls) through a mocked fetch, with the
 * app's own sink installed, and reads the ledger back. No network, no key: the
 * fetch is a scripted stream and the "key" is a test string.
 *
 * Run: npm run db:test.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

// The two resolutions the chat path needs under raw node ESM (the same stub
// db/coach-fidelity.test.mjs §2 uses): `expo/fetch` → the scripted fetch, and
// `@/lib/db/client` → this suite's database. Nothing else is faked.
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
    if (specifier.startsWith('.') || specifier.startsWith('@/')) {
      return next(specifier + '/index.ts', context);
    }
    throw error;
  }
}
`;
register('data:text/javascript,' + encodeURIComponent(LOADER_HOOK), import.meta.url);

// The one-shot callers load `expo/fetch` with a guarded `require` (so their
// pure halves load in node). Under ESM a bare `require` resolves to the global,
// so this gives them the scripted fetch; anything else they require throws, as
// it would without it, and their guards treat that as "absent".
globalThis.require = (id) => {
  if (id === 'expo/fetch') return { fetch: (...args) => globalThis.__ARC_TEST_FETCH__(...args) };
  throw new Error(`no ${id} in the headless suite`);
};

const { migrate } = await import('../src/lib/db/migrate.ts');
const { MIGRATIONS } = await import('../src/lib/db/migrations.generated.ts');
const { shiftISODate, todayISODate } = await import('../src/lib/db/date.ts');
const { getOrCreateUser } = await import('../src/lib/db/repositories/user.ts');
const { apiKeyStore } = await import('../src/lib/ai/api-key-store.ts');
const { MODEL_CALL_TYPES } = await import('../src/lib/ai/call-types.ts');
const { runCoachTurn, setModelUsageSink } = await import('../src/lib/ai/model-client.ts');
const ledgerModule = await import('../src/lib/ai/spend-ledger.ts');
const {
  EMPTY_LEDGER,
  KEEP_DAYS,
  LEDGER_KEY,
  formatUsd,
  parseLedger,
  pruneLedger,
  recordInLedger,
  spentToday,
  summarizeLedger,
} = ledgerModule;
const { installSpendLedger, readSpendLedger, recordModelCall, spentTodayFrom } =
  await import('../src/lib/ai/spend-store.ts');

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
  return { raw, db };
}

const usage = (inputTokens, outputTokens = 0, extra = {}) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...extra,
});
const rec = (callType, usd, u = usage(1000, 100), model = 'claude-sonnet-5') => ({
  callType,
  model,
  usage: u,
  usd,
});

// =============================================================================
console.log('1. aggregation: one bucket per (day, call type), summed');
{
  const day = '2026-10-21';
  let ledger = EMPTY_LEDGER;
  ledger = recordInLedger(
    ledger,
    rec('chat', 0.01, usage(1000, 100, { cacheReadTokens: 9000 })),
    day
  );
  ledger = recordInLedger(
    ledger,
    rec('chat', 0.02, usage(500, 50, { cacheWriteTokens: 4000, webSearchRequests: 2 })),
    day
  );
  ledger = recordInLedger(ledger, rec('meal_estimate', 0.003), day);
  const chat = ledger.days[day].chat;
  chat.n === 2 &&
  chat.in === 1500 &&
  chat.out === 150 &&
  chat.cr === 9000 &&
  chat.cw === 4000 &&
  chat.ws === 2 &&
  near(chat.usd, 0.03) &&
  chat.m['claude-sonnet-5'] === 2
    ? ok('two chat calls sum into one bucket: calls, tokens, searches, USD, model counts')
    : bad('chat bucket', JSON.stringify(chat));
  ledger.days[day].meal_estimate?.n === 1
    ? ok('another call type is its own bucket the same day')
    : bad('type bucket', JSON.stringify(ledger.days[day]));
  EMPTY_LEDGER.days[day] === undefined
    ? ok('recording returns a new ledger; the input is untouched')
    : bad('mutated input');

  // An unpriced model is COUNTED but adds no dollars — never a guess.
  const unpriced = recordInLedger(ledger, rec('chat', null, usage(10), 'some-future-model'), day);
  const c = unpriced.days[day].chat;
  c.n === 3 && c.np === 1 && near(c.usd, 0.03) && c.m['some-future-model'] === 1
    ? ok('a call with no price is counted and marked unpriced, and adds $0 rather than a guess')
    : bad('unpriced', JSON.stringify(c));

  // A type that did not survive to runtime is filed, not dropped.
  const other = recordInLedger(EMPTY_LEDGER, rec('mystery', 0.001), day);
  other.days[day].other?.n === 1
    ? ok('an unknown call type is filed under "other"')
    : bad('unknown type', JSON.stringify(other));
}

console.log('2. windows: today, the last 7 days, this month, by type — and spentToday()');
{
  const today = '2026-10-21';
  let ledger = EMPTY_LEDGER;
  const put = (day, type, usd) => {
    ledger = recordInLedger(ledger, rec(type, usd), day);
  };
  put(today, 'chat', 0.5);
  put(today, 'pass', 0.01);
  put(shiftISODate(today, -6), 'chat', 0.25); // in the 7 days
  put(shiftISODate(today, -7), 'meal_estimate', 1.0); // out of the 7, in the month
  put('2026-09-30', 'lab_parse', 9.0); // last month
  // The pruning reference is the latest day written, so put today's row last.
  put(today, 'meal_estimate', 0.04);
  const s = summarizeLedger(ledger, today);
  near(s.today.usd, 0.55) && s.today.calls === 3
    ? ok('today: $0.55 over three calls')
    : bad('today', JSON.stringify(s.today));
  near(s.last7.usd, 0.8) && s.last7.calls === 4
    ? ok('the last 7 days are today and the six before it ($0.80; the 7th day back is out)')
    : bad('last7', JSON.stringify(s.last7));
  near(s.month.usd, 1.8) && s.month.calls === 5
    ? ok('this month is the calendar month to date ($1.80; September is not in it)')
    : bad('month', JSON.stringify(s.month));
  s.monthByType.map((t) => t.type).join(',') === 'meal_estimate,chat,pass' &&
  near(s.monthByType[0].totals.usd, 1.04)
    ? ok('by type, most expensive first: meal estimates, chat, passes')
    : bad('by type', JSON.stringify(s.monthByType));
  s.daysRecorded === 4 && s.firstDay === '2026-09-30'
    ? ok('it knows how many days it has and since when, so it never implies a month it did not see')
    : bad('days recorded', JSON.stringify({ d: s.daysRecorded, f: s.firstDay }));
  near(spentToday(ledger, today), 0.55) && spentToday(ledger, '2026-10-22') === 0
    ? ok('spentToday() — the usage policy’s read — is today’s priced total, and 0 on an empty day')
    : bad('spentToday', String(spentToday(ledger, today)));
  formatUsd(0) === '$0.00' &&
  formatUsd(0.004) === '<$0.01' &&
  formatUsd(0.555) === '$0.56' &&
  formatUsd(12.3) === '$12.30'
    ? ok('USD reads $0.00 only for a true zero, "<$0.01" for a fraction of a cent')
    : bad('formatUsd');
}

console.log(`3. pruning: the last ${KEEP_DAYS} days are kept, and a bad stored value reads empty`);
{
  const today = '2026-10-21';
  let ledger = EMPTY_LEDGER;
  for (let back = 0; back < 200; back++) {
    ledger = {
      v: 1,
      days: {
        ...ledger.days,
        [shiftISODate(today, -back)]: {
          chat: { n: 1, in: 1, out: 1, cr: 0, cw: 0, ws: 0, usd: 0.01, np: 0, m: {} },
        },
      },
    };
  }
  const pruned = recordInLedger(ledger, rec('chat', 0.01), today);
  const days = Object.keys(pruned.days).sort();
  days.length === KEEP_DAYS &&
  days[0] === shiftISODate(today, -(KEEP_DAYS - 1)) &&
  days.at(-1) === today
    ? ok(`a write keeps exactly ${KEEP_DAYS} days: today and the ${KEEP_DAYS - 1} before it`)
    : bad('prune bounds', `${days.length} ${days[0]} ${days.at(-1)}`);
  Object.keys(pruneLedger(ledger, today, 7).days).length === 7
    ? ok('pruneLedger honours a shorter window')
    : bad('prune window');

  const junk = parseLedger({
    v: 1,
    days: {
      '2026-10-20': { chat: { n: 2, in: 'x', usd: -5, m: { a: 1, b: 'no' } }, nonsense: { n: 1 } },
      'not-a-day': { chat: { n: 1 } },
      '2026-10-19': 'garbage',
    },
  });
  JSON.stringify(Object.keys(junk.days)) === '["2026-10-20"]' &&
  junk.days['2026-10-20'].chat.n === 2 &&
  junk.days['2026-10-20'].chat.in === 0 &&
  junk.days['2026-10-20'].chat.usd === 0 &&
  JSON.stringify(junk.days['2026-10-20'].chat.m) === '{"a":1}' &&
  !('nonsense' in junk.days['2026-10-20'])
    ? ok('a damaged ledger is read tolerantly: bad days, types and numbers drop to nothing')
    : bad('parse tolerance', JSON.stringify(junk));
  [null, 'x', 42, [], { days: 'no' }].every((v) => Object.keys(parseLedger(v).days).length === 0)
    ? ok('…and anything that is not a ledger reads as an empty one')
    : bad('non-ledger values');
}

console.log(
  '3b. the store: preferences JSON, its own key only, and a write that cannot break a call'
);
{
  const { db } = freshDb();
  const user = getOrCreateUser(db);
  db.run('UPDATE users SET preferences = ? WHERE id = ?', [
    JSON.stringify({ units: { weight: 'kg' }, coachPass: { lastDate: '2026-10-20' } }),
    user.id,
  ]);
  const at = new Date(2026, 9, 21, 9, 30);
  recordModelCall(db, rec('chat', 0.02), at) && recordModelCall(db, rec('pass', 0.001), at)
    ? ok('recordModelCall writes')
    : bad('recordModelCall failed');
  const prefs = JSON.parse(getOrCreateUser(db).preferences);
  prefs.units.weight === 'kg' &&
  prefs.coachPass.lastDate === '2026-10-20' &&
  prefs[LEDGER_KEY]?.v === 1
    ? ok('…under its own key, every other preference section left exactly as it was')
    : bad('preferences clobbered', JSON.stringify(prefs));
  const ledger = readSpendLedger(db);
  const day = todayISODate(at);
  ledger.days[day]?.chat?.n === 1 && ledger.days[day]?.pass?.n === 1
    ? ok('the calls are filed under the LOGICAL day of the call')
    : bad('filed day', JSON.stringify(ledger));
  near(spentTodayFrom(db, at), 0.021)
    ? ok('spentTodayFrom(db) reads the same figure from storage')
    : bad('spentTodayFrom', String(spentTodayFrom(db, at)));

  // THE FAILURE PATH: a database that refuses the write returns false, never throws.
  const broken = {
    ...db,
    run: () => {
      throw new Error('disk I/O error');
    },
  };
  const warn = console.warn;
  console.warn = () => {};
  let threw = false;
  let result = true;
  try {
    result = recordModelCall(broken, rec('chat', 0.01), at);
  } catch {
    threw = true;
  } finally {
    console.warn = warn;
  }
  !threw && result === false
    ? ok('a ledger write that fails returns false — it does not throw into the model call')
    : bad('write failure escaped');
  // The column is json_valid-CHECKed, so a damaged blob is valid JSON of the
  // wrong shape — an array, a scalar — rather than unparseable text.
  db.run('UPDATE users SET preferences = ? WHERE id = ?', ['[1,2]', user.id]);
  Object.keys(readSpendLedger(db).days).length === 0 && recordModelCall(db, rec('chat', 0.01), at)
    ? ok(
        'a preferences blob of the wrong shape reads as an empty ledger, and the next write starts it again'
      )
    : bad('corrupt blob');
}

// =============================================================================
console.log('4. the source pin: every file that calls the model names its call type');
{
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
    });
  const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'app'))];
  const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
  // Code only: a comment that mentions runCoachTurn( is not a call.
  const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const EXPECTED = {
    'src/lib/ai/coach-pass.ts': ['pass'],
    'src/lib/ai/coach-service.ts': ['chat'],
    'src/lib/exercise/ai-add.ts': ['exercise_ai'],
    'src/lib/exercise/import-workout.ts': ['workout_import'],
    'src/lib/knowledge/import.ts': ['knowledge_import'],
    'src/lib/labs/parse.ts': ['lab_parse'],
    'src/lib/nutrition/estimate.ts': ['meal_estimate', 'meal_revision', 'food_estimate'],
    'src/lib/photos/analyze.ts': ['photo_reading'],
    'src/lib/recipes/estimate.ts': ['recipe_pricing', 'recipe_revision'],
    'src/lib/recipes/import.ts': ['recipe_import'],
    'src/lib/reports/coach-read.ts': ['report_read'],
  };
  const callers = files
    .filter((f) => !f.endsWith(path.join('ai', 'model-client.ts')))
    .filter((f) => /\brunCoachTurn\(/.test(code(readFileSync(f, 'utf8'))))
    .map(rel)
    .sort();
  JSON.stringify(callers) === JSON.stringify(Object.keys(EXPECTED).sort())
    ? ok(`the ${callers.length} files that call runCoachTurn are exactly the known ones`)
    : bad('a new model call site — give it a call type and add it here', JSON.stringify(callers));
  // A call type is pinned where it is PASSED: as `callType: '<type>'` in a
  // client config, or as the type argument of the estimators' shared turn.
  const passed = (text) =>
    new Set(
      [
        ...code(text).matchAll(/callType:\s*'([a-z_]+)'/g),
        ...code(text).matchAll(/runEstimatorTurn\([^)]*?'([a-z_]+)'/g),
      ].map((m) => m[1])
    );
  const wrong = [];
  for (const [file, types] of Object.entries(EXPECTED)) {
    const found = passed(readFileSync(path.join(ROOT, file), 'utf8'));
    for (const t of types) if (!found.has(t)) wrong.push(`${file} does not pass '${t}'`);
    for (const t of found) if (!types.includes(t)) wrong.push(`${file} passes unexpected '${t}'`);
  }
  wrong.length === 0
    ? ok('each passes its own call type literal, and none files itself as "other"')
    : bad('call types', wrong.join('; '));
  const covered = new Set(Object.values(EXPECTED).flat());
  MODEL_CALL_TYPES.filter((t) => t !== 'other').every((t) => covered.has(t))
    ? ok('every call type in the vocabulary has a call site (none is dead)')
    : bad('dead call type');
  const layout = code(readFileSync(path.join(ROOT, 'app/_layout.tsx'), 'utf8'));
  /\binstallSpendLedger\(getDb\);/.test(layout)
    ? ok('the root layout installs the ledger sink at module scope, before any call')
    : bad('sink not installed at launch');
}

// =============================================================================
console.log('5. through the mock: each of the fourteen real entry points lands in the ledger');
{
  const { db } = freshDb();
  globalThis.__ARC_TEST_DB__ = db;
  await apiKeyStore.setKey('test-key');
  await apiKeyStore.setWebSearch(false);

  // One billed reply: usage on message_start and message_delta, some text.
  let requests = 0;
  const sse = (text) =>
    [
      {
        type: 'message_start',
        message: { usage: { input_tokens: 1200, cache_read_input_tokens: 300 } },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 80 } },
      { type: 'message_stop' },
    ]
      .map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
      .join('');
  globalThis.__ARC_TEST_FETCH__ = async () => {
    requests++;
    const bytes = new TextEncoder().encode(sse('SKIP'));
    let sent = false;
    return {
      ok: true,
      status: 200,
      text: async () => '',
      body: {
        getReader: () => ({
          read: async () =>
            sent ? { done: true } : ((sent = true), { done: false, value: bytes }),
        }),
      },
    };
  };
  const uninstall = installSpendLedger(() => db);

  // Each entry point, with the smallest input it accepts. What the feature
  // does with the reply ("SKIP" parses as nothing) is not this test's question:
  // the call was made and billed, so it must be in the ledger either way.
  const tryRun = async (fn) => {
    try {
      await fn();
    } catch {
      // A reply the feature cannot use still cost a call.
    }
  };
  const { streamCoachReply } = await import('../src/lib/ai/coach-service.ts');
  const { runCoachPass } = await import('../src/lib/ai/coach-pass.ts');
  const { estimateMeal, reviseMeal, estimateFoodEntry } =
    await import('../src/lib/nutrition/estimate.ts');
  const { importRecipe } = await import('../src/lib/recipes/import.ts');
  const { resolveRecipeWithModel, reviseRecipe } = await import('../src/lib/recipes/estimate.ts');
  const { createRecipe } = await import('../src/lib/db/repositories/recipes.ts');
  const { importKnowledge } = await import('../src/lib/knowledge/import.ts');
  const { extractLabReport } = await import('../src/lib/labs/parse.ts');
  const { readPhotos } = await import('../src/lib/photos/analyze.ts');
  const { generateCoachRead } = await import('../src/lib/reports/coach-read.ts');
  const { addExerciseWithAI } = await import('../src/lib/exercise/ai-add.ts');
  const { importWorkoutFromPhoto } = await import('../src/lib/exercise/import-workout.ts');

  const recipeId = createRecipe(db, {
    title: 'Chicken bowl',
    servings: 2,
    ingredients: [{ raw_text: '1 handful of something unpriceable' }],
  });
  const subject = { base64Jpeg: '/9j/x', takenOn: '2026-10-21', pose: 'front', weighIn: '' };
  const ENTRIES = {
    chat: () =>
      streamCoachReply([{ id: 'u1', role: 'user', content: 'hi', createdAt: Date.now() }], {
        onToken: () => {},
        confirmWrite: async () => false,
      }),
    pass: () =>
      runCoachPass(db, { trigger: { kind: 'daily' }, fetchImpl: globalThis.__ARC_TEST_FETCH__ }),
    meal_estimate: () => estimateMeal({ kind: 'text', description: 'a burrito' }),
    meal_revision: () => reviseMeal({ name: 'Lunch', items: [] }, 'it was olive oil'),
    food_estimate: () => estimateFoodEntry('a homemade granola bar'),
    recipe_import: () => importRecipe({ kind: 'text', text: 'Chicken, rice, soy. Cook it.' }),
    recipe_pricing: () => resolveRecipeWithModel(db, recipeId, 'Chicken bowl'),
    recipe_revision: () =>
      reviseRecipe(
        { title: 'Bowl', servings: 2, ingredients: ['rice'], steps: ['cook'] },
        'more rice'
      ),
    knowledge_import: () => importKnowledge({ kind: 'text', text: 'A long article. '.repeat(40) }),
    lab_parse: () => extractLabReport('JVBERi0xLjQK', '2026-10-21'),
    photo_reading: () => readPhotos({ kind: 'single', photo: subject }),
    report_read: () =>
      generateCoachRead({
        kind: 'self_review',
        period: { label: 'This week', rangeLabel: '15–21 Oct' },
      }),
    exercise_ai: () => addExerciseWithAI('cable face pull'),
    workout_import: () => importWorkoutFromPhoto('/9j/x'),
  };
  const missing = MODEL_CALL_TYPES.filter((t) => t !== 'other' && !(t in ENTRIES));
  missing.length === 0
    ? ok('every call type in the vocabulary has an entry point driven below')
    : bad('undriven call types', missing.join(', '));

  const today = todayISODate();
  for (const [type, run] of Object.entries(ENTRIES)) {
    const before = requests;
    const calls = readSpendLedger(db).days[today]?.[type]?.n ?? 0;
    await tryRun(run);
    const after = readSpendLedger(db).days[today]?.[type];
    const made = requests - before;
    made > 0 && after && after.n - calls === made && after.in >= 1200 * made && after.usd > 0
      ? ok(
          `${type}: ${made} request${made === 1 ? '' : 's'} → ${made} ledger call${made === 1 ? '' : 's'}, priced`
        )
      : bad(`${type} not recorded`, JSON.stringify({ made, after }));
  }
  const ledger = readSpendLedger(db);
  const total = Object.values(ledger.days[today] ?? {}).reduce((n, b) => n + b.n, 0);
  total === requests && !ledger.days[today]?.other
    ? ok(`all ${requests} requests are in the ledger, every one under its own type (none "other")`)
    : bad('ledger total', `${total} of ${requests}`);

  // Uninstalled, nothing is recorded — the sink is the only writer.
  uninstall();
  const frozen = JSON.stringify(readSpendLedger(db));
  await tryRun(ENTRIES.meal_estimate);
  JSON.stringify(readSpendLedger(db)) === frozen
    ? ok('with the sink removed, a call records nothing (one writer, one place)')
    : bad('recorded without a sink');

  // The failure path end to end: a ledger whose database refuses the write
  // leaves the call's answer intact.
  installSpendLedger(() => {
    throw new Error('no database');
  });
  let text = null;
  try {
    const result = await runCoachTurn(
      {
        apiKey: 'k',
        model: 'claude-sonnet-5',
        fetchImpl: globalThis.__ARC_TEST_FETCH__,
        callType: 'chat',
      },
      { system: 's', messages: [{ role: 'user', content: 'x' }], tools: [] },
      { onToken: () => {}, executeTool: async () => ({ content: '' }) }
    );
    text = result.text;
  } catch {
    text = 'threw';
  }
  text === 'SKIP'
    ? ok('a ledger that cannot reach its database never fails the model call')
    : bad('ledger failure broke the call', String(text));
  setModelUsageSink(null);
  await apiKeyStore.clearKey();
}

delete globalThis.require;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
