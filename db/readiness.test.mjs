/**
 * Headless test of the readiness derivation (src/lib/home/readiness.ts)
 * against real SQLite — baselines, pillar gradings, the RHR degradation, the
 * ≥5-day evidence gate, and honest unknowns. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { recentSourceDevices, upsertWearableRows } from '../src/lib/db/repositories/wearables.ts';
import { getGoalDirection, setGoalDirection } from '../src/lib/db/repositories/user.ts';
import {
  deriveReadiness,
  expectedDayFraction,
  hrvLevel,
  isTimezoneChangedDay,
  kcalLevel,
  nutritionVerdict,
  paceRatio,
  proteinLevel,
  rhrLevel,
  sleepLevel,
  strainLevel,
  strainVerdict,
} from '../src/lib/home/readiness.ts';
import {
  appleHealthLogKey,
  blankSyncFailedAt,
  garminNeverSends,
  GARMIN_NEVER_SENDS,
  ledgerEmptyNote,
  metricCellPress,
  metricSyncCell,
  noneFromAppleHealth,
  NO_READING,
  subscribeBlankSyncFailure,
  syncFromBlank,
} from '../src/lib/home/metric-sync.ts';
import { clockFromISO } from '../src/lib/db/date.ts';

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

/**
 * One session of `sets` working sets of the bench press — chosen because its
 * seeded mapping is one primary + two secondaries, so every set is exactly
 * **2.0 role-weighted units** and the arithmetic in §6 is checkable by eye.
 */
function plantSession(db, date, sets, exerciseId = 'barbell-bench-press') {
  const workoutId = `w-${date}-${exerciseId}`;
  db.run(`INSERT INTO workouts (id, date, name, kind) VALUES (?, ?, '', 'strength')`, [
    workoutId,
    date,
  ]);
  for (let i = 0; i < sets; i++) {
    db.run(
      `INSERT INTO workout_sets (id, workout_id, exercise, exercise_id, set_index, set_type, reps, weight_kg)
       VALUES (?, ?, 'Barbell Bench Press', ?, ?, 'normal', 8, 80)`,
      [`${workoutId}-${i}`, workoutId, exerciseId, i]
    );
  }
}

/** Five prior sessions of 12 sets — a 24.0-unit "usual session" baseline. */
function plantUsualBaseline(db, sets = 12) {
  for (let i = 2; i <= 6; i++) plantSession(db, daysAgo(i), sets);
}

function plantEnergy(db, date, value) {
  upsertWearableRows(db, [
    {
      date,
      metricType: 'active_energy_kcal',
      value,
      unit: 'kcal',
      sourceDevice: 'apple_health',
      sourceRawId: `hk:active_energy_kcal:${date}`,
      startTime: null,
      endTime: null,
      metadata: {},
    },
  ]);
}

/** 500 kcal on each of days 2..11 ago — the denominator for an energy ratio. */
function plantEnergyBaseline(db, value = 500) {
  for (let i = 2; i <= 11; i++) plantEnergy(db, daysAgo(i), value);
}

const strainOf = (db) => deriveReadiness(db, TODAY).pillars.find((p) => p.label === 'Strain');

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

