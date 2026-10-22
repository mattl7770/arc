/**
 * Headless test of the reversible usage policy (2026-10-21; Track 1 of
 * docs/spikes/chief-of-staff-release.md, the ADR "A reversible usage policy").
 *
 * What it holds, in order:
 *   1. LEAN is a literal snapshot of the values ARC ran on before the policy —
 *      so "switch back" is guaranteed by this file, not by anyone's memory.
 *   2. The profiles' shape: the owner's Generous values, Standard in between,
 *      every model selectable and with an explicit effort decision, the
 *      `query_records` limits the same at every level (they are in the cached
 *      tool description), the thread summary tied to the history window.
 *   3. Resolution: a fresh install is Generous; anything unreadable is Lean;
 *      the soft budget drops the rest of the day to Lean, and the next day
 *      starts on the chosen level again. Through the real preferences store.
 *   4. Each module reads the policy AT RUNTIME, and under Lean reads exactly
 *      Lean's value: the same module instances, switched between levels, with
 *      nothing reloaded.
 *   5. Models: chat vs one-shot, the level defaults, explicit picks win, the
 *      effort sent per call type through every real entry point (mocked fetch,
 *      no key, no network), and never to a model that rejects it.
 *   6. The pass under Generous: the chat model, `query_records` and web search,
 *      still read-only, the proposals directive unchanged.
 *   7. The cached prefix is byte-identical across levels; only `max_tokens`,
 *      `output_config` and the search tool's `max_uses` move.
 *
 * Run: npm run db:test.
 */
import { register } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// `expo/fetch` → the scripted fetch, `@/lib/db/client` → this suite's database
// (the stub db/spend-ledger.test.mjs uses). Nothing else is faked.
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

globalThis.require = (id) => {
  if (id === 'expo/fetch') return { fetch: (...args) => globalThis.__ARC_TEST_FETCH__(...args) };
  throw new Error(`no ${id} in the headless suite`);
};

const { migrate } = await import('../src/lib/db/migrate.ts');
const { MIGRATIONS } = await import('../src/lib/db/migrations.generated.ts');
const { getOrCreateUser } = await import('../src/lib/db/repositories/user.ts');
const policyModule = await import('../src/lib/ai/usage-policy.ts');
const {
  activeUsagePolicy,
  activeUsageResolution,
  budgetFor,
  DEFAULT_USAGE_LEVEL,
  GENEROUS_USAGE_POLICY,
  LEAN_USAGE_POLICY,
  resolveUsage,
  setUsagePolicySource,
  STANDARD_USAGE_POLICY,
  summaryTriggerOf,
  summaryWindowOf,
  USAGE_LEVELS,
  USAGE_POLICIES,
} = policyModule;
const { installUsagePolicy, readUsageSource, saveDailyBudget, saveUsageLevel, USAGE_POLICY_KEY } =
  await import('../src/lib/ai/usage-policy-store.ts');
const { recordModelCall } = await import('../src/lib/ai/spend-store.ts');
const {
  acceptsEffort,
  buildMessagesRequest,
  COACH_MODELS,
  DEFAULT_MODEL,
  hasEffortDecision,
  isCoachModel,
  runCoachTurn,
  setModelUsageSink,
} = await import('../src/lib/ai/model-client.ts');
const { apiKeyStore } = await import('../src/lib/ai/api-key-store.ts');
const { MODEL_CALL_TYPES } = await import('../src/lib/ai/call-types.ts');
const { buildWireHistory, toolDigest } = await import('../src/lib/ai/history-window.ts');
const { buildRollingSummary } = await import('../src/lib/ai/thread-summary.ts');
const { searchUserHistory } = await import('../src/lib/ai/history-search.ts');
const { buildTurnContext } = await import('../src/lib/ai/turn-context.ts');
const { rememberFact } = await import('../src/lib/db/repositories/coach-memory.ts');
const { appendMessage, createConversation } = await import('../src/lib/db/repositories/ai-chat.ts');
const { rankUsualFoods } = await import('../src/lib/nutrition/repeats.ts');
const { correctionsContext } = await import('../src/lib/nutrition/ratings.ts');
const { estimatorContext } = await import('../src/lib/nutrition/estimate.ts');
const { webSearchTool, WEB_SEARCH_TOOL_NAME } = await import('../src/lib/ai/web-search.ts');
const { buildCoachSystemPrompt } = await import('../src/lib/ai/system-prompt.ts');
const { COACH_TOOLS, PASS_READ_TOOLS, READ_TOOLS, toWireTools, toolByName } =
  await import('../src/lib/ai/tools/index.ts');
const { PASS_MODEL } = await import('../src/lib/ai/coach-pass.ts');

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
  return { raw, db };
}

/** Run `fn` with the policy source answering `level` (or a raw read). */
function atLevel(level, fn) {
  const previous = setUsagePolicySource(() => ({
    readable: true,
    stored: { level },
    spentTodayUsd: 0,
  }));
  try {
    return fn();
  } finally {
    setUsagePolicySource(previous);
  }
}
async function atLevelAsync(level, fn) {
  const previous = setUsagePolicySource(() => ({
    readable: true,
    stored: { level },
    spentTodayUsd: 0,
  }));
  try {
    return await fn();
  } finally {
    setUsagePolicySource(previous);
  }
}

