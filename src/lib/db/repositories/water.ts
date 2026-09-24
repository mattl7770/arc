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
 * **The mutable-daily-total trap is real, but it is not the capture's.**
 * HealthKit's inbound day-bucket rows carry a deterministic `hk:<metric>:<date>`
 * raw id precisely so a re-sync UPDATEs one row per day instead of duplicating a
 * fortnight — those ARE mutable daily totals, which is why republishing one to
 * Health would make Health sum the versions.
 *
 * ## Water is TWO-WAY with Apple Health (inbound 2026-09-14, outbound 2026-09-21)
 *
 * `HKQuantityTypeIdentifierDietaryWater` is a read scope as of D2, landing as a
 * merged daily statistic: one `apple_health` row per day under
 * `hk:water_ml:<date>` (`src/lib/health/mapping.ts` → `STATISTIC_METRICS`).
 *
 * Since 2026-09-21 it is a write scope too — the owner's device note, *"water
 * should get 2 way health sync"*. Every MANUAL capture is published as one
 * `DietaryWater` sample (`publish.ts` → `publishWaterCaptures`, walking
 * {@link publishableWaterAfter}), tagged with this row's id. Three facts keep
 * that from doubling the day, and they are docs/wearables-subapp.md §20 in
 * short:
 *
 *   - **Only captures go out** — the walk takes `source_device = 'manual' AND
 *     source_raw_id IS NULL`, so an `hk:` bucket is never republished. That is
 *     the structural guard: it bounds any echo at one double, never a loop.
 *   - **ARC's own samples never come back in** — the cumulative read excludes
 *     them by that tag (`readDailyCumulative`, metadata rung, `failClosed`).
 *   - **An undone capture takes its sample with it** — the tag IS this row's
 *     id, so `removeWaterCapture` finds the sample by the id the Undo holds.
 *     This is the one thing the body channel cannot do (nothing can find a
 *     published weight again).
 *
 * This module stays free of all of that: it answers "which rows?", and
 * `publish.ts` does the native half.
 *
 * ## Two sources, one total, and NO dedupe — the rule, argued
 *
 * A HealthKit day bucket and a manual capture are **separate rows**, and
 * {@link waterDaySeries} sums both. They are not two copies of one event that
 * ARC could reconcile:
 *
 *   - There is nothing to match on. The inbound row is Apple's MERGED day total
 *     — no per-drink identity, no times, no amounts — so a manual 16 oz has no
 *     counterpart in it to cancel against.
 *   - Subtracting ARC's manual total from the bucket would assume the bucket
 *     CONTAINS it. It does not — and since 2026-09-21 that is true because the
 *     read EXCLUDES ARC's published captures rather than because ARC publishes
 *     nothing — so the two records describe different acts of logging, not the
 *     same one twice.
 *   - Any other dedupe (nearest amount, nearest minute) would be a guess that
 *     silently deletes real intake. Inventing a reconciliation is worse than
 *     summing honestly.
 *
 * So the day total is the sum, and **the behavioural rule is: pick one door.**
 * Log a glass in ARC or on the watch, not both. Settings › Apple Health says so
 * in a sentence, and a double IS visible and correctable — `/water` lists the two
 * rows side by side (the synced one marked "From apple_health"), and deleting the
 * manual duplicate is one tap away. That the mistake is legible is what makes
 * summing the honest choice rather than a shrug.
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

// --- The outbound walk (2026-09-21) ------------------------------------------
//
// The water twin of `body.ts` → `publishableBodyAfter` / `newestBodyCursor`, and
// deliberately the same shape: a keyset walk over (created_at, rowid), the
// cursor carried as the row's `id` (that is what `HealthPublishState` persists)
// and resolved to its rowid for the tie-break. Every reason body.ts gives for
// `rowid` over `id` applies here with more force — same-millisecond taps are
// the NORMAL case for water (see listWaterEntries).
//
// One deliberate difference: both the walk and the arming position cover
// MANUAL captures only. The body walk parks on the newest row of its own table;
// this table holds every wearable metric, and water's inbound `hk:` buckets are
// rewritten and even deleted by the re-window pass (docs §16), so parking on
// one would be parking on a row that can vanish.

/** The filter that makes a water row publishable — and the structural guard. */
const PUBLISHABLE_WATER = `metric_type = '${WATER_METRIC}'
       AND source_device = 'manual' AND source_raw_id IS NULL`;

/** One manual capture, as the publisher sees it. */
export type PublishableWater = {
  id: string;
  /** The local day it counts toward — backdated captures sit on a past day. */
  date: string;
  /** Canonical ml. */
  ml: number;
  /** ISO instant the row was written — drink o'clock for a same-day capture. */
  createdAt: string;
};

/** A position in the (created_at, rowid) walk; see the section note. */
export type WaterCursor = { createdAt: string; id: string };

type PublishableWaterRow = { id: string; date: string; value: number; created_at: string };

function toPublishable(r: PublishableWaterRow): PublishableWater {
  return { id: r.id, date: r.date, ml: r.value, createdAt: r.created_at };
}

