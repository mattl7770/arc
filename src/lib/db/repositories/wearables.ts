/**
 * The wearables data layer — writes and reads over `wearable_data` (0001,
 * rebuilt in 0021) plus the `health_sync_state` KV (0021).
 *
 * Write side: {@link upsertWearableRows} is the ONE ingest path. Idempotency is
 * the 0001 unique index `(source_device, source_raw_id)` — day-bucket rows carry
 * a deterministic raw id (`hk:<metric>:<date>`), workouts carry the HealthKit
 * sample UUID, so a re-sync UPDATEs rows instead of duplicating them. The
 * `metric_type` shape rule (^[a-z0-9_]+$) that 0001 delegates to the repository
 * layer is enforced here, on write, where it can fail loud.
 *
 * Read side: per-metric daily series and latest values for the Data tab's
 * wearable history, and {@link pickDailyMetric} — the source-priority rule the
 * readiness derivation uses when two devices report the same metric on the same
 * day (docs/wearables-subapp.md §6).
 *
 * Depends only on the {@link Database} interface — never op-sqlite — so the same
 * code runs on device and against node:sqlite in db/wearables.test.mjs.
 */
import type { Database } from '../database';
import { newId } from '../id';
import type { WearableDataRow, WearableDevice } from '../types';
// The log's SHAPE lives with the health module (its only producer and its only
// reader); this file owns where it is stored. `parseSyncLog` is the sole value
// import — pure, no native seam behind it.
import { parseSyncLog, type HealthSyncLog } from '@/lib/health/log';
// Pure shape, no native seam behind it — ./types imports nothing at all.
import type { HealthScopeStamp } from '@/lib/health/types';

/** One row to ingest — everything wearable_data needs except the generated id. */
export type WearableUpsert = {
  date: string; // local YYYY-MM-DD
  metricType: string; // ^[a-z0-9_]+$
  value: number;
  unit: string | null;
  sourceDevice: WearableDevice;
  /** Deterministic re-sync key; NEVER null on the ingest path. */
  sourceRawId: string;
  startTime: string | null;
  endTime: string | null;
  /** JSON-serialisable provenance blob; stored in `metadata`. */
  metadata: Record<string, unknown>;
};

const METRIC_TYPE_SHAPE = /^[a-z0-9_]+$/;

/**
 * The metric whose `source_raw_id` is a GLOBAL identity rather than a per-device
 * one — a HealthKit workout UUID names one object in the HealthKit store, and
 * the same UUID under two `source_device` buckets is the same session twice.
 *
 * Every other ingested row is keyed `hk:<metric>:<date>`, which is deliberately
 * per-device: two devices reporting HRV on one day are two readings and the read
 * side arbitrates between them. A workout has no such reading to arbitrate.
 */
const GLOBAL_IDENTITY_METRIC = 'workout';