// =============================================================================
console.log('1. LEAN is exactly what ARC ran on before the policy (a literal snapshot)');
{
  // THE REVERT GUARANTEE. Every value below was a literal in its own module on
  // main at 4fa124d: model-client.ts DEFAULT_MAX_TOKENS 8192 and
  // MAX_MODEL_CALLS_PER_TURN 8; no effort sent; DEFAULT_MODEL claude-sonnet-5
  // for everything; coach-pass.ts PASS_MODEL claude-haiku-4-5 with
  // PASS_READ_TOOLS (no query_records) and no search; web-search.ts 3 and 2;
  // history-window.ts 30 and 240; coach-memory.ts MEMORY_PROMPT_LIMIT 40;
  // history-search.ts 300 and 500; record-tools.ts 10 and 25; repeats.ts 30;
  // ratings.ts 8 and 1600. Change one and this fails — which is the point.
  const SNAPSHOT = {
    level: 'lean',
    maxTokensPerCall: 8192,
    maxModelCallsPerTurn: 8,
    effort: {},
    chatModel: 'claude-sonnet-5',
    utilityModel: null,
    passModel: 'claude-haiku-4-5',
    passQueryRecords: false,
    passWebSearch: false,
    coachWebSearchesPerTurn: 3,
    estimatorWebSearchesPerCall: 2,
    historyMessages: 30,
    toolDigestChars: 240,
    memoriesPerTurn: 40,
    historyExcerptChars: 300,
    knowledgeExcerptChars: 500,
    queryRecordsDefaultLimit: 10,
    queryRecordsMaxLimit: 25,
    usualFoods: 30,
    correctionExamples: 8,
    correctionChars: 1600,
    dailyBudgetUsd: null,
  };
  JSON.stringify(LEAN_USAGE_POLICY) === JSON.stringify(SNAPSHOT)
    ? ok('LEAN_USAGE_POLICY equals the literal snapshot, field for field and in order')
    : bad('Lean drifted', JSON.stringify(LEAN_USAGE_POLICY));
  Object.keys(LEAN_USAGE_POLICY).length === Object.keys(SNAPSHOT).length
    ? ok(`…and has no field the snapshot does not pin (${Object.keys(SNAPSHOT).length})`)
    : bad('unpinned field');
  summaryWindowOf(LEAN_USAGE_POLICY) === 30 && summaryTriggerOf(LEAN_USAGE_POLICY) === 40
    ? ok('Lean’s thread summary: window 30, trigger 40 — thread-summary.ts’s old literals')
    : bad('summary under Lean');
  Object.isFrozen(LEAN_USAGE_POLICY) &&
  Object.isFrozen(LEAN_USAGE_POLICY.effort) &&
  USAGE_LEVELS.every((l) => Object.isFrozen(USAGE_POLICIES[l]))
    ? ok('every profile is frozen — nothing at runtime can tune one')
    : bad('a profile is mutable');
  LEAN_USAGE_POLICY.chatModel === DEFAULT_MODEL && LEAN_USAGE_POLICY.passModel === PASS_MODEL
    ? ok('Lean’s chat model is DEFAULT_MODEL and its pass model is PASS_MODEL')
    : bad('Lean models', `${DEFAULT_MODEL} / ${PASS_MODEL}`);
}

