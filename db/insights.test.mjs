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
import { todayISODate } from '../src/lib/db/date.ts';

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
const TODAY = todayISODate(NOW);
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
  // Must be a FUTURE day: a one-off's date is a "not before" floor (isDueOn),
  // so a PAST-dated one is still due today by design — an unfinished nudge
  // keeps nagging. Only a day that hasn't arrived is genuinely "not today".
  createReminder(db, { title: 'Not today', date: '2099-01-01' });

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

console.log('12. a stale one-off cannot evict today’s reminders from the brief');
{
  const { db } = freshDb();
  // Five months-old one-offs, all pinned at early clock times so they outrank
  // today's real reminders under listActiveReminders' clock-only ordering.
  // Under the "not before" floor they are all still due today (isDueOn), which
  // is the point: they must keep nagging WITHOUT hiding the actual plan.
  for (let i = 0; i < 5; i++) {
    createReminder(db, {
      title: `Stale ${i}`,
      time: `0${i}:30`,
      date: isoDaysAgo(NOW, 150 - i),
    });
  }
  createReminder(db, { title: 'Take magnesium', time: '21:00', repeat: 'daily' });
  createReminder(db, { title: 'Weekly review', time: '18:00', repeat: 'weekly', date: TODAY });

  const brief = generateDailyBrief(db, NOW);
  brief.includes('Take magnesium (21:00)') && brief.includes('Weekly review (18:00)')
    ? ok('today’s daily + weekly reminders both survive five stale one-offs')
    : bad('today evicted', brief);

  const onDeck = brief.slice(brief.indexOf('On deck today:'), brief.indexOf('Still open:'));
  !onDeck.includes('Stale')
    ? ok('no stale one-off is listed under "On deck today"')
    : bad('stale in on-deck', onDeck);
}

console.log('13. an overdue one-off is surfaced, labelled with its age');
{
  const { db } = freshDb();
  createReminder(db, { title: 'Book bloodwork', time: '09:00', date: isoDaysAgo(NOW, 120) });
  createReminder(db, { title: 'Take magnesium', time: '21:00', repeat: 'daily' });

  const brief = generateDailyBrief(db, NOW);
  brief.includes('Still open: Book bloodwork (09:00) — 4 mo overdue.')
    ? ok(`overdue nudge kept, aged, and out of today's line ("${brief}")`)
    : bad('overdue rendering', brief);
  brief.includes('On deck today: Take magnesium (21:00).')
    ? ok('today’s line stays exactly today’s')
    : bad('on-deck line', brief);
}

console.log('14. overdue ranking is oldest-first, stable, and counts the tail honestly');
{
  const { db } = freshDb();
  // Deliberately inserted newest-first and with clock times that would invert
  // the intended order under listActiveReminders' sort.
  createReminder(db, { title: 'Newest', time: '01:00', date: isoDaysAgo(NOW, 3) });
  createReminder(db, { title: 'Middle', time: '02:00', date: isoDaysAgo(NOW, 30) });
  createReminder(db, { title: 'Oldest', time: '03:00', date: isoDaysAgo(NOW, 400) });

  const first = generateDailyBrief(db, NOW);
  first.includes(
    'Still open: Oldest (03:00) — 13 mo overdue · Middle (02:00) — 4 wk overdue, and 1 more.'
  )
    ? ok(`oldest nag first, second named, remainder counted not hidden ("${first}")`)
    : bad('overdue ordering', first);
  generateDailyBrief(db, NOW) === first
    ? ok('the brief is stable across repeated calls')
    : bad('unstable brief', `${first} !== ${generateDailyBrief(db, NOW)}`);
}

console.log('15. an undated legacy one-off is today’s, not "overdue" (no age to claim)');
{
  const { db } = freshDb();
  createReminder(db, { title: 'Someday thing', repeat: 'once' });
  const brief = generateDailyBrief(db, NOW);
  brief.includes('On deck today: Someday thing.') && !brief.includes('Still open')
    ? ok('a floor-less one-off is listed as today’s, never aged')
    : bad('undated one-off', brief);
}