/**
 * Manual captures created strictly after `cursor`, oldest first. A null cursor
 * means "from the very beginning" — reachable only when there was no manual
 * capture at all when the walk armed, so the beginning is empty of history.
 *
 * `source_device = 'manual' AND source_raw_id IS NULL` is ECHO SUPPRESSION,
 * and the structural kind — water's equivalent of body's
 * `source <> 'apple_health'`. Whatever the read-side exclusion does, a row that
 * came FROM Apple Health (an `hk:` bucket) is never sent back TO it, so an echo
 * can at worst double one day; it can never feed itself.
 *
 * If the cursor's own row has since been deleted (an Undo right after a pass),
 * its rowid resolves to NULL and only the same-millisecond tie branch goes
 * dark — later captures still satisfy `created_at > ?`. That errs toward
 * skipping a same-millisecond sibling rather than re-posting one, which is the
 * direction body.ts's walk already takes.
 */
export function publishableWaterAfter(
  db: Database,
  cursor: WaterCursor | null,
  limit: number
): PublishableWater[] {
  const rows = cursor
    ? db.all<PublishableWaterRow>(
        `SELECT id, date, value, created_at FROM wearable_data
         WHERE ${PUBLISHABLE_WATER}
           AND (created_at > ?
                OR (created_at = ? AND rowid > (SELECT rowid FROM wearable_data WHERE id = ?)))
         ORDER BY created_at ASC, rowid ASC LIMIT ?`,
        [cursor.createdAt, cursor.createdAt, cursor.id, limit]
      )
    : db.all<PublishableWaterRow>(
        `SELECT id, date, value, created_at FROM wearable_data
         WHERE ${PUBLISHABLE_WATER}
         ORDER BY created_at ASC, rowid ASC LIMIT ?`,
        [limit]
      );
  return rows.map(toPublishable);
}

/**
 * The newest manual capture — where arming parks the cursor, so that the water
 * already on record is never published (docs §10 rule 1, and here for a second
 * reason: that history was logged under the one-way rule, when a glass typed
 * here and tapped on the watch was the user's to reconcile, so sending it now
 * could double Health's own past days).
 */
export function newestWaterCursor(db: Database): WaterCursor | null {
  const row = db.get<{ id: string; created_at: string }>(
    `SELECT id, created_at FROM wearable_data WHERE ${PUBLISHABLE_WATER}
     ORDER BY created_at DESC, rowid DESC LIMIT 1`
  );
  return row ? { createdAt: row.created_at, id: row.id } : null;
}

/** One manual capture by id, or null — a device row, another metric, or gone. */
export function getPublishableWater(db: Database, id: string): PublishableWater | null {
  const row = db.get<PublishableWaterRow>(
    `SELECT id, date, value, created_at FROM wearable_data WHERE id = ? AND ${PUBLISHABLE_WATER}`,
    [id]
  );
  return row ? toPublishable(row) : null;
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

/**
 * The window {@link usualWaterAmount} learns from. **14, to agree with the water
 * screen's own `WINDOW_DAYS`** — two windows disagreeing about what "recently"
 * means is how a number starts lying.
 */
export const USUAL_WINDOW_DAYS = 14;

/**
 * **The amount the owner usually takes** — canonical ml, or `null` when there is
 * nothing to learn from.
 *
 * The rule: the **most frequently logged amount across MANUAL captures in the
 * last {@link USUAL_WINDOW_DAYS} days**, ties broken by the most recent.
 *
 * Every clause of that is load-bearing:
 *
 *   - **Manual only** (`source_raw_id IS NULL`, the same discriminator
 *     editability draws). An `apple_health` day bucket must never become "his
 *     usual": a merged day total is not a vessel, and on a heavy day it would be
 *     the largest number in the table.
 *   - **Most frequent, not most recent.** One 4 oz pill-swallow would retrain a
 *     "last logged" figure, and the Log tab would then describe a quarter of a
 *     glass as his habit for the rest of the week.
 *   - **Ties by the most recent**, and the final tie-break is `rowid` rather than
 *     `id` — `created_at` resolves to the millisecond and several taps land
 *     inside one of those, while ids are random v4 UUIDs whose order is
 *     arbitrary (the same finding {@link listWaterEntries} records).
 *
 * Grouping on the stored `value` is exact rather than approximate: a display
 * amount converts to canonical through one deterministic multiplication, so two
 * taps of 16 oz store the identical double and group together.
 *
 * **It is a reading, not a control (2026-09-21).** From 2026-09-14 this drove
 * the Log tab's Water tile: one tap logged whatever came back from here, and
 * the other vessels sat behind a long-press. Off device that read as a button
 * that only ever added 8 oz — the derivation is only as good as the gesture
 * nobody found. The vessels are now all on the sheet, and this figure is
 * printed beside them as `usually 8 oz` and tapped by nothing. The derivation
 * is unchanged and so are its tests; what changed is that being wrong about it
 * now costs a sentence rather than a mis-logged day. The escape hatch that used
 * to be held in reserve — a user-set default in the preferences blob — is
 * therefore moot: there is no default left to set.
 */
export function usualWaterAmount(
  db: Database,
  today: string,
  days: number = USUAL_WINDOW_DAYS
): number | null {
  const dates = localDaysList(today, days);
  const first = dates[0]!;
  const row = db.get<{ value: number }>(
    `SELECT value, count(*) n, max(created_at) last_at, max(rowid) last_row
     FROM wearable_data
     WHERE metric_type = ? AND source_raw_id IS NULL AND date >= ? AND date <= ?
     GROUP BY value
     ORDER BY n DESC, last_at DESC, last_row DESC
     LIMIT 1`,
    [WATER_METRIC, first, today]
  );
  return row && Number.isFinite(row.value) && row.value > 0 ? row.value : null;
}