const UPSERT_COLUMNS = `INSERT INTO wearable_data
   (id, date, metric_type, value, unit, source_device, source_raw_id,
    start_time, end_time, metadata)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** The shared "did anything actually change?" guard, minus source_device. */
const CHANGED = `wearable_data.value IS NOT excluded.value
    OR wearable_data.date IS NOT excluded.date
    OR wearable_data.unit IS NOT excluded.unit
    OR wearable_data.start_time IS NOT excluded.start_time
    OR wearable_data.end_time IS NOT excluded.end_time
    OR wearable_data.metadata IS NOT excluded.metadata`;

/** Day-bucket rows: identity is (device, `hk:<metric>:<date>`) — the 0001 index. */
const DAY_BUCKET_UPSERT_SQL = `${UPSERT_COLUMNS}
 ON CONFLICT (source_device, source_raw_id) WHERE source_raw_id IS NOT NULL
 DO UPDATE SET
   date = excluded.date,
   metric_type = excluded.metric_type,
   value = excluded.value,
   unit = excluded.unit,
   start_time = excluded.start_time,
   end_time = excluded.end_time,
   metadata = excluded.metadata
 WHERE ${CHANGED}`;

/**
 * Workouts: identity is the HealthKit UUID alone — the 0042 partial index.
 * `source_device` is in the SET (not just the WHERE) because correcting a
 * mis-bucketed source is the whole point of keying on the UUID.
 */
const WORKOUT_UPSERT_SQL = `${UPSERT_COLUMNS}
 ON CONFLICT (source_raw_id) WHERE metric_type = 'workout' AND source_raw_id IS NOT NULL
 DO UPDATE SET
   date = excluded.date,
   metric_type = excluded.metric_type,
   value = excluded.value,
   unit = excluded.unit,
   source_device = excluded.source_device,
   start_time = excluded.start_time,
   end_time = excluded.end_time,
   metadata = excluded.metadata
 WHERE ${CHANGED}
    OR wearable_data.source_device IS NOT excluded.source_device`;

/**
 * The window a pass is reconciling, and which metrics it may reconcile.
 *
 * See {@link upsertWearableRows}'s "re-window" note. `metricTypes` is an
 * allow-list, never derived from `rows` inside this function: the caller is the
 * only party that knows whether a metric produced NOTHING because there is
 * nothing there, or because the read failed.
 */
export type DayBucketWindow = {
  /** Inclusive first local day of the pass's window. */
  first: string;
  /** Inclusive last local day of the pass's window (today). */
  last: string;
  /** Metric types this pass read cleanly and may therefore prune. */
  metricTypes: readonly string[];
};

/** Day-bucket raw ids are `hk:<metric>:<date>`; GLOB is case-sensitive where
 *  LIKE is not, and `hk:*` contains no GLOB metacharacter. */
const HK_BUCKET_GLOB = 'hk:*';

/**
 * Insert-or-update a batch of ingested rows in one transaction. The DO UPDATE
 * only fires a real write (and the updated_at trigger) when something actually
 * changed, so a quiet re-sync of an unchanged fortnight doesn't churn every
 * row's updated_at.
 *
 * ## The re-window pass also DELETES what it did not produce (2026-09-14)
 *
 * Until now this function only INSERTed and UPDATEd, and
 * docs/spikes/timezone-days.md §1c named the defect that leaves:
 *
 * > *"If every sample that used to fall on a day migrates off it, no row is
 * > emitted for that day and the stale row from the previous zone is left
 * > standing, now describing nothing."*
 *
 * The 14-day pass re-buckets samples into the CURRENT zone's calendar days, and
 * the bucket key `hk:<metric>:<date>` embeds the date — so a sample that moves
 * from the 1st to the 2nd writes a new row on the 2nd and orphans the row on the
 * 1st. Readiness baselines and every Coach correlation read those rows. A
 * timezone trip is only the loudest cause; a sample deleted in the Health app
 * strands a bucket exactly the same way, and always did.
 *
 * So when `prune` is supplied, the pass reconciles rather than merely adding:
 * **every `hk:` bucket inside the window, for a metric this pass produced, that
 * this pass did NOT produce, is deleted** — in the same transaction as the
 * upserts, so a reader can never observe the half-state.
 *
 * Four scoping rules, each of which is the difference between a fix and a data
 * loss:
 *
 *   1. **`hk:` raw ids only.** A manual capture leaves `source_raw_id` NULL and
 *      is untouched — the same line water's editability already draws. A
 *      hand-logged glass must never be deleted by a sync.
 *   2. **Per metric; only metrics the caller allow-lists, AND only metrics this
 *      batch actually produced a bucket for.** A pass that read nothing for HRV
 *      — a refused predicate, a denied permission, a native throw — must not
 *      read that as "HealthKit has no HRV" and delete the fortnight. Two
 *      independent guards, deliberately: the caller allow-lists only metrics
 *      whose read reported no error (`sync.ts`), and this function additionally
 *      refuses to prune a metric that produced nothing, so an empty batch can
 *      never empty the window whatever it was handed.
 *   3. **Inside the window only.** The same `[first, last]` bounds
 *      `clampRowsToWindow` uses, so the half-day lead-in that produces rows for
 *      the day BEFORE the window cannot reach back and delete settled history.
 *   4. **Identity is `(source_device, source_raw_id)`**, matching the conflict
 *      key. Two devices reporting HRV on one day are two rows the read side
 *      arbitrates between, so they are reconciled independently: the device that
 *      still reports keeps its row, and the one whose samples are no longer in
 *      HealthKit for that day loses its own — which is the case, because the
 *      read is not source-filtered, so anything still there was re-emitted.
 *      Keying on the raw id alone would instead let one device's fresh row
 *      shelter another's orphan under the same key.
 *
 * Workouts are excluded by construction: their raw id is a HealthKit UUID, not
 * an `hk:` bucket key, so rule 1 skips them. That is deliberate — a workout row
 * is per-object, and `recentWearableWorkouts` already arbitrates duplicates.
 *
 * **Two conflict targets, because there are two kinds of identity here** (see
 * {@link GLOBAL_IDENTITY_METRIC}). Day-bucket rows conflict on the 0001
 * `(source_device, source_raw_id)` index; workouts conflict on the 0042
 * `source_raw_id`-alone partial index, and their DO UPDATE additionally
 * rewrites `source_device`.
 *
 * That last detail is the actual duplicate bug, and it is not hypothetical.
 * `sourceDeviceFor` buckets on `provenance.bundleId`, and `provenanceOf` yields
 * a null bundle id whenever a sample's `sourceRevision` arrives in a shape the
 * seam cannot parse — which lands the workout in 'other'. Parse it successfully
 * on the next sync and the same UUID lands in 'garmin'. Under a
 * `(source_device, source_raw_id)` key those are two different rows, so one
 * session appears twice and re-appears every time the bucket flips. Keying on
 * the UUID alone makes the second pass an UPDATE that corrects the label.
 *
 * The return is the count of rows this pass ACTUALLY WROTE — inserted, or
 * updated with a real change — mirroring the DO UPDATE … WHERE-CHANGED guard so
 * a quiet re-sync of an unchanged fortnight reports 0, not the whole batch. The
 * `Database` seam exposes no `changes()`, so each row is pre-checked against its
 * conflict key (the same approach `upsertHealthBodyRows` takes in body.ts),
 * which keeps `HealthSyncResult.rowsWritten` honest across both halves.
 */
export function upsertWearableRows(
  db: Database,
  rows: WearableUpsert[],
  prune?: DayBucketWindow
): number {
  if (rows.length === 0) return 0;
  for (const row of rows) {
    if (!METRIC_TYPE_SHAPE.test(row.metricType)) {
      throw new Error(`upsertWearableRows: bad metric_type "${row.metricType}"`);
    }
    if (!Number.isFinite(row.value)) {
      throw new Error(`upsertWearableRows: non-finite value for "${row.metricType}"`);
    }
    if (row.sourceRawId.length === 0) {
      throw new Error(`upsertWearableRows: empty source_raw_id for "${row.metricType}"`);
    }
  }
  let written = 0;
  db.transaction(() => {
    for (const row of rows) {
      const metadata = JSON.stringify(row.metadata);
      const isWorkout = row.metricType === GLOBAL_IDENTITY_METRIC;
      if (upsertChangesRow(db, row, metadata, isWorkout)) written++;
      db.run(isWorkout ? WORKOUT_UPSERT_SQL : DAY_BUCKET_UPSERT_SQL, [
        newId(db),
        row.date,
        row.metricType,
        row.value,
        row.unit,
        row.sourceDevice,
        row.sourceRawId,
        row.startTime,
        row.endTime,
        metadata,
      ]);
    }
    if (prune) written += pruneStaleDayBuckets(db, rows, prune);
  });
  return written;
}

/**
 * Delete the `hk:` day buckets this pass was responsible for and did not
 * produce. Called INSIDE {@link upsertWearableRows}' transaction, after the
 * upserts, so the keep-set rows are already present and no reader sees a window
 * mid-reconciliation. Returns the number of rows removed, which joins
 * `rowsWritten` — a delete is a change the pass made, and reporting it as
 * nothing would make "0 rows changed" a lie on the one pass that mattered.
 *
 * The keep-set is keyed `${device}|${rawId}` because that is the conflict key
 * (see rule 4 above). `rows` is the CLAMPED batch, so the keep-set and the
 * window agree by construction.
 *
 * Nothing is pruned for a metric this batch produced no bucket for, even when
 * the caller allow-listed it — that is the "a pass that PRODUCES buckets"
 * half of the rule, and it is enforced here rather than trusted to the caller.
 */
function pruneStaleDayBuckets(
  db: Database,
  rows: readonly WearableUpsert[],
  prune: DayBucketWindow
): number {
  const allowed = new Set(prune.metricTypes);
  if (allowed.size === 0) return 0;
  // **A metric is reconciled only if this batch PRODUCED a bucket for it.** The
  // caller's allow-list says "I read this cleanly"; this says "and it returned
  // something". Both halves are needed, and this half lives here because it is
  // the one that cannot be got wrong by a future caller: an empty batch can
  // never empty the window, whatever it allow-lists.
  const produced = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!allowed.has(row.metricType)) continue;
    const keys = produced.get(row.metricType) ?? new Set<string>();
    keys.add(`${row.sourceDevice}|${row.sourceRawId}`);
    produced.set(row.metricType, keys);
  }
  let removed = 0;
  for (const [metricType, keep] of produced) {
    const existing = db.all<{ id: string; source_device: string; source_raw_id: string }>(
      `SELECT id, source_device, source_raw_id FROM wearable_data
       WHERE metric_type = ? AND date >= ? AND date <= ? AND source_raw_id GLOB ?`,
      [metricType, prune.first, prune.last, HK_BUCKET_GLOB]
    );
    for (const row of existing) {
      if (keep.has(`${row.source_device}|${row.source_raw_id}`)) continue;
      db.run('DELETE FROM wearable_data WHERE id = ?', [row.id]);
      removed++;
    }
  }
  return removed;
}

/** The columns the upsert compares — the CHANGED guard, read back as a row. */
type UpsertProbe = Pick<
  WearableDataRow,
  'value' | 'date' | 'unit' | 'start_time' | 'end_time' | 'metadata' | 'source_device'
>;

/**
 * Would this upsert write? True when no row holds the conflict key (an INSERT)
 * or the existing row differs on any field the DO UPDATE … WHERE clause guards.
 * The conflict key matches the SQL: `(source_device, source_raw_id)` for
 * day-bucket rows, `source_raw_id` alone for a workout (which additionally
 * rewrites `source_device`, so a bucket flip counts as a change here too).
 */
function upsertChangesRow(
  db: Database,
  row: WearableUpsert,
  metadata: string,
  isWorkout: boolean
): boolean {
  const existing = isWorkout
    ? db.get<UpsertProbe>(
        `SELECT value, date, unit, start_time, end_time, metadata, source_device
         FROM wearable_data WHERE source_raw_id = ? AND metric_type = 'workout'`,
        [row.sourceRawId]
      )
    : db.get<UpsertProbe>(
        `SELECT value, date, unit, start_time, end_time, metadata, source_device
         FROM wearable_data WHERE source_device = ? AND source_raw_id = ?`,
        [row.sourceDevice, row.sourceRawId]
      );
  if (!existing) return true;
  return (
    existing.value !== row.value ||
    existing.date !== row.date ||
    existing.unit !== row.unit ||
    existing.start_time !== row.startTime ||
    existing.end_time !== row.endTime ||
    existing.metadata !== metadata ||
    (isWorkout && existing.source_device !== row.sourceDevice)
  );
}

/**
 * Which source wins when several report the same metric on the same day.
 * Dedicated wearables first (they measure; the Watch is the richest default),
 * then the merged transport, then manual — manual still counts when it is all
 * there is (keypad HRV/RHR predate this pipeline).
 */
export const SOURCE_PRIORITY: readonly WearableDevice[] = [
  'apple_watch',
  'oura',
  'whoop',
  'ultrahuman',
  'garmin',
  'eight_sleep',
  'withings',
  'other',
  'apple_health',
  'manual',
];

function priorityOf(device: string): number {
  const index = SOURCE_PRIORITY.indexOf(device as WearableDevice);
  return index === -1 ? SOURCE_PRIORITY.length : index;
}

/** Display names for source_device values (chips, metric details). */
const DEVICE_LABELS: Record<WearableDevice, string> = {
  oura: 'Oura',
  whoop: 'WHOOP',
  ultrahuman: 'Ultrahuman',
  apple_watch: 'Apple Watch',
  garmin: 'Garmin',
  eight_sleep: 'Eight Sleep',
  withings: 'Withings',
  apple_health: 'Apple Health',
  manual: 'Manual',
  other: 'Other',
};

export function deviceLabel(device: WearableDevice): string {
  return DEVICE_LABELS[device] ?? device;
}

/** A day's value for one metric after source arbitration, or null. */
export type DailyMetricPoint = {
  date: string;
  value: number;
  sourceDevice: WearableDevice;
  startTime: string | null;
  endTime: string | null;
  metadata: string;
};

/**
 * The winning row per day for a metric over the trailing `days` window
 * (oldest → newest, gaps simply absent). Arbitration happens in TS — the
 * window is small and the priority rule stays in one testable place.
 */
export function dailyMetricSeries(
  db: Database,
  metricType: string,
  days: number,
  today: string
): DailyMetricPoint[] {
  const rows = db.all<WearableDataRow>(
    `SELECT * FROM wearable_data
     WHERE metric_type = ? AND date <= ? AND date > date(?, '-' || ? || ' days')
     ORDER BY date`,
    [metricType, today, today, days]
  );
  const byDate = new Map<string, WearableDataRow>();
  for (const row of rows) {
    const current = byDate.get(row.date);
    if (!current || priorityOf(row.source_device) < priorityOf(current.source_device)) {
      byDate.set(row.date, row);
    }
  }
  return [...byDate.values()]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((row) => ({
      date: row.date,
      value: row.value,
      sourceDevice: row.source_device,
      startTime: row.start_time,
      endTime: row.end_time,
      metadata: row.metadata,
    }));
}

/** The single winning value for one metric on one day, or null. */
export function pickDailyMetric(
  db: Database,
  metricType: string,
  date: string
): DailyMetricPoint | null {
  const series = dailyMetricSeries(db, metricType, 1, date);
  const last = series[series.length - 1];
  return last && last.date === date ? last : null;
}

/** Latest row for a metric regardless of window — "last known, as of" reads. */
export function latestMetric(db: Database, metricType: string): DailyMetricPoint | null {
  // The newest day's rows only — at most one per source_device (10 buckets),
  // so the LIMIT can never clip a same-day contender.
  const rows = db.all<WearableDataRow>(
    `SELECT * FROM wearable_data
     WHERE metric_type = ? AND date = (SELECT max(date) FROM wearable_data WHERE metric_type = ?)`,
    [metricType, metricType]
  );
  if (rows.length === 0) return null;
  const topDate = rows[0]!.date;
  let winner = rows[0]!;
  for (const row of rows) {
    if (row.date !== topDate) break;
    if (priorityOf(row.source_device) < priorityOf(winner.source_device)) winner = row;
  }
  return {
    date: winner.date,
    value: winner.value,
    sourceDevice: winner.source_device,
    startTime: winner.start_time,
    endTime: winner.end_time,
    metadata: winner.metadata,
  };
}

/**
 * Every source that wrote any row, of any metric, in the trailing `days`
 * window — sorted, no repeats. The evidence behind naming WHY a metric never
 * arrives: a Garmin that sent sleep this fortnight is the reason there is no
 * HRV (src/lib/home/metric-sync.ts). `apple_health` (merged statistics) and
 * `manual` are sources like any other and come back as such.
 */
export function recentSourceDevices(db: Database, today: string, days: number): WearableDevice[] {
  return db
    .all<{ source_device: WearableDevice }>(
      `SELECT DISTINCT source_device FROM wearable_data
       WHERE date <= ? AND date > date(?, '-' || ? || ' days')
       ORDER BY source_device`,
      [today, today, days]
    )
    .map((row) => row.source_device);
}

/** A recent ingested workout, for the Data-tab history list. */
export type WearableWorkout = {
  date: string;
  durationMin: number;
  sourceDevice: WearableDevice;
  startTime: string | null;
  /** Parsed metadata: activity name/raw type, kcal, distance when present. */
  activity: string | null;
  kcal: number | null;
  /**
   * Heart rate during the session (docs §15) — both or neither, null when the
   * row carries no figure. This screen IS the ingest record, so what the watch
   * measured belongs on it.
   */
  avgHr: number | null;
  maxHr: number | null;
  /**
   * True when this session is PAIRED to one the owner logged in ARC (0054) —
   * the same workout, recorded twice. The row still appears, because this screen
   * IS the ingest record and hiding a real HealthKit object from it would make
   * the record incomplete; it says "logged in ARC" instead, so the reader can
   * never count it as a second session.
   */
  loggedInArc: boolean;
};

/** A span in epoch milliseconds — what {@link overlapFraction} compares. */
export type TimeSpan = { start: number; end: number };

/**
 * A workout row's usable time span, or null when it cannot be reasoned about.
 * Exported since 0054: pairing a manual session to an ingested one asks the same
 * question of the same rows, and a second reading of `start_time`/`end_time`
 * would be a second definition of what a readable span is.
 */
export function workoutSpan(row: WearableDataRow): TimeSpan | null {
  if (!row.start_time || !row.end_time) return null;
  return parseSpan(row.start_time, row.end_time);
}

/**
 * Read `metadata.hr` off a decoded workout blob — both members or neither
 * (docs/wearables-subapp.md §15).
 *
 * Exported for the same reason {@link workoutSpan} is: this file and
 * `workout-ingest.ts` are two independent decoders of one JSON blob, and two
 * readings of what counts as a usable figure would agree right up until one of
 * them was tuned. An average with no maximum is half a reading and is refused
 * as such, which is the rule the seam applies when it writes the key.
 */
export function readWorkoutHr(meta: Record<string, unknown>): {
  avgHr: number | null;
  maxHr: number | null;
} {
  const hr =
    typeof meta.hr === 'object' && meta.hr !== null ? (meta.hr as Record<string, unknown>) : null;
  const avg =
    hr && typeof hr.avg === 'number' && Number.isFinite(hr.avg) ? Math.round(hr.avg) : null;
  const max =
    hr && typeof hr.max === 'number' && Number.isFinite(hr.max) ? Math.round(hr.max) : null;
  return avg !== null && max !== null ? { avgHr: avg, maxHr: max } : { avgHr: null, maxHr: null };
}

/**
 * Two ISO instants → a span, or null when they do not make one (unparseable, or
 * an end at or before its start). The shared parse behind {@link workoutSpan}
 * and the manual side of pairing, which reads `workouts.started_at` plus a
 * duration rather than two columns.
 */
export function parseSpan(startIso: string, endIso: string): TimeSpan | null {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

/**
 * Fraction of the SHORTER session that two spans share. Measuring against the
 * shorter one is deliberate: a watch that records a 62-minute session and a
 * phone that catches 48 minutes of it are the same workout, and dividing by the
 * longer span would score that 0.77 against a union-based 0.48 and start
 * depending on which source happened to be more generous.
 *
 * Exported since 0054. It is the app's ONE definition of "the same session", and
 * pairing an ingested row to a logged one reuses it rather than inventing a
 * second: two definitions agree right up until one of them is tuned.
 */
export function overlapFraction(a: TimeSpan, b: TimeSpan): number {
  const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  if (overlap <= 0) return 0;
  return overlap / Math.min(a.end - a.start, b.end - b.start);
}

/** Above this shared fraction, two rows are treated as one real session. */
export const SAME_SESSION_OVERLAP = 0.5;

/** {@link SOURCE_PRIORITY} rank of a device — lower wins. Exported for pairing. */
export function sourcePriorityOf(device: string): number {
  return priorityOf(device);
}

/**
 * Recent HealthKit-ingested workouts, newest first, with **same-session
 * duplicates collapsed**.
 *
 * The UUID identity fixed at 0042 stops ONE session becoming two rows across
 * re-syncs. It cannot help with the other duplicate, which is the one a Garmin
 * user actually sees: a single run recorded by both Garmin Connect and the
 * iPhone arrives as two genuinely distinct HealthKit objects with two distinct
 * UUIDs. Both rows are true; listing both is not, because the user did not do
 * two runs.
 *
 * So the same {@link SOURCE_PRIORITY} arbitration every other metric already
 * gets is applied here — this list was the only wearable read in the file doing
 * a bare SELECT with no arbitration at all, which is why it was the only one
 * that looked duplicated. Rows whose span cannot be read are never collapsed:
 * an unreasonable row is kept, never silently dropped.
 */
export function recentWearableWorkouts(db: Database, limit: number): WearableWorkout[] {
  // Over-fetch, because collapsing happens after the read — a straight
  // `LIMIT ?` could hand back a page that is entirely one duplicated session.
  const pool = db.all<WearableDataRow>(
    `SELECT * FROM wearable_data WHERE metric_type = 'workout'
     ORDER BY date DESC, start_time DESC LIMIT ?`,
    [Math.max(limit * 4, 40)]
  );

  const kept: { row: WearableDataRow; span: { start: number; end: number } | null }[] = [];
  for (const row of pool) {
    const span = workoutSpan(row);
    if (span) {
      const twin = kept.find(
        (k) => k.span !== null && overlapFraction(k.span, span) >= SAME_SESSION_OVERLAP
      );
      if (twin) {
        // Same session, two recorders: keep the better source, and on a tie the
        // longer record (a truncated copy tells you less about the session).
        const incumbent = priorityOf(twin.row.source_device);
        const challenger = priorityOf(row.source_device);
        const longer = span.end - span.start > twin.span!.end - twin.span!.start;
        if (challenger < incumbent || (challenger === incumbent && longer)) {
          twin.row = row;
          twin.span = span;
        }
        continue;
      }
    }
    kept.push({ row, span });
  }

  const shown = kept.slice(0, limit);
  // One statement for the whole page rather than one per row: the ids are known
  // by now, and the alternative is the N+1 every other read in this layer
  // refuses. A device with no links reads an empty set and the join costs
  // nothing.
  const linked = new Set(
    shown.length === 0
      ? []
      : db
          .all<{ wearable_id: string }>(
            `SELECT wearable_id FROM workout_ingest_links WHERE wearable_id IN (${shown
              .map(() => '?')
              .join(',')})`,
            shown.map(({ row }) => row.id)
          )
          .map((r) => r.wearable_id)
  );

  return shown.map(({ row }) => {
    let activity: string | null = null;
    let kcal: number | null = null;
    // Read through the SAME helper the pairing decoder uses, so the two
    // independent readers of this blob cannot disagree about what counts as a
    // readable heart-rate figure.
    let hr: { avgHr: number | null; maxHr: number | null } = { avgHr: null, maxHr: null };
    try {
      const meta = JSON.parse(row.metadata) as Record<string, unknown>;
      if (typeof meta.activity === 'string') activity = meta.activity;
      if (typeof meta.kcal === 'number' && Number.isFinite(meta.kcal)) kcal = meta.kcal;
      hr = readWorkoutHr(meta);
    } catch {
      // Metadata is CHECK-validated JSON; a parse miss just drops the extras.
    }
    return {
      date: row.date,
      durationMin: row.value,
      sourceDevice: row.source_device,
      startTime: row.start_time,
      activity,
      kcal,
      avgHr: hr.avgHr,
      maxHr: hr.maxHr,
      loggedInArc: linked.has(row.id),
    };
  });
}

/**
 * HealthKit UUIDs of workout rows that already carry a heart-rate figure — the
 * heart-rate probe's skip set (docs/wearables-subapp.md §15).
 *
 * One statement for the whole pass rather than a check per session, and it asks
 * the stored JSON directly (`json_extract`, SQLite's json1 is built in) rather
 * than decoding fourteen days of metadata in JS to answer a yes/no.
 *
 * It gates door TWO only. Door one — the figure the writer itself associated
 * with the session — is re-read every pass for every session on purpose, and the
 * upsert's CHANGED guard decides whether that costs a write.
 */
export function workoutUuidsWithHr(db: Database): Set<string> {
  return new Set(
    db
      .all<{ source_raw_id: string }>(
        `SELECT source_raw_id FROM wearable_data
          WHERE metric_type = ? AND source_raw_id IS NOT NULL
            AND json_extract(metadata, '$.hr') IS NOT NULL`,
        [GLOBAL_IDENTITY_METRIC]
      )
      .map((r) => r.source_raw_id)
  );
}

// --- health_sync_state (0021) — the sync cursor KV --------------------------

/** The JSON under health_sync_state.value for key 'apple_health'. */
export type HealthSyncState = {
  /** ISO instant of the last completed sync; drives windowing + throttle. */
  lastSyncedAt: string | null;
  /** ISO instant of the first completed sync (the 90-day backfill). */
  firstSyncedAt: string | null;
  /**
   * ISO instant of the ONE pass that re-read history under the offset-aware
   * bucketing (0060), or null when it has not happened. No migration: 0021 left
   * this value free JSON exactly so a second cursor would not be a schema
   * change. See `rebucketWindowDays` in src/lib/health/sync.ts for why it is
   * stamped only once a pass has both landed data and had rows to widen for.
   */
  rebucketedAt: string | null;
};

export const HEALTH_SYNC_KEY = 'apple_health';

export function getHealthSyncState(db: Database, key: string = HEALTH_SYNC_KEY): HealthSyncState {
  const row = db.get<{ value: string }>('SELECT value FROM health_sync_state WHERE key = ?', [key]);
  const state: HealthSyncState = { lastSyncedAt: null, firstSyncedAt: null, rebucketedAt: null };
  if (!row) return state;
  try {
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    if (typeof parsed.lastSyncedAt === 'string') state.lastSyncedAt = parsed.lastSyncedAt;
    if (typeof parsed.firstSyncedAt === 'string') state.firstSyncedAt = parsed.firstSyncedAt;
    if (typeof parsed.rebucketedAt === 'string') state.rebucketedAt = parsed.rebucketedAt;
  } catch {
    // Corrupt state reads as "never synced" — the next sync self-heals it.
  }
  return state;
}

export function setHealthSyncState(
  db: Database,
  state: HealthSyncState,
  key: string = HEALTH_SYNC_KEY
): void {
  db.run(
    `INSERT INTO health_sync_state (id, key, value) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [newId(db), key, JSON.stringify(state)]
  );
}

