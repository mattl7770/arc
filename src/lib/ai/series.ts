/**
 * Daily-series reads and small statistics shared by the Coach's read tools
 * (src/lib/ai/tools/read-tools.ts) and the insights engine
 * (src/lib/ai/insights.ts). One point per local calendar day, oldest first.
 *
 * Pure SQL + arithmetic over the {@link Database} interface — deterministic,
 * headless-testable, no model involvement. Values are CANONICAL units
 * (kg/ms/bpm/ml…), matching what the tables store; display conversion happens
 * at the edge (the metric registry).
 */
import type { Database } from '@/lib/db/database';
import {
  getDayStartsAt,
  localDayUtcRange,
  logicalDate,
  shiftISODate,
  todayISODate,
} from '@/lib/db/date';
import { dailyMetricSeries } from '@/lib/db/repositories/wearables';

/**
 * The exclusive end of the local day containing `now`, as a UTC instant — the
 * correct upper bound for anything stored as a `measured_at` instant.
 */
export function endOfLocalDayUtc(now: Date): string {
  return localDayUtcRange(now).endUtc;
}

/** One daily observation. */
export type SeriesPoint = { date: string; value: number };

/**
 * The day `days` before today, as YYYY-MM-DD — counted back from the LOGICAL
 * today, so a window opened at 01:00 under a 04:00 boundary covers the same N
 * days the user thinks it does (src/lib/db/date.ts).
 */
export function isoDaysAgo(now: Date, days: number): string {
  return shiftISODate(todayISODate(now), -days);
}

/** Pure date-string arithmetic: `date` shifted by `delta` days. */
export function isoDatePlusDays(date: string, delta: number): string {
  return shiftISODate(date, delta);
}

/**
 * Daily series for a wearable metric — avg per day for level metrics
 * (hrv/rhr), sum per day for accumulating ones (water). All source devices
 * pooled: the question is "what was my HRV", not "what did the ring say".
 *
 * `untilDate` closes the window (inclusive). Callers should pass today: a
 * future-dated row (clock skew, a mis-entered backdate) must never leak into
 * "recent" averages or read as the latest value — the deferred hardening item
 * from project-status.md (2026-07-31), closed 2026-08-08.
 */
export function wearableDailySeries(
  db: Database,
  metricType: string,
  sinceDate: string,
  agg: 'avg' | 'sum',
  untilDate?: string
): SeriesPoint[] {
  const fn = agg === 'sum' ? 'sum' : 'avg';
  return db.all<SeriesPoint>(
    `SELECT date, ${fn}(value) AS value FROM wearable_data
     WHERE metric_type = ? AND date >= ?${untilDate ? ' AND date <= ?' : ''}
     GROUP BY date ORDER BY date`,
    untilDate ? [metricType, sinceDate, untilDate] : [metricType, sinceDate]
  );
}

