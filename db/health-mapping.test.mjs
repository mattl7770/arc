/**
 * Headless test of the PURE HealthKit → wearable_data mapping
 * (src/lib/health/mapping.ts) plus the sync window maths (sync.ts) and the
 * guarded seam's absent-module behavior. No Expo, no native module, no DB.
 * Run: npm run db:test.
 */
import {
  ARC_BUNDLE_ID,
  ARC_WRITE_METADATA_KEY,
  BODY_PUBLISH_METRICS,
  dayRawId,
  HEALTH_READ_IDENTIFIERS,
  HEALTH_WRITE_IDENTIFIERS,
  localDayOf,
  quantityDailyRows,
  readWriteScopeOverlap,
  SAMPLE_METRICS,
  sleepDailyRows,
  sourceDeviceFor,
  STATISTIC_METRICS,
  statisticDailyRows,
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
  parseCategorySample,
  parseQuantitySample,
  parseStatisticSum,
  parseWorkoutSample,
  readQuantitySamples,
  requestHealthPermissions,
  saveHealthQuantity,
} from '../src/lib/health/healthkit.ts';

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

const prov = (bundleId, productType = null, sourceName = null) => ({
  sourceName,
  bundleId,
  productType,
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
    // ECHO SUPPRESSION, second line of defence: ARC's own published samples must
    // never bucket as 'other' (priority 7 — above apple_health and manual), or
    // ARC would rank its own reflection over the merged Apple total and over the
    // user's keypad entry. 'manual' is both truthful and the priority floor.
    [prov(ARC_BUNDLE_ID), 'manual'],
    [prov(ARC_BUNDLE_ID, 'iPhone16,2', 'ARC'), 'manual'],
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
  const samples = await readQuantitySamples(
    'HKQuantityTypeIdentifierStepCount',
    'count',
    new Date(),
    new Date()
  );
  Array.isArray(samples) && samples.length === 0
    ? ok('readQuantitySamples resolves []')
    : bad('samples', JSON.stringify(samples));
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
  ];
  const missing = want.filter((id) => !HEALTH_READ_IDENTIFIERS.includes(id));
  missing.length === 0 ? ok('all 12 scopes present') : bad('scopes', missing.join(','));
  dayRawId('hrv', '2026-07-29') === 'hk:hrv:2026-07-29' ? ok('dayRawId shape') : bad('dayRawId');
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

  // THE tripwire. Nothing echoes today only because none of what ARC writes is
  // in the read set. That is a property of two lists, not of anything
  // structural, so it gets asserted rather than assumed — this is the test that
  // must fail the day someone adds BodyMass to the read scopes.
  const overlap = readWriteScopeOverlap();
  overlap.length === 0
    ? ok('read and write scopes are disjoint — no echo loop')
    : bad('READ/WRITE SCOPE OVERLAP', overlap.join(','));

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
