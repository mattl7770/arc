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
import { formatHm, isScreenTimeMinutes, SCREEN_TIME_METRIC } from '@/lib/screen-time/entry';
import type { UnitPreferences } from '@/lib/user/types';

export type MetricKey =
  'weight' | 'body_fat' | 'waist' | 'hrv' | 'rhr' | 'water' | 'dose' | 'screen_time';

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
   * Empty for a metric the generic adjacency matcher must not see: screen
   * time, whose number is a duration and whose short keyword (`st`) is a word
   * in ordinary notes, so it has its own whole-line grammar in parse.ts.
   */
  keywords: string[];
  /**
   * Minutes-valued: printed "3h 20m" wherever the registry prints it (the Log
   * feed, the keypad's line), never as a raw minute count.
   */
  duration?: boolean;
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
/** Exported since 0047: nutrition prints ml portions under the same oz/ml
 * preference as water, and one app must not carry two versions of one factor
 * (src/lib/nutrition/format.ts). */
export const ML_PER_OZ = 29.5735295625;
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
  {
    // The day's total off Settings › Screen Time, typed (2026-09-25; the plan is
    // docs/spikes/screen-time.md, what was built docs/screen-time.md). Same
    // store as HRV — a `wearable_data` row, `source_device 'manual'` — but ONE
    // row per day: logMetric hands it to recordScreenTime, which replaces
    // whatever the day held. Last in the list so the keypad's existing chips
    // keep their places.
    key: 'screen_time',
    label: 'Screen time',
    displayUnit: 'min',
    decimals: 0,
    toCanonical: id,
    fromCanonical: id,
    target: { kind: 'wearable', metricType: SCREEN_TIME_METRIC, canonicalUnit: 'min' },
    keywords: [],
    duration: true,
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

/** "178.2 lb", "48 ms", "3h 20m" — a canonical stored value rendered for display. */
export function formatCanonical(metric: MetricDescriptor, canonical: number): string {
  if (metric.duration) return formatHm(canonical);
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
  // Whole minutes, 1 to 24 hours — the same rule the repository enforces
  // (src/lib/screen-time/entry.ts `isScreenTimeMinutes`), so a "screen 30h"
  // falls back to a note instead of throwing out of the tap handler.
  if (metric.key === 'screen_time') return isScreenTimeMinutes(canonical);
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
  /**
   * The precision a value is ENTERED and computed at (the keypad, the Coach's
   * card, `roundToSpec`). What is PRINTED can be finer, see `tenthsBelow`.
   */
  decimals: number;
  /**
   * Print to the tenth below this display value and to `decimals` at or above
   * it. Only the ounce branch of water sets it ({@link OZ_TENTHS_BELOW}); every
   * other spec prints at its own fixed precision, exactly as before. Read by
   * {@link roundForDisplay} / {@link formatFigure} / {@link formatMeasured} and
   * by nothing that computes.
   */
  tenthsBelow?: number;
  /** Canonical (stored) value → display value. */
  fromCanonical: (canonical: number) => number;
  /** Display value → canonical (stored) value. */
  toCanonical: (display: number) => number;
};

/**
 * **Ounces print to the tenth below 32 oz, whole at 32 and above** — the fix for
 * the owner's device note on Garmin water, *"units are heavily rounded"*
 * (2026-09-21; the numbers are docs/wearables-subapp.md §21).
 *
 * The rounding was ARC's, not Garmin's and not HealthKit's. The water spec
 * printed WHOLE ounces, and did so twice over (`decimals: 0` here, then
 * `Math.round` again in the water screen's own formatter). A capture typed in
 * ounces round-trips exactly, so nobody saw it on those. A Garmin bucket
 * arrives in millilitres and lands between ounces: 250 mL, a metric cup, printed
 * as "8 oz" (8.45, so 5.4 % low), and 100 mL as "3 oz" (11.3 % low). Three
 * such rows then summed to 24 under a printed total of 25. Nutrition's `fmtQty`
 * has printed the same 250 mL as "8.5 oz" since 0047, so the app gave two
 * answers for one quantity under one preference.
 *
 * Why 32. A half-ounce, the most a whole-ounce figure can be off, is 14.8 mL:
 * 25 % of a 2 oz sip, 6.25 % of a glass, and under 1.6 % from 32 oz upward,
 * where a day total or a goal lives and a decimal is noise.
 */
export const OZ_TENTHS_BELOW = 32;

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
            tenthsBelow: OZ_TENTHS_BELOW,
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

/**
 * A canonical value rounded the way it is PRINTED: {@link roundToSpec}, except
 * that a spec with `tenthsBelow` keeps a tenth under that value. The number an
 * edit field is prefilled with, so the field shows what the row printed.
 */
export function roundForDisplay(spec: DisplaySpec, canonical: number): number {
  const display = spec.fromCanonical(canonical);
  if (spec.tenthsBelow === undefined) return roundToSpec(spec, display);
  // Decided on the value AS PRINTED, so 31.96 oz, which rounds to 32.0, prints
  // "32" beside its neighbours rather than "32.0".
  const tenths = Math.round(display * 10) / 10;
  return Math.abs(tenths) < spec.tenthsBelow ? tenths : roundToSpec(spec, display);
}

/** The printed digits: fixed at `decimals`, or trimmed (no trailing ".0") for tenths. */
function figureText(spec: DisplaySpec, n: number): string {
  return spec.tenthsBelow === undefined ? n.toFixed(spec.decimals) : String(n);
}

/**
 * The figure ONE water row prints, number only, with the thousands comma:
 * "1,893" · "16.9" · "16". **Every surface that prints a volume calls this**:
 * the water screen, the Log tab's `usually` note and the Data tab's *Intake
 * today*. That is what makes them agree about the same row; before 2026-09-21
 * each rounded for itself.
 *
 * A spec with `tenthsBelow` drops a trailing ".0", following nutrition's
 * `fmtQty`: a typed 16 oz reads "16", exactly as typed, and a metric 500 mL
 * reads "16.9". The grouping is hand-rolled because Hermes has no `Intl`.
 */
export function formatFigure(spec: DisplaySpec, canonical: number): string {
  const [whole, frac] = figureText(spec, roundForDisplay(spec, canonical)).split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac === undefined ? grouped : `${grouped}.${frac}`;
}

/** "178.2 lb", "1893 ml" without the comma, "16.9 oz": a canonical value rendered per spec. */
export function formatMeasured(spec: DisplaySpec, canonical: number): string {
  return `${figureText(spec, roundForDisplay(spec, canonical))} ${spec.unit}`;
}
