/**
 * Headless test of the trend-series data layer added on top of Nutrition
 * (nutrition.ts), Exercise (exercise.ts), and Symptoms (symptoms.ts) — against
 * real SQLite via node:sqlite. Mirrors db/nutrition.test.mjs; op-sqlite is
 * never loaded. Run: node --import ./db/register-ts-hooks.mjs db/data-trends.test.mjs
 */
import { DatabaseSync } from 'node:sqlite';

import { todayISODate } from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { dailyIntakeSeries, logMeal } from '../src/lib/db/repositories/nutrition.ts';
import { logWorkout, weeklyTrainingSeries } from '../src/lib/db/repositories/exercise.ts';
import {
  getOrCreateDailyLog,
  insertMissionItem,
  missionAdherence,
  missionBySource,
  missionDailySeries,
  missionOwed,
  missionRecordStart,
  removeMissionItem,
  setMissionStatus,
} from '../src/lib/db/repositories/mission.ts';
import { activeModesIn, getActiveMode, setMode } from '../src/lib/db/repositories/day-modes.ts';
import { generateMissionForDay } from '../src/lib/db/repositories/mission-generate.ts';
import { createProtocolWithVersion, deleteProtocol } from '../src/lib/db/repositories/protocols.ts';
import { logSymptom, symptomDailySeries } from '../src/lib/db/repositories/symptoms.ts';

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
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-6;

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

// Sun 2026-07-26, noon LOCAL — "today" for the nutrition/symptom series below.
const TODAY = '2026-07-26';
// Wed 2026-07-22, noon LOCAL — its Monday-start week is Jul 20 … Jul 26.
const NOW = new Date(2026, 6, 22, 12, 0, 0);

// ============================================================================
// dailyIntakeSeries (nutrition.ts)
// ============================================================================

console.log('1. dailyIntakeSeries: exactly `days` points, oldest -> today, in order');
{
  const { db } = freshDb();
  const series = dailyIntakeSeries(db, 7, TODAY);
  series.length === 7
    ? ok('returns exactly 7 points on an empty database')
    : bad('point count', series.length);
  const expectedDates = [
    '2026-07-20',
    '2026-07-21',
    '2026-07-22',
    '2026-07-23',
    '2026-07-24',
    '2026-07-25',
    '2026-07-26',
  ];
  JSON.stringify(series.map((p) => p.date)) === JSON.stringify(expectedDates)
    ? ok('dates run oldest -> today inclusive, in order')
    : bad('date order', JSON.stringify(series.map((p) => p.date)));
}

console.log('2. dailyIntakeSeries: zero-filled for days with no meals');
{
  const { db } = freshDb();
  const series = dailyIntakeSeries(db, 7, TODAY);
  series.every((p) => p.kcal === 0 && p.protein_g === 0)
    ? ok('every point reads kcal=0, protein_g=0 on an empty database')
    : bad('zero fill', JSON.stringify(series));
}

console.log('3. dailyIntakeSeries: sums meals per day, correctly isolated across days');
{
  const { db } = freshDb();
  logMeal(db, { date: '2026-07-24', time: '08:00', name: 'Breakfast', kcal: 500, protein_g: 30 });
  logMeal(db, { date: '2026-07-24', time: '12:30', name: 'Lunch', kcal: 700, protein_g: 40 });
  logMeal(db, { date: '2026-07-25', time: '08:00', name: 'Breakfast', kcal: 400, protein_g: 20 });
  // Outside the 7-day window (before 2026-07-20) — must not leak in.
  logMeal(db, { date: '2026-07-10', time: '08:00', name: 'Old meal', kcal: 9999, protein_g: 999 });
  const series = dailyIntakeSeries(db, 7, TODAY);
  const day24 = series.find((p) => p.date === '2026-07-24');
  const day25 = series.find((p) => p.date === '2026-07-25');
  const day26 = series.find((p) => p.date === '2026-07-26');
  near(day24.kcal, 1200) && near(day24.protein_g, 70)
    ? ok('2026-07-24 sums both meals (1200 kcal, 70g protein)')
    : bad('day24 sums', JSON.stringify(day24));
  near(day25.kcal, 400) && near(day25.protein_g, 20)
    ? ok('2026-07-25 sums only its own meal, not bleeding from 07-24')
    : bad('day25 sums', JSON.stringify(day25));
  day26.kcal === 0 && day26.protein_g === 0
    ? ok('today with no meals still reads as zero, not undefined')
    : bad('day26 zero', JSON.stringify(day26));
  const out = series.find((p) => p.date === '2026-07-10');
  out === undefined
    ? ok('a meal outside the window does not add an extra point or leak in')
    : bad('window leak', JSON.stringify(out));
}