// =============================================================================
console.log('\n2. the profiles: Generous as the owner set it, Standard in between');
{
  const G = GENEROUS_USAGE_POLICY;
  G.chatModel === 'claude-opus-5-5' &&
  G.utilityModel === 'claude-sonnet-5-5' &&
  G.passModel === 'chat' &&
  G.passQueryRecords &&
  G.passWebSearch &&
  G.historyMessages === 60 &&
  G.toolDigestChars === 600 &&
  G.memoriesPerTurn === 80 &&
  G.coachWebSearchesPerTurn === 5 &&
  G.estimatorWebSearchesPerCall === 3 &&
  G.maxModelCallsPerTurn === 12
    ? ok(
        'Generous: Opus 5.5 chat, Sonnet 5.5 one-shot, pass on chat + query_records + search, 60/600, 80, 5/3, 12'
      )
    : bad('Generous values', JSON.stringify(G));
  G.effort.chat === 'high' &&
  G.effort.meal_estimate === 'low' &&
  G.effort.meal_revision === 'low' &&
  G.effort.food_estimate === 'low' &&
  G.effort.lab_parse === 'xhigh' &&
  G.effort.report_read === 'xhigh'
    ? ok(
        'Generous effort: high for chat, low for estimates, xhigh for the lab parse and report read'
      )
    : bad('Generous effort', JSON.stringify(G.effort));
  DEFAULT_USAGE_LEVEL === 'generous'
    ? ok('the default level for a fresh install is Generous')
    : bad('default level', DEFAULT_USAGE_LEVEL);

  // Standard sits between the two on every numeric limit.
  const NUMERIC = [
    'maxTokensPerCall',
    'maxModelCallsPerTurn',
    'coachWebSearchesPerTurn',
    'estimatorWebSearchesPerCall',
    'historyMessages',
    'toolDigestChars',
    'memoriesPerTurn',
    'historyExcerptChars',
    'knowledgeExcerptChars',
    'usualFoods',
    'correctionExamples',
    'correctionChars',
  ];
  const outside = NUMERIC.filter(
    (k) =>
      !(
        LEAN_USAGE_POLICY[k] <= STANDARD_USAGE_POLICY[k] &&
        STANDARD_USAGE_POLICY[k] <= GENEROUS_USAGE_POLICY[k]
      )
  );
  outside.length === 0
    ? ok(`Lean ≤ Standard ≤ Generous on all ${NUMERIC.length} numeric limits`)
    : bad('Standard out of order', outside.join(', '));

  const models = USAGE_LEVELS.flatMap((l) => {
    const p = USAGE_POLICIES[l];
    return [p.chatModel, p.utilityModel, p.passModel].filter((m) => m !== null && m !== 'chat');
  });
  models.every(isCoachModel)
    ? ok('every model a profile names is a selectable COACH_MODELS id')
    : bad('unknown model in a profile', models.join(', '));
  const undecided = COACH_MODELS.filter((m) => !hasEffortDecision(m.id)).map((m) => m.id);
  undecided.length === 0
    ? ok('every COACH_MODELS id has an explicit effort decision (the fourth table)')
    : bad('model without an effort decision', undecided.join(', '));
  !acceptsEffort('claude-haiku-4-5') && acceptsEffort('claude-opus-5-5') && !acceptsEffort('gpt-x')
    ? ok('Haiku 4.5 (and any unknown model) is never sent an effort; Opus 5.5 is')
    : bad('effort table');

  const typed = MODEL_CALL_TYPES.filter((t) => t !== 'other');
  const effortless = ['standard', 'generous'].flatMap((l) =>
    typed.filter((t) => !USAGE_POLICIES[l].effort[t]).map((t) => `${l}:${t}`)
  );
  effortless.length === 0 && Object.keys(LEAN_USAGE_POLICY.effort).length === 0
    ? ok('Standard and Generous name an effort for every call type; Lean names none')
    : bad('effort coverage', effortless.join(', '));

  // query_records: the limits are written into the tool's description, which
  // rides the cached prefix. A level that moved them would make the tool lie.
  const desc = toolByName('query_records')?.description ?? '';
  USAGE_LEVELS.every(
    (l) =>
      USAGE_POLICIES[l].queryRecordsDefaultLimit === 10 &&
      USAGE_POLICIES[l].queryRecordsMaxLimit === 25
  ) && desc.includes('10 rows by default, 25 at most')
    ? ok('query_records limits are 10 / 25 at every level — the numbers its description states')
    : bad('query_records limits diverge from the description', desc);

  USAGE_LEVELS.every(
    (l) => summaryWindowOf(USAGE_POLICIES[l]) === USAGE_POLICIES[l].historyMessages
  ) && summaryTriggerOf(GENEROUS_USAGE_POLICY) === 70
    ? ok('the summary window IS the history window at every level (Generous: 60, trigger 70)')
    : bad('summary window untied');

  budgetFor('lean', { lean: 5 }) === null &&
  budgetFor('generous', undefined) === 5 &&
  budgetFor('standard', undefined) === 2.5 &&
  budgetFor('generous', { generous: null }) === null &&
  budgetFor('generous', { generous: 10 }) === 10 &&
  budgetFor('generous', { generous: -3 }) === 5
    ? ok(
        'budgets: Lean none; level defaults $2.50 / $5; an override wins; off is off; nonsense ignored'
      )
    : bad('budgetFor');
}