console.log("6. strain is ARC's OWN logged volume — the calibration, pinned");
{
  // Owner, 2026-08-25: "switch to ARC computing". The retired rule was
  // yesterday's active energy over its own mean, and a hard resistance session
  // burns few calories — so the morning after a back day this pillar read
  // `optimal / fresh` while the muscle figure on the same screen reported lats
  // at 27%. Every case below is a representative day pinned to a level: this
  // block is the SPECIFICATION of strainLevel's bands, not a sample of them.
  //
  // Baseline throughout: five prior sessions of 12 bench sets = 24.0 units each,
  // so 1.0 is exactly "your usual session".

  // (a) A rest day is a legitimate zero, and reads fresh.
  {
    const db = freshDb();
    plantUsualBaseline(db);
    const strain = strainOf(db);
    strain.level === 'optimal' && strain.note === 'no training logged yesterday'
      ? ok('rest day → optimal, and says nothing was LOGGED rather than "you rested"')
      : bad('rest day', JSON.stringify(strain));
  }

  // (b) A light accessory day: 5 sets = 10 units = 0.42× → still fresh.
  {
    const db = freshDb();
    plantUsualBaseline(db);
    plantSession(db, daysAgo(1), 5);
    const strain = strainOf(db);
    strain.level === 'optimal' && strain.note === '0.4× your usual session'
      ? ok('5-set accessory day → 0.4× → optimal')
      : bad('light day', JSON.stringify(strain));
  }

  // (c) A usual session is the middle of the scale, by construction.
  {
    const db = freshDb();
    plantUsualBaseline(db);
    plantSession(db, daysAgo(1), 12);
    const strain = strainOf(db);
    strain.level === 'good' && strain.note === '1.0× your usual session'
      ? ok('a typical 12-set session → 1.0× → good')
      : bad('usual day', JSON.stringify(strain));
  }

  // (d) THE DEFECT, pinned. A 17-set back day that burned almost nothing.
  // Active energy well BELOW baseline must not be able to talk the reading back
  // down: `max` is one-directional.
  {
    const db = freshDb();
    plantUsualBaseline(db);
    plantSession(db, daysAgo(1), 17);
    plantEnergyBaseline(db, 500);
    plantEnergy(db, daysAgo(1), 300); // 0.6× — a quiet day by calories
    const strain = strainOf(db);
    strain.level === 'caution' && strain.note === '1.4× your usual session'
      ? ok('17-set back day with LOW calories → caution (energy cannot lower it)')
      : bad('the defect', JSON.stringify(strain));
  }

  // (e) The far end: 25 sets = 50 units = 2.08×.
  {
    const db = freshDb();
    plantUsualBaseline(db);
    plantSession(db, daysAgo(1), 25);
    strainOf(db).level === 'poor'
      ? ok('a 25-set marathon → 2.1× → poor')
      : bad('marathon', JSON.stringify(strainOf(db)));
  }

  // (f) Sets cannot see a two-hour hike; energy can. It may RAISE the reading,
  // and when it does the note names which instrument spoke.
  {
    const db = freshDb();
    plantUsualBaseline(db);
    plantEnergyBaseline(db, 500);
    plantEnergy(db, daysAgo(1), 950); // 1.9×
    const strain = strainOf(db);
    strain.level === 'poor' && strain.note === 'active energy 90% above your 30-day baseline'
      ? ok('nothing logged but a huge energy day → poor, credited to energy')
      : bad('hike day', JSON.stringify(strain));
  }

  // (g) A rest day whose calories are also quiet stays optimal — energy only
  // moves the reading when it has something of its own to report.
  {
    const db = freshDb();
    plantUsualBaseline(db);
    plantEnergyBaseline(db, 500);
    plantEnergy(db, daysAgo(1), 350); // 0.7× — outranks a zero it AGREES with
    const strain = strainOf(db);
    strain.level === 'optimal' && strain.note === 'no training logged yesterday'
      ? ok('a quiet rest day stays optimal, and the note is the plain fact')
      : bad('quiet rest day', JSON.stringify(strain));
  }

  // (h) The baseline is over TRAINING days, not calendar days. These five
  // sessions sit inside a 30-day window that is otherwise empty; if rest days
  // were averaged in, the denominator would collapse and a usual session would
  // read `poor` every time it happened.
  {
    const db = freshDb();
    plantUsualBaseline(db);
    plantSession(db, daysAgo(1), 12);
    strainOf(db).level === 'good'
      ? ok('25 untrained days in the window do not deflate the baseline')
      : bad('training-day baseline', JSON.stringify(strainOf(db)));
  }
}

console.log('6b. the strain evidence gate — sessions, and never blamed on Apple Health');
{
  // A first-week install: some sessions logged, not yet five.
  {
    const db = freshDb();
    plantSession(db, daysAgo(2), 12);
    plantSession(db, daysAgo(4), 12);
    plantSession(db, daysAgo(1), 30); // a huge day it must still refuse to grade
    const strain = strainOf(db);
    strain.level === 'unknown' && strain.note === '3 more logged sessions before a baseline'
      ? ok('2 prior sessions → unknown, and says how many more')
      : bad('first-week install', JSON.stringify(strain));
  }

  // One short reads "session", not "sessions".
  {
    const db = freshDb();
    for (let i = 2; i <= 5; i++) plantSession(db, daysAgo(i), 12);
    strainOf(db).note === '1 more logged session before a baseline'
      ? ok('singular session is not "1 more sessions"')
      : bad('plural', strainOf(db).note);
  }

  // Nothing logged ever.
  {
    const db = freshDb();
    const strain = strainOf(db);
    strain.level === 'unknown' && strain.note === 'no training logged in ARC yet'
      ? ok('an empty training history says so')
      : bad('never trained', JSON.stringify(strain));
  }

  // A full YEAR of active energy cannot buy a verdict on its own: ARC's volume
  // is primary in the strict sense, and energy alone is the reading the owner
  // rejected.
  {
    const db = freshDb();
    plantEnergyBaseline(db, 500);
    plantEnergy(db, daysAgo(1), 900);
    strainOf(db).level === 'unknown'
      ? ok('energy alone never grades strain')
      : bad('energy-only', JSON.stringify(strainOf(db)));
  }

  // Sets need no HealthKit, so an absent module is not a reason strain is blank
  // and must never be offered as one.
  {
    const db = freshDb();
    const note = deriveReadiness(db, TODAY, { link: 'unsupported' }).pillars.find(
      (p) => p.label === 'Strain'
    ).note;
    !note.includes('Apple Health') && !note.includes('build')
      ? ok('strain never sends the reader to the Apple Health switch')
      : bad('strain blames Apple Health', note);
  }
}

