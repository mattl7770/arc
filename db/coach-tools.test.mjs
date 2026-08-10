/**
 * Headless test of the Coach tool registry (src/lib/ai/tools/) against real
 * SQLite via node:sqlite — each tool's execute really reads/writes the same
 * tables the capture screens use. Mirrors db/nutrition.test.mjs; op-sqlite and
 * the model client are never loaded. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { apiKeyStore } from '../src/lib/ai/api-key-store.ts';
import { todayISODate } from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { createProtocolWithVersion } from '../src/lib/db/repositories/protocols.ts';
import { weekSummary } from '../src/lib/db/repositories/exercise.ts';
import { setUnitPreference } from '../src/lib/db/repositories/user.ts';
import { SOURCE_PRIORITY, upsertWearableRows } from '../src/lib/db/repositories/wearables.ts';
// The real ingest mappers — fixtures below are built by the pipeline that runs
// on device, not by hand-written rows that only resemble it.
import {
  STATISTIC_METRICS,
  sleepDailyRows,
  statisticDailyRows,
} from '../src/lib/health/mapping.ts';
import { deriveReadiness } from '../src/lib/home/readiness.ts';
import { isoDaysAgo } from '../src/lib/ai/series.ts';
import {
  COACH_TOOLS,
  READ_TOOLS,
  STUB_TOOLS,
  WRITE_TOOLS,
  toolByName,
  toWireTools,
} from '../src/lib/ai/tools/index.ts';

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
const near = (a, b, eps = 0.05) => typeof a === 'number' && Math.abs(a - b) < eps;
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
/** For tools whose execute is async — set_reminder resyncs the OS schedule so it
 * can report what was really scheduled, which can only be known by asking. */
const runAsync = async (name, db, input = {}) =>
  JSON.parse(await toolByName(name).execute(db, input, CTX));
const rejects = async (fn) => {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
};

console.log('0. registry shape: unique names, read/write split, wire mapping');
{
  const names = COACH_TOOLS.map((t) => t.name);
  new Set(names).size === names.length
    ? ok(`tool names unique (${names.length} registered)`)
    : bad('duplicate names', names.join(','));
  READ_TOOLS.every((t) => t.readOnly) ? ok('read tools are readOnly') : bad('read/readOnly');
  WRITE_TOOLS.every((t) => !t.readOnly && typeof t.confirmSummary === 'function')
    ? ok('every write tool is gated and has a confirmSummary')
    : bad('write tools shape');
  STUB_TOOLS.every((t) => !names.includes(t.name))
    ? ok('stub tools (protocols/modes/navigation…) are NOT registered')
    : bad('stub leaked into registry');
  const wire = toWireTools();
  wire.length === names.length &&
  wire.every((t) => t.name && t.description && t.input_schema && t.input_schema.type === 'object')
    ? ok('toWireTools maps name/description/input_schema')
    : bad('wire shape');
}

console.log('1. get_today_snapshot: empty day is zeros, then reflects writes');
{
  const { db } = freshDb();
  const empty = run('get_today_snapshot', db);
  empty.date === TODAY &&
  empty.meals.length === 0 &&
  empty.workouts.length === 0 &&
  empty.symptoms.length === 0 &&
  empty.remindersDueToday.length === 0
    ? ok('empty snapshot is empty, not fabricated')
    : bad('empty snapshot', JSON.stringify(empty));

  run('log_meal', db, { name: 'Salmon bowl', time: '12:30', kcal: 700, protein_g: 45 });
  run('log_workout', db, { name: 'Zone 2', kind: 'cardio', duration_min: 40 });
  run('log_symptom', db, { name: 'Headache', severity: 4 });
  run('log_capture', db, { type: 'supplement', title: 'Creatine · 5 g' });
  await runAsync('set_reminder', db, { title: 'Take magnesium', time: '21:00', repeat: 'daily' });

  const snap = run('get_today_snapshot', db);
  snap.meals.length === 1 &&
  near(snap.nutritionTotals.protein_g, 45) &&
  snap.workouts.length === 1 &&
  snap.symptoms.length === 1 &&
  snap.captures.some((c) => c.title === 'Creatine · 5 g') &&
  snap.remindersDueToday.length === 1
    ? ok('snapshot reflects meal, workout, symptom, capture, reminder')
    : bad('populated snapshot', JSON.stringify(snap));
}

console.log('2. log_metric: display-unit input lands canonical in the right table');
{
  const { db, raw } = freshDb();
  const out = run('log_metric', db, { metric: 'weight', value: 178 });
  out.logged === true ? ok('log_metric reports logged') : bad('result', JSON.stringify(out));
  const row = raw.prepare('SELECT weight_kg, source FROM body_metrics').get();
  row && near(row.weight_kg, 80.74) && row.source === 'manual'
    ? ok('178 lb stored as ~80.74 kg canonical (body_metrics)')
    : bad('canonical weight', JSON.stringify(row));

  run('log_metric', db, { metric: 'weight', value: 81, unit: 'kg' });
  const rows = raw.prepare('SELECT weight_kg FROM body_metrics ORDER BY created_at').all();
  near(rows[1]?.weight_kg, 81, 1e-6)
    ? ok('explicit unit token ("kg") bypasses the display-unit conversion')
    : bad('unit token', JSON.stringify(rows));

  run('log_metric', db, { metric: 'hrv', value: 48 });
  const hrv = raw.prepare(`SELECT * FROM wearable_data WHERE metric_type = 'hrv'`).get();
  hrv && hrv.value === 48 && hrv.date === TODAY && hrv.source_device === 'manual'
    ? ok('hrv lands in wearable_data as manual, keyed to today')
    : bad('hrv row', JSON.stringify(hrv));

  throws(() => run('log_metric', db, { metric: 'weight', value: -5 }))
    ? ok('out-of-range value rejected before any write')
    : bad('bad value accepted');
  throws(() => run('log_metric', db, { metric: 'weight', value: 80, unit: 'stone' }))
    ? ok('unknown unit token rejected with the valid set named')
    : bad('bad unit accepted');
  throws(() => run('log_metric', db, { metric: 'steps', value: 100 }))
    ? ok('unknown metric rejected')
    : bad('bad metric accepted');

  const summary = toolByName('log_metric').confirmSummary({ metric: 'weight', value: 178 }, db);
  summary === 'Log weight 178 lb'
    ? ok(`confirmSummary is the human line ("${summary}")`)
    : bad('confirm summary', summary);
}

console.log('3. log_workout writes the session and its sets transactionally');
{
  const { db, raw } = freshDb();
  run('log_workout', db, {
    name: 'Upper A',
    kind: 'strength',
    duration_min: 55,
    sets: [
      { exercise: 'Bench', reps: 8, weight: 80, unit: 'kg' },
      { exercise: 'Bench', reps: 8, weight: 80, unit: 'kg' },
    ],
  });
  raw.prepare('SELECT count(*) c FROM workouts').get().c === 1 &&
  raw.prepare('SELECT count(*) c FROM workout_sets WHERE weight_kg = 80').get().c === 2
    ? ok('workout + 2 sets persisted with their weights')
    : bad('workout rows');
  throws(() => run('log_workout', db, { name: 'X', kind: 'swimming' }))
    ? ok('unknown kind rejected')
    : bad('bad kind accepted');
  throws(() => run('log_workout', db, { name: 'X', kind: 'strength', sets: [{ reps: 5 }] }))
    ? ok('a set without an exercise name rejected')
    : bad('bad set accepted');
}

console.log('4. log_symptom and log_meal validate before writing');
{
  const { db, raw } = freshDb();
  throws(() => run('log_symptom', db, { name: 'Headache', severity: 11 }))
    ? ok('severity 11 rejected')
    : bad('severity 11 accepted');
  throws(() => run('log_meal', db, { name: 'Lunch', time: '25:00' }))
    ? ok('impossible clock time rejected (25:00)')
    : bad('25:00 accepted');
  throws(() => run('log_meal', db, {}))
    ? ok('a meal without a name rejected')
    : bad('nameless meal accepted');
  raw.prepare('SELECT count(*) c FROM meals').get().c === 0 &&
  raw.prepare('SELECT count(*) c FROM symptoms').get().c === 0
    ? ok('failed validations wrote nothing')
    : bad('partial writes');
}

