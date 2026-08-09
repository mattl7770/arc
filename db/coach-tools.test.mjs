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

console.log('17. recipes + grocery tools (docs/recipes-grocery.md §6)');
{
  const { db } = freshDb();
  const summary = (name, input) => toolByName(name).confirmSummary(input, db, CTX);

  // Empty book reads honestly.
  const emptyBook = run('get_recipes', db);
  emptyBook.recipes.length === 0 && emptyBook.omitted === 0
    ? ok('get_recipes on an empty book → empty, omitted 0')
    : bad('empty book', JSON.stringify(emptyBook));

  // save_recipe: card, then the row — source 'ai', lines unresolved.
  const chili = {
    title: 'High-protein chili',
    servings: 4,
    ingredients: [
      { raw: '500 g lean ground beef' },
      { raw: '2 cans black beans' },
      { raw: 'salt to taste' },
    ],
    steps: ['Brown the beef.', 'Simmer with the beans.'],
  };
  summary('save_recipe', chili) === 'Save recipe "High-protein chili" — 3 ingredients, 4 servings'
    ? ok('save_recipe card names title, line count, servings')
    : bad('save_recipe card', summary('save_recipe', chili));
  const saved = run('save_recipe', db, chili);
  const { getRecipe, listIngredients, resolveIngredient, setIngredientNegligible } =
    await import('../src/lib/db/repositories/recipes.ts');
  const savedRow = getRecipe(db, saved.id);
  savedRow.source === 'ai' && savedRow.servings === 4
    ? ok('save_recipe lands source=ai')
    : bad('save_recipe row', JSON.stringify(savedRow));
  const chiliLines = listIngredients(db, saved.id);
  chiliLines.every((l) => l.grams === null) &&
  chiliLines[0].qty === 500 &&
  chiliLines[0].unit === 'g'
    ? ok('lines land UNRESOLVED with the overlay parsed from raw')
    : bad('save_recipe lines', JSON.stringify(chiliLines[0]));
  throws(() => summary('save_recipe', { ...chili, ingredients: [] }))
    ? ok('empty ingredients refused')
    : bad('empty ingredients');
  throws(() => summary('save_recipe', { ...chili, servings: 0 }))
    ? ok('servings 0 refused')
    : bad('servings 0');

  // get_recipe detail: ids + resolution state; unknown id corrects the model.
  const detail = run('get_recipe', db, { recipe_id: saved.id });
  detail.ingredients.length === 3 &&
  detail.ingredients.every((l) => typeof l.id === 'string' && l.resolved === false) &&
  detail.nutrition.complete === false &&
  detail.nutrition.perServing.kcal === null
    ? ok('get_recipe: ingredient ids + honest incomplete nutrition')
    : bad('get_recipe', JSON.stringify(detail.nutrition));
  throws(() => run('get_recipe', db, { recipe_id: 'nope' }))
    ? ok('get_recipe unknown id → corrective error')
    : bad('get_recipe unknown');

  // Resolve the two real lines; the salt is negligible → nutrition completes.
  const { createFood } = await import('../src/lib/db/repositories/foods.ts');
  const beef = createFood(db, {
    name: 'Lean ground beef',
    kcal_100g: 250,
    protein_g_100g: 26,
    carbs_g_100g: 0,
    fat_g_100g: 15,
  });
  const beans = createFood(db, {
    name: 'Black beans',
    kcal_100g: 130,
    protein_g_100g: 9,
    carbs_g_100g: 24,
    fat_g_100g: 0.5,
  });
  resolveIngredient(db, chiliLines[0].id, beef, 500);
  resolveIngredient(db, chiliLines[1].id, beans, 480);
  setIngredientNegligible(db, chiliLines[2].id, true);
  const completeDetail = run('get_recipe', db, { recipe_id: saved.id });
  // 500g beef = 1250 kcal + 480g beans = 624 kcal → 1874 / 4 = 468.5 → 469 rounded
  completeDetail.nutrition.complete === true && completeDetail.nutrition.perServing.kcal === 469
    ? ok('resolution + negligible → gate opens, per-serving kcal rounded')
    : bad('complete detail', JSON.stringify(completeDetail.nutrition));

  // log_recipe: card carries portion + honest kcal; backdate suffix; XOR guards.
  summary('log_recipe', { recipe_id: saved.id, servings: 2 }) ===
  'Log 2 servings of "High-protein chili" (~937 kcal)'
    ? ok('log_recipe card: portion + ~kcal from the gate')
    : bad('log_recipe card', summary('log_recipe', { recipe_id: saved.id, servings: 2 }));
  summary('log_recipe', { recipe_id: saved.id, date: '2026-08-01' }) ===
  'Log 1 serving of "High-protein chili" (~469 kcal) · 2026-08-01'
    ? ok('log_recipe card names a backdate')
    : bad('backdate card', summary('log_recipe', { recipe_id: saved.id, date: '2026-08-01' }));
  throws(() => summary('log_recipe', { recipe_id: saved.id, servings: 1, grams: 100 }))
    ? ok('servings AND grams refused before the card')
    : bad('XOR');
  throws(() => summary('log_recipe', { recipe_id: saved.id, grams: 100 }))
    ? ok('grams without a recorded cooked weight refused with the corrective error')
    : bad('grams refusal');
  const logged = run('log_recipe', db, { recipe_id: saved.id, servings: 2, time: '19:00' });
  const { getMeal } = await import('../src/lib/db/repositories/nutrition.ts');
  const cookedMeal = getMeal(db, logged.mealId);
  logged.uncountedIngredients === 0 &&
  cookedMeal.recipe_id === saved.id &&
  near(cookedMeal.kcal, 937, 1)
    ? ok('log_recipe stamps the meal with recipe provenance and scaled snapshots')
    : bad('log_recipe meal', JSON.stringify(cookedMeal));

  // An incomplete recipe's card says so instead of showing a number.
  const draft = run('save_recipe', db, {
    title: 'Mystery stew',
    servings: 2,
    ingredients: [{ raw: 'some vegetables' }],
  });
  summary('log_recipe', { recipe_id: draft.id }) ===
  'Log 1 serving of "Mystery stew" (nutrition incomplete — 1 ingredient uncounted)'
    ? ok('incomplete recipe card discloses the undercount, never a number')
    : bad('incomplete card', summary('log_recipe', { recipe_id: draft.id }));

  // A recipe with nothing loggable refuses BEFORE the card — never an approved
  // action that then fails (bug-hunt 2026-08-08).
  const saltWater = run('save_recipe', db, {
    title: 'Salt water',
    servings: 1,
    ingredients: [{ raw: 'water' }, { raw: 'salt to taste' }],
  });
  for (const l of listIngredients(db, saltWater.id)) setIngredientNegligible(db, l.id, true);
  throws(() => summary('log_recipe', { recipe_id: saltWater.id }))
    ? ok('all-negligible recipe refused before the card')
    : bad('all-negligible card');

  // add_grocery_items: batch card, coach provenance, guards.
  const addInput = { items: [{ name: 'Milk', qty: '2' }, { name: 'Spinach' }] };
  summary('add_grocery_items', addInput) === 'Add 2 items to the grocery list: Milk (2) · Spinach'
    ? ok('add_grocery_items card lists every item with qty')
    : bad('grocery card', summary('add_grocery_items', addInput));
  run('add_grocery_items', db, addInput).added === 2 ? ok('batch add lands') : bad('batch add');
  const { listOpenGroceryItems, getGroceryItem } =
    await import('../src/lib/db/repositories/grocery.ts');
  listOpenGroceryItems(db).every((i) => i.source === 'coach')
    ? ok('coach-added items carry source=coach')
    : bad('source coach');
  throws(() => summary('add_grocery_items', { items: [] }))
    ? ok('empty batch refused')
    : bad('empty batch');

  // get_grocery_list: ids + categories; complete_grocery_items resolves names.
  const list = run('get_grocery_list', db);
  const milk = list.sections.flatMap((s) => s.items).find((i) => i.name === 'Milk');
  list.openCount === 2 && typeof milk.id === 'string'
    ? ok('get_grocery_list returns the ids the write tools need')
    : bad('grocery list', JSON.stringify(list));
  summary('complete_grocery_items', { ids: [milk.id] }) === 'Check off 1 item: Milk'
    ? ok('complete_grocery_items card resolves ids to names')
    : bad('checkoff card', summary('complete_grocery_items', { ids: [milk.id] }));
  throws(() => summary('complete_grocery_items', { ids: ['bogus'] }))
    ? ok('unknown grocery id refused before the card')
    : bad('unknown grocery id');
  run('complete_grocery_items', db, { ids: [milk.id] }).checked === 1 &&
  getGroceryItem(db, milk.id).checked_at !== null
    ? ok('check-off stamps checked_at (soft state)')
    : bad('checkoff execute');

  // add_recipe_to_grocery_list: card counts the included lines; exclude works.
  const addRecipeInput = { recipe_id: saved.id, exclude: [chiliLines[2].id] };
  summary('add_recipe_to_grocery_list', addRecipeInput) ===
  'Add 2 ingredients from "High-protein chili" to the grocery list'
    ? ok('add_recipe_to_grocery_list card: title + included count')
    : bad('recipe→list card', summary('add_recipe_to_grocery_list', addRecipeInput));
  run('add_recipe_to_grocery_list', db, addRecipeInput).added === 2
    ? ok('excluded line stays off the list')
    : bad('recipe→list execute');
  const withRecipe = run('get_grocery_list', db);
  withRecipe.sections.flatMap((s) => s.items).some((i) => i.forRecipe === 'High-protein chili')
    ? ok('list items carry their recipe backlink title')
    : bad('forRecipe', JSON.stringify(withRecipe));
  throws(() =>
    summary('add_recipe_to_grocery_list', {
      recipe_id: saved.id,
      exclude: chiliLines.map((l) => l.id),
    })
  )
    ? ok('all-excluded refused (nothing to add)')
    : bad('all excluded');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