// --- The OUTBOUND cursor (2026-08-12) ---------------------------------------
//
// ARC publishes weight / body fat / waist to Apple Health. This is its cursor,
// and it needs NO MIGRATION: `health_sync_state` is a KV whose `key` carries no
// CHECK and whose `value` is free JSON — 0021 wrote that shape down explicitly
// so a second integration cursor would not be a schema change. A separate key
// rather than more fields under 'apple_health' keeps the two directions
// independent: re-arming publishing must not disturb the ingest backfill logic,
// which reads `firstSyncedAt` to decide whether to pull 90 days.

/** The JSON under health_sync_state.value for key 'apple_health_publish'. */
export type HealthPublishState = {
  /**
   * ISO instant the outbound channel was first armed, or null when it never has
   * been. Arming is what implements the no-backfill policy: on the first pass
   * the cursor jumps straight to the newest existing `body_metrics` row, so
   * every measurement recorded BEFORE ARC could publish stays where it is.
   * Distinguishing "armed, cursor null (table was empty)" from "never armed" is
   * the whole reason this field exists.
   */
  armedAt: string | null;
  /** `created_at` of the last fully-published `body_metrics` row. */
  cursorCreatedAt: string | null;
  /** That row's id — the tiebreak half of the (created_at, id) keyset. */
  cursorId: string | null;
  /** ISO instant of the last pass that actually wrote a sample. */
  lastPublishedAt: string | null;
};