console.log('5. reminders end to end: set → list → complete/dismiss, with guards');
{
  const { db, raw } = freshDb();
  const daily = await runAsync('set_reminder', db, {
    title: 'Take magnesium',
    time: '21:00',
    repeat: 'daily',
  });
  raw.prepare('SELECT created_by FROM reminders WHERE id = ?').get(daily.id).created_by === 'ai'
    ? ok('tool-created reminder records created_by = ai')
    : bad('created_by');

  // The result must state what REALLY happened, not what the description hopes:
  // under node there is no expo-notifications module, so a schedulable reminder
  // reports module-unavailable and scheduled=false. That is the honesty contract.
  daily.notification &&
  daily.notification.scheduled === false &&
  daily.notification.reason === 'module-unavailable' &&
  /no phone alert will fire/.test(daily.notification.note)
    ? ok('set_reminder reports the OBSERVED delivery outcome (module-unavailable here)')
    : bad('delivery report', JSON.stringify(daily.notification));

  const listed = run('list_reminders', db);
  listed.reminders.length === 1 &&
  listed.reminders[0].title === 'Take magnesium' &&
  listed.reminders[0].dueToday === true
    ? ok('list_reminders surfaces it, due today (daily)')
    : bad('list', JSON.stringify(listed));

  // Completing a RECURRING reminder would end it permanently — guarded.
  throws(() => run('complete_reminder', db, { id: daily.id }))
    ? ok('complete_reminder refuses a daily reminder (would end it for good)')
    : bad('recurring completed');

  const once = await runAsync('set_reminder', db, { title: 'Book DEXA', repeat: 'once' });
  once.notification &&
  once.notification.scheduled === false &&
  once.notification.reason === 'no-time'
    ? ok('an untimed reminder reports no-time, not a permission excuse')
    : bad('untimed delivery report', JSON.stringify(once.notification));
  once.date === null
    ? ok('an untimed one-off reports date: null (there was no day to pin)')
    : bad('untimed date', JSON.stringify(once.date));

  // A TIMED one-off gets its day pinned as it is saved, and the tool must report
  // the day it ACTUALLY landed on — the model relays that day to the user, and
  // it is the difference between "tomorrow 9am" and a reminder that fires daily
  // forever. Fixed clock: Fri 2026-08-07 22:00 local, so 09:00 has gone by.
  {
    const lateCtx = { now: new Date(2026, 7, 7, 22, 0, 0, 0) };
    const tool = toolByName('set_reminder');
    const rolled = JSON.parse(
      await tool.execute(db, { title: 'Call the clinic', time: '09:00' }, lateCtx)
    );
    rolled.date === '2026-08-08' && rolled.repeat === 'once'
      ? ok('set_reminder at 22:00 for "09:00" reports date 2026-08-08 (tomorrow), truthfully')
      : bad('rolled one-off report', JSON.stringify(rolled));
    raw.prepare('SELECT date FROM reminders WHERE id = ?').get(rolled.id).date === '2026-08-08'
      ? ok('  → and that day is PERSISTED, so no later resync can move it again')
      : bad('rolled one-off not persisted');
    // Pinned in the future ⇒ genuinely schedulable, so the honest blocker under
    // node is the missing native module, not "moment-passed".
    rolled.notification.scheduled === false && rolled.notification.reason === 'module-unavailable'
      ? ok('  → schedulable, so it reports module-unavailable (not moment-passed)')
      : bad('rolled delivery report', JSON.stringify(rolled.notification));

    const sameDay = JSON.parse(
      await tool.execute(db, { title: 'Take magnesium', time: '23:30' }, lateCtx)
    );
    sameDay.date === '2026-08-07'
      ? ok('set_reminder at 22:00 for "23:30" reports date 2026-08-07 (today)')
      : bad('same-day one-off report', JSON.stringify(sameDay));

    // An explicitly back-dated one-off is unschedulable and must say so.
    const backdated = JSON.parse(
      await tool.execute(db, { title: 'Missed dose', time: '09:00', date: '2026-08-01' }, lateCtx)
    );
    backdated.date === '2026-08-01' &&
    backdated.notification.scheduled === false &&
    backdated.notification.reason === 'moment-passed'
      ? ok('an explicitly back-dated one-off keeps its day and reports moment-passed')
      : bad('backdated report', JSON.stringify(backdated));

    // The CONFIRMATION CARD must name that pinned day before the user approves.
    // "Set reminder … at 09:00" approved at 22:00 silently writes a row dated
    // tomorrow, so the summary takes the same turn context execute does and
    // resolves the day off the same clock. Formatted by hand — Hermes has no Intl.
    const summaryWith = (input) => tool.confirmSummary(input, db, lateCtx);
    summaryWith({ title: 'Call the clinic', time: '09:00' }) ===
    'Set reminder "Call the clinic" at 09:00 · tomorrow (Sat 8 Aug)'
      ? ok('confirmSummary names the day when a bare-time one-off pins to TOMORROW')
      : bad('summary tomorrow', summaryWith({ title: 'Call the clinic', time: '09:00' }));
    summaryWith({ title: 'Take magnesium', time: '23:30' }) ===
    'Set reminder "Take magnesium" at 23:30'
      ? ok('  → and stays silent about the day when it pins to today (nothing to warn about)')
      : bad('summary today', summaryWith({ title: 'Take magnesium', time: '23:30' }));
    summaryWith({ title: 'Missed dose', time: '09:00', date: '2026-08-01' }) ===
    'Set reminder "Missed dose" at 09:00 · 2026-08-01 (Sat 1 Aug)'
      ? ok('  → an explicit day is still shown, ISO plus its weekday')
      : bad('summary explicit date', summaryWith({ title: 'Missed dose', date: '2026-08-01' }));
    summaryWith({ title: 'Weigh in', time: '07:30', repeat: 'weekly', date: '2026-08-03' }) ===
    'Set reminder "Weigh in" at 07:30 · weekly · 2026-08-03 (Mon 3 Aug)'
      ? ok('  → a weekly anchor is printed as a day, never as "tomorrow"')
      : bad('summary weekly anchor');
    // An UNTIMED one-off derives no day at all, so its card must be identical
    // whatever the clock says — the day suffix appears only when there is a day.
    const earlyCtx = { now: new Date(2026, 7, 7, 0, 1, 0, 0) };
    summaryWith({ title: 'Book DEXA' }) === 'Set reminder "Book DEXA"' &&
    tool.confirmSummary({ title: 'Book DEXA' }, db, earlyCtx) === 'Set reminder "Book DEXA"'
      ? ok('  → an untimed one-off derives no day, so its card is clock-independent')
      : bad('summary untimed', summaryWith({ title: 'Book DEXA' }));

    // Housekeeping: these three would otherwise pollute the list assertions below.
    for (const r of [rolled, sameDay, backdated]) run('dismiss_reminder', db, { id: r.id });
  }
  const summary = toolByName('complete_reminder').confirmSummary({ id: once.id }, db);
  summary === 'Mark reminder "Book DEXA" done'
    ? ok(`confirmation names the target, never a bare id ("${summary}")`)
    : bad('confirm summary', summary);
  const completed = run('complete_reminder', db, { id: once.id });
  completed.completed === true &&
  run('list_reminders', db).reminders.every((r) => r.title !== 'Book DEXA')
    ? ok('complete_reminder retires the one-off from the active list')
    : bad('complete');

  const dismissSummary = toolByName('dismiss_reminder').confirmSummary({ id: daily.id }, db);
  dismissSummary === 'Dismiss reminder "Take magnesium"'
    ? ok('dismiss confirmation names the target too')
    : bad('dismiss summary', dismissSummary);
  run('dismiss_reminder', db, { id: daily.id });
  run('list_reminders', db).reminders.length === 0
    ? ok('dismiss_reminder ends the daily one')
    : bad('dismiss');

  throws(() => run('dismiss_reminder', db, { id: 'nope' }))
    ? ok('unknown reminder id rejected with guidance')
    : bad('unknown id accepted');
  (await rejects(() => runAsync('set_reminder', db, { title: 'Weekly check', repeat: 'weekly' })))
    ? ok('weekly without an anchor date rejected at the tool layer')
    : bad('anchorless weekly accepted');
}