console.log('4. dailyIntakeSeries: default days=7 and default today=todayISODate()');
{
  const { db } = freshDb();
  const series = dailyIntakeSeries(db);
  series.length === 7 && series[6].date === todayISODate()
    ? ok('defaults to 7 points ending on todayISODate()')
    : bad('defaults', JSON.stringify(series.map((p) => p.date)));
}

console.log('4b. dailyIntakeSeries: mealCount, oldest-day inclusivity, kcal-less meals');
{
  const { db } = freshDb();
  // Oldest in-window day (dates[0] = 2026-07-20) — pins the `date >= ?` lower bound.
  logMeal(db, { date: '2026-07-20', time: '08:00', name: 'Breakfast', kcal: 300, protein_g: 20 });
  // A meal saved with only a name (kcal/protein NULL) — a real record that must
  // count even though it sums to 0 kcal (drives the honest Data-tab empty flag).
  logMeal(db, { date: '2026-07-21', time: '12:00', name: 'Lunch, no macros' });
  const series = dailyIntakeSeries(db, 7, TODAY);
  const day20 = series.find((p) => p.date === '2026-07-20');
  const day21 = series.find((p) => p.date === '2026-07-21');
  const day26 = series.find((p) => p.date === TODAY);
  day20 && near(day20.kcal, 300) && day20.mealCount === 1
    ? ok('oldest in-window day (2026-07-20) is included (>= lower bound), mealCount=1')
    : bad('lower-bound inclusivity', JSON.stringify(day20));
  day21 && day21.kcal === 0 && day21.protein_g === 0 && day21.mealCount === 1
    ? ok('a kcal-less meal still counts (mealCount=1) though it sums to 0 kcal')
    : bad('kcal-less meal count', JSON.stringify(day21));
  day26 && day26.mealCount === 0
    ? ok('a day with no meals reads mealCount=0')
    : bad('empty day mealCount', JSON.stringify(day26));
}

// ============================================================================
// weeklyTrainingSeries (exercise.ts)
// ============================================================================

console.log('5. weeklyTrainingSeries: exactly `weeks` points, oldest -> current, in order');
{
  const { db } = freshDb();
  const series = weeklyTrainingSeries(db, 6, NOW);
  series.length === 6
    ? ok('returns exactly 6 points on an empty database')
    : bad('point count', series.length);
  // Current week (containing Wed 2026-07-22) starts Mon 2026-07-20; stepping
  // back 7 days per prior week.
  const expectedStarts = [
    '2026-06-15',
    '2026-06-22',
    '2026-06-29',
    '2026-07-06',
    '2026-07-13',
    '2026-07-20',
  ];
  JSON.stringify(series.map((p) => p.weekStart)) === JSON.stringify(expectedStarts)
    ? ok('weekStarts run oldest -> current, Monday-start, 7 days apart')
    : bad('week order', JSON.stringify(series.map((p) => p.weekStart)));
}

console.log('6. weeklyTrainingSeries: zero-filled for weeks with no workouts');
{
  const { db } = freshDb();
  const series = weeklyTrainingSeries(db, 6, NOW);
  series.every((p) => p.zone2Min === 0 && p.strengthCount === 0)
    ? ok('every point reads zone2Min=0, strengthCount=0 on an empty database')
    : bad('zero fill', JSON.stringify(series));
}

console.log('7. weeklyTrainingSeries: aggregates per week, correctly isolated across weeks');
{
  const { db } = freshDb();
  // Current week: Mon 2026-07-20 … Sun 2026-07-26.
  logWorkout(db, { date: '2026-07-20', name: 'Zone 2', kind: 'cardio', durationMin: 30 });
  logWorkout(db, { date: '2026-07-22', name: 'Upper A', kind: 'strength', durationMin: 52 });
  logWorkout(db, { date: '2026-07-22', name: 'Hips', kind: 'mobility', durationMin: 15 });
  // Prior week: Mon 2026-07-13 … Sun 2026-07-19.
  logWorkout(db, { date: '2026-07-14', name: 'Zone 2', kind: 'cardio', durationMin: 45 });
  logWorkout(db, { date: '2026-07-16', name: 'Lower B', kind: 'strength' });
  // Outside the 6-week window (before 2026-06-15) — must not leak in.
  logWorkout(db, { date: '2026-06-01', name: 'Ancient', kind: 'cardio', durationMin: 999 });
  const series = weeklyTrainingSeries(db, 6, NOW);
  const current = series.find((p) => p.weekStart === '2026-07-20');
  const prior = series.find((p) => p.weekStart === '2026-07-13');
  const oldest = series.find((p) => p.weekStart === '2026-06-15');
  near(current.zone2Min, 30) && current.strengthCount === 1
    ? ok('current week: 30 zone2 min, 1 strength session (mobility excluded)')
    : bad('current week', JSON.stringify(current));
  near(prior.zone2Min, 45) && prior.strengthCount === 1
    ? ok('prior week sums only its own workouts, not bleeding from current week')
    : bad('prior week', JSON.stringify(prior));
  oldest.zone2Min === 0 && oldest.strengthCount === 0
    ? ok('the oldest in-window week with no workouts still reads zero')
    : bad('oldest week', JSON.stringify(oldest));
}

