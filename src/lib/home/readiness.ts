/**
 * Readiness derivation — the seam that replaces Home's mock readiness/pillars/
 * metrics with real `wearable_data` (docs/wearables-subapp.md §6).
 *
 * PURE over the {@link Database} interface (headless-tested in
 * db/readiness.test.mjs). Deterministic, documented thresholds — no model call;
 * the Coach interprets, this derives. Evidence gates everywhere: a verdict
 * needs a ≥{@link BASELINE_MIN_DAYS}-day baseline or it is `unknown`, and every
 * missing signal renders as an honest gap ("—"), never a fake number.
 *
 * Data comes through the wearables repo's source-arbitrated day picks, so a
 * manual keypad HRV counts when it is all there is, and an Apple Watch (or a
 * future ring) wins when both exist.
 */
import type { Database } from '@/lib/db/database';
import { todayISODate } from '@/lib/db/date';
import {
  dailyMetricSeries,
  deviceLabel,
  pickDailyMetric,
  type DailyMetricPoint,
} from '@/lib/db/repositories/wearables';
import { todayTotals } from '@/lib/db/repositories/nutrition';
import type { Metric, Pillar, Readiness, SignalLevel } from '@/types/home';

/** Days of history a baseline is computed over (today excluded). */
export const BASELINE_WINDOW_DAYS = 30;
/** Minimum baseline days before any verdict — n=2 baselines are noise. */
export const BASELINE_MIN_DAYS = 5;

export type ReadinessView = {
  readiness: Readiness;
  pillars: Pillar[];
  metrics: Metric[];
  /** False when not a single wearable signal exists — Home's first-run state. */
  hasSignal: boolean;
};

const LEVEL_ORDER: SignalLevel[] = ['optimal', 'good', 'caution', 'poor'];

function worse(a: SignalLevel, b: SignalLevel): SignalLevel {
  if (a === 'unknown') return b;
  if (b === 'unknown') return a;
  return LEVEL_ORDER.indexOf(a) >= LEVEL_ORDER.indexOf(b) ? a : b;
}

function degrade(level: SignalLevel): SignalLevel {
  const index = LEVEL_ORDER.indexOf(level);
  return index === -1 ? level : (LEVEL_ORDER[Math.min(index + 1, 3)] ?? level);
}

/** HRV today/baseline ratio → recovery level (spec §6). */
export function hrvLevel(ratio: number): SignalLevel {
  if (ratio >= 0.97) return 'optimal';
  if (ratio >= 0.9) return 'good';
  if (ratio >= 0.8) return 'caution';
  return 'poor';
}

/** RHR delta (bpm over baseline) → level, when HRV is absent. */
export function rhrLevel(delta: number): SignalLevel {
  if (delta <= 0) return 'optimal';
  if (delta <= 3) return 'good';
  if (delta <= 7) return 'caution';
  return 'poor';
}

/** Asleep minutes → sleep level. */
export function sleepLevel(minutes: number): SignalLevel {
  if (minutes >= 450) return 'optimal';
  if (minutes >= 390) return 'good';
  if (minutes >= 330) return 'caution';
  return 'poor';
}

/** Yesterday's load vs its baseline → strain level (low load = fresh). */
export function strainLevel(ratio: number): SignalLevel {
  if (ratio <= 0.75) return 'optimal';
  if (ratio <= 1.3) return 'good';
  if (ratio <= 1.7) return 'caution';
  return 'poor';
}

/** Mean of the points strictly before `date`; null under the evidence gate. */
function baselineBefore(points: DailyMetricPoint[], date: string): number | null {
  const prior = points.filter((p) => p.date < date);
  if (prior.length < BASELINE_MIN_DAYS) return null;
  return prior.reduce((sum, p) => sum + p.value, 0) / prior.length;
}

function pointOn(points: DailyMetricPoint[], date: string): DailyMetricPoint | null {
  return points.find((p) => p.date === date) ?? null;
}