console.log('6. get_metric_series returns display units with honest stats');
{
  const { db } = freshDb();
  run('log_metric', db, { metric: 'weight', value: 178 });
  run('log_metric', db, { metric: 'weight', value: 180 });
  const series = run('get_metric_series', db, { metric: 'weight', days: 7 });
  series.unit === 'lb' && series.points.length === 1 && near(series.points[0].value, 179, 0.2)
    ? ok('two same-day weigh-ins average to one daily point, in lb')
    : bad('series', JSON.stringify(series));
  series.stats && series.stats.count === 1
    ? ok('stats ride along')
    : bad('stats', JSON.stringify(series.stats));

  const empty = run('get_metric_series', db, { metric: 'hrv' });
  empty.points.length === 0 && empty.stats === null
    ? ok('an unlogged metric returns empty points + null stats (nothing invented)')
    : bad('empty series', JSON.stringify(empty));

  throws(() => run('get_metric_series', db, { metric: 'weight', days: 0 }))
    ? ok('days: 0 rejected')
    : bad('days 0 accepted');
}

console.log('7. get_nutrition_summary + get_training_summary aggregate honestly');
{
  const { db } = freshDb();
  run('log_meal', db, { name: 'A', kcal: 600, protein_g: 40 });
  run('log_meal', db, { name: 'B', kcal: 800, protein_g: 50 });
  const nutrition = run('get_nutrition_summary', db, { days: 7 });
  nutrition.loggedDays === 1 &&
  near(nutrition.averagesAcrossLoggedDays.kcal, 1400) &&
  near(nutrition.averagesAcrossLoggedDays.protein_g, 90)
    ? ok('nutrition day totals + averages across logged days')
    : bad('nutrition', JSON.stringify(nutrition));

  run('log_workout', db, { name: 'Zone 2', kind: 'cardio', duration_min: 45 });
  run('log_workout', db, { name: 'Upper', kind: 'strength', duration_min: 50 });
  const training = run('get_training_summary', db, { days: 28 });
  training.totals.sessions === 2 &&
  near(training.totals.cardioMinutes, 45) &&
  training.totals.strengthSessions === 1 &&
  training.recentSessions.length === 2
    ? ok('training totals, split by kind, with recent sessions')
    : bad('training', JSON.stringify(training));
}

console.log('8. get_biomarkers: honest when empty, real when a result exists');
{
  const { db, raw } = freshDb();
  const empty = run('get_biomarkers', db);
  empty.resultsAvailable === 0 && typeof empty.note === 'string'
    ? ok('no lab results → says so instead of inventing values')
    : bad('empty biomarkers', JSON.stringify(empty));

  raw
    .prepare(
      `INSERT INTO biomarkers (id, slug, name, category, unit, optimal_range_low, optimal_range_high)
       VALUES ('b1', 'apob', 'ApoB', 'cardiovascular', 'mg/dL', 20, 60)`
    )
    .run();
  raw
    .prepare(
      `INSERT INTO lab_results (id, biomarker_id, value, collected_at, source)
       VALUES ('r1', 'b1', 78, '2026-06-01', 'manual')`
    )
    .run();
  const withData = run('get_biomarkers', db, { category: 'cardiovascular' });
  withData.resultsAvailable === 1 &&
  withData.results[0].slug === 'apob' &&
  withData.results[0].value === 78 &&
  withData.results[0].optimal_range_high === 60
    ? ok('latest value + optimal range returned for the filter')
    : bad('biomarkers', JSON.stringify(withData));
}

console.log('9. get_insights wraps the deterministic engine');
{
  const { db } = freshDb();
  const out = run('get_insights', db);
  Array.isArray(out.insights) && typeof out.briefLine === 'string'
    ? ok('insights array + brief line, no model involved')
    : bad('insights', JSON.stringify(out));
}

console.log('10. backdating: an explicit date lands on that day and shows in the summary');
{
  const { db, raw } = freshDb();
  run('log_meal', db, { name: 'Late dinner', kcal: 800, date: '2026-07-20' });
  raw.prepare('SELECT date FROM meals').get().date === '2026-07-20'
    ? ok('log_meal date param writes the stated day, not today')
    : bad('backdated meal');
  const summary = toolByName('log_meal').confirmSummary(
    { name: 'Late dinner', kcal: 800, date: '2026-07-20' },
    db
  );
  summary.includes('· 2026-07-20') && summary.includes('800 kcal')
    ? ok(`confirmation shows the backdate and the macros ("${summary}")`)
    : bad('backdate summary', summary);
  throws(() => run('log_meal', db, { name: 'Bad', date: '2026-13-45' }))
    ? ok('an impossible calendar date is rejected before the DB')
    : bad('2026-13-45 accepted');
  run('log_workout', db, { name: 'Zone 2', kind: 'cardio', duration_min: 40, date: '2026-07-19' });
  raw.prepare('SELECT date FROM workouts').get().date === '2026-07-19'
    ? ok('log_workout backdates too')
    : bad('backdated workout');
}

console.log('11. set weights arrive in display lb and store canonical kg');
{
  const { db, raw } = freshDb();
  run('log_workout', db, {
    name: 'Upper A',
    kind: 'strength',
    sets: [
      { exercise: 'Bench', reps: 8, weight: 225 },
      { exercise: 'Press', reps: 5, weight: 60, unit: 'kg' },
    ],
  });
  const sets = raw.prepare('SELECT exercise, weight_kg FROM workout_sets ORDER BY set_index').all();
  near(sets[0]?.weight_kg, 225 / 2.2046226218, 1e-6)
    ? ok('225 (lb, the default) stored as ~102.06 kg canonical')
    : bad('lb set', JSON.stringify(sets));
  near(sets[1]?.weight_kg, 60, 1e-9)
    ? ok('unit "kg" passes through unconverted')
    : bad('kg set', JSON.stringify(sets));
  const summary = toolByName('log_workout').confirmSummary(
    { name: 'Upper A', kind: 'strength', sets: [{ exercise: 'Bench', reps: 8, weight: 225 }] },
    db
  );
  summary.includes('Bench 8 × 225 lb')
    ? ok(`confirmation shows the sets in display units ("${summary}")`)
    : bad('set summary', summary);
}

console.log('12. sub-week training windows refuse to extrapolate a weekly rate');
{
  const { db } = freshDb();
  run('log_workout', db, { name: 'Zone 2', kind: 'cardio', duration_min: 60 });
  const training = run('get_training_summary', db, { days: 1 });
  training.weeklyRates === null && near(training.totals.minutes, 60)
    ? ok('days: 1 reports totals but a null weeklyRates (no 420 min/week fiction)')
    : bad('weekly extrapolation', JSON.stringify(training));
}