console.log('8. weeklyTrainingSeries: default weeks=6');
{
  const { db } = freshDb();
  const series = weeklyTrainingSeries(db, undefined, NOW);
  series.length === 6 ? ok('defaults to 6 points') : bad('default weeks', series.length);
}

console.log('8b. weeklyTrainingSeries: workoutCount + Sunday (upper-bound) inclusivity');
{
  const { db } = freshDb();
  // Current week is Mon 2026-07-20 … Sun 2026-07-26.
  // A cardio session on the exact Sunday end — pins the inclusive `date <= end`.
  logWorkout(db, { date: '2026-07-26', name: 'Sunday Zone 2', kind: 'cardio', durationMin: 20 });
  // A mobility session — contributes to workoutCount but neither zone2 nor strength.
  logWorkout(db, { date: '2026-07-22', name: 'Yoga', kind: 'mobility', durationMin: 40 });
  const series = weeklyTrainingSeries(db, 6, NOW);
  const current = series.find((p) => p.weekStart === '2026-07-20');
  current && near(current.zone2Min, 20)
    ? ok('Sunday (2026-07-26) cardio is counted — `date <= end` is inclusive')
    : bad('sunday upper bound', JSON.stringify(current));
  current && current.workoutCount === 2 && current.strengthCount === 0
    ? ok('workoutCount counts every kind (cardio + mobility = 2); strengthCount stays 0')
    : bad('workoutCount', JSON.stringify(current));
}

// ============================================================================
// symptomDailySeries (symptoms.ts)
// ============================================================================

console.log('9. symptomDailySeries: exactly `days` points, oldest -> today, in order');
{
  const { db } = freshDb();
  const series = symptomDailySeries(db, 14, TODAY);
  series.length === 14
    ? ok('returns exactly 14 points on an empty database')
    : bad('point count', series.length);
  series[0].date === '2026-07-13' && series[13].date === TODAY
    ? ok('dates run oldest -> today inclusive, in order')
    : bad('date order', JSON.stringify(series.map((p) => p.date)));
}

console.log('10. symptomDailySeries: zero-filled (count=0, maxSeverity=null) for empty days');
{
  const { db } = freshDb();
  const series = symptomDailySeries(db, 14, TODAY);
  series.every((p) => p.count === 0 && p.maxSeverity === null)
    ? ok('every point reads count=0, maxSeverity=null on an empty database')
    : bad('zero fill', JSON.stringify(series));
}

console.log('11. symptomDailySeries: counts + max severity per day, isolated across days');
{
  const { db } = freshDb();
  logSymptom(db, { date: '2026-07-24', time: '08:00', name: 'Headache', severity: 6 });
  logSymptom(db, { date: '2026-07-24', time: '14:00', name: 'Fatigue', severity: 3 });
  logSymptom(db, { date: '2026-07-24', time: '20:00', name: 'Nausea' }); // no severity
  logSymptom(db, { date: '2026-07-25', time: '09:00', name: 'Brain fog', severity: 4 });
  // Outside the 14-day window (before 2026-07-13) — must not leak in.
  logSymptom(db, { date: '2026-07-01', name: 'Old ache', severity: 9 });
  const series = symptomDailySeries(db, 14, TODAY);
  const day24 = series.find((p) => p.date === '2026-07-24');
  const day25 = series.find((p) => p.date === '2026-07-25');
  const day26 = series.find((p) => p.date === TODAY);
  day24.count === 3 && day24.maxSeverity === 6
    ? ok('2026-07-24: count=3 (incl. unrated), maxSeverity=6')
    : bad('day24', JSON.stringify(day24));
  day25.count === 1 && day25.maxSeverity === 4
    ? ok('2026-07-25 counts only its own symptom, not bleeding from 07-24')
    : bad('day25', JSON.stringify(day25));
  day26.count === 0 && day26.maxSeverity === null
    ? ok('today with no symptoms still reads count=0, maxSeverity=null')
    : bad('day26', JSON.stringify(day26));
  const out = series.find((p) => p.date === '2026-07-01');
  out === undefined
    ? ok('a symptom outside the window does not add an extra point or leak in')
    : bad('window leak', JSON.stringify(out));
}

