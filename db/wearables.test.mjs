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
import { DatabaseSync } from 'node:sqlite';

import { migrate, pendingMigrations } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  dailyMetricSeries,
  deviceLabel,
  getHealthPublishState,
  getHealthSyncState,
  HEALTH_PUBLISH_KEY,
  latestMetric,
  pickDailyMetric,
  recentWearableWorkouts,
  setHealthPublishState,
  setHealthSyncState,
  SOURCE_PRIORITY,
  upsertWearableRows,
} from '../src/lib/db/repositories/wearables.ts';
import {
  HEALTH_INGEST_SOURCE,
  newestBodyCursor,
  publishableBodyAfter,
  upsertHealthBodyRows,
} from '../src/lib/db/repositories/body.ts';
import { isHealthSyncEnabled, setHealthSyncEnabled } from '../src/lib/db/repositories/user.ts';
import {
  ARC_BUNDLE_ID,
  ARC_WRITE_METADATA_KEY,
  BODY_INGEST_METRICS,
  bodyIngestRows,
  quantityDailyRows,
  SAMPLE_METRICS,
  sleepDailyRows,
} from '../src/lib/health/mapping.ts';
import { publishBodyMetrics, PUBLISH_BATCH_ROWS } from '../src/lib/health/publish.ts';
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
    ])
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
    ])
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
    ])
  ) === 0
    ? ok("ARC's own published weight, read back, ingests to nothing")
    : bad('echo ingested');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
