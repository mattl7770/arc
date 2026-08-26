/**
 * The metric registry — one descriptor per single-number metric the Log tab
 * captures. This is the single source of truth for three consumers:
 *
 *   - the keypad drill-in (`app/metric-entry.tsx`) — chips, unit, readout;
 *   - the command-field parser (`src/lib/log/parse.ts`) — keyword → metric;
 *   - the writes/reads (`src/lib/db/repositories/logs.ts`) — where each metric
 *     persists and how a stored value renders back in the feed.
 *
 * Pure and DB-free, so it's importable from both the UI and the headless tests.
 *
 * Storage is canonical (SI where there is one): weight in kg, waist in cm, water
 * in ml — matching `body_metrics.weight_kg`/`waist_cm` and keeping a future
 * lb/kg · in/cm · oz/ml unit toggle (Settings, see docs/project-status.md) a
 * display concern, never a migration. `displayUnit` is what the user sees today.
 *
 * The unit toggle is honoured through {@link resolveDisplay}: given a metric and
 * the user's {@link UnitPreferences}, it returns a preference-aware
 * {@link DisplaySpec} (unit label, decimals, canonical↔display converters). The
 * type-only import keeps this module pure and DB-free (types erase at build).
 */
import type { UnitPreferences } from '@/lib/user/types';

export type MetricKey = 'weight' | 'body_fat' | 'waist' | 'hrv' | 'rhr' | 'water' | 'dose';

/** Where a metric's value lands, and how it's shaped there. */
export type MetricTarget =
  | { kind: 'body'; column: 'weight_kg' | 'body_fat_pct' | 'waist_cm' }
  | { kind: 'wearable'; metricType: string; canonicalUnit: string }
  /** No dedicated table — stored as a `log_entries` row of type 'metric'. */
  | { kind: 'generic' };

export type MetricDescriptor = {
  key: MetricKey;
  label: string;
  /** The unit shown to the user today (pre unit-switching). */
  displayUnit: string;
  /** Decimals to render in the feed / recent summary. */
  decimals: number;
  /** Display value → canonical (stored) value. */
  toCanonical: (display: number) => number;
  /** Canonical (stored) value → display value. */
  fromCanonical: (canonical: number) => number;
  target: MetricTarget;
  /**
   * Lowercase keywords the command parser matches ("weight 178", "log hrv 48").
   * Empty for metrics with no unambiguous word (none here).
   */
  keywords: string[];
  /**
   * Explicit unit tokens the parser accepts in free text, each mapping the typed
   * number straight to canonical (e.g. "180 lb" and "82 kg" both land in kg).
   */
  units?: Record<string, (value: number) => number>;
  /**
   * The subset of unit tokens strong enough to *imply* this metric with no
   * keyword ("180 lb" → weight, "48 bpm" → RHR). Deliberately narrow: only
   * units that are unambiguous in this app's domain. Food weight is logged in
   * oz/g, so `oz`/`ml` do NOT imply water, and `mg` alone does not imply a dose
   * — those require their keyword so a note isn't misread as a measurement.
   */
  inferUnits?: string[];
};

// Exact-ish conversion factors (enough precision that a 1-dp round-trip is stable).
const LB_PER_KG = 2.2046226218;
const ML_PER_OZ = 29.5735295625;
const CM_PER_IN = 2.54;

const id = (v: number) => v;

