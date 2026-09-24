/**
 * Headless test of the wearables repository (src/lib/db/repositories/wearables.ts)
 * and migration 0021 against real SQLite via node:sqlite: the wearable_data
 * rebuild preserves rows, the upsert dedups on (source_device, source_raw_id),
 * source-priority day picking, series/latest reads, and the sync-state KV —
 * plus BOTH halves of the body channel: the OUTBOUND publish cursor KV (no
 * migration, key 'apple_health_publish'), its (created_at, id) keyset walk over
 * body_metrics and the no-backfill arming rule; and the INBOUND ingest, keyed on
 * the natural (source, measured_at) pair — also no migration — with the proof
 * that an ingested row is never published back out.
 * Run: npm run db:test.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { migrate, pendingMigrations } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  dailyMetricSeries,
  deviceLabel,
  getHealthPublishState,
  getHealthSyncLog,
  getHealthSyncState,
  HEALTH_LOG_KEY,
  HEALTH_PUBLISH_KEY,
  HEALTH_WATER_PUBLISH_KEY,
  latestMetric,
  pickDailyMetric,
  recentWearableWorkouts,
  setHealthPublishState,
  setHealthSyncLog,
  setHealthSyncState,
  SOURCE_PRIORITY,
  upsertWearableRows,
  workoutUuidsWithHr,
} from '../src/lib/db/repositories/wearables.ts';
import {
  HEALTH_INGEST_SOURCE,
  newestBodyCursor,
  publishableBodyAfter,
  upsertHealthBodyRows,
} from '../src/lib/db/repositories/body.ts';
import { isHealthSyncEnabled, setHealthSyncEnabled } from '../src/lib/db/repositories/user.ts';
import {
  getPublishableWater,
  logWater,
  publishableWaterAfter,
  waterDaySeries,
} from '../src/lib/db/repositories/water.ts';
import { logWorkout, replaceWorkout } from '../src/lib/db/repositories/exercise.ts';
import {
  linkIngestedWorkout,
  pairedIngestFor,
  pairIngestedWorkouts,
  pairingRefusals,
  unlinkIngestedWorkout,
  unpairedIngestedSessions,
  unpairedWorkoutDailyMinutes,
} from '../src/lib/db/repositories/workout-ingest.ts';
import { shiftISODate, todayISODate } from '../src/lib/db/date.ts';
import { wearableMetricInventory } from '../src/lib/ai/series.ts';
import { ingestDetail } from '../src/lib/exercise/format.ts';
import {
  ARC_BUNDLE_ID,
  ARC_WRITE_METADATA_KEY,
  BODY_INGEST_METRICS,
  bodyIngestRows,
  quantityDailyRows,
  isPublishedIdentifier,
  SAMPLE_METRICS,
  sleepDailyRows,
  STATISTIC_METRICS,
  statisticDailyRows,
  WATER_PUBLISH_METRIC,
} from '../src/lib/health/mapping.ts';
import {
  editWaterCapture,
  publishBodyMetrics,
  PUBLISH_BATCH_ROWS,
  publishWaterCaptures,
  removeWaterCapture,
} from '../src/lib/health/publish.ts';
import { readDailyCumulative } from '../src/lib/health/healthkit.ts';
import {
  clampRowsToWindow,
  foregroundTracker,
  isHealthSyncRunning,
  requestFreshHealthSync,
  startHealthSync,
  startOrJoinHealthSync,
  subscribeHealthSyncRunning,
  syncDayWindows,
} from '../src/lib/health/sync.ts';

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

// ---------------------------------------------------------------------------
// Outbound publishing (docs/wearables-subapp.md §10)
// ---------------------------------------------------------------------------

/** Insert a body_metrics row with an explicit created_at, returning its id. */
let bodySeq = 0;
function addBody(
  db,
  { id, createdAt, measuredAt, weightKg = null, bodyFatPct = null, waistCm = null }
) {
  const rowId = id ?? `body-${String(++bodySeq).padStart(3, '0')}`;
  db.run(
    `INSERT INTO body_metrics
       (id, measured_at, weight_kg, body_fat_pct, waist_cm, source, created_at)
     VALUES (?, ?, ?, ?, ?, 'manual', ?)`,
    [rowId, measuredAt, weightKg, bodyFatPct, waistCm, createdAt]
  );
  return rowId;
}

/** A recording saver standing in for the native seam. */
function recorder(behaviour = () => true) {
  const calls = [];
  return {
    calls,
    deps: {
      isAvailable: () => true,
      save: async (identifier, unit, value, start, end, metadata) => {
        const accepted = behaviour(identifier, calls.length);
        calls.push({ identifier, unit, value, at: start.toISOString(), metadata, accepted });
        return accepted;
      },
    },
  };
}

console.log('10. publish cursor KV — no migration, key apple_health_publish');
{
  const { raw, db } = freshDb();

  const fresh = getHealthPublishState(db);
  fresh.armedAt === null && fresh.cursorCreatedAt === null && fresh.cursorId === null
    ? ok('never-armed state reads as all-null')
    : bad('publish state default', JSON.stringify(fresh));

  setHealthPublishState(db, {
    armedAt: '2026-08-12T09:00:00.000Z',
    cursorCreatedAt: '2026-08-12T09:00:00.000Z',
    cursorId: 'body-001',
    lastPublishedAt: '2026-08-12T09:05:00.000Z',
  });
  const back = getHealthPublishState(db);
  back.armedAt === '2026-08-12T09:00:00.000Z' && back.cursorId === 'body-001'
    ? ok('publish state round-trips')
    : bad('publish state round-trip', JSON.stringify(back));

  // It shares health_sync_state with the ingest cursor but not the ROW — the two
  // directions must never overwrite each other's progress.
  setHealthSyncState(db, { lastSyncedAt: '2026-08-12T10:00:00.000Z', firstSyncedAt: null });
  const bothKeys = raw.prepare('SELECT count(*) AS n FROM health_sync_state').get();
  bothKeys.n === 2 && getHealthPublishState(db).cursorId === 'body-001'
    ? ok('ingest and publish cursors are separate keys, neither clobbers the other')
    : bad('cursor separation', JSON.stringify(bothKeys));

  // No migration was needed for any of this: 0021's key column carries no CHECK
  // and its value column is free JSON. Prove the key is stored verbatim.
  const stored = raw
    .prepare('SELECT key FROM health_sync_state WHERE key = ?')
    .get(HEALTH_PUBLISH_KEY);
  stored && stored.key === 'apple_health_publish'
    ? ok('cursor lives in the 0021 KV as-is — no schema change')
    : bad('publish key', JSON.stringify(stored));

  // 0021's `CHECK (json_valid(value))` makes unparseable JSON unstorable, so the
  // realistic corruption is valid JSON of the WRONG SHAPE — a rolled-back schema
  // change, a hand-edited backup. Every field is type-checked on read, and a
  // failure reads as never-armed: the next pass re-arms at the newest row and
  // republishes nothing, which is the right way to fail when the alternative is
  // re-posting history no one can delete.
  raw.exec(`UPDATE health_sync_state SET value = '{"armedAt":42,"cursorId":null}'
            WHERE key = '${HEALTH_PUBLISH_KEY}'`);
  const corrupt = getHealthPublishState(db);
  corrupt.armedAt === null && corrupt.cursorId === null
    ? ok('wrong-shaped cursor reads as never-armed — re-arms rather than republishing history')
    : bad('corrupt publish state', JSON.stringify(corrupt));
}

console.log('11. body_metrics keyset walk — backdating and same-millisecond ties');
{
  const { db } = freshDb();
  // Deliberately adversarial: created_at ASCENDING (insertion order) while
  // measured_at goes BACKWARDS. A measured_at watermark would skip b and c.
  const a = addBody(db, {
    createdAt: '2026-08-12T09:00:00.000Z',
    measuredAt: '2026-08-12T09:00:00.000Z',
    weightKg: 82,
  });
  const b = addBody(db, {
    createdAt: '2026-08-12T09:00:01.000Z',
    measuredAt: '2026-08-05T12:00:00.000Z', // backdated a week
    weightKg: 83,
  });
  // Same millisecond as b — the tie the id half of the keyset exists for.
  const c = addBody(db, {
    id: 'body-zzz',
    createdAt: '2026-08-12T09:00:01.000Z',
    measuredAt: '2026-08-06T12:00:00.000Z',
    waistCm: 81,
  });
  // Carries nothing ARC publishes.
  addBody(db, {
    createdAt: '2026-08-12T09:00:02.000Z',
    measuredAt: '2026-08-12T09:00:02.000Z',
  });

  const all = publishableBodyAfter(db, null, 50).map((r) => r.id);
  all.length === 3 && all[0] === a
    ? ok('only rows with a publishable column, oldest created_at first')
    : bad('walk', all.join(','));

  const afterB = publishableBodyAfter(db, { createdAt: '2026-08-12T09:00:01.000Z', id: b }, 50);
  afterB.length === 1 && afterB[0].id === c
    ? ok('same-millisecond sibling is not skipped — (created_at, id) keyset holds')
    : bad('tie handling', JSON.stringify(afterB.map((r) => r.id)));

  const afterC = publishableBodyAfter(
    db,
    { createdAt: '2026-08-12T09:00:01.000Z', id: 'body-zzz' },
    50
  );
  afterC.length === 0
    ? ok('walking past the last tie ends the batch')
    : bad('tie end', afterC.length);

  const newest = newestBodyCursor(db);
  newest && newest.createdAt === '2026-08-12T09:00:02.000Z'
    ? ok('newestBodyCursor includes non-publishable rows — it is a table position')
    : bad('newest cursor', JSON.stringify(newest));
  newestBodyCursor(freshDb().db) === null ? ok('empty table → null cursor') : bad('empty newest');

  PUBLISH_BATCH_ROWS > 0 && publishableBodyAfter(db, null, 1).length === 1
    ? ok('batch limit is honoured')
    : bad('batch limit');
}

console.log('12. publish pass — arm without backfill, then forward only');
{
  const { db } = freshDb();
  setHealthSyncEnabled(db, true);
  // Years of history, exactly the hazard: irreversible from inside ARC, since
  // nothing stores the HealthKit UUID a delete would need.
  for (let i = 0; i < 40; i++) {
    addBody(db, {
      createdAt: `2025-01-${String((i % 28) + 1).padStart(2, '0')}T08:00:00.000Z`,
      measuredAt: `2025-01-${String((i % 28) + 1).padStart(2, '0')}T08:00:00.000Z`,
      weightKg: 80 + i * 0.1,
    });
  }

  const arm = recorder();
  const armResult = await publishBodyMetrics(db, new Date('2026-08-12T09:00:00.000Z'), arm.deps);
  armResult.armed && armResult.samplesWritten === 0 && arm.calls.length === 0
    ? ok('first pass ARMS: 40 rows of history, zero samples written')
    : bad('arming', JSON.stringify(armResult));
  const armed = getHealthPublishState(db);
  armed.armedAt === '2026-08-12T09:00:00.000Z' && armed.cursorId !== null
    ? ok('cursor parked on the newest existing row')
    : bad('armed state', JSON.stringify(armed));

  // Nothing new yet → still nothing published, and re-running never re-arms.
  const idle = recorder();
  const idleResult = await publishBodyMetrics(db, new Date('2026-08-12T09:15:00.000Z'), idle.deps);
  idleResult.armed === false && idle.calls.length === 0
    ? ok('a second pass with nothing new publishes nothing and does not re-arm')
    : bad('idle pass', JSON.stringify(idleResult));

  // A new measurement, all three columns.
  addBody(db, {
    id: 'body-new',
    createdAt: '2026-08-12T10:00:00.000Z',
    measuredAt: '2026-08-12T09:58:00.000Z',
    weightKg: 82.4,
    bodyFatPct: 18.5,
    waistCm: 81,
  });
  const live = recorder();
  const liveResult = await publishBodyMetrics(db, new Date('2026-08-12T10:01:00.000Z'), live.deps);
  liveResult.samplesWritten === 3 && live.calls.length === 3
    ? ok('a measurement logged after arming publishes all three of its columns')
    : bad('live publish', JSON.stringify(liveResult));

  const fat = live.calls.find((c) => c.identifier === 'HKQuantityTypeIdentifierBodyFatPercentage');
  fat && fat.unit === '%' && Math.abs(fat.value - 0.185) < 1e-12
    ? ok('18.5 % goes out as the 0.185 fraction HKUnit.percent means')
    : bad('body fat on the wire', JSON.stringify(fat));
  const mass = live.calls.find((c) => c.identifier === 'HKQuantityTypeIdentifierBodyMass');
  mass && mass.unit === 'kg' && mass.value === 82.4 && mass.at === '2026-08-12T09:58:00.000Z'
    ? ok('weight goes out in kg at the measurement instant, not the publish instant')
    : bad('weight on the wire', JSON.stringify(mass));
  live.calls.every((c) => c.metadata[ARC_WRITE_METADATA_KEY] === 'body-new')
    ? ok('every sample is stamped with its originating body_metrics id')
    : bad('write metadata', JSON.stringify(live.calls.map((c) => c.metadata)));

  // The cursor moved, so a re-publish cannot double-post.
  const again = recorder();
  const againResult = await publishBodyMetrics(
    db,
    new Date('2026-08-12T10:30:00.000Z'),
    again.deps
  );
  againResult.samplesWritten === 0 && again.calls.length === 0
    ? ok('re-running the pass never double-posts — the cursor advanced')
    : bad('double post', JSON.stringify(againResult));
}

