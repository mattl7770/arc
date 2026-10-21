import { logicalDate, shiftISODate } from '@/lib/db/date';

/**
 * The trendline under the weight record and the HRV / resting-HR trends — a
 * trailing 7-day average over DAILY readings that are allowed to be missing
 * (items 84 and 95, 2026-10-21).
 *
 * ## The window is CALENDAR days, not readings
 *
 * "The last seven readings" would stretch over a fortnight in a week of missed
 * weigh-ins and still call itself a 7-day average. The window here is the seven
 * calendar days ending on the day being drawn, and it averages whatever readings
 * fall inside it — so a gap shortens the evidence and never the window.
 *
 * ## Too little evidence is a gap, not a number
 *
 * A day whose window holds fewer than {@link TREND_MIN_READINGS} readings draws
 * NO average: one reading "averaged" is that reading wearing a smoother's name,
 * and the trendline is the line the eye trusts over the dots. Three of seven is
 * the floor. The line breaks across such stretches (`linePath`,
 * src/lib/charts/geometry.ts) rather than bridging them.
 */

export const TREND_WINDOW_DAYS = 7;
export const TREND_MIN_READINGS = 3;

/** One reading on one logical day. */
export type DayValue = { date: string; value: number };

/** One day of a drawn trend: the day's own reading (or null) and the trailing
 *  average ending that day (or null when the window is too thin). */
export type TrendPoint = { date: string; value: number | null; average: number | null };

/**
 * The trend over `dates` (oldest → newest, consecutive days — `localDaysList`).
 *
 * `readings` may reach back BEFORE `dates[0]`: the first six days of the axis
 * need the six before them for a full window, and a caller that fetched only the
 * visible span would draw an average that starts a week late. Readings outside
 * every window are simply unused. A duplicate date keeps the last one given.
 */
export function trailingAverageSeries(
  readings: DayValue[],
  dates: string[],
  window: number = TREND_WINDOW_DAYS,
  minReadings: number = TREND_MIN_READINGS
): TrendPoint[] {
  const byDate = new Map<string, number>();
  for (const r of readings) {
    if (Number.isFinite(r.value)) byDate.set(r.date, r.value);
  }
  return dates.map((date) => {
    let sum = 0;
    let n = 0;
    for (let k = 0; k < window; k++) {
      const v = byDate.get(shiftISODate(date, -k));
      if (v !== undefined) {
        sum += v;
        n++;
      }
    }
    return {
      date,
      value: byDate.get(date) ?? null,
      average: n >= minReadings ? sum / n : null,
    };
  });
}

/**
 * Timestamped readings (a `body_metrics.measured_at` instant) → one value per
 * LOGICAL day, the mean of that day's readings.
 *
 * The mean, not the first or the last: ARC does not know which of two weigh-ins
 * on one day was the "real" one (a scale sync and a typed figure, a morning and
 * an evening), and choosing would be a rule nobody set. Bucketed by
 * {@link logicalDate}, so a 01:30 reading under a 04:00 boundary belongs to the
 * day it was lived in, like every other row in the app.
 */
export function dailyMeans(
  readings: { measuredAt: string; value: number }[],
  dayStartsAt?: string
): DayValue[] {
  const sums = new Map<string, { sum: number; n: number }>();
  for (const r of readings) {
    if (!Number.isFinite(r.value)) continue;
    const at = new Date(r.measuredAt);
    if (Number.isNaN(at.getTime())) continue;
    const date = dayStartsAt === undefined ? logicalDate(at) : logicalDate(at, dayStartsAt);
    const cell = sums.get(date) ?? { sum: 0, n: 0 };
    cell.sum += r.value;
    cell.n += 1;
    sums.set(date, cell);
  }
  return [...sums.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, { sum, n }]) => ({ date, value: sum / n }));
}

/** The newest non-null average in a trend, or null — the figure printed beside
 *  the chart as "7-day avg". */
export function latestAverage(points: TrendPoint[]): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const a = points[i]!.average;
    if (a !== null) return a;
  }
  return null;
}