export const METRICS: MetricDescriptor[] = [
  {
    key: 'weight',
    label: 'Weight',
    displayUnit: 'lb',
    decimals: 1,
    toCanonical: (lb) => lb / LB_PER_KG,
    fromCanonical: (kg) => kg * LB_PER_KG,
    target: { kind: 'body', column: 'weight_kg' },
    keywords: ['weight', 'weigh', 'bw'],
    units: { lb: (v) => v / LB_PER_KG, lbs: (v) => v / LB_PER_KG, kg: id, kgs: id },
    inferUnits: ['lb', 'lbs', 'kg', 'kgs'],
  },
  {
    key: 'water',
    label: 'Water',
    displayUnit: 'oz',
    decimals: 0,
    toCanonical: (oz) => oz * ML_PER_OZ,
    fromCanonical: (ml) => ml / ML_PER_OZ,
    target: { kind: 'wearable', metricType: 'water_ml', canonicalUnit: 'ml' },
    keywords: ['water', 'h2o'],
    units: {
      oz: (v) => v * ML_PER_OZ,
      ounces: (v) => v * ML_PER_OZ,
      ml: id,
      l: (v) => v * 1000,
      liter: (v) => v * 1000,
      liters: (v) => v * 1000,
      litre: (v) => v * 1000,
      litres: (v) => v * 1000,
    },
  },
  {
    key: 'body_fat',
    label: 'Body-fat',
    displayUnit: '%',
    decimals: 1,
    toCanonical: id,
    fromCanonical: id,
    target: { kind: 'body', column: 'body_fat_pct' },
    keywords: ['bodyfat', 'body-fat', 'body fat', 'bf'],
  },
  {
    key: 'waist',
    label: 'Waist',
    displayUnit: 'in',
    decimals: 1,
    toCanonical: (inches) => inches * CM_PER_IN,
    fromCanonical: (cm) => cm / CM_PER_IN,
    target: { kind: 'body', column: 'waist_cm' },
    keywords: ['waist'],
    units: {
      in: (v) => v * CM_PER_IN,
      inch: (v) => v * CM_PER_IN,
      inches: (v) => v * CM_PER_IN,
      cm: id,
    },
  },
  {
    key: 'hrv',
    label: 'HRV',
    displayUnit: 'ms',
    decimals: 0,
    toCanonical: id,
    fromCanonical: id,
    target: { kind: 'wearable', metricType: 'hrv', canonicalUnit: 'ms' },
    keywords: ['hrv'],
    units: { ms: id },
    inferUnits: ['ms'],
  },
  {
    key: 'rhr',
    label: 'Resting HR',
    displayUnit: 'bpm',
    decimals: 0,
    toCanonical: id,
    fromCanonical: id,
    target: { kind: 'wearable', metricType: 'rhr', canonicalUnit: 'bpm' },
    keywords: ['rhr', 'resting'],
    units: { bpm: id },
    inferUnits: ['bpm'],
  },
  {
    key: 'dose',
    label: 'Dose',
    displayUnit: 'mg',
    decimals: 0,
    toCanonical: id,
    fromCanonical: id,
    target: { kind: 'generic' },
    keywords: ['dose'],
    units: { mg: id },
  },
];

const BY_KEY = new Map<MetricKey, MetricDescriptor>(METRICS.map((m) => [m.key, m]));
const BY_WEARABLE = new Map<string, MetricDescriptor>(
  METRICS.filter((m) => m.target.kind === 'wearable').map((m) => [
    (m.target as { metricType: string }).metricType,
    m,
  ])
);
const BY_BODY_COLUMN = new Map<string, MetricDescriptor>(
  METRICS.filter((m) => m.target.kind === 'body').map((m) => [
    (m.target as { column: string }).column,
    m,
  ])
);

export function metricByKey(key: string): MetricDescriptor | undefined {
  return BY_KEY.get(key as MetricKey);
}

export function metricByWearableType(metricType: string): MetricDescriptor | undefined {
  return BY_WEARABLE.get(metricType);
}

export function metricByBodyColumn(column: string): MetricDescriptor | undefined {
  return BY_BODY_COLUMN.get(column);
}

/** "178.2 lb", "48 ms" — a canonical stored value rendered for display. */
export function formatCanonical(metric: MetricDescriptor, canonical: number): string {
  const display = metric.fromCanonical(canonical);
  return `${display.toFixed(metric.decimals)} ${metric.displayUnit}`;
}

/** Round a display number to the metric's precision (drops a trailing ".0" etc.). */
export function roundDisplay(metric: MetricDescriptor, display: number): number {
  const factor = 10 ** metric.decimals;
  return Math.round(display * factor) / factor;
}

