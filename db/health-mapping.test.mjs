/**
 * Headless test of the PURE HealthKit → wearable_data mapping
 * (src/lib/health/mapping.ts) plus the sync window maths (sync.ts) and the
 * guarded seam's absent-module behavior. No Expo, no native module, no DB.
 * Run: npm run db:test.
 */
import {
  ARC_BUNDLE_ID,
  ARC_WRITE_METADATA_KEY,
  BODY_INGEST_METRICS,
  BODY_PUBLISH_METRICS,
  bodyIngestRows,
  dayRawId,
  ECHO_SUPPRESSED_IDENTIFIERS,
  HEALTH_READ_IDENTIFIERS,
  HEALTH_WRITE_IDENTIFIERS,
  ingestRejectionFor,
  isIngestableSample,
  localDayOf,
  quantityDailyRows,
  readWriteScopeOverlap,
  SAMPLE_METRICS,
  sleepDailyRows,
  sourceDeviceFor,
  STATISTIC_METRICS,
  statisticDailyRows,
  unsuppressedEchoIdentifiers,
  workoutActivityName,
  workoutRows,
} from '../src/lib/health/mapping.ts';
import { bodySamplesFor } from '../src/lib/health/publish.ts';
import {
  clampRowsToWindow,
  FIRST_SYNC_DAYS,
  MAX_SYNC_DAYS,
  sampleQuerySpan,
  shouldAutoSync,
  syncDayWindows,
  SYNC_WINDOW_DAYS,
  syncWindowDays,
} from '../src/lib/health/sync.ts';
import {
  healthWriteAccess,
  isHealthKitAvailable,
  isHealthKitSupported,
  ownWriteExclusions,
  parseCategorySample,
  parseQuantitySample,
  parseStatisticSum,
  parseWorkoutSample,
  readQuantitySamples,
  requestHealthPermissions,
  saveHealthQuantity,
  withOwnWritesExcluded,
} from '../src/lib/health/healthkit.ts';
import { metricNote, parseSyncLog, publishNote } from '../src/lib/health/log.ts';
import { ACCUMULATING_METRIC_TYPES, isAccumulatingMetric } from '../src/lib/health/accumulating.ts';
import { readFileSync } from 'node:fs';

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

const prov = (bundleId, productType = null, sourceName = null, arcWritten = false) => ({
  sourceName,
  bundleId,
  productType,
  arcWritten,
});

/** Local wall-clock ISO instant builder (tests run in the machine timezone —
 * mapping treats local time as the day, so build instants FROM local parts). */
const local = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm, 0, 0).toISOString();

console.log('0. source bucketing (spec §4)');
{
  const cases = [
    [prov('com.ouraring.oura'), 'oura'],
    [prov('com.whoop.iphone'), 'whoop'],
    [prov('com.garmin.connect.mobile'), 'garmin'],
    [prov('com.ultrahuman.ios'), 'ultrahuman'],
    [prov('com.withings.wiScaleNG'), 'withings'],
    [prov('com.eightsleep.Eight'), 'eight_sleep'],
    [prov('com.apple.health.ABC-123', 'Watch7,1'), 'apple_watch'],
    [prov('com.apple.health.ABC-123', 'iPhone16,2'), 'other'],
    [prov('com.apple.Health'), 'manual'],
    [prov('com.somebody.new'), 'other'],
    [prov(null), 'other'],
    // ECHO SUPPRESSION, last line of defence: ARC's own published samples must
    // never bucket as 'other' (priority 7 — above apple_health and manual), or
    // ARC would rank its own reflection over the merged Apple total and over the
    // user's keypad entry. 'manual' is both truthful and the priority floor.
    [prov(ARC_BUNDLE_ID), 'manual'],
    [prov(ARC_BUNDLE_ID, 'iPhone16,2', 'ARC'), 'manual'],
    // …and the metadata tag alone is enough, for the case the bundle id is the
    // thing that didn't survive parsing.
    [prov(null, null, null, true), 'manual'],
    [prov('com.somebody.new', null, null, true), 'manual'],
  ];
  for (const [p, want] of cases) {
    const got = sourceDeviceFor(p);
    got === want
      ? ok(`${p.bundleId ?? 'null'}${p.productType ? ' / ' + p.productType : ''} → ${want}`)
      : bad(`${p.bundleId} bucketing`, `got ${got}`);
  }
}

console.log('1. quantity daily rows — bucketing, aggregation, transforms');
{
  const hrvSpec = SAMPLE_METRICS.find((m) => m.metricType === 'hrv');
  const watch = prov('com.apple.health.X', 'Watch7,1', "Matt's Apple Watch");
  const rows = quantityDailyRows(hrvSpec, [
    {
      value: 40,
      startISO: local(2026, 7, 28, 2, 0),
      endISO: local(2026, 7, 28, 2, 1),
      provenance: watch,
    },
    {
      value: 50,
      startISO: local(2026, 7, 28, 7, 0),
      endISO: local(2026, 7, 28, 7, 1),
      provenance: watch,
    },
    {
      value: 60,
      startISO: local(2026, 7, 29, 7, 0),
      endISO: local(2026, 7, 29, 7, 1),
      provenance: watch,
    },
    // Same day, different device → its own row, not merged into the watch mean.
    {
      value: 44,
      startISO: local(2026, 7, 28, 6, 0),
      endISO: local(2026, 7, 28, 6, 1),
      provenance: prov('com.ouraring.oura', null, 'Oura'),
    },
  ]);
  rows.length === 3
    ? ok('3 (day, device) buckets from 4 samples')
    : bad('bucket count', rows.length);
  const day28watch = rows.find((r) => r.date === '2026-07-28' && r.sourceDevice === 'apple_watch');
  day28watch && day28watch.value === 45
    ? ok('mean aggregation (40,50 → 45)')
    : bad('mean', JSON.stringify(day28watch));
  day28watch && day28watch.sourceRawId === 'hk:hrv:2026-07-28'
    ? ok('deterministic raw id hk:hrv:<date>')
    : bad('raw id', day28watch?.sourceRawId);
  day28watch && day28watch.metadata.hk.samples === 2
    ? ok('metadata carries sample count')
    : bad('metadata samples', JSON.stringify(day28watch?.metadata));
  const day28oura = rows.find((r) => r.date === '2026-07-28' && r.sourceDevice === 'oura');
  day28oura && day28oura.value === 44
    ? ok('same-day other-device row stays separate')
    : bad('oura row', JSON.stringify(day28oura));

  // RHR aggregates LAST (the Watch replaces earlier same-day estimates).
  const rhrSpec = SAMPLE_METRICS.find((m) => m.metricType === 'rhr');
  const rhrRows = quantityDailyRows(rhrSpec, [
    {
      value: 61,
      startISO: local(2026, 7, 28, 9, 0),
      endISO: local(2026, 7, 28, 9, 0),
      provenance: watch,
    },
    {
      value: 58,
      startISO: local(2026, 7, 28, 21, 0),
      endISO: local(2026, 7, 28, 21, 0),
      provenance: watch,
    },
  ]);
  rhrRows.length === 1 && rhrRows[0].value === 58
    ? ok('rhr takes the LAST sample of the day (58, not the 59.5 mean)')
    : bad('rhr last', JSON.stringify(rhrRows));

  // SpO2 arrives as a 0–1 fraction; stored as 0–100 pct.
  const spo2Spec = SAMPLE_METRICS.find((m) => m.metricType === 'spo2_pct');
  const spo2Rows = quantityDailyRows(spo2Spec, [
    {
      value: 0.97,
      startISO: local(2026, 7, 28, 3, 0),
      endISO: local(2026, 7, 28, 3, 1),
      provenance: watch,
    },
    {
      value: 0.99,
      startISO: local(2026, 7, 28, 4, 0),
      endISO: local(2026, 7, 28, 4, 1),
      provenance: watch,
    },
  ]);
  spo2Rows.length === 1 && spo2Rows[0].value === 98
    ? ok('spo2 fraction ×100 (0.97,0.99 → 98)')
    : bad('spo2', JSON.stringify(spo2Rows));

  // Wrist temp attributes by sample END (the wake morning).
  const wristSpec = SAMPLE_METRICS.find((m) => m.metricType === 'wrist_temp_c');
  const wristRows = quantityDailyRows(wristSpec, [
    {
      value: 35.9,
      startISO: local(2026, 7, 27, 23, 30),
      endISO: local(2026, 7, 28, 6, 30),
      provenance: watch,
    },
  ]);
  wristRows.length === 1 && wristRows[0].date === '2026-07-28'
    ? ok('overnight wrist temp lands on the wake day')
    : bad('wrist temp day', JSON.stringify(wristRows));

  // Non-finite samples are dropped.
  const dropped = quantityDailyRows(hrvSpec, [
    {
      value: Number.NaN,
      startISO: local(2026, 7, 28, 2, 0),
      endISO: local(2026, 7, 28, 2, 1),
      provenance: watch,
    },
  ]);
  dropped.length === 0 ? ok('NaN samples dropped') : bad('NaN drop', dropped.length);
}

