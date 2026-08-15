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
 * Insert-or-update a batch of ingested rows in one transaction. The DO UPDATE
 * only fires a real write (and the updated_at trigger) when something actually
 * changed, so a quiet re-sync of an unchanged fortnight doesn't churn every
 * row's updated_at.
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
 */
export function upsertWearableRows(db: Database, rows: WearableUpsert[]): number {
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
  db.transaction(() => {
    for (const row of rows) {
      db.run(
        row.metricType === GLOBAL_IDENTITY_METRIC ? WORKOUT_UPSERT_SQL : DAY_BUCKET_UPSERT_SQL,
        [
          newId(db),
          row.date,
          row.metricType,
          row.value,
          row.unit,
          row.sourceDevice,
          row.sourceRawId,
          row.startTime,
          row.endTime,
          JSON.stringify(row.metadata),
        ]
      );
    }
  });
  return rows.length;
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

/** A recent ingested workout, for the Data-tab history list. */
export type WearableWorkout = {
  date: string;
  durationMin: number;
  sourceDevice: WearableDevice;
  startTime: string | null;
  /** Parsed metadata: activity name/raw type, kcal, distance when present. */
  activity: string | null;
  kcal: number | null;
};

/** A workout row's usable time span, or null when it cannot be reasoned about. */
function workoutSpan(row: WearableDataRow): { start: number; end: number } | null {
  if (!row.start_time || !row.end_time) return null;
  const start = new Date(row.start_time).getTime();
  const end = new Date(row.end_time).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

/**
 * Fraction of the SHORTER session that two spans share. Measuring against the
 * shorter one is deliberate: a watch that records a 62-minute session and a
 * phone that catches 48 minutes of it are the same workout, and dividing by the
 * longer span would score that 0.77 against a union-based 0.48 and start
 * depending on which source happened to be more generous.
 */
function overlapFraction(
  a: { start: number; end: number },
  b: { start: number; end: number }
): number {
  const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  if (overlap <= 0) return 0;
  return overlap / Math.min(a.end - a.start, b.end - b.start);
}

/** Above this shared fraction, two rows are treated as one real session. */
const SAME_SESSION_OVERLAP = 0.5;

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
        const longer = span.end - span.start > (twin.span!.end - twin.span!.start);
        if (challenger < incumbent || (challenger === incumbent && longer)) {
          twin.row = row;
          twin.span = span;
        }
        continue;
      }
    }
    kept.push({ row, span });
  }

  return kept.slice(0, limit).map(({ row }) => {
    let activity: string | null = null;
    let kcal: number | null = null;
    try {
      const meta = JSON.parse(row.metadata) as Record<string, unknown>;
      if (typeof meta.activity === 'string') activity = meta.activity;
      if (typeof meta.kcal === 'number' && Number.isFinite(meta.kcal)) kcal = meta.kcal;
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
    };
  });
}

// --- health_sync_state (0021) — the sync cursor KV --------------------------

/** The JSON under health_sync_state.value for key 'apple_health'. */
export type HealthSyncState = {
  /** ISO instant of the last completed sync; drives windowing + throttle. */
  lastSyncedAt: string | null;
  /** ISO instant of the first completed sync (the 90-day backfill). */
  firstSyncedAt: string | null;
};

export const HEALTH_SYNC_KEY = 'apple_health';

export function getHealthSyncState(db: Database, key: string = HEALTH_SYNC_KEY): HealthSyncState {
  const row = db.get<{ value: string }>('SELECT value FROM health_sync_state WHERE key = ?', [key]);
  const state: HealthSyncState = { lastSyncedAt: null, firstSyncedAt: null };
  if (!row) return state;
  try {
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    if (typeof parsed.lastSyncedAt === 'string') state.lastSyncedAt = parsed.lastSyncedAt;
    if (typeof parsed.firstSyncedAt === 'string') state.firstSyncedAt = parsed.firstSyncedAt;
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