console.log('12. symptomDailySeries: default days=14 and default today=todayISODate()');
{
  const { db } = freshDb();
  const series = symptomDailySeries(db);
  series.length === 14 && series[13].date === todayISODate()
    ? ok('defaults to 14 points ending on todayISODate()')
    : bad('defaults', JSON.stringify(series.map((p) => p.date)));
}

console.log('12b. symptomDailySeries: oldest-day inclusivity + all-NULL-severity day');
{
  const { db } = freshDb();
  // Oldest in-window day (dates[0] = 2026-07-13) with two UNRATED symptoms —
  // pins the `date >= ?` lower bound and the max(severity)=NULL path (guards
  // against a coalesce(max(severity),0) regression).
  logSymptom(db, { date: '2026-07-13', time: '08:00', name: 'Stiffness' });
  logSymptom(db, { date: '2026-07-13', time: '20:00', name: 'Bloating' });
  const series = symptomDailySeries(db, 14, TODAY);
  const day13 = series.find((p) => p.date === '2026-07-13');
  day13 && day13.count === 2 && day13.maxSeverity === null
    ? ok('oldest day included; count=2 with all-NULL severity yields maxSeverity=null')
    : bad('lower bound / null-severity', JSON.stringify(day13));
}

// ============================================================================
// missionDailySeries / missionAdherence (mission.ts) — the Data tab's Mission
// trend. The two things that can go wrong here are both about WHAT COUNTS:
// an ad-hoc Log-tab capture is not a plan item, and a removed item was never
// owed. Both are excluded by the same shared predicates listMission uses.
// ============================================================================

console.log('\n13. missionDailySeries: counts exactly the rows Home draws');
{
  const { db } = freshDb();

  // A day with a plan: 3 planned, 1 completed, 1 skipped, 1 pending.
  const dayA = getOrCreateDailyLog(db, '2026-07-24');
  for (const [title, status] of [
    ['Creatine', 'completed'],
    ['Zone 2', 'skipped'],
    ['Magnesium', 'pending'],
  ]) {
    insertMissionItem(db, dayA.id, 'habit', { id: '', title, status, category: 'Routine' });
  }

  // Today: 2 planned, both completed.
  const dayB = getOrCreateDailyLog(db, TODAY);
  for (const title of ['Creatine', 'Walk']) {
    insertMissionItem(db, dayB.id, 'habit', { id: '', title, status: 'completed' });
  }

  const series = missionDailySeries(db, 14, TODAY);
  const a = series.find((p) => p.date === '2026-07-24');
  const b = series.find((p) => p.date === TODAY);
  series.length === 14 && series[13].date === TODAY
    ? ok('14 points, ending today')
    : bad('window', JSON.stringify(series.map((p) => p.date)));
  a && a.planned === 3 && a.completed === 1 && a.skipped === 1
    ? ok('a mixed day counts planned/completed/skipped separately')
    : bad('mixed day', JSON.stringify(a));
  b && b.planned === 2 && b.completed === 2
    ? ok('today counts 2 of 2')
    : bad('today', JSON.stringify(b));
  const quiet = series.find((p) => p.date === '2026-07-25');
  quiet && quiet.planned === 0 && quiet.completed === 0
    ? ok('a day with no daily_log zero-fills as planned:0, not as a gap')
    : bad('zero-fill', JSON.stringify(quiet));
}

