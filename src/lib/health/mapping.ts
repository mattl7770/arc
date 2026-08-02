/**
 * PURE HealthKit → `wearable_data` mapping (docs/wearables-subapp.md §3–4).
 *
 * Everything here is deterministic over plain inputs — no native module, no DB,
 * no clock — so db/health-mapping.test.mjs exercises the whole ingest brain
 * headless. The impure reader (`healthkit.ts`) produces the sample shapes in
 * `types.ts`; this module turns them into {@link WearableUpsert} rows with:
 *
 *   - source bucketing (bundle id + productType → the source_device enum);
 *   - day bucketing in LOCAL time (a reading belongs to the wall-clock day);
 *   - per-metric aggregation (mean/last), with SpO2's fraction→percent fix;
 *   - sleep sessionisation: noon-to-noon window, gap-split sessions, longest
 *     session wins, stages summed by category value, attributed to the WAKE day;
 *   - deterministic `source_raw_id`s so re-syncs UPDATE instead of duplicate.
 */
import type { WearableUpsert } from '@/lib/db/repositories/wearables';
import type { WearableDevice } from '@/lib/db/types';

import type {
  HealthCategorySample,
  HealthDailyStatistic,
  HealthProvenance,
  HealthQuantitySample,
  HealthWorkoutSample,
} from './types';

// --- Source bucketing ---------------------------------------------------------

/** Known vendor app bundle ids → ARC's source_device vocabulary (spec §4). */
const VENDOR_BUNDLES: readonly { prefix: string; device: WearableDevice }[] = [
  { prefix: 'com.ouraring.oura', device: 'oura' },
  { prefix: 'com.whoop.', device: 'whoop' },
  { prefix: 'com.garmin.connect', device: 'garmin' },
  { prefix: 'com.ultrahuman.', device: 'ultrahuman' },
  { prefix: 'com.withings.', device: 'withings' },
  { prefix: 'com.eightsleep.', device: 'eight_sleep' },
];

/**
 * Bucket a sample's provenance into `source_device`. Apple system data all sits
 * under the com.apple.health umbrella, so Watch vs iPhone is discriminated on
 * productType; a bare `com.apple.Health` bundle is the Health app itself — a
 * manual entry. Unknown vendors land in 'other' with the raw identity preserved
 * in row metadata, so extending the table above is never a data migration.
 */
export function sourceDeviceFor(provenance: HealthProvenance): WearableDevice {
  const bundle = provenance.bundleId ?? '';
  for (const vendor of VENDOR_BUNDLES) {
    if (bundle.startsWith(vendor.prefix)) return vendor.device;
  }
  const lower = bundle.toLowerCase();
  if (lower.startsWith('com.apple.health')) {
    // The suffix-less Health app bundle is user manual entry; device recordings
    // carry a device-scoped suffix (com.apple.health.<UUID>).
    if (bundle === 'com.apple.Health') return 'manual';
    if ((provenance.productType ?? '').startsWith('Watch')) return 'apple_watch';
    return 'other';
  }
  return 'other';
}

// --- Local-day helpers ----------------------------------------------------------

