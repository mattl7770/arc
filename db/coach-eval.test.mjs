/**
 * Headless test of Phase-5 RIGOR (docs/coach-intelligence-review.md §4 Phase 5):
 *
 *   - the statistics behind the detectors (Welch's t, critical r, the tables)
 *   - cost estimation and the muted per-reply caption
 *   - the number-provenance checker — the first real test of the
 *     never-fabricate rail
 *   - a GOLDEN TRANSCRIPT: a scripted turn replayed end to end through
 *     runCoachTurn with the real tool registry against a seeded database,
 *     asserting tool selection, usage accounting, and that every number in the
 *     reply traces to something the turn actually read.
 *
 * No network and no op-sqlite. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { todayISODate } from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { isoDaysAgo } from '../src/lib/ai/series.ts';
import { compareWindows, rCritical, stdev, tCritical } from '../src/lib/ai/stats.ts';
import { estimateCost, usageCaption } from '../src/lib/ai/cost.ts';
import { checkNumberProvenance, extractNumbers } from '../src/lib/ai/provenance.ts';
import { runCoachTurn } from '../src/lib/ai/model-client.ts';
import { buildTurnContext } from '../src/lib/ai/turn-context.ts';
import { toolByName, COACH_TOOLS, READ_TOOLS, toWireTools } from '../src/lib/ai/tools/index.ts';
import { buildCoachSystemPrompt } from '../src/lib/ai/system-prompt.ts';

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
const near = (a, b, eps = 0.01) => typeof a === 'number' && Math.abs(a - b) < eps;

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

console.log('1. the statistics: variance, critical values, Welch');
{
  stdev([2, 4, 4, 4, 5, 5, 7, 9]) !== null && near(stdev([2, 4, 4, 4, 5, 5, 7, 9]), 2.138, 0.01)
    ? ok('sample standard deviation (n−1) is correct')
    : bad('stdev', String(stdev([2, 4, 4, 4, 5, 5, 7, 9])));
  stdev([5]) === null ? ok('one observation has no variance to report') : bad('stdev n=1');

  near(tCritical(10), 2.228, 0.001) && near(tCritical(30), 2.042, 0.001)
    ? ok('t critical values match the table')
    : bad('t table', `${tCritical(10)} / ${tCritical(30)}`);
  // df = 11 sits between the table's 10 (2.228) and 12 (2.179). Stepping DOWN
  // means df = 10's LARGER bar. Asserting 2.179 here is asserting the bug: it
  // is the step-UP answer, and it loosens the gate rather than tightening it.
  tCritical(11) === 2.228
    ? ok('an off-table df steps DOWN (conservative — a larger bar, never smaller)')
    : bad('t step-down: expected df=10 2.228, got', String(tCritical(11)));
  tCritical(11) > tCritical(12)
    ? ok('fewer degrees of freedom always demand a larger t')
    : bad('t monotonicity', `${tCritical(11)} vs ${tCritical(12)}`);

  // The gate that matters: n=8 at r=0.5 must NOT clear, n=20 at r=0.5 must.
  rCritical(8) > 0.5
    ? ok(`n=8 needs |r| > ${rCritical(8).toFixed(2)} — 0.5 was p≈0.20, a coin flip`)
    : bad('rCritical(8)', String(rCritical(8)));
  rCritical(20) < 0.5
    ? ok(`n=20 needs only |r| > ${rCritical(20).toFixed(2)} — more pairs, less doubt`)
    : bad('rCritical(20)', String(rCritical(20)));
}

console.log('2. compareWindows: two bars, and both must clear');
{
  // Big, clean difference → fires.
  const clear = compareWindows([40, 41, 39, 40, 41], [55, 54, 56, 55, 55, 54], 5, 5);
  clear && clear.significant
    ? ok('a large difference against tight variance is significant')
    : bad('clear case', JSON.stringify(clear));

  // Same means, but the recent window is wildly noisy — inside normal variation.
  const noisy = compareWindows([20, 70, 30, 65, 25], [55, 54, 56, 55, 55, 54], 5, 5);
  noisy && !noisy.significant
    ? ok('the same mean shift does NOT fire when it sits inside the user’s own noise')
    : bad('noisy case', JSON.stringify(noisy));

  // Statistically immaculate but practically trivial.
  const trivial = compareWindows([100, 100, 100, 100, 100], [101, 101, 101, 101, 101], 5, 5);
  trivial && !trivial.significant
    ? ok('a 1% shift stays quiet even with zero variance (the practical bar)')
    : bad('trivial case', JSON.stringify(trivial));

  compareWindows([1, 2], [3, 4, 5], 5, 5) === null
    ? ok('too few observations returns null rather than a guess')
    : bad('min-n');
  compareWindows([5, 5, 5, 5, 5], [0, 0, 0, 0, 0], 5, 5) === null
    ? ok('a zero baseline has no percentage to report')
    : bad('zero baseline');
}

console.log('3. cost: an estimate the user can see, never a precise-looking lie');
{
  const usage = {
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 10_000,
    cacheWriteTokens: 0,
  };
  // Opus: 1000×$5/M + 10000×$5/M×0.1 + 500×$25/M = 0.005 + 0.005 + 0.0125
  near(estimateCost(usage, 'claude-opus-5'), 0.0225, 0.0001)
    ? ok('cost sums input, cached reads at 0.1×, and output at the output rate')
    : bad('opus cost', String(estimateCost(usage, 'claude-opus-5')));
  estimateCost(usage, 'claude-haiku-4-5') < estimateCost(usage, 'claude-opus-5')
    ? ok('Haiku costs less than Opus for the same turn')
    : bad('model ordering');
  estimateCost(usage, 'some-future-model') === null
    ? ok('an unknown model returns null instead of a made-up price')
    : bad('unknown model');

  // The caption must break CACHED tokens out separately. A dashboard reports
  // one lump total, so a warm 10k re-read looks identical to paying full price
  // for it — and costs a tenth. Without the split you cannot tell a cache
  // problem from a round-trip problem from a thinking problem.
  const caption = usageCaption(usage, 'claude-opus-5', 3);
  caption === '3 tool calls · 10.0k cached · 1.0k in · 500 out · ~$0.02'
    ? ok(`caption reads "${caption}"`)
    : bad('caption', caption);
  /cached/.test(caption) && /out/.test(caption)
    ? ok('…naming cached reads and output separately, not one opaque total')
    : bad('caption hides the breakdown', caption);
  usageCaption(
    { inputTokens: 200, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 9000 },
    'claude-sonnet-5',
    0
  ).includes('9.0k cache write')
    ? ok('a COLD turn says so — the expensive event is the one worth seeing')
    : bad('cold write not surfaced');
  // Three decimals under a cent: at ~$0.004 a turn, 0.004 vs 0.009 is the whole
  // optimisation, and "<$0.01" hides exactly that.
  usageCaption(
    { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    'claude-haiku-4-5',
    0
  ) === '10 in · 5 out · ~$0.000'
    ? ok('a sub-cent turn shows three decimals, not "<$0.01"')
    : bad(
        'small caption',
        usageCaption(
          { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
          'claude-haiku-4-5',
          0
        )
      );
  usageCaption(undefined, 'claude-opus-5', 0) === null
    ? ok('no usage → no caption (nothing invented)')
    : bad('missing usage');
}

console.log('4. provenance: numbers in a reply must trace to what the turn read');
{
  extractNumbers('Your HRV averaged 48 ms, down 14.5% from 56.')
    .map((n) => n.value)
    .join(',') === '48,14.5,56'
    ? ok('every numeric literal is extracted')
    : bad(
        'extract',
        JSON.stringify(extractNumbers('Your HRV averaged 48 ms, down 14.5% from 56.'))
      );
  extractNumbers('Do 3 sets of 8 at 07:00 on 2026-08-08.').length === 0
    ? ok('set/rep counts, clock times and dates are not treated as data claims')
    : bad('ignorable', JSON.stringify(extractNumbers('Do 3 sets of 8 at 07:00 on 2026-08-08.')));

  const sources = ['{"metric":"hrv","stats":{"avg":47.6,"last":44}}'];
  checkNumberProvenance('HRV is averaging 48 ms.', sources).unsourced.length === 0
    ? ok('a number rounded from a tool result (47.6 → 48) counts as sourced')
    : bad('rounding tolerance');
  const invented = checkNumberProvenance('Your ApoB is 78 mg/dL.', sources);
  invented.unsourced.length === 1 && invented.unsourced[0].value === 78
    ? ok('a number from NOWHERE is caught — this is the never-fabricate rail, tested')
    : bad('fabrication missed', JSON.stringify(invented));
  checkNumberProvenance('You said 210 lb this morning.', ['user: I weighed 210 this morning'])
    .unsourced.length === 0
    ? ok('the user’s own words count as a source')
    : bad('user source');

  // The two leniencies that made this rail decorative (adversarial review).
  //
  // Substring: "48" is inside "2048", "1.48", "3480" — with text matching, a
  // fabricated 2–3 digit number had to be unlucky to get caught.
  const substr = checkNumberProvenance('Your fasting glucose is 48 mg/dL.', [
    '{"steps":2048,"weight":3480}',
  ]);
  substr.unsourced.length === 1
    ? ok('a number that only appears as a SUBSTRING of a source number is unsourced')
    : bad('substring leniency', JSON.stringify(substr));

  // The ±1% band: the haystack is the whole turn — context block plus every
  // tool result — so a percentage window round any of hundreds of numbers
  // covered most of the number line.
  const band = checkNumberProvenance('Your ApoB came back at 1,840 mg/dL.', [
    '{"active_energy":1822,"resting":1858}',
  ]);
  band.unsourced.length === 1
    ? ok('a large number within 1% of a source no longer passes — rounding must reproduce it')
    : bad('1% band leniency', JSON.stringify(band));

  // …while genuine prose rounding at the written precision still passes.
  checkNumberProvenance('Deep sleep averaged 1.4 h.', ['{"deep_sleep_h":1.43}']).unsourced
    .length === 0
    ? ok('rounding to the precision actually written (1.43 → 1.4) is still sourced')
    : bad('over-tightened: legitimate rounding now flagged');
}

console.log('5. golden transcript: a scripted turn, replayed against real tools');
{
  const { db, raw } = freshDb();
  // Seed a body of data the reply can legitimately quote.
  for (let d = 1; d <= 10; d++) {
    raw
      .prepare(
        `INSERT INTO wearable_data (id, date, metric_type, value, source_device) VALUES (?, ?, 'hrv', ?, 'manual')`
      )
      .run(`g-${d}`, isoDaysAgo(NOW, d), 50);
  }

  // The script: the model calls get_metric_series, then answers using it.
  const toolUse = [
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"get_metric_series","input":{}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"metric\\":\\"hrv\\",\\"days\\":14}"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":40}}',
    '',
    '',
  ].join('\n');

  const answer = (text) =>
    [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1200,"cache_read_input_tokens":5000,"output_tokens":1}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}`,
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":90}}',
      '',
      '',
    ].join('\n');

  const script = [
    toolUse,
    answer('Your HRV has been steady at 50 ms across the last 10 readings.'),
  ];
  let call = 0;
  const fetchImpl = async () => {
    const body = script[Math.min(call++, script.length - 1)];
    return {
      ok: true,
      status: 200,
      text: async () => '',
      body: {
        getReader() {
          let done = false;
          return {
            async read() {
              if (done) return { done: true };
              done = true;
              return { done: false, value: new TextEncoder().encode(body) };
            },
          };
        },
      },
    };
  };

  const toolResults = [];
  const result = await runCoachTurn(
    { apiKey: 'k', model: 'claude-opus-5', fetchImpl },
    {
      system: 'system',
      systemContext: buildTurnContext(db, NOW),
      messages: [{ role: 'user', content: 'How has my HRV been?' }],
      tools: toWireTools(READ_TOOLS),
    },
    {
      onToken: () => {},
      executeTool: async (name, input) => {
        const content = await toolByName(name).execute(db, input, { now: NOW });
        toolResults.push(content);
        return { content };
      },
    }
  );

  result.toolCalls.length === 1 && result.toolCalls[0].name === 'get_metric_series'
    ? ok('the turn ran the tool the script asked for, against the real registry')
    : bad('tool selection', JSON.stringify(result.toolCalls.map((t) => t.name)));
  JSON.parse(toolResults[0]).stats.avg === 50
    ? ok('the tool returned the seeded data (50 ms average)')
    : bad('tool result', toolResults[0]);
  result.stopReason === 'end_turn' ? ok('the turn completed normally') : bad('stop reason');

  // Usage is summed across BOTH round-trips.
  result.usage && result.usage.outputTokens === 130 && result.usage.inputTokens === 1200
    ? ok('usage is accumulated across every round-trip of the turn (40 + 90 output)')
    : bad('usage', JSON.stringify(result.usage));
  result.usage.cacheReadTokens === 5000
    ? ok('cached prefix reads are counted separately (they bill at ~0.1×)')
    : bad('cache usage', JSON.stringify(result.usage));

  // THE ASSERTION THAT MATTERS: every number in the reply traces to a source.
  const report = checkNumberProvenance(result.text, [
    ...toolResults,
    buildTurnContext(db, NOW),
    'How has my HRV been?',
  ]);
  report.unsourced.length === 0
    ? ok(`all ${report.checked} numbers in the reply trace to what the turn actually read`)
    : bad('unsourced numbers', JSON.stringify(report.unsourced));

  // And the same harness CATCHES a fabricating reply.
  const fabricated = checkNumberProvenance('Your ApoB is 78 mg/dL and trending up.', toolResults);
  fabricated.unsourced.length > 0
    ? ok('…and the harness flags a reply that invents a number it never read')
    : bad('harness too lenient');
}

console.log('6. the prompt budget: the fixed payload every request carries');
{
  // Rough tokenisation — ~2.8 chars/token for dense JSON, ~3.6 for prose. Good
  // to ~10%, which is all a budget guard needs. First live testing burned 48k
  // tokens on three trivial questions; the fixed prefix was the whole reason,
  // so it is now a number with a ceiling rather than something that drifts.
  const jsonTok = (s) => Math.round(s.length / 2.8);
  const proseTok = (s) => Math.round(s.length / 3.6);

  const systemTokens = proseTok(buildCoachSystemPrompt({ notificationsLive: false }));
  const allToolTokens = jsonTok(JSON.stringify(toWireTools(COACH_TOOLS)));
  const readToolTokens = jsonTok(JSON.stringify(toWireTools(READ_TOOLS)));

  // The ceilings rose at the 2026-08-10 merge and that was a deliberate trade,
  // not drift. Main's VOICE section (~900 tok) fixes a real owner complaint —
  // the Coach "speaks a bit AIy" — and its wearables doctrine fixes a Coach
  // that was misinformed about the user's own Health data. Both are worth their
  // tokens, and both sit in the CACHED prefix, so past the first request of the
  // hour they bill at 0.1×. What is not acceptable is silent creep: these are
  // still hard ceilings, and the fix when one trips is to delete duplication
  // (a tool description restating a system-prompt rail), not to raise it again.
  //
  // THE TOOL CEILING ROSE ONCE MORE, 2026-08-11 — 8,000 → 9,000 — and this is
  // the accounting, because the rule above says raising it is the wrong reflex:
  //
  //   · The registry went 31 → 39: a whole domain (recipes + grocery) arrived
  //     with 3 read and 5 write tools. Those eight measure **~1,190 tok, ~149
  //     per tool**, against the existing 31's ~250 average — they are the
  //     leanest schemas in the registry, not the reason the budget is tight.
  //   · The 31 pre-existing tools measure **~7,742 tok on their own**, i.e. 97%
  //     of the old 8,000 ceiling before this branch added anything. Any
  //     addition at all would have tripped it.
  //   · The fix WAS applied first, and it worked: every behavioural rail those
  //     eight descriptions carried ("batch the adds", "never present a recipe
  //     the book lacks", the undercount disclosure) now lives once in
  //     TOOL_DOCTRINE instead of eight times here, cutting them from ~1,822 to
  //     ~1,190. The system-prompt ceiling was NOT raised — those bullets were
  //     rewritten to fit under 3,500 instead.
  //
  // Headroom is deliberately ~70 tokens. The next addition trims; it does not
  // raise this a third time. The place to find that trim is the head of the
  // list above (get_metric_series ~600, get_today_snapshot ~476), whose
  // descriptions restate rails the system prompt already states.
  //
  // ⚠️ 2026-08-12 — THE RULE WAS FOLLOWED AND BOTH CEILINGS HELD, BUT THE
  // HEADROOM IS NOW ~1 TOKEN ON THE PROMPT. Four owner-mandated behaviour
  // fixes landed in the doctrine (a decline scopes to one write; pass grocery
  // quantities; prefer add_recipe_to_grocery_list; catch a standing goal
  // dropped in passing) and cost ~92 tok. Neither ceiling moved — the room
  // came from deleting real duplication, which is exactly what this comment
  // asks for, and it is worth recording WHERE so the next person does not go
  // looking in the same places twice: the two state-block bullets said the
  // same rule from both sides and are now one; the "cite the numbers" bullet
  // restated the whole ABSENCE IS NOT ZERO bullet; the logging and
  // past-event bullets were one topic split in two; the WEARABLES
  // parenthetical glossed three snapshot fields the tool's own description
  // already documents; and the pasted-URL bullet folded into Recipes.
  // **There is nothing cheap left.** The next addition either finds a
  // genuinely new duplication or trims the VOICE section, and both ceilings
  // should be treated as full.
  //
  // ── 2026-08-12: BOTH CEILINGS RAISED, 9,000 → 9,250 and 3,500 → 3,700, for
  // the knowledge base (registry 42 → 43, docs/knowledge-subapp.md §6). The
  // rule above says raising is the wrong reflex, so here is the accounting it
  // demands, measured rather than asserted.
  //
  // WHAT IT COST, BEFORE ANY TRIMMING: +365 tok of schema, +308 of prompt. The
  // ceilings were at 8,973 / 3,499 — i.e. 27 and 1 token of headroom, exactly
  // as the ⚠️ above warned. Any addition at all would have tripped both.
  //
  // WHAT WAS TRIMMED FIRST, and it was real duplication, not shaving:
  //   · The new tool's own description, cut from ~143 tok to 66. Its first
  //     draft restated three rails that its system-prompt bullet also carries
  //     (invitation-only, present-the-body-before-calling, the memory/knowledge
  //     line) — the precise eight-descriptions-say-it-eight-times pattern this
  //     comment was written about, caught before it shipped rather than after.
  //   · search_history's description, ~153 → ~110, WHILE fixing it: it said
  //     "ARC's curated longevity reference", which named only the shipped pack
  //     and became false the moment user entries could outrank it.
  //   · The knowledge doctrine was MERGED INTO the Memory bullet rather than
  //     added beside it. The two stores are one distinction, and stating it
  //     once beats stating "what memory is" twice. ~308 → ~185.
  //   · Two genuine prompt duplications, both pre-existing: "never answer from
  //     memory or by guessing" and "NEVER invent a value, a trend, or a lab
  //     result" were the same rule in two bullets (now one, folded into the
  //     state-block bullet with the read-tool bullet it also overlapped); and
  //     WEARABLES' "you can read the whole Apple Health plane, so never say you
  //     don't have it" is what the COVERAGE manifest below now asserts
  //     systematically, for every domain, which is why the manifest was built.
  //   · The "you cannot fetch a pasted URL" rail was recipe-specific and now
  //     applies to two import screens, so it is stated once, generally.
  //
  // NET: 9,206 / 3,641. Trimming recovered 132 tok of schema and 167 of prompt
  // — i.e. it paid for roughly half the feature, which is as much as honest
  // dedup could reach.
  //
  // WHY THE REMAINDER IS A DEFENSIBLE TRADE, in the terms the 2026-08-10 entry
  // set. save_knowledge_entry is 250 tok against a registry mean of 214, and
  // 161 of that is schema (three string properties; the topic vocabulary is
  // data the prompt has no business carrying). It is not a fat tool. And the
  // prompt half buys a rail that has no cheaper form: when the user's own entry
  // and ARC's shipped reference disagree, the Coach must cite both and follow
  // the user's stance. Without it the model silently picks one, and the user
  // cannot tell which — the failure this whole prefix exists to prevent.
  //
  // WHERE THE NEXT TRIM IS, measured so nobody re-derives it: the fat is no
  // longer in descriptions, it is in SCHEMAS. log_workout (277 tok of schema),
  // update_protocol (263), adjust_today (253) and create_experiment (229) carry
  // per-property prose that in several cases restates the tool description
  // above it. That is ~1,000 tok in four tools and it has never been swept.
  // ⚠️ 2026-08-12 (later still) — REPORTS arrived and the trim-first rule held
  // a third time: reports itself moved NO ceiling (the raise above belongs to
  // the knowledge base alone), and its room came out of the coverage manifest
  // itself (src/lib/ai/tools/index.ts). Reports must be an
  // UNCOVERED_DOMAINS entry — a model that denies a shipped feature exists is
  // the exact failure that list prevents (docs/reports-subapp.md §8) — and it
  // cost ~16 tok. Three trims paid for it, each a correction rather than a
  // squeeze:
  //   · the manifest's heading was the only SENTENCE among four label headings
  //     ("Character:", "Using your tools:", "Safety and boundaries:") and said
  //     what the line beneath it already said → "Coverage:" (−29 chars);
  //   · two UNCOVERED entries repeated "(Eat)" for one domain → merged;
  //   · "saved workouts, routines and programs (Train)" was STALE — programs
  //     were retired 2026-08-11 and routines re-branded Saved workouts, so it
  //     named one live thing twice and one dead thing once → "saved workouts".
  // INTEGRATOR NOTE (2026-08-13, the three-way merge): knowledge raised the
  // ceilings to 9,250 / 3,700 and reports' three manifest trims still apply on
  // top — so the merged tree banks reports' recovered tokens as headroom under
  // the raised ceilings, and the assertions below measure the merged truth.
  // The manifest has been mined twice now; the next addition digs in the four
  // fat SCHEMAS named above, not here.
  allToolTokens < 9250
    ? ok(`the ${COACH_TOOLS.length} tool schemas fit the budget (~${allToolTokens} tok)`)
    : bad(
        'tool schemas over budget',
        `${allToolTokens} tok — trim descriptions before adding more`
      );
  systemTokens < 3700
    ? ok(`the static system prompt fits its budget (~${systemTokens} tok)`)
    : bad('system prompt over budget', String(systemTokens));

  // THE TRAP. Prompt-cache minimums differ by model: 512 on Opus 5, 1024 on
  // Sonnet 5, but 4096 on Haiku 4.5 — which is exactly what the unattended
  // coach pass runs on, with the READ tools only. Fall below Haiku's floor and
  // caching silently stops: no error, just cache_creation_input_tokens: 0 and
  // full price on every pass, forever. Trimming tool descriptions moves this
  // number DOWN, so the guard belongs right next to the budget above.
  const HAIKU_CACHE_MINIMUM = 4096;
  const passPrefix = systemTokens + readToolTokens;
  passPrefix > HAIKU_CACHE_MINIMUM
    ? ok(
        `the pass prefix (~${passPrefix} tok) still clears Haiku's ${HAIKU_CACHE_MINIMUM}-token cache floor`
      )
    : bad(
        'pass prefix below Haiku cache minimum — caching will silently stop',
        `${passPrefix} tok < ${HAIKU_CACHE_MINIMUM}`
      );

  // Cheap turns must stay cheap: the cost model has to price a cached read far
  // below a cold write, or none of the above is worth doing.
  const warm = estimateCost(
    { inputTokens: 200, outputTokens: 300, cacheReadTokens: 8900, cacheWriteTokens: 0 },
    'claude-sonnet-5'
  );
  const cold = estimateCost(
    { inputTokens: 200, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 8900 },
    'claude-sonnet-5'
  );
  cold > warm * 4
    ? ok(`a cold turn costs ${(cold / warm).toFixed(1)}× a warm one — why the cache TTL is 1h`)
    : bad('cache economics wrong', `${cold} vs ${warm}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
