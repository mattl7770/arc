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
import { todayISODate } from '@/lib/db/date';

/** One daily observation. */
export type SeriesPoint = { date: string; value: number };

/** The local calendar day `days` before `now`, as YYYY-MM-DD. */
export function isoDaysAgo(now: Date, days: number): string {
  return todayISODate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days));
}

/** Pure date-string arithmetic: `date` shifted by `delta` days (UTC, DST-proof). */
export function isoDatePlusDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/**
 * Daily series for a wearable metric — avg per day for level metrics
 * (hrv/rhr), sum per day for accumulating ones (water). All source devices
 * pooled: the question is "what was my HRV", not "what did the ring say".
 */
export function wearableDailySeries(
  db: Database,
  metricType: string,
  sinceDate: string,
  agg: 'avg' | 'sum'
): SeriesPoint[] {
  const fn = agg === 'sum' ? 'sum' : 'avg';
  return db.all<SeriesPoint>(
    `SELECT date, ${fn}(value) AS value FROM wearable_data
     WHERE metric_type = ? AND date >= ?
     GROUP BY date ORDER BY date`,
    [metricType, sinceDate]
  );
}

/**
 * Daily series for a body_metrics column (weight_kg / body_fat_pct /
 * waist_cm), averaging multiple same-day measurements. body_metrics stores a
 * UTC `measured_at` instant, so "day" here is the UTC day (substr of the ISO
 * string) — deterministic everywhere, and honest enough for multi-day trends.
 */
export function bodyDailySeries(
  db: Database,
  column: 'weight_kg' | 'body_fat_pct' | 'waist_cm',
  sinceDate: string
): SeriesPoint[] {
  // `column` is a fixed union from the signature, never user/model input.
  return db.all<SeriesPoint>(
    `SELECT substr(measured_at, 1, 10) AS date, avg(${column}) AS value FROM body_metrics
     WHERE ${column} IS NOT NULL AND substr(measured_at, 1, 10) >= ?
     GROUP BY substr(measured_at, 1, 10) ORDER BY date`,
    [sinceDate]
  );
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

export function nutritionDailyTotals(db: Database, sinceDate: string): NutritionDay[] {
  return db.all<NutritionDay>(
    `SELECT date,
       coalesce(sum(kcal), 0)      AS kcal,
       coalesce(sum(protein_g), 0) AS protein_g,
       coalesce(sum(carbs_g), 0)   AS carbs_g,
       coalesce(sum(fat_g), 0)     AS fat_g,
       count(*)                    AS meals
     FROM meals WHERE date >= ?
     GROUP BY date ORDER BY date`,
    [sinceDate]
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

export function trainingDailyTotals(db: Database, sinceDate: string): TrainingDay[] {
  return db.all<TrainingDay>(
    `SELECT date,
       coalesce(sum(duration_min), 0) AS minutes,
       count(*)                       AS sessions,
       sum(CASE WHEN kind = 'strength' THEN 1 ELSE 0 END) AS strength_sessions,
       sum(CASE WHEN kind = 'cardio' THEN coalesce(duration_min, 0) ELSE 0 END) AS cardio_min
     FROM workouts WHERE date >= ?
     GROUP BY date ORDER BY date`,
    [sinceDate]
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
