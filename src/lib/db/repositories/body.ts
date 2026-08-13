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
 * It also feeds the OUTBOUND Apple Health channel (bottom of file): ARC owns
 * these three columns and publishes copies of them, so the "what still needs
 * publishing" query belongs with the table that owns the data, not with the
 * HealthKit seam that transmits it.
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

// --- Outbound publishing feed (Apple Health, docs/wearables-subapp.md §10) ---
//
// Rows are walked in (created_at, id) order, NOT measured_at order. That choice
// is what makes the publish cursor honest about backdating: `logMetric` stamps a
// backdated reading at local noon of its intended day, so a weight logged today
// for last Tuesday has a measured_at in the past. A measured_at watermark would
// step straight over it and that reading would never reach Apple Health.
// `created_at` is stamped by SQLite at INSERT and is therefore monotonic in
// insertion order regardless of what the reading claims about when it happened.
//
// The `id` half of the key is not decoration: `created_at` has millisecond
// resolution, so two rows written in the same millisecond (an import writing
// weight and waist together) share a value, and a bare `created_at > ?` would
// drop whichever lost the tie. Ids are random rather than ordered, which is
// fine — keyset pagination only needs a TOTAL order, not a chronological one,
// and ORDER BY matches the WHERE exactly.

/** One `body_metrics` row, as the publisher sees it. */
export type PublishableBody = {
  id: string;
  createdAt: string;
  measuredAt: string;
  weightKg: number | null;
  bodyFatPct: number | null;
  waistCm: number | null;
};

/** A position in the (created_at, id) walk. */
export type BodyCursor = { createdAt: string; id: string };

/**
 * Rows created strictly after `cursor` in (created_at, id) order, oldest first.
 * A null cursor means "from the very beginning" — only reachable when the table
 * was empty at arming time, since {@link newestBodyCursor} otherwise starts the
 * walk at the newest existing row.
 *
 * Only rows carrying at least one publishable column come back; a row holding
 * nothing but hip/muscle would otherwise advance the cursor for no reason and
 * make a pass look like it did work.
 */
export function publishableBodyAfter(
  db: Database,
  cursor: BodyCursor | null,
  limit: number
): PublishableBody[] {
  const publishable = `(weight_kg IS NOT NULL OR body_fat_pct IS NOT NULL OR waist_cm IS NOT NULL)`;
  const rows = cursor
    ? db.all<{
        id: string;
        created_at: string;
        measured_at: string;
        weight_kg: number | null;
        body_fat_pct: number | null;
        waist_cm: number | null;
      }>(
        `SELECT id, created_at, measured_at, weight_kg, body_fat_pct, waist_cm
         FROM body_metrics
         WHERE ${publishable} AND (created_at > ? OR (created_at = ? AND id > ?))
         ORDER BY created_at ASC, id ASC LIMIT ?`,
        [cursor.createdAt, cursor.createdAt, cursor.id, limit]
      )
    : db.all<{
        id: string;
        created_at: string;
        measured_at: string;
        weight_kg: number | null;
        body_fat_pct: number | null;
        waist_cm: number | null;
      }>(
        `SELECT id, created_at, measured_at, weight_kg, body_fat_pct, waist_cm
         FROM body_metrics
         WHERE ${publishable}
         ORDER BY created_at ASC, id ASC LIMIT ?`,
        [limit]
      );
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    measuredAt: r.measured_at,
    weightKg: r.weight_kg,
    bodyFatPct: r.body_fat_pct,
    waistCm: r.waist_cm,
  }));
}

/**
 * The last row in the (created_at, id) walk — where arming parks the cursor so
 * that pre-existing history is never published. Every row counts here, not just
 * publishable ones: the cursor is a position in the table, and skipping past a
 * hip-only row is exactly as correct as stopping on it.
 */
export function newestBodyCursor(db: Database): BodyCursor | null {
  const row = db.get<{ id: string; created_at: string }>(
    `SELECT id, created_at FROM body_metrics ORDER BY created_at DESC, id DESC LIMIT 1`
  );
  return row ? { createdAt: row.created_at, id: row.id } : null;
}