console.log('2. cumulative statistics rows — merged label, zero-day skip');
{
  const steps = STATISTIC_METRICS.find((m) => m.metricType === 'steps');
  const rows = statisticDailyRows(steps, [
    { date: '2026-07-27', value: 8123.4 },
    { date: '2026-07-28', value: 0 },
    { date: '2026-07-29', value: 3240 },
  ]);
  rows.length === 2
    ? ok('zero-value day skipped (0 steps is a claim, not absence)')
    : bad('rows', rows.length);
  rows.every((r) => r.sourceDevice === 'apple_health')
    ? ok("merged totals labelled 'apple_health'")
    : bad('merged label', JSON.stringify(rows.map((r) => r.sourceDevice)));
  rows[0].value === 8123 ? ok('steps rounded to integers') : bad('rounding', rows[0].value);
}

console.log('3. sleep — sessions, stages, attribution (spec §3)');
{
  const watch = prov('com.apple.health.X', 'Watch7,1', "Matt's Apple Watch");
  // A night 23:10 → 06:40 crossing midnight: inBed spans, stages partition.
  const samples = [
    {
      value: 0,
      startISO: local(2026, 7, 28, 23, 10),
      endISO: local(2026, 7, 29, 6, 40),
      provenance: watch,
    }, // inBed 450m
    {
      value: 3,
      startISO: local(2026, 7, 28, 23, 20),
      endISO: local(2026, 7, 29, 2, 20),
      provenance: watch,
    }, // core 180m
    {
      value: 4,
      startISO: local(2026, 7, 29, 2, 20),
      endISO: local(2026, 7, 29, 3, 20),
      provenance: watch,
    }, // deep 60m
    {
      value: 5,
      startISO: local(2026, 7, 29, 3, 20),
      endISO: local(2026, 7, 29, 5, 20),
      provenance: watch,
    }, // rem 120m
    {
      value: 2,
      startISO: local(2026, 7, 29, 5, 20),
      endISO: local(2026, 7, 29, 5, 50),
      provenance: watch,
    }, // awake 30m
    {
      value: 1,
      startISO: local(2026, 7, 29, 5, 50),
      endISO: local(2026, 7, 29, 6, 40),
      provenance: watch,
    }, // unspec 50m
  ];
  const rows = sleepDailyRows(samples);
  const duration = rows.find((r) => r.metricType === 'sleep_duration_min');
  duration && duration.date === '2026-07-29'
    ? ok('night crossing midnight lands on the wake day')
    : bad('wake day', JSON.stringify(duration));
  duration && duration.value === 410
    ? ok('asleep = core+deep+rem+unspecified only (410m, not inBed 450 or the 890 blind sum)')
    : bad('asleep minutes', duration?.value);
  const inBed = rows.find((r) => r.metricType === 'sleep_in_bed_min');
  inBed && inBed.value === 450
    ? ok('inBed recorded separately (450m)')
    : bad('inBed', inBed?.value);
  const deep = rows.find((r) => r.metricType === 'sleep_deep_min');
  deep && deep.value === 60 ? ok('deep stage row (60m)') : bad('deep', deep?.value);
  const awake = rows.find((r) => r.metricType === 'sleep_awake_min');
  awake && awake.value === 30 ? ok('awake row (30m)') : bad('awake', awake?.value);
  duration && duration.startTime !== null && duration.endTime !== null
    ? ok('duration row carries session bounds')
    : bad('session bounds', JSON.stringify(duration));

  // A 40-min afternoon nap: separate session, loses to the main night.
  const withNap = sleepDailyRows([
    ...samples,
    {
      value: 1,
      startISO: local(2026, 7, 29, 14, 0),
      endISO: local(2026, 7, 29, 14, 40),
      provenance: watch,
    },
  ]);
  const napDuration = withNap.find((r) => r.metricType === 'sleep_duration_min');
  napDuration && napDuration.value === 410
    ? ok('longest session wins the day (nap ignored)')
    : bad('nap handling', napDuration?.value);

  // WHOOP-style: inBed + asleepUnspecified only → duration but NO stage rows.
  const whoop = prov('com.whoop.iphone', null, 'WHOOP');
  const whoopRows = sleepDailyRows([
    {
      value: 0,
      startISO: local(2026, 7, 28, 23, 0),
      endISO: local(2026, 7, 29, 7, 0),
      provenance: whoop,
    },
    {
      value: 1,
      startISO: local(2026, 7, 28, 23, 15),
      endISO: local(2026, 7, 29, 6, 45),
      provenance: whoop,
    },
  ]);
  whoopRows.some((r) => r.metricType === 'sleep_duration_min')
    ? ok('stage-less writer still yields a duration row')
    : bad('whoop duration', JSON.stringify(whoopRows.map((r) => r.metricType)));
  !whoopRows.some((r) =>
    ['sleep_core_min', 'sleep_deep_min', 'sleep_rem_min'].includes(r.metricType)
  )
    ? ok('no stage rows when no stages were written (0 ≠ unknown)')
    : bad('whoop stages leaked');

  // iPhone-style: inBed ONLY → in-bed row, no duration row.
  const phoneRows = sleepDailyRows([
    {
      value: 0,
      startISO: local(2026, 7, 28, 23, 0),
      endISO: local(2026, 7, 29, 7, 0),
      provenance: prov('com.apple.health.Y', 'iPhone16,2'),
    },
  ]);
  phoneRows.length === 1 && phoneRows[0].metricType === 'sleep_in_bed_min'
    ? ok('inBed-only writer: time in bed recorded, sleep duration withheld')
    : bad('inBed-only', JSON.stringify(phoneRows.map((r) => r.metricType)));

  // Two devices, same night → independent rows per device.
  const dual = sleepDailyRows([
    ...samples,
    {
      value: 1,
      startISO: local(2026, 7, 28, 23, 5),
      endISO: local(2026, 7, 29, 6, 50),
      provenance: prov('com.ouraring.oura', null, 'Oura'),
    },
  ]);
  const durations = dual.filter((r) => r.metricType === 'sleep_duration_min');
  durations.length === 2 && new Set(durations.map((r) => r.sourceDevice)).size === 2
    ? ok('dual-device night → one duration row per device')
    : bad('dual device', JSON.stringify(durations));
}

console.log('4. workouts');
{
  const rows = workoutRows([
    {
      uuid: 'UUID-1',
      activityTypeRaw: 37,
      durationSec: 1800, // 30 min true duration…
      startISO: local(2026, 7, 29, 17, 0),
      endISO: local(2026, 7, 29, 17, 40), // …inside a 40-min span (paused 10m)
      kcal: 320,
      distanceKm: 5.2,
      provenance: prov('com.garmin.connect.mobile', null, 'Garmin Connect'),
    },
  ]);
  rows.length === 1 && rows[0].value === 30
    ? ok('duration = HK duration (30m), not end−start (40m)')
    : bad('duration', rows[0]?.value);
  rows[0].sourceRawId === 'UUID-1'
    ? ok('raw id = HK sample uuid')
    : bad('uuid', rows[0]?.sourceRawId);
  rows[0].metadata.activity === 'Running' && rows[0].metadata.kcal === 320
    ? ok('metadata: activity name + kcal')
    : bad('workout metadata', JSON.stringify(rows[0]?.metadata));
  workoutActivityName(9999) === 'Workout (type 9999)'
    ? ok('unknown activity type degrades readably')
    : bad('unknown activity');
  workoutRows([
    {
      uuid: '',
      activityTypeRaw: 37,
      durationSec: 60,
      startISO: local(2026, 7, 29, 8, 0),
      endISO: local(2026, 7, 29, 8, 1),
      kcal: null,
      distanceKm: null,
      provenance: prov(null),
    },
  ]).length === 0
    ? ok('empty uuid dropped')
    : bad('empty uuid kept');
}

