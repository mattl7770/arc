/**
 * Headless test of Phase-4 INITIATIVE (docs/coach-intelligence-review.md §4
 * Phase 4) against real SQLite via node:sqlite:
 *
 *   - the pass schedule: once a day, plus an attention router for NEW signals
 *   - runCoachPass against a scripted wire: read-only, SKIP means silence,
 *     failures are silent, write tools are refused even if offered
 *   - notification routing (a tapped reminder / check-in knows where to go)
 *   - experiment monitoring: the intervention lands on the mission, and the
 *     readout surfaces as an insight instead of waiting to be asked
 *
 * op-sqlite is never loaded and no network call is made. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { setDayStartsAt, shiftISODate, todayISODate } from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { createExperiment } from '../src/lib/db/repositories/experiments.ts';
import { listMission } from '../src/lib/db/repositories/mission.ts';
import { generateMissionForDay } from '../src/lib/db/repositories/mission-generate.ts';
import { createProtocolWithVersion } from '../src/lib/db/repositories/protocols.ts';
import { computeInsights } from '../src/lib/ai/insights.ts';
import { isoDaysAgo } from '../src/lib/ai/series.ts';
import { isPassSkip, passDirective, PASS_SKIP, runCoachPass } from '../src/lib/ai/coach-pass.ts';
import {
  currentSignals,
  duePass,
  EVENING_FROM,
  getPassState,
  isEveningAt,
  markPassRan,
  setPassState,
} from '../src/lib/ai/pass-schedule.ts';
import {
  carriesNumber,
  inQuietHours,
  parseNudgeReply,
  planNudges,
  NUDGE_MAX_CHARS,
  NUDGE_MAX_PER_DAY,
} from '../src/lib/notifications/nudge-plan.ts';
import * as nudgeRepo from '../src/lib/db/repositories/coach-nudges.ts';
import * as chatRepo from '../src/lib/db/repositories/ai-chat.ts';
import { createReminder } from '../src/lib/db/repositories/reminders.ts';
import { waitForHealthSyncIdle } from '../src/lib/health/sync.ts';
import {
  coachTapLanding,
  coachTapParams,
  routeForNotification,
  tapKey,
} from '../src/lib/notifications/reminders.ts';
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

// Today at NOON, not the moment the suite runs. Since 0064 a pass due after
// 18:00 is the EVENING pass, so a suite run in the evening would see a
// different trigger than one run at lunch. Every date-relative fixture below
// still keys off today.
const NOW = new Date();
NOW.setHours(12, 0, 0, 0);
const CTX = { now: NOW };
const TODAY = todayISODate(NOW);
const run = (name, db, input = {}) => JSON.parse(toolByName(name).execute(db, input, CTX));

/** Seed enough HRV history for a poor-readiness watch signal. */
function seedPoorReadiness(raw) {
  let n = 0;
  const insert = (metric, daysAgo, value) =>
    raw
      .prepare(
        `INSERT INTO wearable_data (id, date, metric_type, value, source_device) VALUES (?, ?, ?, ?, 'manual')`
      )
      .run(`cp-${++n}`, isoDaysAgo(NOW, daysAgo), metric, value);
  for (let d = 1; d <= 6; d++) insert('hrv', d, 50);
  insert('hrv', 0, 36);
}

console.log('1. the pass schedule: once a day, and only for genuinely new signals');
{
  const { db } = freshDb();
  const first = duePass(db, NOW);
  first && first.kind === 'daily'
    ? ok('a day with no pass yet is due (the app-open trigger)')
    : bad('first pass', JSON.stringify(first));

  markPassRan(db, NOW);
  duePass(db, NOW) === null
    ? ok('immediately after, nothing is due — re-opening the app costs no pass')
    : bad('re-fired same day', JSON.stringify(duePass(db, NOW)));

  getPassState(db).lastDate === TODAY
    ? ok('the run is recorded against today')
    : bad('state', JSON.stringify(getPassState(db)));

  // Tomorrow it is due again.
  const tomorrow = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + 1, 9, 0, 0);
  duePass(db, tomorrow)?.kind === 'daily' ? ok('the next day is due again') : bad('next day');

  // A clock rolled BACKWARD must not re-fire the day's pass.
  const yesterday = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 1, 9, 0, 0);
  duePass(db, yesterday) === null
    ? ok('a clock rolled backward does not re-fire the pass')
    : bad('clock rollback re-fired');

  // …and a pass that RUNS on the rolled-back clock must not rewind the cursor,
  // or the daily pass fires a second time once the calendar catches back up.
  // Since 2026-09-14 this is src/lib/db/date.ts::forwardCursor rather than a
  // comparison local to this file.
  markPassRan(db, yesterday);
  getPassState(db).lastDate === TODAY
    ? ok('a pass run after westbound travel keeps the later day')
    : bad('markPassRan rewound the cursor', String(getPassState(db).lastDate));
  duePass(db, NOW) === null
    ? ok('…so the daily pass does not fire twice when the clock catches up')
    : bad('daily pass re-fired after a rollback', JSON.stringify(duePass(db, NOW)));
}

console.log('2. the attention router wakes the Coach for a NEW signal, once');
{
  const { db, raw } = freshDb();
  markPassRan(db, NOW);
  duePass(db, NOW) === null ? ok('quiet day stays quiet') : bad('spurious pass');

  seedPoorReadiness(raw);
  const signalPass = duePass(db, NOW);
  signalPass && signalPass.kind === 'signal'
    ? ok('a new watch-tone signal makes a second pass due the same day')
    : bad('signal trigger', JSON.stringify(signalPass));
  signalPass.detail.includes('readiness')
    ? ok('the trigger names what changed')
    : bad('detail', signalPass.detail);

  markPassRan(db, NOW);
  duePass(db, NOW) === null
    ? ok('the same standing signal does not fire again (no daily nagging)')
    : bad('signal re-fired', JSON.stringify(duePass(db, NOW)));

  currentSignals(db, NOW).length > 0 && getPassState(db).seenSignals.length > 0
    ? ok('the signal set is remembered, not recomputed from scratch')
    : bad('signals not stored');
}

console.log('3. the directive: open-ended, names no scenario, allows silence');
{
  const daily = passDirective({ kind: 'daily' }, TODAY);
  daily.includes('the user did not type this')
    ? ok('the model is told this is not a user message')
    : bad('directive framing', daily);
  daily.includes(PASS_SKIP)
    ? ok('silence is an explicit, first-class option')
    : bad('no skip path', daily);
  !/(readiness|HRV|deload|workout|volume)/i.test(daily)
    ? ok('no scenario is prescribed — the judgment is entirely the model’s')
    : bad('directive prescribes a scenario', daily);
  passDirective({ kind: 'checkin', part: 'evening' }, TODAY).includes('actually happened')
    ? ok('the evening check-in asks for plan vs actuals')
    : bad('evening directive');
  /do not narrate/i.test(daily)
    ? ok('…and it asks for no preamble (the SECOND line of defence — isPassSkip is the first)')
    : bad('no anti-preamble directive', daily);
}

// ---------------------------------------------------------------------------
// The sentinel parser. This is the defect the owner saw on their phone
// (2026-08-11): the model narrated ("I'll read the current state and check for
// anything worth flagging."), called its tools, then said SKIP — and the old
// whole-string test `/^skip[.!]?$/i` did not match, so the preamble AND the
// sentinel shipped to Home's "Coach noticed" card as a proactive observation.
//
// Both directions matter and only one of them is visible when it goes wrong:
// a leaked sentinel is embarrassing, a wrongly-silenced note is never seen at
// all (silence consumes the day — see R9 below). So the false-positive cases
// are as load-bearing as the true ones.
// ---------------------------------------------------------------------------
console.log('3b. isPassSkip: the sentinel survives a preamble, a real note survives the word');
{
  const silent = (label, text) => (isPassSkip(text) ? ok(label) : bad(label, JSON.stringify(text)));
  const spoken = (label, text) =>
    !isPassSkip(text) ? ok(label) : bad(label, JSON.stringify(text));

  silent('a bare SKIP is silence', PASS_SKIP);
  silent('…punctuated', 'SKIP.');
  silent('…exclaimed', 'SKIP!');
  silent('…lower-cased', 'skip');
  silent('…emphasised', '**SKIP**');
  silent('…with trailing whitespace and newlines', 'SKIP   \n\n  \n');
  silent('…with leading whitespace', '   SKIP');
  silent(
    'a preamble followed by the sentinel is STILL silence (the shipped defect)',
    "I'll read the current state and check for anything worth flagging.\n\nSKIP"
  );
  silent(
    '…including a manufactured observation above it — the verdict governs the reply',
    'Nothing much stands out today.\n\nSKIP.'
  );
  silent('an empty reply is silence', '');
  silent('…as is whitespace only', '   \n  \n');

  spoken(
    'a real note is NOT silenced',
    'Protein landed at 96 g against a 150 g target four days running. Move one serving to breakfast.'
  );
  spoken(
    '…even when it contains the word "skip" mid-sentence',
    'Four sessions logged this week — it is fine to skip today’s and hold the pattern.'
  );
  spoken(
    '…even when the word ENDS the note, with other words on the line',
    'You are two days into a deficit; do not skip'
  );
  spoken(
    '…and a note that merely mentions the sentinel on the way to a real point',
    'SKIP is what I would normally say here, but your sleep debt is 6 h and worth naming.'
  );
}