console.log('6c. strainVerdict composition rules');
{
  const base = { setsYesterday: 24, setsBaseline: 24, priorSessions: 8, energyRatio: null };
  strainVerdict({ ...base, energyRatio: 0.2 }).level === 'good'
    ? ok('a low energy ratio cannot pull a 1.0× session below good')
    : bad('max is one-directional');
  strainVerdict({ ...base, energyRatio: 1.9 }).level === 'poor'
    ? ok('a high energy ratio can raise a 1.0× session to poor')
    : bad('energy raises');
  strainVerdict({ ...base, setsBaseline: 0 }).level === 'unknown'
    ? ok('a zero baseline is refused, never divided by')
    : bad('zero baseline');
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
  // Slop pass 3 (docs/ai-slop-candidates-2026-09.md §10): the fact the user
  // needs about their data is that it is not lost — one clause. It used to be a
  // consoling sentence ("…is safe there and will land here once it does").
  off.readiness.detail.endsWith('Readings already in Apple Health will land then.') &&
  !off.readiness.detail.includes('safe there')
    ? ok('…and says nothing is lost in one clause, not a reassurance')
    : bad('unsupported detail tail', off.readiness.detail);
  // Sleep and Recovery only — Nutrition never read a wearable, and Strain
  // stopped reading one on 2026-08-25 (§6b asserts it never blames the link).
  off.pillars
    .filter((p) => p.label === 'Sleep' || p.label === 'Recovery')
    .every((p) => p.note === 'Apple Health is not connected in this build')
    ? ok('and every wearable-derived pillar carries that reason, not a blank')
    : bad('unsupported notes', JSON.stringify(off.pillars));

  const disconnected = deriveReadiness(db, TODAY, { link: 'disconnected' });
  disconnected.readiness.detail.includes('Connect Apple Health')
    ? ok('disconnected → points at the Settings toggle')
    : bad('disconnected detail', disconnected.readiness.detail);
  // Slop pass 3: the route in is the fact. "…to power readiness" narrated the
  // widget reacting — the tail the list's §8 cut from the metrics strip's own
  // copy of this sentence ("…to populate this").
  disconnected.readiness.detail === 'Connect Apple Health in Settings.'
    ? ok('…and gives the route in, and stops')
    : bad('disconnected detail wording', disconnected.readiness.detail);
  disconnected.pillars.find((p) => p.label === 'Sleep').note === 'Apple Health sync is switched off'
    ? ok('a switched-off link reads differently from an absent module')
    : bad('disconnected note');

  const connected = deriveReadiness(db, TODAY, { link: 'connected' });
  connected.readiness.detail.includes('Privacy & Security')
    ? ok('connected but empty → points at the iOS read-permission screen')
    : bad('connected detail', connected.readiness.detail);
}

console.log('9. "how many more days?" — the answer to the owner\'s question');
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

