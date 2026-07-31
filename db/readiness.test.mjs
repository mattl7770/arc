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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
