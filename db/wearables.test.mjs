/**
 * Headless test of the wearables repository (src/lib/db/repositories/wearables.ts)
 * and migration 0021 against real SQLite via node:sqlite: the wearable_data
 * rebuild preserves rows, the upsert dedups on (source_device, source_raw_id),
 * source-priority day picking, series/latest reads, and the sync-state KV.
 * Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate, pendingMigrations } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  dailyMetricSeries,
  deviceLabel,
  getHealthSyncState,
  latestMetric,
  pickDailyMetric,
  recentWearableWorkouts,
  setHealthSyncState,
  upsertWearableRows,
} from '../src/lib/db/repositories/wearables.ts';
import { isHealthSyncEnabled, setHealthSyncEnabled } from '../src/lib/db/repositories/user.ts';
import { quantityDailyRows, SAMPLE_METRICS, sleepDailyRows } from '../src/lib/health/mapping.ts';
import { clampRowsToWindow, syncDayWindows } from '../src/lib/health/sync.ts';

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
  return { raw, db: database };
}

const row = (overrides = {}) => ({
  date: '2026-07-29',
  metricType: 'hrv',
  value: 42,
  unit: 'ms',
  sourceDevice: 'apple_watch',
  sourceRawId: 'hk:hrv:2026-07-29',
  startTime: null,
  endTime: null,
  metadata: { hk: { samples: 3 } },
  ...overrides,
});

console.log('0. migration 0021 — rebuild preserves data, adds apple_health + sync state');
{
  // Apply everything up to 0020, plant legacy rows, then run 0021 on top —
  // exactly what happens on Matt's device.
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const { database, executor } = makeDb(raw);
  const upTo0020 = MIGRATIONS.filter((m) => m.version <= 20);
  migrate(executor, upTo0020);

  database.run(
    `INSERT INTO wearable_data (id, date, metric_type, value, unit, source_device)
     VALUES ('legacy-1', '2026-07-20', 'water_ml', 500, 'ml', 'manual')`
  );
  database.run(
    `INSERT INTO wearable_data (id, date, metric_type, value, unit, source_device, source_raw_id)
     VALUES ('legacy-2', '2026-07-21', 'hrv', 48, 'ms', 'manual', 'seed-raw')`
  );

  migrate(executor, MIGRATIONS);
  const kept = database.all('SELECT * FROM wearable_data ORDER BY id');
  kept.length === 2 && kept[0].id === 'legacy-1' && kept[1].source_raw_id === 'seed-raw'
    ? ok('legacy rows survive the rebuild byte-for-byte')
    : bad('legacy rows', JSON.stringify(kept));

  let threw = false;
  try {
    database.run(
      `INSERT INTO wearable_data (id, date, metric_type, value, unit, source_device)
       VALUES ('x', '2026-07-29', 'steps', 100, 'count', 'apple_health')`
    );
  } catch (e) {
    threw = true;
  }
  !threw ? ok("'apple_health' accepted by the rebuilt CHECK") : bad('apple_health rejected');

  threw = false;
  try {
    database.run(
      `INSERT INTO wearable_data (id, date, metric_type, value, unit, source_device)
       VALUES ('y', '2026-07-29', 'steps', 100, 'count', 'fitbit')`
    );
  } catch (e) {
    threw = true;
  }
  threw ? ok('unknown device still rejected by the CHECK') : bad('CHECK gone');

  // The updated_at trigger was recreated with the table. Deterministic probe:
  // write a stale updated_at in the UPDATE itself — the AFTER UPDATE trigger
  // must overwrite it with now. (Comparing updated_at > created_at is flaky:
  // insert and update can land in the same millisecond.)
  database.run(
    `UPDATE wearable_data SET value = 501, updated_at = '2000-01-01T00:00:00.000Z'
     WHERE id = 'legacy-1'`
  );
  const updated = database.get(
    `SELECT created_at, updated_at FROM wearable_data WHERE id = 'legacy-1'`
  );
  updated.updated_at !== '2000-01-01T00:00:00.000Z' && updated.updated_at >= updated.created_at
    ? ok('updated_at trigger recreated on the rebuilt table')
    : bad('trigger', JSON.stringify(updated));

  // pendingMigrations sees nothing left.
  pendingMigrations(executor.getUserVersion(), MIGRATIONS).length === 0
    ? ok('runner idempotent after 0021')
    : bad('pending after 0021');
}

console.log('1. upsert — insert, re-sync update, no duplicates');
{
  const { db } = freshDb();
  upsertWearableRows(db, [row()]);
  upsertWearableRows(db, [row({ value: 44, metadata: { hk: { samples: 5 } } })]);
  const rows = db.all(`SELECT * FROM wearable_data WHERE metric_type = 'hrv'`);
  rows.length === 1 ? ok('re-sync updates instead of duplicating') : bad('dup', rows.length);
  rows[0].value === 44 ? ok('value updated on conflict') : bad('value', rows[0].value);
  JSON.parse(rows[0].metadata).hk.samples === 5
    ? ok('metadata updated on conflict')
    : bad('metadata', rows[0].metadata);

  // Same raw id, different device → distinct row (composite key).
  upsertWearableRows(db, [row({ sourceDevice: 'oura', value: 47 })]);
  db.all(`SELECT * FROM wearable_data WHERE metric_type = 'hrv'`).length === 2
    ? ok('same day different device coexists')
    : bad('composite key');

  // Unchanged re-sync leaves updated_at alone (the WHERE guard).
  const before = db.get(`SELECT updated_at FROM wearable_data WHERE source_device = 'oura'`);
  upsertWearableRows(db, [row({ sourceDevice: 'oura', value: 47 })]);
  const after = db.get(`SELECT updated_at FROM wearable_data WHERE source_device = 'oura'`);
  before.updated_at === after.updated_at
    ? ok('identical re-sync is a no-op (updated_at untouched)')
    : bad('noop churn', `${before.updated_at} → ${after.updated_at}`);

  let threw = false;
  try {
    upsertWearableRows(db, [row({ metricType: 'BAD-SHAPE' })]);
  } catch {
    threw = true;
  }
  threw ? ok('metric_type shape enforced (^[a-z0-9_]+$)') : bad('shape not enforced');

  threw = false;
  try {
    upsertWearableRows(db, [row({ value: Number.POSITIVE_INFINITY })]);
  } catch {
    threw = true;
  }
  threw ? ok('non-finite value rejected') : bad('Infinity accepted');
}

console.log('2. reads — series, priority pick, latest, workouts');
{
  const { db } = freshDb();
  upsertWearableRows(db, [
    row({ date: '2026-07-27', sourceRawId: 'hk:hrv:2026-07-27', value: 50 }),
    row({ date: '2026-07-28', sourceRawId: 'hk:hrv:2026-07-28', value: 46 }),
    // Two sources on the 28th: watch (46) must beat manual (99)…
    row({
      date: '2026-07-28',
      sourceDevice: 'manual',
      sourceRawId: 'hk:hrv:2026-07-28',
      value: 99,
    }),
    // …but manual-only on the 29th still counts.
    row({
      date: '2026-07-29',
      sourceDevice: 'manual',
      sourceRawId: 'hk:hrv:2026-07-29',
      value: 41,
    }),
  ]);

  const series = dailyMetricSeries(db, 'hrv', 30, '2026-07-29');
  series.length === 3
    ? ok('one point per day after arbitration')
    : bad('series length', series.length);
  series[1].value === 46 && series[1].sourceDevice === 'apple_watch'
    ? ok('watch beats manual on a dual-source day')
    : bad('priority', JSON.stringify(series[1]));
  series[2].value === 41 && series[2].sourceDevice === 'manual'
    ? ok('manual counts when it is all there is')
    : bad('manual day', JSON.stringify(series[2]));

  const pick = pickDailyMetric(db, 'hrv', '2026-07-28');
  pick && pick.value === 46
    ? ok('pickDailyMetric arbitrates one day')
    : bad('pick', JSON.stringify(pick));
  pickDailyMetric(db, 'hrv', '2026-07-26') === null
    ? ok('pickDailyMetric null on an empty day')
    : bad('pick empty');

  const latest = latestMetric(db, 'hrv');
  latest && latest.date === '2026-07-29' && latest.value === 41
    ? ok('latestMetric returns the newest day')
    : bad('latest', JSON.stringify(latest));
  latestMetric(db, 'vo2max') === null
    ? ok('latestMetric null when never seen')
    : bad('latest empty');

  upsertWearableRows(db, [
    row({
      metricType: 'workout',
      date: '2026-07-29',
      value: 30,
      unit: 'min',
      sourceDevice: 'garmin',
      sourceRawId: 'UUID-W1',
      startTime: '2026-07-29T17:00:00.000Z',
      endTime: '2026-07-29T17:40:00.000Z',
      metadata: { activity: 'Running', kcal: 320 },
    }),
  ]);
  const workouts = recentWearableWorkouts(db, 5);
  workouts.length === 1 && workouts[0].activity === 'Running' && workouts[0].kcal === 320
    ? ok('recentWearableWorkouts parses metadata')
    : bad('workouts', JSON.stringify(workouts));

  deviceLabel('apple_watch') === 'Apple Watch' && deviceLabel('apple_health') === 'Apple Health'
    ? ok('device labels')
    : bad('labels');
}

console.log('4. two-pass ingest: an aged-out day is never rewritten from a partial read');
{
  // The regression this locks down: the sample span starts at NOON of the day
  // before the window (to cover the first night's sleep), so on the pass where
  // day D falls off the window's start, HealthKit returns only D's AFTERNOON
  // samples. Mapped un-clamped, those rebuild D's rows from that fragment and —
  // sharing the deterministic hk:<metric>:<date> id — overwrite the correct
  // full-day values stored earlier. Every day of history would be corrupted
  // once, on the day it aged out. Simulated here through the real pipeline
  // (map → clamp → upsert → read) with no native module.
  const { db } = freshDb();
  const watch = {
    sourceName: "Matt's Apple Watch",
    bundleId: 'com.apple.health.ABC',
    productType: 'Watch7,1',
  };
  const hrvSpec = SAMPLE_METRICS.find((m) => m.metricType === 'hrv');
  const iso = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm, 0, 0).toISOString();

  // Day D = 2026-07-15. Overnight 60 and 50, plus one afternoon reading of 34.
  const fullDaySamples = [
    {
      value: 60,
      startISO: iso(2026, 7, 15, 3, 0),
      endISO: iso(2026, 7, 15, 3, 1),
      provenance: watch,
    },
    {
      value: 50,
      startISO: iso(2026, 7, 15, 7, 0),
      endISO: iso(2026, 7, 15, 7, 1),
      provenance: watch,
    },
    {
      value: 34,
      startISO: iso(2026, 7, 15, 14, 0),
      endISO: iso(2026, 7, 15, 14, 1),
      provenance: watch,
    },
  ];
  const nightSleep = [
    {
      value: 0,
      startISO: iso(2026, 7, 14, 23, 0),
      endISO: iso(2026, 7, 15, 6, 30),
      provenance: watch,
    },
    {
      value: 3,
      startISO: iso(2026, 7, 14, 23, 10),
      endISO: iso(2026, 7, 15, 6, 10),
      provenance: watch,
    },
  ];
  const afternoonNap = [
    {
      value: 1,
      startISO: iso(2026, 7, 15, 13, 0),
      endISO: iso(2026, 7, 15, 13, 40),
      provenance: watch,
    },
  ];

  // PASS 1 — 2026-07-28: D is inside the 14-day window (07-15…07-28), and the
  // span covers all of it, so the stored row is the true full-day mean of 48.
  const pass1Days = syncDayWindows(new Date(2026, 6, 28, 15, 0), 14);
  upsertWearableRows(
    db,
    clampRowsToWindow(
      [
        ...quantityDailyRows(hrvSpec, fullDaySamples),
        ...sleepDailyRows([...nightSleep, ...afternoonNap]),
      ],
      pass1Days
    )
  );
  const afterPass1 = pickDailyMetric(db, 'hrv', '2026-07-15');
  afterPass1 && afterPass1.value === 48
    ? ok('pass 1 stores the true full-day HRV mean (48)')
    : bad('pass 1 hrv', JSON.stringify(afterPass1));
  const sleepAfterPass1 = pickDailyMetric(db, 'sleep_duration_min', '2026-07-15');
  sleepAfterPass1 && sleepAfterPass1.value === 420
    ? ok('pass 1 stores the real night (420 min)')
    : bad('pass 1 sleep', JSON.stringify(sleepAfterPass1));

  // PASS 2 — 2026-07-29: the window is 07-16…07-29, so D has aged out, and the
  // span (noon of 07-15 →) returns ONLY the 34 ms reading and the 40-min nap.
  const pass2Days = syncDayWindows(new Date(2026, 6, 29, 15, 0), 14);
  const partialRows = [
    ...quantityDailyRows(hrvSpec, [fullDaySamples[2]]),
    ...sleepDailyRows(afternoonNap),
  ];
  partialRows.some((r) => r.date === '2026-07-15')
    ? ok('the mappers DO emit partial rows for the aged-out day (the hazard is real)')
    : bad('no partial rows produced — test no longer exercises the bug');
  upsertWearableRows(db, clampRowsToWindow(partialRows, pass2Days));

  const afterPass2 = pickDailyMetric(db, 'hrv', '2026-07-15');
  afterPass2 && afterPass2.value === 48
    ? ok('pass 2 leaves the aged-out day intact (48, not the afternoon-only 34)')
    : bad('HISTORY CORRUPTED', JSON.stringify(afterPass2));
  const sleepAfterPass2 = pickDailyMetric(db, 'sleep_duration_min', '2026-07-15');
  sleepAfterPass2 && sleepAfterPass2.value === 420
    ? ok('pass 2 leaves the night intact (420 min, not the 40-min nap)')
    : bad('SLEEP CORRUPTED', JSON.stringify(sleepAfterPass2));

  // And a day still inside the window DOES keep updating (the clamp must not
  // freeze live days — today is provisional until the Watch finishes syncing).
  upsertWearableRows(
    db,
    clampRowsToWindow(
      quantityDailyRows(hrvSpec, [
        {
          value: 41,
          startISO: iso(2026, 7, 29, 6, 0),
          endISO: iso(2026, 7, 29, 6, 1),
          provenance: watch,
        },
      ]),
      pass2Days
    )
  );
  const today = pickDailyMetric(db, 'hrv', '2026-07-29');
  today && today.value === 41
    ? ok('in-window days still update (clamp only blocks out-of-window rows)')
    : bad('in-window blocked', JSON.stringify(today));
}

console.log('3. health_sync_state KV + the preferences toggle');
{
  const { db } = freshDb();
  const empty = getHealthSyncState(db);
  empty.lastSyncedAt === null && empty.firstSyncedAt === null
    ? ok('empty state reads as never-synced')
    : bad('empty state', JSON.stringify(empty));

  setHealthSyncState(db, {
    lastSyncedAt: '2026-07-29T10:00:00.000Z',
    firstSyncedAt: '2026-07-01T08:00:00.000Z',
  });
  setHealthSyncState(db, {
    lastSyncedAt: '2026-07-29T12:00:00.000Z',
    firstSyncedAt: '2026-07-01T08:00:00.000Z',
  });
  const state = getHealthSyncState(db);
  state.lastSyncedAt === '2026-07-29T12:00:00.000Z'
    ? ok('state upserts on key (one row, latest value)')
    : bad('state upsert', JSON.stringify(state));
  db.all('SELECT * FROM health_sync_state').length === 1
    ? ok('single KV row per key')
    : bad('KV rows');

  isHealthSyncEnabled(db) === false ? ok('sync disabled by default') : bad('default enabled');
  setHealthSyncEnabled(db, true);
  isHealthSyncEnabled(db) === true ? ok('toggle persists to preferences') : bad('toggle on');
  setHealthSyncEnabled(db, false);
  isHealthSyncEnabled(db) === false ? ok('toggle off persists') : bad('toggle off');
}

// The owner reported, twice, that Home shows their Apple Health step count while
// the Coach says nothing has synced. Same database, same day, two readers.
//
// Home reads pickDailyMetric(db, 'steps', today) directly. The Coach reaches the
// same call only after a gate: it discovers its readable set from
// `SELECT metric_type, max(date) … GROUP BY metric_type` and skips any metric
// whose max(date) is older than today. Two read shapes, one of them gated, is a
// place they CAN disagree — so pin that they cannot, over rows shaped the way
// the real ingest writes them rather than hand-picked ones that merely look
// similar.
//
// (The round-2 fault was in fact ABOVE this layer: the snapshot returned the
// steps and contradicted itself in prose. This invariant is the cheap guard for
// the failure everyone assumed it was, and it belongs here because it is a
// statement about the repository's two read shapes.)
console.log('5. inventory discovery can never hide a day pickDailyMetric can see');
{
  const { db } = freshDb();
  const now = new Date();
  const day = (n) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  };
  const today = day(0);

  const rows = [];
  // Merged HealthKit statistics, exactly as statisticDailyRows writes them:
  // source_device 'apple_health', unit 'count', id hk:<metric>:<date>.
  for (let i = 0; i < 30; i++) {
    for (const [metricType, unit, value] of [
      ['steps', 'count', 8432 - i * 37],
      ['active_energy_kcal', 'kcal', 612],
    ]) {
      rows.push({
        date: day(i),
        metricType,
        value,
        unit,
        sourceDevice: 'apple_health',
        sourceRawId: `hk:${metricType}:${day(i)}`,
        startTime: null,
        endTime: null,
        metadata: { hk: { merged: true } },
      });
    }
  }
  // Watch nights, through the REAL sleep mapper — sessionised, stage-summed,
  // attributed to the wake day, so the dates are the pipeline's, not mine.
  const watch = {
    sourceName: "Matt's Apple Watch",
    bundleId: 'com.apple.health.9A8B7C6D-5E4F-3021-1122-334455667788',
    productType: 'Watch7,1',
  };
  for (let i = 0; i < 30; i++) {
    rows.push(
      ...sleepDailyRows([
        {
          value: 3,
          startISO: new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate() - i - 1,
            23,
            0
          ).toISOString(),
          endISO: new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate() - i,
            6,
            11
          ).toISOString(),
          provenance: watch,
        },
      ])
    );
  }
  upsertWearableRows(db, rows);

  // The discovery query the Coach's readable set is built from.
  const inventory = db.all(
    `SELECT metric_type AS metricType, max(date) AS lastDate
     FROM wearable_data GROUP BY metric_type ORDER BY metric_type`
  );

  const hidden = inventory
    .map((r) => ({
      metricType: r.metricType,
      // What Home would show for today…
      home: pickDailyMetric(db, r.metricType, today),
      // …and whether the gate would even let the Coach try.
      admitted: !(r.lastDate < today),
    }))
    .filter((r) => r.home !== null && !r.admitted);

  hidden.length === 0
    ? ok(`all ${inventory.length} discovered metrics readable for today pass the max(date) gate`)
    : bad('gate hides a readable day', hidden.map((h) => h.metricType).join(', '));

  const steps = pickDailyMetric(db, 'steps', today);
  const stepsRow = inventory.find((r) => r.metricType === 'steps');
  steps &&
  steps.value === 8432 &&
  steps.sourceDevice === 'apple_health' &&
  stepsRow.lastDate === today
    ? ok('steps: apple_health wins the day and max(date) is today — both readers agree')
    : bad('steps agreement', JSON.stringify({ steps, stepsRow }));

  // One-directional: gating a genuinely stale metric is the point, so removing
  // today's row must make BOTH readers report absence, not just the gated one.
  db.run('DELETE FROM wearable_data WHERE metric_type = ? AND date = ?', ['steps', today]);
  const stale = db.get('SELECT max(date) AS lastDate FROM wearable_data WHERE metric_type = ?', [
    'steps',
  ]);
  stale.lastDate < today && pickDailyMetric(db, 'steps', today) === null
    ? ok('drop today’s row and both readers report absence — the gate is not over-eager')
    : bad('stale gating', JSON.stringify(stale));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