console.log('5. sync window maths');
{
  const now = new Date(2026, 6, 29, 15, 30);
  const days = syncDayWindows(now, 14);
  days.length === 14 ? ok('14 day buckets') : bad('window length', days.length);
  days[13].date === '2026-07-29' && days[0].date === '2026-07-16'
    ? ok('oldest→today ordering (07-16 … 07-29)')
    : bad('window dates', `${days[0].date}…${days[13].date}`);
  days[13].start.getHours() === 0 && days[13].end.getDate() === 30
    ? ok('buckets are local midnight → next local midnight')
    : bad('bucket bounds');
  const span = sampleQuerySpan(now, 14);
  span.start.getHours() === 12 && localDayOf(span.start.toISOString()) === '2026-07-15'
    ? ok('sample span starts at noon before the window (sleep coverage)')
    : bad('span start', span.start.toISOString());

  shouldAutoSync(null, now) ? ok('never-synced → sync') : bad('first sync gate');
  !shouldAutoSync(new Date(2026, 6, 29, 15, 20).toISOString(), now)
    ? ok('10 min ago → throttled')
    : bad('throttle');
  shouldAutoSync(new Date(2026, 6, 29, 15, 10).toISOString(), now)
    ? ok('20 min ago → syncs')
    : bad('throttle expiry');
  shouldAutoSync('garbage', now) ? ok('corrupt timestamp → sync (self-heal)') : bad('corrupt ts');
}

console.log('5b. window clamping — the boundary day must never be rewritten partially');
{
  // The sample span starts at NOON of the day before the window, so the mappers
  // legitimately produce rows for that out-of-window day built from afternoon
  // samples only. Those must be dropped, or they overwrite the complete rows
  // stored while that day was in-window (silent, permanent history corruption).
  const now = new Date(2026, 6, 29, 15, 30);
  const days = syncDayWindows(now, 14); // 2026-07-16 … 2026-07-29
  const rows = [
    { date: '2026-07-15', metricType: 'hrv', value: 34, sourceRawId: 'hk:hrv:2026-07-15' },
    { date: '2026-07-16', metricType: 'hrv', value: 48, sourceRawId: 'hk:hrv:2026-07-16' },
    { date: '2026-07-29', metricType: 'hrv', value: 42, sourceRawId: 'hk:hrv:2026-07-29' },
    { date: '2026-07-30', metricType: 'hrv', value: 99, sourceRawId: 'hk:hrv:2026-07-30' },
  ];
  const kept = clampRowsToWindow(rows, days);
  // Of the four fixture rows only 07-16 and 07-29 are inside 07-16…07-29.
  kept.length === 2 && !kept.some((r) => r.date === '2026-07-15')
    ? ok('pre-window afternoon-only row dropped (no partial overwrite of aged-out days)')
    : bad('clamp start', JSON.stringify(kept.map((r) => r.date)));
  !kept.some((r) => r.date === '2026-07-30') ? ok('future-dated row dropped') : bad('clamp end');
  kept.some((r) => r.date === '2026-07-16') && kept.some((r) => r.date === '2026-07-29')
    ? ok('both window edges kept')
    : bad('clamp edges', JSON.stringify(kept.map((r) => r.date)));
  clampRowsToWindow(rows, []).length === 0 ? ok('empty window keeps nothing') : bad('empty window');

  // A sleep session that STARTS before the window but WAKES inside it is
  // attributed to the wake day, so the clamp must not discard it — that night
  // is exactly why the span reaches back to noon.
  const watch = prov('com.apple.health.X', 'Watch7,1', 'Watch');
  const firstNight = sleepDailyRows([
    {
      value: 0,
      startISO: local(2026, 7, 15, 23, 10),
      endISO: local(2026, 7, 16, 6, 40),
      provenance: watch,
    },
    {
      value: 3,
      startISO: local(2026, 7, 15, 23, 20),
      endISO: local(2026, 7, 16, 6, 30),
      provenance: watch,
    },
  ]);
  clampRowsToWindow(firstNight, days).some((r) => r.metricType === 'sleep_duration_min')
    ? ok("the window's first night survives the clamp (wake day is in-window)")
    : bad('first night dropped');
}

console.log('5c. window sizing — gaps are covered, backfill is not burned');
{
  const now = new Date(2026, 6, 29, 12, 0);
  syncWindowDays({ lastSyncedAt: null, firstSyncedAt: null }, now) === FIRST_SYNC_DAYS
    ? ok('never synced → 90-day backfill')
    : bad('first sync window');
  // A pass that wrote nothing leaves firstSyncedAt null, so the backfill is
  // still armed — the deny-then-grant permission flow.
  syncWindowDays(
    { lastSyncedAt: new Date(2026, 6, 29, 11, 0).toISOString(), firstSyncedAt: null },
    now
  ) === FIRST_SYNC_DAYS
    ? ok('synced but never landed data → backfill still armed')
    : bad('backfill burned');
  syncWindowDays(
    {
      lastSyncedAt: new Date(2026, 6, 29, 8, 0).toISOString(),
      firstSyncedAt: '2026-05-01T00:00:00.000Z',
    },
    now
  ) === SYNC_WINDOW_DAYS
    ? ok('synced hours ago → steady-state 14-day window')
    : bad('steady state');
  // 100 days dormant (or toggled off and back on) → the window stretches to
  // cover the gap instead of leaving a permanent hole.
  syncWindowDays(
    {
      lastSyncedAt: new Date(2026, 3, 20, 12, 0).toISOString(),
      firstSyncedAt: '2026-01-01T00:00:00.000Z',
    },
    now
  ) === 101
    ? ok('100-day gap → 101-day window (gap covered, +1 for the partial last day)')
    : bad(
        'gap window',
        syncWindowDays(
          {
            lastSyncedAt: new Date(2026, 3, 20, 12, 0).toISOString(),
            firstSyncedAt: '2026-01-01T00:00:00.000Z',
          },
          now
        )
      );
  syncWindowDays(
    { lastSyncedAt: '2020-01-01T00:00:00.000Z', firstSyncedAt: '2020-01-01T00:00:00.000Z' },
    now
  ) === MAX_SYNC_DAYS
    ? ok('years dormant → capped at 365 days')
    : bad('cap');
  syncWindowDays({ lastSyncedAt: 'garbage', firstSyncedAt: '2026-01-01T00:00:00.000Z' }, now) ===
  FIRST_SYNC_DAYS
    ? ok('corrupt cursor → re-backfill rather than guess')
    : bad('corrupt cursor');
}

console.log('5d. wire-shape parsers — fixtures matching @kingstinct v14 payloads');
{
  // Verified against the installed package: WorkoutSample.duration,
  // totalEnergyBurned and totalDistance are Quantity OBJECTS
  // ({unit, quantity}) — duration in 's', energy 'kcal', distance 'meters'
  // (ios/WorkoutProxy.swift, lib/typescript/types/Workouts.d.ts). Reading any of
  // them as a bare number returns null and silently drops the whole record.
  const revision = {
    source: { name: 'Garmin Connect', bundleIdentifier: 'com.garmin.connect.mobile' },
    productType: 'iPhone16,2',
  };
  const workoutFixture = {
    uuid: 'UUID-REAL-1',
    workoutActivityType: 37,
    duration: { unit: 's', quantity: 1800 },
    totalEnergyBurned: { unit: 'kcal', quantity: 320 },
    totalDistance: { unit: 'meters', quantity: 5200 },
    startDate: new Date(local(2026, 7, 29, 17, 0)),
    endDate: new Date(local(2026, 7, 29, 17, 40)),
    sourceRevision: revision,
  };
  const w = parseWorkoutSample(workoutFixture);
  w !== null ? ok('a real-shaped workout parses (NOT dropped)') : bad('workout dropped');
  w && w.durationSec === 1800
    ? ok('duration Quantity unwrapped to 1800 s')
    : bad('duration', JSON.stringify(w));
  w && w.kcal === 320 && w.distanceKm === 5.2
    ? ok('energy kcal + distance meters→km unwrapped')
    : bad('energy/distance', JSON.stringify(w));
  w && w.provenance.bundleId === 'com.garmin.connect.mobile'
    ? ok('provenance read off sourceRevision')
    : bad('provenance', JSON.stringify(w?.provenance));

  // toJSON() flattening (WorkoutProxy is a hybrid object).
  const proxy = { toJSON: () => workoutFixture };
  const viaProxy = parseWorkoutSample(proxy);
  viaProxy && viaProxy.durationSec === 1800
    ? ok('WorkoutProxy.toJSON() flattening handled')
    : bad('toJSON', JSON.stringify(viaProxy));

  // Unit awareness: a library switching duration to minutes must not 60× it.
  const inMinutes = parseWorkoutSample({
    ...workoutFixture,
    duration: { unit: 'min', quantity: 30 },
  });
  inMinutes && inMinutes.durationSec === 1800
    ? ok('duration in minutes converts to the same 1800 s')
    : bad('minute duration', JSON.stringify(inMinutes));

  // A bare number (the shape the code was originally written against) must not
  // be silently accepted as seconds — it isn't what the library sends.
  parseWorkoutSample({ ...workoutFixture, duration: 1800 }) === null
    ? ok('bare-number duration rejected (wrong shape fails loud, not silently)')
    : bad('bare number accepted');
  parseWorkoutSample({ ...workoutFixture, uuid: undefined }) === null
    ? ok('missing uuid → dropped')
    : bad('uuid missing kept');
  const noExtras = parseWorkoutSample({
    uuid: 'U2',
    workoutActivityType: 3000,
    duration: { unit: 's', quantity: 600 },
    startDate: new Date(local(2026, 7, 29, 8, 0)),
    endDate: new Date(local(2026, 7, 29, 8, 10)),
    sourceRevision: revision,
  });
  noExtras && noExtras.kcal === null && noExtras.distanceKm === null
    ? ok('absent energy/distance → nulls, workout still kept')
    : bad('optional quantities', JSON.stringify(noExtras));

  // QuantitySample.quantity IS a plain number (the asymmetry that caused the
  // workout bug) — pin it so a future refactor can't "fix" it the wrong way.
  const q = parseQuantitySample({
    quantity: 42.5,
    unit: 'ms',
    startDate: new Date(local(2026, 7, 29, 3, 0)),
    endDate: new Date(local(2026, 7, 29, 3, 1)),
    sourceRevision: {
      source: { name: 'Watch', bundleIdentifier: 'com.apple.health.X' },
      productType: 'Watch7,1',
    },
  });
  q && q.value === 42.5
    ? ok('QuantitySample.quantity is a plain number')
    : bad('quantity sample', JSON.stringify(q));
  parseQuantitySample({
    quantity: { unit: 'ms', quantity: 42 },
    startDate: new Date(),
    endDate: new Date(),
  }) === null
    ? ok('object-wrapped quantity rejected on the sample path')
    : bad('wrapped quantity accepted');

  const c = parseCategorySample({
    value: 3,
    startDate: new Date(local(2026, 7, 29, 1, 0)),
    endDate: new Date(local(2026, 7, 29, 2, 0)),
    sourceRevision: { source: { name: 'Oura', bundleIdentifier: 'com.ouraring.oura' } },
  });
  c && c.value === 3 && c.provenance.sourceName === 'Oura'
    ? ok('category sample (sleep stage) parses')
    : bad('category', JSON.stringify(c));

  // Statistics responses wrap the sum in a Quantity too.
  parseStatisticSum({ sumQuantity: { unit: 'count', quantity: 8123 } }) === 8123
    ? ok('statistics sumQuantity unwrapped')
    : bad('statistic sum');
  parseStatisticSum({}) === null ? ok('statistics with no sum → null') : bad('empty statistic');
  parseStatisticSum(null) === null ? ok('null statistics response → null') : bad('null statistic');
}

