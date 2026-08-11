/**
 * Today's Mission, backed by `daily_logs` + `log_entries`.
 *
 * A `log_entry` row is richer in presentation than its columns: the mission UI
 * wants a display `category`, a `why` line, an estimate, and a protocol name.
 * Until the protocol→mission generator exists, those presentation extras live
 * in `log_entries.value` (the schema's "type-dependent payload" json), and the
 * `type` column still carries a real value for later logic. `toMissionItem`
 * reads both back out.
 */
import type { Database } from '../database';
import { newId } from '../id';
import type { DailyLogRow, LogEntryRow, LogEntryStatus, LogEntryType } from '../types';
import type { MissionItem, MissionStatus } from '@/types/home';

/** Presentation extras stashed in log_entries.value as JSON. */
type MissionExtras = {
  category?: string;
  why?: string;
  estimatedMinutes?: number;
  protocol?: string;
  /** True for demo rows planted by the seed — purgeable once real data exists. */
  seed?: boolean;
};

/** Fallback display label when an entry has no stored `category`. */
const CATEGORY_BY_TYPE: Record<LogEntryType, string> = {
  habit: 'Routine',
  meal: 'Nutrition',
  workout: 'Training',
  supplement: 'Supplements',
  medication: 'Medications',
  therapy: 'Therapies',
  metric: 'Metrics',
  note: 'Notes',
};

function parseExtras(value: string | null): MissionExtras {
  if (!value) return {};
  try {
    return JSON.parse(value) as MissionExtras;
  } catch {
    return {};
  }
}

/** Map a stored row to the Home view-model. */
export function toMissionItem(row: LogEntryRow): MissionItem {
  const extras = parseExtras(row.value);
  return {
    id: row.id,
    title: row.title,
    scheduledTime: row.scheduled_time ?? undefined,
    status: row.status as MissionStatus,
    category: extras.category ?? CATEGORY_BY_TYPE[row.type],
    why: extras.why,
    estimatedMinutes: extras.estimatedMinutes,
    protocol: extras.protocol,
  };
}

/** The daily_log for a date, creating an empty one if absent. */
export function getOrCreateDailyLog(db: Database, date: string): DailyLogRow {
  const existing = db.get<DailyLogRow>('SELECT * FROM daily_logs WHERE date = ?', [date]);
  if (existing) return existing;
  const id = newId(db);
  db.run('INSERT INTO daily_logs (id, date) VALUES (?, ?)', [id, date]);
  return db.get<DailyLogRow>('SELECT * FROM daily_logs WHERE id = ?', [id])!;
}

/**
 * Today's mission items as view-models, ordered by scheduled time (untimed
 * last), then insertion order. Empty array if there's no daily_log yet — the
 * derivation layer sorts again, so this order is a convenience, not the source
 * of truth.
 *
 * Ad-hoc Log-tab captures (a note, a spontaneous metric — marked
 * `value.adhoc = true` by src/lib/db/repositories/logs.ts) share the
 * `log_entries` table but are NOT part of the day's plan, so they're excluded
 * here. Planned/seeded entries carry no such flag and pass through.
 */
/**
 * The SQL predicate separating a PLANNED mission row from an ad-hoc Log-tab
 * capture (`value.adhoc`, written by repositories/logs.ts). EVERY query that
 * reasons about "the day's mission" must carry it — {@link listMission},
 * {@link countMissionEntries}, and the mode re-derive (mission-generate.ts)
 * all interpolate this one string so the three can never drift apart. Omitting
 * it from a DELETE would destroy the user's Log-tab captures.
 */
export const PLANNED_ROW_SQL = "json_extract(value, '$.adhoc') IS NULL";

/**
 * A row the user removed from the day. It stays in the table as a TOMBSTONE
 * (see {@link removeMissionItem}) and must be invisible everywhere the mission
 * is shown — but visible to the mode re-derive, which is the whole point.
 */
export const NOT_REMOVED_SQL = "json_extract(value, '$.removed') IS NULL";

export function listMission(db: Database, date: string): MissionItem[] {
  const log = db.get<{ id: string }>('SELECT id FROM daily_logs WHERE date = ?', [date]);
  if (!log) return [];
  const rows = db.all<LogEntryRow>(
    `SELECT * FROM log_entries
     WHERE daily_log_id = ? AND ${PLANNED_ROW_SQL} AND ${NOT_REMOVED_SQL}
     ORDER BY (scheduled_time IS NULL), scheduled_time, created_at, id`,
    [log.id]
  );
  return rows.map(toMissionItem);
}

/**
 * Set a log entry's status, stamping completed_at only when completing.
 *
 * Completion is IDEMPOTENT: re-completing an already-completed row keeps the
 * original timestamp rather than moving a 06:40 workout to whenever the second
 * call happened. Any other status clears it, which is what un-completing means.
 */
