/**
 * The readable-metric catalog — every name `get_metric_series` accepts, how a
 * day of it is folded, and how a value is reported in the user's units.
 *
 * Moved out of src/lib/ai/tools/read-tools.ts unchanged (2026-10-21) so a
 * second reader can share it: the experiment readout
 * (src/lib/experiments/readout.ts) has to read a watched metric over a FIXED
 * window and arrive at exactly the numbers `get_metric_series` reports for the
 * same days. A copy of the catalog would make that agreement a coincidence;
 * one module makes it structural, and db/experiment-readout.test.mjs asserts
 * it. {@link readMetricDays} at the bottom is the only new code here.
 */
import type { Database } from '@/lib/db/database';
import { unpairedWorkoutDailyMinutes } from '@/lib/db/repositories/workout-ingest';
import { isAccumulatingMetric } from '@/lib/health/accumulating';
import { SAMPLE_METRICS, STATISTIC_METRICS } from '@/lib/health/mapping';
import { metricByKey, resolveDisplay, type MetricKey } from '@/lib/log/metrics';
import { SCREEN_TIME_METRIC } from '@/lib/screen-time/entry';
import type { UnitPreferences } from '@/lib/user/types';

import {
  bodyDailySeries,
  round1,
  wearableArbitratedSeries,
  wearableDailySeries,
  wearableMetricInventory,
  type SeriesPoint,
  type WearableMetricPresence,
} from './series';

// --- The wearable metric catalog ---------------------------------------------
//
// `wearable_data.metric_type` is deliberately free text so a new vendor metric
// is never a migration (CLAUDE.md §9). A hardcoded enum of readable metrics
// therefore rots on contact with the next ingest — which is exactly how the
// Coach ended up blind to steps, sleep, energy and VO2max while the HealthKit
// pipeline was happily writing all of them.
//
// So the readable set is built in two layers and never typed out by hand:
//
//   1. DERIVED from the ingest specs themselves (src/lib/health/mapping.ts's
//      SAMPLE_METRICS + STATISTIC_METRICS, plus the sleep rows sleepDailyRows
//      emits and the manual-log wearable targets). Add a metric to the pipeline
//      and it is readable here with no edit to this file.
//   2. DISCOVERED from the data (SELECT DISTINCT metric_type). Anything present
//      that layer 1 does not describe still becomes readable, with its unit
//      taken from the rows and `inferred: true` flagged in the output so the
//      model knows the semantics were guessed rather than declared.

type WearableAgg =
  /** One winning source per day — the rule Home and the Data tab use. */
  | 'arbitrated'
  /** Many rows a day that must be added up (sips logged, sessions logged). */
  | 'sum';

export type WearableMetricSpec = {
  metricType: string;
  label: string;
  /** The canonical unit stored in wearable_data.unit. */
  canonicalUnit: string;
  agg: WearableAgg;
  decimals: number;
  /** Minutes-valued: also rendered "7h 11m", never left as a raw minute count. */
  isDuration?: boolean;
  // NO `accumulating` FLAG HERE, deliberately. Whether a folded day is
  // FINISHED is a different axis from `agg` (which folds it), and it is
  // answered by {@link isAccumulatingMetric} — the app's one declaration, in
  // lib/health/accumulating.ts. This spec used to be one of four places each
  // holding its own copy of that answer.
  /** Dimensions the user has a Settings preference for. */
  display?: 'volume' | 'temperature';
  /** True when the spec was guessed from the rows, not declared by the pipeline. */
  inferred?: boolean;
};

/** Readable names for the pipeline's metric_types (the specs carry no label). */
const WEARABLE_LABELS: Record<string, string> = {
  hrv: 'HRV',
  rhr: 'Resting heart rate',
  respiratory_rate: 'Respiratory rate',
  spo2_pct: 'Blood oxygen',
  body_temp_c: 'Body temperature',
  wrist_temp_c: 'Sleeping wrist temperature',
  vo2max: 'VO2max',
  steps: 'Steps',
  active_energy_kcal: 'Active energy',
  resting_energy_kcal: 'Resting energy',
};