console.log('4. runCoachPass: read-only, honest silence, never surfaces a failure');
{
  // A scripted wire: the model "replies" with whatever the script says.
  const sse = (text) =>
    [
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}`,
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      '',
      '',
    ].join('\n');

  const fetchFor = (body, capture) => async (url, init) => {
    if (capture) capture.push(JSON.parse(init.body));
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

  const { db } = freshDb();
  const { apiKeyStore } = await import('../src/lib/ai/api-key-store.ts');
  await apiKeyStore.setKey('test-key');
  const { runCoachPass } = await import('../src/lib/ai/coach-pass.ts');

  const requests = [];
  const spoke = await runCoachPass(db, {
    trigger: { kind: 'daily' },
    now: NOW,
    fetchImpl: fetchFor(sse('Your protein has been under target all week.'), requests),
  });
  spoke.message === 'Your protein has been under target all week.'
    ? ok('a pass that has something to say returns it')
    : bad('pass message', JSON.stringify(spoke));

  const offered = requests[0].tools.map((t) => t.name);
  offered.length > 0 && offered.every((n) => toolByName(n)?.readOnly === true)
    ? ok(`the pass is offered READ tools only (${offered.length}), so nothing can be written`)
    : bad('write tool offered', offered.join(','));
  requests[0].system.length === 2
    ? ok('it carries the same two-block system prompt as a normal turn')
    : bad('system blocks', JSON.stringify(requests[0].system.length));

  const silent = await runCoachPass(db, {
    trigger: { kind: 'daily' },
    now: NOW,
    fetchImpl: fetchFor(sse('SKIP')),
  });
  silent.message === null ? ok('SKIP means silence, not a message saying "SKIP"') : bad('skip');

  const punctuated = await runCoachPass(db, {
    trigger: { kind: 'daily' },
    now: NOW,
    fetchImpl: fetchFor(sse('Skip.')),
  });
  punctuated.message === null ? ok('…however the model punctuates it') : bad('skip variant');

  // End to end, on the wire, for the exact string the owner's phone rendered.
  const preambled = await runCoachPass(db, {
    trigger: { kind: 'daily' },
    now: NOW,
    fetchImpl: fetchFor(
      sse("I'll read the current state and check for anything worth flagging.\n\nSKIP")
    ),
  });
  preambled.message === null && preambled.status === 'silent'
    ? ok('…and a preamble ahead of the sentinel never reaches Home as an observation')
    : bad('preamble shipped', JSON.stringify(preambled));

  const failed = await runCoachPass(db, {
    trigger: { kind: 'daily' },
    now: NOW,
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  failed.message === null
    ? ok('a failed pass is silent — the user never sees an error they did not ask for')
    : bad('error surfaced', JSON.stringify(failed));

  await apiKeyStore.clearKey();
  const keyless = await runCoachPass(db, { trigger: { kind: 'daily' }, now: NOW });
  keyless.message === null ? ok('no key → no pass, no crash') : bad('keyless pass');
}

console.log('5. notification taps know where to go');
{
  const plain = routeForNotification({ reminderId: 'r1' });
  plain?.kind === 'reminder' && plain.id === 'r1' && plain.checkin === false
    ? ok('a reminder tap routes to the reminder, as a plain one')
    : bad('reminder route', JSON.stringify(plain));
  const checkinReminder = routeForNotification({ reminderId: 'r2', checkin: true });
  checkinReminder?.kind === 'reminder' && checkinReminder.checkin === true
    ? ok('a CHECK-IN reminder tap says so, so the Coach can speak first (0064, Q5)')
    : bad('check-in reminder route', JSON.stringify(checkinReminder));
  routeForNotification({ reminderId: 'r3', checkin: 'yes' })?.checkin === false
    ? ok('…and only a real true makes it one')
    : bad('truthy checkin accepted');
  routeForNotification({ kind: 'checkin' })?.kind === 'checkin'
    ? ok('the morning check-in tap is its own route')
    : bad('checkin route');
  const nudge = routeForNotification({ kind: 'nudge', nudgeId: 'n1' });
  nudge?.kind === 'nudge' && nudge.id === 'n1'
    ? ok('a Coach nudge tap carries its row id')
    : bad('nudge route', JSON.stringify(nudge));
  routeForNotification({ kind: 'nudge' }) === null
    ? ok('…and a nudge payload with no id routes nowhere rather than guessing')
    : bad('id-less nudge routed');
  routeForNotification({ protocolItem: 'p:i', protocolId: 'p' })?.kind === 'mission'
    ? ok('a protocol item still lands on the mission')
    : bad('protocol route');
  routeForNotification(undefined) === null && routeForNotification({}) === null
    ? ok('an unrecognised payload routes nowhere (no mystery navigation)')
    : bad('unknown payload routed');
}

console.log('6. a running experiment is ON the day, and its readout surfaces itself');
{
  const { db } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Morning', type: 'daily_routine' },
    { items: [{ title: 'Morning light', scheduled_time: '07:00' }] }
  );
  createExperiment(db, {
    title: 'Magnesium PM',
    hypothesis: 'Better sleep',
    intervention: '400 mg magnesium glycinate at night',
    metrics: ['sleep'],
    startDate: isoDaysAgo(NOW, 2),
    durationDays: 14,
  });

  generateMissionForDay(db, TODAY);
  const mission = listMission(db, TODAY);
  const row = mission.find((m) => m.title === '400 mg magnesium glycinate at night');
  row
    ? ok('the intervention appears on the mission — adherence becomes visible')
    : bad('intervention missing', JSON.stringify(mission.map((m) => m.title)));
  // `category`, not `protocol` — main's exclusivity rule (mission-generate.ts):
  // a row names its origin ONCE. An experiment is no more a protocol than a
  // mode is, and "ROUTINE · EXPERIMENT" reads worse than "EXPERIMENT".
  row && row.category === 'Experiment · Magnesium PM' && row.protocol === undefined
    ? ok('labelled as the experiment, in the category slot, with no protocol attribution')
    : bad('label', JSON.stringify({ category: row?.category, protocol: row?.protocol }));
  row && /Day 3 of this experiment/.test(row.why ?? '')
    ? ok('and it says which day of the run this is')
    : bad('day number', row && row.why);

  // A finished window announces itself without being asked.
  const { db: db2 } = freshDb();
  createExperiment(db2, {
    title: 'Cold showers',
    hypothesis: 'Higher HRV',
    intervention: '2 min cold finish',
    metrics: ['hrv'],
    startDate: isoDaysAgo(NOW, 10),
    durationDays: 3,
  });
  const ready = computeInsights(db2, NOW).find((i) => i.kind === 'experiment');
  ready && ready.tone === 'watch' && ready.headline.includes('ready to read out')
    ? ok('a closed window surfaces as a watch insight (the brief and get_insights see it)')
    : bad('ready insight', JSON.stringify(computeInsights(db2, NOW).map((i) => i.id)));
  ready && ready.detail.includes('2 min cold finish')
    ? ok('carrying what was tested, so the readout has its context')
    : bad('ready detail', ready && ready.detail);
}

console.log('7. abandoning exists so a broken run needs no fabricated verdict');
{
  const { db } = freshDb();
  const id = createExperiment(db, {
    title: 'Sauna nightly',
    hypothesis: 'Deeper sleep',
    intervention: '20 min sauna',
    metrics: ['sleep'],
    startDate: isoDaysAgo(NOW, 3),
    durationDays: 14,
  });
  // `abandon_experiment` folded into `edit_record` on 2026-09-19. The card is
  // verbatim; the rail its description carried ("use this INSTEAD of concluding
  // it") now rides the `get_experiments` payload, asserted below.
  const abandon = {
    domain: 'experiments',
    id,
    fields: { status: 'abandoned', reason: 'Sauna was closed all week' },
  };
  toolByName('edit_record').confirmSummary(abandon, db, { now: NOW }) ===
  'Abandon experiment "Sauna nightly" — Sauna was closed all week'
    ? ok('the card names the experiment and the reason')
    : bad('abandon card', toolByName('edit_record').confirmSummary(abandon, db, { now: NOW }));
  // A reason is REQUIRED in code, since a schema cannot say "this field when
  // that value" without splitting the tool in two again.
  throws(() =>
    toolByName('edit_record').confirmSummary(
      { domain: 'experiments', id, fields: { status: 'abandoned' } },
      db,
      { now: NOW }
    )
  )
    ? ok('abandoning with no reason is refused at the card')
    : bad('reasonless abandon accepted');
  const running = JSON.parse(toolByName('get_experiments').execute(db, {}, CTX));
  /abandoned \(with a reason\), never concluded/i.test(running.note ?? '')
    ? ok('get_experiments carries the abandon-not-conclude rail, where the id comes from')
    : bad('missing abandon note', JSON.stringify(running.note));

  const result = JSON.parse(toolByName('edit_record').execute(db, abandon, { now: NOW }));
  result.edited ? ok('it abandons cleanly') : bad('abandon failed', JSON.stringify(result));
  throws(() => toolByName('edit_record').execute(db, abandon, { now: NOW }))
    ? ok('abandoning twice is refused')
    : bad('double abandon');
}

console.log('8. create_experiment warns when a watched metric cannot be read back');
{
  const { db } = freshDb();
  const readable = run('create_experiment', db, {
    name: 'Mag PM',
    hypothesis: 'Better sleep',
    intervention: '400 mg',
    metrics: ['sleep', 'HRV'],
    duration_days: 14,
  });
  !readable.unreadableMetrics
    ? ok('readable metrics create cleanly')
    : bad('false warning', JSON.stringify(readable));

  const vague = run('create_experiment', db, {
    name: 'Mood test',
    hypothesis: 'Feels better',
    intervention: 'Morning walk',
    metrics: ['sleep score', 'general vibe'],
    duration_days: 14,
  });
  vague.unreadableMetrics?.length === 2 && vague.note.includes('qualitative')
    ? ok('unreadable metrics are flagged AT CREATION, not discovered on readout day')
    : bad('no warning', JSON.stringify(vague));
}

// ---------------------------------------------------------------------------
// Regressions from the Phase 2–6 adversarial review. The pass carried the worst
// of them: as shipped it could not fire at all on a cold start, and when it did
// it fired twice.
// ---------------------------------------------------------------------------

console.log('R9. the pass store: one run, only when it is safe and possible');
{
  const sse = (text) =>
    [
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}`,
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      '',
      '',
    ].join('\n');
  const fetchFor = (body, counter) => async () => {
    if (counter) counter.n += 1;
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

  const { apiKeyStore } = await import('../src/lib/ai/api-key-store.ts');
  const { coachPassStore } = await import('../src/lib/ai/pass-store.ts');
  const { listMessages, getOrCreateActiveConversation } =
    await import('../src/lib/db/repositories/ai-chat.ts');

  // --- LOCKED: the pass reads health data and posts it to the model API.
  // Behind Face ID nobody has proven they are the user yet.
  {
    const { db } = freshDb();
    await apiKeyStore.setKey('test-key');
    await apiKeyStore.hydrate();
    coachPassStore.reset();
    const counter = { n: 0 };
    const outcome = await coachPassStore.maybeRun(db, {
      unlocked: false,
      now: NOW,
      fetchImpl: fetchFor(sse('Something worth saying.'), counter),
    });
    outcome === 'skipped' && counter.n === 0
      ? ok('a locked app never runs a pass — no model call, no data leaves the device')
      : bad('ran while locked', `${outcome}/${counter.n}`);
  }

  // --- NOT HYDRATED: the original checked apiKeyStore.has() synchronously on
  // mount while hydrate() was still in flight, so on a cold start the answer
  // was always "no key" and the daily pass never fired at all.
  {
    const { db } = freshDb();
    coachPassStore.reset();
    await apiKeyStore.setKey('test-key');
    await apiKeyStore.hydrate();
    apiKeyStore.isHydrated() && apiKeyStore.has()
      ? ok('once hydration settles, the key is visible')
      : bad('hydration precondition');
    const counter = { n: 0 };
    const outcome = await coachPassStore.maybeRun(db, {
      unlocked: true,
      now: NOW,
      fetchImpl: fetchFor(sse('Protein is under target again.'), counter),
    });
    outcome === 'ran' && counter.n === 1
      ? ok('…and the pass DOES fire (the cold-start bug: it never used to)')
      : bad('pass did not fire', `${outcome}/${counter.n}`);
    coachPassStore.getMessage() === 'Protein is under target again.'
      ? ok('the note is published to the store, where Home reads it')
      : bad('note not published', String(coachPassStore.getMessage()));

    // …and it is a real assistant turn in the thread, not a floating toast.
    const thread = listMessages(db, getOrCreateActiveConversation(db).id);
    thread.some((m) => m.role === 'assistant' && m.content.includes('Protein'))
      ? ok('…and persisted into the thread, auditable like any other turn')
      : bad('not persisted', JSON.stringify(thread.map((m) => m.role)));
  }

  // --- ONE RUN: mounting the old hook at the root AND on Home ran two passes
  // for one trigger — two model calls, two assistant turns.
  {
    const { db } = freshDb();
    coachPassStore.reset();
    await apiKeyStore.setKey('test-key');
    await apiKeyStore.hydrate();
    const counter = { n: 0 };
    const results = await Promise.all([
      coachPassStore.maybeRun(db, {
        unlocked: true,
        now: NOW,
        fetchImpl: fetchFor(sse('One.'), counter),
      }),
      coachPassStore.maybeRun(db, {
        unlocked: true,
        now: NOW,
        fetchImpl: fetchFor(sse('One.'), counter),
      }),
    ]);
    counter.n === 1
      ? ok('two concurrent callers collapse into ONE model call')
      : bad('double-fired', String(counter.n));
    results.filter((r) => r === 'ran').length === 1
      ? ok('…and exactly one of them reports having run')
      : bad('both claimed to run', JSON.stringify(results));
    listMessages(db, getOrCreateActiveConversation(db).id).filter((m) => m.role === 'assistant')
      .length === 1
      ? ok('…leaving one assistant turn in the thread, not two')
      : bad('duplicate turns');
  }

  // --- OFFLINE ≠ SILENT: a pass that never reached the model must not consume
  // the day. One aeroplane-mode morning used to cancel that day's pass.
  {
    const { db } = freshDb();
    coachPassStore.reset();
    await apiKeyStore.setKey('test-key');
    await apiKeyStore.hydrate();
    const before = getPassState(db).lastDate;
    before === null ? ok('no pass has run today yet') : bad('precondition', String(before));
    const outcome = await coachPassStore.maybeRun(db, {
      unlocked: true,
      now: NOW,
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    outcome === 'offline'
      ? ok('a failed pass reports offline, not silence')
      : bad('offline', outcome);
    getPassState(db).lastDate === before
      ? ok('…and the day stays OPEN, so a real pass can still happen later')
      : bad('offline pass consumed the day', String(getPassState(db).lastDate));
    coachPassStore.getMessage() === null
      ? ok('…while the user still sees nothing (they did not ask for this)')
      : bad('error surfaced to the user');

    // Back online, the same day still gets its pass.
    const counter = { n: 0 };
    const retry = await coachPassStore.maybeRun(db, {
      unlocked: true,
      now: NOW,
      fetchImpl: fetchFor(sse('Back online, and here is the thing.'), counter),
    });
    retry === 'ran' && counter.n === 1
      ? ok('…and the retry lands once the network returns')
      : bad('no retry after offline', `${retry}/${counter.n}`);
  }

  // --- SILENCE IS A JUDGMENT: it consumes the day, unlike a failure.
  {
    const { db } = freshDb();
    coachPassStore.reset();
    await apiKeyStore.setKey('test-key');
    await apiKeyStore.hydrate();
    const outcome = await coachPassStore.maybeRun(db, {
      unlocked: true,
      now: NOW,
      fetchImpl: fetchFor(sse(PASS_SKIP)),
    });
    outcome === 'silent' ? ok('a considered SKIP reports silent') : bad('skip outcome', outcome);
    getPassState(db).lastDate === todayISODate(NOW)
      ? ok('…and DOES consume the day — a signal weighed and set aside is not re-asked hourly')
      : bad('silent pass did not consume the day', String(getPassState(db).lastDate));
    coachPassStore.getMessage() === null ? ok('…and says nothing') : bad('spoke on skip');
  }

  await apiKeyStore.clearKey();
  coachPassStore.reset();
}

// ---------------------------------------------------------------------------
// 0064 — THE COACH SENDS NOTIFICATIONS (docs/spikes/coach-notifications.md,
// owner's answers 2026-09-25). The model decides whether, what and when; every
// section below is the code half: parse, cap, de-duplicate, quiet hours,
// store, answer taps. No real model call — the wire is scripted throughout.
// ---------------------------------------------------------------------------

const TOMORROW = shiftISODate(TODAY, 1);
const ZERO = '00:00';

/** A scripted wire: every call replies with `text`; `capture` collects bodies. */
const nudgeSse = (text) =>
  [
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}`,
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
    '',
    '',
  ].join('\n');
const wire = (text, capture) => async (_url, init) => {
  if (capture) capture.push(JSON.parse(init.body));
  const body = nudgeSse(text);
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
const directiveOf = (request) => request.messages[0].content;

console.log('N1. the NUDGE grammar: strict lines out, the note left, nothing guessed');
{
  const reply = parseNudgeReply(
    [
      'Protein has been low three days running.',
      '',
      `NUDGE ${TOMORROW} 07:30 Leg day. Eat before you lift.`,
      `- **NUDGE** ${TOMORROW} 7:05 — "Walk after lunch"`,
      'NUDGE tomorrow 08:00 A day in words',
      `NUDGE ${TOMORROW} 25:00 An hour that is not one`,
      'NUDGE 2026-02-30 08:00 A day that does not exist',
      'Nudge yourself toward bed earlier tonight.',
    ].join('\n')
  );
  reply.text ===
  'Protein has been low three days running.\n\nNudge yourself toward bed earlier tonight.'
    ? ok('every NUDGE line leaves the note, and prose that starts "Nudge" stays in it')
    : bad('note after parse', JSON.stringify(reply.text));
  reply.proposals.length === 2 &&
  reply.proposals[0].day === TOMORROW &&
  reply.proposals[0].time === '07:30' &&
  reply.proposals[0].body === 'Leg day. Eat before you lift.'
    ? ok('a well-formed line becomes a proposal: day, time and words')
    : bad('proposal', JSON.stringify(reply.proposals));
  reply.proposals[1]?.time === '07:05' && reply.proposals[1]?.body === 'Walk after lunch'
    ? ok('bullets, emphasis, a dash and quotes are stripped; a one-digit hour is padded')
    : bad('decorated line', JSON.stringify(reply.proposals[1]));
  reply.malformed.length === 3
    ? ok('a day in words, a 25th hour and 30 February are malformed — dropped, never guessed')
    : bad('malformed', JSON.stringify(reply.malformed));
  const none = parseNudgeReply('SKIP\nNUDGE NONE');
  none.clear && none.text === 'SKIP' && none.proposals.length === 0
    ? ok('NUDGE NONE is the one way to cancel on purpose')
    : bad('NUDGE NONE', JSON.stringify(none));
  isPassSkip(parseNudgeReply(`NUDGE ${TOMORROW} 07:30 Leg day.\nSKIP`).text) &&
  isPassSkip(parseNudgeReply(`SKIP\nNUDGE ${TOMORROW} 07:30 Leg day.`).text)
    ? ok('a pass can say SKIP and still plan a nudge, whichever order it writes them in')
    : bad('SKIP beside a nudge line');
  isPassSkip(parseNudgeReply(`NUDGE ${TOMORROW} 07:30 Leg day.`).text)
    ? ok('…and a reply that is only nudge lines is a silent pass, not an empty message')
    : bad('nudge-only reply spoke');
}

console.log('N2. the caps: two a day, quiet hours, no digits, the horizon — dropped, never moved');
{
  const base = { now: NOW, dayStartsAt: ZERO, quietStart: '21:30', quietEnd: '07:00', sent: [] };
  const at = (day, time, body = 'Walk after lunch.') => ({ day, time, body });
  const plan = (proposals, extra = {}) => planNudges({ ...base, proposals, ...extra });
  const reasons = (result) => result.rejected.map((r) => r.reason).join(',');

  inQuietHours('21:30', '21:30', '07:00') &&
  inQuietHours('06:59', '21:30', '07:00') &&
  !inQuietHours('07:00', '21:30', '07:00') &&
  !inQuietHours('21:29', '21:30', '07:00')
    ? ok('quiet hours wrap midnight: start inside, end outside')
    : bad('overnight window');
  inQuietHours('12:00', '09:00', '17:00') && !inQuietHours('08:00', '09:00', '17:00')
    ? ok('…and a daytime window works the same way')
    : bad('daytime window');
  !inQuietHours('03:00', '08:00', '08:00')
    ? ok('equal ends mean no quiet hours, not all day')
    : bad('empty window');

  const quiet = plan([at(TODAY, '22:00'), at(TOMORROW, '06:30'), at(TOMORROW, '07:00')]);
  quiet.accepted.length === 1 &&
  quiet.accepted[0].time === '07:00' &&
  reasons(quiet) === 'quiet-hours,quiet-hours'
    ? ok('a nudge inside quiet hours is dropped; 07:00 on the dot is allowed')
    : bad('quiet hours', reasons(quiet));

  reasons(plan([at(TOMORROW, '08:00', 'Drink 500 ml of water')])) === 'number'
    ? ok('a line with a digit is dropped — the lock screen carries no numbers (Q3)')
    : bad('digits');
  reasons(plan([at(TOMORROW, '08:00', 'x'.repeat(NUDGE_MAX_CHARS + 1))])) === 'too-long'
    ? ok(`a line over ${NUDGE_MAX_CHARS} characters is dropped, not truncated`)
    : bad('length');
  reasons(plan([at(TODAY, '11:00'), at(TODAY, '12:02')])) === 'past,past'
    ? ok('a moment already gone, or minutes away, is dropped')
    : bad('past');
  reasons(plan([at(shiftISODate(TODAY, 2), '09:00')])) === 'beyond-horizon'
    ? ok('a moment beyond 36 hours is dropped')
    : bad('horizon');

  const three = plan([
    at(TOMORROW, '08:00', 'One.'),
    at(TOMORROW, '12:00', 'Two.'),
    at(TOMORROW, '17:00', 'Three.'),
  ]);
  three.accepted.length === NUDGE_MAX_PER_DAY &&
  three.accepted.map((n) => n.body).join(' ') === 'One. Two.' &&
  reasons(three) === 'day-cap'
    ? ok(`at most ${NUDGE_MAX_PER_DAY} a day, and the ones written first are the ones kept`)
    : bad('day cap', reasons(three));

  const sentToday = [at(TODAY, '09:00', 'Walk after lunch.')];
  const withSent = plan([at(TODAY, '13:00', 'Stretch.'), at(TODAY, '15:00', 'Bed on time.')], {
    sent: sentToday,
  });
  withSent.accepted.length === 1 && reasons(withSent) === 'day-cap'
    ? ok('one already sent today leaves room for one more, not two')
    : bad('cap counting sent', reasons(withSent));
  reasons(plan([at(TODAY, '14:00', 'walk after lunch')], { sent: sentToday })) === 'duplicate'
    ? ok('words already sent today are not sent again, whatever their case')
    : bad('duplicate words');
  reasons(plan([at(TOMORROW, '08:00', 'One.'), at(TOMORROW, '08:00', 'Two.')])) === 'duplicate'
    ? ok('two in the same slot keep the first')
    : bad('duplicate slot');
  const order = plan([at(TOMORROW, '09:00', 'Later.'), at(TODAY, '15:00', 'Sooner.')]);
  order.accepted.map((n) => n.body).join(' ') === 'Sooner. Later.'
    ? ok('accepted nudges come back soonest first')
    : bad('order');
}

console.log('N3. what a pass does to the pending set: silence keeps it, lines replace it');
{
  const { db, raw } = freshDb();
  const apply = (text) => nudgeRepo.applyNudgeReply(db, parseNudgeReply(text), NOW, ZERO);
  const ahead = () => nudgeRepo.upcomingNudges(db, NOW, ZERO);

  let out = apply(`SKIP\nNUDGE ${TOMORROW} 07:30 Leg day. Eat before you lift.`);
  out.changed && out.added.length === 1 && ahead().length === 1
    ? ok('a first line writes a pending row')
    : bad('first plan', JSON.stringify(out));
  const first = ahead()[0].id;

  out = apply('SKIP');
  !out.changed && ahead().length === 1
    ? ok('a SILENT pass leaves what is pending alone (the decision the plan left open)')
    : bad('silent pass cancelled the plan');

  out = apply(`NUDGE ${TOMORROW} 07:30 Leg day. Eat before you lift.`);
  !out.changed && out.kept.length === 1 && ahead()[0].id === first
    ? ok('restating a pending nudge keeps its row and records nothing')
    : bad('restate', JSON.stringify(out));

  out = apply(`NUDGE ${TOMORROW} 12:30 Lunch before the afternoon walk.`);
  out.changed &&
  out.cancelled.length === 1 &&
  nudgeRepo.getNudge(db, first).status === 'cancelled' &&
  ahead().length === 1 &&
  ahead()[0].time === '12:30'
    ? ok('new lines REPLACE what is still pending — the set can never pile up')
    : bad('replace', JSON.stringify(out));

  out = apply(`NUDGE ${TOMORROW} 23:00 Lights out.`);
  !out.changed && out.rejected[0]?.reason === 'quiet-hours' && ahead()[0].time === '12:30'
    ? ok('lines the caps all refuse change nothing — a slip cannot wipe the plan')
    : bad('all-rejected pass', JSON.stringify(out));

  // A nudge whose moment has passed went out; it is history, never cancelled.
  raw
    .prepare(
      "INSERT INTO coach_nudges (id, day, time, body) VALUES ('past-1', ?, '09:00', 'Walk.')"
    )
    .run(TODAY);
  out = apply('NUDGE NONE');
  out.changed &&
  ahead().length === 0 &&
  nudgeRepo.getNudge(db, 'past-1').status === 'pending' &&
  nudgeRepo.describeNudgePlan(out, TODAY) ===
    'Planned notifications cancelled. None are planned now.'
    ? ok('NUDGE NONE cancels everything ahead, never a nudge that already went out')
    : bad('NUDGE NONE', JSON.stringify(out));
  nudgeRepo.sentNudgesFrom(db, TODAY, NOW, ZERO).some((r) => r.id === 'past-1')
    ? ok('…and that past one counts as sent')
    : bad('past not sent');

  out = apply(`NUDGE ${TOMORROW} 08:00 Pack the gym bag tonight.`);
  nudgeRepo.describeNudgePlan(out, TODAY) ===
  'Planned notifications\ntomorrow, 08:00 · Pack the gym bag tonight.'
    ? ok('the thread record lists what is planned, in plain words')
    : bad('record', nudgeRepo.describeNudgePlan(out, TODAY));

  nudgeRepo.saveNudgeSettings(db, { enabled: false }, NOW, ZERO);
  out = apply(`NUDGE ${TOMORROW} 09:00 Something.`);
  !out.changed && nudgeRepo.upcomingNudges(db, NOW, ZERO).length === 0
    ? ok('with nudges off, a pass cannot plan one')
    : bad('disabled pass planned');
}

console.log(
  'N4. settings: off cancels what is ahead; quiet hours hold a nudge back, never destroy it'
);
{
  const { db } = freshDb();
  const s0 = nudgeRepo.getNudgeSettings(db);
  s0.enabled && s0.quietStart === '21:30' && s0.quietEnd === '07:00' && s0.checkinTime === null
    ? ok('defaults: on, quiet 21:30–07:00, morning check-in off (the owner’s answers)')
    : bad('defaults', JSON.stringify(s0));
  nudgeRepo.applyNudgeReply(
    db,
    parseNudgeReply(`NUDGE ${TODAY} 20:00 Stretch before bed.\nNUDGE ${TOMORROW} 08:00 Walk.`),
    NOW,
    ZERO
  );
  nudgeRepo.saveNudgeSettings(db, { quietStart: '19:00' }, NOW, ZERO);
  const left = nudgeRepo.upcomingNudges(db, NOW, ZERO);
  left.length === 1 && left[0].time === '08:00'
    ? ok('quiet hours moved over the 20:00 nudge hold it back: not listed, not scheduled')
    : bad('quiet move', JSON.stringify(left));
  !nudgeRepo.nudgeDirectiveFor(db, NOW, ZERO).pending.some((n) => n.time === '20:00')
    ? ok('…and the pass is not told it is coming either')
    : bad('held-back nudge in the directive');
  // The wheel commits every time it settles, so a spin through 19:00 on the
  // way to 22:00 must not have destroyed anything.
  nudgeRepo.saveNudgeSettings(db, { quietStart: '22:00' }, NOW, ZERO);
  nudgeRepo
    .upcomingNudges(db, NOW, ZERO)
    .map((n) => n.time)
    .join(',') === '20:00,08:00'
    ? ok('moved off it again, the 20:00 nudge is back — a spin through the wheel destroys nothing')
    : bad('held-back nudge lost', JSON.stringify(nudgeRepo.upcomingNudges(db, NOW, ZERO)));
  nudgeRepo.saveNudgeSettings(db, { quietStart: '21:30' }, NOW, ZERO);
  const junk = nudgeRepo.saveNudgeSettings(
    db,
    { quietEnd: '25:00', checkinTime: '7:30' },
    NOW,
    ZERO
  );
  junk.quietEnd === '07:00' && junk.checkinTime === null
    ? ok('a time that is not a clock is ignored, never stored')
    : bad('junk stored', JSON.stringify(junk));
  nudgeRepo.saveNudgeSettings(db, { checkinTime: '07:15' }, NOW, ZERO).checkinTime === '07:15' &&
  nudgeRepo.saveNudgeSettings(db, { checkinTime: null }, NOW, ZERO).checkinTime === null
    ? ok('the morning check-in turns on at a time and off again')
    : bad('check-in time');
  nudgeRepo.saveNudgeSettings(db, { enabled: false }, NOW, ZERO);
  nudgeRepo.upcomingNudges(db, NOW, ZERO).length === 0 &&
  nudgeRepo.listNudgesFrom(db, TODAY).every((r) => r.status === 'cancelled')
    ? ok('turning nudges off cancels every one still ahead, at once')
    : bad('off did not cancel');
}

console.log('N5. the directive: nudge instructions only when on, in the pass, naming no scenario');
{
  const { db } = freshDb();
  nudgeRepo.applyNudgeReply(
    db,
    parseNudgeReply(`NUDGE ${TOMORROW} 07:30 Leg day. Eat before you lift.`),
    NOW,
    ZERO
  );
  const context = nudgeRepo.nudgeDirectiveFor(db, NOW, ZERO);
  const daily = passDirective({ kind: 'daily' }, TODAY, context);
  daily.includes('NUDGE YYYY-MM-DD HH:MM text') &&
  daily.includes('Quiet hours are 21:30–07:00') &&
  daily.includes(`${TOMORROW} 07:30 Leg day. Eat before you lift.`) &&
  daily.includes('NUDGE NONE')
    ? ok('the pass is told the grammar, the quiet window and what is already pending')
    : bad('nudge block', daily);
  daily.includes(PASS_SKIP) && daily.includes('NUDGE lines are the one exception')
    ? ok('…and SKIP still stands, with nudge lines allowed beside it')
    : bad('skip with nudges');
  !/(readiness|HRV|deload|workout|volume)/i.test(daily)
    ? ok('…and still names no scenario — what to nudge about is the model’s call')
    : bad('nudge block prescribes a scenario');
  !passDirective({ kind: 'daily' }, TODAY).includes('NUDGE')
    ? ok('with nudges off the directive is the pre-0064 text: no nudge instructions at all')
    : bad('nudge text leaked into the off directive');
  passDirective({ kind: 'checkin', part: 'evening' }, TODAY, context).includes(
    'last look before tomorrow'
  )
    ? ok('the evening pass is told it is the one that plans tomorrow')
    : bad('evening plan line');
  const morning = passDirective({ kind: 'checkin', part: 'morning' }, TODAY, null);
  morning.includes('They asked') && !morning.includes('If the day is unremarkable')
    ? ok('a tapped check-in is told he is waiting, and to answer')
    : bad('waiting directive', morning);
  const topic = passDirective(
    { kind: 'topic', title: 'The knee', notes: 'sore after runs', firstLook: true },
    TODAY,
    null
  );
  topic.includes('"The knee" (sore after runs)') && topic.includes('first look')
    ? ok('a check-in reminder names its topic, and folds in the day’s first look when due')
    : bad('topic directive', topic);
  nudgeRepo.saveNudgeSettings(db, { enabled: false }, NOW, ZERO);
  nudgeRepo.nudgeDirectiveFor(db, NOW, ZERO) === null
    ? ok('nudges off: there is nothing to tell the pass')
    : bad('directive context while off');
}

console.log('N6. the evening pass: the first open after 18:00, only while nudges are on');
{
  const EVENING = new Date(NOW);
  EVENING.setHours(19, 0, 0, 0);
  const SMALL_HOURS = new Date(NOW);
  SMALL_HOURS.setHours(2, 0, 0, 0);
  isEveningAt(EVENING, ZERO) && !isEveningAt(NOW, ZERO) && EVENING_FROM === '18:00'
    ? ok('19:00 is the evening, noon is not')
    : bad('isEveningAt');
  isEveningAt(SMALL_HOURS, '04:00') && !isEveningAt(SMALL_HOURS, ZERO)
    ? ok('02:00 under an 04:00 day boundary is still the evening of the day it belongs to')
    : bad('late boundary');

  const { db } = freshDb();
  const first = duePass(db, EVENING);
  first?.kind === 'checkin' && first.part === 'evening'
    ? ok('a day whose first open is after 18:00 gets the evening pass, not two passes')
    : bad('evening first open', JSON.stringify(first));
  markPassRan(db, EVENING, { evening: true });
  duePass(db, EVENING) === null && getPassState(db).lastDate === TODAY
    ? ok('…which also counts as the day’s look')
    : bad('evening did not consume the day', JSON.stringify(getPassState(db)));

  const { db: db2 } = freshDb();
  markPassRan(db2, NOW);
  const later = duePass(db2, EVENING);
  later?.kind === 'checkin' && later.part === 'evening'
    ? ok('after a noon pass, the first open after 18:00 is the evening pass')
    : bad('evening after daily', JSON.stringify(later));

  const { db: db3 } = freshDb();
  nudgeRepo.saveNudgeSettings(db3, { enabled: false }, NOW, ZERO);
  duePass(db3, EVENING)?.kind === 'daily'
    ? ok('with nudges off there is no evening pass — it exists to plan them')
    : bad('evening pass while off');
}

console.log('N7. a pass that plans: rows written, the thread records it, the note stays clean');
{
  const { apiKeyStore } = await import('../src/lib/ai/api-key-store.ts');
  const { coachPassStore } = await import('../src/lib/ai/pass-store.ts');
  await apiKeyStore.setKey('test-key');
  await apiKeyStore.hydrate();

  {
    const { db } = freshDb();
    coachPassStore.reset();
    const requests = [];
    const outcome = await coachPassStore.maybeRun(db, {
      unlocked: true,
      now: NOW,
      fetchImpl: wire(
        `Protein has been under target three days running.\n\nNUDGE ${TOMORROW} 07:30 Leg day. Eat before you lift.`,
        requests
      ),
    });
    outcome === 'ran' ? ok('the pass spoke') : bad('outcome', outcome);
    directiveOf(requests[0]).includes('NUDGE YYYY-MM-DD HH:MM text')
      ? ok('the nudge instructions rode the pass’s own message')
      : bad('directive missing nudge block');
    coachPassStore.getMessage() === 'Protein has been under target three days running.'
      ? ok('Home’s card gets the note alone — no NUDGE line, no record')
      : bad('home note', String(coachPassStore.getMessage()));
    const thread = chatRepo.listMessages(db, chatRepo.getOrCreateActiveConversation(db).id);
    const last = thread[thread.length - 1];
    last.role === 'assistant' &&
    last.content ===
      'Protein has been under target three days running.\n\nPlanned notifications\ntomorrow, 07:30 · Leg day. Eat before you lift.'
      ? ok('the thread keeps the note AND what was planned (Q1: recorded in the thread)')
      : bad('thread record', JSON.stringify(last.content));
    !thread.some((m) => m.content.includes('NUDGE'))
      ? ok('no sentinel reaches the thread')
      : bad('sentinel in the thread');
    nudgeRepo.upcomingNudges(db, NOW, ZERO).length === 1
      ? ok('…and the nudge is a pending row, ready for the OS resync')
      : bad('row not written');
  }

  {
    const { db } = freshDb();
    coachPassStore.reset();
    const outcome = await coachPassStore.maybeRun(db, {
      unlocked: true,
      now: NOW,
      fetchImpl: wire(`SKIP\nNUDGE ${TOMORROW} 08:00 Pack the gym bag tonight.`),
    });
    const thread = chatRepo.listMessages(db, chatRepo.getOrCreateActiveConversation(db).id);
    outcome === 'silent' &&
    coachPassStore.getMessage() === null &&
    thread.length === 1 &&
    thread[0].content === 'Planned notifications\ntomorrow, 08:00 · Pack the gym bag tonight.'
      ? ok('a silent pass that planned one still records it — and Home shows nothing')
      : bad('silent planning pass', JSON.stringify({ outcome, thread }));
  }
  coachPassStore.reset();
}

console.log('N8. the pass waits for the Health sync the same foreground started');
{
  const { coachPassStore } = await import('../src/lib/ai/pass-store.ts');
  const { db } = freshDb();
  coachPassStore.reset();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const counter = [];
  const running = coachPassStore.maybeRun(db, {
    unlocked: true,
    now: NOW,
    fetchImpl: wire('SKIP', counter),
    settle: () => gate,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  counter.length === 0
    ? ok('no model call while the sync is still landing last night')
    : bad('pass ran before the sync settled');
  release();
  await running;
  counter.length === 1 ? ok('…and the pass runs the moment it settles') : bad('never ran');

  const idleProbe = { isRunning: () => false, subscribe: () => () => {} };
  (await waitForHealthSyncIdle(1000, idleProbe)) === 'idle'
    ? ok('no sync running: the wait ends at once')
    : bad('idle probe');
  let busy = true;
  const subscribers = new Set();
  const busyProbe = {
    isRunning: () => busy,
    subscribe: (listener) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
  };
  const waiting = waitForHealthSyncIdle(1000, busyProbe);
  setTimeout(() => {
    busy = false;
    for (const listener of subscribers) listener();
  }, 15);
  (await waiting) === 'idle' && subscribers.size === 0
    ? ok('a running sync is waited for, and the listener is removed after')
    : bad('busy probe');
  (await waitForHealthSyncIdle(20, { isRunning: () => true, subscribe: () => () => {} })) ===
  'timeout'
    ? ok('a sync that never settles cannot hold the Coach: the wait times out')
    : bad('no timeout');
  coachPassStore.reset();
}

console.log('N9. tapped check-ins: the Coach speaks first, once, and says why when it does not');
{
  const { apiKeyStore } = await import('../src/lib/ai/api-key-store.ts');
  const { coachPassStore } = await import('../src/lib/ai/pass-store.ts');
  await apiKeyStore.setKey('test-key');
  await apiKeyStore.hydrate();

  {
    // The morning check-in tapped before the day's first look IS that look.
    const { db } = freshDb();
    coachPassStore.reset();
    const requests = [];
    coachPassStore.requestCheckin({ kind: 'morning' });
    coachPassStore.isAnswering() ? ok('a tap queues a request') : bad('not queued');
    await coachPassStore.maybeRun(db, {
      unlocked: true,
      now: NOW,
      fetchImpl: wire('You slept short; keep the run easy.', requests),
    });
    directiveOf(requests[0]).includes('morning check-in') &&
    coachPassStore.getCheckinOutcome()?.result === 'spoke' &&
    duePass(db, NOW) === null
      ? ok('the doorbell before any pass runs as the morning check-in and counts as the day')
      : bad('doorbell first', JSON.stringify(coachPassStore.getCheckinOutcome()));
    coachPassStore.requestCheckin({ kind: 'morning' });
    await coachPassStore.maybeRun(db, {
      unlocked: true,
      now: NOW,
      fetchImpl: wire('Again.', requests),
    });
    requests.length === 1 && coachPassStore.getCheckinOutcome()?.result === 'shown'
      ? ok('tapped again after the Coach spoke: the thread shows the note, nothing is paid twice')
      : bad(
          'second tap',
          `${requests.length} ${JSON.stringify(coachPassStore.getCheckinOutcome())}`
        );
  }

  {
    // The daily pass already ran and chose silence: he is still asking.
    const { db } = freshDb();
    coachPassStore.reset();
    const requests = [];
    await coachPassStore.maybeRun(db, {
      unlocked: true,
      now: NOW,
      fetchImpl: wire('SKIP', requests),
    });
    coachPassStore.requestCheckin({ kind: 'morning' });
    await coachPassStore.maybeRun(db, {
      unlocked: true,
      now: NOW,
      fetchImpl: wire('SKIP', requests),
    });
    requests.length === 2 &&
    directiveOf(requests[1]).includes('morning check-in') &&
    coachPassStore.getCheckinOutcome()?.result === 'silent'
      ? ok('after a silent daily pass the check-in runs once, and a silent answer is reported')
      : bad('check-in after silence', `${requests.length}`);
    coachPassStore.requestCheckin({ kind: 'morning' });
    await coachPassStore.maybeRun(db, {
      unlocked: true,
      now: NOW,
      fetchImpl: wire('SKIP', requests),
    });
    requests.length === 2 && coachPassStore.getCheckinOutcome()?.result === 'silent'
      ? ok('…and only once a day')
      : bad('check-in re-ran', `${requests.length}`);
  }

  {
    const { db } = freshDb();
    coachPassStore.reset();
    markPassRan(db, NOW);
    const knee = createReminder(db, { title: 'The knee', time: '20:00', checkin: true }, NOW);
    const creatine = createReminder(db, { title: 'Take creatine', time: '15:00' }, NOW);
    const requests = [];
    coachPassStore.requestCheckin({ kind: 'reminder', reminderId: knee });
    await coachPassStore.maybeRun(db, {
      unlocked: true,
      now: NOW,
      fetchImpl: wire('How did it hold up on today’s walk?', requests),
    });
    requests.length === 1 &&
    directiveOf(requests[0]).includes('"The knee"') &&
    coachPassStore.getCheckinOutcome()?.result === 'spoke'
      ? ok('a check-in reminder’s tap has the Coach speak first, about that topic')
      : bad('topic pass', `${requests.length}`);
    coachPassStore.requestCheckin({ kind: 'reminder', reminderId: knee });
    await coachPassStore.maybeRun(db, { unlocked: true, now: NOW, fetchImpl: wire('x', requests) });
    requests.length === 1 && coachPassStore.getCheckinOutcome()?.result === 'shown'
      ? ok('…once: a second tap the same day shows the thread')
      : bad('topic re-ran');
    coachPassStore.clearCheckinOutcome();
    coachPassStore.requestCheckin({ kind: 'reminder', reminderId: creatine });
    await coachPassStore.maybeRun(db, { unlocked: true, now: NOW, fetchImpl: wire('x', requests) });
    requests.length === 1 && coachPassStore.getCheckinOutcome() === null
      ? ok('a PLAIN reminder never makes the Coach speak — its tap is "Talk about this"')
      : bad('plain reminder ran a pass');
  }

  {
    const { db } = freshDb();
    coachPassStore.reset();
    await apiKeyStore.clearKey();
    coachPassStore.requestCheckin({ kind: 'morning' });
    await coachPassStore.maybeRun(db, { unlocked: true, now: NOW, fetchImpl: wire('x') });
    coachPassStore.getCheckinOutcome()?.result === 'no-key' && !coachPassStore.isAnswering()
      ? ok('with no key the tap is answered with why, not left waiting')
      : bad('no-key check-in', JSON.stringify(coachPassStore.getCheckinOutcome()));
  }
  coachPassStore.reset();
}

console.log('N10. a tapped nudge becomes the Coach’s latest message, once');
{
  const { coachPassStore } = await import('../src/lib/ai/pass-store.ts');
  const { db } = freshDb();
  coachPassStore.reset();
  nudgeRepo.applyNudgeReply(
    db,
    parseNudgeReply(`NUDGE ${TODAY} 15:00 Walk after lunch.`),
    NOW,
    ZERO
  );
  const id = nudgeRepo.upcomingNudges(db, NOW, ZERO)[0].id;
  const before = coachPassStore.getThreadVersion();
  const delivered = coachPassStore.deliverNudge(db, id);
  const thread = chatRepo.listMessages(db, chatRepo.getOrCreateActiveConversation(db).id);
  delivered &&
  thread.length === 1 &&
  thread[0].role === 'assistant' &&
  thread[0].content === 'Walk after lunch.' &&
  nudgeRepo.getNudge(db, id).status === 'delivered' &&
  coachPassStore.getThreadVersion() === before + 1
    ? ok('the line is in the thread as the Coach’s, the row is delivered, the tab is told')
    : bad('deliver', JSON.stringify({ delivered, thread }));
  !coachPassStore.deliverNudge(db, id) &&
  chatRepo.listMessages(db, chatRepo.getOrCreateActiveConversation(db).id).length === 1
    ? ok('a second tap (or a relaunch replaying it) adds nothing')
    : bad('delivered twice');
  !coachPassStore.deliverNudge(db, 'not-on-this-phone')
    ? ok('a nudge this phone does not have just opens the tab')
    : bad('unknown id delivered');
  const context = nudgeRepo.nudgeDirectiveFor(db, NOW, ZERO);
  context.sentToday.some((n) => n.body === 'Walk after lunch.') && context.pending.length === 0
    ? ok('the next pass is told it went out, so it does not repeat it')
    : bad('sent not in directive', JSON.stringify(context));
  coachPassStore.reset();
}

console.log('N11. set_reminder’s check-in flag, and list_reminders shows the Coach’s plan');
{
  const { db } = freshDb();
  const setReminder = toolByName('set_reminder');
  setReminder.confirmSummary({ title: 'The knee', time: '20:00', checkin: true }, db, CTX) ===
  'Set check-in "The knee" at 20:00'
    ? ok('the card says it is a check-in before he approves it')
    : bad(
        'card',
        setReminder.confirmSummary({ title: 'The knee', time: '20:00', checkin: true }, db, CTX)
      );
  setReminder.confirmSummary({ title: 'Take creatine', time: '20:00' }, db, CTX) ===
  'Set reminder "Take creatine" at 20:00'
    ? ok('…and a plain reminder’s card is unchanged')
    : bad('plain card');
  await setReminder.execute(db, { title: 'The knee', time: '20:00', checkin: true }, CTX);
  nudgeRepo.applyNudgeReply(
    db,
    parseNudgeReply(`NUDGE ${TOMORROW} 08:00 Pack the gym bag tonight.`),
    NOW,
    ZERO
  );
  const listed = run('list_reminders', db);
  listed.reminders[0].checkin === true &&
  listed.coachNotifications?.[0]?.text === 'Pack the gym bag tonight.'
    ? ok('list_reminders marks the check-in and lists the Coach’s own planned notifications')
    : bad('list_reminders', JSON.stringify(listed));
  const { db: bare } = freshDb();
  !('coachNotifications' in run('list_reminders', bare))
    ? ok('…and says nothing about them when there are none')
    : bad('empty coachNotifications shipped');
}

// ---------------------------------------------------------------------------
// The independent review of 0064 (2026-09-25): the findings it proved, each
// pinned here so the fix cannot quietly come undone.
// ---------------------------------------------------------------------------

console.log('N12. a SKIP stays silent whatever the model wraps its NUDGE lines in');
{
  const line = `NUDGE ${TOMORROW} 07:30 Leg day.`;
  const fence = '```';
  const wrapped = [
    ['a label', `SKIP\n\nNotifications:\n${line}`],
    ['a code fence', `SKIP\n${fence}\n${line}\n${fence}`],
    ['a horizontal rule', `SKIP\n\n---\n${line}`],
    ['a label over a bulleted list', `SKIP\n\nPlanned nudges:\n- ${line}`],
    ['a bold heading', `SKIP\n\n**Notifications**\n${line}`],
    ['a heading over a fenced block', `SKIP\n\n### Nudges\n${fence}text\n${line}\n${fence}`],
    ['a numbered list', `SKIP\n1. ${line}\n2. NUDGE ${TOMORROW} 12:30 Walk after lunch.`],
    ['a numbered list with parentheses', `SKIP\n1) ${line}`],
  ];
  for (const [name, reply] of wrapped) {
    const parsed = parseNudgeReply(reply);
    parsed.text === 'SKIP' && parsed.proposals.length >= 1 && parsed.malformed.length === 0
      ? ok(`SKIP then ${name}: the note is the sentinel alone, and the nudge still parses`)
      : bad(`SKIP then ${name}`, JSON.stringify(parsed));
  }

  const numbered = parseNudgeReply(`Protein is low.\n1) NUDGE ${TOMORROW} 07:30 Leg day.`);
  numbered.text === 'Protein is low.' && numbered.proposals[0]?.body === 'Leg day.'
    ? ok('a numbered nudge line under a real note leaves the note and becomes a proposal')
    : bad('numbered after a note', JSON.stringify(numbered));

  const longIntro =
    'Your HRV has dipped three mornings running, and the week ahead is a heavy one to carry:';
  const prose = parseNudgeReply(`${longIntro}\n${line}`);
  prose.text === longIntro
    ? ok('a long sentence above the lines is prose, not a label, and stays')
    : bad('long intro stripped', JSON.stringify(prose.text));
  const code = parseNudgeReply(`Try this split:\n${fence}\nA: push\nB: pull\n${fence}\n\n${line}`);
  code.text === `Try this split:\n${fence}\nA: push\nB: pull\n${fence}`
    ? ok('a code block in the note that ends just above the lines keeps both its fences')
    : bad('code block broken', JSON.stringify(code.text));
  const ruleInNote = parseNudgeReply('Sleep first.\n\n---\n\nThen the rest.');
  ruleInNote.text === 'Sleep first.\n\n---\n\nThen the rest.' && ruleInNote.lead === null
    ? ok('with no NUDGE line nothing is scaffolding: a rule in a note stays')
    : bad('rule stripped from a plain note', JSON.stringify(ruleInNote));

  const { apiKeyStore } = await import('../src/lib/ai/api-key-store.ts');
  await apiKeyStore.setKey('test-key');
  await apiKeyStore.hydrate();
  const { db } = freshDb();
  const passOf = (text) =>
    runCoachPass(db, { trigger: { kind: 'daily' }, now: NOW, fetchImpl: wire(text) });

  for (const [name, reply] of wrapped.slice(0, 4)) {
    const result = await passOf(reply);
    result.status === 'silent' && result.message === null && result.nudges.proposals.length === 1
      ? ok(`the pass: SKIP then ${name} is SILENT and still plans (the reviewer’s four replies)`)
      : bad(
          `pass with ${name}`,
          JSON.stringify({ status: result.status, message: result.message })
        );
  }
  const trailing = await passOf(`SKIP\n${line}\nThat one is for the morning.`);
  trailing.status === 'silent' && trailing.message === null
    ? ok('SKIP, the lines, then a remark about them: the verdict was SKIP, and it holds')
    : bad('trailing remark leaked', JSON.stringify(trailing.message));
  const noteFirst = await passOf(`${line}\nProtein has been low three days running.`);
  noteFirst.status === 'spoke' && noteFirst.message === 'Protein has been low three days running.'
    ? ok('lines FIRST and a note after: nothing precedes them, so the note speaks')
    : bad('note after the lines swallowed', JSON.stringify(noteFirst));
  const spoke = await passOf(`Protein has been low three days running.\n\nNotifications:\n${line}`);
  spoke.status === 'spoke' && spoke.message === 'Protein has been low three days running.'
    ? ok('a real note keeps its words, and loses the label that introduced the lines')
    : bad('note with a label', JSON.stringify(spoke.message));
}

console.log('N13. numbers: a figure is kept off the lock screen, a name with a digit is not');
{
  const base = { now: NOW, dayStartsAt: ZERO, quietStart: '21:30', quietEnd: '07:00', sent: [] };
  const body = (text) =>
    planNudges({ ...base, proposals: [{ day: TOMORROW, time: '08:00', body: text }] });
  const names = ['B12 with breakfast.', 'Omega-3 with dinner.', 'Vitamin D3 with your eggs.'];
  names.every((text) => body(text).accepted.length === 1)
    ? ok('B12, Omega-3 and D3 are names, and pass (they were all vetoed before the review)')
    : bad('names refused', names.filter((t) => body(t).accepted.length === 0).join(' | '));
  carriesNumber('CoQ10 with lunch.') === false && carriesNumber('Omega-3s with dinner.') === false
    ? ok('…as do CoQ10 and a plural')
    : bad('CoQ10 / plural');
  const figures = [
    'HRV 38 this morning, go easy.',
    'Sleep was 6 hours.',
    'Drink 500 ml of water.',
    'Walk at 7:30.',
    'A 5k easy.',
    'Zone 2 walk after lunch.',
  ];
  figures.every((text) => body(text).rejected[0]?.reason === 'number')
    ? ok('a reading, a duration, a dose, a clock time, a distance — and Zone 2 — still refused')
    : bad('figure let through', figures.filter((t) => body(t).accepted.length > 0).join(' | '));
}

console.log('N14. a restated nudge due within the five-minute lead is kept, not cancelled');
{
  const { db } = freshDb();
  nudgeRepo.applyNudgeReply(
    db,
    parseNudgeReply(`NUDGE ${TODAY} 15:00 Walk after lunch.`),
    NOW,
    ZERO
  );
  const original = nudgeRepo.upcomingNudges(db, NOW, ZERO)[0];
  const LATE = new Date(NOW);
  LATE.setHours(14, 57, 0, 0);
  const out = nudgeRepo.applyNudgeReply(
    db,
    parseNudgeReply(
      `NUDGE ${TODAY} 15:00 Walk after lunch.\nNUDGE ${TOMORROW} 08:00 Pack the gym bag.`
    ),
    LATE,
    ZERO
  );
  out.cancelled.length === 0 &&
  out.kept.length === 1 &&
  out.added.length === 1 &&
  nudgeRepo.getNudge(db, original.id).status === 'pending' &&
  nudgeRepo
    .upcomingNudges(db, LATE, ZERO)
    .map((n) => n.time)
    .join(',') === '15:00,08:00'
    ? ok(
        'restated three minutes out, it keeps its row; the new one joins it (the reviewer’s probe)'
      )
    : bad('restatement cancelled', JSON.stringify(out));
  const fresh = nudgeRepo.applyNudgeReply(
    db,
    parseNudgeReply(`NUDGE ${TODAY} 15:01 A new line four minutes out.`),
    LATE,
    ZERO
  );
  fresh.rejected[0]?.reason === 'past'
    ? ok('…but a NEW line that close is still refused: the exemption is for restatements only')
    : bad('new line inside the lead accepted', JSON.stringify(fresh));
}

console.log('N15. the pass knows the time, and hears what was refused last time');
{
  const { db } = freshDb();
  const directive = passDirective(
    { kind: 'daily' },
    TODAY,
    nudgeRepo.nudgeDirectiveFor(db, NOW, ZERO)
  );
  directive.includes(`It is now 12:00 on ${TODAY}.`) &&
  directive.includes('at least 5 minutes after') &&
  directive.includes('12:00 and within the next 36 hours')
    ? ok('the directive carries the wall clock, so "today" lines are not a guess')
    : bad('no clock in the directive', directive);
  const EVENING = new Date(NOW);
  EVENING.setHours(19, 42, 0, 0);
  passDirective(
    { kind: 'checkin', part: 'evening' },
    TODAY,
    nudgeRepo.nudgeDirectiveFor(db, EVENING, ZERO)
  ).includes('It is now 19:42')
    ? ok('…and the evening pass is told the actual time, not only "after 18:00"')
    : bad('evening clock');

  nudgeRepo.applyNudgeReply(
    db,
    parseNudgeReply(
      [
        `NUDGE ${TOMORROW} 08:00 HRV 38, go easy.`,
        `NUDGE ${TOMORROW} 23:00 Lights out.`,
        'NUDGE tomorrow morning Walk.',
        `NUDGE ${TOMORROW} 09:00 Walk after breakfast.`,
      ].join('\n')
    ),
    NOW,
    ZERO
  );
  const told = passDirective({ kind: 'daily' }, TODAY, nudgeRepo.nudgeDirectiveFor(db, NOW, ZERO));
  told.includes('Not planned from your last pass:') &&
  told.includes(`${TOMORROW} 08:00 HRV 38, go easy. (it had a number in it)`) &&
  told.includes(`${TOMORROW} 23:00 Lights out. (inside quiet hours)`) &&
  told.includes('NUDGE tomorrow morning Walk. (not in the NUDGE YYYY-MM-DD HH:MM text form)') &&
  !told.includes('Walk after breakfast. (')
    ? ok('the next pass is told each refused line and the rule that refused it')
    : bad('refusals not told', told);
  nudgeRepo.applyNudgeReply(db, parseNudgeReply('SKIP'), NOW, ZERO);
  !passDirective({ kind: 'daily' }, TODAY, nudgeRepo.nudgeDirectiveFor(db, NOW, ZERO)).includes(
    'Not planned'
  ) && nudgeRepo.getRefusedNudges(db).length === 0
    ? ok('…and only the LAST pass’s: a pass with nothing refused clears the memory')
    : bad('refusals outlived the next pass');
  nudgeRepo.saveNudgeSettings(db, { quietStart: '22:00' }, NOW, ZERO);
  nudgeRepo.getNudgeSettings(db).quietStart === '22:00'
    ? ok('the memory sits beside the settings, so a settings save cannot wipe or corrupt it')
    : bad('settings');
}

console.log('N16. a late day boundary: a small-hours nudge belongs to the day before');
{
  const LATE_BOUNDARY = '04:00';
  const { db } = freshDb();
  nudgeRepo.saveNudgeSettings(db, { quietStart: '00:00', quietEnd: '00:00' }, NOW, LATE_BOUNDARY);
  const NIGHT = new Date(NOW);
  NIGHT.setHours(23, 0, 0, 0);
  const out = nudgeRepo.applyNudgeReply(
    db,
    parseNudgeReply(`NUDGE ${TODAY} 01:30 Screens off, lights out.`),
    NIGHT,
    LATE_BOUNDARY
  );
  const fires = new Date(NOW);
  fires.setDate(fires.getDate() + 1);
  fires.setHours(1, 30, 0, 0);
  out.added.length === 1 && out.added[0].when.getTime() === fires.getTime()
    ? ok('01:30 on the logical day fires at 01:30 on the NEXT calendar day, not 22 hours ago')
    : bad('small-hours fire instant', JSON.stringify(out));
  const ZERO_OUT = nudgeRepo.applyNudgeReply(
    freshDb().db,
    parseNudgeReply(`NUDGE ${TODAY} 01:30 Screens off, lights out.`),
    NIGHT,
    ZERO
  );
  ZERO_OUT.rejected[0]?.reason === 'past'
    ? ok('…where under a midnight boundary the same line is in the past (the boundary is doing it)')
    : bad('midnight boundary', JSON.stringify(ZERO_OUT));

  const AFTER_MIDNIGHT = new Date(fires);
  AFTER_MIDNIGHT.setHours(0, 30, 0, 0);
  const listed = nudgeRepo.upcomingNudges(db, AFTER_MIDNIGHT, LATE_BOUNDARY);
  const context = nudgeRepo.nudgeDirectiveFor(db, AFTER_MIDNIGHT, LATE_BOUNDARY);
  listed.length === 1 &&
  context.today === TODAY &&
  context.pending.some((n) => n.day === TODAY && n.time === '01:30') &&
  nudgeRepo.describeNudgePlan({ ...out, kept: [], changed: true }, context.today) ===
    'Planned notifications\ntoday, 01:30 · Screens off, lights out.'
    ? ok('at 00:30 it is still that logical day: listed, told to the pass, and called "today"')
    : bad('after midnight', JSON.stringify({ listed, context }));

  const AFTER_IT = new Date(fires);
  AFTER_IT.setHours(2, 0, 0, 0);
  nudgeRepo.upcomingNudges(db, AFTER_IT, LATE_BOUNDARY).length === 0 &&
  nudgeRepo.nudgeDirectiveFor(db, AFTER_IT, LATE_BOUNDARY).sentToday.some((n) => n.time === '01:30')
    ? ok('at 02:00 it went out: no longer ahead, and counted as sent on its own logical day')
    : bad('after it fired');
  const cap = nudgeRepo.applyNudgeReply(
    db,
    parseNudgeReply(
      `NUDGE ${TODAY} 02:30 One more.\nNUDGE ${TODAY} 03:00 And another.\nNUDGE ${TODAY} 03:30 Too many.`
    ),
    AFTER_IT,
    LATE_BOUNDARY
  );
  cap.added.length === 1 && cap.rejected.map((r) => r.reason).join(',') === 'day-cap,day-cap'
    ? ok('the day cap counts it against the logical day it belongs to')
    : bad('late-boundary cap', JSON.stringify(cap));

  // The daily pass under the same boundary, told the logical day and the clock.
  setDayStartsAt(LATE_BOUNDARY);
  try {
    const text = passDirective(
      { kind: 'daily' },
      todayISODate(AFTER_MIDNIGHT),
      nudgeRepo.nudgeDirectiveFor(db, AFTER_MIDNIGHT)
    );
    text.includes(`It is now 00:30 on ${TODAY}.`)
      ? ok('a pass at 00:30 is told the logical day it is in, with the real clock')
      : bad('late-boundary directive', text);
  } finally {
    setDayStartsAt(ZERO);
  }
}

console.log('N17. the tap lands where its answer is');
{
  const plain = { kind: 'reminder', id: 'r1', checkin: false };
  const checkin = { kind: 'reminder', id: 'r2', checkin: true };
  const land = (route) => coachTapLanding(coachTapParams(route));
  JSON.stringify(land(plain)) === JSON.stringify({ highlight: 'r1', scroll: 'top' })
    ? ok('a plain reminder: its row is marked, and the tab goes to the top where it is')
    : bad('plain landing', JSON.stringify(land(plain)));
  JSON.stringify(land(checkin)) === JSON.stringify({ highlight: 'r2', scroll: 'end' })
    ? ok('a CHECK-IN: the row is marked, but the tab goes to the END, where the Coach answers')
    : bad('check-in landing', JSON.stringify(land(checkin)));
  land({ kind: 'nudge', id: 'n1' }).scroll === 'end' && land({ kind: 'checkin' }).scroll === 'end'
    ? ok('a nudge and the morning check-in go to the end too — the line, or the answer, is there')
    : bad('nudge / morning landing');
  JSON.stringify(coachTapLanding({})) === JSON.stringify({ highlight: null, scroll: null })
    ? ok('no tap, no scroll: an ordinary open of the tab is left alone')
    : bad('no-tap landing');
  Object.keys(coachTapParams({ kind: 'mission' })).length === 0
    ? ok('a protocol item carries nothing for the Coach tab (it lands on Home)')
    : bad('mission params');

  const response = (identifier, date) => ({
    notification: { date, request: { identifier, content: { data: { kind: 'checkin' } } } },
  });
  const monday = Date.UTC(2026, 8, 28, 14, 30);
  const tuesday = Date.UTC(2026, 8, 29, 14, 30);
  tapKey(response('morning', monday)) === tapKey(response('morning', monday))
    ? ok('one delivery handed over twice on a cold start is one tap')
    : bad('cold-start double not collapsed');
  tapKey(response('morning', monday)) !== tapKey(response('morning', tuesday))
    ? ok('a DAILY repeat fires under the same identifier tomorrow, and that tap is a new one')
    : bad('repeat swallowed');
  tapKey({ notification: { request: { content: {} } } }) === null
    ? ok('no identifier, nothing to remember it by')
    : bad('key without identifier');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