console.log('13. protocols: get_protocols reads live items; update_protocol versions like code');
{
  const { db, raw } = freshDb();
  // Seed an "evening stack" through the same repo path the editor uses.
  const protocolId = createProtocolWithVersion(
    db,
    { name: 'Evening Stack', type: 'supplement_stack' },
    {
      items: [
        { title: 'Magnesium Glycinate', scheduled_time: '21:00', dose: '200 mg', notes: null },
        { title: 'Vitamin D3', scheduled_time: '21:00', dose: '5000 IU', notes: null },
      ],
    },
    'seed'
  );
  const slug = raw.prepare('SELECT slug FROM protocols WHERE id = ?').get(protocolId).slug;

  const view = run('get_protocols', db);
  const stack = view.protocols.find((p) => p.slug === slug);
  stack &&
  stack.name === 'Evening Stack' &&
  stack.versionNumber === 1 &&
  stack.items.length === 2 &&
  stack.items[0].title === 'Magnesium Glycinate' &&
  stack.items[0].dose === '200 mg'
    ? ok('get_protocols returns the stack with its current items')
    : bad('get_protocols', JSON.stringify(view));

  // The magnesium scenario: read the current items, resubmit the COMPLETE list
  // plus the change. The confirmation shows the count delta so a wipe is visible.
  const changeInput = {
    protocol_slug: slug,
    items: [
      { title: 'Magnesium Glycinate', scheduled_time: '21:00', dose: '400 mg' },
      { title: 'Vitamin D3', scheduled_time: '21:00', dose: '5000 IU' },
      { title: 'Zinc', scheduled_time: '21:00', dose: '15 mg' },
    ],
    change_notes: 'Bumped magnesium to 400 mg, added zinc',
  };
  const summary = toolByName('update_protocol').confirmSummary(changeInput, db);
  summary === 'Update "Evening Stack": 3 items (was 2) — Bumped magnesium to 400 mg, added zinc'
    ? ok(`confirmation shows the item-count delta ("${summary}")`)
    : bad('update summary', summary);

  const out = run('update_protocol', db, changeInput);
  out.updated === true && out.versionNumber === 2 && out.itemCount === 3 && out.protocol === slug
    ? ok('update_protocol writes version 2 with 3 items')
    : bad('update result', JSON.stringify(out));

  const versionCount = raw
    .prepare('SELECT count(*) c FROM protocol_versions WHERE protocol_id = ?')
    .get(protocolId).c;
  const current = raw
    .prepare(
      `SELECT v.version_number, v.created_by, json_array_length(v.content, '$.items') n
       FROM protocols p JOIN protocol_versions v ON v.id = p.current_version_id WHERE p.id = ?`
    )
    .get(protocolId);
  versionCount === 2 &&
  current.version_number === 2 &&
  current.created_by === 'ai' &&
  current.n === 3
    ? ok('v1 preserved; current_version_id points at the ai-authored v2 (3 items)')
    : bad('versioning', JSON.stringify({ versionCount, current }));

  const after = run('get_protocols', db).protocols.find((p) => p.slug === slug);
  after.versionNumber === 2 &&
  after.items.some((it) => it.title === 'Zinc') &&
  after.items.find((it) => it.title === 'Magnesium Glycinate').dose === '400 mg'
    ? ok('get_protocols now reads v2 (zinc added, magnesium at 400 mg)')
    : bad('post-update read', JSON.stringify(after));

  throws(() =>
    run('update_protocol', db, {
      protocol_slug: 'no_such_stack',
      items: [{ title: 'X' }],
      change_notes: 'y',
    })
  )
    ? ok('unknown slug rejected with guidance (call get_protocols first)')
    : bad('unknown slug accepted');
  throws(() =>
    run('update_protocol', db, {
      protocol_slug: slug,
      items: [{ dose: '5 g' }],
      change_notes: 'z',
    })
  )
    ? ok('an item without a title is rejected before any write')
    : bad('titleless item accepted');
}

console.log('14. unit preferences drive the Coach write + read path (a metric user)');
{
  const { db, raw } = freshDb();
  setUnitPreference(db, 'weight', 'kg');
  setUnitPreference(db, 'length', 'cm');
  setUnitPreference(db, 'volume', 'ml');

  // The bug this fixes: an unqualified "80" from a kg user must store 80 kg, not
  // 36 kg (the old imperial default). An explicit unit token still overrides.
  run('log_metric', db, { metric: 'weight', value: 80 });
  run('log_metric', db, { metric: 'weight', value: 80, unit: 'lb' });
  const weights = raw
    .prepare('SELECT weight_kg FROM body_metrics WHERE weight_kg IS NOT NULL ORDER BY rowid')
    .all();
  near(weights[0]?.weight_kg, 80, 1e-6)
    ? ok('kg-preference: unqualified weight 80 stores 80 kg, not 36')
    : bad('kg weight write', JSON.stringify(weights));
  near(weights[1]?.weight_kg, 80 / 2.2046226218, 1e-6)
    ? ok('an explicit "lb" token overrides the kg preference (80 lb → 36.3 kg)')
    : bad('lb override', JSON.stringify(weights));

  // The confirmation card must show the user's unit, so an approve isn't blind.
  const summary = toolByName('log_metric').confirmSummary({ metric: 'weight', value: 80 }, db);
  summary === 'Log weight 80 kg'
    ? ok(`confirmation card shows the user's unit ("${summary}")`)
    : bad('kg summary', summary);

  // An explicit-unit override still renders the card in the user's OWN unit
  // (kg here), so the shown value matches the app everywhere — intentional.
  const lbCard = toolByName('log_metric').confirmSummary(
    { metric: 'weight', value: 180, unit: 'lb' },
    db
  );
  lbCard === 'Log weight 81.6 kg'
    ? ok(`explicit "lb" from a kg user still shows the card in kg ("${lbCard}")`)
    : bad('lb-override card', lbCard);

  run('log_metric', db, { metric: 'waist', value: 90 });
  const waist = raw.prepare('SELECT waist_cm FROM body_metrics WHERE waist_cm IS NOT NULL').get();
  near(waist?.waist_cm, 90, 1e-6)
    ? ok('cm-preference: waist 90 stores 90 cm, not 228.6')
    : bad('cm waist', JSON.stringify(waist));

  run('log_metric', db, { metric: 'water', value: 500 });
  const water = raw.prepare(`SELECT value FROM wearable_data WHERE metric_type = 'water_ml'`).get();
  near(water?.value, 500, 1e-6)
    ? ok('ml-preference: water 500 stores 500 ml, not 14786')
    : bad('ml water', JSON.stringify(water));

  const series = run('get_metric_series', db, { metric: 'weight', days: 7 });
  series.unit === 'kg'
    ? ok('get_metric_series reports the series in kg for a kg user')
    : bad('series unit', JSON.stringify(series));

  // log_workout: an unqualified set weight follows the weight preference too.
  run('log_workout', db, {
    name: 'Squat',
    kind: 'strength',
    sets: [{ exercise: 'Squat', reps: 5, weight: 100 }],
  });
  const set = raw.prepare('SELECT weight_kg FROM workout_sets').get();
  near(set?.weight_kg, 100, 1e-6)
    ? ok('kg-preference: an unqualified set weight 100 stores 100 kg (not 45)')
    : bad('kg set', JSON.stringify(set));
  const wSummary = toolByName('log_workout').confirmSummary(
    { name: 'Squat', kind: 'strength', sets: [{ exercise: 'Squat', reps: 5, weight: 100 }] },
    db
  );
  wSummary.includes('100 kg')
    ? ok(`workout card renders the set in kg ("${wSummary}")`)
    : bad('kg set summary', wSummary);
}

console.log('15. get_training_summary.thisWeek is the calendar week (agrees with the Data tab)');
{
  const { db } = freshDb();
  // A fixed Monday so the calendar week and the rolling-7 window barely overlap —
  // the worst-case where the two definitions of "this week" disagree.
  const monday = new Date(2026, 6, 27); // Mon 2026-07-27 (local)
  const ctx = { now: monday };
  const sunday = isoDaysAgo(monday, 1); // 2026-07-26 — LAST calendar week, but in rolling-7
  const todayIso = todayISODate(monday); // 2026-07-27 — this calendar week

  const trainTool = toolByName('log_workout');
  trainTool.execute(db, { name: 'Sun ride', kind: 'cardio', duration_min: 30, date: sunday }, ctx);
  trainTool.execute(
    db,
    { name: 'Mon ride', kind: 'cardio', duration_min: 45, date: todayIso },
    ctx
  );

  const summary = JSON.parse(toolByName('get_training_summary').execute(db, { days: 7 }, ctx));
  const week = weekSummary(db, monday); // exactly what the Data tab renders as "this week"

  // thisWeek is the SAME number the Data tab shows (both call weekSummary): today only.
  summary.thisWeek.cardioMinutes === week.zone2Min && summary.thisWeek.cardioMinutes === 45
    ? ok('thisWeek = Monday-start calendar week (45 min today), identical to weekSummary')
    : bad('thisWeek vs weekSummary', JSON.stringify({ tw: summary.thisWeek, week }));

  // The rolling last-7-days totals DO include Sunday's session; thisWeek must not —
  // this is the divergence the fix pins down so the Coach never calls 75 "this week".
  near(summary.totals.cardioMinutes, 75) && summary.thisWeek.cardioMinutes === 45
    ? ok('rolling 7-day totals include the Sunday session (75); thisWeek excludes it (45)')
    : bad('rolling vs calendar', JSON.stringify(summary));
}