/** The sleep rows sleepDailyRows() emits, in the order a night reads. */
const SLEEP_METRICS: readonly (readonly [string, string])[] = [
  ['sleep_duration_min', 'Sleep (asleep)'],
  ['sleep_in_bed_min', 'Time in bed'],
  ['sleep_deep_min', 'Deep sleep'],
  ['sleep_rem_min', 'REM sleep'],
  ['sleep_core_min', 'Core sleep'],
  ['sleep_awake_min', 'Awake during the night'],
];

function humanize(metricType: string): string {
  const words = metricType.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function tempSpec(metricType: string): WearableMetricSpec {
  return {
    metricType,
    label: WEARABLE_LABELS[metricType] ?? humanize(metricType),
    canonicalUnit: 'c',
    agg: 'arbitrated',
    decimals: 2,
    display: 'temperature',
  };
}

/** Layer 1: everything the ingest pipeline is known to write. */
const DECLARED_WEARABLE_METRICS: readonly WearableMetricSpec[] = [
  ...SAMPLE_METRICS.map((spec): WearableMetricSpec =>
    spec.unit === 'c'
      ? tempSpec(spec.metricType)
      : {
          metricType: spec.metricType,
          label: WEARABLE_LABELS[spec.metricType] ?? humanize(spec.metricType),
          canonicalUnit: spec.unit,
          agg: 'arbitrated',
          decimals: spec.decimals,
        }
  ),
  ...STATISTIC_METRICS.map((spec): WearableMetricSpec => ({
    metricType: spec.metricType,
    label: WEARABLE_LABELS[spec.metricType] ?? humanize(spec.metricType),
    canonicalUnit: spec.unit,
    agg: 'arbitrated',
    decimals: spec.decimals,
  })),
  ...SLEEP_METRICS.map(([metricType, label]): WearableMetricSpec => ({
    metricType,
    label,
    canonicalUnit: 'min',
    agg: 'arbitrated',
    decimals: 0,
    isDuration: true,
  })),
  {
    // Many sessions a day, each its own row keyed by the HK sample UUID — this
    // one really does accumulate, unlike every day-bucketed metric above.
    //
    // The label says "not logged in ARC" because since 0054 that is literally
    // what the number is: a session PAIRED to one the owner logged is subtracted
    // here, since get_training_summary already counts it from `workouts` with
    // its sets and its kind. Before pairing existed the same hour appeared in
    // both tools and nothing could reconcile them. See `accumulatedSeries`.
    metricType: 'workout',
    label: 'Workout minutes (Apple Health, not logged in ARC)',
    canonicalUnit: 'min',
    agg: 'sum',
    decimals: 1,
    isDuration: true,
  },
  {
    // Manual capture: one row per sip logged, so the day is a sum.
    metricType: 'water_ml',
    label: 'Water',
    canonicalUnit: 'ml',
    agg: 'sum',
    decimals: 0,
    display: 'volume',
  },
  {
    // The day's total off Settings › Screen Time, typed on Log or sent by a
    // Shortcut (docs/screen-time.md). ONE row per day by construction
    // (repositories/screen-time.ts replaces), so arbitration has nothing to
    // pick between. Declared rather than left to discovery so the label says
    // what the number is — self-reported, from another app's screen — and
    // `hm` carries "3h 20m" instead of an inferred bare minute count.
    metricType: SCREEN_TIME_METRIC,
    label: 'Screen time (daily total, self-reported)',
    canonicalUnit: 'min',
    agg: 'arbitrated',
    decimals: 0,
    isDuration: true,
  },
];

/** Layer 2: declared ∪ whatever the table actually holds today. */
export function wearableCatalog(
  inventory: WearableMetricPresence[]
): Map<string, WearableMetricSpec> {
  const catalog = new Map<string, WearableMetricSpec>(
    DECLARED_WEARABLE_METRICS.map((spec) => [spec.metricType, spec])
  );
  for (const row of inventory) {
    if (catalog.has(row.metricType)) continue;
    const unit = row.unit ?? '';
    catalog.set(row.metricType, {
      metricType: row.metricType,
      label: humanize(row.metricType),
      canonicalUnit: unit,
      // Unknown cadence: arbitration can only ever under-report, summing could
      // silently double a day. Prefer the claim that cannot be inflated.
      agg: 'arbitrated',
      decimals: 2,
      isDuration: unit === 'min',
      inferred: true,
    });
  }
  return catalog;
}

/** Friendly names the model is likely to reach for → the real metric_type. */
export const METRIC_ALIASES: Record<string, string> = {
  water: 'water_ml',
  sleep: 'sleep_duration_min',
  sleep_min: 'sleep_duration_min',
  asleep: 'sleep_duration_min',
  deep_sleep: 'sleep_deep_min',
  rem_sleep: 'sleep_rem_min',
  core_sleep: 'sleep_core_min',
  time_in_bed: 'sleep_in_bed_min',
  in_bed: 'sleep_in_bed_min',
  active_energy: 'active_energy_kcal',
  active_calories: 'active_energy_kcal',
  resting_energy: 'resting_energy_kcal',
  calories_burned: 'active_energy_kcal',
  spo2: 'spo2_pct',
  oxygen_saturation: 'spo2_pct',
  body_temp: 'body_temp_c',
  wrist_temp: 'wrist_temp_c',
  vo2: 'vo2max',
  vo2_max: 'vo2max',
  workouts: 'workout',
  workout_minutes: 'workout',
  step_count: 'steps',
  heart_rate_variability: 'hrv',
  resting_heart_rate: 'rhr',
  respiration: 'respiratory_rate',
  screen_time: SCREEN_TIME_METRIC,
  screentime: SCREEN_TIME_METRIC,
};

/** Body metrics keep their own path — they live in body_metrics, not wearables. */
export const BODY_METRIC_KEYS = ['weight', 'body_fat', 'waist'] as const;

type WearableDisplaySpec = {
  unit: string;
  decimals: number;
  fromCanonical: (canonical: number) => number;
};

/**
 * How a wearable value should be reported for THIS user's Settings › Units.
 * Same contract the rest of the tool layer honours via resolveDisplay: the
 * Coach must never cite °F to a °C user, or oz to an ml user.
 */
export function wearableDisplay(
  spec: WearableMetricSpec,
  units: UnitPreferences
): WearableDisplaySpec {
  if (spec.display === 'volume') {
    const water = resolveDisplay(metricByKey('water')!, units);
    return { unit: water.unit, decimals: water.decimals, fromCanonical: water.fromCanonical };
  }
  if (spec.display === 'temperature') {
    return units.temperature === 'C'
      ? { unit: '°C', decimals: 1, fromCanonical: (c) => c }
      : { unit: '°F', decimals: 1, fromCanonical: (c) => c * 1.8 + 32 };
  }
  return {
    unit: spec.canonicalUnit,
    decimals: spec.decimals,
    fromCanonical: (v) => v,
  };
}

/** 431 → "7h 11m", 45 → "45m". Hermes has no Intl; this is hand-formatted. */
export function formatDuration(minutes: number): string {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** The one place a canonical wearable value becomes a reportable object. */
export function reportValue(
  spec: WearableMetricSpec,
  display: WearableDisplaySpec,
  canonical: number
): { value: number; unit: string; hm?: string } {
  return {
    value: roundTo(display.fromCanonical(canonical), display.decimals),
    unit: display.unit,
    ...(spec.isDuration ? { hm: formatDuration(canonical) } : {}),
  };
}

/**
 * Does today's value for this metric keep growing until midnight?
 *
 * Delegated, not decided: {@link isAccumulatingMetric} is the app's one
 * declaration (lib/health/accumulating.ts), shared with the insight trends, the
 * brief's floor line and the self-review. This used to read
 * `spec.agg === 'sum' || spec.accumulating === true`, i.e. it re-derived half
 * the answer from a flag only this file set. The `agg === 'sum'` half was true
 * and remains true — summing many rows into a day IS accumulation — so it is
 * preserved as an assertion (db/health-mapping.test.mjs §13) rather than as a
 * second rule that a new `agg: 'sum'` spec could satisfy here and nowhere else.
 */
export function accumulatesThroughDay(spec: WearableMetricSpec): boolean {
  return isAccumulatingMetric(spec.metricType);
}

/** Everything get_metric_series will accept right now, for error text + discovery. */
export function readableMetricNames(catalog: Map<string, WearableMetricSpec>): string[] {
  return [...BODY_METRIC_KEYS, ...catalog.keys()];
}

/**
 * The daily series for an ACCUMULATING wearable metric — and the one place the
 * ingested-workout de-duplication is applied.
 *
 * `workout` rows are the only metric in `wearable_data` that can describe the
 * same event as a row in another table: a session the owner logged in ARC and
 * the watch also recorded. `get_training_summary` counts that session from
 * `workouts`, where it carries sets, a kind and a duration the owner stands
 * behind, so counting the watch's copy here as well made one hour of training
 * appear in two tools with nothing able to tell (the defect migration 0054 was
 * written for). {@link unpairedWorkoutDailyMinutes} subtracts exactly the paired
 * rows and nothing else.
 *
 * It lives here — one function, every call site (today's snapshot, the series
 * tool, the experiment readout) — because a second reader that forgot the
 * subtraction would put the defect straight back.
 */
export function accumulatedSeries(
  db: Database,
  metricType: string,
  sinceDate: string,
  untilDate?: string
): SeriesPoint[] {
  return metricType === 'workout'
    ? unpairedWorkoutDailyMinutes(db, sinceDate, untilDate)
    : wearableDailySeries(db, metricType, sinceDate, 'sum', untilDate);
}

// --- A watched metric over a fixed window -------------------------------------

/**
 * The names `create_experiment` already promises are readable
 * (`READABLE_SERIES` in tools/write-tools.ts) but that `get_metric_series`'s
 * lowercase-only lookup misses. Exact keys, never a fuzzy match: a name that is
 * in neither table is reported unreadable, and the Coach says so.
 */
const WATCHED_NAME_ALIASES: Record<string, string> = {
  resting_hr: 'rhr',
  restinghr: 'rhr',
  bodyfat: 'body_fat',
  sleep_duration: 'sleep_duration_min',
  sleep_deep: 'sleep_deep_min',
};

/** One readable metric over one window, as `get_metric_series` would report those days. */
export type MetricDays = {
  /** The resolved name: a body metric key or a `wearable_data.metric_type`. */
  metric: string;
  label: string;
  /** The user's display unit (Settings › Units). */
  unit: string;
  isDuration: boolean;
  /** Today's value is a running total for this metric (lib/health/accumulating.ts). */
  accumulating: boolean;
  /** One value per day WITH data, oldest first, rounded exactly as the series tool rounds. */
  points: SeriesPoint[];
};

/**
 * A watched metric's daily values over the inclusive window `from … to`, or
 * null when no series answers to the name.
 *
 * The same reads, the same folds and the same rounding as `get_metric_series`:
 * body metrics through `bodyDailySeries` (UTC day of `measured_at`, averaged,
 * `round1` in display units), wearables through `wearableArbitratedSeries` or
 * `accumulatedSeries` and `reportValue`. Nothing is dropped here — a partial
 * today, an excluded day — because those are the caller's rules to state.
 */
export function readMetricDays(
  db: Database,
  requested: string,
  from: string,
  to: string,
  units: UnitPreferences
): MetricDays | null {
  const normal = requested
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const name = WATCHED_NAME_ALIASES[normal] ?? normal;
  if (to < from) return null;

  if ((BODY_METRIC_KEYS as readonly string[]).includes(name)) {
    const descriptor = metricByKey(name as MetricKey)!;
    const target = descriptor.target as {
      kind: 'body';
      column: 'weight_kg' | 'body_fat_pct' | 'waist_cm';
    };
    const spec = resolveDisplay(descriptor, units);
    return {
      metric: name,
      label: descriptor.label,
      unit: spec.unit,
      isDuration: false,
      accumulating: false,
      points: bodyDailySeries(db, target.column, from)
        .filter((p) => p.date <= to)
        .map((p) => ({ date: p.date, value: round1(spec.fromCanonical(p.value)) })),
    };
  }

  const metricType = METRIC_ALIASES[name] ?? name;
  const spec = wearableCatalog(wearableMetricInventory(db)).get(metricType);
  if (!spec) return null;
  const display = wearableDisplay(spec, units);
  const raw =
    spec.agg === 'sum'
      ? accumulatedSeries(db, metricType, from, to)
      : wearableArbitratedSeries(db, metricType, from, to);
  return {
    metric: metricType,
    label: spec.label,
    unit: display.unit,
    isDuration: spec.isDuration === true,
    accumulating: accumulatesThroughDay(spec),
    points: raw
      .filter((p) => p.date >= from && p.date <= to)
      .map((p) => ({ date: p.date, value: reportValue(spec, display, p.value).value })),
  };
}