export function setMissionStatus(db: Database, id: string, status: MissionStatus): void {
  if (status !== 'completed') {
    db.run('UPDATE log_entries SET status = ?, completed_at = NULL WHERE id = ?', [
      status as LogEntryStatus,
      id,
    ]);
    return;
  }
  db.run(
    "UPDATE log_entries SET status = 'completed', completed_at = COALESCE(completed_at, ?) WHERE id = ?",
    [new Date().toISOString(), id]
  );
}

/** Flip a log entry between completed and pending (the row-tap gesture). */
export function toggleMission(db: Database, id: string): void {
  const row = db.get<{ status: LogEntryStatus }>('SELECT status FROM log_entries WHERE id = ?', [
    id,
  ]);
  if (!row) return;
  setMissionStatus(db, id, row.status === 'completed' ? 'pending' : 'completed');
}

/**
 * Insert one mission item under a daily_log. `opts.seed` marks demo rows so they
 * stay distinguishable from real entries and can be purged when the
 * protocol→mission generator (or manual logging) replaces the seed.
 */
export function insertMissionItem(
  db: Database,
  dailyLogId: string,
  type: LogEntryType,
  item: MissionItem,
  opts: { seed?: boolean } = {}
): void {
  const extras: MissionExtras = {
    category: item.category,
    why: item.why,
    estimatedMinutes: item.estimatedMinutes,
    protocol: item.protocol,
    ...(opts.seed ? { seed: true } : {}),
  };
  db.run(
    `INSERT INTO log_entries (id, daily_log_id, type, title, status, scheduled_time, value, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(db),
      dailyLogId,
      type,
      item.title,
      item.status as LogEntryStatus,
      item.scheduledTime ?? null,
      JSON.stringify(extras),
      'manual',
    ]
  );
}

/**
 * Reschedule one PENDING planned item. Returns false when the row isn't
 * eligible (already acted on, an ad-hoc capture, or not on this day) rather
 * than throwing — the caller reports which ops applied.
 *
 * The guards mirror {@link removeMissionItem}: moving a completed item would
 * rewrite history, and an ad-hoc capture is not part of the plan.
 */
export function moveMissionItem(
  db: Database,
  dailyLogId: string,
  id: string,
  scheduledTime: string | null
): boolean {
  const row = db.get<{ id: string }>(
    `SELECT id FROM log_entries
     WHERE id = ? AND daily_log_id = ? AND status = 'pending' AND ${PLANNED_ROW_SQL}`,
    [id, dailyLogId]
  );
  if (!row) return false;
  db.run('UPDATE log_entries SET scheduled_time = ? WHERE id = ?', [scheduledTime, id]);
  return true;
}

/**
 * Remove one PENDING planned item from the day. Returns false when the row
 * isn't eligible (already acted on, an ad-hoc capture, or not on this day).
 *
 * A TOMBSTONE, not a DELETE. Deleting the row worked exactly until the next
 * mode change: `rederiveMissionForDay` recomputes the day from the protocols,
 * finds the removed item still in the plan and nothing on the day matching it,
 * and dutifully puts it back. The user's approved removal was undone by an
 * unrelated action, with no message either way.
 *
 * So the row stays, marked `removed` and settled as `skipped`:
 *   - {@link listMission} hides it, so "removed" still means removed on screen;
 *   - the re-derive counts it among the PRESERVED rows (status ≠ pending), so
 *     its plan entry is already satisfied and is never re-added;
 *   - and the day keeps an honest record that the item was planned and dropped.
 *
 * The guards below are defence in depth on a state-changing statement, exactly
 * as the re-derive does: even with a wrong id this can never reach an ad-hoc
 * Log-tab capture, an acted-on row, or another day.
 */
export function removeMissionItem(db: Database, dailyLogId: string, id: string): boolean {
  const before = db.get<{ c: number }>(
    `SELECT count(*) c FROM log_entries
     WHERE id = ? AND daily_log_id = ? AND status = 'pending'
       AND ${PLANNED_ROW_SQL} AND ${NOT_REMOVED_SQL}`,
    [id, dailyLogId]
  );
  if ((before?.c ?? 0) === 0) return false;
  db.run(
    // COALESCE: a row with a NULL value column would otherwise json_set to NULL
    // and lose the tombstone — which is precisely the row that then resurrects.
    `UPDATE log_entries
     SET status = 'skipped',
         value = json_set(COALESCE(value, '{}'), '$.removed', json('true'))
     WHERE id = ? AND daily_log_id = ? AND status = 'pending'
       AND ${PLANNED_ROW_SQL} AND ${NOT_REMOVED_SQL}`,
    [id, dailyLogId]
  );
  return true;
}

/**
 * Number of *planned* (mission) entries under a daily_log — the same rows
 * `listMission` shows, i.e. excluding ad-hoc Log-tab captures (`value.adhoc`).
 * This is what the seed guard must use: counting all rows would let a single
 * note logged before Home opens suppress the whole day's seeded mission.
 */
export function countMissionEntries(db: Database, dailyLogId: string): number {
  const row = db.get<{ c: number }>(
    `SELECT count(*) c FROM log_entries WHERE daily_log_id = ? AND ${PLANNED_ROW_SQL}`,
    [dailyLogId]
  );
  return row?.c ?? 0;
}