// =============================================================================
console.log('\n3. resolution: Generous by default, Lean when unreadable, Lean past the budget');
{
  const r = (stored, spent = 0) => resolveUsage({ readable: true, stored, spentTodayUsd: spent });
  const fresh = r(undefined);
  fresh.effective === 'generous' &&
  fresh.why === 'default' &&
  fresh.policy === GENEROUS_USAGE_POLICY
    ? ok('nothing stored (a fresh install) → Generous, “the default”')
    : bad('fresh install', JSON.stringify(fresh));
  const chosen = r({ level: 'standard' });
  chosen.effective === 'standard' && chosen.why === 'chosen'
    ? ok('a stored level runs, “chosen”')
    : bad('chosen', JSON.stringify(chosen));
  const garbage = [r({ level: 'turbo' }), r('generous'), r(null), r([1])];
  garbage.every((g) => g.effective === 'lean' && g.why === 'unreadable')
    ? ok('a stored value that is not a level (a typo, a string, null, an array) → Lean')
    : bad('garbage', JSON.stringify(garbage.map((g) => g.effective)));
  resolveUsage({ readable: false }).policy === LEAN_USAGE_POLICY
    ? ok('an unreadable setting → Lean')
    : bad('unreadable');

  const previous = setUsagePolicySource(null);
  activeUsagePolicy() === LEAN_USAGE_POLICY && activeUsageResolution().why === 'unreadable'
    ? ok('no source installed (the headless suites, a module before launch) → Lean')
    : bad('no source');
  setUsagePolicySource(() => {
    throw new Error('store exploded');
  });
  activeUsagePolicy() === LEAN_USAGE_POLICY
    ? ok('a source that throws → Lean, and activeUsagePolicy never throws')
    : bad('throwing source');
  setUsagePolicySource(previous);

  const under = r({ level: 'generous' }, 4.99);
  const over = r({ level: 'generous' }, 5);
  under.effective === 'generous' &&
  over.effective === 'lean' &&
  over.why === 'budget' &&
  over.chosen === 'generous' &&
  over.budgetUsd === 5
    ? ok('the soft budget: $4.99 of $5 runs Generous; $5.00 drops the rest of the day to Lean')
    : bad('budget', JSON.stringify({ under: under.effective, over }));
  r({ level: 'generous', budgets: { generous: null } }, 500).effective === 'generous'
    ? ok('a budget turned off never trips, whatever is spent')
    : bad('budget off');
  r({ budgets: { standard: 1 } }).why === 'default'
    ? ok('a saved budget with no saved level is still the default level')
    : bad('budget-only');
}

// =============================================================================
console.log('\n4. through the preferences store and the spend ledger');
{
  const { db } = freshDb();
  const now = new Date();
  const fresh = resolveUsage(readUsageSource(db, now));
  fresh.effective === 'generous' && fresh.why === 'default'
    ? ok('a fresh database resolves to Generous (nothing stored)')
    : bad('fresh db', JSON.stringify(fresh));
  saveUsageLevel(db, 'standard');
  saveDailyBudget(db, 'standard', 1);
  const prefs = JSON.parse(getOrCreateUser(db).preferences)[USAGE_POLICY_KEY];
  prefs.level === 'standard' && prefs.budgets.standard === 1
    ? ok('the level and a budget are stored under preferences.usagePolicy, and nothing else moves')
    : bad('stored shape', JSON.stringify(prefs));
  let threw = false;
  try {
    saveDailyBudget(db, 'lean', 3);
  } catch {
    threw = true;
  }
  threw ? ok('Lean refuses a budget (it is the floor)') : bad('lean budget stored');

  // The ledger drives the budget: $1.20 spent today against $1 → Lean.
  const uninstall = installUsagePolicy(
    () => db,
    () => now
  );
  recordModelCall(
    db,
    {
      callType: 'chat',
      model: 'claude-sonnet-5-5',
      usage: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      usd: 1.2,
    },
    now
  );
  const tripped = activeUsageResolution();
  tripped.effective === 'lean' && tripped.why === 'budget' && tripped.chosen === 'standard'
    ? ok('$1.20 recorded today against a $1 Standard budget → the installed source reads Lean')
    : bad('ledger budget', JSON.stringify(tripped));
  uninstall();
  const tomorrow = new Date(now.getTime() + 36 * 3600_000);
  const next = resolveUsage(readUsageSource(db, tomorrow));
  next.effective === 'standard'
    ? ok('the next logical day starts on Standard again — no automatic revert beyond the day')
    : bad('next day', JSON.stringify(next));

  // The schema's CHECK keeps the blob valid JSON, so "unreadable" here is JSON
  // that is not an object.
  db.run('UPDATE users SET preferences = ?', ['[1]']);
  resolveUsage(readUsageSource(db, now)).why === 'unreadable'
    ? ok('preferences that are not an object → unreadable → Lean (never the default)')
    : bad('corrupt prefs');
  let refused = false;
  try {
    saveUsageLevel(db, 'generous');
  } catch {
    refused = true;
  }
  refused && getOrCreateUser(db).preferences === '[1]'
    ? ok('…and a save does not overwrite a blob it could not read')
    : bad('overwrote corrupt prefs');
}