console.log('6. guarded seam is a safe no-op without the native module');
{
  isHealthKitSupported() === false
    ? ok('isHealthKitSupported() false under node')
    : bad('supported');
  isHealthKitAvailable() === false
    ? ok('isHealthKitAvailable() false under node')
    : bad('available');
  const granted = await requestHealthPermissions();
  granted === false ? ok('requestHealthPermissions resolves false') : bad('permissions', granted);
  const read = await readQuantitySamples(
    'HKQuantityTypeIdentifierStepCount',
    'count',
    new Date(),
    new Date()
  );
  Array.isArray(read.samples) && read.samples.length === 0
    ? ok('readQuantitySamples resolves no samples')
    : bad('samples', JSON.stringify(read));
  // An absent module is not a REFUSAL. 'refused' is reserved for "HealthKit
  // would not accept either echo-suppression predicate", which the Settings
  // screen says out loud — claiming it here would put a false alarm on a web
  // preview and on every build predating the native module.
  read.exclusion === 'none' && read.error === null
    ? ok("…reported as exclusion 'none' with no error — absent ≠ refused")
    : bad('absent-module outcome', JSON.stringify(read));
}

console.log('7. read scopes cover the spec');
{
  const want = [
    'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
    'HKQuantityTypeIdentifierRestingHeartRate',
    'HKQuantityTypeIdentifierStepCount',
    'HKQuantityTypeIdentifierActiveEnergyBurned',
    'HKQuantityTypeIdentifierBasalEnergyBurned',
    'HKQuantityTypeIdentifierRespiratoryRate',
    'HKQuantityTypeIdentifierOxygenSaturation',
    'HKQuantityTypeIdentifierBodyTemperature',
    'HKQuantityTypeIdentifierAppleSleepingWristTemperature',
    'HKQuantityTypeIdentifierVO2Max',
    'HKCategoryTypeIdentifierSleepAnalysis',
    'HKWorkoutTypeIdentifier',
    // The body channel's inbound half (2026-08-12) — weight was ZERO-way until
    // this landed: published outward, never read back, so a smart scale syncing
    // to Health never reached ARC at all.
    'HKQuantityTypeIdentifierBodyMass',
    'HKQuantityTypeIdentifierBodyFatPercentage',
    'HKQuantityTypeIdentifierWaistCircumference',
  ];
  const missing = want.filter((id) => !HEALTH_READ_IDENTIFIERS.includes(id));
  missing.length === 0 ? ok('all 15 scopes present') : bad('scopes', missing.join(','));
  dayRawId('hrv', '2026-07-29') === 'hk:hrv:2026-07-29' ? ok('dayRawId shape') : bad('dayRawId');

  // A scope ARC ASKS for but never ingests is a permission prompt with nothing
  // behind it — the user grants access to data that then silently never lands.
  // Every declared read identifier must be claimed by exactly one ingest path.
  const ingestPaths = [
    ...SAMPLE_METRICS.map((m) => m.hkIdentifier),
    ...STATISTIC_METRICS.map((m) => m.hkIdentifier),
    ...BODY_INGEST_METRICS.map((m) => m.hkIdentifier),
    'HKCategoryTypeIdentifierSleepAnalysis', // sleepDailyRows
    'HKWorkoutTypeIdentifier', // workoutRows
  ];
  const orphaned = HEALTH_READ_IDENTIFIERS.filter((id) => !ingestPaths.includes(id));
  orphaned.length === 0
    ? ok('every read scope has an ingest path — nothing is requested but dropped')
    : bad('READ SCOPE WITH NO INGEST PATH', orphaned.join(','));
  const duplicated = ingestPaths.filter((id, i) => ingestPaths.indexOf(id) !== i);
  duplicated.length === 0
    ? ok('no identifier is ingested by two paths')
    : bad('duplicate ingest', duplicated.join(','));
}

console.log('8. write scopes + the echo-loop tripwire (spec §10)');
{
  const want = [
    'HKQuantityTypeIdentifierBodyMass',
    'HKQuantityTypeIdentifierBodyFatPercentage',
    'HKQuantityTypeIdentifierWaistCircumference',
  ];
  const missingWrite = want.filter((id) => !HEALTH_WRITE_IDENTIFIERS.includes(id));
  missingWrite.length === 0 && HEALTH_WRITE_IDENTIFIERS.length === 3
    ? ok('write scopes are exactly weight / body fat / waist')
    : bad('write scopes', HEALTH_WRITE_IDENTIFIERS.join(','));

  // THE tripwire, in its second form.
  //
  // It used to assert the two scope lists were DISJOINT, on the reasoning that
  // nothing could echo while ARC read none of what it wrote. That was true and
  // is now obsolete: reading BodyMass back is the entire point of the two-way
  // link (weight was zero-way inbound), so the old assertion would have had to
  // fail or be deleted. Neither — what it was protecting is kept exactly: NO
  // TYPE MAY BE BOTH READ AND WRITTEN WITHOUT ECHO SUPPRESSION BEHIND IT.
  //
  // The overlap is therefore expected, and expected to be precisely the body
  // channel; what must be empty is the overlap NOT covered by suppression. This
  // still fires in CI for the case that matters now — a new write scope for a
  // type already read on the ordinary path, where the reader retries unfiltered
  // on a bad predicate and would re-ingest ARC's own samples.
  const overlap = readWriteScopeOverlap().slice().sort();
  overlap.length === 3 && overlap.join(',') === want.slice().sort().join(',')
    ? ok('the read/write overlap is exactly the body channel — deliberate, not accidental')
    : bad('unexpected overlap', overlap.join(','));

  const unsuppressed = unsuppressedEchoIdentifiers();
  unsuppressed.length === 0
    ? ok('every read+write type has echo suppression behind it')
    : bad('UNSUPPRESSED ECHO PATH', unsuppressed.join(','));

  // Non-circularity: the suppressed set is derived from BODY_INGEST_METRICS, so
  // it can only claim coverage the ingest path actually implements. Prove no
  // published type sneaks in through the UNsuppressed readers.
  const unsuppressedReaders = [
    ...SAMPLE_METRICS.map((m) => m.hkIdentifier),
    ...STATISTIC_METRICS.map((m) => m.hkIdentifier),
  ];
  const leaked = HEALTH_WRITE_IDENTIFIERS.filter((id) => unsuppressedReaders.includes(id));
  leaked.length === 0
    ? ok('no published type is read through the unfiltered-retry path')
    : bad('PUBLISHED TYPE ON THE UNSUPPRESSED READER', leaked.join(','));

  // Workouts and nutrition are explicitly out of scope: neither can be deleted
  // once written (no column stores a HealthKit UUID).
  const forbidden = HEALTH_WRITE_IDENTIFIERS.filter(
    (id) => id.startsWith('HKQuantityTypeIdentifierDietary') || id === 'HKWorkoutTypeIdentifier'
  );
  forbidden.length === 0
    ? ok('no workout or nutrition write scopes')
    : bad('out-of-scope write', forbidden.join(','));
}