console.log('13. publish refusals never advance the cursor, and the toggle governs both ways');
{
  const { db } = freshDb();
  setHealthSyncEnabled(db, true);
  setHealthPublishState(db, {
    armedAt: '2026-08-12T09:00:00.000Z',
    cursorCreatedAt: null,
    cursorId: null,
    lastPublishedAt: null,
  });
  addBody(db, {
    id: 'body-a',
    createdAt: '2026-08-12T10:00:00.000Z',
    measuredAt: '2026-08-12T10:00:00.000Z',
    weightKg: 82,
  });
  addBody(db, {
    id: 'body-b',
    createdAt: '2026-08-12T11:00:00.000Z',
    measuredAt: '2026-08-12T11:00:00.000Z',
    weightKg: 83,
  });

  // HealthKit refuses the second row (share access revoked mid-pass).
  const refuse = recorder((_id, index) => index < 1);
  const refused = await publishBodyMetrics(db, new Date('2026-08-12T11:05:00.000Z'), refuse.deps);
  refused.samplesWritten === 1 && refused.stalled
    ? ok('a refusal stops the pass rather than skipping the row')
    : bad('stall', JSON.stringify(refused));
  const stalledAt = getHealthPublishState(db);
  stalledAt.cursorId === 'body-a'
    ? ok('cursor sits on the last FULLY published row — the refused reading is not lost')
    : bad('stalled cursor', JSON.stringify(stalledAt));

  // Access restored → the refused row publishes on the next pass.
  const retry = recorder();
  const retried = await publishBodyMetrics(db, new Date('2026-08-12T11:10:00.000Z'), retry.deps);
  retried.samplesWritten === 1 &&
  retry.calls[0].metadata[ARC_WRITE_METADATA_KEY] === 'body-b' &&
  getHealthPublishState(db).cursorId === 'body-b'
    ? ok('the next pass retries exactly the refused row')
    : bad('retry', JSON.stringify(retried));

  // One switch governs both directions.
  setHealthSyncEnabled(db, false);
  addBody(db, {
    createdAt: '2026-08-12T12:00:00.000Z',
    measuredAt: '2026-08-12T12:00:00.000Z',
    weightKg: 84,
  });
  const off = recorder();
  const offResult = await publishBodyMetrics(db, new Date('2026-08-12T12:01:00.000Z'), off.deps);
  offResult.status === 'disabled' && off.calls.length === 0
    ? ok('“Turn off” stops publishing too — one Apple Health switch, both directions')
    : bad('disabled publish', JSON.stringify(offResult));

  // And without the native module there is nothing to publish to.
  setHealthSyncEnabled(db, true);
  const absent = await publishBodyMetrics(db, new Date('2026-08-12T12:02:00.000Z'), {
    isAvailable: () => false,
    save: async () => true,
  });
  absent.status === 'unavailable' && absent.samplesWritten === 0
    ? ok('no HealthKit → the pass is a no-op, cursor untouched')
    : bad('unavailable publish', JSON.stringify(absent));
}

console.log('14. source priority still ranks an ARC echo below everything real');
{
  const { db } = freshDb();
  // 'other' keeps its place — an unrecognised vendor is a LIVE case (no wearable
  // chosen yet), so it must still outrank a stale keypad entry…
  SOURCE_PRIORITY.indexOf('other') < SOURCE_PRIORITY.indexOf('manual')
    ? ok("'other' was NOT demoted — an unknown ring still beats manual")
    : bad('other/manual order', SOURCE_PRIORITY.join(','));
  // …and 'manual', where ARC's own bundle now buckets, remains the floor.
  SOURCE_PRIORITY[SOURCE_PRIORITY.length - 1] === 'manual'
    ? ok("'manual' is the priority floor, so an ARC echo can never outrank its origin")
    : bad('manual is not last', SOURCE_PRIORITY.join(','));

  // Prove it end-to-end: an echo row (ARC's bundle → 'manual') loses to the
  // merged Apple total on the same day.
  upsertWearableRows(db, [
    row({
      metricType: 'steps',
      value: 8000,
      sourceDevice: 'apple_health',
      sourceRawId: 'hk:steps:2026-08-12',
      date: '2026-08-12',
    }),
    row({
      metricType: 'steps',
      value: 1,
      sourceDevice: 'manual',
      sourceRawId: 'echo',
      date: '2026-08-12',
    }),
  ]);
  const won = pickDailyMetric(db, 'steps', '2026-08-12');
  won && won.value === 8000 && won.sourceDevice === 'apple_health'
    ? ok('an ARC-labelled echo loses to the real merged value')
    : bad('echo arbitration', JSON.stringify(won));
}

console.log('15. inbound body ingest — no migration, natural key (source, measured_at)');
{
  const { db } = freshDb();
  const spec = (c) => BODY_INGEST_METRICS.find((m) => m.column === c);
  const scale = { sourceName: 'Withings', bundleId: 'com.withings.wiScaleNG', productType: null };
  const sample = (value, iso) => ({
    value,
    startISO: iso,
    endISO: iso,
    provenance: { ...scale, arcWritten: false },
  });

  // The headline gap this closes: weight from a scale reaching body_metrics —
  // the same table a keypad entry lands in, so the same trend, tools and export.
  const first = upsertHealthBodyRows(
    db,
    bodyIngestRows([
      {
        spec: spec('weight_kg'),
        samples: [
          sample(82.4, '2026-08-11T07:00:00.000Z'),
          sample(82.1, '2026-08-12T07:00:00.000Z'),
        ],
      },
      { spec: spec('body_fat_pct'), samples: [sample(0.185, '2026-08-12T07:00:00.000Z')] },
    ]).rows
  );
  first === 2 ? ok('two instants → two rows') : bad('first ingest', first);
  const rows = db.all(`SELECT * FROM body_metrics ORDER BY measured_at`);
  rows.length === 2 &&
  rows[0].weight_kg === 82.4 &&
  rows[1].weight_kg === 82.1 &&
  rows[1].body_fat_pct === 18.5 &&
  rows.every((r) => r.source === HEALTH_INGEST_SOURCE)
    ? ok("weight and body fat from one weigh-in share a row, stamped source='apple_health'")
    : bad('ingested rows', JSON.stringify(rows));

  // Re-syncing the trailing window must UPDATE, never duplicate — this is what
  // the natural key buys in place of a source_raw_id column and a migration.
  const again = upsertHealthBodyRows(
    db,
    bodyIngestRows([
      {
        spec: spec('weight_kg'),
        samples: [
          sample(82.4, '2026-08-11T07:00:00.000Z'),
          sample(82.1, '2026-08-12T07:00:00.000Z'),
        ],
      },
    ]).rows
  );
  again === 0 && db.all(`SELECT id FROM body_metrics`).length === 2
    ? ok('an unchanged re-sync writes nothing and duplicates nothing')
    : bad('re-sync', again);

  // A corrected value at the same instant updates in place…
  upsertHealthBodyRows(db, [{ measuredAt: '2026-08-11T07:00:00.000Z', values: { weight_kg: 83 } }]);
  const corrected = db.all(`SELECT * FROM body_metrics ORDER BY measured_at`);
  corrected.length === 2 && corrected[0].weight_kg === 83
    ? ok('a changed value updates its row rather than adding one')
    : bad('correction', JSON.stringify(corrected));
  // …and a column arriving later fills in beside it without clearing the rest.
  upsertHealthBodyRows(db, [{ measuredAt: '2026-08-11T07:00:00.000Z', values: { waist_cm: 81 } }]);
  const filled = db.get(
    `SELECT * FROM body_metrics WHERE measured_at = '2026-08-11T07:00:00.000Z'`
  );
  filled.waist_cm === 81 && filled.weight_kg === 83
    ? ok('a late-arriving column merges in; the others are untouched')
    : bad('merge', JSON.stringify(filled));

  // A manual row at the same instant is a DIFFERENT row and is never touched —
  // the key is scoped to the ingest source precisely so ARC's own record of a
  // measurement can never be overwritten by a sync.
  addBody(db, {
    id: 'manual-same-instant',
    createdAt: '2026-08-12T07:00:00.000Z',
    measuredAt: '2026-08-12T07:00:00.000Z',
    weightKg: 99,
  });
  upsertHealthBodyRows(db, [
    { measuredAt: '2026-08-12T07:00:00.000Z', values: { weight_kg: 82.9 } },
  ]);
  const manual = db.get(`SELECT * FROM body_metrics WHERE id = 'manual-same-instant'`);
  const ingested = db.get(
    `SELECT * FROM body_metrics WHERE measured_at = '2026-08-12T07:00:00.000Z' AND source = '${HEALTH_INGEST_SOURCE}'`
  );
  manual.weight_kg === 99 && ingested.weight_kg === 82.9
    ? ok('a manual row at the same instant is never matched, merged or overwritten')
    : bad('manual collision', JSON.stringify([manual, ingested]));

  // Rows with nothing in them do nothing, and the CHECK bounds hold for real —
  // the mapper drops out-of-range values so this INSERT never has to throw.
  upsertHealthBodyRows(db, [{ measuredAt: '2026-08-13T07:00:00.000Z', values: {} }]).valueOf() === 0
    ? ok('an empty values bag writes no row')
    : bad('empty values');
  let threw = false;
  try {
    upsertHealthBodyRows(db, [
      { measuredAt: '2026-08-14T07:00:00.000Z', values: { weight_kg: 0 } },
    ]);
  } catch {
    threw = true;
  }
  threw
    ? ok('body_metrics still refuses weight ≤ 0 at the DB layer — the mapper filters first')
    : bad('CHECK gone');
}

console.log('16. the echo loop is shut structurally — an ingested row is never published');
{
  const { db } = freshDb();
  setHealthSyncEnabled(db, true);

  // A real scale reading, ingested.
  upsertHealthBodyRows(db, [
    { measuredAt: '2026-08-12T07:00:00.000Z', values: { weight_kg: 82.4 } },
  ]);
  // And a keypad entry ARC owns.
  addBody(db, {
    id: 'body-typed',
    createdAt: '2026-08-12T08:00:00.000Z',
    measuredAt: '2026-08-12T08:00:00.000Z',
    weightKg: 82.5,
  });

  const walk = publishableBodyAfter(db, null, 50);
  walk.length === 1 && walk[0].id === 'body-typed'
    ? ok('the publish walk sees only rows ARC originated')
    : bad('walk', JSON.stringify(walk.map((r) => r.id)));

  // End-to-end: with the cursor armed at the very beginning, a pass publishes
  // the typed row and NOTHING that came in from Apple Health. This is the guard
  // that holds even if every provenance check upstream fails at once — the row
  // is not publishable, whatever it looks like.
  setHealthPublishState(db, {
    armedAt: '2026-08-12T06:00:00.000Z',
    cursorCreatedAt: null,
    cursorId: null,
    lastPublishedAt: null,
  });
  const pub = recorder();
  const result = await publishBodyMetrics(db, new Date('2026-08-12T09:00:00.000Z'), pub.deps);
  result.samplesWritten === 1 && pub.calls.length === 1 && pub.calls[0].value === 82.5
    ? ok('only the typed reading goes out — an ingested one is never round-tripped')
    : bad('echo published', JSON.stringify(pub.calls));

  // The same proof one layer up: even a sample carrying ARC's own bundle id,
  // fed straight at the mapper, produces no row at all to publish.
  upsertHealthBodyRows(
    db,
    bodyIngestRows([
      {
        spec: BODY_INGEST_METRICS.find((m) => m.column === 'weight_kg'),
        samples: [
          {
            value: 82.5,
            startISO: '2026-08-12T08:00:00.000Z',
            endISO: '2026-08-12T08:00:00.000Z',
            provenance: {
              sourceName: 'ARC',
              bundleId: ARC_BUNDLE_ID,
              productType: null,
              arcWritten: true,
            },
          },
        ],
      },
    ]).rows
  ) === 0
    ? ok("ARC's own published weight, read back, ingests to nothing")
    : bad('echo ingested');
}

