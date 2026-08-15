/**
 * The water record's data layer — intake in, the day and the window out.
 *
 * ## Water is stored as INDEPENDENT ROWS, one per capture. Verified, not assumed.
 *
 * This was the open question behind the whole screen, because the answer decides
 * whether *"edit water related entries"* is even expressible. It is, and no
 * migration was needed:
 *
 *   - {@link logWater} (and `logMetric`, the keypad's path) INSERT a new
 *     `wearable_data` row every time. Neither ever UPDATEs a running total.
 *   - The only unique index on the table is **partial** —
 *     `wearable_data_device_raw_id_key ON (source_device, source_raw_id)
 *     WHERE source_raw_id IS NOT NULL` — and a manual capture leaves
 *     `source_raw_id` NULL. So two 500 ml logs on one day cannot collide, cannot
 *     upsert, and cannot overwrite each other: they are two rows of 500.
 *
 * Proven directly against SQLite rather than read off the source: three 500 ml
 * logs produce three rows summing to 1500, and a per-row UPDATE/DELETE hits
 * exactly one of them (db/water.test.mjs §1–§2).
 *
 * **The mutable-daily-total trap is real, but it is not water's.** HealthKit's
 * inbound day-bucket rows carry a deterministic `hk:<metric>:<date>` raw id
 * precisely so a re-sync UPDATEs one row per day instead of duplicating a
 * fortnight — those ARE mutable daily totals, which is why republishing one to
 * Health would make Health sum the versions. Water has never been on that path:
 * `src/lib/health/mapping.ts` has no water channel in either direction. If one is
 * ever added, the sum-per-day read below is already the right shape for it and
 * the manual-only guards on the write paths are what keep a synced row from
 * being hand-edited into a value the next sync would silently revert.
 *
 * ## Only manual rows are editable, and that is enforced here
 *
 * {@link updateWaterEntry} and {@link deleteWaterEntry} both carry
 * `AND source_raw_id IS NULL`. A row that came from a device is a record of what
 * that device reported; editing it would be undone by the next sync without
 * telling anyone, so the write simply does not match. The UI reads
 * {@link WaterEntry.editable} and never offers the affordance in the first
 * place — the guard is the backstop, not the mechanism.
 *
 * Everything here is canonical **ml**, matching `metrics.ts`'s water descriptor.
 * The oz/ml the user sees is a display concern resolved at the screen through
 * `resolveDisplay`, never a storage one.
 *
 * Depends only on the {@link Database} interface — never op-sqlite — so the same
 * code runs on device and against node:sqlite in db/water.test.mjs.
 */
import type { Database } from '../database';
import { localDaysList } from '../date';
import { newId } from '../id';

/** The `wearable_data.metric_type` water lands under (metrics.ts is the origin). */
const WATER_METRIC = 'water_ml';

/** One capture — the unit of the record, and the thing that can be edited. */
export interface WaterEntry {
  id: string;
  /** Canonical millilitres. Always > 0: a zero intake is not an event. */
  ml: number;
  /** ISO-8601 instant the row was written — the feed's time column. */
  at: string;
  /** `wearable_data.source_device`; 'manual' for anything typed in ARC. */
  source: string;
  /** False for device-sourced rows, which must not be hand-edited (see header). */
  editable: boolean;
}

/**
 * One day of the window.
 *
 * `entries` is the honesty seam and the reason this is not just a number. A day
 * with nothing logged and a day with a small amount logged are different facts,
 * and `ml` alone cannot tell them apart — so callers key "nothing here" on
 * `entries === 0` and print an em-dash, never a stand-in `0 ml`
 * (00-design-spec.md §5). Same refusal as nutrition's `mealCount`.
 */
export interface WaterDay {
  date: string;
  /** Total canonical ml across every source. 0 when `entries` is 0. */
  ml: number;
  entries: number;
}

/**
 * Persist one capture; returns its id.
 *
 * Writes the identical row shape as `logMetric`'s wearable branch (logs.ts) —
 * same table, same canonical unit, same `source_device`, `source_raw_id` left
 * NULL — so the keypad and this screen produce indistinguishable records and
 * neither can shadow the other. It exists separately only because a screen that
 * lets you correct what you just logged needs the id back, and because water
 * here can be backdated onto the day being viewed.
 */
export function logWater(db: Database, date: string, ml: number): string {
  if (!Number.isFinite(ml) || ml <= 0) {
    throw new Error(`logWater: intake must be a positive number of ml, got ${ml}`);
  }
  const id = newId(db);
  db.run(
    `INSERT INTO wearable_data (id, date, metric_type, value, unit, source_device)
     VALUES (?, ?, ?, ?, 'ml', 'manual')`,
    [id, date, WATER_METRIC, ml]
  );
  return id;
}