console.log('9. body publish mapping — units are the whole job');
{
  const byColumn = (c) => BODY_PUBLISH_METRICS.find((m) => m.column === c);

  // Weight and waist are already canonical (body_metrics stores kg and cm), and
  // 'kg'/'cm' are exact HKUnit strings (MassUnit / LengthUnit).
  const weight = byColumn('weight_kg');
  weight.hkUnit === 'kg' && weight.toHealthKit(82.4) === 82.4
    ? ok("weight_kg → BodyMass in 'kg', unconverted")
    : bad('weight unit', JSON.stringify(weight));
  const waist = byColumn('waist_cm');
  waist.hkUnit === 'cm' && waist.toHealthKit(81) === 81
    ? ok("waist_cm → WaistCircumference in 'cm', unconverted")
    : bad('waist unit', JSON.stringify(waist));

  // The one that would silently corrupt a medical record: HKUnit.percent() is a
  // FRACTION 0.0–1.0, so 18.5 % must go out as 0.185, not 18.5 (which Health
  // would read as 1850 %). Same trap the read side handles for SpO2, reversed.
  const fat = byColumn('body_fat_pct');
  fat.hkUnit === '%' && Math.abs(fat.toHealthKit(18.5) - 0.185) < 1e-12
    ? ok('body_fat_pct 18.5 → 0.185 (HKUnit.percent is a fraction)')
    : bad('body fat conversion', JSON.stringify(fat.toHealthKit(18.5)));
  fat.toHealthKit(100) === 1 ? ok('body fat 100 % → 1.0') : bad('body fat ceiling');

  // One row → the samples it produces.
  const at = '2026-08-12T09:30:00.000Z';
  const all = bodySamplesFor({
    id: 'row-1',
    createdAt: '2026-08-12T09:30:00.100Z',
    measuredAt: at,
    weightKg: 82.4,
    bodyFatPct: 18.5,
    waistCm: 81,
  });
  all.length === 3
    ? ok('a row with all three columns → 3 samples')
    : bad('sample count', all.length);
  all.every((s) => s.at.toISOString() === at && s.sourceRowId === 'row-1')
    ? ok('samples carry the measurement instant and their source row id')
    : bad('sample provenance', JSON.stringify(all));

  const partial = bodySamplesFor({
    id: 'row-2',
    createdAt: at,
    measuredAt: at,
    weightKg: 82.4,
    bodyFatPct: null,
    waistCm: null,
  });
  partial.length === 1 && partial[0].hkIdentifier === 'HKQuantityTypeIdentifierBodyMass'
    ? ok('null columns publish nothing (keypad writes one at a time)')
    : bad('partial row', JSON.stringify(partial));

  // Nothing doubtful is ever sent: HealthKit does not sanity-check magnitudes.
  bodySamplesFor({
    id: 'row-3',
    createdAt: at,
    measuredAt: 'not-a-date',
    weightKg: 82.4,
    bodyFatPct: null,
    waistCm: null,
  }).length === 0
    ? ok('unparseable measured_at publishes nothing')
    : bad('bad instant');
  bodySamplesFor({
    id: 'row-4',
    createdAt: at,
    measuredAt: at,
    weightKg: Number.NaN,
    bodyFatPct: null,
    waistCm: null,
  }).length === 0
    ? ok('non-finite value publishes nothing')
    : bad('NaN value');
}

console.log('10. the write half of the guarded seam no-ops without the module');
{
  healthWriteAccess() === 'unsupported'
    ? ok("healthWriteAccess() 'unsupported' under node")
    : bad('write access', healthWriteAccess());
  const saved = await saveHealthQuantity(
    'HKQuantityTypeIdentifierBodyMass',
    'kg',
    82.4,
    new Date(),
    new Date(),
    { [ARC_WRITE_METADATA_KEY]: 'row-1' }
  );
  saved === false
    ? ok('saveHealthQuantity resolves false — a refused write is never claimed')
    : bad('save', saved);
}

console.log('11. echo suppression — who may be ingested on a type ARC also writes');
{
  // The ordinary case: a real device, attributable, not ARC.
  isIngestableSample(prov('com.withings.wiScaleNG', null, 'Withings'))
    ? ok('a real scale is ingestable')
    : bad('withings rejected');

  // ARC's own, by either kind of evidence.
  !isIngestableSample(prov(ARC_BUNDLE_ID))
    ? ok("ARC's own bundle is never re-ingested")
    : bad('arc bundle ingested');
  !isIngestableSample(prov('com.withings.wiScaleNG', null, null, true))
    ? ok('the ARCPublishedFrom tag is decisive even under a foreign bundle id')
    : bad('metadata tag ignored');

  // THE rule that is easy to get backwards: unknown source is NOT safe for a
  // type ARC writes. An unattributable BodyMass sample cannot be shown not to be
  // ARC's own reflection, and ingesting it is how the round-trip starts.
  !isIngestableSample(prov(null))
    ? ok('unknown source is REFUSED — unattributable ≠ safe on a published type')
    : bad('null bundle ingested');
  !isIngestableSample(prov(''))
    ? ok('an empty bundle id is refused too')
    : bad('empty bundle ingested');

  // The parser is where `arcWritten` comes from, so pin the wire shape: the key
  // ARC stamps is a plain metadata key on the sample, not part of sourceRevision.
  const echoed = parseQuantitySample({
    quantity: 82.4,
    startDate: new Date('2026-08-12T09:00:00.000Z'),
    endDate: new Date('2026-08-12T09:00:00.000Z'),
    sourceRevision: { source: { name: 'ARC', bundleIdentifier: ARC_BUNDLE_ID } },
    metadata: { [ARC_WRITE_METADATA_KEY]: 'body-1' },
  });
  echoed && echoed.provenance.arcWritten === true
    ? ok('parseQuantitySample lifts the ARC write tag off sample metadata')
    : bad('metadata parse', JSON.stringify(echoed));
  const foreign = parseQuantitySample({
    quantity: 82.4,
    startDate: new Date('2026-08-12T09:00:00.000Z'),
    endDate: new Date('2026-08-12T09:00:00.000Z'),
    sourceRevision: { source: { name: 'Withings', bundleIdentifier: 'com.withings.wiScaleNG' } },
    metadata: { HKWasUserEntered: false },
  });
  foreign && foreign.provenance.arcWritten === false
    ? ok('an unrelated metadata bag does not read as an ARC write')
    : bad('false positive', JSON.stringify(foreign));
  // A sample with no metadata at all must not throw or read as ARC's.
  const bare = parseQuantitySample({
    quantity: 80,
    startDate: new Date('2026-08-12T09:00:00.000Z'),
    endDate: new Date('2026-08-12T09:00:00.000Z'),
    sourceRevision: { source: { name: 'Oura', bundleIdentifier: 'com.ouraring.oura' } },
  });
  bare && bare.provenance.arcWritten === false
    ? ok('a sample with no metadata parses, tagged not-ours')
    : bad('bare sample', JSON.stringify(bare));

  ECHO_SUPPRESSED_IDENTIFIERS.length === 3 &&
  ECHO_SUPPRESSED_IDENTIFIERS.every((id) => HEALTH_WRITE_IDENTIFIERS.includes(id))
    ? ok('the suppressed set is exactly the published set')
    : bad('suppressed set', ECHO_SUPPRESSED_IDENTIFIERS.join(','));
}