console.log('17. workout identity (0042) — one session, one row, whatever the bucket');
{
  const { db, raw } = freshDb();
  const workout = (overrides = {}) =>
    row({
      metricType: 'workout',
      date: '2026-07-29',
      value: 40,
      unit: 'min',
      sourceDevice: 'garmin',
      sourceRawId: 'HK-UUID-1',
      startTime: '2026-07-29T17:00:00.000Z',
      endTime: '2026-07-29T17:40:00.000Z',
      metadata: { activity: 'Running' },
      ...overrides,
    });

  // THE reported bug. `provenanceOf` yields a null bundle id whenever a
  // sample's sourceRevision arrives in a shape the seam cannot parse, and a
  // null bundle buckets to 'other'; parse it next time and the same UUID
  // buckets to 'garmin'. Under the old (source_device, source_raw_id) key those
  // were two rows, and every flip of the bucket added another.
  upsertWearableRows(db, [workout({ sourceDevice: 'other' })]);
  upsertWearableRows(db, [workout({ sourceDevice: 'garmin' })]);
  upsertWearableRows(db, [workout({ sourceDevice: 'other' })]);
  const stored = raw
    .prepare("SELECT source_device FROM wearable_data WHERE metric_type = 'workout'")
    .all();
  stored.length === 1
    ? ok('the same UUID under three different device buckets is ONE row')
    : bad('bucket flip duplicated', JSON.stringify(stored));
  stored[0]?.source_device === 'other'
    ? ok('and the latest bucket wins — the label is corrected in place, not added to')
    : bad('source_device not rewritten', JSON.stringify(stored));

  // The day-bucket key is untouched: two devices reporting HRV on one day are
  // still two readings for the read side to arbitrate between.
  upsertWearableRows(db, [
    row({ sourceDevice: 'garmin', sourceRawId: 'hk:hrv:2026-07-29' }),
    row({ sourceDevice: 'apple_watch', sourceRawId: 'hk:hrv:2026-07-29' }),
  ]);
  raw.prepare("SELECT count(*) AS n FROM wearable_data WHERE metric_type = 'hrv'").get().n === 2
    ? ok('day-bucket rows still separate per device — 0042 did not over-reach')
    : bad('day-bucket rows collapsed');

  // A genuine second session on the same day is still a second row.
  upsertWearableRows(db, [
    workout({
      sourceRawId: 'HK-UUID-2',
      startTime: '2026-07-29T20:00:00.000Z',
      endTime: '2026-07-29T20:30:00.000Z',
      value: 30,
    }),
  ]);
  recentWearableWorkouts(db, 10).length === 2
    ? ok('two real sessions on one day stay two rows')
    : bad('a real second session was swallowed');
}

console.log('18. same session, two recorders — the read side collapses it');
{
  const { db } = freshDb();
  // The duplicate the UUID key CANNOT fix: one run recorded by Garmin Connect
  // and by the iPhone is two genuinely distinct HealthKit objects with two
  // distinct UUIDs. Both rows are true; showing both is not.
  upsertWearableRows(db, [
    row({
      metricType: 'workout',
      value: 62,
      unit: 'min',
      sourceDevice: 'garmin',
      sourceRawId: 'GARMIN-1',
      startTime: '2026-07-29T17:00:00.000Z',
      endTime: '2026-07-29T18:02:00.000Z',
      metadata: { activity: 'Running' },
    }),
    row({
      metricType: 'workout',
      value: 48,
      unit: 'min',
      sourceDevice: 'apple_watch',
      sourceRawId: 'WATCH-1',
      startTime: '2026-07-29T17:06:00.000Z',
      endTime: '2026-07-29T17:54:00.000Z',
      metadata: { activity: 'Running' },
    }),
  ]);
  const collapsed = recentWearableWorkouts(db, 10);
  collapsed.length === 1
    ? ok('one run recorded twice lists once')
    : bad('overlapping sessions not collapsed', JSON.stringify(collapsed));
  collapsed[0]?.sourceDevice === 'apple_watch'
    ? ok('SOURCE_PRIORITY picks the winner — the same rule every other metric gets')
    : bad('wrong winner', JSON.stringify(collapsed));

  // Adjacent-but-separate sessions must survive: a cool-down after a lift is
  // not the lift. These abut at the boundary and share no time at all.
  upsertWearableRows(db, [
    row({
      metricType: 'workout',
      value: 20,
      unit: 'min',
      sourceDevice: 'garmin',
      sourceRawId: 'GARMIN-2',
      startTime: '2026-07-29T18:02:00.000Z',
      endTime: '2026-07-29T18:22:00.000Z',
      metadata: { activity: 'Walking' },
    }),
  ]);
  recentWearableWorkouts(db, 10).length === 2
    ? ok('a back-to-back session that merely abuts is NOT collapsed')
    : bad('abutting sessions wrongly merged');

  // A row with no usable span cannot be reasoned about, so it is kept — never
  // silently dropped for being unreadable.
  upsertWearableRows(db, [
    row({
      metricType: 'workout',
      value: 15,
      unit: 'min',
      sourceDevice: 'other',
      sourceRawId: 'NO-TIMES',
      startTime: null,
      endTime: null,
      metadata: { activity: 'Yoga' },
    }),
  ]);
  recentWearableWorkouts(db, 10).length === 3
    ? ok('a workout with no start/end time is kept, not dropped')
    : bad('untimed workout dropped');
}

console.log('19. 0042 on a POPULATED device — the duplicates are cleaned before the index');
{
  // The hazard this locks down: CREATE UNIQUE INDEX fails outright if the table
  // already violates it, and the runner wraps the file in one transaction — so
  // a failed cleanup would roll the whole migration back and strand the device
  // below 42 forever. Set the table up in exactly the broken state the old key
  // permitted, then run the real migration over it.
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const { database, executor } = makeDb(raw);
  migrate(
    executor,
    MIGRATIONS.filter((m) => m.version <= 41)
  );

  const plant = (id, device, uuid, createdAt) =>
    raw
      .prepare(
        `INSERT INTO wearable_data
           (id, date, metric_type, value, unit, source_device, source_raw_id, created_at, updated_at)
         VALUES (?, '2026-07-29', 'workout', 40, 'min', ?, ?, ?, ?)`
      )
      .run(id, device, uuid, createdAt, createdAt);

  // One session that flip-flopped across three buckets…
  plant('a', 'other', 'UUID-A', '2026-07-29T18:00:00.000Z');
  plant('b', 'garmin', 'UUID-A', '2026-07-29T19:00:00.000Z');
  plant('c', 'manual', 'UUID-A', '2026-07-29T20:00:00.000Z');
  // …a session that never duplicated…
  plant('d', 'garmin', 'UUID-B', '2026-07-29T21:00:00.000Z');
  // …and two rows with a NULL raw id, which the index must tolerate.
  raw
    .prepare(
      `INSERT INTO wearable_data (id, date, metric_type, value, unit, source_device)
       VALUES ('e', '2026-07-29', 'workout', 10, 'min', 'manual'),
              ('f', '2026-07-29', 'workout', 12, 'min', 'manual')`
    )
    .run();
  // A day-bucket row sharing a raw id across devices — must survive untouched.
  raw
    .prepare(
      `INSERT INTO wearable_data (id, date, metric_type, value, unit, source_device, source_raw_id)
       VALUES ('g', '2026-07-29', 'hrv', 42, 'ms', 'garmin', 'hk:hrv:2026-07-29'),
              ('h', '2026-07-29', 'hrv', 44, 'ms', 'apple_watch', 'hk:hrv:2026-07-29')`
    )
    .run();

  let migrated = true;
  try {
    migrate(executor, MIGRATIONS);
  } catch (e) {
    migrated = false;
    bad('0042 threw on a populated device', e.message);
  }
  if (migrated) ok('0042 applies cleanly over pre-existing duplicates');

  executor.getUserVersion() >= 42
    ? ok('and the device actually reaches 42 — no silent rollback')
    : bad('user_version', String(executor.getUserVersion()));

  const survivors = raw
    .prepare("SELECT id, source_device FROM wearable_data WHERE source_raw_id = 'UUID-A'")
    .all();
  survivors.length === 1
    ? ok('three rows for one session collapse to one')
    : bad('dedupe', JSON.stringify(survivors));
  // SOURCE_PRIORITY: garmin (4) beats other (7) beats manual (9) — so the row
  // the cleanup keeps is the row the UI would have chosen anyway.
  survivors[0]?.id === 'b'
    ? ok('the survivor is the best-sourced row, not merely the newest')
    : bad('wrong survivor', JSON.stringify(survivors));

  raw.prepare("SELECT count(*) AS n FROM wearable_data WHERE source_raw_id = 'UUID-B'").get().n ===
  1
    ? ok('a session that was never duplicated is untouched')
    : bad('non-duplicate harmed');
  raw
    .prepare(
      "SELECT count(*) AS n FROM wearable_data WHERE metric_type = 'workout' AND source_raw_id IS NULL"
    )
    .get().n === 2
    ? ok('NULL raw ids are left alone — a unique index does not constrain them')
    : bad('null raw ids removed');
  raw.prepare("SELECT count(*) AS n FROM wearable_data WHERE metric_type = 'hrv'").get().n === 2
    ? ok('day-bucket rows sharing a raw id across devices survive intact')
    : bad('day-bucket rows harmed by the workout cleanup');

  // Re-running the same cleanup logic must be a no-op (deterministic tiebreak).
  const before = raw.prepare('SELECT count(*) AS n FROM wearable_data').get().n;
  migrate(executor, MIGRATIONS);
  raw.prepare('SELECT count(*) AS n FROM wearable_data').get().n === before
    ? ok('re-running the migration set changes nothing')
    : bad('not idempotent');
}

console.log('18. the sync log KV (2026-08-26) — a third key, still no migration');
{
  const { db, raw } = freshDb();

  getHealthSyncLog(db) === null ? ok('no log yet reads as null') : bad('fresh log');

  const log = {
    at: '2026-08-26T09:00:00.000Z',
    windowDays: 14,
    rowsWritten: 5,
    metrics: [
      {
        metric: 'weight_kg',
        label: 'Weight',
        returned: 0,
        rows: 0,
        exclusion: 'refused',
        error: 'predicate not supported',
        rejected: { arcTag: 0, arcBundle: 0, unattributed: 0, outOfBounds: 0, nonFinite: 0 },
      },
    ],
    publish: { armed: true, stalled: false, attempted: 0, succeeded: 0, types: [] },
  };
  setHealthSyncLog(db, log);
  const back = getHealthSyncLog(db);
  back &&
  back.metrics[0].exclusion === 'refused' &&
  back.metrics[0].error === 'predicate not supported' &&
  back.publish.armed === true
    ? ok('a log survives the round trip through health_sync_state')
    : bad('log round trip', JSON.stringify(back));

  // Same argument as the publish cursor: `key` carries no CHECK and `value` is
  // free JSON, so a third integration key is not a schema change. It also must
  // not disturb the two cursors, which drive windowing and the no-backfill rule.
  setHealthSyncState(db, { lastSyncedAt: '2026-08-26T09:00:00.000Z', firstSyncedAt: null });
  setHealthPublishState(db, {
    armedAt: '2026-08-12T09:00:00.000Z',
    cursorCreatedAt: '2026-08-12T09:00:00.000Z',
    cursorId: 'body-1',
    lastPublishedAt: null,
  });
  setHealthSyncLog(db, log);
  const keys = raw.prepare('SELECT count(*) AS n FROM health_sync_state').get();
  keys.n === 3 &&
  getHealthPublishState(db).cursorId === 'body-1' &&
  getHealthSyncState(db).lastSyncedAt === '2026-08-26T09:00:00.000Z' &&
  getHealthSyncLog(db) !== null
    ? ok('three keys coexist — the log never disturbs either cursor')
    : bad('key independence', JSON.stringify(keys));

  // Bounded to the LAST run. This is diagnostics, not history: a second write
  // replaces the first rather than appending, so the row cannot grow.
  setHealthSyncLog(db, { ...log, at: '2026-08-26T10:00:00.000Z', rowsWritten: 9 });
  const only = raw
    .prepare("SELECT count(*) AS n FROM health_sync_state WHERE key = 'apple_health_log'")
    .get();
  only.n === 1 && getHealthSyncLog(db).rowsWritten === 9
    ? ok('the log holds the last run only — one row, overwritten')
    : bad('unbounded log', JSON.stringify(only));

  // The screen that renders this is the one a user opens when something is
  // already broken. A wrong-shaped row must read as "no log", never throw
  // there. (Wrong-shaped, not malformed: `value` is CHECK json_valid, so
  // unparseable text cannot reach the column — the shape is the reachable
  // corruption, e.g. a log written by an older build.)
  raw.exec(`UPDATE health_sync_state SET value = '{"metrics":"not an array"}'
            WHERE key = '${HEALTH_LOG_KEY}'`);
  getHealthSyncLog(db) === null
    ? ok('an unreadable log reads as absent rather than throwing on the Settings screen')
    : bad('corrupt log');
}

console.log('19. the publish pass reports what it attempted, per type');
{
  const { db } = freshDb();
  setHealthSyncEnabled(db, true);
  addBody(db, {
    id: 'seed',
    createdAt: '2026-08-12T06:00:00.000Z',
    measuredAt: '2026-08-12T06:00:00.000Z',
    weightKg: 82,
  });
  // Arm on the seed so the pass below is a real forward walk, not an arming.
  await publishBodyMetrics(db, new Date('2026-08-12T07:00:00.000Z'), recorder().deps);

  addBody(db, {
    id: 'both-columns',
    createdAt: '2026-08-12T08:00:00.000Z',
    measuredAt: '2026-08-12T08:00:00.000Z',
    weightKg: 82.5,
    bodyFatPct: 18.5,
  });

  // A PARTIAL share grant is the state this split exists for: weight
  // authorised, body fat refused. One aggregate count cannot tell that from a
  // blanket refusal, and the two need different things done about them.
  const partial = recorder((identifier) => identifier.endsWith('BodyMass'));
  const result = await publishBodyMetrics(db, new Date('2026-08-12T09:00:00.000Z'), partial.deps);
  result.samplesAttempted === 2 && result.samplesWritten === 1 && result.stalled
    ? ok('a half-accepted row reports 2 attempted, 1 written, and stalls')
    : bad('partial publish', JSON.stringify(result));
  {
    const weight = result.byType.find((t) => t.label === 'Weight');
    const fat = result.byType.find((t) => t.label === 'Body fat');
    weight?.attempted === 1 && weight.succeeded === 1 && fat?.attempted === 1 && fat.succeeded === 0
      ? ok('…and names WHICH type Apple Health refused')
      : bad('byType', JSON.stringify(result.byType));
  }
  // A type the walk never reached must be ABSENT, not a zero — a zero row on
  // the screen reads as a refusal, which would be a fabricated finding.
  result.byType.some((t) => t.label === 'Waist circumference')
    ? bad('waist reported despite never being attempted')
    : ok('a type never attempted does not appear at all');

  // The arming pass writes nothing, so it attempts nothing — the count the
  // Settings screen turns into "Armed", never into a failure.
  const { db: fresh } = freshDb();
  setHealthSyncEnabled(fresh, true);
  addBody(fresh, {
    id: 'history',
    createdAt: '2025-01-01T08:00:00.000Z',
    measuredAt: '2025-01-01T08:00:00.000Z',
    weightKg: 80,
  });
  const armed = await publishBodyMetrics(
    fresh,
    new Date('2026-08-12T09:00:00.000Z'),
    recorder().deps
  );
  armed.armed && armed.samplesAttempted === 0 && armed.byType.length === 0
    ? ok('an arming pass attempts nothing and reports no types')
    : bad('armed tally', JSON.stringify(armed));
}