export const HEALTH_PUBLISH_KEY = 'apple_health_publish';

/**
 * The WATER walk's cursor (2026-09-21) — a fourth key in the same KV, the same
 * {@link HealthPublishState} shape, and no migration for the same reason the
 * first three needed none: `key` carries no CHECK and `value` is free JSON.
 * Its own key rather than a field on the body cursor because the two walks
 * cover different tables and arm at different times: the body cursor armed in
 * August, and water's arms on the first pass after the build that carries it.
 */
export const HEALTH_WATER_PUBLISH_KEY = 'apple_health_publish_water';

export function getHealthPublishState(
  db: Database,
  key: string = HEALTH_PUBLISH_KEY
): HealthPublishState {
  const row = db.get<{ value: string }>('SELECT value FROM health_sync_state WHERE key = ?', [key]);
  const state: HealthPublishState = {
    armedAt: null,
    cursorCreatedAt: null,
    cursorId: null,
    lastPublishedAt: null,
  };
  if (!row) return state;
  try {
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    if (typeof parsed.armedAt === 'string') state.armedAt = parsed.armedAt;
    if (typeof parsed.cursorCreatedAt === 'string') state.cursorCreatedAt = parsed.cursorCreatedAt;
    if (typeof parsed.cursorId === 'string') state.cursorId = parsed.cursorId;
    if (typeof parsed.lastPublishedAt === 'string') state.lastPublishedAt = parsed.lastPublishedAt;
  } catch {
    // Corrupt state reads as "never armed", so the next pass re-arms at the
    // newest row and republishes nothing. Erring toward silence is right here:
    // the alternative failure mode is re-posting history no one can delete.
  }
  return state;
}

