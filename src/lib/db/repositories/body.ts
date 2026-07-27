/**
 * The Body sub-app's data layer: one `body_metrics` row per measurement
 * (0001_init.sql), read back as per-column trend series and latest readings.
 *
 * `column` is always one of a fixed string union ({@link BodyColumn}), never
 * free input, so interpolating it into SQL is safe — the same pattern as
 * `logMetric`'s column interpolation in repositories/logs.ts.
 *
 * `body_metrics` has no local `date` column, only a UTC `measured_at` — so the
 * trailing-window bound here is computed in JS from `now` (like
 * `localDayUtcRange`), never via SQLite's `'localtime'` modifier, keeping this
 * deterministic in the headless tests.
 *
 * Works against the {@link Database} interface only — never op-sqlite — so the
 * same code runs on device and against node:sqlite in
 * db/data-body-biomarkers.test.mjs.
 */
import type { Database } from '../database';

export type BodyColumn = 'weight_kg' | 'body_fat_pct' | 'waist_cm';

export interface BodyPoint {
  measuredAt: string;
  value: number;
}

export interface LatestBody {
  value: number;
  measuredAt: string;
}

/**
 * `column`'s trend over the trailing `days` days (default 30) up to `now`,
 * oldest to newest. Rows where `column` is NULL are skipped — a day where only
 * waist was logged doesn't produce a weight point.
 */
export function bodySeries(
  db: Database,
  column: BodyColumn,
  days: number = 30,
  now: Date = new Date()
): BodyPoint[] {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - days);
  const rows = db.all<{ measured_at: string; value: number }>(
    `SELECT measured_at, ${column} AS value FROM body_metrics
     WHERE ${column} IS NOT NULL AND measured_at >= ? AND measured_at <= ?
     ORDER BY measured_at ASC`,
    [cutoff.toISOString(), now.toISOString()]
  );
  return rows.map((r) => ({ measuredAt: r.measured_at, value: r.value }));
}

/** The most recent non-null reading for `column`, or null if none exist. */
export function latestBody(db: Database, column: BodyColumn): LatestBody | null {
  const row = db.get<{ measured_at: string; value: number }>(
    `SELECT measured_at, ${column} AS value FROM body_metrics
     WHERE ${column} IS NOT NULL ORDER BY measured_at DESC LIMIT 1`
  );
  return row ? { value: row.value, measuredAt: row.measured_at } : null;
}