console.log('10. nutrition — direction-aware bands on an expected-by-now pace curve (C7)');
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
  const nutritionOf = (db, hour, minute = 0) =>
    deriveReadiness(db, TODAY, {
      link: 'connected',
      now: new Date(2026, 6, 29, hour, minute, 0),
    }).pillars.find((p) => p.label === 'Nutrition');

  // --- (a) The band table. The owner's numbers, asserted row by row ----------
  //
  // Gaining: +20% optimal · +35% good · +50% caution · beyond poor, mirrored
  // for cutting, symmetric for maintaining. Ratios are end-of-day ratios, which
  // is what paceRatio collapses to once the day has closed.
  {
    const table = [
      // ratio, cut, maintain, gain
      [1.0, 'optimal', 'optimal', 'optimal'],
      [1.1, 'good', 'optimal', 'optimal'],
      [1.25, 'poor', 'caution', 'good'],
      [1.4, 'poor', 'poor', 'caution'],
      [1.6, 'poor', 'poor', 'poor'],
    ];
    const wrong = table.filter(
      ([ratio, cut, maintain, gain]) =>
        kcalLevel(ratio, 'cut') !== cut ||
        kcalLevel(ratio, 'maintain') !== maintain ||
        kcalLevel(ratio, 'gain') !== gain
    );
    wrong.length === 0
      ? ok('the band table holds at 0 / +10 / +25 / +40 / +60% for all three directions')
      : bad(
          'band table',
          wrong
            .map(
              ([r]) =>
                `${r}: ${kcalLevel(r, 'cut')}/${kcalLevel(r, 'maintain')}/${kcalLevel(r, 'gain')}`
            )
            .join(' ')
        );

    // The bolded row of the proposal: one day, three verdicts.
    kcalLevel(2800 / 2400, 'cut') === 'caution' &&
    kcalLevel(2800 / 2400, 'maintain') === 'good' &&
    kcalLevel(2800 / 2400, 'gain') === 'optimal'
      ? ok('2,800 on a 2,400 target: a fault cutting, unremarkable maintaining, the point gaining')
      : bad('the owner’s sentence', kcalLevel(2800 / 2400, 'gain'));

    // Mirrored, not merely loosened: the same 25% miss flips sides.
    kcalLevel(0.75, 'cut') === 'good' &&
    kcalLevel(0.75, 'maintain') === 'caution' &&
    kcalLevel(0.75, 'gain') === 'poor'
      ? ok('and −25% mirrors it — good on a cut, poor on a gain')
      : bad('mirror', kcalLevel(0.75, 'cut'));

    // The no-change default: `maintain` IS the symmetric band this pillar
    // graded with before C7, and it is what an untouched profile reads.
    kcalLevel(1.15) === 'good' && kcalLevel(0.85) === 'good' && kcalLevel(1.05) === 'optimal'
      ? ok('maintain reproduces the pre-C7 symmetric bands exactly')
      : bad('maintain default', kcalLevel(1.15));

    const fresh = freshDb();
    getGoalDirection(fresh) === 'maintain'
      ? ok('and a profile that never set a direction reads maintain')
      : bad('default direction', getGoalDirection(fresh));
  }

  // --- (b) The pace curve ----------------------------------------------------
  {
    const at = (hour, minute = 0, boundary = '00:00') =>
      expectedDayFraction(new Date(2026, 6, 29, hour, minute, 0), boundary);
    const near = (a, b) => Math.abs(a - b) < 1e-9;

    at(9) === 0 && near(at(10), 0.15) && near(at(13), 0.4) && near(at(19), 0.85) && at(23) === 1
      ? ok(
          'the pace curve hits its anchors: 09:00 → 0, 10:00 → .15, 13:00 → .40, 19:00 → .85, 23:00 → 1'
        )
      : bad('anchors', [at(9), at(10), at(13), at(19), at(23)].join(' '));

    near(at(11), 0.15 + (60 / 180) * 0.25) && near(at(20), 0.85 + (60 / 120) * 0.15)
      ? ok('and interpolates linearly between them')
      : bad('interpolation', [at(11), at(20)].join(' '));

    // B3: the curve is measured from the user's day boundary, so a 02:00 snack
    // on a 04:00 day is the END of that day, not the small hours of the next.
    at(2, 0, '04:00') === 1 && at(5, 0, '04:00') === 0
      ? ok('with a 04:00 boundary, 02:00 is a closed day and 05:00 is before the clock starts')
      : bad('boundary rebase', [at(2, 0, '04:00'), at(5, 0, '04:00')].join(' '));
  }

  // --- (c) The projection, and why it is not eaten ÷ expected-by-now ---------
  {
    // A 700-kcal breakfast at 10:00 is 1.94× the 360 expected by then; as a
    // share of the DAY's budget it is 14% ahead, which is what it actually is.
    const r = paceRatio(700, 2400, 0.15);
    Math.abs(r - (1 + (700 - 360) / 2400)) < 1e-9 &&
    kcalLevel(r, 'maintain') === 'good' &&
    kcalLevel(r, 'gain') === 'optimal'
      ? ok('a 700-kcal breakfast at 10:00 is a breakfast, not a "poor" day')
      : bad('projection', `${r} ${kcalLevel(r, 'maintain')}`);

    Math.abs(paceRatio(2800, 2400, 1) - 2800 / 2400) < 1e-9
      ? ok('and at the close the projection IS intake ÷ target')
      : bad('closed projection', paceRatio(2800, 2400, 1));
  }

  // --- (d) The complaint, answered as a number -------------------------------
  //
  // 500 kcal of 2,400 at 11:00 graded `unknown` + "day in progress" before C7.
  {
    const db = freshDb();
    setTargets(db, 2400, 180);
    logMeal(db, 500, 35);
    const pillar = nutritionOf(db, 11);
    pillar.level === 'good'
      ? ok('mid-morning on an ordinary day now TRANSMITS — a grade, not a page-coloured em-dash')
      : bad('transmits', JSON.stringify(pillar));
    // Calories are on pace; 35 g of protein against the ~42 g expected by now
    // is not, and the cap is why this reads `good` rather than `optimal`. Both
    // halves are in the sentence, so the reading is reversible by eye.
    pillar.note ===
    'On pace — 500 of ~560 expected by 11:00 · protein 35 of 180 g — behind, which caps this'
      ? ok('and the note says what pace it graded against, and what held it back')
      : bad('pace note', pillar.note);
  }

  // --- (e) The note, at three times of day -----------------------------------
  {
    // Before the first anchor: no denominator, so no grade and no pretending.
    const db = freshDb();
    setTargets(db, 2400, 180);
    logMeal(db, 300, 25);
    const early = nutritionOf(db, 9);
    early.level === 'unknown' &&
    early.note === 'nothing expected yet — the pace clock starts at 10:00'
      ? ok('09:00 — unknown, and honest about why')
      : bad('pre-clock', JSON.stringify(early));

    // The owner's own example sentence, reproduced exactly.
    const db2 = freshDb();
    setTargets(db2, 3125, null);
    logMeal(db2, 1140, 0);
    const midday = nutritionOf(db2, 13);
    midday.note === 'On pace — 1,140 of ~1,250 expected by 13:00' && midday.level === 'optimal'
      ? ok('13:00 — "On pace — 1,140 of ~1,250 expected by 13:00"')
      : bad('midday note', JSON.stringify(midday));

    // Closed, over target, gaining: the direction is named BECAUSE it changed
    // the reading (strainNote's discipline).
    const db3 = freshDb();
    setGoalDirection(db3, 'gain');
    setTargets(db3, 2400, null);
    logMeal(db3, 2800, 0);
    const closed = nutritionOf(db3, 21);
    closed.level === 'optimal' &&
    closed.note ===
      'Over target — 2,800 of 2,400 kcal for the day · ahead of target, which is the point while gaining'
      ? ok('21:00 gaining — over target, optimal, and the note says the direction did it')
      : bad('closed gain note', JSON.stringify(closed));

    // The same day on maintain: same numbers, no direction clause, and `good`.
    const db4 = freshDb();
    setTargets(db4, 2400, null);
    logMeal(db4, 2800, 0);
    const level4 = nutritionOf(db4, 21);
    level4.level === 'good' && !level4.note.includes('gaining') && !level4.note.includes('cut')
      ? ok('and the direction is never named when it changed nothing')
      : bad('silent direction', JSON.stringify(level4));
  }

  // --- (f) Protein weighs alongside calories ---------------------------------
  {
    // Met → lifts a borderline calorie reading one step (good → optimal).
    const db = freshDb();
    setTargets(db, 2400, 180);
    logMeal(db, 2750, 185);
    const lifted = nutritionOf(db, 21);
    lifted.level === 'optimal' && lifted.note.includes('which lifts this a step')
      ? ok('a hit protein target lifts a borderline calorie reading one step')
      : bad('protein lift', JSON.stringify(lifted));

    // Missed → caps it at protein's own level (optimal calories → good).
    const db2 = freshDb();
    setTargets(db2, 2400, 180);
    logMeal(db2, 2400, 160);
    const capped = nutritionOf(db2, 21);
    capped.level === 'good' && capped.note.includes('behind, which caps this')
      ? ok('a missed protein target caps an otherwise optimal day')
      : bad('protein cap', JSON.stringify(capped));

    // And a lift is never a rescue: `poor` is not borderline. This is the case
    // that used to read `optimal` outright.
    const db3 = freshDb();
    setTargets(db3, 2400, 180);
    logMeal(db3, 1200, 185);
    nutritionOf(db3, 21).level === 'poor'
      ? ok('protein met cannot rescue a half-eaten day — poor stays poor')
      : bad('no rescue', JSON.stringify(nutritionOf(db3, 21)));

    // The bands themselves, one-sided: overshooting protein is never a fault.
    proteinLevel(1.4) === 'optimal' && proteinLevel(0.86) === 'good' && proteinLevel(0.5) === 'poor'
      ? ok('protein is one-sided in every direction — there is no upper band')
      : bad('protein bands', proteinLevel(1.4));
  }

  // --- (g) The states that were already right, preserved ---------------------
  {
    const db = freshDb();
    logMeal(db, 400, 30);
    const pillar = nutritionOf(db, 12);
    pillar.level === 'unknown' && pillar.note.includes('no daily targets set')
      ? ok('one meal and NO targets is unknown — never an invented denominator')
      : bad('no-targets', JSON.stringify(pillar));

    const db2 = freshDb();
    setTargets(db2, 2400, 180);
    const open = nutritionOf(db2, 11);
    const shut = nutritionOf(db2, 22);
    open.level === 'unknown' &&
    open.note === 'nothing logged yet' &&
    shut.note === 'nothing logged today'
      ? ok('an empty day is unknown, and reads differently once the day has closed')
      : bad('empty day', JSON.stringify([open, shut]));
  }

  // --- (h) The D4 seam -------------------------------------------------------
  {
    const graded = {
      totals: { kcal: 3400, protein_g: 40, mealCount: 3 },
      targets: { kcal: 2400, protein_g: 180 },
      direction: 'maintain',
      expected: 1,
      clock: '21:00',
    };
    nutritionVerdict(graded).level === 'poor'
      ? ok('a 41%-over day with protein missed is poor…')
      : bad('seam control', JSON.stringify(nutritionVerdict(graded)));

    const quiet = nutritionVerdict({ ...graded, timezoneChanged: true });
    quiet.level === 'unknown' &&
    quiet.note.endsWith('timezone changed today — not graded') &&
    quiet.note.includes(' kcal · ')
      ? ok(
          '…and the same day goes quiet when it is a timezone-change day — figures shown, verdict withheld'
        )
      : bad('timezone quiet', JSON.stringify(quiet));

    isTimezoneChangedDay(freshDb(), TODAY) === false
      ? ok('and the predicate is false on a record with no zone change (D4 landed the marker)')
      : bad('seam default');
  }
}