console.log('20. the re-window pass DELETES the buckets it did not produce (2026-09-14)');
{
  // docs/spikes/timezone-days.md §1c, in one sentence: the ingest path only ever
  // INSERTed and UPDATEd, so when a sample moved off a day — a timezone trip
  // re-bucketing the fortnight into a new zone's calendar days, or a sample
  // deleted in the Health app — the row it used to write was left standing,
  // describing nothing, and readiness baselines and every Coach correlation kept
  // reading it.
  //
  // The MOVE is simulated by mapping two different sample sets rather than by
  // changing the process timezone: `localDayOf` reads the ambient zone, so a
  // genuine re-bucket needs either a child process with TZ= set or an offset
  // parameter on the mapper (the spike's §10, still open). The defect under test
  // is the upsert path's missing DELETE, and a bucket that stopped being
  // produced is a bucket that stopped being produced however it happened.
  const { db } = freshDb();
  const days = syncDayWindows(new Date(2026, 6, 28, 15, 0), 14); // 07-15 … 07-28
  const first = days[0].date;
  const last = days[days.length - 1].date;
  first === '2026-07-15' && last === '2026-07-28'
    ? ok(`the window under test is ${first} … ${last}`)
    : bad('window', `${first} … ${last}`);

  const hrv = (date, value, device = 'apple_watch') => ({
    date,
    metricType: 'hrv',
    value,
    unit: 'ms',
    sourceDevice: device,
    sourceRawId: `hk:hrv:${date}`,
    startTime: null,
    endTime: null,
    metadata: {},
  });

  // PASS 1 — HRV on the 15th (from the watch and, separately, a Garmin) and on
  // the 20th. Plus three rows the prune must never touch:
  //   · a manual capture inside the window (source_raw_id NULL);
  //   · a steps bucket inside the window, whose metric this pass will not read;
  //   · an HRV bucket OUTSIDE the window.
  upsertWearableRows(db, [
    hrv('2026-07-15', 60),
    hrv('2026-07-15', 44, 'garmin'),
    hrv('2026-07-20', 50),
    hrv('2026-07-02', 55),
    {
      date: '2026-07-16',
      metricType: 'steps',
      value: 8000,
      unit: 'count',
      sourceDevice: 'apple_health',
      sourceRawId: 'hk:steps:2026-07-16',
      startTime: null,
      endTime: null,
      metadata: {},
    },
  ]);
  db.run(
    `INSERT INTO wearable_data (id, date, metric_type, value, unit, source_device)
     VALUES ('manual-water-1', '2026-07-15', 'water_ml', 500, 'ml', 'manual')`
  );

  // PASS 2 — the 15th's reading is now bucketed on the 16th. The watch produced
  // rows; the Garmin produced none; steps were not read at all this pass.
  const moved = [hrv('2026-07-16', 60), hrv('2026-07-20', 50)];
  const changed = upsertWearableRows(db, clampRowsToWindow(moved, days), {
    first,
    last,
    metricTypes: ['hrv'],
  });

  const hrvRows = db.all(`SELECT date, source_device FROM wearable_data
     WHERE metric_type = 'hrv' ORDER BY date, source_device`);
  const shape = hrvRows.map((r) => `${r.date}/${r.source_device}`).join(' ');
  shape === '2026-07-02/apple_watch 2026-07-16/apple_watch 2026-07-20/apple_watch'
    ? ok('the orphaned 07-15 buckets are gone; the moved 07-16 row stands in their place')
    : bad('STALE ROW SURVIVED', shape);

  pickDailyMetric(db, 'hrv', '2026-07-15') === null
    ? ok('...so the day that describes nothing reads as nothing, not as 60 ms')
    : bad('07-15 still readable', JSON.stringify(pickDailyMetric(db, 'hrv', '2026-07-15')));
  pickDailyMetric(db, 'hrv', '2026-07-02')
    ? ok('a bucket OUTSIDE the window is untouched — settled history is not the pass’s to judge')
    : bad('out-of-window row deleted');
  pickDailyMetric(db, 'steps', '2026-07-16')
    ? ok('a metric this pass did not read keeps every row it had')
    : bad('UNREAD METRIC PRUNED');

  const manual = db.get(`SELECT value FROM wearable_data WHERE id = 'manual-water-1'`);
  manual && manual.value === 500
    ? ok('a MANUAL capture inside the window is never touched — the prune is `hk:` only')
    : bad('MANUAL ROW DELETED', JSON.stringify(manual));

  changed === 3
    ? ok('the pass reports 3 changes — one moved row written, two orphans removed')
    : bad('rowsWritten must count deletions', String(changed));

  // THE SAFETY CONDITION, and the one that decides whether this is a fix or a
  // data loss. A metric that produced NOTHING this pass must prune nothing —
  // otherwise a refused predicate, a denied permission or a native throw reads
  // as "HealthKit no longer has this" and costs a fortnight of history. Two
  // independent guards, and both are exercised:
  //
  //   (i) an empty batch, which is what a wholly-failed pass looks like;
  upsertWearableRows(db, [], { first, last, metricTypes: ['hrv', 'steps'] });
  const afterEmpty = db.all(`SELECT id FROM wearable_data WHERE metric_type IN ('hrv','steps')`);
  afterEmpty.length === 4
    ? ok('an empty batch prunes nothing, however much it allow-lists')
    : bad('EMPTY READ WIPED THE WINDOW', `${afterEmpty.length} rows left`);

  //  (ii) a batch that produced rows for ONE of two allow-listed metrics, which
  //       is what one failed reader inside an otherwise good pass looks like.
  upsertWearableRows(db, [hrv('2026-07-20', 51)], {
    first,
    last,
    metricTypes: ['hrv', 'steps'],
  });
  const stepsLeft = db.all(`SELECT id FROM wearable_data WHERE metric_type = 'steps'`);
  const hrvLeft = db.all(`SELECT date FROM wearable_data WHERE metric_type = 'hrv' AND date >= ?`, [
    first,
  ]);
  stepsLeft.length === 1 && hrvLeft.length === 1 && hrvLeft[0].date === '2026-07-20'
    ? ok('allow-listing a metric that produced nothing prunes nothing of it — HRV alone reconciles')
    : bad('PARTIAL PASS PRUNED AN UNREAD METRIC', JSON.stringify({ stepsLeft, hrvLeft }));

  // Workouts are excluded by construction: their raw id is a HealthKit UUID, not
  // an `hk:` bucket key. Even allow-listed, the GLOB does not reach them.
  upsertWearableRows(db, [
    {
      date: '2026-07-18',
      metricType: 'workout',
      value: 42,
      unit: 'min',
      sourceDevice: 'garmin',
      sourceRawId: 'A1B2C3D4-0000-0000-0000-000000000001',
      startTime: '2026-07-18T10:00:00.000Z',
      endTime: '2026-07-18T10:42:00.000Z',
      metadata: {},
    },
  ]);
  upsertWearableRows(
    db,
    [
      {
        date: '2026-07-19',
        metricType: 'workout',
        value: 30,
        unit: 'min',
        sourceDevice: 'garmin',
        sourceRawId: 'A1B2C3D4-0000-0000-0000-000000000002',
        startTime: '2026-07-19T10:00:00.000Z',
        endTime: '2026-07-19T10:30:00.000Z',
        metadata: {},
      },
    ],
    { first, last, metricTypes: ['workout'] }
  );
  db.all(`SELECT id FROM wearable_data WHERE metric_type = 'workout'`).length === 2
    ? ok('a UUID-keyed workout row is out of the prune’s reach even when allow-listed')
    : bad('WORKOUT PRUNED');

  // And the whole thing is one transaction: a throw mid-batch leaves neither the
  // writes nor the deletes behind. Forced with a bad metric_type on the second
  // row, which `upsertWearableRows` validates before it opens the transaction —
  // so this also pins that the validation runs first.
  const before = db.all(`SELECT id FROM wearable_data WHERE metric_type = 'hrv'`).length;
  let threw = false;
  try {
    upsertWearableRows(
      db,
      [hrv('2026-07-21', 47), { ...hrv('2026-07-22', 48), metricType: 'BAD' }],
      {
        first,
        last,
        metricTypes: ['hrv'],
      }
    );
  } catch {
    threw = true;
  }
  threw && db.all(`SELECT id FROM wearable_data WHERE metric_type = 'hrv'`).length === before
    ? ok('a rejected batch writes nothing and deletes nothing')
    : bad('partial batch applied');
}