console.log('16. the REAL call site: one turn clock from confirmation card to written row');
{
  // Section 5 exercises `confirmSummary` by handing it a context directly — a
  // path the app never takes. The defect being covered here lived in the CALL
  // SITE: src/lib/ai/coach-service.ts is the only place a confirmation card is
  // rendered repo-wide, and it built the card off one `new Date()` and the row
  // off a second, later one, read AFTER awaiting the user's approval. So this
  // section drives coach-service itself, model stream and all, with the clock
  // injected and MOVED while the user "thinks".
  //
  // Loading that module under node needs three resolutions Metro/tsc do and raw
  // node ESM does not: `expo/fetch` (no node-resolvable entry point) and
  // `@/lib/db/client` (pulls in native op-sqlite) are stubbed to test doubles,
  // and `./tools` needs directory-index resolution. Nothing else is faked —
  // the agentic loop, the tool registry, the repositories and the SQLite writes
  // are the real ones.
  const { register } = await import('node:module');
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

  // --- A scripted Messages API stream (the wire shape model-client parses) ---
  const sse = (events) =>
    events.map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join('');

  const toolUseReply = (name, input) =>
    sse([
      { type: 'message_start', message: {} },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_clock', name, input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ]);

  const textReply = (text) =>
    sse([
      { type: 'message_start', message: {} },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
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
          read: async () =>
            sent ? { done: true } : ((sent = true), { done: false, value: bytes }),
        }),
      },
    };
  };

  /**
   * One complete turn: the model calls set_reminder, the confirmation card is
   * rendered at `startAt`, the user deliberates (the injected clock jumps to
   * `approveAt`), then approves. Returns the card line, the row that landed,
   * and how many clock reads happened before vs. after the approval.
   */
  async function runTurn({ input, startAt, approveAt }) {
    const { db, raw } = freshDb();
    globalThis.__ARC_TEST_DB__ = db;
    const replies = [toolUseReply('set_reminder', input), textReply('Done.')];
    globalThis.__ARC_TEST_FETCH__ = async () => responseOf(replies.shift());

    let instant = startAt;
    let reads = 0;
    let readsAtCard = -1;
    let card = null;

    const result = await streamCoachReply(
      [{ id: 'u1', role: 'user', content: 'remind me', createdAt: 0 }],
      {
        onToken: () => {},
        now: () => {
          reads++;
          return instant;
        },
        confirmWrite: async (request) => {
          card = request.summary;
          readsAtCard = reads;
          instant = approveAt; // approval latency — the wall clock really moved
          return true;
        },
      }
    );

    return {
      card,
      row: raw.prepare('SELECT title, date FROM reminders').get(),
      toolResult: JSON.parse(result.toolCalls[0].result),
      reads,
      readsAtCard,
    };
  }

  await apiKeyStore.setKey('test-key'); // a key set ⇒ the REAL path, not the mock

  // The exact scenario the defect describes: the card is rendered 30 seconds
  // before 09:00 (so "09:00" is still ahead — today), and approval lands 40
  // seconds later, past 09:00. Two clock reads would card "today" and write
  // "tomorrow"; one read cannot.
  const straddle = await runTurn({
    input: { title: 'Take creatine', time: '09:00' },
    startAt: new Date(2026, 7, 7, 8, 59, 30),
    approveAt: new Date(2026, 7, 7, 9, 0, 10),
  });
  straddle.card === 'Set reminder "Take creatine" at 09:00'
    ? ok('card rendered at 08:59:30 for "09:00" names no day — it lands today')
    : bad('straddle card', straddle.card);
  straddle.row.date === '2026-08-07' && straddle.toolResult.date === '2026-08-07'
    ? ok('  → approved at 09:00:10, the row is STILL dated today, exactly as the card said')
    : bad('straddle row', JSON.stringify({ row: straddle.row, result: straddle.toolResult }));
  straddle.reads === straddle.readsAtCard
    ? ok('  → and execute read no clock of its own (one instant, card to row)')
    : bad('clock re-read after approval', `${straddle.readsAtCard} → ${straddle.reads}`);

  // Non-triviality: start the same turn AFTER 09:00 and both halves must move
  // together to tomorrow. A card hardcoded to "today" would pass the test above
  // and fail this one.
  const rolled = await runTurn({
    input: { title: 'Take creatine', time: '09:00' },
    startAt: new Date(2026, 7, 7, 9, 0, 10),
    approveAt: new Date(2026, 7, 7, 9, 0, 20),
  });
  rolled.card === 'Set reminder "Take creatine" at 09:00 · tomorrow (Sat 8 Aug)' &&
  rolled.row.date === '2026-08-08' &&
  rolled.toolResult.date === '2026-08-08'
    ? ok('the same turn started 40s later cards AND writes tomorrow — the day is truly derived')
    : bad('rolled turn', JSON.stringify({ card: rolled.card, row: rolled.row }));

  await apiKeyStore.clearKey();
}