// ---------------------------------------------------------------------------
// D3b — DOCUMENTATION, not a gate. The owner's answer to question 1 was that
// neither Home pillar moves: Strain stays ARC's logged sets raised by active
// energy, Recovery stays the resting-heart-rate delta. The argument is in
// docs/wearables-subapp.md §15 and it is stronger than "not resting" — heart
// rate at a moment of training is a function of the LOAD at that moment, and
// ARC holds no load control (no pace, no power, no grade). A session average 8
// bpm above the last four could be fatigue, illness, heat, or a harder run; 8
// bpm below could be fitness or parasympathetic suppression. A deterministic
// rule on a confounded signal is exactly what the house rule keeps out of code.
//
// So this asserts a NON-effect, and it is worth a test because the next person
// to read `metadata.hr` land in the store will reasonably wonder why Recovery
// did not move. It did not move on purpose.
console.log('11. in-workout heart rate moves NEITHER Home pillar (D3b, owner answer 1a)');
{
  const withoutHr = freshDb();
  const withHr = freshDb();

  for (const db of [withoutHr, withHr]) {
    plantBaseline(db, 'rhr', 'bpm', 52, 10);
    plantEnergyBaseline(db);
    upsertWearableRows(db, [
      {
        date: TODAY,
        metricType: 'rhr',
        value: 55,
        unit: 'bpm',
        sourceDevice: 'garmin',
        sourceRawId: `hk:rhr:${TODAY}`,
        startTime: null,
        endTime: null,
        metadata: {},
      },
    ]);
  }

  // The same fortnight of sessions, one store carrying heart rate and one not.
  const workoutRow = (hr) => ({
    date: daysAgo(1),
    metricType: 'workout',
    value: 60,
    unit: 'min',
    sourceDevice: 'garmin',
    sourceRawId: 'hk-workout-1',
    startTime: `${daysAgo(1)}T17:00:00.000Z`,
    endTime: `${daysAgo(1)}T18:00:00.000Z`,
    metadata: {
      activity: 'Running',
      activity_type_raw: 37,
      kcal: 610,
      distance_km: 8.4,
      ...(hr ? { hr } : {}),
    },
  });
  upsertWearableRows(withoutHr, [workoutRow(null)]);
  // A figure far outside anything a resting baseline would tolerate, so a
  // pillar that HAD grown an opinion about it could not fail to show one.
  upsertWearableRows(withHr, [workoutRow({ avg: 168, max: 191, method: 'workout' })]);

  const a = deriveReadiness(withoutHr, TODAY);
  const b = deriveReadiness(withHr, TODAY);

  JSON.stringify(a) === JSON.stringify(b)
    ? ok('readiness is byte-identical with and without the figure — no pillar reads it')
    : bad('a pillar moved on heart rate', `${JSON.stringify(a)}\n${JSON.stringify(b)}`);
  JSON.stringify(b).includes('168') === false && JSON.stringify(b).includes('191') === false
    ? ok('…and neither number appears anywhere in the Home payload')
    : bad('a session heart rate leaked into Home', JSON.stringify(b));
}