// ---------------------------------------------------------------------------
console.log('21. ingested-workout pairing (0054) — one session, one link, either way');
{
  const NOW = new Date('2026-07-26T20:00:00.000Z');
  const DAY = '2026-07-26';
  const iso = (day, hhmm) => `${day}T${hhmm}:00.000Z`;

  /** One HealthKit workout row, through the real ingest path. */
  const ingest = (db, { uuid, device = 'garmin', day = DAY, from, to, raw = 50, kcal = 300 }) =>
    upsertWearableRows(db, [
      {
        date: day,
        metricType: 'workout',
        value: Math.round((Date.parse(iso(day, to)) - Date.parse(iso(day, from))) / 60_000),
        unit: 'min',
        sourceDevice: device,
        sourceRawId: uuid,
        startTime: iso(day, from),
        endTime: iso(day, to),
        metadata: {
          activity: 'Strength training',
          activity_type_raw: raw,
          kcal,
          distance_km: null,
        },
      },
    ]);

  /** One ARC session with a real span — what only the live logger writes. */
  const logSpan = (db, { day = DAY, from, minutes }) =>
    logWorkout(db, {
      date: day,
      kind: 'strength',
      durationMin: minutes,
      startedAt: iso(day, from),
    });

  const linkCount = (db) => db.all('SELECT id FROM workout_ingest_links').length;

  // --- the happy path, and the tie ------------------------------------------
  {
    const { db } = freshDb();
    const workoutId = logSpan(db, { from: '17:00', minutes: 60 });
    // The same hour, recorded by two devices — the duplicate a Garmin user
    // actually sees. Both overlap the session fully, so the tie falls to
    // SOURCE_PRIORITY, where garmin outranks 'other' (an unparsed bundle id).
    ingest(db, { uuid: 'garmin-1', device: 'garmin', from: '17:05', to: '17:58' });
    ingest(db, { uuid: 'iphone-1', device: 'other', from: '17:00', to: '18:00' });

    pairIngestedWorkouts(db, NOW) === 1
      ? ok('two overlapping ingested rows produce exactly ONE link')
      : bad('link count from a tie', linkCount(db));
    const link = db.get('SELECT * FROM workout_ingest_links');
    link.workout_id === workoutId && link.wearable_id
      ? ok('…attached to the session the owner logged')
      : bad('link target', JSON.stringify(link));
    const winner = db.get('SELECT source_device FROM wearable_data WHERE id = ?', [
      link.wearable_id,
    ]);
    winner.source_device === 'garmin'
      ? ok('…and the tie resolves to the SOURCE_PRIORITY winner (garmin over other)')
      : bad('tie-break', winner.source_device);
    link.linked_by === 'auto' && link.overlap > 0.99
      ? ok('the link records HOW it was made (auto) and the overlap that justified it')
      : bad('link provenance', JSON.stringify(link));

    // Idempotence — the whole point of excluding linked rows on both sides.
    pairIngestedWorkouts(db, NOW) === 0 && linkCount(db) === 1
      ? ok('re-running the pass links nothing new and duplicates nothing')
      : bad('pass not idempotent', linkCount(db));

    // A RE-SYNC rewrites the same UUID in place (0042), so the link survives it.
    ingest(db, { uuid: 'garmin-1', device: 'garmin', from: '17:05', to: '17:58', kcal: 611 });
    pairIngestedWorkouts(db, NOW) === 0 && linkCount(db) === 1
      ? ok('a re-sync corrects the row in place — it does not re-pair or duplicate')
      : bad('re-sync broke the link', linkCount(db));
    JSON.parse(
      db.get('SELECT metadata FROM wearable_data WHERE id = ?', [link.wearable_id]).metadata
    ).kcal === 611
      ? ok('…and the corrected calorie figure is visible through the link, never copied')
      : bad('corrected kcal did not reach the pair');

    // The one-to-one guarantee is the SCHEMA's, not the code's.
    let threw = false;
    try {
      db.run(`INSERT INTO workout_ingest_links (id, workout_id, wearable_id) VALUES ('x', ?, ?)`, [
        workoutId,
        db.get(`SELECT id FROM wearable_data WHERE source_raw_id = 'iphone-1'`).id,
      ]);
    } catch {
      threw = true;
    }
    threw
      ? ok('a second link on the WORKOUT side is refused by the unique index')
      : bad('workout-side uniqueness');
    threw = false;
    try {
      const second = logSpan(db, { from: '17:00', minutes: 60 });
      db.run(`INSERT INTO workout_ingest_links (id, workout_id, wearable_id) VALUES ('y', ?, ?)`, [
        second,
        link.wearable_id,
      ]);
    } catch {
      threw = true;
    }
    threw
      ? ok('a second link on the WEARABLE side is refused too — one session, one pair')
      : bad('wearable-side uniqueness');
  }

  // --- what must NOT pair ---------------------------------------------------
  {
    const { db } = freshDb();
    logSpan(db, { from: '17:00', minutes: 60 });
    ingest(db, { uuid: 'later', from: '19:00', to: '20:00' });
    ingest(db, { uuid: 'yesterday', day: '2026-07-25', from: '17:00', to: '18:00' });
    pairIngestedWorkouts(db, NOW) === 0 && linkCount(db) === 0
      ? ok('a non-overlapping hour and the same hour a day earlier both refuse to pair')
      : bad('false pair', linkCount(db));
  }
  {
    // A BACKDATED session has no knowable span, so THIS rule cannot see it at
    // all. Until 2026-09-21 that meant it never auto-paired; it now pairs by
    // DAY instead (§23), and the observable difference is the overlap — the
    // span rule always records the fraction it matched on, so a link with none
    // did not come from here. That is also how the method is read back
    // (`pairedBy`), and it is what this assertion pins.
    const { db } = freshDb();
    logWorkout(db, { date: DAY, kind: 'strength', durationMin: 60 });
    ingest(db, { uuid: 'watch', from: '17:00', to: '18:00' });
    pairIngestedWorkouts(db, NOW);
    !db.get('SELECT id FROM workout_ingest_links WHERE overlap IS NOT NULL')
      ? ok('the span rule never claims a session with no started_at — no link of its making exists')
      : bad('span rule paired a session with no span');
  }
  {
    // Two ARC sessions overlapping one watch record: the earlier takes it, and
    // the schema makes the second impossible rather than merely unlikely.
    const { db } = freshDb();
    logSpan(db, { from: '17:00', minutes: 60 });
    logSpan(db, { from: '17:10', minutes: 45 });
    ingest(db, { uuid: 'one-watch', from: '17:05', to: '17:58' });
    pairIngestedWorkouts(db, NOW) === 1 && linkCount(db) === 1
      ? ok('one watch record can only ever be claimed once, however many sessions overlap it')
      : bad('double claim', linkCount(db));
  }

  // --- the double-count, and where it went ---------------------------------
  {
    const { db } = freshDb();
    logSpan(db, { from: '17:00', minutes: 60 });
    ingest(db, { uuid: 'both', from: '17:00', to: '18:00' }); // the ARC session
    ingest(db, { uuid: 'only-watch', from: '07:00', to: '07:40', raw: 52 }); // a walk, unlogged
    const before = unpairedWorkoutDailyMinutes(db, DAY, DAY);
    before.length === 1 && before[0].value === 100
      ? ok('before pairing, ingested minutes count BOTH sessions (60 + 40) — the defect')
      : bad('pre-pair total', JSON.stringify(before));
    pairIngestedWorkouts(db, NOW);
    const after = unpairedWorkoutDailyMinutes(db, DAY, DAY);
    after.length === 1 && after[0].value === 40
      ? ok('after pairing, only the 40-min walk remains — the logged hour is counted once')
      : bad('post-pair total', JSON.stringify(after));
    unpairedIngestedSessions(db, DAY, 10).length === 1
      ? ok('…and the session list the Coach reads holds only what ARC has no log for')
      : bad('unpaired session list');

    // The Data tab still SHOWS the paired row — it is the ingest record — but
    // says what it is, so nobody counts it as a second workout.
    const shown = recentWearableWorkouts(db, 10);
    shown.length === 2 &&
    shown.filter((w) => w.loggedInArc).length === 1 &&
    shown.find((w) => !w.loggedInArc).durationMin === 40
      ? ok('the wearables list marks the paired row "logged in ARC" rather than hiding it')
      : bad('loggedInArc', JSON.stringify(shown));
  }

  // --- CASCADE, both directions --------------------------------------------
  {
    const { db } = freshDb();
    const workoutId = logSpan(db, { from: '17:00', minutes: 60 });
    ingest(db, { uuid: 'w1', from: '17:00', to: '18:00' });
    pairIngestedWorkouts(db, NOW);
    db.run('DELETE FROM workouts WHERE id = ?', [workoutId]);
    linkCount(db) === 0 &&
    db.all(`SELECT id FROM wearable_data WHERE metric_type = 'workout'`).length === 1
      ? ok('deleting the ARC session drops the link and leaves the mirror free to re-pair')
      : bad('workout delete cascade');
  }
  {
    const { db } = freshDb();
    const workoutId = logSpan(db, { from: '17:00', minutes: 60 });
    ingest(db, { uuid: 'w2', from: '17:00', to: '18:00' });
    pairIngestedWorkouts(db, NOW);
    db.run(`DELETE FROM wearable_data WHERE source_raw_id = 'w2'`);
    linkCount(db) === 0 && db.get('SELECT id FROM workouts WHERE id = ?', [workoutId])
      ? ok('deleting the ingested row — which a re-sync may — leaves the session whole')
      : bad('wearable delete cascade');
  }

  // --- a hand link outranks an automatic one -------------------------------
  {
    const { db } = freshDb();
    const first = logSpan(db, { from: '17:00', minutes: 60 });
    ingest(db, { uuid: 'contested', from: '17:00', to: '18:00' });
    pairIngestedWorkouts(db, NOW);
    const wearableId = db.get(`SELECT id FROM wearable_data WHERE source_raw_id = 'contested'`).id;
    const second = logWorkout(db, { date: DAY, kind: 'strength', durationMin: 60 });
    linkIngestedWorkout(db, second, wearableId);
    const link = db.get('SELECT * FROM workout_ingest_links');
    linkCount(db) === 1 && link.workout_id === second && link.linked_by === 'user'
      ? ok('a hand link REPLACES an automatic one — an assertion outranks an inference')
      : bad('hand link', JSON.stringify(link));
    link.overlap === null && first
      ? ok('…and records no overlap, because it needed no clock to justify it')
      : bad('hand link overlap', link.overlap);
  }
}

// ---------------------------------------------------------------------------
console.log('22. in-workout heart rate through the store (D3b, docs §15 — no migration)');
{
  const NOW = new Date('2026-09-14T20:00:00.000Z');
  const DAY = '2026-09-14';
  const iso = (hhmm) => `${DAY}T${hhmm}:00.000Z`;

  /** One ingested session, optionally carrying a heart-rate figure. */
  const ingest = (
    db,
    { uuid, hr = null, kcal = 610, device = 'garmin', from = '17:00', to = '18:00' }
  ) =>
    upsertWearableRows(db, [
      {
        date: DAY,
        metricType: 'workout',
        value: Math.round((Date.parse(iso(to)) - Date.parse(iso(from))) / 60_000),
        unit: 'min',
        sourceDevice: device,
        sourceRawId: uuid,
        startTime: iso(from),
        endTime: iso(to),
        metadata: {
          activity: 'Running',
          activity_type_raw: 37,
          kcal,
          distance_km: 8.4,
          ...(hr ? { hr } : {}),
          hk: { source: 'Garmin Connect' },
        },
      },
    ]);

  // --- the skip set: door 2 is asked once, door 1 every pass ----------------
  {
    const { db } = freshDb();
    ingest(db, { uuid: 'answered', hr: { avg: 142, max: 171, method: 'source' } });
    ingest(db, { uuid: 'silent' });

    const skip = workoutUuidsWithHr(db);
    skip.has('answered') && !skip.has('silent') && skip.size === 1
      ? ok('a row carrying a figure is in the skip set and one without it is not')
      : bad('skip set', [...skip].join(','));

    // A session door 2 found nothing for is re-probed every pass while it is in
    // the window — which is how a late Connect export lands — and frozen when
    // it leaves. Nothing about the skip set stops that.
    ingest(db, { uuid: 'silent', hr: { avg: 128, max: 150, method: 'source' } });
    workoutUuidsWithHr(db).size === 2
      ? ok('…and a late figure moves that session into the skip set on the next pass')
      : bad('late figure not picked up');
  }

  // --- the CHANGED guard: a figure landing is ONE update, counted once ------
  {
    const { db } = freshDb();
    ingest(db, { uuid: 'late' }) === 1
      ? ok('the first sync of a session writes one row')
      : bad('initial insert count');
    ingest(db, { uuid: 'late', hr: { avg: 142, max: 171, method: 'workout' } }) === 1
      ? ok('a later pass finding heart rate is ONE update, counted in rowsWritten')
      : bad('hr landing not counted');
    ingest(db, { uuid: 'late', hr: { avg: 142, max: 171, method: 'workout' } }) === 0
      ? ok('…and the same row unchanged writes nothing, so a quiet re-sync reports zero')
      : bad('unchanged row was rewritten');
  }

  // --- it is NEVER a metric of its own --------------------------------------
  {
    const { db } = freshDb();
    ingest(db, { uuid: 'a', hr: { avg: 142, max: 171, method: 'workout' } });
    ingest(db, { uuid: 'b', hr: { avg: 128, max: 150, method: 'source' } });
    const inventory = wearableMetricInventory(db);
    // The Coach's readable metric set is DERIVED from the data, so a heart-rate
    // bucket would appear in it the moment one existed — one metric_type string
    // away from `rhr`, which IS a baseline. There is nothing to derive it from:
    // the figure lives inside a workout row's metadata.
    inventory.every((m) => !m.metricType.includes('heart') && m.metricType !== 'hr')
      ? ok('a store full of heart-rate figures still lists no heart-rate metric')
      : bad('inventory grew a heart-rate metric', inventory.map((m) => m.metricType).join(','));
    inventory.length === 1 && inventory[0].metricType === 'workout'
      ? ok('…only the workout rows themselves, exactly as before the feature')
      : bad('inventory', inventory.map((m) => m.metricType).join(','));
  }

  // --- both readers, and the two strings ------------------------------------
  {
    const { db } = freshDb();
    const workoutId = logWorkout(db, {
      date: DAY,
      kind: 'cardio',
      durationMin: 60,
      startedAt: iso('17:00'),
    });
    ingest(db, { uuid: 'paired', hr: { avg: 142, max: 171, method: 'workout' } });
    pairIngestedWorkouts(db, NOW);

    const paired = pairedIngestFor(db, workoutId);
    paired?.avgHr === 142 && paired.maxHr === 171
      ? ok('the figure reaches the paired session THROUGH the link — nothing is copied (0054)')
      : bad('paired hr', JSON.stringify(paired));

    const units = { weight: 'lb', distance: 'mi', volume: 'floz', length: 'in', temperature: 'f' };
    const line = ingestDetail(paired, units);
    const spoken = ingestDetail(paired, units, { spoken: true });
    line?.includes('avg 142 · max 171 bpm')
      ? ok('…and the hub line prints it after the distance, in the mono shorthand')
      : bad('display line', line);
    spoken?.includes('average heart rate 142, peak 171 beats per minute')
      ? ok('…while the spoken form says it in words, because VoiceOver reads the label')
      : bad('spoken line', spoken);
    line !== spoken
      ? ok('…and the two strings are genuinely different, not one variable feeding both')
      : bad('one string for both');

    // The Data tab's own decoder is a SECOND reader of the same blob.
    const [listed] = recentWearableWorkouts(db, 5);
    listed.avgHr === 142 && listed.maxHr === 171
      ? ok('the wearables list decodes the same figure through its own parse')
      : bad('wearables row hr', JSON.stringify(listed));
  }

  // --- an absence is an absence ---------------------------------------------
  {
    const { db } = freshDb();
    const workoutId = logWorkout(db, {
      date: DAY,
      kind: 'strength',
      durationMin: 60,
      startedAt: iso('17:00'),
    });
    ingest(db, { uuid: 'silent' });
    pairIngestedWorkouts(db, NOW);
    const paired = pairedIngestFor(db, workoutId);
    paired?.avgHr === null && paired.maxHr === null
      ? ok('a session with no figure reads null on both fields, never zero')
      : bad('absent hr', JSON.stringify(paired));
    const units = { weight: 'lb', distance: 'mi', volume: 'floz', length: 'in', temperature: 'f' };
    ingestDetail(paired, units)?.includes('bpm') === false
      ? ok('…and the line simply omits the clause')
      : bad('bpm printed for an absent figure');
    recentWearableWorkouts(db, 5)[0].avgHr === null
      ? ok('…on the wearables row too')
      : bad('wearables row invented a figure');

    // Half a reading is refused by BOTH decoders, which is why they share one
    // helper: two readings of "usable figure" would agree until one was tuned.
    ingest(db, { uuid: 'silent', hr: { avg: 142 } });
    pairedIngestFor(db, workoutId)?.avgHr === null &&
    recentWearableWorkouts(db, 5)[0].avgHr === null
      ? ok('an average with no maximum is refused identically by both decoders')
      : bad('half a reading accepted somewhere');
  }

  // --- the documented edge, from the plan: linked to the loser --------------
  {
    const { db } = freshDb();
    const workoutId = logWorkout(db, {
      date: DAY,
      kind: 'cardio',
      durationMin: 60,
      startedAt: iso('17:00'),
    });
    // The phone's copy lands first and pairs; the watch's arrives later. 0054
    // never revisits a link, so the paired line keeps reading the phone's row
    // while the Data tab's duplicate collapse shows the watch's. Documented
    // here rather than fixed — heart rate simply inherits the behaviour.
    ingest(db, { uuid: 'phone', device: 'other', from: '17:00', to: '18:00' });
    pairIngestedWorkouts(db, NOW);
    ingest(db, {
      uuid: 'watch',
      device: 'garmin',
      from: '17:02',
      to: '17:59',
      hr: { avg: 142, max: 171, method: 'workout' },
    });
    pairIngestedWorkouts(db, NOW);

    const paired = pairedIngestFor(db, workoutId);
    const [listed] = recentWearableWorkouts(db, 5);
    paired?.avgHr === null && listed.avgHr === 142
      ? ok(
          'a link made to a phone row is not revisited — the list shows the watch, the pair the phone'
        )
      : bad('link-to-loser edge changed', JSON.stringify({ paired, listed }));
  }
}