/**
 * Correct one capture's amount. Manual rows only (header); a no-op against a
 * device row or an unknown id. Returns whether a row actually changed, so a
 * caller can tell "corrected" from "nothing matched" instead of assuming.
 */
export function updateWaterEntry(db: Database, id: string, ml: number): boolean {
  if (!Number.isFinite(ml) || ml <= 0) {
    throw new Error(`updateWaterEntry: intake must be a positive number of ml, got ${ml}`);
  }
  const before = db.get<{ n: number }>(
    `SELECT count(*) n FROM wearable_data
     WHERE id = ? AND metric_type = ? AND source_raw_id IS NULL`,
    [id, WATER_METRIC]
  );
  if ((before?.n ?? 0) === 0) return false;
  db.run(
    `UPDATE wearable_data SET value = ?
     WHERE id = ? AND metric_type = ? AND source_raw_id IS NULL`,
    [ml, id, WATER_METRIC]
  );
  return true;
}

/**
 * Remove one capture. Manual rows only (header). Returns whether a row was
 * actually removed.
 *
 * A hard DELETE rather than a tombstone: `wearable_data` is referenced by no
 * foreign key, so unlike a protocol there is no execution history to strand —
 * the CLAUDE.md rule that a delete must not destroy history is about rows that
 * something else points at, and nothing points at these.
 */
export function deleteWaterEntry(db: Database, id: string): boolean {
  const before = db.get<{ n: number }>(
    `SELECT count(*) n FROM wearable_data
     WHERE id = ? AND metric_type = ? AND source_raw_id IS NULL`,
    [id, WATER_METRIC]
  );
  if ((before?.n ?? 0) === 0) return false;
  db.run(`DELETE FROM wearable_data WHERE id = ? AND metric_type = ? AND source_raw_id IS NULL`, [
    id,
    WATER_METRIC,
  ]);
  return true;
}

/**
 * Every capture on one local day, earliest first — the day's editable record.
 *
 * **The tie-break is `rowid`, not `id`.** `created_at` is stamped by
 * `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, which resolves to the millisecond, and
 * three taps of a quick amount land inside one of those — so ties are the normal
 * case here, not an edge. The house tie-break elsewhere is `id`, which is fine
 * for a `LIMIT 1` "most recent" read but useless for ordering: ids are random
 * v4 UUIDs (`randomblob`), so ordering by one shuffles same-millisecond rows
 * into an arbitrary sequence that can differ between two reads of the same data.
 * `rowid` is SQLite's own insertion counter and is the only column here that
 * actually records the order the taps happened in. (Caught by db/water.test.mjs
 * §5, which logged three amounts in a tight loop and got them back reversed.)
 */
export function listWaterEntries(db: Database, date: string): WaterEntry[] {
  const rows = db.all<{
    id: string;
    value: number;
    created_at: string;
    source_device: string;
    source_raw_id: string | null;
  }>(
    `SELECT id, value, created_at, source_device, source_raw_id
     FROM wearable_data
     WHERE metric_type = ? AND date = ?
     ORDER BY created_at ASC, rowid ASC`,
    [WATER_METRIC, date]
  );
  return rows.map((r) => ({
    id: r.id,
    ml: r.value,
    at: r.created_at,
    source: r.source_device,
    editable: r.source_raw_id === null,
  }));
}

/**
 * A rolling `days`-long window ending on `today`, oldest → newest, with every
 * day present whether or not anything was logged — `localDaysList` is the single
 * definition of that window across the app, so this trend cannot disagree with
 * nutrition's or symptoms' about what "the last 14 days" means.
 *
 * Days with no capture come back `{ ml: 0, entries: 0 }`. That zero is a
 * rendering input, never a rendered figure: see {@link WaterDay.entries}.
 */
export function waterDaySeries(db: Database, days: number, today: string): WaterDay[] {
  const dates = localDaysList(today, days);
  const first = dates[0]!;
  const rows = db.all<{ date: string; ml: number; entries: number }>(
    `SELECT date, sum(value) ml, count(*) entries
     FROM wearable_data
     WHERE metric_type = ? AND date >= ? AND date <= ?
     GROUP BY date`,
    [WATER_METRIC, first, today]
  );
  const byDate = new Map(rows.map((r) => [r.date, r]));
  return dates.map((date) => {
    const hit = byDate.get(date);
    return { date, ml: hit?.ml ?? 0, entries: hit?.entries ?? 0 };
  });
}

/**
 * The first day water was ever logged, or null when it never has been.
 *
 * The window is clipped to this before anything is judged, so a four-day-old
 * record draws four rows and says so rather than ten rows of empty that read as
 * ten days of not drinking (the rule mission-history.tsx records).
 */
export function waterRecordStart(db: Database): string | null {
  const row = db.get<{ first: string | null }>(
    `SELECT min(date) first FROM wearable_data WHERE metric_type = ?`,
    [WATER_METRIC]
  );
  return row?.first ?? null;
}