// =============================================================================
console.log('\n5. each module reads the policy at runtime — Lean’s exact value under Lean');
{
  const { db } = freshDb();
  globalThis.__ARC_TEST_DB__ = db;

  // History window and digests (history-window.ts).
  const t0 = Date.now();
  const thread = Array.from({ length: 100 }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `turn ${i}`,
    createdAt: t0,
  }));
  const n = (level) => atLevel(level, () => buildWireHistory(thread, null, new Date(t0)).length);
  const lean = n('lean');
  const gen = n('generous');
  // Standard's 45 lands on an assistant turn and sheds it (the API wants a user
  // turn first), so 44 reach the wire.
  lean === 30 && gen === 60 && n('standard') === 44
    ? ok(
        'buildWireHistory replays 30 (Lean) / 45 (less the shed lead) / 60 messages — same module, switched'
      )
    : bad('history window', `${lean} / ${gen}`);
  const long = 'x'.repeat(2000);
  const digest = (level) =>
    atLevel(level, () => toolDigest([{ id: 'a', name: 'get_insights', input: {}, result: long }]));
  const dl = digest('lean');
  const dg = digest('generous');
  dl.includes(`${'x'.repeat(240)}…`) &&
  !dl.includes('x'.repeat(241)) &&
  dg.includes(`${'x'.repeat(600)}…`)
    ? ok('toolDigest cuts at 240 (Lean) / 600 (Generous)')
    : bad('digest', `${dl.length} / ${dg.length}`);

  // The thread summary (thread-summary.ts), tied to the window.
  const conv = createConversation(db);
  for (let i = 0; i < 50; i++) appendMessage(db, conv, i % 2 ? 'assistant' : 'user', `said ${i}`);
  const sl = atLevel('lean', () => buildRollingSummary(db, conv));
  const sg = atLevel('generous', () => buildRollingSummary(db, conv));
  sl !== null && sg === null
    ? ok('a 50-message thread is summarised past Lean’s 30, and not at all inside Generous’s 60')
    : bad('summary window', `${sl} / ${sg}`);

  // Memories (turn-context.ts).
  for (let i = 0; i < 100; i++) rememberFact(db, { content: `fact number ${i}` });
  const mem = (level) =>
    atLevel(level, () => (buildTurnContext(db, new Date()).match(/\(id: /g) ?? []).length);
  const ml = mem('lean');
  const mg = mem('generous');
  ml === 40 && mg === 80
    ? ok('the turn context carries 40 memories (Lean) / 80 (Generous)')
    : bad('memories', `${ml} / ${mg}`);

  // Excerpts (history-search.ts).
  appendMessage(db, conv, 'user', `zebra ${'y'.repeat(3000)}`);
  const ex = (level) =>
    atLevel(level, () => searchUserHistory(db, 'zebra')[0]?.text.replace(/…/g, '').length ?? 0);
  const el = ex('lean');
  const eg = ex('generous');
  el === 300 && eg === 500
    ? ok('search_history excerpts run 300 (Lean) / 500 (Generous) characters')
    : bad('excerpt', `${el} / ${eg}`);

  // Usual foods (repeats.ts) and corrections (ratings.ts).
  const items = Array.from({ length: 120 }, (_, i) => ({
    name: `food ${i % 60}`,
    amount: 100,
    unit: 'g',
    kcal: 100,
    protein_g: 1,
    carbs_g: 1,
    fat_g: 1,
    created_at: `2026-10-${String(1 + (i % 20)).padStart(2, '0')}T08:00:00.000Z`,
    food_id: null,
    is_composite: 0,
  }));
  const uf = (level) => atLevel(level, () => rankUsualFoods(items).length);
  uf('lean') === 30 && uf('generous') === 50
    ? ok('usual foods: 30 (Lean) / 50 (Generous) per estimate')
    : bad('usual foods', `${uf('lean')} / ${uf('generous')}`);
  const corrections = Array.from({ length: 20 }, (_, i) => ({
    issue: 'portion',
    before: [
      {
        name: `Dish ${i}`,
        amount: 300,
        unit: 'g',
        kcal: 400,
        protein_g: 20,
        carbs_g: 30,
        fat_g: 10,
      },
    ],
    after: [
      {
        name: `Dish ${i}`,
        amount: 200,
        unit: 'g',
        kcal: 270,
        protein_g: 13,
        carbs_g: 20,
        fat_g: 7,
      },
    ],
  }));
  const cl = (level) =>
    atLevel(level, () => (correctionsContext(corrections) ?? '').split('\n').length - 1);
  const cLean = cl('lean');
  const cGen = cl('generous');
  cLean > 0 && cLean <= 8 && cGen > cLean && cGen <= 12
    ? ok(
        `corrections: ${cLean} lines under Lean (≤ 8 / 1,600 chars), ${cGen} under Generous (≤ 12 / 2,400)`
      )
    : bad('corrections', `${cLean} / ${cGen}`);
  atLevel('lean', () => (correctionsContext(corrections) ?? '').length <= 1600) &&
  atLevel('generous', () => (correctionsContext(corrections) ?? '').length <= 2400)
    ? ok('…each within its level’s character budget')
    : bad('corrections chars');

  // The estimators' search cap (estimate.ts).
  const est = (level) =>
    atLevel(level, () => estimatorContext({ webSearch: true, region: null }).webSearch?.maxUses);
  est('lean') === 2 && est('generous') === 3
    ? ok('estimates may search 2 times (Lean) / 3 (Generous)')
    : bad('estimator searches', `${est('lean')} / ${est('generous')}`);

  // The model client: the cap and the effort in the request body.
  const body = (level, model, callType = 'chat', extra = {}) =>
    atLevel(level, () =>
      JSON.parse(
        buildMessagesRequest(
          { apiKey: 'k', model, fetchImpl: async () => null, callType, ...extra },
          { system: 's', messages: [{ role: 'user', content: 'q' }], tools: [] }
        ).body
      )
    );
  const bl = body('lean', 'claude-opus-5-5');
  const bg = body('generous', 'claude-opus-5-5');
  bl.max_tokens === 8192 && !('output_config' in bl)
    ? ok('Lean: max_tokens 8192 and NO output_config — the request ARC sent before')
    : bad('lean body', JSON.stringify(bl));
  bg.max_tokens === 16384 && bg.output_config?.effort === 'high'
    ? ok('Generous: max_tokens 16384, effort high on a chat call')
    : bad('generous body', JSON.stringify(bg));
  !('output_config' in body('generous', 'claude-haiku-4-5'))
    ? ok('Generous never sends an effort to Haiku 4.5, which rejects it')
    : bad('effort to haiku 4.5');
  body('generous', 'claude-sonnet-5-5', 'lab_parse', { maxTokens: 32000 }).max_tokens === 32000
    ? ok('a caller’s own cap (the lab parse’s 32,000 floor) is never replaced by the policy')
    : bad('caller cap');

  // Round trips per turn: a model that never stops calling tools.
  const toolSse = [
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_x', name: 'get_insights', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{}' },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]
    .map((d) => `event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`)
    .join('');
  let calls = 0;
  const loopFetch = async () => {
    calls++;
    const bytes = new TextEncoder().encode(toolSse);
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
  const loop = async (level) => {
    calls = 0;
    const result = await atLevelAsync(level, () =>
      runCoachTurn(
        { apiKey: 'k', model: 'claude-sonnet-5', fetchImpl: loopFetch, callType: 'chat' },
        {
          system: 's',
          messages: [{ role: 'user', content: 'q' }],
          tools: toWireTools([toolByName('get_insights')]),
        },
        { onToken: () => {}, executeTool: async () => ({ content: '{}' }) }
      )
    );
    return { calls, stop: result.stopReason };
  };
  const rl = await loop('lean');
  const rg = await loop('generous');
  rl.calls === 8 && rg.calls === 12 && rl.stop === 'tool_use_limit'
    ? ok('a runaway tool loop stops at 8 round trips (Lean) / 12 (Generous)')
    : bad('round trips', JSON.stringify({ rl, rg }));
}

