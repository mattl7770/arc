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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