console.log('12. inbound body mapping — the percent trap, in reverse');
{
  const bySpec = (c) => BODY_INGEST_METRICS.find((m) => m.column === c);
  const scale = prov('com.withings.wiScaleNG', null, 'Withings');
  const at = (iso) => ({ startISO: iso, endISO: iso, provenance: scale });

  // Inbound and outbound must stay exact inverses. Asserted as a ROUND-TRIP
  // property rather than two separate constants, so the pair cannot drift apart
  // one edit at a time — which is the only way a unit bug gets into a medical
  // record after review.
  let roundTrips = true;
  for (const out of BODY_PUBLISH_METRICS) {
    const back = BODY_INGEST_METRICS.find((m) => m.hkIdentifier === out.hkIdentifier);
    if (!back || back.column !== out.column || back.hkUnit !== out.hkUnit) {
      roundTrips = false;
      break;
    }
    for (const value of [0.1, 18.5, 82.4, 100]) {
      if (Math.abs(back.fromHealthKit(out.toHealthKit(value)) - value) > 1e-9) roundTrips = false;
    }
  }
  roundTrips
    ? ok('every published type round-trips: fromHealthKit(toHealthKit(v)) === v')
    : bad('round trip broken');

  // The trap itself, stated inbound: HKUnit.percent() is a 0.0–1.0 FRACTION, so
  // a real 18.5 % arrives as 0.185 and must be scaled UP. Storing it raw would
  // record 0.185 % body fat — small enough to pass the 0–100 CHECK and poison
  // every trend silently.
  const fat = bySpec('body_fat_pct');
  Math.abs(fat.fromHealthKit(0.185) - 18.5) < 1e-9
    ? ok('body fat 0.185 → 18.5 % on the way IN')
    : bad('inbound body fat', fat.fromHealthKit(0.185));
  bySpec('weight_kg').fromHealthKit(82.4) === 82.4 && bySpec('waist_cm').fromHealthKit(81) === 81
    ? ok('weight and waist arrive canonical — kg and cm, unconverted')
    : bad('inbound identity conversions');

  // One weigh-in reporting several columns is ONE row: HealthKit stamps them at
  // the same instant and body_metrics is a wide row, exactly like the keypad's.
  const merged = bodyIngestRows([
    { spec: bySpec('weight_kg'), samples: [{ value: 82.4, ...at('2026-08-12T07:00:00.000Z') }] },
    {
      spec: bySpec('body_fat_pct'),
      samples: [{ value: 0.185, ...at('2026-08-12T07:00:00.000Z') }],
    },
    { spec: bySpec('waist_cm'), samples: [{ value: 81, ...at('2026-08-12T08:00:00.000Z') }] },
  ]).rows;
  merged.length === 2 &&
  merged[0].measuredAt === '2026-08-12T07:00:00.000Z' &&
  merged[0].values.weight_kg === 82.4 &&
  merged[0].values.body_fat_pct === 18.5 &&
  merged[1].values.waist_cm === 81
    ? ok('samples sharing an instant merge into one row; a later instant is its own row')
    : bad('instant grouping', JSON.stringify(merged));
  merged[0].measuredAt < merged[1].measuredAt
    ? ok('rows come back oldest-first')
    : bad('row order');

  // Echo: ARC's own weight coming back must produce NOTHING.
  const echo = bodyIngestRows([
    {
      spec: bySpec('weight_kg'),
      samples: [
        {
          value: 82.4,
          startISO: '2026-08-12T07:00:00.000Z',
          endISO: '2026-08-12T07:00:00.000Z',
          provenance: prov(ARC_BUNDLE_ID),
        },
        {
          value: 82.4,
          startISO: '2026-08-12T08:00:00.000Z',
          endISO: '2026-08-12T08:00:00.000Z',
          provenance: prov('com.withings.wiScaleNG', null, null, true),
        },
        {
          value: 82.4,
          startISO: '2026-08-12T09:00:00.000Z',
          endISO: '2026-08-12T09:00:00.000Z',
          provenance: prov(null),
        },
      ],
    },
  ]);
  echo.rows.length === 0
    ? ok("ARC's own, tagged, and unattributable samples all ingest to nothing")
    : bad('echo leaked in');

  // …and the pass now says WHICH guard refused each one. This is the whole
  // point of the 2026-08-26 log: `unattributed: 1` and `arcTag: 1` are opposite
  // diagnoses — a source ARC cannot attribute versus ARC reading its own writes
  // back — and before this they were the same silent zero. Counted per guard,
  // in the order a sample meets them (docs §10, guard 3).
  {
    const t = echo.rejected['HKQuantityTypeIdentifierBodyMass'];
    t && t.arcBundle === 1 && t.arcTag === 1 && t.unattributed === 1
      ? ok('…and each refusal is counted against the guard that made it')
      : bad('rejection tally', JSON.stringify(t));
    t && t.outOfBounds === 0 && t.nonFinite === 0
      ? ok('…with the value-shape counters left at zero')
      : bad('spurious value rejections', JSON.stringify(t));
  }

  // The reason-giver and the guard are ONE decision. If they could disagree,
  // the log would describe a pipeline that is not the one running.
  {
    const cases = [
      [prov('com.withings.wiScaleNG', null, 'Withings'), null],
      [prov(ARC_BUNDLE_ID), 'arcBundle'],
      [prov('com.withings.wiScaleNG', null, null, true), 'arcTag'],
      [prov(null), 'unattributed'],
      [prov(''), 'unattributed'],
    ];
    cases.every(([p, reason]) => ingestRejectionFor(p) === reason) &&
    cases.every(([p, reason]) => isIngestableSample(p) === (reason === null))
      ? ok('ingestRejectionFor and isIngestableSample cannot disagree — one decision, two shapes')
      : bad('guard/reason drift');
  }

  // Out-of-CHECK values are dropped HERE, because body_metrics would throw on
  // the INSERT and take the whole batch with it.
  const outOfRange = bodyIngestRows([
    {
      spec: bySpec('weight_kg'),
      samples: [
        { value: 0, ...at('2026-08-12T01:00:00.000Z') }, // CHECK is weight > 0
        { value: 1000, ...at('2026-08-12T02:00:00.000Z') }, // …and < 1000
        { value: Number.NaN, ...at('2026-08-12T03:00:00.000Z') },
        { value: 82.4, ...at('2026-08-12T04:00:00.000Z') },
      ],
    },
    {
      spec: bySpec('body_fat_pct'),
      // 1.5 as a FRACTION is 150 % — above the CHECK ceiling. The bound is
      // applied to the CONVERTED value, which is the only correct place for it.
      samples: [
        { value: 1.5, ...at('2026-08-12T05:00:00.000Z') },
        { value: 1, ...at('2026-08-12T06:00:00.000Z') }, // 100 % — inclusive, kept
      ],
    },
  ]);
  outOfRange.rows.length === 2 &&
  outOfRange.rows[0].values.weight_kg === 82.4 &&
  outOfRange.rows[1].values.body_fat_pct === 100
    ? ok('values outside the body_metrics CHECK bounds are dropped, not thrown')
    : bad('bounds', JSON.stringify(outOfRange.rows));
  // Out-of-bounds and unreadable are separate counters: one says the source is
  // sending nonsense, the other says the wire shape changed. Same zero rows,
  // different investigation.
  outOfRange.rejected['HKQuantityTypeIdentifierBodyMass'].outOfBounds === 2 &&
  outOfRange.rejected['HKQuantityTypeIdentifierBodyMass'].nonFinite === 1 &&
  outOfRange.rejected['HKQuantityTypeIdentifierBodyFatPercentage'].outOfBounds === 1
    ? ok('…counted as outOfBounds vs nonFinite, per identifier')
    : bad('bounds tally', JSON.stringify(outOfRange.rejected));

  const empty = bodyIngestRows([]);
  empty.rows.length === 0 && Object.keys(empty.rejected).length === 0
    ? ok('no input → no rows and no tallies')
    : bad('empty input');

  // A metric that was READ but rejected nothing still gets a zeroed tally, so
  // the screen can distinguish "nothing came back" from "this metric was never
  // queried" — an absent key would render identically to a clean one.
  const clean = bodyIngestRows([{ spec: bySpec('waist_cm'), samples: [] }]);
  clean.rejected['HKQuantityTypeIdentifierWaistCircumference'] !== undefined
    ? ok('a queried metric always gets a tally, even an all-zero one')
    : bad('missing zero tally', JSON.stringify(clean.rejected));
}