/** Whole days from `from` to `to` inclusive-of-both-ends counting (UTC, DST-proof). */
export function daysBetweenISO(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Daily series for a wearable metric using the SAME source arbitration Home and
 * the Data tab use ({@link dailyMetricSeries}): one winning row per day, richest
 * device first. This is the read for anything HealthKit day-buckets (steps,
 * sleep, energy, HRV, RHR, VO2max…) — pooling those across devices with
 * avg/sum would either blur two devices' nights together or double-count them,
 * and would make the Coach disagree with the number Home is showing.
 *
 * Contrast {@link wearableDailySeries}, which pools every row: correct only for
 * metrics that genuinely ACCUMULATE many rows a day (water sips, workouts).
 */
export function wearableArbitratedSeries(
  db: Database,
  metricType: string,
  sinceDate: string,
  today: string
): SeriesPoint[] {
  // dailyMetricSeries' window is `date > today - days`, so a `since`-inclusive
  // window of N days needs days = N.
  const days = Math.max(1, daysBetweenISO(sinceDate, today) + 1);
  return dailyMetricSeries(db, metricType, days, today).map((p) => ({
    date: p.date,
    value: p.value,
  }));
}

/** What one metric_type actually holds — the basis for data-driven discovery. */
export type WearableMetricPresence = {
  metricType: string;
  /** The unit the rows carry (they are written per metric, so max() is it). */
  unit: string | null;
  /** Distinct days with a row. */
  days: number;
  /** Most recent day with a row. */
  lastDate: string;
};

/**
 * Every metric_type that ACTUALLY exists in wearable_data, discovered from the
 * data itself. `wearable_data.metric_type` is deliberately free text so a new
 * vendor metric is not a migration (CLAUDE.md §9) — so anything that enumerates
 * metrics from a hardcoded list rots the moment a new one is ingested. This is
 * the antidote: the Coach's readable set is derived, not declared.
 */
export function wearableMetricInventory(db: Database): WearableMetricPresence[] {
  return db.all<WearableMetricPresence>(
    `SELECT metric_type AS metricType,
            max(unit)          AS unit,
            count(DISTINCT date) AS days,
            max(date)          AS lastDate
     FROM wearable_data
     GROUP BY metric_type
     ORDER BY metric_type`
  );
}

/**
 * Daily series for a body_metrics column (weight_kg / body_fat_pct /
 * waist_cm), averaging multiple same-day measurements. body_metrics stores a
 * UTC `measured_at` instant, so each reading is filed under the LOGICAL LOCAL
 * day it was taken on (`logicalDate`, honouring Settings' day boundary) — the
 * day every other window in ARC is counted in, and the one the findings
 * engine files a weigh-in under. The UTC day of the ISO string was used until
 * 2026-10-21: east of UTC it filed a 07:00 Auckland weigh-in under the day
 * before, so an experiment's baseline swallowed its start day's reading.
 */
export function bodyDailySeries(
  db: Database,
  column: 'weight_kg' | 'body_fat_pct' | 'waist_cm',
  sinceDate: string,
  /**
   * Exclusive upper bound as a UTC ISO INSTANT — pass
   * `localDayUtcRange(now).endUtc` to close the window at the end of the local
   * day. It must be an instant, not a date string: `measured_at` is a UTC
   * instant, so west of UTC an evening weigh-in already carries TOMORROW's UTC
   * date and a `substr(...) <= today` bound would drop the user's own reading
   * (caught by db/coach-tools.test.mjs on a UTC-behind machine).
   */
  untilExclusiveUtc?: string
): SeriesPoint[] {
  // `column` is a fixed union from the signature, never user/model input. The
  // SQL bound is a day early (a local day can begin on the previous UTC date —
  // up to 14 h east of UTC); the exact cut is on the logical day below.
  const rows = db.all<{ measuredAt: string; value: number }>(
    `SELECT measured_at AS measuredAt, ${column} AS value FROM body_metrics
     WHERE ${column} IS NOT NULL AND measured_at >= ?${
       untilExclusiveUtc ? ' AND measured_at < ?' : ''
     }
     ORDER BY measured_at`,
    untilExclusiveUtc
      ? [shiftISODate(sinceDate, -1), untilExclusiveUtc]
      : [shiftISODate(sinceDate, -1)]
  );
  const dayStartsAt = getDayStartsAt();
  const byDay = new Map<string, { sum: number; n: number }>();
  for (const row of rows) {
    const date = logicalDate(new Date(row.measuredAt), dayStartsAt);
    if (date < sinceDate) continue;
    const day = byDay.get(date) ?? { sum: 0, n: 0 };
    day.sum += row.value;
    day.n += 1;
    byDay.set(date, day);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, { sum, n }]) => ({ date, value: sum / n }));
}

/** Per-day nutrition totals for days that have meals, oldest first. */
export type NutritionDay = {
  date: string;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  meals: number;
};

export function nutritionDailyTotals(
  db: Database,
  sinceDate: string,
  untilDate?: string
): NutritionDay[] {
  return db.all<NutritionDay>(
    `SELECT date,
       coalesce(sum(kcal), 0)      AS kcal,
       coalesce(sum(protein_g), 0) AS protein_g,
       coalesce(sum(carbs_g), 0)   AS carbs_g,
       coalesce(sum(fat_g), 0)     AS fat_g,
       count(*)                    AS meals
     FROM meals WHERE date >= ?${untilDate ? ' AND date <= ?' : ''}
     GROUP BY date ORDER BY date`,
    untilDate ? [sinceDate, untilDate] : [sinceDate]
  );
}

/** Per-day training load for days that have sessions, oldest first. */
export type TrainingDay = {
  date: string;
  minutes: number;
  sessions: number;
  strength_sessions: number;
  cardio_min: number;
};

export function trainingDailyTotals(
  db: Database,
  sinceDate: string,
  untilDate?: string
): TrainingDay[] {
  return db.all<TrainingDay>(
    `SELECT date,
       coalesce(sum(duration_min), 0) AS minutes,
       count(*)                       AS sessions,
       sum(CASE WHEN kind = 'strength' THEN 1 ELSE 0 END) AS strength_sessions,
       sum(CASE WHEN kind = 'cardio' THEN coalesce(duration_min, 0) ELSE 0 END) AS cardio_min
     FROM workouts WHERE date >= ?${untilDate ? ' AND date <= ?' : ''}
     GROUP BY date ORDER BY date`,
    untilDate ? [sinceDate, untilDate] : [sinceDate]
  );
}

// --- Statistics ---------------------------------------------------------------

export type SeriesStats = {
  count: number;
  min: number;
  max: number;
  avg: number;
  first: SeriesPoint;
  last: SeriesPoint;
};

/** Summary stats for a non-empty series; null for an empty one. */
export function seriesStats(points: SeriesPoint[]): SeriesStats | null {
  if (points.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const p of points) {
    if (p.value < min) min = p.value;
    if (p.value > max) max = p.value;
    sum += p.value;
  }
  return {
    count: points.length,
    min,
    max,
    avg: sum / points.length,
    first: points[0]!,
    last: points[points.length - 1]!,
  };
}

/** Mean of a value list; null when empty. */
export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Pearson correlation of two equal-length samples; null when undefined
 * (fewer than 3 pairs, or zero variance on either side).
 */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = mean(xs.slice(0, n))!;
  const my = mean(ys.slice(0, n))!;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Round for tool output — the model doesn't need 12 decimals of avg. */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
