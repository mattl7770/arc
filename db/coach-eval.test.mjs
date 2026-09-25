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
import {
  toolByName,
  COACH_TOOLS,
  PASS_READ_TOOLS,
  READ_TOOLS,
  toWireTools,
} from '../src/lib/ai/tools/index.ts';
import { buildCoachSystemPrompt } from '../src/lib/ai/system-prompt.ts';
import {
  FOOD_ENTRY_SYSTEM_PROMPT,
  MEAL_ESTIMATION_SYSTEM_PROMPT,
} from '../src/lib/nutrition/estimate.ts';

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
  // A turn that costs a real fraction of a cent must not round to "$0.000":
  // 10 in + 5 out on Haiku is ~$0.00004, which toFixed(3) would show as exactly
  // zero — presenting a nonzero cost as free, the one thing this module avoids.
  // Below the three-decimal floor it says "<$0.001"; the 0.0005–0.01 band still
  // shows three decimals (0.004 vs 0.009 is the whole optimisation).
  usageCaption(
    { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    'claude-haiku-4-5',
    0
  ) === '10 in · 5 out · ~<$0.001'
    ? ok('a sub-milli-cent turn floors to "<$0.001", never "$0.000"')
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
  //
  // ── 2026-08-14: COACH FIDELITY. NEITHER CEILING MOVED, and the tool schemas
  // were not touched at all (9,206, unchanged). Two owner reports needed two
  // prompt rules and both were paid for out of duplication, per the rule above.
  //
  // ADDED (~+82 tok): never report a change as done before its tool result
  // arrives, because no tool call means nothing happened (report 7, the phantom
  // write); and, since earlier turns are now day-stamped, drop a suggestion
  // already raised on a previous day and treat an old event as history
  // (report 8, the stale grocery suggestion).
  //
  // PAID FOR BY (~-123 tok), and all four are corrections rather than shaving:
  //   · The decline bullet's "a decline is about that write, not their message
  //     — refused one of two asks, do the other" is stated MORE fully, and at
  //     the exact moment it applies, by the decline tool result itself
  //     (coach-service.ts). The static copy was the weaker of the two.
  //   · The state-block bullet re-listed every label the block carries — while
  //     the block says of itself that it is "labelled line by line". It was
  //     also ALREADY STALE: it never listed the grocery line, which shipped
  //     later. A hand-maintained index of a self-labelling block can only rot.
  //   · Reminders' "an OS notification needs a capable build, a granted
  //     permission and a moment still ahead" enumerates precisely the reason
  //     codes the `notification` result field returns, which the very next
  //     clause tells the model to relay.
  //   · Grocery's "read get_grocery_list first when unsure" predates the state
  //     block naming every open item; it now points at the cheaper source.
  //
  // NET 3,696 → 3,655, i.e. the branch RETURNED 41 tokens of headroom rather
  // than spending it. The next addition still digs in the four fat SCHEMAS
  // named above: the prompt is now genuinely swept.
  //
  // ── 2026-08-25: PROTOCOLS v2. NEITHER CEILING MOVED. The system prompt was
  // not touched at all (3,655, unchanged). This is the first addition to dig in
  // the four fat SCHEMAS the note above named, and the digging paid for most of
  // the feature.
  //
  // WHAT IT COST, BEFORE ANY TRIMMING: +95 tok of schema (9,206 → 9,301), which
  // tripped the 9,250 ceiling. `update_protocol` grew from a flat `items` array
  // to ordered `phases` of items, each item carrying a `cadence` — content
  // schema 2 (src/lib/protocols/types.ts). Two design choices held that number
  // down before any trim was needed:
  //   · **cadence is a compact STRING**, not a four-branch object union —
  //     `daily | mon,wed,fri | every 3 days | 3/week` — parsed at the tool
  //     boundary by `parseCadenceText`. The union would have cost several times
  //     as much for exactly the same expressiveness, and a model writes the
  //     phrase more reliably than it fills in a discriminated object.
  //   · **`apply_today` is GONE** (−~40 tok, and one fewer decision for the
  //     model to get wrong): a protocol edit now always reaches today, so the
  //     flag had one legal value.
  //   · get_protocols carries phases, cadence and the LIVE phase in its OUTPUT,
  //     which costs nothing against this budget at all.
  //
  // PAID FOR BY (−82 tok), every one a duplication rather than a shave:
  //   · create_experiment.metrics said "Prefer names get_metric_series can read
  //     back, so the readout has numbers; anything else is watched
  //     qualitatively." The tool's own RESULT already warns, by name, about any
  //     metric that cannot be read — the same information delivered only where
  //     it matters. Cut to the first clause.
  //   · create_experiment.intervention said "The single change, e.g. …" while
  //     the tool description's own second clause is "the ONE intervention being
  //     changed". The example survives; the restatement does not.
  //   · adjust_today's "The whole batch is ONE confirmation, so send it as one
  //     call" restates its first clause, "in one batch"; and its `id` property
  //     said "Item id" under a description that already says "by their id from
  //     get_today_snapshot".
  //   · log_workout's weight note spelled out a parenthetical the sentence did
  //     not need.
  //   · update_protocol's own description listed "(stack, routine, training
  //     block)", which get_protocols lists one tool away.
  //
  // NET 9,206 → 9,219: **+13 tok for phases, cadence, and a tool that no longer
  // asks the model which day an edit lands on.** 31 tokens of headroom remain.
  // The next addition digs in the same place — log_workout (349), adjust_today
  // (~340) and get_metric_series (354) are now the three fattest, and
  // update_protocol at 424 is fat for a reason it can defend.
  //
  // ── 2026-08-26: KNOWLEDGE SECTIONS. NEITHER CEILING MOVED, and the trimming
  // paid for the whole feature on the tool side and more than it on the prompt
  // side. The knowledge base gained two sections (`scientific` / `personal`,
  // migration 0044, docs/knowledge-subapp.md §2b), so save_knowledge_entry
  // gained a REQUIRED `section` enum.
  //
  // SCHEMA — WHAT IT COST BEFORE TRIMMING: +53 tok (9,219 → 9,272, over the
  // 9,250 ceiling). Three parts, measured: the property itself ~21, `"section"`
  // in `required` ~5, and +27 on the tool's own description, which had to widen
  // because "reference — how something works" was the definition of ONE of the
  // two sections and became false for the other.
  //
  // Two design choices held that down before any trim was needed:
  //   · the property carries NO per-property description. The two enum values
  //     are defined once, in the tool description; a second copy under
  //     `section.description` is the eight-descriptions-say-it-eight-times
  //     duplication this comment was written about, and it would have cost ~26.
  //   · `section` is REQUIRED rather than defaulted. That is a correctness call,
  //     not a budget one (a model that omits it has usually just been told
  //     something about the USER, and defaulting to `scientific` files a fact
  //     about his knee in with the articles) — but it is also the cheap shape:
  //     a default would need a sentence explaining when it applies.
  //
  // PAID FOR BY (−49 tok), and both are the same nameable duplication class —
  // A DESCRIPTION RECITING ITS OWN SCHEMA, which is the first time that class
  // has been swept here:
  //   · log_workout, 56 → 28. "name, kind (strength/cardio/mobility/other),
  //     duration in minutes, and optional strength sets" listed four properties
  //     the schema declares one line below, and inlined `kind`'s enum verbatim
  //     beside the enum itself.
  //   · log_meal, 65 → 44. "(kcal, protein_g, carbs_g, fat_g) and wall-clock
  //     time" recited four property names plus `time`, which carries its own
  //     format description.
  //
  // NET 9,219 → 9,223: **+4 tok for a required two-value enum on a write tool.**
  // 27 tokens of headroom remain. Note that this is the SCHEMA fat the entry
  // above pointed at, approached from the description side; the four fat
  // SCHEMAS (update_protocol 424, log_workout, adjust_today, get_metric_series)
  // are still unswept and are still where the next addition digs.
  //
  // PROMPT — WHAT IT COST BEFORE TRIMMING: +57 tok (3,655 → 3,712, over the
  // 3,700 ceiling). The Memory-and-knowledge bullet had to carry the third leg
  // of the distinction: the split between a memory and a personal entry is
  // LENGTH, not subject, and search_history now labels hits three ways ("your
  // record" / "your knowledge" / "ARC reference") instead of two. Neither has a
  // cheaper form — without the length rule the model has two tools for one
  // sentence and picks arbitrarily; without the labels it cannot tell the user's
  // own account of himself from an article he imported.
  //
  // PAID FOR BY (−44 tok), all three the fact-then-restatement pattern the
  // 2026-08-12 entry established as the right thing to delete:
  //   · the bullet's opener, "Memory and knowledge are two stores with one line
  //     between them", was a topic SENTENCE saying what the bullet then says
  //     precisely — and every other bullet in this section opens with a topic
  //     LABEL ("Reminders:", "Modes:", "Grocery:", "Recipes:"). Now it does too.
  //   · the standing-goal rail said the same thing twice, abstract then
  //     concrete: "is the easiest to miss and the most worth keeping" and "it
  //     arrives as an aside about one meal and governs months". The concrete
  //     half survives; it is the one that teaches.
  //   · "this week" carried the rule from both sides — "rolling windows are NOT
  //     the same thing" AND "never report a trailing-N-day number as this week".
  //     One prohibition now, which is the half that instructs.
  //
  // NET 3,655 → 3,668: **+13 tok**, and 32 tokens of headroom, up from 45 →
  // 12-over → 32. The prompt was declared "genuinely swept" on 2026-08-14; it
  // was not quite, and these three are the last of that pattern. The next
  // addition trims the VOICE section or the schemas, because there is no fourth
  // fact-then-restatement left in here.
  //
  // ── 2026-09-14: `ml` AS A UNIT (0047, backlog B2). MEASURED DELTA: **0 / 0**.
  // Neither ceiling moved and neither number moved: 9,223 / 3,668, the same
  // figures the entry above recorded. Nothing was trimmed because nothing was
  // spent — and the reason is a fact about this registry worth writing down
  // rather than re-deriving:
  //
  //   **No Coach tool carries a food portion.** `log_meal` writes a free-form
  //   meal (name, time, optional macro totals) and `meals` has no amount column
  //   for a unit to qualify; `log_recipe`'s `grams` is a cooked DISH weight
  //   against `total_weight_g`, and 0047 deliberately left `recipe_ingredients`
  //   in grams; `save_recipe`'s ingredient `unit` is free text read off the
  //   written line, normalisation-only and never a conversion. A `unit`
  //   property added to any of them would describe a number that does not
  //   exist, which is the one thing worse than an expensive property.
  //
  // What the unit had to survive instead is the READ path, and it does so for
  // free: `meal_items.kcal` and the macro columns are absolute amounts for the
  // portion, not per-basis, so a day's totals sum across g and ml by
  // construction. db/coach-tools.test.mjs §37 asserts that end to end against
  // the real tools — a 250 ml drink and a 50 g bowl summing to one day.
  //
  // Headroom is therefore unchanged: 27 tokens of schema, 32 of prompt. The
  // next addition still digs in the four fat SCHEMAS named above.

  // ── 2026-09-14: B1, EXERCISE METRIC TYPES. NEITHER CEILING MOVED, and the
  // schema addition was paid for out of the same schema — which is where the
  // 2026-08-26 entry said the next dig would be.
  //
  // COST (+31 tok). `log_workout`'s set item gained `duration_s` and
  // `distance_m` (migration 0046: an exercise declares what it measures, and a
  // run is time + distance while a plank is time). Both are bare
  // `{type, minimum}` with NO description, because the property NAMES carry the
  // units — the cheapest form a numeric property has. Neither takes a `unit`
  // sibling the way `weight` does: "five miles" is a conversion the model does
  // once at no schema cost, where an lb/kg reading is one the OWNER has to be
  // able to check on the card.
  //
  // PAID FOR BY (−30 tok): `name`, deleted from the same tool — a REQUIRED
  // property with an example ("Upper A", "Zone 2 ride") asking the model to
  // invent a string for `workouts.name`, a column the owner retired on
  // 2026-08-14 (*"Workouts dont need names, remove this"*) and that nothing has
  // rendered since. The session list titles itself off its movements, the
  // logger has no name field, and the repository already defaults the column to
  // ''. The confirmation card quoted the invented name back — the single place
  // it was ever visible, and a label the owner would never see again after
  // approving it. This is not the fact-then-restatement pattern; it is a newer
  // and worse one, a schema still asking for a fact the APP no longer has.
  //
  // NET 9,223 → 9,224: **+1 tok**, 26 of headroom. Where the next addition
  // digs: `update_protocol` (424) is still the largest schema and still
  // unswept, then `get_metric_series` (354) and `adjust_today` (348). The
  // training READ tools gained per-session `setSeconds` / `setMetres` at zero
  // schema cost — result fields are not in this budget, which is the argument
  // for putting new information in the payload rather than in the description.

  // ── 2026-09-14: C14, COACH MEMORY → KNOWLEDGE BASE. NEITHER CEILING MOVED,
  // and the tool side came out BELOW where it started. The owner's requirement
  // was read AND write on both stores; the entry half was write-once, so
  // save_knowledge_entry gained an optional `id` (present = rewrite the whole
  // entry) and retire_knowledge_entry was added as the 44th tool.
  //
  // SCHEMA — WHAT IT COST: +148 tok. retire_knowledge_entry is 119 of that
  // (desc 59, schema 36) and save_knowledge_entry's `id` is 29 (the property ~10
  // plus ~19 on the tool description's new last clause). Two design choices held
  // it down before any trim:
  //   · `id` carries NO per-property description. Where ids come from is the
  //     same answer for every id-taking tool in the registry, and the tool
  //     description's own clause says what passing it does.
  //   · retiring is its OWN tool rather than a `retire: true` flag on the save.
  //     That reads like the expensive choice and is not: a flag would have made
  //     title/topic/body/section optional (they cannot be required for a call
  //     that only archives), which costs the correctness rail that stops a
  //     CREATE arriving with no body — and a conditional-requirement sentence
  //     explaining when each applies would have cost more than the 36-token
  //     `{id}` schema it was trying to avoid.
  //
  // PAID FOR BY (−153 tok), four trims, three of them the same nameable class —
  // A DESCRIPTION RECITING ITS OWN SCHEMA — and one the 2026-08-11 class, A
  // DESCRIPTION RESTATING WHAT THE PAYLOAD SAYS AT RUNTIME:
  //   · get_screenings, 239 → 193 (−46). "An empty ledger means the user has
  //     tracked none — ARC does track them (Data › Screenings); never report the
  //     feature as missing" is emitted BY `execute`, in those words, as
  //     `emptyNote`, in the one case where it is true. Billing it on every
  //     request about screenings the user does track is the get_metric_series
  //     trim again.
  //   · get_metric_series.metric, −45 (309 total after). Its description said "A
  //     body metric or a wearable metric_type; …availableMetrics lists this
  //     device's set." The first clause is the tool description's own first
  //     clause, less specific (that one NAMES the three body metrics); the
  //     second offers a discovery path the tool description already beats, since
  //     "an unknown name errors WITH the valid set" costs no extra round trip.
  //   · remember, 194 → 167 (−27). "a preference, a constraint or adverse
  //     reaction (…), stable context, or a goal" spelled out the four values of
  //     the `category` enum three lines below it. The parenthetical EXAMPLE
  //     survives — it shows the shape and the LENGTH, which no enum can.
  //   · forget, 175 → 153 (−22), and this one had to go regardless: "the user
  //     can still see it in Settings" became FALSE when memory moved to the
  //     Knowledge hub, in the one sentence the model would repeat to the user.
  //   · log_screening_done.id, −13. Its description was "From get_screenings."
  //     under a tool description reading "Get the id from get_screenings." The
  //     purest example of the class in the registry.
  //
  // NET 9,223 → 9,218: **−5 tok for a 44th tool and a new capability.** 32
  // tokens of headroom, up from 27. The prompt side moved +1 (3,668 → 3,669):
  // one UNCOVERED_DOMAINS line had to be NARROWED because the feature made it
  // false — "editing or deleting anything already logged, incl. your own writes
  // and knowledge entries" now names only what is still true. A false line in
  // that list is worse than a long one, and the swap was near-free.
  //
  // WHAT WAS NOT DONE, on purpose: search_knowledge stayed unregistered. It is
  // the tool that names the knowledge base, so registering it looks like the
  // direct answer to "the Coach needs read access" — but the embedder is still
  // a hardcoded null, so every call returns `available: false`, and it would
  // have spent ~180 tok advertising a dead end. Read access on both stores is
  // search_history, which reads them by keyword today with no model, and which
  // C14 gave the row ids so a read can lead to a write. Pinned in
  // db/coach-memory.test.mjs §7, against `embedderStatus()` rather than against
  // a comment.
  //
  // The next addition still digs where the 2026-08-26 entry pointed:
  // update_protocol (424), log_workout (321) and adjust_today (348) are the
  // three fattest schemas and none of them has been swept.

  // ── 2026-09-14: C13, THE AWAY-GYM BIT. NEITHER CEILING MOVED, and the
  // addition was paid for out of the training tools themselves.
  //
  // COST (+36 tok). `get_training_summary`'s description gained one sentence:
  // "`away: true` means a different gym — those loads are not comparable, so
  // never call them a regression." This sentence IS the feature on the Coach's
  // side (migration 0055). Everything else about the away flag is arithmetic
  // the app does — no PR, no progression input, no prefill — but the Coach
  // needs no arithmetic at all, only to stop reading a travel week's lighter
  // loads as a decline and saying so, which is the owner's actual complaint.
  // The per-session `away: true` on `recentSessions` costs this budget NOTHING:
  // it is payload, and it is omitted on home sessions rather than nulled, so
  // ten ordinary rows carry no "no".
  //
  // PAID FOR BY (−21 tok), both fact-then-restatement, both in the training
  // tools that grew:
  //
  //   • `get_training_recommendation` claimed "program week (and whether it is
  //     a deload)" — a `recommendation.program` field that CANNOT appear.
  //     Programs were retired 2026-08-11, the recommender's schedule branch was
  //     deleted, and `buildRecommendation` contains no mention of one. This is
  //     the `log_workout.name` class exactly: a description still promising a
  //     fact the app no longer has, and worse than merely expensive — a model
  //     told to expect a field that never arrives reads its absence as a
  //     statement about the user's programming. (−16)
  //   • `get_training_summary`'s own "(default 28)", which the `days` property
  //     one line below states verbatim as "Window, default 28.". (−5)
  //
  // NET 9,224 → 9,241: **+17 tok**, 9 of headroom. Thinner than it has been,
  // and the honest reading is that the cheap trims in the training tools are
  // now spent. Where the next addition digs, unchanged: `update_protocol` (424)
  // is still the largest schema and still unswept, then `get_metric_series`
  // (354) — whose `metric` property opens "A body metric or a wearable
  // metric_type", restating its own description's "Takes body metrics … and any
  // wearable metric_type" — and `adjust_today` (348).
  // ── 2026-09-19: THE PROTOCOL INTERFACE RETHINK, §8.1 and §8.3. **NEITHER
  // CEILING MOVED, because neither change is a schema.**
  //
  // Two defects, both fixed entirely in `get_protocols`' OUTPUT:
  //
  //   • the destructive one. `update_protocol` is a complete replacement and
  //     takes each item's `notes` from the call or writes null — and this tool
  //     did not emit `notes`, so every Coach edit re-sent every item without a
  //     field the model had never seen and ERASED every rationale line in the
  //     protocol. Those lines are the `why` the generator stamps on each
  //     mission row and the italic line Home's hero prints. Emitting the field
  //     is the whole fix; the complete-set sentence in the system prompt then
  //     becomes true for it, and a deliberate rewording becomes possible.
  //   • the blind one. `carryOver`, `checkoffMode` and `startedOn` say what a
  //     protocol's plan MEANS, and the model was answering about all three
  //     without them.
  //
  // COST TO THESE BUDGETS: **0.** Output is not schema. The payload cost is
  // real and is counted where it lands — on a device with six protocols of five
  // items, `notes` is ~30 × 14 ≈ 420 tok on a turn that calls the tool, and the
  // three protocol fields ~24 each when non-default. Each is OMITTED at its
  // default (the C13 `away: true` rule), so a device running the defaults
  // carries no "no". `notes` is the fix for a data-destroying bug and is worth
  // it outright.
  //
  // NOT ADDED, on purpose: a per-item `nextOn`. ~9 tok × every item × every
  // call for a figure the model can derive from the cadence, `startedOn` and
  // `checkoffMode` — which it now has. Judgment stays in the model.
  //
  // ONE CORRECTION TO THE LEDGER ABOVE, measured rather than assumed: the C13
  // entry records 9,241 and "9 of headroom". The live figure on `main` is
  // **9,236**, so the true headroom is 14. The rethink's plan inherited the
  // 9,241 number from this comment; anything budgeting against it should
  // re-measure here first.
  //
  // ── 2026-09-19: §8.2, THE COACH CAN CREATE A PROTOCOL. **+1 tok.**
  //
  // The hub's empty state has sent the owner to the Coach to "draft one" since
  // it shipped, and NO TOOL COULD WRITE THE RESULT — the Coach drafted in prose
  // and the path ended there. `update_protocol` now creates when
  // `protocol_slug` is ABSENT and `name` + `type` are present. The absence is
  // the signal deliberately: a call that names a slug is always an update, so a
  // typo still errors with "call get_protocols first" and can never silently
  // mint a second protocol beside the one the user meant.
  //
  // COST (+28 tok):
  //   • `protocol_slug` leaves `required`, which shrinks it (−6);
  //   • `name` and `type` as **bare strings** (+9 each). The seven-value `type`
  //     ENUM measures **52** on its own — it was the whole cost the first
  //     estimate missed — and a bare string plus an error that NAMES the set is
  //     the registry's own pattern, so the model recovers on the next turn
  //     either way;
  //   • the tool description gains ` No slug + "name" + "type" creates one.`
  //     (+15).
  //
  // PAID FOR BY (−27 tok), both fact-then-restatement, the trim rule at :393:
  //   • `protocol_slug`'s `"From get_protocols."` (−13). The tool description
  //     one line above already says "by its slug from get_protocols";
  //   • `phases`' `"Ordered; usually one."` (−14). Its own children say it —
  //     `"Omit if single-phase."` and `"Required except on the LAST phase"`.
  //
  // NET **9,236 → 9,237**, and the tool itself **424 → 425**. 13 of headroom.
  // A separate `create_protocol` was the alternative and is not affordable:
  // ~150 tok of schema for a body that is this one's minus a lookup.
  //
  // §8.1 and §8.3 above moved NOTHING, and this round's trims are inside a
  // WRITE tool, so `readToolTokens` — and therefore the Haiku pass prefix — is
  // untouched at 7,053. All four assertions below hold on the same run.
  //
  // ── 2026-09-19: THE MISSION DAY PICKER AND THE FUTURE CHECK-OFF, §3.10.
  // **NEITHER CEILING MOVES, AND NEITHER NUMBER MOVES: 9,237 / 3,669.**
  //
  // The Coach gains VISIBILITY of a day the user planned ahead, and visibility
  // is payload. `get_today_snapshot` emits `doneOn` on a mission row whose
  // completion was recorded on a different day — omitted on every ordinary
  // tick, so the usual day carries no field at all — and an `ahead` array of
  // `{day, title, protocol}` for every completed row on a day after today,
  // omitted when empty, which is every database that has never used the Plan
  // screen. Neither is a schema: no description sentence, no `inputSchema`
  // property, nothing in the cached prefix these two ceilings guard.
  //
  // What was NOT done, and why: `adjust_today` does not learn a `date`. That is
  // ~13 tokens of headroom against a property plus the rewrite of its "Today
  // only" sentence, and acting on a day ahead rides the parked whole-app-access
  // item (docs/spikes/coach-whole-app-access.md) where the `update_protocol`
  // sweep — still the largest schema at 425, still unswept — pays for it.
  //
  // No rule is attached about whether ticking ahead is good practice. That is
  // judgment, and judgment lives in the model (memory: coach-judgment-not-rules).

  // ── 2026-09-19: THE MODES REVAMP (migration 0061). **NEITHER CEILING MOVED,
  // and BOTH sides came out AHEAD of where they started.**
  //
  // Measured on main before the change: **9,237 schema / 3,669 prompt** (13 and
  // 31 of headroom). The comment above quoting 9,241 was stale — the protocol
  // interface rethink corrected it to 9,237 and this entry re-measures rather
  // than trusting either number.
  //
  // SCHEMA, −4 NET (9,237 → 9,233, 17 of headroom):
  //
  //   · `set_mode` DELETED, −285. Six enum keys, each of which stood for a
  //     table of hardcoded consequences.
  //   · `set_status` ADDED, +282 — and it is NOT the 236 the spike predicted,
  //     because the owner diverged on Q2: excusal is decided per status through
  //     an `excuses` flag, which is a schema property the recommendation did
  //     not have (~30 tok including the clause that makes an OMITTED flag mean
  //     "leave it" rather than "default true" — the whole point of it).
  //   · PAID FOR by deleting a restatement inside the new tool, which is what
  //     the rule above asks for: `label`'s description said `"normal" ends all
  //     open ones.` under a tool description reading `"normal" ends every open
  //     status.` — the `protocol_slug` class exactly. (−11)
  //
  // PROMPT, +23 NET (3,669 → 3,692, 8 of headroom):
  //
  //   · the Modes bullet −127, the Status bullet +145. The new bullet is the
  //     feature: there is no switch any more, so the model IS how the day
  //     adapts, and it has to be told the three moves (adjust_today for today,
  //     update_protocol for anything longer, set_status to record the fact) and
  //     the one carve-out that keeps a deload out of the status system.
  //   · the `excuses: false` clause inside it, +14, is the owner's Q2(b)
  //     reaching the model at all. Without it the flag exists and nothing ever
  //     sets it to false.
  //   · "what mode am I in?" → "what's my status?", −1.
  //   · the `day modes` domain label → `your status`, 0 (it feeds the cached
  //     coverage manifest, and +2 characters rounds to nothing).
  //   · TRIMMED, and this is the spike's own named fallback rather than an
  //     improvisation: the bullet opened with four examples ("sick",
  //     "traveling", "jet-lagged", "work crunch") and now carries two. The
  //     first measurement landed at exactly 3,700 — over, by one — and the
  //     spike said where to cut if it did. (−8)
  //
  // The Haiku pass prefix moved 7,053 → 7,076: `set_status` is a WRITE tool and
  // does not ride it, so the whole change is the prompt's +23. Still 2,980
  // clear of Haiku's 4,096 cache floor.
  //
  // Where the next addition digs is unchanged: `update_protocol` (425),
  // `get_metric_series` (354), `adjust_today` (348). 8 tokens of prompt
  // headroom is the thinnest this has been, and the honest reading is that the
  // prompt is FULL: the next bullet pays for itself or does not land.
  // ── 2026-09-19: WHOLE-APP ACCESS, COMMIT A — THE FOLD.
  // **BOTH CEILINGS HELD AND BOTH SIDES CAME OUT AHEAD: 9,233 → 8,479 schema,
  // 3,692 → 3,691 prompt.** Measured on `main` first, with these same proxies
  // over the live registry, rather than inherited from the entry above.
  //
  // WHY THIS IS THE SHAPE IT IS. docs/spikes/coach-whole-app-access.md asked
  // for whole-app read/write access for the Coach, and a bespoke tool per gap
  // was priced at ~14,000 tokens — more than the entire existing toolbox. The
  // answer is a DOMAIN REGISTRY (src/lib/ai/domains/) behind generic tools,
  // which costs one schema instead of sixty-eight.
  //
  // SCHEMA, −754 NET:
  //   · SIX status-change tools DELETED, −970: complete_reminder (144),
  //     dismiss_reminder (115), complete_experiment (221), abandon_experiment
  //     (218), forget (153), retire_knowledge_entry (119). Every one of them
  //     executed a single `UPDATE … SET status`.
  //   · `edit_record` ADDED, +216 over a four-key enum. It carries the
  //     vocabulary the six descriptions carried, once.
  //   · `get_experiments`' description −8: "complete_experiment needs the id"
  //     named a tool that no longer exists, and "closing one (you need the id)"
  //     says the same thing without it. This is why `readToolTokens` moved at
  //     all — the Haiku pass prefix is 7,076 → 7,067, still 2,971 clear of the
  //     4,096 cache floor. (It moves again in commit B, DOWNWARD, when the
  //     prompt shrinks; the pass's read SET does not move after this.)
  //
  // PROMPT, −1 NET, and this is the part that had to be earned. Main had **8
  // tokens of headroom** and the spike's doctrine bullet was priced at +27, so
  // it did not fit. It was paid for out of three restatements, which is what
  // the rule at :393 asks for rather than a fourth raise:
  //   · the INVITATION-ONLY rule was stated TWICE — once as "not to tidy their
  //     list unasked" on the adjust_today bullet and once as "ONLY on their
  //     request or clear invitation, never to file away your own output" inside
  //     the Memory bullet. It is now ONE bullet governing adjust_today,
  //     save_knowledge_entry and edit_record, which is strictly more coverage
  //     for fewer characters.
  //   · the knowledge split carried THREE examples for a distinction with two
  //     sides. "Magnesium forms differ in absorption…" illustrates `scientific`,
  //     which the clause two sentences above it defines — and the split being
  //     illustrated is LENGTH (a memory vs a personal entry), which that example
  //     is not about. The status build's precedent: four examples → two, −8.
  //   · "adds today's mission items" — `adjust_today`'s own description says
  //     "Today only", the `protocol_slug` class.
  //
  // WHAT WAS **NOT** DONE: the VOICE section was not touched. The spike names
  // it as the reserve of last resort and it was not needed. No ceiling moved,
  // which also means the revert arithmetic holds: putting the six tools back
  // returns the registry to 9,233 exactly.
  //
  // COMMIT A IS PROMPT-NEGATIVE BY ONE TOKEN, which matters more than it
  // sounds: B (query_records) cannot land before A, because query_records is
  // built on the registry A introduces, so A's own moment is the tightest one
  // this branch ever has. It is 3,691 — better than main's 3,692.
  // ── 2026-09-19: WHOLE-APP ACCESS, COMMIT B — `query_records`.
  // **9,233 → 8,750 schema and 3,692 → 3,651 prompt, measured against MAIN.**
  // Both sides are still ahead of where the branch started, on a branch whose
  // whole purpose is to ADD capability.
  //
  // SCHEMA, +271 on top of commit A's −754:
  //   · `query_records` over a FIFTEEN-key enum. The description does NOT name
  //     the fifteen: the enum is already on the wire, and naming them twice is
  //     the description-recites-its-own-schema class this comment exists about
  //     (~75 tok saved against the first draft). What it carries instead is
  //     what an enum cannot — the filters, the 10/25 cap, and the DISCOVERY
  //     call.
  //   · Field vocabularies cost **0**. A no-filter call returns each domain's
  //     `fields`, so discovery is one warm round trip on the turn it is needed
  //     rather than 26 domains × ~25 tokens in a cached prefix forever. That
  //     was the alternative, and it is ~650 tokens against 8 of headroom.
  //
  // PROMPT, −40, and every token of it is a coverage line that became FALSE —
  // the only reason a line may leave that list (src/lib/ai/tools/index.ts):
  //   · "the food catalog, per-item micronutrients and saved meal templates
  //     (Eat)" — three domains now.
  //   · "saved workouts (Train)".
  //   · "progress photos and their AI readings" and "generated reports and
  //     doctor packs" — the owner reopened both (Q4a). The 2026-08-12 photo
  //     call was a PREFIX-COST argument against a bespoke tool, and a registry
  //     key costs ~3 tokens; the reports entry said "revisit if transcripts
  //     show the user asking about past reports", and the direction is wider.
  //     READ-ONLY, no pixels, no writes.
  //   · the lab line NARROWED to the PDF and the files: the report LIST reads.
  //   · one label ADDED (+12), "the rest of the app, domain by domain
  //     (query_records)" — ONE entry for fifteen domains, because the keys are
  //     already in the enum.
  //
  // THE HAIKU PASS'S READ SET IS UNCHANGED, and that is deliberate rather than
  // incidental: `query_records` is excluded from it (PASS_EXCLUDED_TOOLS), so
  // the pass still carries exactly the eighteen tools it always did — 3,376
  // tokens. Its PREFIX is that plus the system prompt, so it moves with the
  // prompt alone: 7,067 → 7,027, downward.
  // Haiku's selection over a fifteen-key enum is unmeasured, a discovery call
  // would spend one of the pass's eight round trips AND re-bill the ~1.4k
  // uncached state block, and the pass is triage over curated reads. The
  // assertion below now bills the pass's OWN tool set, not every read tool.
  // ── 2026-09-19: WHOLE-APP ACCESS, COMMIT C — THE WRITES (Phase 2).
  // **9,067 schema and 3,652 prompt**, against main's 9,233 / 3,692. The branch
  // ends with MORE headroom on both ceilings than it started with, having added
  // twenty-six writable/readable domains, and NO CEILING WAS RAISED.
  //
  // SCHEMA, +317 on commit B's 8,750:
  //   · `edit_record`'s enum 4 → 18 keys, and its description gains the fourth
  //     status vocabulary plus one sentence sending the model to
  //     `query_records` for every other domain's fields. The per-domain FIELD
  //     names are still not here: 26 domains × ~25 tok is ~650 of cached prefix
  //     for something a warm no-filter call returns.
  //   · `delete_record` ADDED over an ELEVEN-key enum — the removable set, not
  //     the editable one. A record of a day is absent from that enum entirely,
  //     so the schema refuses it at zero round trips, which is cheaper than any
  //     sentence explaining the rule would be.
  //
  // PROMPT, +1 on commit B's 3,651, and it buys a whole tool:
  //   · the doctrine bullet gains `delete_record` and one clause — "a record of
  //     a day is corrected, never removed" (+~30).
  //   · PAID FOR by three coverage lines that became FALSE: appointments (a
  //     registry domain now), "creating a protocol or a screening from scratch"
  //     (already half-false since §8.2 gave `update_protocol` a create arm),
  //     and the logged-history line, REWRITTEN to what the owner's Q2(b) answer
  //     leaves true — a logged metric and a capture, which have no repository
  //     edit path and therefore no screen path either. The Settings line
  //     narrowed to the security boundary (Q3a).
  //
  // THE HAIKU PASS'S READ SET IS STILL 3,376 — untouched by three commits,
  // because `query_records` never joined it and no write ever could. Its prefix
  // is 7,028, down from main's 7,076, entirely because the prompt shrank.
  // ── 2026-09-23: DELETION BY PARITY (the owner reversed Q2(b)'s undo-only
  // half — docs/decisions.md). **9,067 → 9,039 schema, 3,652 → 3,648 prompt**,
  // re-measured on main with these same proxies before anything changed. BOTH
  // SIDES CAME OUT AHEAD while the Coach gained deletion of every row a screen
  // can delete, a whole protocol included.
  //
  // SCHEMA, −28 (`delete_record` 207 → 179):
  //   · the enum 11 → 12 keys: `protocols` joins it, +4. It refused until now
  //     on the ground that the screen "shows what it would take with it", and
  //     the card now shows it.
  //   · the description −32. It carried the RULE — "ONLY as an undo of
  //     something you wrote in THIS conversation. Everything else is corrected
  //     on its own screen." — and a rule about WHEN is exactly what the owner
  //     removed. What is left says what the tool DOES: the screen's delete,
  //     a card naming the date and figures, no undo.
  //
  // PROMPT, −4:
  //   · the doctrine clause "delete_record is for an object the user is
  //     finished with, or to UNDO a row you logged this conversation; a record
  //     of a day is corrected, never removed" became "delete_record removes ONE
  //     row for good, as its own screen would. Nothing brings it back, so be
  //     sure it is the row they mean." — the fact that makes judgment matter
  //     in place of the rule that replaced it. −7.
  //   · the CANNOT line gained "or deleting", +3: a logged metric or a capture
  //     has no screen edit AND no screen delete, and once deletion follows the
  //     screens the model must not infer that a row it cannot correct is one
  //     it may still remove.
  //
  // The Haiku pass prefix moves with the prompt alone, 7,028 → 7,024 — the
  // pass carries no write. Every per-domain card line (`RemovePolicy.gone`)
  // is TypeScript and costs 0 on the wire.
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
  // ── 2026-09-14: C2's FOOD-ENTRY PROMPT (src/lib/nutrition/estimate.ts).
  //
  // A third prompt now leaves this app, and it is measured here because this is
  // where prompts are measured — but it is NOT in the budgets above and must not
  // be added to them. The two ceilings guard the **Coach's cached prefix**, the
  // payload every chat turn carries; the nutrition prompts ride one-shot
  // requests with no tools, no history and no cache, so they cost what they say
  // once and nothing afterwards.
  //
  // Why it is its own prompt rather than a branch in the meal estimator's:
  // a MEAL is a list of portions eaten now, priced per portion, with per-item
  // confidence; a catalog ENTRY is one food priced PER 100 of its basis and kept
  // for life. They share a model and nothing else, and every word one does not
  // need is a word the other would pay for on every call — including the meal
  // prompt's, which rides a photograph.
  //
  // MEASURED: **469 tok**, against the meal estimator's 542. Trimmed once before
  // landing (507 → 469) by the same rule the entries above follow — delete the
  // restatement, keep the instruction: "(pure fat is ~884)" (the parser enforces
  // the bound anyway), "espresso drinks" (covered by coffee), and the second
  // half of the null rule, which said in a clause what the first half had just
  // said. The ceiling is 500, a deliberate ~6% of headroom rather than a round
  // number well above the truth: a ceiling nothing can reach guards nothing.
  //
  // 2026-09-25: the estimator's micro shortlist and its 10% bar joined it (the
  // owner's "yes, same rule as the estimator"), +48, paid inside the ceiling by
  // rewriting the sodium/caffeine bullet in the estimator's shape and trimming
  // the drinks list and the schema line: **468 tok**, and the ceiling did not
  // move. The accounting is on FOOD_ENTRY_SYSTEM_PROMPT itself.
  const foodEntryTokens = proseTok(FOOD_ENTRY_SYSTEM_PROMPT);
  const FOOD_ENTRY_PROMPT_CEILING = 500;
  foodEntryTokens < FOOD_ENTRY_PROMPT_CEILING
    ? ok(`the food-entry prompt fits its own ceiling (~${foodEntryTokens} tok < 500)`)
    : bad('food-entry prompt over budget', String(foodEntryTokens));
  FOOD_ENTRY_SYSTEM_PROMPT !== MEAL_ESTIMATION_SYSTEM_PROMPT &&
  !buildCoachSystemPrompt({ notificationsLive: false }).includes(FOOD_ENTRY_SYSTEM_PROMPT)
    ? ok('…and it is a separate one-shot prompt, not part of the Coach’s cached prefix')
    : bad('the food-entry prompt has leaked into the cached prefix');

  const HAIKU_CACHE_MINIMUM = 4096;
  // The pass's OWN tool set, not every read tool: `query_records` is held back
  // from the unattended pass (PASS_EXCLUDED_TOOLS, src/lib/ai/tools/index.ts),
  // so billing it here would guard a prefix nothing sends.
  const passPrefix = systemTokens + jsonTok(JSON.stringify(toWireTools(PASS_READ_TOOLS)));
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