// The owner's report: "asked the Coach for my step count and it did not know."
// The cause was structural — the readable metric set was the MANUAL-LOG registry
// (weight/body_fat/waist/hrv/rhr/water), so the entire HealthKit plane (steps,
// sleep, energy, SpO2, temperatures, VO2max, workouts) was unreachable by any
// tool. These cases pin the fix: discovery from the data, not a hardcoded enum.
console.log('17. wearables: every ingested metric_type is readable by the Coach');
{
  const { db } = freshDb();
  const day = (n) => isoDaysAgo(NOW, n);
  const wear = (rows) =>
    upsertWearableRows(
      db,
      rows.map((r) => ({
        date: r.date,
        metricType: r.metric,
        value: r.value,
        unit: r.unit ?? null,
        sourceDevice: r.device ?? 'apple_watch',
        sourceRawId: `hk:${r.metric}:${r.date}`,
        startTime: null,
        endTime: null,
        metadata: {},
      }))
    );

  const rows = [];
  for (let i = 0; i < 10; i++) {
    rows.push({ date: day(i), metric: 'hrv', value: 50 + i, unit: 'ms' });
    rows.push({ date: day(i), metric: 'rhr', value: 55, unit: 'bpm' });
    rows.push({
      date: day(i),
      metric: 'steps',
      value: 8000 + i * 100,
      unit: 'count',
      device: 'apple_health',
    });
    rows.push({ date: day(i), metric: 'sleep_duration_min', value: 431, unit: 'min' });
    rows.push({
      date: day(i),
      metric: 'active_energy_kcal',
      value: 620,
      unit: 'kcal',
      device: 'apple_health',
    });
  }
  rows.push({ date: day(0), metric: 'sleep_deep_min', value: 74, unit: 'min' });
  rows.push({ date: day(0), metric: 'vo2max', value: 48.2, unit: 'ml_kg_min' });
  rows.push({ date: day(0), metric: 'spo2_pct', value: 97.5, unit: 'pct' });
  rows.push({ date: day(0), metric: 'wrist_temp_c', value: 35.2, unit: 'c' });
  rows.push({ date: day(0), metric: 'respiratory_rate', value: 14.5, unit: 'brpm' });
  rows.push({ date: day(0), metric: 'resting_energy_kcal', value: 1720, unit: 'kcal' });
  // A metric NOTHING in the codebase declares — the "new vendor metric tomorrow"
  // case that a hardcoded enum would silently swallow.
  rows.push({ date: day(0), metric: 'glucose_mgdl', value: 92, unit: 'mgdl' });
  // Recorded, but long outside a short window: absence-in-window ≠ never.
  rows.push({ date: day(40), metric: 'water_ml', value: 500, unit: 'ml', device: 'manual' });
  wear(rows);

  // --- (a) each metric round-trips through get_metric_series ----------------
  const expectations = [
    ['steps', 'count', 8000],
    ['sleep_duration_min', 'min', 431],
    ['active_energy_kcal', 'kcal', 620],
    ['resting_energy_kcal', 'kcal', 1720],
    ['hrv', 'ms', 50],
    ['rhr', 'bpm', 55],
    ['vo2max', 'ml_kg_min', 48.2],
    ['spo2_pct', 'pct', 97.5],
    ['respiratory_rate', 'brpm', 14.5],
    ['sleep_deep_min', 'min', 74],
  ];
  const misses = expectations.filter(([metric, unit, todayValue]) => {
    const out = run('get_metric_series', db, { metric, days: 10 });
    const point = out.points.find((p) => p.date === TODAY);
    return !(out.hasData === true && out.unit === unit && point && near(point.value, todayValue));
  });
  misses.length === 0
    ? ok(
        `all ${expectations.length} HealthKit metric_types round-trip (steps, sleep, energy, SpO2, VO2max…)`
      )
    : bad('unreachable metrics', misses.map((m) => m[0]).join(', '));

  const steps = run('get_metric_series', db, { metric: 'steps', days: 10 });
  // Ten days of points, but only the NINE complete ones are averaged: today is
  // a running total and rides in `todaySoFar` instead (pinned in section 21).
  steps.points.length === 10 &&
  steps.stats.count === 9 &&
  steps.statsExcludesToday === true &&
  near(steps.todaySoFar.value, 8000)
    ? ok('steps returns a real 10-day history with stats — the exact question that failed')
    : bad('steps series', JSON.stringify(steps).slice(0, 200));

  // --- (c) sleep reads as hours/minutes, never a raw minute count ------------
  const sleep = run('get_metric_series', db, { metric: 'sleep' });
  sleep.metric === 'sleep_duration_min' &&
  sleep.points.every((p) => p.hm === '7h 11m') &&
  sleep.stats.avgHm === '7h 11m'
    ? ok('alias "sleep" resolves, and every point carries hm ("7h 11m"), not bare minutes')
    : bad('sleep hm', JSON.stringify(sleep).slice(0, 240));

  // --- (a) a metric NOBODY declared is still readable ------------------------
  const glucose = run('get_metric_series', db, { metric: 'glucose_mgdl' });
  glucose.hasData === true &&
  near(glucose.points[0].value, 92) &&
  glucose.unit === 'mgdl' &&
  glucose.inferred === true
    ? ok('an undeclared metric_type is discovered from the data and read, flagged inferred')
    : bad('discovery', JSON.stringify(glucose).slice(0, 240));

  // --- (c) absence is "no data", never 0 ------------------------------------
  const absent = run('get_metric_series', db, { metric: 'body_temp_c' });
  absent.hasData === false &&
  absent.stats === null &&
  absent.points.length === 0 &&
  absent.lastRecorded === null &&
  /not a zero/.test(absent.note)
    ? ok('a never-recorded metric reports hasData:false + "not a zero", never 0')
    : bad('absent metric', JSON.stringify(absent));

  const stale = run('get_metric_series', db, { metric: 'water', days: 7 });
  stale.hasData === false && stale.lastRecorded === day(40) && /most recent value/.test(stale.note)
    ? ok('recorded-but-outside-the-window says so, and names the last day on record')
    : bad('stale metric', JSON.stringify(stale));

  const unknown = (() => {
    try {
      run('get_metric_series', db, { metric: 'nonsense_metric' });
      return null;
    } catch (e) {
      return e.message;
    }
  })();
  unknown && /steps/.test(unknown) && /glucose_mgdl/.test(unknown)
    ? ok('an unknown name errors with the DEVICE-SPECIFIC valid set (discovered ones included)')
    : bad('unknown metric error', unknown);

  // --- (b) today's wearable picture is IN the snapshot -----------------------
  const snap = run('get_today_snapshot', db);
  snap.wearables &&
  near(snap.wearables.today.steps.value, 8000) &&
  snap.wearables.today.steps.unit === 'count' &&
  snap.wearables.today.sleep_duration_min.hm === '7h 11m' &&
  near(snap.wearables.today.hrv.value, 50) &&
  near(snap.wearables.today.active_energy_kcal.value, 620)
    ? ok('get_today_snapshot carries steps, sleep (h/m), HRV and energy for today')
    : bad('snapshot wearables', JSON.stringify(snap.wearables).slice(0, 300));

  snap.wearables.noDataToday.length === 0 &&
  snap.wearables.availableMetrics.includes('glucose_mgdl') &&
  snap.wearables.availableMetrics.includes('steps')
    ? ok('availableMetrics advertises the whole device set, discovered metrics included')
    : bad('availableMetrics', JSON.stringify(snap.wearables.availableMetrics));

  snap.wearables.today.steps.source === 'Apple Health' &&
  snap.wearables.today.hrv.source === 'Apple Watch'
    ? ok('each value names the source device that won the day')
    : bad('sources', JSON.stringify(snap.wearables.today.steps));

  // --- (b) readiness is Home's, not a second opinion -------------------------
  const home = deriveReadiness(db, TODAY);
  snap.readiness.level === home.readiness.level &&
  snap.readiness.label === home.readiness.label &&
  snap.readiness.detail === home.readiness.detail &&
  JSON.stringify(snap.readiness.pillars) === JSON.stringify(home.pillars) &&
  snap.readiness.hasSignal === home.hasSignal
    ? ok(
        `snapshot readiness IS Home's derivation ("${home.readiness.label}" · ${home.readiness.detail})`
      )
    : bad('readiness mismatch', JSON.stringify({ coach: snap.readiness, home: home.readiness }));
}

console.log('18. wearables: an empty device states absence rather than implying zeros');
{
  const { db } = freshDb();
  const snap = run('get_today_snapshot', db);
  snap.wearables.noDataToday.includes('steps') &&
  snap.wearables.noDataToday.includes('sleep_duration_min') &&
  Object.keys(snap.wearables.today).length === 0 &&
  /never synced/.test(snap.wearables.note)
    ? ok('no wearable data at all ⇒ core metrics named in noDataToday + an explicit note')
    : bad('empty wearables', JSON.stringify(snap.wearables));
  snap.readiness.hasSignal === false && snap.readiness.level === 'unknown'
    ? ok('readiness is `unknown` with hasSignal:false — an absence, not a bad score')
    : bad('empty readiness', JSON.stringify(snap.readiness));

  // Steps synced but nothing else: the still-missing ones must stay named.
  upsertWearableRows(db, [
    {
      date: TODAY,
      metricType: 'steps',
      value: 4210,
      unit: 'count',
      sourceDevice: 'apple_health',
      sourceRawId: `hk:steps:${TODAY}`,
      startTime: null,
      endTime: null,
      metadata: {},
    },
  ]);
  const partial = run('get_today_snapshot', db);
  near(partial.wearables.today.steps.value, 4210) &&
  !partial.wearables.noDataToday.includes('steps') &&
  partial.wearables.noDataToday.includes('sleep_duration_min') &&
  partial.wearables.noDataToday.includes('hrv')
    ? ok('a partial sync reports what exists and still names what does not')
    : bad('partial wearables', JSON.stringify(partial.wearables));
}

console.log('19. wearable values honour Settings › Units (°F/°C, oz/ml)');
{
  const { db } = freshDb();
  upsertWearableRows(db, [
    {
      date: TODAY,
      metricType: 'wrist_temp_c',
      value: 35.2,
      unit: 'c',
      sourceDevice: 'apple_watch',
      sourceRawId: `hk:wrist_temp_c:${TODAY}`,
      startTime: null,
      endTime: null,
      metadata: {},
    },
    {
      date: TODAY,
      metricType: 'water_ml',
      value: 500,
      unit: 'ml',
      sourceDevice: 'manual',
      sourceRawId: `manual:water:${TODAY}:1`,
      startTime: null,
      endTime: null,
      metadata: {},
    },
    {
      date: TODAY,
      metricType: 'water_ml',
      value: 250,
      unit: 'ml',
      sourceDevice: 'manual',
      sourceRawId: `manual:water:${TODAY}:2`,
      startTime: null,
      endTime: null,
      metadata: {},
    },
  ]);

  // Imperial defaults: 35.2 °C → 95.4 °F, 750 ml → 25 oz (water renders whole
  // ounces everywhere in the app — the Coach must not invent extra precision).
  const f = run('get_metric_series', db, { metric: 'wrist_temp' });
  f.unit === '°F' && near(f.points[0].value, 95.4, 0.06)
    ? ok('an °F user reads wrist temperature in °F (35.2 °C → 95.4 °F)')
    : bad('temp F', JSON.stringify(f.points));
  const ozWater = run('get_metric_series', db, { metric: 'water' });
  ozWater.unit === 'oz' && ozWater.points[0].value === 25
    ? ok('water sums the day’s rows (500 + 250 ml) and reports 25 oz for an oz user')
    : bad('water oz', JSON.stringify(ozWater.points));

  setUnitPreference(db, 'temperature', 'C');
  setUnitPreference(db, 'volume', 'ml');
  const c = run('get_metric_series', db, { metric: 'wrist_temp_c' });
  c.unit === '°C' && near(c.points[0].value, 35.2, 0.06)
    ? ok('flipping the preference reports the same row in °C — display only, no rewrite')
    : bad('temp C', JSON.stringify(c.points));
  const mlSnap = run('get_today_snapshot', db);
  mlSnap.wearables.today.water_ml.unit === 'ml' &&
  near(mlSnap.wearables.today.water_ml.value, 750) &&
  mlSnap.wearables.today.wrist_temp_c.unit === '°C'
    ? ok('the snapshot honours the same preferences (750 ml, °C)')
    : bad('snapshot units', JSON.stringify(mlSnap.wearables.today));
}