console.log('\n13b. missionDailySeries: ad-hoc captures and removed items are NOT plan');
{
  const { db } = freshDb();
  const day = getOrCreateDailyLog(db, TODAY);
  insertMissionItem(db, day.id, 'habit', { id: '', title: 'Creatine', status: 'completed' });
  const doomed = insertMissionItem(db, day.id, 'habit', {
    id: '',
    title: 'Sauna',
    status: 'pending',
  });

  // An ad-hoc Log-tab capture — value.adhoc, written here as raw SQL so the
  // test asserts against the SHAPE the log repository writes, not against a
  // helper that could drift with it.
  db.run(
    `INSERT INTO log_entries (id, daily_log_id, type, title, status, value, source)
     VALUES ('adhoc-1', ?, 'note', 'Slept badly', 'completed', '{"adhoc":true}', 'manual')`,
    [day.id]
  );
  // A row the user removed from the day: tombstoned, settled as skipped.
  const removedId = db.get(
    `SELECT id FROM log_entries WHERE daily_log_id = ? AND title = 'Sauna'`,
    [day.id]
  ).id;
  removeMissionItem(db, day.id, removedId);

  const today = missionDailySeries(db, 7, TODAY).find((p) => p.date === TODAY);
  today && today.planned === 1 && today.completed === 1 && today.skipped === 0
    ? ok('the ad-hoc note and the tombstone are both excluded')
    : bad('exclusions', JSON.stringify(today));
  void doomed;
}

console.log('\n13c. missionAdherence: rate over OWED days only, null when none');
{
  const day = (date, planned, completed, skipped, excused = 0, mode = 'normal') => ({
    date,
    mode,
    planned,
    completed,
    skipped,
    excused,
  });
  const empty = missionAdherence([day('d1', 0, 0, 0), day('d2', 0, 0, 0)]);
  empty === null
    ? ok('a window that planned nothing has no rate (null, never 0%)')
    : bad('empty window', String(empty));

  const rate = missionAdherence([
    day('d1', 4, 3, 1),
    // A no-plan day must not drag the average down.
    day('d2', 0, 0, 0),
    day('d3', 6, 3, 0),
  ]);
  near(rate, 6 / 10)
    ? ok('6 of 10 planned = 60%, the empty day ignored')
    : bad('rate', String(rate));

  // The denominator choice, asserted as a number rather than left to prose:
  // an excused skip LEAVES the denominator. Counted as met it would read 4/4;
  // counted as a miss, 3/4; excluded, 3/3.
  const excusedRate = missionAdherence([day('d1', 4, 3, 0, 1, 'sick')]);
  near(excusedRate, 1)
    ? ok('an excused skip leaves the denominator (3 of 3, not 3 of 4 or 4 of 4)')
    : bad('excused denominator', String(excusedRate));
  missionOwed(day('d1', 4, 3, 0, 1, 'sick')) === 3
    ? ok('missionOwed is planned − excused')
    : bad('missionOwed');
  missionAdherence([day('d1', 3, 0, 0, 3, 'sick')]) === null
    ? ok('a day the mode excused ENTIRELY owes nothing and has no rate')
    : bad('fully excused day', String(missionAdherence([day('d1', 3, 0, 0, 3, 'sick')])));
}