/**
 * True if a canonical value can be stored without tripping a `body_metrics`
 * CHECK constraint (0001_init.sql): every metric must be a finite positive
 * number, and the body columns carry upper bounds. This is the guard the write
 * path uses so an out-of-range keypad/parsed value fails soft (disabled button /
 * saved as a note) instead of throwing an uncaught constraint error out of a tap
 * handler. Keep in lockstep with the schema's body-metric CHECKs.
 */
export function isLoggableCanonical(metric: MetricDescriptor, canonical: number): boolean {
  if (!Number.isFinite(canonical) || canonical <= 0) return false;
  if (metric.target.kind === 'body') {
    switch (metric.target.column) {
      case 'body_fat_pct':
        return canonical <= 100;
      case 'weight_kg':
        return canonical < 1000;
      case 'waist_cm':
        return canonical < 10000;
    }
  }
  return true;
}

/**
 * A preference-aware display contract for a metric: the unit label to show, how
 * many decimals to render, and the converters between the CANONICAL stored value
 * (kg/cm/ml) and that display unit. This is what lets the lb↔kg · in↔cm · oz↔ml
 * toggle stay a pure render concern — storage never changes, only this spec does.
 */
export type DisplaySpec = {
  unit: string;
  decimals: number;
  /** Canonical (stored) value → display value. */
  fromCanonical: (canonical: number) => number;
  /** Display value → canonical (stored) value. */
  toCanonical: (display: number) => number;
};

/**
 * Resolve how a metric should render for the user's chosen units. Only the three
 * metrics with a user-facing unit choice branch — weight (lb/kg), water (oz/ml),
 * waist (in/cm); each SI branch is the identity map (storage IS canonical), and
 * each imperial branch reproduces the descriptor's own factors exactly, so the
 * imperial defaults render identically to the pre-toggle behaviour. Every other
 * metric (body-fat %, HRV ms, RHR bpm, dose mg) has no unit preference and falls
 * through to its own fixed unit and converters.
 */
export function resolveDisplay(metric: MetricDescriptor, units: UnitPreferences): DisplaySpec {
  switch (metric.key) {
    case 'weight':
      return units.weight === 'kg'
        ? { unit: 'kg', decimals: 1, fromCanonical: id, toCanonical: id }
        : {
            unit: 'lb',
            decimals: 1,
            fromCanonical: (kg) => kg * LB_PER_KG,
            toCanonical: (lb) => lb / LB_PER_KG,
          };
    case 'water':
      return units.volume === 'ml'
        ? { unit: 'ml', decimals: 0, fromCanonical: id, toCanonical: id }
        : {
            unit: 'oz',
            decimals: 0,
            fromCanonical: (ml) => ml / ML_PER_OZ,
            toCanonical: (oz) => oz * ML_PER_OZ,
          };
    case 'waist':
      return units.length === 'cm'
        ? { unit: 'cm', decimals: 1, fromCanonical: id, toCanonical: id }
        : {
            unit: 'in',
            decimals: 1,
            fromCanonical: (cm) => cm / CM_PER_IN,
            toCanonical: (inches) => inches * CM_PER_IN,
          };
    default:
      return {
        unit: metric.displayUnit,
        decimals: metric.decimals,
        fromCanonical: metric.fromCanonical,
        toCanonical: metric.toCanonical,
      };
  }
}

/** Round a display number to the spec's precision (mirrors {@link roundDisplay}). */
export function roundToSpec(spec: DisplaySpec, display: number): number {
  const factor = 10 ** spec.decimals;
  return Math.round(display * factor) / factor;
}

/** "178.2 lb", "1,893 ml" without the comma — a canonical value rendered per spec. */
export function formatMeasured(spec: DisplaySpec, canonical: number): string {
  return `${roundToSpec(spec, spec.fromCanonical(canonical)).toFixed(spec.decimals)} ${spec.unit}`;
}