// The owner's SECOND report of the same symptom: "steps have been synced and
// the home screen correctly displays my step count from apple health, coach is
// not able to read them and reports that no step data has synced when asked."
//
// Round one chased the data layer and proved 18 assertions about it. The data
// layer was never the fault — get_today_snapshot returned the steps then and
// returns them now. What it ALSO returned, in the same object, was
// `readiness.detail = "Connect Apple Health in Settings to power readiness."`,
// deriveReadiness' first-run CALL TO ACTION, emitted whenever there is no
// usable RECOVERY input (HRV/RHR with a baseline, or last night's sleep).
//
// On Home that string is small copy under a strip already showing the step
// count, and a human reads it as "no recovery signal". In JSON it is a flat
// assertion that Apple Health is not connected, sitting a few lines under
// `steps: 8432`, in the payload the system prompt tells the model is the
// authority on today. The model repeated the sentence, not the number.
//
// And for a PHONE-ONLY user it is not a first-run state at all: no watch means
// no HRV, no resting HR and no sleep — forever — so the tool shipped that
// contradiction on every single call, which is exactly why the symptom looked
// permanent and unrelated to any particular day's sync.
//
// So the fixtures below are built by the REAL ingest mappers (statisticDailyRows
// / quantityDailyRows / sleepDailyRows) rather than by hand-written rows, and
// the load-bearing assertion is a NEGATIVE one: no interface instruction may
// appear anywhere in a tool payload that is simultaneously carrying data.
console.log('20. the snapshot never denies a sync it is reporting (owner report, round 2)');
{
  const localDay = (n) =>
    todayISODate(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - n));
  const CONNECT_CTA = 'Connect Apple Health';

  /** A phone-only device: HealthKit merged statistics, no watch, so no recovery. */
  const phoneOnlyDb = () => {
    const { db } = freshDb();
    const rows = [];
    for (const key of ['steps', 'active_energy_kcal', 'resting_energy_kcal']) {
      const spec = STATISTIC_METRICS.find((s) => s.metricType === key);
      const stats = [];
      for (let i = 0; i < 30; i++) {
        stats.push({
          date: localDay(i),
          value: key === 'steps' ? 8432 - i * 37 : key === 'active_energy_kcal' ? 612 : 1720,
        });
      }
      rows.push(...statisticDailyRows(spec, stats));
    }
    upsertWearableRows(db, rows);
    return db;
  };

  const db = phoneOnlyDb();

  // The rows the REAL mapper emits are the ones the arbitration list must know.
  const stepRow = db.get(
    'SELECT unit, source_device, source_raw_id FROM wearable_data WHERE metric_type = ? AND date = ?',
    ['steps', TODAY]
  );
  stepRow.unit === 'count' &&
  stepRow.source_device === 'apple_health' &&
  stepRow.source_raw_id === `hk:steps:${TODAY}` &&
  SOURCE_PRIORITY.includes(stepRow.source_device)
    ? ok('the real ingest writes steps as apple_health/count/hk:steps:<date>, a known source')
    : bad('real step row shape', JSON.stringify(stepRow));

  // Home and the Coach must agree, because they are the same read.
  const home = deriveReadiness(db, TODAY);
  const snap = run('get_today_snapshot', db);
  const homeSteps = home.metrics.find((m) => m.id === 'steps');
  homeSteps.value === '8,432' && near(snap.wearables.today.steps.value, 8432)
    ? ok('Home renders 8,432 steps and the snapshot carries the same 8432 — one read, one answer')
    : bad('home/coach steps', JSON.stringify({ homeSteps, coach: snap.wearables.today.steps }));

  // THE REGRESSION. A payload that is reporting data must never also instruct
  // the user to connect the source of that data.
  const serialised = JSON.stringify(snap);
  Object.keys(snap.wearables.today).length > 0 && !serialised.includes(CONNECT_CTA)
    ? ok('no "Connect Apple Health" instruction anywhere in a payload that carries today’s data')
    : bad('CTA leaked into the tool payload', serialised.slice(0, 400));

  // Readiness is still honestly `unknown` — the fix is about WHAT IT SAYS, not
  // about inventing a verdict from signals that genuinely are not there.
  snap.readiness.level === 'unknown' &&
  snap.readiness.hasSignal === true &&
  /RECOVERY ONLY/.test(snap.readiness.detail) &&
  /NOT mean Apple Health is disconnected/.test(snap.readiness.detail)
    ? ok('readiness stays `unknown` but scopes itself to recovery instead of denying the sync')
    : bad('readiness detail', JSON.stringify(snap.readiness));

  // Silence is what let the contradiction win: nothing in the old payload ever
  // affirmed a working sync, so every ambiguity resolved toward "it is broken".
  /HAS synced today/.test(snap.wearables.note) && /3 metric/.test(snap.wearables.note)
    ? ok('the note states affirmatively that Apple Health synced, and how many metrics')
    : bad('affirmative note', JSON.stringify(snap.wearables.note));

  // A phone has no HRV sensor. Reporting that as "not synced today", every day,
  // is what makes a working sync look broken.
  snap.wearables.noDataToday.includes('hrv') &&
  snap.wearables.neverRecorded.includes('hrv') &&
  snap.wearables.neverRecorded.includes('sleep_duration_min') &&
  !snap.wearables.neverRecorded.includes('steps')
    ? ok('neverRecorded separates "no sensor on this device" from "missing today"')
    : bad('neverRecorded', JSON.stringify(snap.wearables));

  // "and likely other data" — the same question, asked the same way, for the
  // other two metrics the owner named.
  const seriesMisses = ['steps', 'active_energy_kcal'].filter((metric) => {
    const out = run('get_metric_series', db, { metric, days: 30 });
    return !(out.hasData === true && out.points.some((p) => p.date === TODAY));
  });
  seriesMisses.length === 0
    ? ok('get_metric_series over real-mapper rows returns today for steps and active energy')
    : bad('series misses', seriesMisses.join(', '));

  // A metric that is missing TODAY but recorded before must not be relabelled
  // "no sensor" — that is the same conflation in the other direction.
  {
    const db2 = phoneOnlyDb();
    const watch = {
      sourceName: "Matt's Apple Watch",
      bundleId: 'com.apple.health.0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0',
      productType: 'Watch7,1',
    };
    // A night of sleep that ended YESTERDAY morning, from the real sleep mapper.
    const start = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 2, 23, 0, 0, 0);
    const end = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 1, 6, 11, 0, 0);
    upsertWearableRows(
      db2,
      sleepDailyRows([
        { value: 3, startISO: start.toISOString(), endISO: end.toISOString(), provenance: watch },
      ])
    );
    const s2 = run('get_today_snapshot', db2);
    s2.wearables.noDataToday.includes('sleep_duration_min') &&
    !s2.wearables.neverRecorded.includes('sleep_duration_min')
      ? ok('slept the night before but not last night ⇒ noDataToday, NOT neverRecorded')
      : bad('stale-but-recorded', JSON.stringify(s2.wearables));
  }

  // The genuinely empty device keeps its old, correct message — the fix must not
  // have traded one false claim for the opposite one.
  {
    const { db: empty } = freshDb();
    const s3 = run('get_today_snapshot', empty);
    /never synced/.test(s3.wearables.note) &&
    s3.readiness.hasSignal === false &&
    Object.keys(s3.wearables.today).length === 0
      ? ok(
          'a device with no rows at all still says "never synced" — absence still reads as absence'
        )
      : bad('empty device', JSON.stringify(s3.wearables));
  }
}