console.log('13. accumulating metrics — ONE list, and it cannot quietly grow a second');
{
  // The question "is today finished?" had four answers in four files
  // (read-tools' WearableMetricSpec.accumulating, insights' WEARABLE_TRENDS and
  // BRIEF_FLOOR_METRICS, the self-review's RecoverySpec). They agreed, which is
  // the only reason nothing was visibly wrong; a metric classified accumulating
  // in one and level in another makes the Coach average a two-hour-old day into
  // one tool's answer and not the other's. There is now one declaration
  // (src/lib/health/accumulating.ts) and these are its invariants.

  // (a) A HealthKit *statistic* is a cumulative day total by construction, so
  //     adding one to the ingest pipeline must classify it with no edit
  //     anywhere else. This is the assertion that makes that true.
  const missingStats = STATISTIC_METRICS.map((s) => s.metricType).filter(
    (m) => !isAccumulatingMetric(m)
  );
  missingStats.length === 0
    ? ok(`every HealthKit statistic is accumulating (${STATISTIC_METRICS.length})`)
    : bad('a statistic is not accumulating', missingStats.join(', '));

  // (b) …and a point-in-time SAMPLE never is: an HRV reading, a resting heart
  //     rate, a VO2max estimate are each whole the moment they are written.
  const wrongSamples = SAMPLE_METRICS.map((s) => s.metricType).filter((m) =>
    isAccumulatingMetric(m)
  );
  wrongSamples.length === 0
    ? ok(`no point-in-time sample is accumulating (${SAMPLE_METRICS.length})`)
    : bad('a sample was marked accumulating', wrongSamples.join(', '));

  // (c) The exact membership, as a regression lock. Sleep is the one that has
  //     to be argued for: a night is written once against the WAKE day, so it
  //     is a whole fact, not a running total.
  const expected = ['steps', 'active_energy_kcal', 'resting_energy_kcal', 'workout', 'water_ml'];
  const actual = [...ACCUMULATING_METRIC_TYPES].sort();
  actual.join(',') === [...expected].sort().join(',')
    ? ok(`the accumulating set is exactly {${expected.join(', ')}}`)
    : bad('accumulating set drifted', actual.join(', '));
  ['sleep_duration_min', 'sleep_deep_min', 'hrv', 'rhr', 'vo2max', 'wrist_temp_c'].every(
    (m) => !isAccumulatingMetric(m)
  )
    ? ok('a night’s sleep and every level reading stay complete-on-write')
    : bad('a level metric was marked accumulating');

  // (d) The invariant that used to live in read-tools as a second rule:
  //     `accumulatesThroughDay` read `spec.agg === 'sum' || spec.accumulating`,
  //     and the `agg === 'sum'` half is TRUE — folding many rows into a day is
  //     accumulation. Deleting the disjunct is only safe if every `agg: 'sum'`
  //     spec is on the shared list, so that is asserted instead of assumed.
  const readTools = readFileSync(new URL('../src/lib/ai/tools/read-tools.ts', import.meta.url), 'utf8'); // prettier-ignore
  // Only real declarations — `\n<indent>agg: 'sum',` — so a mention of the
  // shape inside a doc comment is not read as a spec.
  const sumSpecs = [];
  for (const m of readTools.matchAll(/\n[ \t]+agg: 'sum',/g)) {
    const open = readTools.lastIndexOf("metricType: '", m.index);
    if (open < 0) continue;
    sumSpecs.push(readTools.slice(open + 13, readTools.indexOf("'", open + 13)));
  }
  sumSpecs.length >= 2 && sumSpecs.every((m) => isAccumulatingMetric(m))
    ? ok(`every agg:'sum' spec is on the list (${sumSpecs.join(', ')})`)
    : bad('an agg:sum spec is not accumulating', sumSpecs.join(', ') || 'none found');

  // (e) The drift alarm itself. The four consumers no longer carry the field —
  //     the types dropped it, so re-declaring one is a deliberate act — and a
  //     stray `accumulating:` literal in any of them means the second list is
  //     back. Cheap to check, and it is the exact failure this section exists
  //     to make impossible.
  const CONSUMERS = [
    'src/lib/ai/tools/read-tools.ts',
    'src/lib/ai/insights.ts',
    'src/lib/reports/assemble-self-review.ts',
    'src/lib/home/readiness.ts',
  ];
  const redeclared = CONSUMERS.filter((path) =>
    /\baccumulating\s*\??\s*:/.test(readFileSync(new URL('../' + path, import.meta.url), 'utf8'))
  );
  redeclared.length === 0
    ? ok(`no consumer re-declares an accumulating flag (${CONSUMERS.length} scanned)`)
    : bad('a second accumulating list is back', redeclared.join(', '));
  // The scan has to be able to fail, or "0 problems" proves nothing.
  /\baccumulating\s*\??\s*:/.test('  accumulating: true,') &&
  /\baccumulating\s*\??\s*:/.test('  accumulating?: boolean;') &&
  !/\baccumulating\s*\??\s*:/.test('const x = accumulating ? a : b;')
    ? ok('…and the scan catches both declaration shapes without firing on a ternary')
    : bad('drift scan does not scan');
}

console.log('14. echo-suppression LADDER + hybrid-object provenance (2026-08-26)');
{
  // Both fixes for the owner's "weight sync is not working in the read
  // direction". Neither branch was reachable from node before this section:
  // the ladder lived inside a function that took the native module, and the
  // provenance parser was only ever fed plain-object fixtures — which is
  // precisely the shape the library does NOT send.

  // (a) The ladder's SHAPE. Source first because it is categorical (it covers
  //     every sample ARC ever wrote, including any predating the metadata
  //     scheme); metadata second because it is a plain key predicate with no
  //     source set behind it.
  const proxy = { __isSourceProxy: true };
  const both = ownWriteExclusions(() => proxy);
  both.length === 2 &&
  both[0].kind === 'source' &&
  both[0].NOT[0].sources[0] === proxy &&
  both[1].kind === 'metadata' &&
  both[1].NOT[0].metadata.withMetadataKey === ARC_WRITE_METADATA_KEY
    ? ok('the ladder is [source, metadata] — strongest first, both present')
    : bad('ladder shape', JSON.stringify(both));

  // The metadata rung is ALWAYS present. Before the fix it appeared only when
  // `currentAppSource` was missing or threw, so the case that actually bit —
  // the API present, its PREDICATE refused — never reached it.
  [
    ['absent', ownWriteExclusions(undefined)],
    [
      'throwing',
      ownWriteExclusions(() => {
        throw new Error('no source');
      }),
    ],
    ['null-returning', ownWriteExclusions(() => null)],
  ].every(([, rungs]) => rungs.length === 1 && rungs[0].kind === 'metadata')
    ? ok('an absent, throwing or empty currentAppSource leaves the metadata rung standing alone')
    : bad('degenerate ladders');

  // (b) THE REGRESSION. HealthKit refuses the source predicate; the metadata
  //     predicate is accepted. On a PUBLISHED type this used to return nothing
  //     — one refused predicate meant no weight, forever, silently, with the
  //     narrower predicate never tried. It must now come back on rung two.
  {
    const seen = [];
    const result = await withOwnWritesExcluded(both, true, async (NOT) => {
      seen.push(NOT?.[0]?.sources ? 'source' : NOT?.[0]?.metadata ? 'metadata' : 'unfiltered');
      if (NOT?.[0]?.sources) throw new Error('predicate not supported');
      return ['a sample'];
    });
    result.value?.length === 1 &&
    result.outcome.exclusion === 'metadata' &&
    seen.join(',') === 'source,metadata'
      ? ok('a refused SOURCE predicate falls through to the metadata rung — weight still arrives')
      : bad('ladder fallthrough', JSON.stringify({ seen, ...result }));
  }

  // …and a published type still never reaches an unfiltered read. That is the
  // guarantee the ladder must not have bought its robustness with: there, the
  // unfiltered read IS the echo loop.
  {
    const seen = [];
    const result = await withOwnWritesExcluded(both, true, async (NOT) => {
      seen.push(NOT === undefined ? 'unfiltered' : 'filtered');
      throw new Error('refused');
    });
    result.value === null &&
    result.outcome.exclusion === 'refused' &&
    result.outcome.error === 'refused' &&
    !seen.includes('unfiltered')
      ? ok("failClosed exhausts the ladder to 'refused' and NEVER queries unfiltered")
      : bad('failClosed leak', JSON.stringify({ seen, ...result }));
  }

  // A read-only type does the opposite, for the opposite reason: losing the
  // filter is harmless there, losing every metric is not.
  {
    const seen = [];
    const result = await withOwnWritesExcluded(both, false, async (NOT) => {
      seen.push(NOT === undefined ? 'unfiltered' : 'filtered');
      if (NOT !== undefined) throw new Error('refused');
      return ['a sample'];
    });
    result.value?.length === 1 && result.outcome.exclusion === 'none' && seen.length === 3
      ? ok('a read-only type falls all the way through to an unfiltered query')
      : bad('read-only fallthrough', JSON.stringify({ seen, ...result }));
  }

  // The happy path must not pay for any of this: one rung, one query.
  {
    let calls = 0;
    const result = await withOwnWritesExcluded(both, true, async () => {
      calls++;
      return [];
    });
    calls === 1 && result.outcome.exclusion === 'source' && result.outcome.error === null
      ? ok('an accepted source predicate runs exactly one query and reports no error')
      : bad('happy path', JSON.stringify({ calls, ...result }));
  }

  // Error text is persisted and rendered, so it is clamped at the seam.
  {
    const result = await withOwnWritesExcluded(both, true, async () => {
      throw new Error('x'.repeat(5000));
    });
    typeof result.outcome.error === 'string' && result.outcome.error.length === 200
      ? ok('native error text is clamped to 200 chars before it can reach the KV')
      : bad('error clamp', result.outcome.error?.length);
  }

  // (c) PROVENANCE off a HYBRID object. `sourceRevision.source` is a Nitro
  //     hybrid (ios/SourceProxy.swift), and Nitro installs a hybrid's
  //     properties as getters on a shared PROTOTYPE — so the object has no own
  //     keys, does not spread, and inherits a base `name` getter of its own.
  //     Every fixture in this file until now was a plain object, which is the
  //     one shape the library never sends.
  const hybrid = (source, { toJSON, protoName } = {}) => {
    const proto = {};
    Object.defineProperty(proto, 'name', {
      get: () => protoName ?? source.name,
      configurable: true,
    });
    Object.defineProperty(proto, 'bundleIdentifier', {
      get: () => source.bundleIdentifier,
      configurable: true,
    });
    if (toJSON !== undefined) proto.toJSON = toJSON;
    return Object.create(proto);
  };
  const sampleWith = (source) =>
    parseQuantitySample({
      quantity: 82.4,
      startDate: new Date('2026-08-26T07:00:00.000Z'),
      endDate: new Date('2026-08-26T07:00:00.000Z'),
      sourceRevision: { source, productType: 'iPhone16,2' },
      metadata: {},
    });
  const garmin = { name: 'Garmin Connect', bundleIdentifier: 'com.garmin.connect.mobile' };

  {
    // Prototype-only properties, no toJSON — the direct-access fallback.
    const p = sampleWith(hybrid(garmin))?.provenance;
    p?.bundleId === garmin.bundleIdentifier && p.sourceName === garmin.name
      ? ok('a prototype-backed source parses — properties are read, not enumerated')
      : bad('hybrid direct access', JSON.stringify(p));
  }
  {
    // The library's own answer: toJSON() returns a plain Source built natively.
    const p = sampleWith(hybrid(garmin, { toJSON: () => ({ ...garmin }) }))?.provenance;
    p?.bundleId === garmin.bundleIdentifier
      ? ok('…and toJSON() is preferred when the library offers it')
      : bad('toJSON path', JSON.stringify(p));
  }
  {
    // The collision Nitro makes possible: the BASE HybridObject prototype
    // registers a `name` getter returning the hybrid's class name. toJSON()
    // comes from the HKSource itself, so it wins and the real name survives.
    const p = sampleWith(
      hybrid(garmin, { toJSON: () => ({ ...garmin }), protoName: 'SourceProxy' })
    )?.provenance;
    p?.sourceName === 'Garmin Connect'
      ? ok("…and beats a base-class `name` getter leaking the hybrid's type name")
      : bad('name collision', JSON.stringify(p));
  }
  {
    // A toJSON that throws, or answers with nothing usable, must not cost the
    // bundle id — that is what guard 3 refuses a body sample for lacking.
    const thrower = sampleWith(
      hybrid(garmin, {
        toJSON: () => {
          throw new Error('unsupported');
        },
      })
    )?.provenance;
    const useless = sampleWith(hybrid(garmin, { toJSON: () => ({ nothing: 1 }) }))?.provenance;
    thrower?.bundleId === garmin.bundleIdentifier && useless?.bundleId === garmin.bundleIdentifier
      ? ok('…and a throwing or useless toJSON falls back to the properties, keeping the bundle id')
      : bad('toJSON fallback', JSON.stringify({ thrower, useless }));
  }
  {
    // The reason all of this matters, stated as the consequence: an
    // unattributable body sample is REFUSED, so a provenance parser that
    // cannot read a hybrid empties weight rather than mis-sourcing it.
    const readable = sampleWith(hybrid(garmin));
    const unreadable = sampleWith({ notASource: true });
    isIngestableSample(readable.provenance) &&
    !isIngestableSample(unreadable.provenance) &&
    ingestRejectionFor(unreadable.provenance) === 'unattributed'
      ? ok('a readable hybrid ingests; an unreadable source is refused as unattributed')
      : bad('guard 3 consequence');
  }
}