console.log('\n13d. mode-aware adherence: a skip while Sick is the right call, not a miss');
{
  const { db } = freshDb();
  const SICK = '2026-07-22';
  const NORMAL = '2026-07-23';

  // The same day twice over, once under each mode: 3 planned, 1 completed,
  // 1 skipped, 1 untouched. Only the mode differs, so any difference in the
  // numbers below is the mode doing its job.
  for (const date of [SICK, NORMAL]) {
    const log = getOrCreateDailyLog(db, date);
    for (const [title, status] of [
      ['Creatine', 'completed'],
      ['Zone 2', 'skipped'],
      ['Magnesium', 'pending'],
    ]) {
      insertMissionItem(db, log.id, 'habit', { id: '', title, status, category: 'Routine' });
    }
  }
  // Sick for one day only. Deload is the control that must NOT excuse: it is a
  // plan you are still meant to execute (registry.excusesSkips === false).
  setMode(db, { mode: 'sick', startDate: SICK, endDate: SICK });
  setMode(db, { mode: 'deload', startDate: NORMAL, endDate: NORMAL });

  const series = missionDailySeries(db, 14, TODAY);
  const sick = series.find((p) => p.date === SICK);
  const deload = series.find((p) => p.date === NORMAL);
  sick && sick.mode === 'sick' && deload && deload.mode === 'deload'
    ? ok('each day carries its own mode')
    : bad('day modes', JSON.stringify([sick?.mode, deload?.mode]));
  sick && sick.excused === 1 && sick.skipped === 0
    ? ok('the Sick day’s skip is EXCUSED, not counted against it')
    : bad('sick day split', JSON.stringify(sick));
  deload && deload.excused === 0 && deload.skipped === 1
    ? ok('the Deload day’s skip is still a miss — a deload is a plan, not a pass')
    : bad('deload day split', JSON.stringify(deload));
  sick && sick.planned === 3 && missionOwed(sick) === 2
    ? ok('planned still says 3 — the day’s plan is a fact, only the denominator moves')
    : bad('planned preserved', JSON.stringify(sick));

  // The headline. Excused-excluded: 1/2 + 1/3 → 2 of 5 = 40%.
  // Counted as a miss it would be 2 of 6 = 33%; counted as met, 3 of 6 = 50%.
  near(missionAdherence([sick, deload]), 2 / 5)
    ? ok('the rate is 2 of 5 owed, not 2 of 6 planned')
    : bad('rate', String(missionAdherence([sick, deload])));

  // …and the same rule reaches "Where it's failing", which is the half of the
  // screen that names a protocol to go and change.
  const sources = missionBySource(db, SICK, NORMAL);
  const record = sources.find((s) => s.name === 'Routine');
  record && record.excused === 1 && record.skipped === 1
    ? ok('by-source splits the two skips the same way the day series does')
    : bad('source split', JSON.stringify(record));
  const zone2 = record?.items.find((i) => i.title === 'Zone 2');
  zone2 && zone2.planned === 2 && zone2.excused === 1 && zone2.skipped === 1
    ? ok('the item that was rested from carries the excuse, per day')
    : bad('item split', JSON.stringify(zone2));
  // 6 planned − 2 completed − 1 excused = 3 missed. Before this change it was 4,
  // and Zone 2 outranked Magnesium on a list of "what you are failing at".
  record && record.planned - record.completed - record.excused === 3
    ? ok('the miss count drops by exactly the excused skip')
    : bad('miss count', JSON.stringify(record));
  record?.items[0]?.title === 'Magnesium'
    ? ok('…so the never-touched item outranks the one correctly rested from')
    : bad('failing order', JSON.stringify(record?.items.map((i) => i.title)));
}

console.log('\n13e. activeModesIn matches getActiveMode day-for-day');
{
  const { db } = freshDb();
  // Overlapping, out-of-order, open-ended, and a reset — the four shapes the
  // "most recently SET covering row wins" rule has to arbitrate.
  setMode(db, { mode: 'travel', startDate: '2026-07-20', endDate: '2026-07-26' });
  setMode(db, { mode: 'sick', startDate: '2026-07-22', endDate: '2026-07-24' });
  setMode(db, { mode: 'social', startDate: '2026-07-23', endDate: '2026-07-23' });
  setMode(db, { mode: 'normal', startDate: '2026-07-25' });
  const from = '2026-07-18';
  const to = '2026-07-28';
  const bulk = activeModesIn(db, from, to);
  const dates = [];
  for (let d = 18; d <= 28; d++) dates.push(`2026-07-${d}`);
  const drift = dates.filter((date) => (bulk.get(date) ?? 'normal') !== getActiveMode(db, date));
  drift.length === 0
    ? ok(`the window read agrees with the per-day read on all ${dates.length} days`)
    : bad('mode resolution drift', drift.join(', '));
  bulk.get('2026-07-23') === 'social' && bulk.get('2026-07-22') === 'sick'
    ? ok('the most-recently-set covering row wins, day by day')
    : bad('winner', JSON.stringify([...bulk]));
  !bulk.has('2026-07-25') && !bulk.has('2026-07-19')
    ? ok('Normal days are omitted — the reset and the uncovered day both read normal')
    : bad('normal leaked into the map', JSON.stringify([...bulk]));
  activeModesIn(db, to, from).size === 0
    ? ok('an inverted range is empty, not an error')
    : bad('inverted range');
}

// ============================================================================
// missionRecordStart / missionBySource (mission.ts) — the execution record
// behind app/mission-history.tsx. Two things must hold: the record must begin
// where the PLAN began (not where any log_entry began), and every judgement
// must be attributable to the thing that generated it, including after that
// thing is deleted.
// ============================================================================

/** Every planned row on a date, keyed by title — the tests set statuses by hand. */
function entryIds(db, date) {
  const rows = db.all(
    `SELECT e.id, e.title FROM log_entries e
       JOIN daily_logs d ON d.id = e.daily_log_id
      WHERE d.date = ?`,
    [date]
  );
  return new Map(rows.map((r) => [r.title, r.id]));
}