export function setHealthPublishState(
  db: Database,
  state: HealthPublishState,
  key: string = HEALTH_PUBLISH_KEY
): void {
  db.run(
    `INSERT INTO health_sync_state (id, key, value) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [newId(db), key, JSON.stringify(state)]
  );
}

// --- The DIAGNOSTIC log (2026-08-26) ----------------------------------------
//
// A third key in the same KV, and for the same reason the second one needed no
// migration: `key` carries no CHECK and `value` is free JSON. It holds ONE
// record — the last pass — overwritten every sync. Diagnostics, not history: a
// trend of syncs would be a table, and nothing here is worth one.
//
// It exists because the failure it describes was silent. Weight stopped
// arriving from Apple Health and no surface in the app could say which step
// produced zero, so the only available bug report was "not working". The log is
// what makes the next one specific.

/** The JSON under health_sync_state.value for key 'apple_health_log'. */
export const HEALTH_LOG_KEY = 'apple_health_log';

/**
 * The last pass's log, or null when there has never been one (or the stored row
 * is unreadable). Corrupt reads as absent for the same reason the cursors do:
 * this powers the screen a user opens when something is already wrong, and it
 * must not be the thing that breaks there.
 */
export function getHealthSyncLog(db: Database, key: string = HEALTH_LOG_KEY): HealthSyncLog | null {
  const row = db.get<{ value: string }>('SELECT value FROM health_sync_state WHERE key = ?', [key]);
  if (!row) return null;
  try {
    return parseSyncLog(JSON.parse(row.value));
  } catch {
    return null;
  }
}

export function setHealthSyncLog(
  db: Database,
  log: HealthSyncLog,
  key: string = HEALTH_LOG_KEY
): void {
  db.run(
    `INSERT INTO health_sync_state (id, key, value) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [newId(db), key, JSON.stringify(log)]
  );
}