console.log('15. the sync log — bounded, defensive, and able to name the failing step');
{
  const log = {
    at: '2026-08-26T09:00:00.000Z',
    windowDays: 14,
    rowsWritten: 3,
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
      {
        metric: 'hrv',
        label: 'hrv',
        returned: 40,
        rows: 14,
        exclusion: 'source',
        error: null,
        rejected: null,
      },
    ],
    publish: {
      armed: true,
      stalled: false,
      attempted: 0,
      succeeded: 0,
      types: [{ label: 'Weight', attempted: 0, succeeded: 0 }],
    },
  };

  // Round-trips through the KV's JSON without losing a field.
  const back = parseSyncLog(JSON.parse(JSON.stringify(log)));
  back &&
  back.at === log.at &&
  back.windowDays === 14 &&
  back.rowsWritten === 3 &&
  back.metrics.length === 2 &&
  back.metrics[0].exclusion === 'refused' &&
  back.metrics[0].error === 'predicate not supported' &&
  back.metrics[1].rejected === null &&
  back.publish.armed === true &&
  back.publish.types[0].label === 'Weight'
    ? ok('a log round-trips through JSON intact')
    : bad('round trip', JSON.stringify(back));

  // This screen is opened when something is ALREADY wrong. It must never be the
  // thing that breaks there, so anything unreadable reads as "no log".
  [null, undefined, 42, 'nope', {}, { at: 7 }, { metrics: [] }].every(
    (v) => parseSyncLog(v) === null
  )
    ? ok('garbage, and anything without a timestamp, reads as no log at all')
    : bad('defensive parse');
  {
    // A log from a future build must degrade, not throw: unknown fields are
    // dropped, unparseable entries are skipped, an unknown exclusion is 'none'.
    const future = parseSyncLog({
      at: '2026-09-01T00:00:00.000Z',
      metrics: [null, { label: 'no metric key' }, { metric: 'steps', exclusion: 'quantum' }],
      publish: { types: [{ attempted: 1 }] },
      somethingNew: { deeply: ['nested'] },
    });
    future &&
    future.metrics.length === 1 &&
    future.metrics[0].exclusion === 'none' &&
    future.metrics[0].label === 'steps' &&
    future.publish.types.length === 0 &&
    !('somethingNew' in future)
      ? ok('a log from a newer build degrades field by field instead of throwing')
      : bad('forward compat', JSON.stringify(future));
  }

  // The notes are the whole point: a zero has to say which step produced it.
  metricNote(back.metrics[0])?.startsWith('Apple Health refused both')
    ? ok("a 'refused' metric says the filters were refused, and carries the native error")
    : bad('refused note', metricNote(back.metrics[0]));
  metricNote(back.metrics[1]) === null
    ? ok('…and a metric whose counts already explain themselves gets no sentence')
    : bad('spurious note', metricNote(back.metrics[1]));
  metricNote({ ...back.metrics[1], returned: 0, rows: 0, exclusion: 'source' }) ===
  'Nothing recorded in this window.'
    ? ok('…an empty-but-healthy read says so plainly')
    : bad('empty note');
  {
    const note = metricNote({
      ...back.metrics[0],
      returned: 3,
      rows: 0,
      exclusion: 'source',
      error: null,
      rejected: { arcTag: 0, arcBundle: 0, unattributed: 3, outOfBounds: 0, nonFinite: 0 },
    });
    note === 'Skipped 3 with no readable source.'
      ? ok('…and a guard rejection names the guard, in words')
      : bad('rejection note', note);
  }

  // The armed cursor is the single most failure-LOOKING success in the app: a
  // first sync publishes nothing on purpose (docs §10, rule 1), and "0
  // published" on its own is what sent the owner looking for a bug.
  publishNote(back.publish).startsWith('Armed —')
    ? ok('an armed first pass says so, rather than reporting zero and leaving it there')
    : bad('armed note', publishNote(back.publish));
  publishNote({ ...back.publish, armed: false, stalled: true }).includes('refused a write')
    ? ok('a stalled pass says a write was refused and that it will retry')
    : bad('stalled note');
  publishNote({ ...back.publish, armed: false, attempted: 0 }) === 'Nothing new to publish.'
    ? ok('an idle pass says there was nothing to send')
    : bad('idle note');
  publishNote({ ...back.publish, armed: false, attempted: 2, succeeded: 2 }).includes('accepted')
    ? ok('a full pass says everything was accepted')
    : bad('full note');
  publishNote({ ...back.publish, armed: false, attempted: 2, succeeded: 1 }).includes('retried')
    ? ok('a partial pass says some writes were not accepted')
    : bad('partial note');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
