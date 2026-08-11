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

import { todayISODate } from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { createExperiment } from '../src/lib/db/repositories/experiments.ts';
import { listMission } from '../src/lib/db/repositories/mission.ts';
import { generateMissionForDay } from '../src/lib/db/repositories/mission-generate.ts';
import { createProtocolWithVersion } from '../src/lib/db/repositories/protocols.ts';
import { computeInsights } from '../src/lib/ai/insights.ts';
import { isoDaysAgo } from '../src/lib/ai/series.ts';
import { passDirective, PASS_SKIP } from '../src/lib/ai/coach-pass.ts';
import {
  currentSignals,
  duePass,
  getPassState,
  markPassRan,
  setPassState,
} from '../src/lib/ai/pass-schedule.ts';
import { routeForNotification } from '../src/lib/notifications/reminders.ts';
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

const NOW = new Date();
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
  routeForNotification({ reminderId: 'r1' })?.kind === 'reminder'
    ? ok('a reminder tap routes to the reminder')
    : bad('reminder route');
  routeForNotification({ kind: 'checkin' })?.kind === 'coach'
    ? ok('a check-in tap opens the Coach')
    : bad('checkin route');
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
  row && row.protocol === 'Experiment · Magnesium PM'
    ? ok('labelled as the experiment, not as a protocol item')
    : bad('label', row && row.protocol);
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

console.log('7. abandon_experiment exists so a broken run needs no fabricated verdict');
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
  toolByName('abandon_experiment').confirmSummary({ id, reason: 'Sauna was closed all week' }, db, CTX)
    .includes('Sauna nightly')
    ? ok('the card names the experiment and the reason')
    : bad('abandon card');
  const result = run('abandon_experiment', db, { id, reason: 'Sauna was closed all week' });
  result.abandoned ? ok('it abandons cleanly') : bad('abandon failed', JSON.stringify(result));
  throws(() => run('abandon_experiment', db, { id, reason: 'again' }))
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
  const { listMessages, getOrCreateActiveConversation } = await import(
    '../src/lib/db/repositories/ai-chat.ts'
  );

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
      coachPassStore.maybeRun(db, { unlocked: true, now: NOW, fetchImpl: fetchFor(sse('One.'), counter) }),
      coachPassStore.maybeRun(db, { unlocked: true, now: NOW, fetchImpl: fetchFor(sse('One.'), counter) }),
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
    outcome === 'offline' ? ok('a failed pass reports offline, not silence') : bad('offline', outcome);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