// ---------------------------------------------------------------------------
// The owner, from the device on 2026-09-21: *"the apple health found workouts
// should be attempted to be linked to workouts i've logged that are around the
// same time automatically."* 0054 refused to, by design — only the live logger
// writes `started_at`, and without a span there is no clock to overlap. This is
// the second rule, for exactly those sessions, and the refusal that keeps a pair
// the owner breaks from coming back on the next sync.
console.log('23. the DAY rule — a session logged with no start time (2026-09-21)');
{
  const NOW = new Date('2026-07-26T20:00:00.000Z');
  const DAY = todayISODate(NOW);
  const UNITS = { weight: 'lb', distance: 'mi', volume: 'floz', length: 'in', temperature: 'f' };

  /**
   * A LOCAL wall-clock instant on `day`. Everything in this section is built
   * through it, and that is the whole trick: the day rule compares an ARC
   * session's logical day against an ingested session's, and a fixture writing
   * UTC would agree with the local day on one machine's timezone and disagree
   * on the next. Hours stay well inside the day so no span crosses midnight.
   */
  const at = (day, hour, minute = 0) => {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(y, m - 1, d, hour, minute, 0, 0).toISOString();
  };

  /** One HealthKit workout row, through the real ingest path. */
  const ingestAt = (
    db,
    { uuid, day = DAY, hour = 12, minutes, device = 'garmin', raw = 50, kcal = 300 }
  ) => {
    const start = at(day, hour);
    upsertWearableRows(db, [
      {
        date: day,
        metricType: 'workout',
        value: minutes,
        unit: 'min',
        sourceDevice: device,
        sourceRawId: uuid,
        startTime: start,
        endTime: new Date(Date.parse(start) + minutes * 60_000).toISOString(),
        metadata: {
          activity: 'Strength training',
          activity_type_raw: raw,
          kcal,
          distance_km: null,
        },
      },
    ]);
    return db.get('SELECT id FROM wearable_data WHERE source_raw_id = ?', [uuid]).id;
  };

  /** A session logged with NO start time — the manual logger, a backdated entry. */
  const logDay = (db, { day = DAY, minutes = null } = {}) =>
    logWorkout(db, { date: day, kind: 'strength', durationMin: minutes });

  const linkCount = (db) => db.all('SELECT id FROM workout_ingest_links').length;

  // --- one candidate: pair it, and say HOW ----------------------------------
  {
    const { db } = freshDb();
    const workoutId = logDay(db, { minutes: 60 });
    const wearableId = ingestAt(db, { uuid: 'only', hour: 17, minutes: 55, kcal: 411 });

    pairIngestedWorkouts(db, NOW) === 1
      ? ok('one logged session and one watch record on a day pair, with no clock between them')
      : bad('unique day pair', linkCount(db));
    const link = db.get('SELECT * FROM workout_ingest_links');
    link.workout_id === workoutId && link.wearable_id === wearableId
      ? ok('…the two the owner meant')
      : bad('day pair target', JSON.stringify(link));
    link.linked_by === 'auto' && link.overlap === null
      ? ok('…recorded as automatic with NO overlap — the absence IS the method (no new column)')
      : bad('day link provenance', JSON.stringify(link));

    const paired = pairedIngestFor(db, workoutId);
    paired?.pairedBy === 'day'
      ? ok('…and it reads back as `pairedBy: day`, derived from linked_by + overlap alone')
      : bad('method derivation', JSON.stringify(paired));
    ingestDetail(paired, UNITS)?.endsWith('same day')
      ? ok('…which the line then SAYS, so a pair made without a clock is visibly one')
      : bad('day wording', ingestDetail(paired, UNITS));
    ingestDetail(paired, UNITS, { spoken: true })?.endsWith('matched by day, not by clock')
      ? ok('…in words for VoiceOver, like every other mono shorthand on these lines')
      : bad('spoken day wording', ingestDetail(paired, UNITS, { spoken: true }));

    pairIngestedWorkouts(db, NOW) === 0 && linkCount(db) === 1
      ? ok('re-running the pass links nothing new — the day rule is idempotent too')
      : bad('day rule not idempotent', linkCount(db));
  }

  // --- a no-duration log still pairs when there is only one candidate --------
  {
    const { db } = freshDb();
    logDay(db);
    ingestAt(db, { uuid: 'lonely', hour: 9, minutes: 40 });
    pairIngestedWorkouts(db, NOW) === 1
      ? ok('a log with no duration at all still pairs when nothing competes for it')
      : bad('no-duration unique case', linkCount(db));
  }

  // --- several candidates: the CLOSEST duration wins -------------------------
  {
    const { db } = freshDb();
    const workoutId = logDay(db, { minutes: 60 });
    ingestAt(db, { uuid: 'short', hour: 7, minutes: 30 });
    const wanted = ingestAt(db, { uuid: 'close', hour: 17, minutes: 47 });
    ingestAt(db, { uuid: 'long', hour: 10, minutes: 90 });
    pairIngestedWorkouts(db, NOW) === 1 &&
    db.get('SELECT * FROM workout_ingest_links').wearable_id === wanted
      ? ok('three watch records on one day: the 47-min one takes the 60-min log')
      : bad('closest duration', JSON.stringify(db.all('SELECT * FROM workout_ingest_links')));
    pairedIngestFor(db, workoutId)?.durationMin === 47
      ? ok('…and the other two are left alone, still unpaired')
      : bad('closest duration read-back');
  }

  // --- …but only inside the tolerance ---------------------------------------
  {
    const { db } = freshDb();
    logDay(db, { minutes: 60 });
    ingestAt(db, { uuid: 'tiny', hour: 7, minutes: 20 });
    ingestAt(db, { uuid: 'small', hour: 17, minutes: 25 });
    // 25 of 60 is 0.42 — under DAY_PAIR_MIN_RATIO. The point of a tolerance is
    // that failing it is an ANSWER: two sessions happened, not one.
    pairIngestedWorkouts(db, NOW) === 0 && linkCount(db) === 0
      ? ok('a 60-min log and a 25-min record are two sessions — the closest one is still refused')
      : bad('tolerance not applied', linkCount(db));
  }

  // --- …and only when there is a duration to compare ------------------------
  {
    const { db } = freshDb();
    logDay(db);
    ingestAt(db, { uuid: 'a', hour: 7, minutes: 30 });
    ingestAt(db, { uuid: 'b', hour: 17, minutes: 55 });
    pairIngestedWorkouts(db, NOW) === 0 && linkCount(db) === 0
      ? ok(
          'with no duration and two candidates there is nothing to choose on, so nothing is chosen'
        )
      : bad('guessed without a duration', linkCount(db));
  }

  // --- "exactly one" counts the DAY, not what is left after the first pair --
  {
    const { db } = freshDb();
    // Two sessions logged, two recorded. The first log takes the near record on
    // duration; the second is then down to one candidate — and must still clear
    // the tolerance against it, or a record rejected for one session would be
    // accepted by the next one down the list and the answer would depend on
    // iteration order.
    logDay(db, { minutes: 60 });
    logDay(db, { minutes: 60 });
    ingestAt(db, { uuid: 'near', hour: 17, minutes: 58 });
    ingestAt(db, { uuid: 'stray', hour: 7, minutes: 25 });
    pairIngestedWorkouts(db, NOW) === 1 && linkCount(db) === 1
      ? ok('a day with two records hands out one link — the leftover 25-min row is not a prize')
      : bad('unique-case free pass', JSON.stringify(db.all('SELECT * FROM workout_ingest_links')));
    db.get('SELECT * FROM workout_ingest_links').wearable_id ===
    db.get(`SELECT id FROM wearable_data WHERE source_raw_id = 'near'`).id
      ? ok('…and it is the 58-min one, judged on duration like everything on a crowded day')
      : bad('wrong record taken');
  }

  // --- a different day is a different session -------------------------------
  {
    const { db } = freshDb();
    logDay(db, { minutes: 60 });
    ingestAt(db, { uuid: 'yesterday', day: shiftISODate(DAY, -1), hour: 17, minutes: 60 });
    pairIngestedWorkouts(db, NOW) === 0
      ? ok('the same hour a day earlier does not pair — the day is the whole of the rule')
      : bad('cross-day pair');
  }

  // --- the SPAN rule goes first, because a clock beats a calendar -----------
  {
    const { db } = freshDb();
    const live = logWorkout(db, {
      date: DAY,
      kind: 'strength',
      durationMin: 60,
      startedAt: at(DAY, 17),
    });
    const backdated = logDay(db, { minutes: 60 });
    ingestAt(db, { uuid: 'contested', hour: 17, minutes: 55 });
    pairIngestedWorkouts(db, NOW) === 1 && linkCount(db) === 1
      ? ok('one watch record, two claimants: exactly one link is made')
      : bad('contested record', linkCount(db));
    pairedIngestFor(db, live)?.pairedBy === 'span' && pairedIngestFor(db, backdated) === null
      ? ok('…and the SESSION THAT SHARES ITS CLOCK takes it; the day-only claimant waits')
      : bad('span rule did not win', JSON.stringify(pairedIngestFor(db, backdated)));
  }

  // --- two span-less logs, one record: the one-to-one guarantee holds --------
  {
    const { db } = freshDb();
    logDay(db, { minutes: 60 });
    logDay(db, { minutes: 58 });
    ingestAt(db, { uuid: 'single', hour: 17, minutes: 59 });
    pairIngestedWorkouts(db, NOW) === 1 && linkCount(db) === 1
      ? ok('one watch record can be claimed once however many span-less sessions share its day')
      : bad('double claim by day', linkCount(db));
  }

  // --- RETROACTIVE: the day rule reaches back as far as the span rule -------
  {
    const { db } = freshDb();
    const old = shiftISODate(DAY, -60);
    const ancient = shiftISODate(DAY, -120);
    logDay(db, { day: old, minutes: 60 });
    ingestAt(db, { uuid: 'old', day: old, hour: 17, minutes: 58 });
    logDay(db, { day: ancient, minutes: 60 });
    ingestAt(db, { uuid: 'ancient', day: ancient, hour: 17, minutes: 58 });
    // This is what makes the feature arrive on a phone that already holds
    // months of both: an ordinary sync pairs the history, not only today.
    pairIngestedWorkouts(db, NOW) === 1
      ? ok('a session and a record from 60 days ago pair on an ordinary pass — no backfill needed')
      : bad('retroactive pass', linkCount(db));
    db.get('SELECT * FROM workout_ingest_links').wearable_id ===
    db.get(`SELECT id FROM wearable_data WHERE source_raw_id = 'old'`).id
      ? ok('…and the 120-day-old pair is outside PAIR_LOOKBACK_DAYS, exactly as for the span rule')
      : bad('lookback not applied');
  }

  // --- unpair is one tap, and it STAYS unpaired -----------------------------
  {
    const { db } = freshDb();
    const workoutId = logDay(db, { minutes: 60 });
    const wearableId = ingestAt(db, { uuid: 'wrong', hour: 17, minutes: 55 });
    pairIngestedWorkouts(db, NOW);

    unlinkIngestedWorkout(db, workoutId);
    linkCount(db) === 0 && pairedIngestFor(db, workoutId) === null
      ? ok('unpairing drops the link — one call, nothing of the owner’s touched')
      : bad('unlink left a link', linkCount(db));
    const refusals = pairingRefusals(db);
    refusals.length === 1 &&
    refusals[0].workoutId === workoutId &&
    refusals[0].wearableId === wearableId
      ? ok('…and records the REFUSAL, for that pair rather than for either row alone')
      : bad('refusal not recorded', JSON.stringify(refusals));

    // The whole point. Without it the next sync finds the same day, the same
    // duration and the same two rows, and remakes the link the owner rejected.
    pairIngestedWorkouts(db, NOW) === 0 && linkCount(db) === 0
      ? ok('…so the next sync does NOT remake it — a refusal outlives the pass that reads it')
      : bad('refused pair came back', linkCount(db));
    unpairedIngestedSessions(db, shiftISODate(DAY, -1), 10).length === 1
      ? ok('…and the watch’s record goes back to standing on its own, counted and inferred again')
      : bad('unpaired record did not return');

    // An assertion outranks a refusal, in both directions.
    linkIngestedWorkout(db, workoutId, wearableId);
    pairingRefusals(db).length === 0 && linkCount(db) === 1
      ? ok('a hand link clears the refusal — the owner saying "yes" outranks having said "no"')
      : bad('hand link left a stale refusal', JSON.stringify(pairingRefusals(db)));
  }

  // --- a refusal is bounded by the same window the pass can see -------------
  {
    const { db } = freshDb();
    const workoutId = logDay(db, { day: shiftISODate(DAY, -40), minutes: 60 });
    ingestAt(db, { uuid: 'aged', day: shiftISODate(DAY, -40), hour: 17, minutes: 58 });
    pairIngestedWorkouts(db, NOW);
    unlinkIngestedWorkout(db, workoutId);
    pairingRefusals(db).length === 1 ? ok('a refusal is stored') : bad('refusal missing');
    // A pass that can no longer reach the day it is about drops it: the list is
    // state, not history, and unbounded state on a device with one copy of the
    // data is a slow leak nobody would ever notice.
    pairIngestedWorkouts(db, NOW, 7);
    pairingRefusals(db).length === 0
      ? ok('…and a pass whose window no longer reaches that day prunes it')
      : bad('refusal not pruned', JSON.stringify(pairingRefusals(db)));
  }
}