// =============================================================================
console.log('\n6. models and effort through every real entry point');
{
  const { db } = freshDb();
  globalThis.__ARC_TEST_DB__ = db;
  await apiKeyStore.setKey('test-key');
  await apiKeyStore.setWebSearch(true);
  await apiKeyStore.setModel(null);
  await apiKeyStore.setUtilityModel(null);

  const sse = (text) =>
    [
      { type: 'message_start', message: { usage: { input_tokens: 100 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
      { type: 'message_stop' },
    ]
      .map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
      .join('');
  let bodies = [];
  globalThis.__ARC_TEST_FETCH__ = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
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
  const tryRun = async (fn) => {
    try {
      await fn();
    } catch {
      // The reply ("SKIP") is not what these features want; the request is.
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
  const typed = MODEL_CALL_TYPES.filter((t) => t !== 'other');
  typed.every((t) => t in ENTRIES)
    ? ok(`all ${typed.length} call types have an entry point driven below`)
    : bad('undriven call type');

  /** Drive every entry point at `level`; the first request each one made. */
  const driveAll = async (level) => {
    const out = {};
    for (const [type, run] of Object.entries(ENTRIES)) {
      bodies = [];
      await atLevelAsync(level, () => tryRun(run));
      out[type] = bodies[0] ?? null;
    }
    return out;
  };

  // LEAN: everything on Sonnet 5 except the pass (Haiku 4.5), no effort anywhere,
  // the old caps — the requests ARC sent before the policy.
  const lean = await driveAll('lean');
  const leanWrong = Object.entries(lean).filter(([type, b]) => {
    if (!b) return true;
    const model = type === 'pass' ? 'claude-haiku-4-5' : 'claude-sonnet-5';
    const cap = type === 'lab_parse' ? 32000 : type === 'photo_reading' ? 4000 : 8192;
    return b.model !== model || 'output_config' in b || b.max_tokens !== cap;
  });
  leanWrong.length === 0
    ? ok('Lean: every entry point on Sonnet 5 (the pass on Haiku 4.5), no effort, the old caps')
    : bad(
        'Lean requests',
        leanWrong.map(([t, b]) => `${t}:${b?.model}/${b?.max_tokens}`).join(' ')
      );
  const leanSearch = lean.chat?.tools?.find((t) => t.name === WEB_SEARCH_TOOL_NAME);
  const leanPassTools = (lean.pass?.tools ?? []).map((t) => t.name);
  leanSearch?.max_uses === 3 &&
  !leanPassTools.includes('query_records') &&
  !leanPassTools.includes(WEB_SEARCH_TOOL_NAME) &&
  leanPassTools.length === PASS_READ_TOOLS.length
    ? ok('Lean: chat searches 3; the pass has today’s curated reads — no query_records, no search')
    : bad('Lean tools', JSON.stringify({ leanSearch, leanPassTools }));

  // GENEROUS: chat (and the pass) on Opus 5.5, one-shot calls on Sonnet 5.5,
  // each with its level's effort.
  const gen = await driveAll('generous');
  const genWrong = Object.entries(gen).filter(([type, b]) => {
    if (!b) return true;
    const model = type === 'chat' || type === 'pass' ? 'claude-opus-5-5' : 'claude-sonnet-5-5';
    return b.model !== model || b.output_config?.effort !== GENEROUS_USAGE_POLICY.effort[type];
  });
  genWrong.length === 0
    ? ok(
        'Generous: chat and pass on Opus 5.5, every one-shot call on Sonnet 5.5, each with its effort'
      )
    : bad(
        'Generous requests',
        genWrong.map(([t, b]) => `${t}:${b?.model}/${b?.output_config?.effort}`).join(' ')
      );
  gen.chat?.max_tokens === 16384 &&
  gen.lab_parse?.max_tokens === 32000 &&
  gen.chat?.tools?.find((t) => t.name === WEB_SEARCH_TOOL_NAME)?.max_uses === 5
    ? ok('Generous: chat cap 16,384, the lab parse keeps its own floor, chat searches 5')
    : bad(
        'Generous caps',
        JSON.stringify({ c: gen.chat?.max_tokens, l: gen.lab_parse?.max_tokens })
      );

  // Explicit picks win over the level, both ways.
  await apiKeyStore.setModel('claude-sonnet-5');
  await apiKeyStore.setUtilityModel('claude-haiku-4-5');
  const picked = await atLevelAsync('generous', async () => ({
    chat: apiKeyStore.getChatModel(),
    utility: apiKeyStore.getUtilityModel(),
  }));
  bodies = [];
  await atLevelAsync('generous', () => tryRun(ENTRIES.meal_estimate));
  const pickedEstimate = bodies[0];
  bodies = [];
  await atLevelAsync('generous', () => tryRun(ENTRIES.pass));
  const pickedPass = bodies[0];
  picked.chat === 'claude-sonnet-5' &&
  picked.utility === 'claude-haiku-4-5' &&
  pickedEstimate?.model === 'claude-haiku-4-5' &&
  !('output_config' in pickedEstimate) &&
  pickedPass?.model === 'claude-sonnet-5'
    ? ok(
        'explicit picks win under Generous: chat Sonnet 5, one-shot Haiku 4.5 (no effort sent to it), the pass on the picked chat model'
      )
    : bad('picks', JSON.stringify({ picked, e: pickedEstimate?.model, p: pickedPass?.model }));
  await apiKeyStore.setUtilityModel(null);
  atLevel('lean', () => apiKeyStore.getUtilityModel()) === 'claude-sonnet-5'
    ? ok('with no utility pick, Lean’s one-shot calls follow the chat model — as before the split')
    : bad('lean utility follows chat');
  await apiKeyStore.setModel(null);
  atLevel('generous', () => apiKeyStore.getChatModel()) === 'claude-opus-5-5' &&
  atLevel('standard', () => apiKeyStore.getChatModel()) === 'claude-sonnet-5-5'
    ? ok('clearing the pick returns the chat to the level’s default (Opus 5.5 / Sonnet 5.5)')
    : bad('clear pick');

  // ===========================================================================
  console.log('\n7. the pass under Generous: the chat’s read access, still read-only');
  const passTools = gen.pass?.tools ?? [];
  const names = passTools.map((t) => t.name);
  const registry = passTools.filter((t) => t.name !== WEB_SEARCH_TOOL_NAME);
  names.includes('query_records') &&
  names.includes(WEB_SEARCH_TOOL_NAME) &&
  registry.length === READ_TOOLS.length &&
  registry.every((t) => toolByName(t.name)?.readOnly === true)
    ? ok(
        `the Generous pass has query_records and web search, and its ${registry.length} registry tools are ALL reads`
      )
    : bad('Generous pass tools', names.join(','));
  const writes = COACH_TOOLS.filter((t) => !t.readOnly).map((t) => t.name);
  !writes.some((w) => names.includes(w))
    ? ok(`not one of the ${writes.length} write tools reaches the pass`)
    : bad('a write tool reached the pass');
  // At one fixed instant (the directive states the wall clock), the user turn
  // the pass sends is the same bytes at both levels: the proposals mechanism
  // does not know the level exists.
  const fixed = new Date();
  const directiveAt = async (level) => {
    bodies = [];
    await atLevelAsync(level, () =>
      tryRun(() =>
        runCoachPass(db, {
          trigger: { kind: 'daily' },
          now: fixed,
          brief: true,
          fetchImpl: globalThis.__ARC_TEST_FETCH__,
        })
      )
    );
    return JSON.stringify(bodies[0]?.messages?.[0]?.content);
  };
  const dLean = await directiveAt('lean');
  const dGen = await directiveAt('generous');
  dLean === dGen && dGen.includes('PROPOSE') && dGen.includes('SKIP')
    ? ok('the pass directive — SKIP, BRIEF and the PROPOSE lines — is the same text at both levels')
    : bad('pass directive moved across levels', `${dLean.length} / ${dGen.length}`);

  // A write tool called by the Generous pass is refused, not run.
  const write = writes.find((w) => w === 'log_metric') ?? writes[0];
  let refusal = null;
  let step = 0;
  globalThis.__ARC_TEST_FETCH__ = async (_url, init) => {
    const sent = JSON.parse(init.body);
    step++;
    const events =
      step === 1
        ? [
            { type: 'message_start', message: { usage: { input_tokens: 10 } } },
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: 'toolu_w', name: write, input: {} },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: '{}' },
            },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'message_delta',
              delta: { stop_reason: 'tool_use' },
              usage: { output_tokens: 5 },
            },
            { type: 'message_stop' },
          ]
        : [
            { type: 'message_start', message: { usage: { input_tokens: 10 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SKIP' } },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 1 },
            },
            { type: 'message_stop' },
          ];
    if (step === 2) {
      const last = sent.messages[sent.messages.length - 1];
      refusal = Array.isArray(last.content) ? last.content[0] : null;
    }
    const bytes = new TextEncoder().encode(
      events.map((d) => `event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`).join('')
    );
    let done = false;
    return {
      ok: true,
      status: 200,
      text: async () => '',
      body: {
        getReader: () => ({
          read: async () =>
            done ? { done: true } : ((done = true), { done: false, value: bytes }),
        }),
      },
    };
  };
  const metricsBefore = db.get('SELECT COUNT(*) AS n FROM body_metrics')?.n;
  await atLevelAsync('generous', () =>
    runCoachPass(db, { trigger: { kind: 'daily' }, fetchImpl: globalThis.__ARC_TEST_FETCH__ })
  );
  refusal?.is_error === true &&
  String(refusal?.content).includes('not available in an automatic pass') &&
  db.get('SELECT COUNT(*) AS n FROM body_metrics')?.n === metricsBefore
    ? ok(`a write (${write}) called by the Generous pass is refused and nothing is written`)
    : bad('pass write not refused', JSON.stringify(refusal));

  // ===========================================================================
  console.log('\n8. the cached prefix is byte-identical across levels');
  const systemOf = (b) => JSON.stringify(b?.system?.[0]);
  const registryOf = (b) =>
    JSON.stringify((b?.tools ?? []).filter((t) => t.name !== WEB_SEARCH_TOOL_NAME));
  const chatBodies = [lean.chat, gen.chat];
  systemOf(lean.chat) === systemOf(gen.chat) && registryOf(lean.chat) === registryOf(gen.chat)
    ? ok(
        'chat: the static system block and every registry tool are the same bytes under Lean and Generous'
      )
    : bad('chat prefix moved');
  chatBodies.every((b) => b?.system?.[0]?.text === buildCoachSystemPrompt())
    ? ok('…and the system block is buildCoachSystemPrompt() — no level is interpolated into it')
    : bad('system text');

  // Same model at every level: the whole body differs ONLY in max_tokens,
  // output_config and the search tool's max_uses.
  const sameModel = (level) =>
    atLevel(level, () => {
      const p = activeUsagePolicy();
      return JSON.parse(
        buildMessagesRequest(
          { apiKey: 'k', model: 'claude-opus-5-5', fetchImpl: async () => null, callType: 'chat' },
          {
            system: buildCoachSystemPrompt(),
            systemContext: 'state',
            messages: [{ role: 'user', content: 'q' }],
            tools: toWireTools(COACH_TOOLS),
            webSearch: { maxUses: p.coachWebSearchesPerTurn },
          }
        ).body
      );
    });
  const strip = (b) => {
    const { max_tokens: _m, output_config: _o, ...rest } = b;
    return JSON.stringify({
      ...rest,
      tools: rest.tools.map((t) =>
        t.name === WEB_SEARCH_TOOL_NAME ? { ...t, max_uses: 'level' } : t
      ),
    });
  };
  const variants = USAGE_LEVELS.map(sameModel);
  new Set(variants.map(strip)).size === 1 && new Set(variants.map((v) => v.max_tokens)).size === 3
    ? ok(
        'on one model, the three levels’ requests differ only in max_tokens, output_config and the search tool’s max_uses'
      )
    : bad('a level moved something else in the request');
  // The search tool renders AFTER the registry's tool breakpoint, so the ~8k
  // tool tier is untouched by its max_uses; the system tier re-writes once.
  const tools = variants[2].tools;
  const breakpoint = tools.findIndex((t) => t.cache_control);
  tools[tools.length - 1].name === WEB_SEARCH_TOOL_NAME && breakpoint === tools.length - 2
    ? ok('the search tool (the one prefix byte a level moves) sits after the tool breakpoint')
    : bad('search tool placement', String(breakpoint));
  webSearchTool('claude-opus-5-5', 5)?.max_uses === 5
    ? ok('(the search tool carries the level’s cap)')
    : bad('search tool cap');

  setModelUsageSink(null);
  await apiKeyStore.clearKey();
}

delete globalThis.require;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