// --- What ARC has ASKED FOR (2026-09-19) ------------------------------------
//
// A fourth key in the same KV, needing no migration for the third time — that
// is what 0021 bought by writing `value` as free JSON with no CHECK on `key`.
//
// It exists because of an asymmetry that bites exactly once per scope, silently:
// adding an identifier to HEALTH_READ_IDENTIFIERS asks NOBODY anything on an
// install that has already answered the permission sheet. iOS presents a sheet
// only for types the user has not answered, so a late scope on an existing
// install is requested, granted nothing, and reads empty forever — looking
// exactly like a source that does not write it. This records which identifiers
// a request has actually covered, so Settings can offer a control that is not a
// no-op. It is NEVER a record of grants: iOS does not reveal those.

/** The JSON under health_sync_state.value for key 'apple_health_scopes'. */
export const HEALTH_SCOPES_KEY = 'apple_health_scopes';

/**
 * Which read scopes ARC has asked for, or null when it has never stamped one.
 *
 * Null and "asked for nothing" are deliberately the same answer downstream
 * (`unaskedReadScopes` treats both as every scope unasked): the safe direction
 * is to offer the control, because tapping it on a fully-answered device costs
 * one no-op sheet request and nothing else.
 */
export function getHealthScopeStamp(
  db: Database,
  key: string = HEALTH_SCOPES_KEY
): HealthScopeStamp | null {
  const row = db.get<{ value: string }>('SELECT value FROM health_sync_state WHERE key = ?', [key]);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    if (!Array.isArray(parsed.askedFor)) return null;
    return { askedFor: parsed.askedFor.filter((id): id is string => typeof id === 'string') };
  } catch {
    // Corrupt reads as "never asked" — the control reappears and re-stamps.
    return null;
  }
}

/**
 * Record that a permission request covering `identifiers` was PROCESSED.
 *
 * Accumulative rather than replacing: a pass that asked for a narrower list
 * must not un-say what an earlier, wider one already asked for.
 */
export function stampHealthScopes(
  db: Database,
  identifiers: readonly string[],
  key: string = HEALTH_SCOPES_KEY
): void {
  const asked = new Set(getHealthScopeStamp(db, key)?.askedFor ?? []);
  for (const id of identifiers) asked.add(id);
  const stamp: HealthScopeStamp = { askedFor: [...asked].sort() };
  db.run(
    `INSERT INTO health_sync_state (id, key, value) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [newId(db), key, JSON.stringify(stamp)]
  );
}