console.log('16. a phone with no watch still gets real insights (steps + energy)');
{
  const { db, raw } = freshDb();
  // The owner's actual device: steps and active/resting energy sync every day,
  // HRV and RHR do not exist and never will. Before this, computeInsights read
  // only hrv/rhr, so a month of daily data produced exactly nothing.
  for (let d = 8; d <= 28; d++) {
    seedWearable(raw, 'steps', d, 6000);
    seedWearable(raw, 'active_energy_kcal', d, 500);
    seedWearable(raw, 'resting_energy_kcal', d, 1700);
  }
  for (let d = 1; d <= 7; d++) {
    seedWearable(raw, 'steps', d, 9000);
    seedWearable(raw, 'active_energy_kcal', d, 700);
    seedWearable(raw, 'resting_energy_kcal', d, 1900);
  }
  // Today, still being accumulated — a partial total that must not read as a drop.
  seedWearable(raw, 'steps', 0, 900);
  seedWearable(raw, 'active_energy_kcal', 0, 60);

  const insights = computeInsights(db, NOW);
  insights.length > 0
    ? ok(`a phone-only device produces insights (${insights.length})`)
    : bad('phone-only device still blind', JSON.stringify(insights));

  // Steps and active energy both rose, so they are ONE activity insight, not two.
  const activity = byId(insights, 'trend-activity-up');
  activity?.tone === 'good' &&
  activity.headline.includes('steps 50%') &&
  activity.headline.includes('active energy 40%')
    ? ok(`one activity line carries both magnitudes ("${activity.headline}")`)
    : bad('activity trend', JSON.stringify(insights.map((i) => i.id)));
  activity &&
  activity.detail.includes('9000 steps') &&
  activity.detail.includes('6000 steps') &&
  activity.detail.includes('700 kcal') &&
  activity.detail.includes('500 kcal')
    ? ok('detail keeps every window average, and today’s partial day is excluded')
    : bad('activity detail', activity?.detail);

  byId(insights, 'trend-resting_energy-up')?.tone === 'info'
    ? ok('resting energy is direction-neutral info, never an instruction')
    : bad('resting energy', JSON.stringify(insights.map((i) => [i.id, i.tone])));
  !insights.some((i) => i.metric === 'hrv' || i.metric === 'rhr')
    ? ok('nothing is claimed about sensors this device does not have')
    : bad('invented hrv/rhr', JSON.stringify(insights.map((i) => i.id)));

  const brief = generateDailyBrief(db, NOW);
  brief.includes('Daily activity up') && !brief.includes('No notable movements')
    ? ok(`the brief names what it sees ("${brief}")`)
    : bad('brief still blind', brief);
}

console.log('17. sleep is a whole night, reported in hours and minutes');
{
  const { db, raw } = freshDb();
  for (let d = 7; d <= 27; d++) seedWearable(raw, 'sleep_duration_min', d, 450);
  for (let d = 0; d <= 6; d++) seedWearable(raw, 'sleep_duration_min', d, 390); // -13.3%
  const insight = byId(computeInsights(db, NOW), 'trend-sleep-down');
  insight?.tone === 'watch' && insight.headline.includes('13.3%')
    ? ok(`sleep down 13.3% fires as watch ("${insight.headline}")`)
    : bad('sleep trend', JSON.stringify(computeInsights(db, NOW)));
  insight && insight.detail.includes('6h 30m') && insight.detail.includes('7h 30m')
    ? ok('sleep is reported as hours and minutes, never a raw minute count')
    : bad('sleep detail', insight?.detail);
}

console.log('18. flat step data: no trend, but the brief still says what it can see');
{
  const { db, raw } = freshDb();
  for (let d = 0; d <= 27; d++) seedWearable(raw, 'steps', d, 8000);
  computeInsights(db, NOW).length === 0
    ? ok('a flat month crosses no threshold — nothing is invented')
    : bad('flat data fired', JSON.stringify(computeInsights(db, NOW)));

  const brief = generateDailyBrief(db, NOW);
  !brief.includes('No notable movements')
    ? ok('the "not enough logged" line is NOT shown to someone logging daily')
    : bad('false emptiness claim', brief);
  brief.includes('steps averaged 8000 a day (7 of the last 7 full days)')
    ? ok(`the brief names the steps it can actually read ("${brief}")`)
    : bad('brief floor line', brief);
}

console.log('19. a genuinely empty device is still told so honestly');
{
  const { db, raw } = freshDb();
  // Some non-wearable logging, far too little for any detector, and NO wearable
  // rows at all. The honest answer here really is "not enough logged".
  seedMeal(raw, 1, 40);
  seedWeight(raw, 1, 81);
  const brief = generateDailyBrief(db, NOW);
  brief.includes('No notable movements')
    ? ok('no wearable data at all → the honest empty brief')
    : bad('empty device', brief);
}

console.log('20. wearable rows outside the window are named, not called nothing');
{
  const { db, raw } = freshDb();
  for (let d = 40; d <= 45; d++) seedWearable(raw, 'steps', d, 8000);
  const brief = generateDailyBrief(db, NOW);
  brief.includes('Apple Health holds 1 metric on this device') &&
  brief.includes(`last synced ${isoDaysAgo(NOW, 40)}`)
    ? ok(`a stale sync is described, not denied ("${brief}")`)
    : bad('stale sync', brief);
}