console.log('\n14. missionRecordStart: where the PLAN began, not where any row did');
{
  const { db } = freshDb();
  missionRecordStart(db) === null
    ? ok('an empty database has no record start (null, never a date)')
    : bad('empty record start', String(missionRecordStart(db)));

  const early = getOrCreateDailyLog(db, '2026-07-20');
  insertMissionItem(db, early.id, 'habit', { id: '', title: 'Creatine', status: 'completed' });
  const later = getOrCreateDailyLog(db, '2026-07-24');
  insertMissionItem(db, later.id, 'habit', { id: '', title: 'Zone 2', status: 'skipped' });
  missionRecordStart(db) === '2026-07-20'
    ? ok('the record starts on the earliest PLANNED day')
    : bad('record start', String(missionRecordStart(db)));

  // An ad-hoc Log-tab capture on a much earlier day is not a plan, so it must
  // not drag the record back — a note typed in June is not evidence that a
  // mission existed in June.
  const ancient = getOrCreateDailyLog(db, '2026-06-01');
  db.run(
    `INSERT INTO log_entries (id, daily_log_id, type, title, status, value, source)
     VALUES ('adhoc-early', ?, 'note', 'Slept badly', 'completed', '{"adhoc":true}', 'manual')`,
    [ancient.id]
  );
  missionRecordStart(db) === '2026-07-20'
    ? ok('an ad-hoc capture on an earlier day does not move the record start')
    : bad('adhoc moved the start', String(missionRecordStart(db)));

  // A removed (tombstoned) row is likewise not a day the plan asked anything.
  const tomb = getOrCreateDailyLog(db, '2026-07-01');
  insertMissionItem(db, tomb.id, 'habit', { id: '', title: 'Sauna', status: 'pending' });
  removeMissionItem(db, tomb.id, entryIds(db, '2026-07-01').get('Sauna'));
  missionRecordStart(db) === '2026-07-20'
    ? ok('a day whose only row was removed does not move the record start')
    : bad('tombstone moved the start', String(missionRecordStart(db)));
}

console.log('\n14b. missionBySource: one protocol, four-way counts, worst item first');
{
  const { db } = freshDb();
  const stack = createProtocolWithVersion(
    db,
    { name: 'Evening stack', type: 'supplement_stack' },
    {
      items: [
        { title: 'Magnesium', scheduled_time: '21:00', dose: '400 mg', notes: null },
        { title: 'Creatine', scheduled_time: '21:00', dose: '5 g', notes: null },
      ],
    }
  );
  const DAYS = ['2026-07-22', '2026-07-23', '2026-07-24'];
  for (const date of DAYS) generateMissionForDay(db, date);

  // Creatine done all three days. Magnesium: done once, skipped once, and left
  // untouched once — three DIFFERENT outcomes, which is the whole point of
  // counting four ways rather than scoring one.
  for (const date of DAYS) setMissionStatus(db, entryIds(db, date).get('Creatine'), 'completed');
  setMissionStatus(db, entryIds(db, DAYS[0]).get('Magnesium'), 'completed');
  setMissionStatus(db, entryIds(db, DAYS[1]).get('Magnesium'), 'skipped');

  const sources = missionBySource(db, DAYS[0], DAYS[2]);
  sources.length === 1
    ? ok('two items from one protocol roll up to ONE source')
    : bad('source count', JSON.stringify(sources.map((s) => s.name)));
  const source = sources[0];
  source.name === 'Evening stack' && source.kind === 'protocol' && source.protocolId === stack
    ? ok('named from the LIVE protocol row, and carries the id that routes back')
    : bad('attribution', JSON.stringify({ name: source.name, kind: source.kind }));
  source.planned === 6 && source.completed === 4 && source.skipped === 1 && source.partial === 0
    ? ok('6 planned, 4 done, 1 skipped, 0 partial')
    : bad('source totals', JSON.stringify(source));
  source.planned - source.completed - source.skipped - source.partial === 1
    ? ok('the remainder is 1 untouched — the ledger sums to planned')
    : bad('ledger does not sum', JSON.stringify(source));
  source.items.length === 2 && source.items[0].title === 'Magnesium'
    ? ok('items are worst-missed first (Magnesium 2 missed before Creatine 0)')
    : bad('item order', JSON.stringify(source.items.map((i) => i.title)));
  source.items[0].planned === 3 && source.items[0].completed === 1 && source.items[0].skipped === 1
    ? ok('the worst item carries its own three-day record')
    : bad('worst item', JSON.stringify(source.items[0]));

  console.log('\n14c. missionBySource: the range is inclusive at both ends and does not leak');
  const outside = '2026-07-25';
  generateMissionForDay(db, outside);
  setMissionStatus(db, entryIds(db, outside).get('Magnesium'), 'completed');
  const clipped = missionBySource(db, DAYS[0], DAYS[2]);
  clipped[0].planned === 6
    ? ok('a day after `to` does not leak into the window')
    : bad('upper-bound leak', JSON.stringify(clipped[0]));
  const narrow = missionBySource(db, DAYS[1], DAYS[1]);
  narrow[0].planned === 2
    ? ok('a single-day range returns exactly that day')
    : bad('single-day range', JSON.stringify(narrow[0]));
  missionBySource(db, DAYS[2], DAYS[0]).length === 0
    ? ok('an inverted range (`to` before `from`) is empty, not an error')
    : bad('inverted range', 'expected []');

  console.log('\n14d. missionBySource and missionDailySeries agree, by construction');
  // app/mission-history.tsx prints the rate from missionAdherence(series) and
  // the ledger beneath it from the source totals. If those two ever counted
  // different rows the screen would contradict itself on one line.
  const series = missionDailySeries(db, 14, outside).filter((p) => p.date < outside);
  const seriesPlanned = series.reduce((n, p) => n + p.planned, 0);
  const seriesCompleted = series.reduce((n, p) => n + p.completed, 0);
  const sourcePlanned = clipped.reduce((n, s) => n + s.planned, 0);
  const sourceCompleted = clipped.reduce((n, s) => n + s.completed, 0);
  seriesPlanned === sourcePlanned && seriesCompleted === sourceCompleted
    ? ok(`both count ${seriesPlanned} planned / ${seriesCompleted} done over the same days`)
    : bad(
        'series vs sources',
        `${seriesPlanned}/${seriesCompleted} vs ${sourcePlanned}/${sourceCompleted}`
      );
  near(missionAdherence(series), sourceCompleted / sourcePlanned)
    ? ok('the rate the screen prints is the ratio of the ledger beneath it')
    : bad('rate vs ledger', String(missionAdherence(series)));

  console.log('\n14e. a deleted protocol keeps its name and loses its route');
  deleteProtocol(db, stack);
  const orphaned = missionBySource(db, DAYS[0], DAYS[2]);
  orphaned.length === 1 &&
  orphaned[0].name === 'Evening stack' &&
  orphaned[0].kind === 'protocol_gone' &&
  orphaned[0].protocolId === null
    ? ok('history survives the delete, still named, no longer navigable')
    : bad('orphaned source', JSON.stringify(orphaned));
  orphaned[0].planned === 6 && orphaned[0].completed === 4
    ? ok('and its counts are unchanged — ON DELETE SET NULL, never CASCADE')
    : bad('orphaned counts', JSON.stringify(orphaned[0]));
}