console.log('\nA blank metric is one tap from an Apple Health sync (2026-09-23)');
{
  // The owner, from the device: "when hrv is blank, put quick apple health sync
  // button there". src/lib/home/metric-sync.ts decides what each blank becomes;
  // every case it names is pinned here, including the two the brief singled
  // out — a sync that cannot run is never offered, and a sync that ran and
  // found nothing says so instead of offering the same button forever.
  const eq = (name, actual, expected) =>
    JSON.stringify(actual) === JSON.stringify(expected)
      ? ok(name)
      : bad(name, `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);

  // The strip's own em-dash. If readiness ever prints a different blank, every
  // case below would silently become a 'reading' — so the two are pinned together.
  const view = deriveReadiness(freshDb(), TODAY);
  view.metrics.every((m) => m.value === NO_READING)
    ? ok('an empty database prints exactly the blank metric-sync keys on, in all four cells')
    : bad('blank drift', JSON.stringify(view.metrics.map((m) => m.value)));

  const hrvBlank = { id: 'hrv', value: NO_READING };
  const hrvRead = { id: 'hrv', value: '48 ms' };

  const logWith = (entries, windowDays = 14) => ({
    at: '2026-07-29T07:02:00.000Z',
    windowDays,
    rowsWritten: 3,
    metrics: entries.map(([metric, returned, error = null]) => ({
      metric,
      label: metric,
      returned,
      rows: returned > 0 ? 1 : 0,
      exclusion: 'source',
      error,
      rejected: null,
    })),
    publish: { armed: false, stalled: false, attempted: 0, succeeded: 0, types: [] },
  });

  // A pass that ran THIS morning, local time, so "as of" has a check to quote.
  const thisMorning = new Date(2026, 6, 29, 7, 2).toISOString();
  const lastNight = new Date(2026, 6, 28, 22, 40).toISOString();

  const ctx = (over = {}) => ({
    link: 'connected',
    available: true,
    running: false,
    lastSyncedAt: thisMorning,
    failedAt: null,
    log: logWith([
      ['hrv', 12],
      ['rhr', 14],
      ['sleep', 30],
      ['steps', 14],
    ]),
    sources: ['apple_health', 'apple_watch'],
    today: TODAY,
    ...over,
  });

  // ── The control only ever replaces a blank ──
  eq('a reading is never touched', metricSyncCell(hrvRead, ctx()), { kind: 'reading' });
  eq('…not even while a pass runs', metricSyncCell(hrvRead, ctx({ running: true })), {
    kind: 'reading',
  });

  // ── Never offer a sync that cannot run ──
  eq(
    'module absent (web, an older build): the plain blank — Settings has nothing to switch on',
    metricSyncCell(hrvBlank, ctx({ link: 'unsupported' })),
    { kind: 'blank' }
  );
  eq(
    'sync switched off: a door to Settings › Apple Health, never a sync',
    metricSyncCell(hrvBlank, ctx({ link: 'disconnected' })),
    { kind: 'connect' }
  );
  eq(
    'HealthKit unavailable on the device: the plain blank',
    metricSyncCell(hrvBlank, ctx({ available: false })),
    { kind: 'blank' }
  );
  eq(
    '…and neither of those is overridden by a running pass',
    [
      metricSyncCell(hrvBlank, ctx({ link: 'unsupported', running: true })).kind,
      metricSyncCell(hrvBlank, ctx({ link: 'disconnected', running: true })).kind,
    ],
    ['blank', 'connect']
  );

  // ── The offer, and what it says beneath itself ──
  eq(
    'connected, blank today, Apple Health does send it: the offer, quoting this morning’s check',
    metricSyncCell(hrvBlank, ctx()),
    { kind: 'offer', note: `none as of ${clockFromISO(thisMorning)}` }
  );
  eq(
    'a pass from last night never looked at today, so its time is not quoted',
    metricSyncCell(hrvBlank, ctx({ lastSyncedAt: lastNight })),
    { kind: 'offer', note: 'not synced today' }
  );
  eq(
    'no pass has ever completed',
    metricSyncCell(hrvBlank, ctx({ lastSyncedAt: null, log: null })),
    { kind: 'offer', note: 'never synced' }
  );

  // ── A pass is running: shown, and not startable twice ──
  eq('a running pass turns the offer into Syncing', metricSyncCell(hrvBlank, ctx({ running: true })), {
    kind: 'syncing',
  });

  // ── Sync ran and there is still none: say so, and keep the tap ──
  // The brief: say so plainly "instead of offering the same button forever".
  // The owner: a sync button on exactly this cell. Both hold — the statement is
  // the note, and the verb changes to "Sync again" (metrics-strip.tsx).
  const noHrv = logWith([
    ['hrv', 0],
    ['rhr', 14],
  ]);
  eq(
    'Apple Health returned no HRV at all on the last pass: the statement, not the first offer',
    metricSyncCell(hrvBlank, ctx({ log: noHrv })),
    { kind: 'none', note: 'Apple Health sent none in 14 days' }
  );
  eq(
    '…and it is still one tap from a sync (a read grant fixed in iOS Settings needs exactly that)',
    metricCellPress(metricSyncCell(hrvBlank, ctx({ log: noHrv }))),
    'sync'
  );
  eq(
    '…and a running pass shows Syncing there too — a tap on it must show that it is working',
    metricSyncCell(hrvBlank, ctx({ log: noHrv, running: true })),
    { kind: 'syncing' }
  );
  eq(
    '…and speaks for its own metric only — RHR in the same log is still offered',
    metricSyncCell({ id: 'rhr', value: NO_READING }, ctx({ log: noHrv })).kind,
    'offer'
  );

  // ── The cause, when it is known: a Garmin never sends HRV ──
  // coverage.ts pins HRV, blood oxygen, respiratory rate and VO₂max as types a
  // Garmin never writes to Apple Health. With a Garmin among the recent sources,
  // that is the reason the cell is blank, and the cell says it.
  const garmin = ['apple_health', 'garmin'];
  eq(
    'a Garmin among the sources and HRV sent none: the cell names the cause',
    metricSyncCell(hrvBlank, ctx({ log: noHrv, sources: garmin })),
    { kind: 'none', note: GARMIN_NEVER_SENDS }
  );
  eq('…in these words', GARMIN_NEVER_SENDS, 'Garmin never sends this to Apple Health');
  eq(
    '…but only for a metric the audit pins as a Garmin "no" — resting HR sent none is not blamed on it',
    noneFromAppleHealth(logWith([['rhr', 0]]), 'rhr', garmin),
    'Apple Health sent none in 14 days'
  );
  eq(
    '…and only with a Garmin actually among the sources',
    noneFromAppleHealth(noHrv, 'hrv', ['apple_health', 'oura']),
    'Apple Health sent none in 14 days'
  );
  eq(
    '…and never without the log’s evidence: a Garmin does not make an errored read "none"',
    noneFromAppleHealth(logWith([['hrv', 0, 'predicate not supported']]), 'hrv', garmin),
    null
  );
  eq(
    'the audit’s Garmin "no" list, through the metric names ARC uses',
    ['hrv', 'spo2_pct', 'respiratory_rate', 'vo2max', 'rhr', 'steps', 'sleep', 'body_temp_c', 'sleep_deep_min'].map(
      garminNeverSends
    ),
    [true, true, true, true, false, false, false, false, false]
  );

  // ── Where a tap goes ──
  eq(
    'the Connect door opens Settings; the offer and Sync again run a pass; nothing else takes a tap',
    [
      metricCellPress({ kind: 'connect' }),
      metricCellPress({ kind: 'offer', note: 'x' }),
      metricCellPress({ kind: 'none', note: 'x' }),
      metricCellPress({ kind: 'syncing' }),
      metricCellPress({ kind: 'blank' }),
      metricCellPress({ kind: 'reading' }),
    ],
    ['settings', 'sync', 'sync', null, null, null]
  );

  // ── Data › Wearables takes the statement, and only while sync is on ──
  const row = (over = {}) => ({
    supported: true,
    enabled: true,
    empty: true,
    log: noHrv,
    metric: 'hrv',
    sources: [],
    ...over,
  });
  eq(
    'an empty ledger row with sync on and the log saying none: the statement replaces "No data yet"',
    ledgerEmptyNote(row()),
    'Apple Health sent none in 14 days'
  );
  eq('…with the cause when a Garmin is the source', ledgerEmptyNote(row({ sources: garmin })), GARMIN_NEVER_SENDS);
  eq(
    'sync switched off, module absent, or a row with data: no statement (the ledger keeps "No data yet")',
    [
      ledgerEmptyNote(row({ enabled: false })),
      ledgerEmptyNote(row({ supported: false })),
      ledgerEmptyNote(row({ empty: false })),
    ],
    [null, null, null]
  );
  eq(
    'a ledger stage row gets no statement — the one sleep count cannot speak for it',
    ledgerEmptyNote(row({ metric: 'sleep_deep_min', log: logWith([['sleep', 0]]) })),
    null
  );

  // ── The sources the cause is read from ──
  {
    const sdb = freshDb();
    const put = (date, metricType, sourceDevice) =>
      upsertWearableRows(sdb, [
        {
          date,
          metricType,
          value: 1,
          unit: 'x',
          sourceDevice,
          sourceRawId: `hk:${metricType}:${date}:${sourceDevice}`,
          startTime: null,
          endTime: null,
          metadata: {},
        },
      ]);
    put(TODAY, 'rhr', 'garmin');
    put(daysAgo(3), 'steps', 'apple_health');
    put(daysAgo(3), 'sleep_duration_min', 'garmin');
    put(daysAgo(20), 'hrv', 'oura'); // outside a 14-day window
    put('2026-07-30', 'hrv', 'whoop'); // after today — not "recent"
    eq(
      'recentSourceDevices: every source in the window, once each, sorted — nothing older or later',
      recentSourceDevices(sdb, TODAY, 14),
      ['apple_health', 'garmin']
    );
    eq('…and an empty table is an empty list', recentSourceDevices(freshDb(), TODAY, 14), []);
  }
  eq(
    'the window is the pass’s own (a first sync reads 90)',
    noneFromAppleHealth(logWith([['hrv', 0]], 90), 'hrv'),
    'Apple Health sent none in 90 days'
  );
  eq('a one-day window is singular', noneFromAppleHealth(logWith([['hrv', 0]], 1), 'hrv'), 'Apple Health sent none in 1 day');
  eq(
    'a read that REPORTED AN ERROR proves nothing — it may have been refused, not empty',
    noneFromAppleHealth(logWith([['hrv', 0, 'predicate not supported']]), 'hrv'),
    null
  );
  eq('a metric the log does not name proves nothing', noneFromAppleHealth(logWith([]), 'hrv'), null);
  eq('no log proves nothing', noneFromAppleHealth(null, 'hrv'), null);

  // The log's names. Sleep is one line for every sleep sample, so only the
  // duration row may be judged by it — a source can send sleep and no stages.
  eq(
    'log keys: Home ids map to themselves, sleep maps to the one sleep line, stages to nothing',
    ['hrv', 'rhr', 'steps', 'sleep', 'sleep_duration_min', 'sleep_deep_min', 'sleep_rem_min'].map(
      appleHealthLogKey
    ),
    ['hrv', 'rhr', 'steps', 'sleep', 'sleep', null, null]
  );
  eq(
    'Home’s Sleep cell is judged by the sleep line',
    metricSyncCell({ id: 'sleep', value: NO_READING }, ctx({ log: logWith([['sleep', 0]]) })),
    { kind: 'none', note: 'Apple Health sent none in 14 days' }
  );

  // ── A failure is quiet, honest, and retryable ──
  const failedAt = new Date(2026, 6, 29, 9, 14).toISOString();
  eq(
    'a failed pass keeps the offer, so it can be retried, and says it failed',
    metricSyncCell(hrvBlank, ctx({ failedAt })),
    { kind: 'offer', note: `sync failed at ${clockFromISO(failedAt)}` }
  );
  eq(
    '…and outranks a stale "sent none", which the failed pass never got to re-check',
    metricSyncCell(hrvBlank, ctx({ failedAt, log: noHrv })).kind,
    'offer'
  );
  eq(
    'a later successful pass, from anywhere, supersedes the failure',
    metricSyncCell(hrvBlank, ctx({ failedAt, lastSyncedAt: new Date(2026, 6, 29, 9, 30).toISOString() })),
    { kind: 'offer', note: `none as of ${clockFromISO(new Date(2026, 6, 29, 9, 30).toISOString())}` }
  );
  eq('a running retry shows Syncing over the failure', metricSyncCell(hrvBlank, ctx({ failedAt, running: true })), {
    kind: 'syncing',
  });

  // ── The tap itself: never throws, records only a real failure ──
  const db = freshDb();
  let heard = 0;
  const stop = subscribeBlankSyncFailure(() => heard++);
  const at = new Date(2026, 6, 29, 9, 14);

  eq(
    'a completed pass is "synced"',
    await syncFromBlank(db, {
      run: async () => ({ status: 'synced', rowsWritten: 4, samplesPublished: 0, syncedAt: null }),
      now: () => at,
    }),
    'synced'
  );
  eq(
    'disabled / unavailable are "skipped", not failures — the cell re-reads the switch instead',
    [
      await syncFromBlank(db, {
        run: async () => ({ status: 'disabled', rowsWritten: 0, samplesPublished: 0, syncedAt: null }),
        now: () => at,
      }),
      await syncFromBlank(db, {
        run: async () => ({ status: 'unavailable', rowsWritten: 0, samplesPublished: 0, syncedAt: null }),
        now: () => at,
      }),
    ],
    ['skipped', 'skipped']
  );
  heard === 0 && blankSyncFailedAt() === null
    ? ok('…and none of those recorded a failure')
    : bad('a non-failure was recorded', String(blankSyncFailedAt()));

  let threw = false;
  let outcome = null;
  try {
    outcome = await syncFromBlank(db, {
      run: async () => {
        throw new Error('database is locked');
      },
      now: () => at,
    });
  } catch {
    threw = true;
  }
  !threw && outcome === 'failed'
    ? ok('a pass that throws resolves "failed" — the tap never throws, and nothing alerts')
    : bad('the failure escaped', String(outcome));
  blankSyncFailedAt() === at.toISOString() && heard === 1
    ? ok('…the failure time is recorded once, and the cell is told')
    : bad('failure not recorded', `${blankSyncFailedAt()} / heard ${heard}`);
  stop();

  // A subscriber that throws while being told must not turn the tap into a throw.
  const stopThrower = subscribeBlankSyncFailure(() => {
    throw new Error('database is locked');
  });
  let escaped = false;
  let told = null;
  try {
    told = await syncFromBlank(db, {
      run: async () => {
        throw new Error('HealthKit query refused');
      },
      now: () => at,
    });
  } catch {
    escaped = true;
  }
  !escaped && told === 'failed'
    ? ok('…and a failure listener that throws still leaves the tap resolving "failed"')
    : bad('a throwing listener escaped the tap', String(told));
  stopThrower();

  // The real default runner, end to end in node: sync is off in a fresh
  // database, so the tracked pass returns `disabled` and the tap is "skipped".
  eq('the default runner goes through the real gate', await syncFromBlank(db), 'skipped');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
