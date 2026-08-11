/**
 * Headless test of the Coach tool registry (src/lib/ai/tools/) against real
 * SQLite via node:sqlite — each tool's execute really reads/writes the same
 * tables the capture screens use. Mirrors db/nutrition.test.mjs; op-sqlite and
 * the model client are never loaded. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { todayISODate } from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { createExperiment } from '../src/lib/db/repositories/experiments.ts';
import { createProtocolWithVersion } from '../src/lib/db/repositories/protocols.ts';
import { weekSummary } from '../src/lib/db/repositories/exercise.ts';
import { setUnitPreference, updateProfile } from '../src/lib/db/repositories/user.ts';
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
  run('set_reminder', db, { title: 'Take magnesium', time: '21:00', repeat: 'daily' });

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
  const daily = run('set_reminder', db, {
    title: 'Take magnesium',
    time: '21:00',
    repeat: 'daily',
  });
  raw.prepare('SELECT created_by FROM reminders WHERE id = ?').get(daily.id).created_by === 'ai'
    ? ok('tool-created reminder records created_by = ai')
    : bad('created_by');

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

  const once = run('set_reminder', db, { title: 'Book DEXA', repeat: 'once' });
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
  throws(() => run('set_reminder', db, { title: 'Weekly check', repeat: 'weekly' }))
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
  const summary = toolByName('update_protocol').confirmSummary(changeInput, db, CTX);
  // The card carries the item-count delta AND which day the change lands on —
  // approving "added zinc" and seeing nothing on today's mission reads as a
  // broken promise, so "takes effect tomorrow" is part of the contract.
  summary ===
  'Update "Evening Stack": 3 items (was 2) — Bumped magnesium to 400 mg, added zinc · takes effect tomorrow'
    ? ok(`confirmation shows the item-count delta and the effective day ("${summary}")`)
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

let extraSeq = 0;
const xid = () => `x-${++extraSeq}`;
const seedWearableRow = (raw, metricType, daysAgo, value) =>
  raw
    .prepare(
      `INSERT INTO wearable_data (id, date, metric_type, value, source_device) VALUES (?, ?, ?, ?, 'manual')`
    )
    .run(xid(), isoDaysAgo(NOW, daysAgo), metricType, value);

console.log('16. snapshot carries readiness, profile, mission ids, experiments');
{
  const { db, raw } = freshDb();
  const empty = run('get_today_snapshot', db);
  empty.readiness &&
  empty.readiness.verdict === 'unknown' &&
  empty.profile &&
  empty.profile.age === null &&
  Array.isArray(empty.experiments) &&
  empty.experiments.length === 0
    ? ok('empty day: readiness unknown, profile nulls, experiments []')
    : bad('empty snapshot extras', JSON.stringify(empty.readiness));

  updateProfile(db, { dateOfBirth: '1992-01-15', biologicalSex: 'male' });
  for (let d = 1; d <= 6; d++) seedWearableRow(raw, 'hrv', d, 50);
  seedWearableRow(raw, 'hrv', 0, 40);
  createExperiment(db, {
    title: 'Magnesium PM',
    hypothesis: 'Better sleep',
    intervention: '400 mg at night',
    metrics: ['hrv', 'sleep'],
    startDate: TODAY,
    durationDays: 14,
  });

  const snap = run('get_today_snapshot', db);
  snap.profile.sex === 'male' && typeof snap.profile.age === 'number'
    ? ok('profile carries age + sex')
    : bad('profile', JSON.stringify(snap.profile));
  // HRV 40 vs a 50 baseline (ratio 0.8) → the same "caution" Home renders.
  snap.readiness.verdict === 'caution' &&
  snap.readiness.pillars &&
  snap.readiness.pillars.recovery === 'caution'
    ? ok('readiness verdict + pillars mirror deriveReadiness')
    : bad('readiness', JSON.stringify(snap.readiness));
  snap.experiments.length === 1 &&
  snap.experiments[0].title === 'Magnesium PM' &&
  snap.experiments[0].ready === false &&
  snap.experiments[0].daysLeft === 13
    ? ok('running experiments ride the snapshot')
    : bad('experiments', JSON.stringify(snap.experiments));
}

console.log('17. snapshot mission items expose ids (the address a mission tool needs)');
{
  const { db } = freshDb();
  run('log_metric', db, { metric: 'weight', value: 178 }); // ensures a daily_log exists
  const snap = run('get_today_snapshot', db);
  // Mission may be empty (no protocols seeded), but WHEN items exist they must
  // carry ids — assert on the shape contract via a seeded item instead.
  const { getOrCreateDailyLog, insertMissionItem } = await import(
    '../src/lib/db/repositories/mission.ts'
  );
  const log = getOrCreateDailyLog(db, TODAY);
  insertMissionItem(db, log.id, 'habit', {
    id: 'unused',
    title: 'Morning light',
    status: 'pending',
    category: 'Routine',
    why: 'Circadian anchor',
  });
  const snap2 = run('get_today_snapshot', db);
  snap2.mission.length === 1 &&
  typeof snap2.mission[0].id === 'string' &&
  snap2.mission[0].id.length > 0 &&
  snap2.mission[0].category === 'Routine' &&
  snap2.mission[0].why === 'Circadian anchor'
    ? ok('mission items carry id + category + why')
    : bad('mission ids', JSON.stringify(snap2.mission));
  snap.mission.length === 0
    ? ok('before seeding, an unplanned day reports an empty mission (no fabricated rows)')
    : bad('pre-seed mission not empty', JSON.stringify(snap.mission));
}

console.log('18. get_metric_series reads sleep/steps/energy; future rows never leak');
{
  const { db, raw } = freshDb();
  for (let d = 0; d <= 4; d++) seedWearableRow(raw, 'sleep_duration_min', d, 420 + d);
  seedWearableRow(raw, 'steps', 1, 9000);
  seedWearableRow(raw, 'active_energy_kcal', 1, 650);
  // A future-dated row (clock skew / bad import) must not appear at all.
  seedWearableRow(raw, 'sleep_duration_min', -3, 999);

  const sleep = run('get_metric_series', db, { metric: 'sleep', days: 14 });
  sleep.unit === 'min' && sleep.stats.count === 5
    ? ok('sleep series in fixed minutes, 5 real days')
    : bad('sleep series', JSON.stringify(sleep.stats));
  sleep.points.every((p) => p.date <= TODAY) && sleep.stats.max < 999
    ? ok('the future-dated row is excluded from points and stats')
    : bad('future leak', JSON.stringify(sleep.points));
  run('get_metric_series', db, { metric: 'steps', days: 7 }).stats.count === 1
    ? ok('steps series reads')
    : bad('steps');
  run('get_metric_series', db, { metric: 'active_energy', days: 7 }).unit === 'kcal'
    ? ok('active_energy series reads in kcal')
    : bad('energy');
}

console.log('19. get_biomarker_history: trend behind the latest value, exact-first resolution');
{
  const { db, raw } = freshDb();
  const insertMarker = (id, slug, name) =>
    raw
      .prepare(
        `INSERT INTO biomarkers (id, slug, name, category, unit, optimal_range_low, optimal_range_high)
         VALUES (?, ?, ?, 'hormone', 'ng/dL', 20, 60)`
      )
      .run(id, slug, name);
  insertMarker('bm1', 'apob', 'ApoB');
  insertMarker('bm2', 'testosterone', 'Testosterone');
  insertMarker('bm3', 'testosterone_free', 'Testosterone, Free');
  raw
    .prepare(
      `INSERT INTO lab_results (id, biomarker_id, value, collected_at, source) VALUES (?, ?, ?, ?, 'manual')`
    )
    .run('lr1', 'bm1', 95, '2026-01-10');
  raw
    .prepare(
      `INSERT INTO lab_results (id, biomarker_id, value, collected_at, source) VALUES (?, ?, ?, ?, 'manual')`
    )
    .run('lr2', 'bm1', 78, '2026-06-01');

  const bySlug = run('get_biomarker_history', db, { biomarker: 'apob' });
  bySlug.found && bySlug.resultCount === 2 && bySlug.results[0].value === 95
    ? ok('slug lookup returns the full series, oldest first')
    : bad('slug lookup', JSON.stringify(bySlug));
  // "Testosterone" is a substring of "Testosterone, Free" — the exact name
  // match must win outright, never read as ambiguous (the labs discipline).
  const exact = run('get_biomarker_history', db, { biomarker: 'Testosterone' });
  exact.found && exact.slug === 'testosterone'
    ? ok('exact name beats the substring trap (Testosterone vs Testosterone, Free)')
    : bad('exact-name', JSON.stringify(exact));
  const ambiguous = run('get_biomarker_history', db, { biomarker: 'testo' });
  !ambiguous.found && ambiguous.candidates && ambiguous.candidates.length === 2
    ? ok('an ambiguous fragment returns candidates instead of guessing')
    : bad('ambiguous', JSON.stringify(ambiguous));
  const missing = run('get_biomarker_history', db, { biomarker: 'zzz' });
  !missing.found ? ok('no match → found:false, no invention') : bad('missing', JSON.stringify(missing));
}

console.log('20. get_training_recommendation reports engine state (never decides)');
{
  const { db } = freshDb();
  const rec = run('get_training_recommendation', db);
  rec.recommendation && typeof rec.recommendation.kind === 'string' && rec.recommendation.why
    ? ok(`recommendation present (kind: ${rec.recommendation.kind})`)
    : bad('recommendation shape', JSON.stringify(rec.recommendation));
  Array.isArray(rec.muscleFreshness) && rec.muscleFreshness.length >= 10
    ? ok(`muscle freshness ledger rides along (${rec.muscleFreshness.length} muscles)`)
    : bad('ledger', JSON.stringify(rec.muscleFreshness));
  Array.isArray(rec.weeklyVolume) && rec.weeklyVolume.length === 0
    ? ok('no logged sets → empty weekly volume, not 16 zero rows')
    : bad('volume', JSON.stringify(rec.weeklyVolume));
  if (rec.recommendation.exercises) {
    rec.recommendation.exercises.every((e) => e.target && typeof e.target.kind === 'string')
      ? ok('every recommended exercise carries a progression target')
      : bad('targets', JSON.stringify(rec.recommendation.exercises[0]));
  } else {
    ok('no exercises on this recommendation kind (nothing to target)');
  }
}

console.log('21. log_workout resolves catalog exercise ids — exact match only');
{
  const { db, raw } = freshDb();
  const result = run('log_workout', db, {
    name: 'Upper A',
    kind: 'strength',
    duration_min: 50,
    sets: [
      { exercise: 'Barbell Bench Press', reps: 8, weight: 100, unit: 'kg' },
      { exercise: 'bench press', reps: 8, weight: 100, unit: 'kg' }, // alias, case-insensitive
      { exercise: 'Press', reps: 5, weight: 60, unit: 'kg' }, // no unique exact match
    ],
  });
  const ids = raw
    .prepare(`SELECT exercise_id FROM workout_sets ORDER BY set_index, rowid`)
    .all()
    .map((r) => r.exercise_id);
  ids[0] === 'barbell-bench-press' && ids[1] === 'barbell-bench-press'
    ? ok('exact name and exact alias both resolve to the catalog id')
    : bad('resolution', JSON.stringify(ids));
  ids[2] === null
    ? ok('a non-unique name stays NULL — never a guess')
    : bad('ambiguous resolved', JSON.stringify(ids));
  result.unmatchedExercises &&
  result.unmatchedExercises.length === 1 &&
  result.unmatchedExercises[0] === 'Press'
    ? ok('the tool result names the unmatched exercise so the model can say so')
    : bad('unmatched note', JSON.stringify(result));
}

console.log('22. future log dates are rejected; set_mode "until" may still be future');
{
  const { db } = freshDb();
  const future = isoDaysAgo(NOW, -2);
  throws(() => run('log_metric', db, { metric: 'weight', value: 178, date: future }))
    ? ok('log_metric refuses a future date')
    : bad('future weight accepted');
  throws(() => run('log_meal', db, { name: 'Lunch', date: future }))
    ? ok('log_meal refuses a future date')
    : bad('future meal accepted');
  const past = run('log_metric', db, { metric: 'weight', value: 178, date: isoDaysAgo(NOW, 1) });
  past.logged ? ok('a real backdate still logs') : bad('backdate broken');
  const mode = run('set_mode', db, { mode: 'travel', until: future });
  mode.set && mode.until === future
    ? ok('set_mode "until" legitimately reaches into the future')
    : bad('set_mode until', JSON.stringify(mode));

  // The rejection must fire at CARD time too — a knowable failure must never
  // cost the user an Approve tap (card shows, user approves, execute throws).
  throws(() =>
    toolByName('log_metric').confirmSummary({ metric: 'weight', value: 178, date: future }, db, CTX)
  )
    ? ok('confirmSummary throws on a future date BEFORE the card is shown')
    : bad('future date reached the confirmation card');
  const reminderCard = toolByName('set_reminder').confirmSummary(
    { title: 'Book DEXA', date: future },
    db,
    CTX
  );
  reminderCard.includes(future)
    ? ok("set_reminder's card still accepts a future date (its dates reach forward)")
    : bad('reminder card', reminderCard);
}

console.log('23. an evening weigh-in west of UTC still lands in its own series');
{
  // REGRESSION: body_metrics stores a UTC INSTANT, so west of UTC an evening
  // weigh-in already carries tomorrow's UTC date. Bounding the window with a
  // local date string (`substr(measured_at,1,10) <= today`) silently dropped
  // the user's own reading; the bound must be the end-of-local-day instant.
  const { db, raw } = freshDb();
  const local = todayISODate(NOW);
  // Stamp it the way the local evening does: an instant inside today locally,
  // whose UTC date may be tomorrow.
  const eveningUtc = new Date(
    NOW.getFullYear(),
    NOW.getMonth(),
    NOW.getDate(),
    23,
    30,
    0,
    0
  ).toISOString();
  raw
    .prepare(
      `INSERT INTO body_metrics (id, measured_at, weight_kg, source) VALUES (?, ?, ?, 'manual')`
    )
    .run('bm-evening', eveningUtc, 80);
  const series = run('get_metric_series', db, { metric: 'weight', days: 7 });
  series.points.length === 1
    ? ok(`a 23:30 local weigh-in is in the series (UTC date ${eveningUtc.slice(0, 10)}, local ${local})`)
    : bad('evening weigh-in dropped', JSON.stringify(series));

  // A genuinely future reading (tomorrow evening) is still excluded.
  const tomorrowUtc = new Date(
    NOW.getFullYear(),
    NOW.getMonth(),
    NOW.getDate() + 1,
    20,
    0,
    0,
    0
  ).toISOString();
  raw
    .prepare(
      `INSERT INTO body_metrics (id, measured_at, weight_kg, source) VALUES (?, ?, ?, 'manual')`
    )
    .run('bm-future', tomorrowUtc, 99);
  run('get_metric_series', db, { metric: 'weight', days: 7 }).points.length === 1
    ? ok('a genuinely future weigh-in is still excluded')
    : bad('future weigh-in leaked', JSON.stringify(run('get_metric_series', db, { metric: 'weight', days: 7 })));
}

console.log('24. dual-writer sleep night: the Coach cites the arbitrated winner, like Home');
{
  const { db, raw } = freshDb();
  const day = isoDaysAgo(NOW, 1);
  const insert = raw.prepare(
    `INSERT INTO wearable_data (id, date, metric_type, value, source_device) VALUES (?, ?, ?, ?, ?)`
  );
  insert.run('dw-1', day, 'sleep_duration_min', 450, 'apple_watch');
  insert.run('dw-2', day, 'sleep_duration_min', 380, 'oura');
  const sleep = run('get_metric_series', db, { metric: 'sleep', days: 7 });
  // SOURCE_PRIORITY ranks apple_watch above oura — Home shows 450; a pooled
  // average (415) would be a number no app surface displays.
  sleep.stats.count === 1 && sleep.points[0].value === 450
    ? ok('sleep series returns the source-arbitrated 450, not the 415 pooled average')
    : bad('dual-writer sleep', JSON.stringify(sleep.points));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