console.log('24. water is two-way — the walk, the echo, the undo (2026-09-21, docs §20)');
{
  const WATER = WATER_PUBLISH_METRIC.hkIdentifier;
  const waterSpec = STATISTIC_METRICS.find((m) => m.hkIdentifier === WATER);
  const localAt = (date, hour) => {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y, m - 1, d, hour, 0, 0, 0);
  };
  const dayWindow = (date) => ({
    date,
    start: localAt(date, 0),
    end: localAt(shiftISODate(date, 1), 0),
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  /**
   * ONE fake HealthKit behind every native call: the publish pass saves into
   * it, the tagged delete removes from it, and the statistics read sums it —
   * honouring a metadata NOT the way HKStatisticsQuery honours a sample
   * predicate. So the glass the read must leave out is the one ARC's own
   * publish code wrote, carrying the tag ARC's own code stamped.
   */
  const fakeHealthKit = (initial) => {
    const samples = [...initial];
    const saves = [];
    const deletes = [];
    let refusing = false;
    return {
      samples,
      saves,
      deletes,
      refuse: (on) => {
        refusing = on;
      },
      deps: {
        isAvailable: () => true,
        save: async (identifier, unit, value, start, end, metadata) => {
          saves.push({ identifier, unit, value, at: start.toISOString(), metadata });
          if (refusing) return false;
          samples.push({ identifier, ml: value, start, metadata });
          return true;
        },
        deleteByTag: async (identifier, rowId) => {
          deletes.push({ identifier, rowId });
          const before = samples.length;
          for (let i = samples.length - 1; i >= 0; i--) {
            const s = samples[i];
            if (s.identifier === identifier && s.metadata?.[ARC_WRITE_METADATA_KEY] === rowId) {
              samples.splice(i, 1);
            }
          }
          return before - samples.length;
        },
      },
      statistics: {
        queryStatistics: async (identifier, options) => {
          const { date, NOT } = options.filter;
          const hidden = (s) =>
            (NOT ?? []).some(
              (c) =>
                c.metadata !== undefined && s.metadata?.[c.metadata.withMetadataKey] !== undefined
            );
          const sum = samples
            .filter(
              (s) =>
                s.identifier === identifier &&
                s.start >= date.startDate &&
                s.start < date.endDate &&
                !hidden(s)
            )
            .reduce((a, s) => a + s.ml, 0);
          return { sumQuantity: { unit: options.unit, quantity: sum } };
        },
      },
    };
  };

  const { db } = freshDb();
  setHealthSyncEnabled(db, true);
  const today = todayISODate();
  const win = dayWindow(today);
  // Garmin's own glass, already in Apple Health: 473 mL at 08:00.
  const hk = fakeHealthKit([
    { identifier: WATER, ml: 473, start: localAt(today, 8), metadata: {} },
  ]);

  // --- Arming: what was logged before this build stays in ARC ---------------
  const before = logWater(db, today, 250);
  const armed = await publishWaterCaptures(db, new Date(), hk.deps);
  armed.armed && armed.samplesWritten === 0 && hk.saves.length === 0
    ? ok('the first water pass ARMS: a capture already on record is never published')
    : bad('water arming', JSON.stringify(armed));
  const waterState = getHealthPublishState(db, HEALTH_WATER_PUBLISH_KEY);
  waterState.armedAt !== null &&
  waterState.cursorId === before &&
  getHealthPublishState(db).armedAt === null
    ? ok('its cursor is its OWN key — the body cursor is untouched by it')
    : bad('cursor keys', JSON.stringify({ waterState, body: getHealthPublishState(db) }));

  // --- A new capture goes out, once, tagged with its own id ------------------
  const glass = logWater(db, today, 473.176473); // a 16 oz bottle, as the Log tab writes it
  const first = await publishWaterCaptures(db, new Date(), hk.deps);
  first.samplesWritten === 1 &&
  hk.saves.length === 1 &&
  hk.saves[0].identifier === WATER &&
  hk.saves[0].unit === 'mL' &&
  hk.saves[0].value === 473.176473 &&
  hk.saves[0].metadata[ARC_WRITE_METADATA_KEY] === glass
    ? ok('a manual capture publishes as ONE DietaryWater sample in mL, tagged with its row id')
    : bad('water publish', JSON.stringify(hk.saves));
  first.byType.length === 1 && first.byType[0].label === 'Water' && first.byType[0].succeeded === 1
    ? ok('the log reports it per type, as "Water"')
    : bad('water byType', JSON.stringify(first.byType));

  // --- THE ECHO: read the day back through the real read path --------------
  // Health now holds Garmin's 473 AND ARC's own 473.18. The control shows what
  // an unfiltered read would bucket; the real read is sync.ts's, failClosed.
  const control = await readDailyCumulative(WATER, 'mL', [win], {}, hk.statistics);
  const read = await readDailyCumulative(
    WATER,
    'mL',
    [win],
    { failClosed: isPublishedIdentifier(WATER) },
    hk.statistics
  );
  Math.abs(control.samples[0].value - 946.176473) < 1e-9 && read.samples[0].value === 473
    ? ok(
        'Health holds both glasses (946.18 mL); the published-water read buckets Garmin’s 473 alone'
      )
    : bad('echo read', JSON.stringify({ control, read }));
  upsertWearableRows(db, statisticDailyRows(waterSpec, read.samples));
  const dayTotal = waterDaySeries(db, 1, today)[0];
  const expected = 250 + 473.176473 + 473;
  Math.abs(dayTotal.ml - expected) < 1e-6 && dayTotal.entries === 3
    ? ok(
        `the day counts ARC’s glass ONCE: 250 + 473.18 + Garmin 473 = ${dayTotal.ml.toFixed(2)} mL (the echo would read ${(expected + 473.176473).toFixed(2)})`
      )
    : bad('DOUBLE COUNT', JSON.stringify(dayTotal));

  // --- The structural guard: an hk: bucket is never sent back ---------------
  const walkable = publishableWaterAfter(db, null, 50).map((r) => r.id);
  walkable.length === 2 && walkable.includes(before) && walkable.includes(glass)
    ? ok('the walk sees only manual captures — the hk:water_ml bucket is not publishable')
    : bad('walkable', JSON.stringify(walkable));
  const again = await publishWaterCaptures(db, new Date(), hk.deps);
  again.samplesAttempted === 0 && hk.saves.length === 1
    ? ok('a pass after the read-back publishes nothing: no re-post, no echo of the bucket')
    : bad('republished', JSON.stringify(again));

  // --- The Undo takes the glass back out of Health ---------------------------
  removeWaterCapture(db, glass, hk.deps) &&
  hk.deletes.length === 1 &&
  hk.deletes[0].rowId === glass &&
  hk.deletes[0].identifier === WATER
    ? ok('removeWaterCapture deletes the row and asks Health to delete by THAT row’s tag')
    : bad('undo', JSON.stringify(hk.deletes));
  await flush();
  hk.samples.length === 1 && hk.samples[0].ml === 473
    ? ok('...and Health is left holding Garmin’s glass alone')
    : bad('undo left', JSON.stringify(hk.samples));
  const reread = await readDailyCumulative(WATER, 'mL', [win], { failClosed: true }, hk.statistics);
  upsertWearableRows(db, statisticDailyRows(waterSpec, reread.samples));
  Math.abs(waterDaySeries(db, 1, today)[0].ml - (250 + 473)) < 1e-9
    ? ok('the day after the Undo: 250 + Garmin 473 — nothing left behind on either side')
    : bad('after undo', JSON.stringify(waterDaySeries(db, 1, today)));

  // --- An edit replaces what was published, and only that --------------------
  const bottle = logWater(db, today, 500);
  await publishWaterCaptures(db, new Date(), hk.deps);
  const savesBefore = hk.saves.length;
  editWaterCapture(db, bottle, 750, hk.deps);
  await flush();
  const replaced = hk.samples.filter((s) => s.metadata?.[ARC_WRITE_METADATA_KEY] === bottle);
  replaced.length === 1 &&
  replaced[0].ml === 750 &&
  hk.saves.length === savesBefore + 1 &&
  hk.saves[hk.saves.length - 1].at === hk.saves[savesBefore - 1].at
    ? ok('editing a published capture re-saves it at 750 mL, same tag, same instant — one glass')
    : bad('edit resync', JSON.stringify(replaced));
  const unwalked = logWater(db, today, 200);
  const savesMid = hk.saves.length;
  editWaterCapture(db, unwalked, 300, hk.deps);
  await flush();
  hk.saves.length === savesMid
    ? ok('editing a capture the walk has not reached saves nothing — the tagged delete found none')
    : bad('edit of unpublished saved', JSON.stringify(hk.saves.slice(savesMid)));
  await publishWaterCaptures(db, new Date(), hk.deps);
  hk.saves[hk.saves.length - 1].value === 300 &&
  hk.saves[hk.saves.length - 1].metadata[ARC_WRITE_METADATA_KEY] === unwalked
    ? ok('...and the walk then publishes the CORRECTED amount when it gets there')
    : bad('corrected publish', JSON.stringify(hk.saves[hk.saves.length - 1]));

  // --- Rule 2: a refusal stalls and loses nothing ----------------------------
  hk.refuse(true);
  const refusedCapture = logWater(db, today, 240);
  const cursorBefore = getHealthPublishState(db, HEALTH_WATER_PUBLISH_KEY).cursorId;
  const stalled = await publishWaterCaptures(db, new Date(), hk.deps);
  stalled.stalled &&
  stalled.samplesWritten === 0 &&
  getHealthPublishState(db, HEALTH_WATER_PUBLISH_KEY).cursorId === cursorBefore
    ? ok('a refused save stalls the water walk and leaves its cursor where it was')
    : bad('water stall', JSON.stringify(stalled));
  hk.refuse(false);
  const retried = await publishWaterCaptures(db, new Date(), hk.deps);
  retried.samplesWritten === 1 &&
  hk.saves[hk.saves.length - 1].metadata[ARC_WRITE_METADATA_KEY] === refusedCapture
    ? ok('the next pass publishes the capture it stalled on')
    : bad('water retry', JSON.stringify(retried));

  // --- The race: an Undo that lands while the save is in flight --------------
  // The one ordering the Undo cannot cover by itself: the walk has read the row
  // and called save; the Undo lands BEFORE the sample exists, so its tagged
  // delete finds nothing; then the save lands — an orphan with no capture.
  const racing = logWater(db, today, 120);
  const raceDeps = {
    ...hk.deps,
    save: async (...args) => {
      removeWaterCapture(db, racing, hk.deps); // the Undo, first
      await flush(); // its delete runs now, and finds 0
      return hk.deps.save(...args); // then the save lands
    },
  };
  await publishWaterCaptures(db, new Date(), raceDeps);
  await flush();
  const raceDeletes = hk.deletes.filter((d) => d.rowId === racing).length;
  getPublishableWater(db, racing) === null &&
  raceDeletes === 2 &&
  hk.samples.every((s) => s.metadata?.[ARC_WRITE_METADATA_KEY] !== racing)
    ? ok(
        'undone mid-save: the Undo’s delete finds nothing, then the walk sees the row gone and takes the orphan out'
      )
    : bad('race orphan', JSON.stringify({ raceDeletes, samples: hk.samples }));

  // --- A backdated capture lands on its own day ------------------------------
  const yesterday = shiftISODate(today, -1);
  logWater(db, yesterday, 200);
  await publishWaterCaptures(db, new Date(), hk.deps);
  hk.saves[hk.saves.length - 1].at === localAt(yesterday, 12).toISOString()
    ? ok('a capture backdated to yesterday is published at yesterday’s local noon')
    : bad('backdated instant', hk.saves[hk.saves.length - 1].at);

  // --- One switch, both directions --------------------------------------------
  setHealthSyncEnabled(db, false);
  const deletesOff = hk.deletes.length;
  const offRemoved = removeWaterCapture(db, bottle, hk.deps);
  const offPass = await publishWaterCaptures(db, new Date(), hk.deps);
  offRemoved && hk.deletes.length === deletesOff && offPass.status === 'disabled'
    ? ok('with sync off the row still goes, but ARC neither deletes from nor writes to Health')
    : bad('switch off', JSON.stringify({ offRemoved, deletes: hk.deletes.length, offPass }));
  setHealthSyncEnabled(db, true);
  const absent = await publishWaterCaptures(db, new Date(), {
    ...hk.deps,
    isAvailable: () => false,
  });
  absent.status === 'unavailable' && absent.samplesWritten === 0
    ? ok('no HealthKit module: the water pass is a silent no-op')
    : bad('absent water pass', JSON.stringify(absent));
}

console.log('25. one pass at a time — the gate behind Home’s blank-cell sync (2026-09-23)');
{
  // In node the pass itself returns `disabled` (sync is off in a fresh
  // database), which is exactly enough: what is under test is the GATE — who
  // joins, who waits, who starts, and when the running flag clears — not the
  // pass. Every running event is one start or one settle, so the count says
  // how many passes actually ran.
  const { db } = freshDb();
  let events = 0;
  const stop = subscribeHealthSyncRunning(() => events++);

  isHealthSyncRunning() === false ? ok('nothing is running at rest') : bad('running at rest');

  // ── Join: the boot pass, and a return that never left the app ──
  const first = startOrJoinHealthSync(db);
  const second = startOrJoinHealthSync(db);
  first === second
    ? ok('startOrJoin: a second caller JOINS the running pass rather than starting another')
    : bad('two passes were started');
  isHealthSyncRunning() && events === 1
    ? ok('…the pass is visible while it runs, and its start was announced once')
    : bad('start not visible', `${isHealthSyncRunning()} / ${events}`);

  const result = await second;
  result.status === 'disabled'
    ? ok('the joined caller gets the pass’s own result')
    : bad('joined result', JSON.stringify(result));
  !isHealthSyncRunning() && events === 2
    ? ok('…and by the time a caller resumes, the flag is clear and the settle was announced')
    : bad('settle not visible', `${isHealthSyncRunning()} / ${events}`);

  const third = startOrJoinHealthSync(db);
  third !== first
    ? ok('once settled, the next caller starts a fresh pass')
    : bad('a settled pass was re-joined');
  await third;

  // ── Fresh: a tap, Sync now, a return from another app ──
  // The case the review found: a pass that began BEFORE the user went to Garmin
  // Connect cannot see what they pushed there. A fresh ask never joins it; it
  // queues one follow-up behind it, and later fresh asks share that follow-up.
  events = 0;
  const running = requestFreshHealthSync(db);
  isHealthSyncRunning() && events === 1
    ? ok('fresh, nothing running: a pass starts at once')
    : bad('fresh did not start', `${isHealthSyncRunning()} / ${events}`);
  const tapped = requestFreshHealthSync(db);
  tapped !== running
    ? ok('fresh, a pass already running: it is NOT joined — it started before the ask')
    : bad('a fresh ask joined a pass that predates it');
  requestFreshHealthSync(db) === tapped
    ? ok('…a second fresh ask shares the queued follow-up — never more than one waits')
    : bad('a second follow-up was queued');
  startOrJoinHealthSync(db) === tapped
    ? ok('…and a joiner joins the newest, which is the follow-up')
    : bad('a joiner took the stale pass');
  events === 1
    ? ok('…queuing started nothing yet')
    : bad('the follow-up started early', String(events));

  await running;
  isHealthSyncRunning()
    ? ok('between the first pass settling and the follow-up starting, the flag stays up (no flicker to the offer)')
    : bad('the flag dropped in the gap');
  const followed = await tapped;
  followed.status === 'disabled' && !isHealthSyncRunning() && events === 4
    ? ok('the follow-up ran after the first — two passes for three asks, never side by side')
    : bad('follow-up', `${followed.status} / ${isHealthSyncRunning()} / events ${events}`);

  // ── Setup flows: a pass of their own ──
  const ordinary = startOrJoinHealthSync(db);
  const setup = startHealthSync(db, new Date(), { windowDays: 90 });
  setup !== ordinary
    ? ok('startHealthSync never joins — a setup flow’s pass is its own')
    : bad('setup flow joined a pass that predates its grant');
  startOrJoinHealthSync(db) === setup
    ? ok('…and a later joiner joins the NEWEST running pass')
    : bad('joined the wrong pass');
  const afterSetup = requestFreshHealthSync(db);
  afterSetup !== setup && afterSetup !== ordinary
    ? ok('…while a fresh ask queues behind it')
    : bad('a fresh ask joined a running setup pass');
  await Promise.all([ordinary, setup, afterSetup]);
  !isHealthSyncRunning()
    ? ok('overlapping passes and a follow-up all clear when they settle')
    : bad('a settled pass stayed listed');

  // ── A subscriber that throws cannot jam the gate ──
  const stopThrower = subscribeHealthSyncRunning(() => {
    throw new Error('database is locked');
  });
  let escaped = false;
  let jammed = null;
  try {
    jammed = startOrJoinHealthSync(db);
  } catch {
    escaped = true;
  }
  if (jammed) await jammed;
  !escaped && !isHealthSyncRunning()
    ? ok('a running-listener that throws neither escapes the start nor strands the pass as running')
    : bad('the gate jammed', `${escaped} / ${isHealthSyncRunning()}`);
  stopThrower();

  // A pass that THROWS must clear too, or every blank cell would say Syncing
  // until the app restarted.
  const broken = {
    get: () => {
      throw new Error('database is locked');
    },
    all: () => {
      throw new Error('database is locked');
    },
    run: () => {
      throw new Error('database is locked');
    },
    transaction: () => {
      throw new Error('database is locked');
    },
  };
  let rejected = false;
  try {
    await requestFreshHealthSync(broken);
  } catch {
    rejected = true;
  }
  rejected && !isHealthSyncRunning()
    ? ok('a pass that throws rejects to its caller AND clears the running flag')
    : bad('a thrown pass left the flag set', `${rejected} / ${isHealthSyncRunning()}`);
  stop();

  // ── The foreground hook: fresh only after a trip to the background ──
  const walk = (states) => {
    const next = foregroundTracker();
    return states.map(next).filter((t) => t !== null);
  };
  const eqJ = (name, actual, expected) =>
    JSON.stringify(actual) === JSON.stringify(expected)
      ? ok(name)
      : bad(name, `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  eqJ(
    'foreground: Face ID or Control Centre (inactive → active) joins a running pass',
    walk(['inactive', 'active']),
    ['join']
  );
  eqJ(
    'foreground: back from another app (background → active) asks for a fresh pass',
    walk(['inactive', 'background', 'active']),
    ['fresh']
  );
  eqJ(
    '…and only once — the next inactive → active is a join again',
    walk(['background', 'inactive', 'active', 'inactive', 'active']),
    ['fresh', 'join']
  );

  // The hook's wiring. Under node it returns before reaching the pass (no
  // HealthKit), so this is asserted on the source — the same way
  // db/timezone.test.mjs pins the pass's own ordering.
  const src = readFileSync(new URL('../src/lib/health/sync.ts', import.meta.url), 'utf8');
  const hook = src.slice(
    src.indexOf('export async function syncHealthIfEnabled'),
    src.indexOf('export function foregroundTracker')
  );
  hook.includes('requestFreshHealthSync(db, now)') &&
  hook.includes('startOrJoinHealthSync(db, now)') &&
  !hook.includes('syncHealthData(')
    ? ok('the boot/foreground sync goes through the gate: fresh after a trip away, a join otherwise')
    : bad('syncHealthIfEnabled bypasses the gate');
  const register = src.slice(src.indexOf('export function registerForegroundHealthSync'));
  register.includes('foregroundTracker()') && register.includes("fresh: trigger === 'fresh'")
    ? ok('…and the AppState listener feeds it the tracker’s verdict')
    : bad('the foreground listener ignores the background trip');

  // …and so does every Settings caller: Sync now asks for a fresh pass, the
  // setup flows start tracked ones. A bare `syncHealthData(` there would be
  // invisible to Home.
  const settings = readFileSync(new URL('../app/settings-health.tsx', import.meta.url), 'utf8');
  !/await syncHealthData\(/.test(settings) && settings.includes('requestFreshHealthSync(getDb())')
    ? ok('Settings › Apple Health starts no untracked pass, and Sync now reads from the tap')
    : bad('Settings still starts a pass the gate cannot see');
}

// ---------------------------------------------------------------------------
// Owner, 2026-09-23: "workout duration should be editable" and "be able to
// reorder exercises in a workout". The session screen writes both through
// replaceWorkout, and runs a pairing pass when the minutes changed.
console.log('26. pairing reads a corrected duration, and survives a reorder (2026-09-23)');
{
  const NOW = new Date('2026-07-26T20:00:00.000Z');
  const DAY = todayISODate(NOW);
  // LOCAL wall-clock instants on DAY, for the reason §23 gives.
  const at = (hour, minute = 0) => {
    const [y, m, d] = DAY.split('-').map(Number);
    return new Date(y, m - 1, d, hour, minute, 0, 0).toISOString();
  };
  const ingestAt = (db, { uuid, hour, minute = 0, minutes }) => {
    const start = at(hour, minute);
    upsertWearableRows(db, [
      {
        date: DAY,
        metricType: 'workout',
        value: minutes,
        unit: 'min',
        sourceDevice: 'garmin',
        sourceRawId: uuid,
        startTime: start,
        endTime: new Date(Date.parse(start) + minutes * 60_000).toISOString(),
        metadata: { activity: 'Strength training', activity_type_raw: 50, kcal: 300 },
      },
    ]);
    return db.get('SELECT id FROM wearable_data WHERE source_raw_id = ?', [uuid]).id;
  };
  const linkCount = (db) => db.all('SELECT id FROM workout_ingest_links').length;
  const row = { exercise: 'Barbell Row', exerciseId: 'barbell-row', reps: 8, weightKg: 70 };
  const bench = { exercise: 'Bench', exerciseId: 'barbell-bench-press', reps: 5, weightKg: 100 };

  // --- the DAY rule compares the corrected figure ---------------------------
  {
    const { db } = freshDb();
    // Typed 10 for 60. Two watch records on the day, so the rule has to choose
    // on duration — and 10 is nowhere near either of them.
    const id = logWorkout(db, { date: DAY, kind: 'strength', durationMin: 10 }, [row]);
    const lift = ingestAt(db, { uuid: 'lift', hour: 17, minutes: 58 });
    ingestAt(db, { uuid: 'walk', hour: 7, minutes: 90 });
    pairIngestedWorkouts(db, NOW) === 0
      ? ok('a mistyped 10 min is refused against a 58-min record — two sessions, not one')
      : bad('mistyped duration paired', linkCount(db));
    replaceWorkout(db, id, { kind: 'strength', durationMin: 60 }, [row]);
    pairIngestedWorkouts(db, NOW) === 1 &&
    db.get('SELECT wearable_id FROM workout_ingest_links').wearable_id === lift
      ? ok('corrected to 60, the same pass pairs it with the 58-min lift, not the walk')
      : bad('corrected duration did not pair', linkCount(db));
  }

  // --- the SPAN rule reads started_at + the corrected minutes ----------------
  {
    const { db } = freshDb();
    // Started at 16:00 and saved as 20 minutes; the watch recorded 16:30–17:30.
    const id = logWorkout(db, { date: DAY, kind: 'strength', durationMin: 20, startedAt: at(16) }, [
      row,
    ]);
    const watch = ingestAt(db, { uuid: 'lift-span', hour: 16, minute: 30, minutes: 60 });
    pairIngestedWorkouts(db, NOW) === 0
      ? ok('16:00 for 20 min shares no clock with 16:30–17:30 — no pair')
      : bad('short span paired', linkCount(db));
    replaceWorkout(db, id, { kind: 'strength', durationMin: 70 }, [row]);
    pairIngestedWorkouts(db, NOW) === 1 &&
    db.get('SELECT wearable_id, overlap FROM workout_ingest_links').wearable_id === watch
      ? ok('corrected to 70, the span reaches 17:10 and the overlap pairs them')
      : bad('corrected span did not pair', linkCount(db));
  }

  // --- a reorder is a set rewrite; the link is to the SESSION ---------------
  {
    const { db } = freshDb();
    const id = logWorkout(db, { date: DAY, kind: 'strength', durationMin: 60 }, [bench, row]);
    ingestAt(db, { uuid: 'lift', hour: 17, minutes: 58 });
    pairIngestedWorkouts(db, NOW);
    const before = db.get('SELECT * FROM workout_ingest_links WHERE workout_id = ?', [id]);
    replaceWorkout(db, id, { kind: 'strength', durationMin: 60 }, [row, bench]);
    const after = db.get('SELECT * FROM workout_ingest_links WHERE workout_id = ?', [id]);
    before && after && after.id === before.id && after.wearable_id === before.wearable_id
      ? ok('reordering the exercises keeps the watch pair — the same link row, untouched')
      : bad('reorder dropped the pair', JSON.stringify({ before, after }));
    pairedIngestFor(db, id)?.durationMin === 58
      ? ok('…and the session still reads the watch’s own record through it')
      : bad('pair read-back after reorder');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
