/**
 * Headless test of the deterministic insights engine (src/lib/ai/insights.ts)
 * against real SQLite via node:sqlite — trends, gaps, symptom volume,
 * correlation, and the composed daily brief. Everything is seeded relative to
 * an injected `now`, so the assertions are date-independent. Mirrors
 * db/nutrition.test.mjs; op-sqlite and the model client are never loaded.
 * Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { computeInsights, generateDailyBrief } from '../src/lib/ai/insights.ts';
import { isoDaysAgo } from '../src/lib/ai/series.ts';
import { createReminder } from '../src/lib/db/repositories/reminders.ts';

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

const NOW = new Date();
let seq = 0;
const uid = () => `t-${++seq}`;

const seedWearable = (raw, metricType, daysAgo, value) =>
  raw
    .prepare(
      `INSERT INTO wearable_data (id, date, metric_type, value, source_device) VALUES (?, ?, ?, ?, 'manual')`
    )
    .run(uid(), isoDaysAgo(NOW, daysAgo), metricType, value);

const seedWeight = (raw, daysAgo, kg) =>
  raw
    .prepare(
      `INSERT INTO body_metrics (id, measured_at, weight_kg, source) VALUES (?, ?, ?, 'manual')`
    )
    .run(uid(), `${isoDaysAgo(NOW, daysAgo)}T08:00:00.000Z`, kg);

const seedMeal = (raw, daysAgo, protein) =>
  raw
    .prepare(`INSERT INTO meals (id, date, name, protein_g) VALUES (?, ?, 'Meal', ?)`)
    .run(uid(), isoDaysAgo(NOW, daysAgo), protein);

const seedWorkout = (raw, daysAgo, minutes, kind = 'cardio') =>
  raw
    .prepare(`INSERT INTO workouts (id, date, name, kind, duration_min) VALUES (?, ?, 'W', ?, ?)`)
    .run(uid(), isoDaysAgo(NOW, daysAgo), kind, minutes);

const seedSymptom = (raw, daysAgo, name) =>
  raw
    .prepare(`INSERT INTO symptoms (id, date, name) VALUES (?, ?, ?)`)
    .run(uid(), isoDaysAgo(NOW, daysAgo), name);

const byId = (insights, id) => insights.find((i) => i.id === id);

console.log('0. an empty database yields no insights and an honest brief');
{
  const { db } = freshDb();
  const insights = computeInsights(db, NOW);
  insights.length === 0
    ? ok('no data → no insights (nothing invented)')
    : bad('empty', JSON.stringify(insights));
  const brief = generateDailyBrief(db, NOW);
  brief.includes('No notable movements')
    ? ok('brief admits there is nothing to read yet')
    : bad('empty brief', brief);
}

console.log('1. HRV down vs baseline → watch trend with real numbers');
{
  const { db, raw } = freshDb();
  for (let d = 8; d <= 17; d++) seedWearable(raw, 'hrv', d, 55);
  for (let d = 0; d <= 4; d++) seedWearable(raw, 'hrv', d, 47);
  const insight = byId(computeInsights(db, NOW), 'trend-hrv-down');
  insight && insight.tone === 'watch'
    ? ok('trend-hrv-down fires as watch')
    : bad('hrv insight missing', JSON.stringify(computeInsights(db, NOW)));
  insight && insight.headline.includes('14.5%')
    ? ok(`headline carries the real magnitude ("${insight.headline}")`)
    : bad('magnitude', insight?.headline);
  insight && insight.detail.includes('47 ms') && insight.detail.includes('55 ms')
    ? ok('detail carries both window averages in display units')
    : bad('detail', insight?.detail);
}

console.log('2. sub-threshold movement stays silent (no noise)');
{
  const { db, raw } = freshDb();
  for (let d = 8; d <= 17; d++) seedWearable(raw, 'hrv', d, 55);
  for (let d = 0; d <= 4; d++) seedWearable(raw, 'hrv', d, 54); // -1.8% < 5%
  computeInsights(db, NOW).length === 0
    ? ok('a 1.8% HRV move does not fire the 5% detector')
    : bad('noise fired', JSON.stringify(computeInsights(db, NOW)));
}

console.log('3. too few readings stays silent (minimum observations)');
{
  const { db, raw } = freshDb();
  seedWearable(raw, 'hrv', 10, 55);
  seedWearable(raw, 'hrv', 9, 55);
  for (let d = 0; d <= 4; d++) seedWearable(raw, 'hrv', d, 40);
  computeInsights(db, NOW).length === 0
    ? ok('2 baseline points < the 3-point minimum → no trend claim')
    : bad('fired on thin data');
}

console.log('4. resting HR up → watch; weight drift → info; protein drop → watch');
{
  const { db, raw } = freshDb();
  for (let d = 8; d <= 14; d++) seedWearable(raw, 'rhr', d, 52);
  for (let d = 0; d <= 3; d++) seedWearable(raw, 'rhr', d, 56); // +7.7%
  for (let d = 8; d <= 14; d++) seedWeight(raw, d, 82);
  for (let d = 0; d <= 3; d++) seedWeight(raw, d, 81); // -1.2%
  for (let d = 8; d <= 12; d++) seedMeal(raw, d, 150);
  for (let d = 0; d <= 4; d++) seedMeal(raw, d, 120); // -20%

  const insights = computeInsights(db, NOW);
  byId(insights, 'trend-rhr-up')?.tone === 'watch'
    ? ok('rising resting HR is a watch')
    : bad('rhr', JSON.stringify(insights));
  byId(insights, 'trend-weight-down')?.tone === 'info'
    ? ok('weight drift is direction-neutral info')
    : bad('weight', JSON.stringify(insights));
  const protein = byId(insights, 'trend-protein-down');
  protein?.tone === 'watch' && protein.headline.includes('20%')
    ? ok('protein intake down 20% is a watch, quantified')
    : bad('protein', JSON.stringify(protein));
  insights.findIndex((i) => i.tone === 'info') > insights.findIndex((i) => i.tone === 'watch')
    ? ok('watch insights rank above info')
    : bad('ordering', JSON.stringify(insights.map((i) => [i.id, i.tone])));
}

console.log('5. training collapse → watch; logging gap → watch with day count');
{
  const { db, raw } = freshDb();
  for (let d = 8; d <= 21; d += 2) seedWorkout(raw, d, 60); // 7 sessions over baseline
  // No training in the last 7 days; last weight 10 days ago.
  seedWeight(raw, 10, 81.6);

  const insights = computeInsights(db, NOW);
  const training = byId(insights, 'trend-training-down');
  training?.tone === 'watch' && training.headline.includes('100%')
    ? ok('training volume -100% vs weekly baseline fires as watch')
    : bad('training', JSON.stringify(insights));
  const gap = byId(insights, 'gap-weight');
  gap && gap.headline.includes('10 days')
    ? ok('weight gap counts the days since the last reading')
    : bad('gap', JSON.stringify(gap));
}

console.log('6. symptom volume above baseline → watch');
{
  const { db, raw } = freshDb();
  for (let d = 0; d <= 3; d++) seedSymptom(raw, d, 'Headache');
  const insight = byId(computeInsights(db, NOW), 'volume-symptoms-up');
  insight && insight.headline.includes('4 symptoms')
    ? ok('4 symptoms this week vs a zero baseline fires')
    : bad('symptoms', JSON.stringify(insight));
}

console.log('7. prior-day training ↔ HRV correlation (perfectly anti-correlated seed)');
{
  const { db, raw } = freshDb();
  for (let i = 1; i <= 10; i++) {
    const minutes = i % 2 === 0 ? 60 : 0;
    seedWorkout(raw, i + 1, minutes); // training the day BEFORE each HRV reading
    seedWearable(raw, 'hrv', i, minutes === 60 ? 40 : 60);
  }
  const insight = byId(computeInsights(db, NOW), 'correlation-hrv-training-neg');
  insight && insight.tone === 'watch'
    ? ok('negative correlation surfaces as watch')
    : bad('correlation', JSON.stringify(computeInsights(db, NOW)));
  insight && insight.detail.includes('r = -1')
    ? ok(`detail reports the coefficient ("${insight.detail.slice(0, 60)}…")`)
    : bad('r value', insight?.detail);
}

console.log('8. the daily brief composes insights + reminders due today');
{
  const { db, raw } = freshDb();
  for (let d = 8; d <= 17; d++) seedWearable(raw, 'hrv', d, 55);
  for (let d = 0; d <= 4; d++) seedWearable(raw, 'hrv', d, 47);
  createReminder(db, { title: 'Take magnesium', time: '21:00', repeat: 'daily' });
  createReminder(db, { title: 'Not today', date: '1999-01-01' });

  const brief = generateDailyBrief(db, NOW);
  brief.includes('HRV down') ? ok('brief leads with the trend') : bad('brief trend', brief);
  brief.includes('Take magnesium (21:00)') && !brief.includes('Not today')
    ? ok('brief lists only reminders due today')
    : bad('brief reminders', brief);
}

console.log('9. the incomplete current day never fires an accumulating-metric trend');
{
  const { db, raw } = freshDb();
  // Steady 150 g/day history; today has ONE meal so far (30 g). Counting the
  // partial day would read as a drop every morning — it must be excluded.
  for (let d = 1; d <= 14; d++) seedMeal(raw, d, 150);
  seedMeal(raw, 0, 30);
  const insights = computeInsights(db, NOW);
  !byId(insights, 'trend-protein-down')
    ? ok('a half-written today does not read as a protein drop')
    : bad('partial-day fired', JSON.stringify(byId(insights, 'trend-protein-down')));
}

console.log('10. duration-less sessions are a data gap, not a training collapse');
{
  const { db, raw } = freshDb();
  for (let d = 8; d <= 18; d += 2) seedWorkout(raw, d, 60); // timed baseline
  for (let d = 2; d <= 6; d += 2) seedWorkout(raw, d, null, 'strength'); // untimed recent
  const insights = computeInsights(db, NOW);
  !byId(insights, 'trend-training-down')
    ? ok('minutes collapsed to 0 but sessions held — no "down 100%" fires')
    : bad('null-duration fired', JSON.stringify(byId(insights, 'trend-training-down')));
}

console.log('11. correlation treats unlogged days as rest days (0 minutes)');
{
  const { db, raw } = freshDb();
  // Workouts only on alternate days — NO explicit 0-minute rows — and HRV
  // dipping the morning after each. Rest days must count as 0 for the pairs.
  for (let i = 1; i <= 10; i++) {
    const trainedPrior = (i + 1) % 2 === 1; // prior day (i+1 ago) odd → trained
    if (trainedPrior) seedWorkout(raw, i + 1, 60);
    seedWearable(raw, 'hrv', i, trainedPrior ? 40 : 60);
  }
  const insight = byId(computeInsights(db, NOW), 'correlation-hrv-training-neg');
  insight
    ? ok('train/rest alternation is detected without explicit 0-minute rows')
    : bad('rest-day correlation missed', JSON.stringify(computeInsights(db, NOW)));
}

console.log('12. an unrecorded macro is not a zero — no fabricated protein decline');
{
  // A steady 180 g/day week where ONE day was logged by name only (blank macros
  // store NULL). Summing that day to 0 g used to read as -14.3% and print
  // "Protein intake down 14.3%" on Home about a decline that never happened.
  const { db, raw } = freshDb();
  for (let d = 8; d <= 20; d++) seedMeal(raw, d, 180);
  for (let d = 1; d <= 7; d++) seedMeal(raw, d, d === 3 ? null : 180);
  const insights = computeInsights(db, NOW);
  !byId(insights, 'trend-protein-down')
    ? ok('a name-only day is skipped, not counted as 0 g')
    : bad('name-only day fired', JSON.stringify(byId(insights, 'trend-protein-down')));
}
{
  // The same failure at meal granularity: 3 of the recent days have one of their
  // three meals blank, so each totals 120 g instead of 180 g → -14.3%.
  const { db, raw } = freshDb();
  for (let d = 8; d <= 20; d++) for (let m = 0; m < 3; m++) seedMeal(raw, d, 60);
  for (let d = 1; d <= 7; d++) {
    for (let m = 0; m < 3; m++) seedMeal(raw, d, d <= 3 && m === 2 ? null : 60);
  }
  const insights = computeInsights(db, NOW);
  !byId(insights, 'trend-protein-down')
    ? ok('a partially recorded day (2 of 3 meals) is skipped too')
    : bad('partial day fired', JSON.stringify(byId(insights, 'trend-protein-down')));
}
{
  // Filtering must feed the evidence gate, not bypass it: 5 name-only days leave
  // 2 usable readings, under MIN_POINTS_PER_WINDOW, so the honest answer is
  // silence — even though those 2 days really are far below baseline.
  const { db, raw } = freshDb();
  for (let d = 8; d <= 20; d++) seedMeal(raw, d, 180);
  for (let d = 1; d <= 7; d++) seedMeal(raw, d, d <= 5 ? null : 100);
  const insights = computeInsights(db, NOW);
  !byId(insights, 'trend-protein-down')
    ? ok('2 usable days < the 3-point minimum → no trend claim')
    : bad('trended on thin data', JSON.stringify(byId(insights, 'trend-protein-down')));
}
{
  // A real decline still fires — and the detail may only claim the days it used.
  const { db, raw } = freshDb();
  for (let d = 8; d <= 20; d++) seedMeal(raw, d, 180);
  for (let d = 1; d <= 7; d++) seedMeal(raw, d, d <= 3 ? null : 120);
  const insight = byId(computeInsights(db, NOW), 'trend-protein-down');
  insight && insight.headline.includes('33.3%')
    ? ok(`a genuine drop across the recorded days still fires ("${insight.headline}")`)
    : bad('real decline missed', JSON.stringify(insight));
  insight && insight.detail.includes('(4 readings)') && !insight.detail.includes('(7 readings)')
    ? ok('detail counts only the 4 complete days, not all 7')
    : bad('reading count', insight?.detail);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
