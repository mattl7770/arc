/**
 * Headless test of the readiness derivation (src/lib/home/readiness.ts)
 * against real SQLite — baselines, pillar gradings, the RHR degradation, the
 * ≥5-day evidence gate, and honest unknowns. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { upsertWearableRows } from '../src/lib/db/repositories/wearables.ts';
import {
  deriveReadiness,
  hrvLevel,
  rhrLevel,
  sleepLevel,
  strainLevel,
} from '../src/lib/home/readiness.ts';

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
  const database = {
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
  const executor = {
    exec: (sql) => raw.exec(sql),
    getUserVersion: () => raw.prepare('PRAGMA user_version').get().user_version,
    setUserVersion: (n) => raw.exec(`PRAGMA user_version = ${n}`),
    transaction: database.transaction,
  };
  return { database, executor };
}

function freshDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const { database, executor } = makeDb(raw);
  migrate(executor, MIGRATIONS);
  return database;
}

const TODAY = '2026-07-29';

/** YYYY-MM-DD n days before TODAY (componentwise, local-safe). */
function daysAgo(n) {
  const d = new Date(2026, 6, 29 - n);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Plant `days` of history for a metric ending yesterday, all at `value`. */
function plantBaseline(db, metricType, unit, value, days = 10) {
  const rows = [];
  for (let i = 1; i <= days; i++) {
    rows.push({
      date: daysAgo(i),
      metricType,
      value,
      unit,
      sourceDevice: 'apple_watch',
      sourceRawId: `hk:${metricType}:${daysAgo(i)}`,
      startTime: null,
      endTime: null,
      metadata: {},
    });
  }
  upsertWearableRows(db, rows);
}

function plantToday(db, metricType, unit, value, sourceDevice = 'apple_watch') {
  upsertWearableRows(db, [
    {
      date: TODAY,
      metricType,
      value,
      unit,
      sourceDevice,
      sourceRawId: `hk:${metricType}:${TODAY}`,
      startTime: null,
      endTime: null,
      metadata: {},
    },
  ]);
}

console.log('0. threshold functions');
{
  hrvLevel(1.0) === 'optimal' &&
  hrvLevel(0.94) === 'good' &&
  hrvLevel(0.85) === 'caution' &&
  hrvLevel(0.7) === 'poor'
    ? ok('hrvLevel bands')
    : bad('hrvLevel');
  rhrLevel(-2) === 'optimal' &&
  rhrLevel(2) === 'good' &&
  rhrLevel(6) === 'caution' &&
  rhrLevel(9) === 'poor'
    ? ok('rhrLevel bands')
    : bad('rhrLevel');
  sleepLevel(460) === 'optimal' &&
  sleepLevel(400) === 'good' &&
  sleepLevel(340) === 'caution' &&
  sleepLevel(300) === 'poor'
    ? ok('sleepLevel bands')
    : bad('sleepLevel');
  strainLevel(0.6) === 'optimal' &&
  strainLevel(1.0) === 'good' &&
  strainLevel(1.5) === 'caution' &&
  strainLevel(2.0) === 'poor'
    ? ok('strainLevel bands')
    : bad('strainLevel');
}

console.log('1. empty database — honest unknowns, no fake numbers');
{
  const db = freshDb();
  const view = deriveReadiness(db, TODAY);
  view.hasSignal === false ? ok('hasSignal false') : bad('hasSignal');
  view.readiness.level === 'unknown' && view.readiness.label === 'No recovery signal yet'
    ? ok('verdict unknown with the honest label')
    : bad('verdict', JSON.stringify(view.readiness));
  view.readiness.detail.includes('Apple Health')
    ? ok('detail points at Settings › Apple Health')
    : bad('detail', view.readiness.detail);
  view.pillars.every((p) => p.level === 'unknown')
    ? ok('all four pillars unknown')
    : bad('pillars', JSON.stringify(view.pillars));
  view.metrics.every((m) => m.value === '—')
    ? ok('metrics strip renders — for every gap')
    : bad('metrics', JSON.stringify(view.metrics));
}

console.log('2. the mock-day scenario — suppressed HRV + elevated RHR');
{
  const db = freshDb();
  plantBaseline(db, 'hrv', 'ms', 49, 10);
  plantToday(db, 'hrv', 'ms', 42); // ratio 0.857 → caution
  plantBaseline(db, 'rhr', 'bpm', 54, 10);
  plantToday(db, 'rhr', 'bpm', 58); // +4 — corroborates but below the +5 degrade
  plantBaseline(db, 'sleep_duration_min', 'min', 440, 8);
  plantToday(db, 'sleep_duration_min', 'min', 432); // 7h12 → good
  plantToday(db, 'sleep_deep_min', 'min', 51);
  plantToday(db, 'steps', 'count', 3240, 'apple_health');

  const view = deriveReadiness(db, TODAY);
  view.readiness.level === 'caution' ? ok('verdict caution') : bad('verdict', view.readiness.level);
  view.readiness.label === 'Recovery low'
    ? ok('label "Recovery low"')
    : bad('label', view.readiness.label);
  view.readiness.detail === 'HRV 42 ms · 14% below your 30-day baseline'
    ? ok('detail mirrors the designed sentence exactly')
    : bad('detail', view.readiness.detail);

  const byLabel = Object.fromEntries(view.pillars.map((p) => [p.label, p.level]));
  byLabel.Recovery === 'caution' && byLabel.Sleep === 'good'
    ? ok('pillars: Recovery caution, Sleep good')
    : bad('pillars', JSON.stringify(byLabel));
  byLabel.Nutrition === 'unknown'
    ? ok('no meals → Nutrition unknown')
    : bad('nutrition', byLabel.Nutrition);

  const metric = Object.fromEntries(view.metrics.map((m) => [m.id, m]));
  metric.sleep.value === '7h 12m' && metric.sleep.detail === 'Deep 51m'
    ? ok('sleep cell "7h 12m · Deep 51m"')
    : bad('sleep cell', JSON.stringify(metric.sleep));
  metric.hrv.value === '42 ms' && metric.hrv.detail === '14% below baseline'
    ? ok('hrv cell "42 ms · 14% below baseline"')
    : bad('hrv cell', JSON.stringify(metric.hrv));
  metric.rhr.value === '58 bpm' && metric.rhr.detail === '+4 vs baseline'
    ? ok('rhr cell "58 bpm · +4 vs baseline"')
    : bad('rhr cell', JSON.stringify(metric.rhr));
  metric.steps.value === '3,240' ? ok('steps cell "3,240"') : bad('steps cell', metric.steps.value);
}

console.log('3. RHR corroboration degrades the HRV verdict one level');
{
  const db = freshDb();
  plantBaseline(db, 'hrv', 'ms', 50, 10);
  plantToday(db, 'hrv', 'ms', 46); // 0.92 → good on its own
  plantBaseline(db, 'rhr', 'bpm', 52, 10);
  plantToday(db, 'rhr', 'bpm', 58); // +6 ≥ +5 → degrade
  const view = deriveReadiness(db, TODAY);
  const recovery = view.pillars.find((p) => p.label === 'Recovery');
  recovery.level === 'caution'
    ? ok('good HRV + elevated RHR → caution')
    : bad('degrade', recovery.level);
}

console.log('4. the evidence gate — fewer than 5 baseline days = unknown');
{
  const db = freshDb();
  plantBaseline(db, 'hrv', 'ms', 49, 3); // only 3 prior days
  plantToday(db, 'hrv', 'ms', 20); // would be a scary drop…
  const view = deriveReadiness(db, TODAY);
  const recovery = view.pillars.find((p) => p.label === 'Recovery');
  recovery.level === 'unknown'
    ? ok('3-day baseline is not evidence — Recovery stays unknown')
    : bad('gate', recovery.level);
  const hrvCell = view.metrics.find((m) => m.id === 'hrv');
  hrvCell.value === '20 ms' && hrvCell.detail === 'no baseline yet'
    ? ok('the number still shows, the verdict does not')
    : bad('hrv cell under gate', JSON.stringify(hrvCell));
}

console.log('5. RHR-only fallback when HRV is absent');
{
  const db = freshDb();
  plantBaseline(db, 'rhr', 'bpm', 55, 10);
  plantToday(db, 'rhr', 'bpm', 55);
  const view = deriveReadiness(db, TODAY);
  const recovery = view.pillars.find((p) => p.label === 'Recovery');
  recovery.level === 'optimal'
    ? ok('at-baseline RHR → optimal')
    : bad('rhr fallback', recovery.level);
  view.readiness.detail.startsWith('Resting HR 55 bpm')
    ? ok('detail falls back to the RHR sentence')
    : bad('rhr detail', view.readiness.detail);
}

console.log('6. strain reads yesterday against its 28-day baseline');
{
  const db = freshDb();
  // Baseline ~500 kcal for days 2..11 ago; yesterday 900 → ratio 1.8 → poor.
  for (let i = 2; i <= 11; i++) {
    upsertWearableRows(db, [
      {
        date: daysAgo(i),
        metricType: 'active_energy_kcal',
        value: 500,
        unit: 'kcal',
        sourceDevice: 'apple_health',
        sourceRawId: `hk:active_energy_kcal:${daysAgo(i)}`,
        startTime: null,
        endTime: null,
        metadata: {},
      },
    ]);
  }
  upsertWearableRows(db, [
    {
      date: daysAgo(1),
      metricType: 'active_energy_kcal',
      value: 900,
      unit: 'kcal',
      sourceDevice: 'apple_health',
      sourceRawId: `hk:active_energy_kcal:${daysAgo(1)}`,
      startTime: null,
      endTime: null,
      metadata: {},
    },
  ]);
  const view = deriveReadiness(db, TODAY);
  const strain = view.pillars.find((p) => p.label === 'Strain');
  strain.level === 'poor' ? ok('1.8× yesterday → poor (big day)') : bad('strain', strain.level);
}

console.log('7. verdict = worst of Recovery and Sleep');
{
  const db = freshDb();
  plantBaseline(db, 'hrv', 'ms', 50, 10);
  plantToday(db, 'hrv', 'ms', 51); // optimal recovery
  plantToday(db, 'sleep_duration_min', 'min', 300); // 5h → poor sleep
  const view = deriveReadiness(db, TODAY);
  view.readiness.level === 'poor' && view.readiness.label === 'Back off today'
    ? ok('poor sleep drags an optimal recovery down')
    : bad('worst-of', JSON.stringify(view.readiness));
}

console.log('8. the link state — three different reasons a pillar is blank');
{
  const db = freshDb();
  // The state ARC has actually been in since this pipeline was written: the
  // HealthKit module is not in the binary, so nothing can arrive however well
  // the vendor app is syncing into Apple Health. Telling the owner to connect
  // Apple Health here would be advice they can follow and get nothing from.
  const off = deriveReadiness(db, TODAY, { link: 'unsupported' });
  off.readiness.detail.includes('cannot be read in this build')
    ? ok('unsupported → says the module is not in this build')
    : bad('unsupported detail', off.readiness.detail);
  off.pillars
    .filter((p) => p.label !== 'Nutrition')
    .every((p) => p.note === 'Apple Health is not connected in this build')
    ? ok('and every wearable pillar carries that reason, not a blank')
    : bad('unsupported notes', JSON.stringify(off.pillars));

  const disconnected = deriveReadiness(db, TODAY, { link: 'disconnected' });
  disconnected.readiness.detail.includes('Connect Apple Health')
    ? ok('disconnected → points at the Settings toggle')
    : bad('disconnected detail', disconnected.readiness.detail);
  disconnected.pillars.find((p) => p.label === 'Sleep').note ===
  'Apple Health sync is switched off'
    ? ok('a switched-off link reads differently from an absent module')
    : bad('disconnected note');

  const connected = deriveReadiness(db, TODAY, { link: 'connected' });
  connected.readiness.detail.includes('Privacy & Security')
    ? ok('connected but empty → points at the iOS read-permission screen')
    : bad('connected detail', connected.readiness.detail);
}

console.log("9. \"how many more days?\" — the answer to the owner's question");
{
  // Three prior days of HRV is under the 5-day gate, so Recovery is CORRECTLY
  // unknown. The defect was never the unknown — it was the screen not saying
  // how long was left.
  const db = freshDb();
  plantBaseline(db, 'hrv', 'ms', 50, 3);
  const recovery = deriveReadiness(db, TODAY, { link: 'connected' }).pillars.find(
    (p) => p.label === 'Recovery'
  );
  recovery.level === 'unknown' ? ok('3 prior days → still unknown') : bad('gate');
  recovery.note === '2 more days of HRV or resting heart rate before a baseline'
    ? ok('and it says exactly how many days are left')
    : bad('days remaining', recovery.note);

  // One day short reads "1 more day", not "1 more days".
  const db2 = freshDb();
  plantBaseline(db2, 'hrv', 'ms', 50, 4);
  deriveReadiness(db2, TODAY, { link: 'connected' })
    .pillars.find((p) => p.label === 'Recovery')
    .note.startsWith('1 more day of')
    ? ok('singular day is not "1 more days"')
    : bad('plural');

  // Baseline satisfied but nothing today — a different fact from a short
  // baseline, and it must not claim days are still needed.
  const db3 = freshDb();
  plantBaseline(db3, 'hrv', 'ms', 50, 8);
  const note3 = deriveReadiness(db3, TODAY, { link: 'connected' }).pillars.find(
    (p) => p.label === 'Recovery'
  ).note;
  note3 === 'no HRV or resting heart rate reading today'
    ? ok('a full baseline with no reading today says so, not "N more days"')
    : bad('no-reading note', note3);
}

console.log('10. nutrition is graded against targets, not against "did you open the app"');
{
  const setTargets = (db, kcal, protein) =>
    db.run(
      `INSERT INTO nutrition_targets (id, effective_date, kcal, protein_g)
       VALUES ('t-' || abs(random()), '2026-01-01', ?, ?)`,
      [kcal, protein]
    );
  const logMeal = (db, kcal, protein) =>
    db.run(
      `INSERT INTO meals (id, date, name, kcal, protein_g)
       VALUES ('m-' || abs(random()), ?, 'Meal', ?, ?)`,
      [TODAY, kcal, protein]
    );
  const nutritionOf = (db, hour) =>
    deriveReadiness(db, TODAY, {
      link: 'connected',
      now: new Date(2026, 6, 29, hour, 0, 0),
    }).pillars.find((p) => p.label === 'Nutrition');

  // The old rule outright: one meal logged scored 'good'. It was a fact about
  // whether the app had been opened.
  {
    const db = freshDb();
    logMeal(db, 400, 30);
    const pillar = nutritionOf(db, 12);
    pillar.level === 'unknown' && pillar.note.includes('no daily targets set')
      ? ok('one meal and NO targets is unknown, not "good"')
      : bad('no-targets', JSON.stringify(pillar));
  }

  // A day at 11am is not a failed day.
  {
    const db = freshDb();
    setTargets(db, 2400, 180);
    logMeal(db, 500, 35);
    const pillar = nutritionOf(db, 11);
    pillar.level === 'unknown' && pillar.note.includes('day in progress')
      ? ok('mid-morning, well under target → in progress, not "poor"')
      : bad('in-progress', JSON.stringify(pillar));
    pillar.note.includes('500 / 2,400 kcal') && pillar.note.includes('35 / 180 g protein')
      ? ok('and it shows real progress against real denominators')
      : bad('progress note', pillar.note);
  }

  // The ceiling IS judgable all day — eaten calories cannot be un-eaten.
  {
    const db = freshDb();
    setTargets(db, 2000, 150);
    logMeal(db, 2800, 60);
    const pillar = nutritionOf(db, 11);
    pillar.level === 'poor' && pillar.note.includes('800 kcal over target')
      ? ok('40% over target at 11am is already a completed fact')
      : bad('ceiling', JSON.stringify(pillar));
  }

  // A protein target already met is also a completed fact.
  {
    const db = freshDb();
    setTargets(db, 2400, 150);
    logMeal(db, 1200, 160);
    const pillar = nutritionOf(db, 13);
    pillar.level === 'optimal' && pillar.note.includes('protein target met')
      ? ok('protein hit early reads optimal without waiting for the day to end')
      : bad('protein met', JSON.stringify(pillar));
  }

  // After the close hour both halves grade, and the WORSE one wins — a hit
  // protein target must not paper over a large calorie shortfall.
  {
    const db = freshDb();
    setTargets(db, 2400, 180);
    logMeal(db, 2350, 185);
    nutritionOf(db, 21).level === 'optimal'
      ? ok('a closed day on target both ways → optimal')
      : bad('closed optimal', JSON.stringify(nutritionOf(db, 21)));

    const db2 = freshDb();
    setTargets(db2, 2400, 180);
    logMeal(db2, 1200, 185); // protein met, calories 50% short
    nutritionOf(db2, 21).level === 'poor'
      ? ok('a closed day half-eaten is poor even with protein met — worst-of wins')
      : bad('worst-of', JSON.stringify(nutritionOf(db2, 21)));
  }

  // Nothing logged is not a grade.
  {
    const db = freshDb();
    setTargets(db, 2400, 180);
    const open = nutritionOf(db, 11);
    const closed = nutritionOf(db, 22);
    open.level === 'unknown' &&
    open.note === 'nothing logged yet' &&
    closed.note === 'nothing logged today'
      ? ok('an empty day is unknown, and reads differently once the day has closed')
      : bad('empty day', JSON.stringify([open, closed]));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