/** "1840" → "1,840" without Intl (Hermes-safe; same as use-data-overview). */
function fmtInt(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 432 → "7h 12m". */
function fmtSleep(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${m}m`;
}

/** "+4" / "−2" style signed delta. */
function fmtDelta(delta: number): string {
  const rounded = Math.round(delta);
  return rounded >= 0 ? `+${rounded}` : `−${Math.abs(rounded)}`;
}

/** "14% below your 30-day baseline" | "at your 30-day baseline" | above. */
function baselineSentence(ratio: number): string {
  const pct = Math.round(Math.abs(1 - ratio) * 100);
  if (pct < 1) return 'at your 30-day baseline';
  return ratio < 1 ? `${pct}% below your 30-day baseline` : `${pct}% above your 30-day baseline`;
}

/** The local day before a YYYY-MM-DD, parsed componentwise (never UTC-shifted). */
function dayBefore(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const prev = new Date(y, m - 1, d - 1);
  const mm = String(prev.getMonth() + 1).padStart(2, '0');
  const dd = String(prev.getDate()).padStart(2, '0');
  return `${prev.getFullYear()}-${mm}-${dd}`;
}

const VERDICT_LABEL: Record<SignalLevel, string> = {
  optimal: 'Primed',
  good: 'Ready',
  caution: 'Recovery low',
  poor: 'Back off today',
  unknown: 'No recovery signal yet',
};

/** Derive the whole Home readiness view for `today`. */
export function deriveReadiness(db: Database, today: string = todayISODate()): ReadinessView {
  // --- Raw signals, source-arbitrated per day ------------------------------
  const hrvSeries = dailyMetricSeries(db, 'hrv', BASELINE_WINDOW_DAYS + 1, today);
  const rhrSeries = dailyMetricSeries(db, 'rhr', BASELINE_WINDOW_DAYS + 1, today);
  const hrvToday = pointOn(hrvSeries, today);
  const rhrToday = pointOn(rhrSeries, today);
  const hrvBaseline = baselineBefore(hrvSeries, today);
  const rhrBaseline = baselineBefore(rhrSeries, today);

  const sleepToday = pickDailyMetric(db, 'sleep_duration_min', today);
  const deepToday = pickDailyMetric(db, 'sleep_deep_min', today);

  const yesterday = dayBefore(today);
  const energySeries = dailyMetricSeries(db, 'active_energy_kcal', 29, yesterday);
  const energyYesterday = pointOn(energySeries, yesterday);
  const energyBaseline = baselineBefore(energySeries, yesterday);

  const stepsToday = pickDailyMetric(db, 'steps', today);

  const hasSignal =
    hrvSeries.length > 0 ||
    rhrSeries.length > 0 ||
    sleepToday !== null ||
    stepsToday !== null ||
    energySeries.length > 0;

  // --- Pillars ---------------------------------------------------------------
  const hrvRatio = hrvToday && hrvBaseline ? hrvToday.value / hrvBaseline : null;
  const rhrDelta = rhrToday && rhrBaseline !== null ? rhrToday.value - rhrBaseline : null;

  let recovery: SignalLevel = 'unknown';
  if (hrvRatio !== null) {
    recovery = hrvLevel(hrvRatio);
    // An elevated resting HR corroborates suppression — degrade one level.
    if (rhrDelta !== null && rhrDelta >= 5) recovery = degrade(recovery);
  } else if (rhrDelta !== null) {
    recovery = rhrLevel(rhrDelta);
  }

  const sleep: SignalLevel = sleepToday ? sleepLevel(sleepToday.value) : 'unknown';
  const strain: SignalLevel =
    energyYesterday && energyBaseline !== null && energyBaseline > 0
      ? strainLevel(energyYesterday.value / energyBaseline)
      : 'unknown';
  const nutrition: SignalLevel = todayTotals(db, today).mealCount > 0 ? 'good' : 'unknown';

  const pillars: Pillar[] = [
    { label: 'Sleep', level: sleep },
    { label: 'Recovery', level: recovery },
    { label: 'Nutrition', level: nutrition },
    { label: 'Strain', level: strain },
  ];

  // --- Verdict -----------------------------------------------------------------
  const verdict = worse(recovery, sleep);
  let detail: string;
  if (hrvToday && hrvRatio !== null) {
    detail = `HRV ${Math.round(hrvToday.value)} ms · ${baselineSentence(hrvRatio)}`;
  } else if (rhrToday && rhrDelta !== null) {
    detail = `Resting HR ${Math.round(rhrToday.value)} bpm · ${fmtDelta(rhrDelta)} bpm vs your 30-day baseline`;
  } else if (sleepToday) {
    detail = `${fmtSleep(sleepToday.value)} asleep last night`;
  } else {
    detail = 'Connect Apple Health in Settings to power readiness.';
  }

  const readiness: Readiness = {
    level: verdict,
    label: VERDICT_LABEL[verdict],
    detail,
  };

  // --- Metrics strip --------------------------------------------------------------
  const metrics: Metric[] = [
    {
      id: 'sleep',
      label: 'Sleep',
      value: sleepToday ? fmtSleep(sleepToday.value) : '—',
      detail: sleepToday
        ? deepToday
          ? `Deep ${Math.round(deepToday.value)}m`
          : deviceLabel(sleepToday.sourceDevice)
        : 'No data yet',
      level: sleep,
    },
    {
      id: 'hrv',
      label: 'HRV',
      value: hrvToday ? `${Math.round(hrvToday.value)} ms` : '—',
      detail: hrvToday
        ? hrvRatio !== null
          ? baselineSentence(hrvRatio).replace(' your 30-day', '')
          : 'no baseline yet'
        : 'No data yet',
      level: hrvRatio !== null ? hrvLevel(hrvRatio) : 'unknown',
    },
    {
      id: 'rhr',
      label: 'Resting HR',
      value: rhrToday ? `${Math.round(rhrToday.value)} bpm` : '—',
      detail: rhrToday
        ? rhrDelta !== null
          ? `${fmtDelta(rhrDelta)} vs baseline`
          : 'no baseline yet'
        : 'No data yet',
      level: rhrDelta !== null ? rhrLevel(rhrDelta) : 'unknown',
    },
    {
      id: 'steps',
      label: 'Steps',
      value: stepsToday ? fmtInt(stepsToday.value) : '—',
      detail: stepsToday ? 'today' : 'No data yet',
      level: 'unknown',
    },
  ];

  return { readiness, pillars, metrics, hasSignal };
}