// The same bug insights.ts was fixed for, one file over — and the one the owner
// actually asks: "how have my steps been?" sends the model to get_metric_series
// FIRST (system-prompt.ts) and tells it to cite these numbers. Steps accumulate,
// so a two-hour-old today is a fraction of a day; averaging it in beside seven
// complete 8,000-step days reported avg 7,112.5 and min 900 — numbers that
// describe the clock, not the user. Today is not dropped (it is real, and the
// owner wants it) — it is held out of the statistics and reported on its own.
console.log('21. get_metric_series never averages a still-accumulating today (owner: steps)');
{
  const { db } = freshDb();
  const day = (n) => isoDaysAgo(NOW, n);
  const wear = (rows) =>
    upsertWearableRows(
      db,
      rows.map((r) => ({
        date: r.date,
        metricType: r.metric,
        value: r.value,
        unit: r.unit,
        sourceDevice: r.device ?? 'apple_health',
        sourceRawId: `hk:${r.metric}:${r.date}`,
        startTime: null,
        endTime: null,
        metadata: {},
      }))
    );

  const rows = [];
  // Seven identical COMPLETE days...
  for (let i = 1; i <= 7; i++) {
    rows.push({ date: day(i), metric: 'steps', value: 8000, unit: 'count' });
    rows.push({ date: day(i), metric: 'active_energy_kcal', value: 600, unit: 'kcal' });
    rows.push({ date: day(i), metric: 'sleep_duration_min', value: 431, unit: 'min' });
  }
  // ...and a today two hours old.
  rows.push({ date: day(0), metric: 'steps', value: 900, unit: 'count' });
  rows.push({ date: day(0), metric: 'active_energy_kcal', value: 70, unit: 'kcal' });
  // Sleep is a whole fact the moment it is written: last night counts today.
  rows.push({ date: day(0), metric: 'sleep_duration_min', value: 431, unit: 'min' });
  wear(rows);

  const steps = run('get_metric_series', db, { metric: 'steps', days: 8 });

  // (1) The partial day moves NOTHING in the statistics.
  steps.stats.count === 7 &&
  near(steps.stats.avg, 8000) &&
  near(steps.stats.min, 8000) &&
  near(steps.stats.max, 8000) &&
  steps.stats.last.date === day(1) &&
  near(steps.stats.last.value, 8000)
    ? ok('a two-hour-old today moves neither avg (8000, not 7112.5) nor min (8000, not 900)')
    : bad('steps stats polluted by today', JSON.stringify(steps.stats));

  // (2) It is still THERE — visible, real, and labelled as a running total.
  const todayPoint = steps.points.find((p) => p.date === TODAY);
  steps.points.length === 8 &&
  todayPoint &&
  near(todayPoint.value, 900) &&
  todayPoint.partial === true &&
  steps.todaySoFar &&
  steps.todaySoFar.date === TODAY &&
  near(steps.todaySoFar.value, 900) &&
  steps.todaySoFar.partial === true &&
  steps.todaySoFar.unit === 'count'
    ? ok("today's 900 steps are NOT dropped — they are in points (partial) and in todaySoFar")
    : bad('today missing from the payload', JSON.stringify(steps).slice(0, 300));

  // (3) points and stats cover different sets, and the payload says which.
  steps.statsExcludesToday === true &&
  /complete days only/.test(steps.statsBasis) &&
  /RUNNING TOTAL/.test(steps.note) &&
  /Never average today in/.test(steps.note) &&
  /so far today/.test(steps.note)
    ? ok('statsBasis + statsExcludesToday + note spell out that points ≠ the stats window')
    : bad('inconsistency unexplained', JSON.stringify(steps).slice(0, 400));

  // (4) The same class, the other metric the owner named.
  const energy = run('get_metric_series', db, { metric: 'active_energy_kcal', days: 8 });
  energy.stats.count === 7 && near(energy.stats.avg, 600) && near(energy.todaySoFar.value, 70)
    ? ok('active energy accumulates too: today held out of stats, kept as todaySoFar')
    : bad('active energy', JSON.stringify(energy.stats));

  // (5) A LEVEL metric is whole when written — today must keep counting.
  const sleep = run('get_metric_series', db, { metric: 'sleep_duration_min', days: 8 });
  sleep.stats.count === 8 &&
  near(sleep.stats.avg, 431) &&
  sleep.statsExcludesToday === false &&
  sleep.todaySoFar === undefined &&
  sleep.points.every((p) => p.partial === undefined) &&
  sleep.stats.last.date === TODAY
    ? ok("last night's sleep still counts today — a level metric is not held back")
    : bad('sleep wrongly excluded', JSON.stringify(sleep).slice(0, 300));

  // (6) HRV, RHR, VO2max — every sampled reading — stay on the level side.
  {
    const { db: db2 } = freshDb();
    upsertWearableRows(db2, [
      {
        date: TODAY,
        metricType: 'hrv',
        value: 50,
        unit: 'ms',
        sourceDevice: 'apple_watch',
        sourceRawId: 'hk:hrv:today',
        startTime: null,
        endTime: null,
        metadata: {},
      },
    ]);
    const hrv = run('get_metric_series', db2, { metric: 'hrv', days: 7 });
    hrv.stats && hrv.stats.count === 1 && hrv.statsExcludesToday === false
      ? ok('a single HRV reading taken today is a complete fact and is averaged')
      : bad('hrv held back', JSON.stringify(hrv).slice(0, 240));
  }

  // (7) Today alone: there IS data, but no complete day to average. Both facts
  // must be stated — a null `stats` next to a real running total is exactly
  // where a model would otherwise invent a daily figure.
  {
    const { db: db3 } = freshDb();
    upsertWearableRows(db3, [
      {
        date: TODAY,
        metricType: 'steps',
        value: 900,
        unit: 'count',
        sourceDevice: 'apple_health',
        sourceRawId: 'hk:steps:today',
        startTime: null,
        endTime: null,
        metadata: {},
      },
    ]);
    const only = run('get_metric_series', db3, { metric: 'steps', days: 7 });
    only.hasData === true &&
    only.stats === null &&
    near(only.todaySoFar.value, 900) &&
    /no COMPLETE day/.test(only.note)
      ? ok('today-only: stats is null with data present, and the note says why')
      : bad('today-only steps', JSON.stringify(only).slice(0, 320));
  }

  // (8) A summed metric (water: one row per sip) is accumulating by construction
  // and needs no declaration to be handled the same way.
  {
    const { db: db4 } = freshDb();
    setUnitPreference(db4, 'volume', 'ml');
    upsertWearableRows(
      db4,
      [
        { date: day(1), value: 2000 },
        { date: TODAY, value: 250 },
      ].map((r) => ({
        date: r.date,
        metricType: 'water_ml',
        value: r.value,
        unit: 'ml',
        sourceDevice: 'manual',
        sourceRawId: `manual:water:${r.date}`,
        startTime: null,
        endTime: null,
        metadata: {},
      }))
    );
    const water = run('get_metric_series', db4, { metric: 'water', days: 7 });
    water.stats.count === 1 && near(water.stats.avg, 2000) && near(water.todaySoFar.value, 250)
      ? ok('water (agg sum) excludes today from stats without needing its own flag')
      : bad('water', JSON.stringify(water).slice(0, 260));
  }

  // (9) Body metrics are readings, not totals — weight logged today counts.
  {
    const { db: db5 } = freshDb();
    run('log_metric', db5, { metric: 'weight', value: 180 });
    const weight = run('get_metric_series', db5, { metric: 'weight', days: 7 });
    weight.statsExcludesToday === false &&
    weight.stats.count === 1 &&
    weight.todaySoFar === undefined
      ? ok("today's weigh-in is a complete measurement and stays in the stats")
      : bad('weight', JSON.stringify(weight).slice(0, 240));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