console.log('21. today’s partial total never enters a stated daily average or its day count');
{
  const { db, raw } = freshDb();
  // Seven complete days at 8000 steps, plus a today that is two hours old.
  // Averaging the partial in gives 7113 over "8 of the last 7 days" — a number
  // no day produced, billed against a day that has not happened yet.
  for (let d = 1; d <= 7; d++) seedWearable(raw, 'steps', d, 8000);
  seedWearable(raw, 'steps', 0, 900);
  // Sleep is a whole fact the night it is written, so today DOES count for it.
  for (let d = 0; d <= 6; d++) seedWearable(raw, 'sleep_duration_min', d, 450);

  const brief = generateDailyBrief(db, NOW);
  brief.includes('steps averaged 8000 a day (7 of the last 7 full days)')
    ? ok(`the average is the complete days only ("${brief}")`)
    : bad('partial day in the average', brief);
  !brief.includes('7113') && !brief.includes('8 of the last')
    ? ok('the partial day moves neither the mean nor the day count')
    : bad('partial day counted', brief);
  brief.includes('sleep averaged 7h 30m (7 of the last 7 days)')
    ? ok('a level metric still counts today — the rule is per metric, not blanket')
    : bad('sleep floor clause', brief);
}

console.log('22. steps and active energy falling together spend ONE brief slot');
{
  const { db, raw } = freshDb();
  for (let d = 8; d <= 28; d++) {
    seedWearable(raw, 'steps', d, 10000);
    seedWearable(raw, 'active_energy_kcal', d, 600);
  }
  for (let d = 1; d <= 7; d++) {
    seedWearable(raw, 'steps', d, 6000); // -40%
    seedWearable(raw, 'active_energy_kcal', d, 380); // -36.7%
  }
  // A second, genuinely different watch fact that must survive the top-3 slice.
  for (let d = 8; d <= 12; d++) seedMeal(raw, d, 150);
  for (let d = 1; d <= 5; d++) seedMeal(raw, d, 120); // -20%

  const insights = computeInsights(db, NOW);
  byId(insights, 'trend-activity-down') &&
  !byId(insights, 'trend-steps-down') &&
  !byId(insights, 'trend-active_energy-down')
    ? ok('one combined activity insight replaces the near-duplicate pair')
    : bad('pair not folded', JSON.stringify(insights.map((i) => i.id)));
  const combined = byId(insights, 'trend-activity-down');
  combined?.tone === 'watch' &&
  combined.detail.includes('6000 steps') &&
  combined.detail.includes('380 kcal')
    ? ok('get_insights still gets every number both detectors found')
    : bad('numbers lost in the fold', JSON.stringify(combined));

  const brief = generateDailyBrief(db, NOW);
  brief.split('Daily activity').length - 1 === 1
    ? ok('the brief says "you moved less" exactly once')
    : bad('duplicate clauses', brief);
  !brief.includes('Daily steps') && !brief.includes('Active energy ')
    ? ok('neither half is restated on its own line')
    : bad('half restated', brief);
  brief.includes('Protein intake down 20%')
    ? ok(`the freed slot goes to a different fact ("${brief}")`)
    : bad('protein crowded out', brief);
}

console.log('23. divergent movement is a real observation — both halves stand');
{
  const { db, raw } = freshDb();
  for (let d = 8; d <= 28; d++) {
    seedWearable(raw, 'steps', d, 6000);
    seedWearable(raw, 'active_energy_kcal', d, 700);
  }
  for (let d = 1; d <= 7; d++) {
    seedWearable(raw, 'steps', d, 9000); // +50%
    seedWearable(raw, 'active_energy_kcal', d, 400); // -42.9%
  }
  const insights = computeInsights(db, NOW);
  byId(insights, 'trend-steps-up') &&
  byId(insights, 'trend-active_energy-down') &&
  !insights.some((i) => i.metric === 'activity')
    ? ok('more steps but less energy burned is two facts, not one')
    : bad('over-merged', JSON.stringify(insights.map((i) => i.id)));
}

console.log('24. a device holding only today’s running total says exactly that');
{
  const { db, raw } = freshDb();
  seedWearable(raw, 'steps', 0, 900);
  const brief = generateDailyBrief(db, NOW);
  brief.includes(`last synced ${TODAY}`) &&
  brief.includes('only today’s running totals') &&
  !brief.includes('nothing in the last 7 days')
    ? ok(`a same-day sync is never called "nothing in the last 7 days" ("${brief}")`)
    : bad('contradictory floor fallback', brief);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