console.log('\n14f. missionBySource: modes/experiments attribute by category; noise excluded');
{
  const { db } = freshDb();
  const day = getOrCreateDailyLog(db, '2026-07-24');
  // A mode item: `category`, never `protocol` (the exclusivity rule in
  // mission-generate.ts). It has no protocol to route to and must say so.
  insertMissionItem(db, day.id, 'habit', {
    id: '',
    title: 'Rest — no training today',
    status: 'skipped',
    category: 'Sick',
  });
  // A hand-added row with no attribution at all.
  insertMissionItem(db, day.id, 'habit', { id: '', title: 'Stretch', status: 'pending' });
  // Neither of these is a plan item.
  db.run(
    `INSERT INTO log_entries (id, daily_log_id, type, title, status, value, source)
     VALUES ('adhoc-2', ?, 'note', 'Felt rough', 'completed', '{"adhoc":true}', 'manual')`,
    [day.id]
  );
  insertMissionItem(db, day.id, 'habit', { id: '', title: 'Sauna', status: 'pending' });
  removeMissionItem(db, day.id, entryIds(db, '2026-07-24').get('Sauna'));

  const sources = missionBySource(db, '2026-07-24', '2026-07-24');
  const names = sources.map((s) => s.name).sort();
  JSON.stringify(names) === JSON.stringify(['Sick', 'Unattributed'])
    ? ok('the mode item files under its label; the unattributed one says so')
    : bad('attribution names', JSON.stringify(names));
  sources.every((s) => s.kind === 'other' && s.protocolId === null)
    ? ok('neither is navigable — there is no protocol behind either')
    : bad('navigability', JSON.stringify(sources.map((s) => s.kind)));
  sources.reduce((n, s) => n + s.planned, 0) === 2
    ? ok('the ad-hoc note and the tombstoned row are both excluded')
    : bad('exclusions', JSON.stringify(sources));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