/** ISO instant → the LOCAL calendar day it falls on (device wall clock). */
export function localDayOf(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Minutes between two ISO instants, floored at 0. */
function minutesBetween(startISO: string, endISO: string): number {
  const ms = new Date(endISO).getTime() - new Date(startISO).getTime();
  return ms > 0 ? ms / 60_000 : 0;
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/** The deterministic re-sync key for a day-bucket row (spec §4). */
export function dayRawId(metricType: string, date: string): string {
  return `hk:${metricType}:${date}`;
}

// --- Quantity-sample metrics ----------------------------------------------------

/** How one sampled HealthKit quantity becomes a daily ARC metric. */
export type SampleMetricSpec = {
  metricType: string;
  /** Full HK identifier, e.g. 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN'. */
  hkIdentifier: string;
  /** HKUnit string the reader requests, e.g. 'ms', 'count/min', '%', 'degC'. */
  hkUnit: string;
  /** ARC canonical unit label stored in wearable_data.unit. */
  unit: string;
  /** Daily aggregation: mean of the day's samples, or the last one (RHR — the
   * Watch replaces earlier same-day estimates; VO2max — sparse "as-of" data). */
  aggregate: 'mean' | 'last';
  /** Per-sample value fix-up (SpO2 arrives as a 0–1 fraction). */
  transform?: (value: number) => number;
  decimals: number;
  /** Which end of the sample names its local day. Overnight aggregates
   * (wrist temperature) belong to the morning they end on. */
  attributeBy: 'start' | 'end';
};

export const SAMPLE_METRICS: readonly SampleMetricSpec[] = [
  {
    metricType: 'hrv',
    hkIdentifier: 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
    hkUnit: 'ms',
    unit: 'ms',
    aggregate: 'mean',
    decimals: 1,
    attributeBy: 'start',
  },
  {
    metricType: 'rhr',
    hkIdentifier: 'HKQuantityTypeIdentifierRestingHeartRate',
    hkUnit: 'count/min',
    unit: 'bpm',
    aggregate: 'last',
    decimals: 0,
    attributeBy: 'start',
  },
  {
    metricType: 'respiratory_rate',
    hkIdentifier: 'HKQuantityTypeIdentifierRespiratoryRate',
    hkUnit: 'count/min',
    unit: 'brpm',
    aggregate: 'mean',
    decimals: 1,
    attributeBy: 'start',
  },
  {
    metricType: 'spo2_pct',
    hkIdentifier: 'HKQuantityTypeIdentifierOxygenSaturation',
    hkUnit: '%',
    unit: 'pct',
    aggregate: 'mean',
    // HKUnit.percent() measures 0.0–1.0; ARC stores human-readable 0–100.
    transform: (v) => v * 100,
    decimals: 1,
    attributeBy: 'start',
  },
  {
    metricType: 'body_temp_c',
    hkIdentifier: 'HKQuantityTypeIdentifierBodyTemperature',
    hkUnit: 'degC',
    unit: 'c',
    aggregate: 'mean',
    decimals: 2,
    attributeBy: 'start',
  },
  {
    metricType: 'wrist_temp_c',
    hkIdentifier: 'HKQuantityTypeIdentifierAppleSleepingWristTemperature',
    hkUnit: 'degC',
    unit: 'c',
    aggregate: 'mean',
    decimals: 2,
    // The nightly sample spans the night; it belongs to the wake morning.
    attributeBy: 'end',
  },
  {
    metricType: 'vo2max',
    hkIdentifier: 'HKQuantityTypeIdentifierVO2Max',
    // Parenthesised on purpose: HKUnit's string grammar reads ml/kg*min
    // left-to-right as (ml/kg)·min — the wrong dimension.
    hkUnit: 'ml/(kg*min)',
    unit: 'ml_kg_min',
    aggregate: 'last',
    decimals: 2,
    attributeBy: 'start',
  },
];

/**
 * Bucket one metric's samples into per-(local day, source device) rows.
 * Multi-device days stay separate rows — the read side arbitrates (spec §6);
 * the composite unique (source_device, hk:<metric>:<date>) keeps them apart.
 */
export function quantityDailyRows(
  spec: SampleMetricSpec,
  samples: HealthQuantitySample[]
): WearableUpsert[] {
  type Bucket = {
    device: WearableDevice;
    date: string;
    values: number[];
    lastEnd: string;
    lastValue: number;
    sources: Set<string>;
  };
  const buckets = new Map<string, Bucket>();

  for (const sample of samples) {
    if (!Number.isFinite(sample.value)) continue;
    const value = spec.transform ? spec.transform(sample.value) : sample.value;
    const date = localDayOf(spec.attributeBy === 'end' ? sample.endISO : sample.startISO);
    const device = sourceDeviceFor(sample.provenance);
    const key = `${device}|${date}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { device, date, values: [], lastEnd: '', lastValue: value, sources: new Set() };
      buckets.set(key, bucket);
    }
    bucket.values.push(value);
    if (sample.endISO >= bucket.lastEnd) {
      bucket.lastEnd = sample.endISO;
      bucket.lastValue = value;
    }
    if (sample.provenance.sourceName) bucket.sources.add(sample.provenance.sourceName);
  }

  return [...buckets.values()].map((bucket) => {
    const value =
      spec.aggregate === 'last'
        ? bucket.lastValue
        : bucket.values.reduce((a, b) => a + b, 0) / bucket.values.length;
    return {
      date: bucket.date,
      metricType: spec.metricType,
      value: round(value, spec.decimals),
      unit: spec.unit,
      sourceDevice: bucket.device,
      sourceRawId: dayRawId(spec.metricType, bucket.date),
      startTime: null,
      endTime: null,
      metadata: { hk: { samples: bucket.values.length, sources: [...bucket.sources].sort() } },
    };
  });
}

// --- Cumulative (HealthKit-merged) metrics ---------------------------------------

/** Cumulative metrics ride HealthKit's own merged daily statistics (spec §3). */
export type StatisticMetricSpec = {
  metricType: string;
  hkIdentifier: string;
  hkUnit: string;
  unit: string;
  decimals: number;
};

export const STATISTIC_METRICS: readonly StatisticMetricSpec[] = [
  {
    metricType: 'steps',
    hkIdentifier: 'HKQuantityTypeIdentifierStepCount',
    hkUnit: 'count',
    unit: 'count',
    decimals: 0,
  },
  {
    metricType: 'active_energy_kcal',
    hkIdentifier: 'HKQuantityTypeIdentifierActiveEnergyBurned',
    hkUnit: 'kcal',
    unit: 'kcal',
    decimals: 0,
  },
  {
    metricType: 'resting_energy_kcal',
    hkIdentifier: 'HKQuantityTypeIdentifierBasalEnergyBurned',
    hkUnit: 'kcal',
    unit: 'kcal',
    decimals: 0,
  },
];

/**
 * Merged daily statistics → rows labelled 'apple_health' (no single device
 * exists for a merged total by design). Zero-value days are skipped — HealthKit
 * reports 0 for days with no data, and a row saying "0 steps" would be a claim,
 * not an absence.
 */
export function statisticDailyRows(
  spec: StatisticMetricSpec,
  stats: HealthDailyStatistic[]
): WearableUpsert[] {
  return stats
    .filter((s) => Number.isFinite(s.value) && s.value > 0)
    .map((s) => ({
      date: s.date,
      metricType: spec.metricType,
      value: round(s.value, spec.decimals),
      unit: spec.unit,
      sourceDevice: 'apple_health' as const,
      sourceRawId: dayRawId(spec.metricType, s.date),
      startTime: null,
      endTime: null,
      metadata: { hk: { merged: true } },
    }));
}

// --- Sleep ------------------------------------------------------------------------

/** HKCategoryValueSleepAnalysis raw values (iOS 16+; verified against the SDK). */
export const SLEEP_VALUE = {
  inBed: 0,
  asleepUnspecified: 1,
  awake: 2,
  asleepCore: 3,
  asleepDeep: 4,
  asleepREM: 5,
} as const;

const ASLEEP_VALUES = new Set<number>([1, 3, 4, 5]);

/** Gap between samples that splits two sleep sessions (spec §3). */
const SESSION_GAP_MIN = 60;

type SleepSession = {
  device: WearableDevice;
  startISO: string;
  endISO: string;
  /** Minutes by category value. */
  byValue: Map<number, number>;
  sources: Set<string>;
};

/**
 * Sleep samples → per-(wake day, source device) rows. Per device bucket:
 * sort, split into sessions on >60 min gaps, attribute each session to the
 * LOCAL day it ends on (the wake day), and keep the longest session per day.
 * Asleep duration sums values {1,3,4,5} only — `inBed` (0) SPANS the stage
 * samples, so summing everything would double-count the night. Stage rows are
 * emitted only when the source actually wrote stages (WHOOP doesn't; for an
 * inBed-only writer even the duration row is withheld — time in bed is not
 * time asleep, and 0 ≠ unknown).
 */
export function sleepDailyRows(samples: HealthCategorySample[]): WearableUpsert[] {
  // Bucket samples per source device first — two writers describe two nights.
  const byDevice = new Map<WearableDevice, HealthCategorySample[]>();
  for (const sample of samples) {
    if (!Number.isFinite(sample.value)) continue;
    const device = sourceDeviceFor(sample.provenance);
    const list = byDevice.get(device);
    if (list) list.push(sample);
    else byDevice.set(device, [sample]);
  }

  const rows: WearableUpsert[] = [];

  for (const [device, deviceSamples] of byDevice) {
    const sorted = [...deviceSamples].sort((a, b) =>
      a.startISO < b.startISO ? -1 : a.startISO > b.startISO ? 1 : 0
    );

    // Split into sessions on coverage gaps.
    const sessions: SleepSession[] = [];
    let current: SleepSession | null = null;
    for (const sample of sorted) {
      if (current && minutesBetween(current.endISO, sample.startISO) > SESSION_GAP_MIN) {
        sessions.push(current);
        current = null;
      }
      if (!current) {
        current = {
          device,
          startISO: sample.startISO,
          endISO: sample.endISO,
          byValue: new Map(),
          sources: new Set(),
        };
      }
      const minutes = minutesBetween(sample.startISO, sample.endISO);
      current.byValue.set(sample.value, (current.byValue.get(sample.value) ?? 0) + minutes);
      if (sample.endISO > current.endISO) current.endISO = sample.endISO;
      if (sample.provenance.sourceName) current.sources.add(sample.provenance.sourceName);
    }
    if (current) sessions.push(current);

    // Longest session per wake day wins (naps lose to the main sleep).
    const asleepMin = (s: SleepSession) =>
      [...s.byValue.entries()].reduce(
        (sum, [value, min]) => (ASLEEP_VALUES.has(value) ? sum + min : sum),
        0
      );
    const byWakeDay = new Map<string, SleepSession>();
    for (const session of sessions) {
      const wakeDay = localDayOf(session.endISO);
      const best = byWakeDay.get(wakeDay);
      if (!best || asleepMin(session) > asleepMin(best)) byWakeDay.set(wakeDay, session);
    }

    for (const [wakeDay, session] of byWakeDay) {
      const asleep = asleepMin(session);
      const meta = {
        hk: { sessions: sessions.length, sources: [...session.sources].sort() },
      };
      // Time-in-bed is honest to record even for inBed-only writers…
      const inBed = session.byValue.get(SLEEP_VALUE.inBed) ?? 0;
      if (inBed > 0) {
        rows.push({
          date: wakeDay,
          metricType: 'sleep_in_bed_min',
          value: round(inBed, 0),
          unit: 'min',
          sourceDevice: session.device,
          sourceRawId: dayRawId('sleep_in_bed_min', wakeDay),
          startTime: session.startISO,
          endTime: session.endISO,
          metadata: meta,
        });
      }
      // …but sleep duration exists only when something was actually asleep.
      if (asleep <= 0) continue;
      rows.push({
        date: wakeDay,
        metricType: 'sleep_duration_min',
        value: round(asleep, 0),
        unit: 'min',
        sourceDevice: session.device,
        sourceRawId: dayRawId('sleep_duration_min', wakeDay),
        startTime: session.startISO,
        endTime: session.endISO,
        metadata: meta,
      });
      // Awake minutes are MEASURED, not derived from stages — a stage-less
      // writer (WHOOP) still marks its wake periods. Emitted before the stage
      // guard below, which would otherwise `continue` past it and silently drop
      // real data; its own `awake > 0` test is what keeps 0 from being claimed.
      const awake = session.byValue.get(SLEEP_VALUE.awake) ?? 0;
      if (awake > 0) {
        rows.push({
          date: wakeDay,
          metricType: 'sleep_awake_min',
          value: round(awake, 0),
          unit: 'min',
          sourceDevice: session.device,
          sourceRawId: dayRawId('sleep_awake_min', wakeDay),
          startTime: null,
          endTime: null,
          metadata: meta,
        });
      }
      // Stage rows only when stages were written — for a stage-less writer a
      // zero would read as "no deep sleep at all", which is a finding, not a gap.
      const stages: readonly [number, string][] = [
        [SLEEP_VALUE.asleepCore, 'sleep_core_min'],
        [SLEEP_VALUE.asleepDeep, 'sleep_deep_min'],
        [SLEEP_VALUE.asleepREM, 'sleep_rem_min'],
      ];
      const hasStages = stages.some(([value]) => (session.byValue.get(value) ?? 0) > 0);
      if (!hasStages) continue;
      for (const [value, metricType] of stages) {
        rows.push({
          date: wakeDay,
          metricType,
          value: round(session.byValue.get(value) ?? 0, 0),
          unit: 'min',
          sourceDevice: session.device,
          sourceRawId: dayRawId(metricType, wakeDay),
          startTime: null,
          endTime: null,
          metadata: meta,
        });
      }
    }
  }

  return rows;
}

// --- Workouts ----------------------------------------------------------------------

/** Common HKWorkoutActivityType raw values → readable names (raw ints are the
 * stable identity; names have churned across SDK versions). */
const ACTIVITY_NAMES: Record<number, string> = {
  9: 'Climbing',
  11: 'Cross training',
  13: 'Cycling',
  16: 'Elliptical',
  20: 'Functional strength',
  24: 'Hiking',
  28: 'Martial arts',
  29: 'Mind & body',
  33: 'Prep & recovery',
  35: 'Rowing',
  37: 'Running',
  44: 'Stair climbing',
  46: 'Swimming',
  50: 'Strength training',
  52: 'Walking',
  57: 'Yoga',
  59: 'Core training',
  60: 'XC skiing',
  61: 'Downhill skiing',
  62: 'Flexibility',
  63: 'HIIT',
  64: 'Jump rope',
  66: 'Pilates',
  68: 'Stairs',
  69: 'Step training',
  73: 'Mixed cardio',
  80: 'Cooldown',
  3000: 'Other',
};

/** Readable activity label for a raw HKWorkoutActivityType value. */
export function workoutActivityName(raw: number): string {
  return ACTIVITY_NAMES[raw] ?? `Workout (type ${raw})`;
}

/**
 * Workouts → one row each: value is the true duration in MINUTES (HealthKit's
 * `duration` excludes pauses — never end−start), the raw id is the HK sample
 * UUID (real per-object identity), the date is the local day the workout ended.
 */
export function workoutRows(workouts: HealthWorkoutSample[]): WearableUpsert[] {
  return workouts
    .filter((w) => w.uuid.length > 0 && Number.isFinite(w.durationSec) && w.durationSec > 0)
    .map((w) => ({
      date: localDayOf(w.endISO),
      metricType: 'workout',
      value: round(w.durationSec / 60, 1),
      unit: 'min',
      sourceDevice: sourceDeviceFor(w.provenance),
      sourceRawId: w.uuid,
      startTime: w.startISO,
      endTime: w.endISO,
      metadata: {
        activity: workoutActivityName(w.activityTypeRaw),
        activity_type_raw: w.activityTypeRaw,
        kcal: w.kcal,
        distance_km: w.distanceKm,
        hk: { source: w.provenance.sourceName },
      },
    }));
}

// --- Read scopes ---------------------------------------------------------------------

/** Every HealthKit type ARC asks to read (docs/wearables-subapp.md §2). */
export const HEALTH_READ_IDENTIFIERS: readonly string[] = [
  ...SAMPLE_METRICS.map((m) => m.hkIdentifier),
  ...STATISTIC_METRICS.map((m) => m.hkIdentifier),
  'HKCategoryTypeIdentifierSleepAnalysis',
  'HKWorkoutTypeIdentifier',
];
