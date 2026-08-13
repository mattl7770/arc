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
import { localDaysList, todayISODate } from '../date';
import { newId } from '../id';
import type { DailyLogRow, LogEntryRow, LogEntryStatus, LogEntryType } from '../types';
import type { MissionItem, MissionStatus } from '@/types/home';

/**
 * Presentation extras stashed in log_entries.value as JSON.
 *
 * `dose` and `why` are two fields because they are two facts — a quantity and a
 * rationale — and the hero renders them in different type voices (mono measures,
 * serif speaks). They were one field until 2026-08-12, flattened by the
 * generator as `dose ?? notes`, which forced the hero to guess from the string
 * shape which one it had. Rows written before that carry a dose in `why` and no
 * `dose`; they render as prose until the mission regenerates, which is daily.
 */
type MissionExtras = {
  category?: string;
  dose?: string;
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
    dose: extras.dose,
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
    dose: item.dose,
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

/** One day of mission history — what was planned, and what was actually done. */
export interface MissionDayPoint {
  date: string;
  /** Planned items that stood on the day (tombstoned removals excluded). */
  planned: number;
  /** Of those, the ones marked completed. */
  completed: number;
  /** Marked skipped by hand. `planned - completed - skipped` is what was left
   *  pending or partial — stated as three numbers rather than one score. */
  skipped: number;
}

/**
 * Mission completion history: the last `days` calendar days, oldest → `today`
 * inclusive, zero-filled for days with no plan at all. The Data tab's Mission
 * trend, and the only place the app looks back at adherence across days.
 *
 * **It counts exactly the rows Home draws** — `PLANNED_ROW_SQL` keeps ad-hoc
 * Log-tab captures out (a note is not a plan item, and counting it would make
 * every day the user typed into look less adherent), and `NOT_REMOVED_SQL`
 * keeps tombstones out (a row the user removed from the day was never owed, so
 * it is neither a completion nor a miss). Both predicates are the shared
 * constants above, so this can never drift from {@link listMission}.
 *
 * **A day with no plan is planned: 0, not adherence: 0.** The distinction is
 * the whole reason this returns three counts instead of a percentage: a rate
 * over a day that asked nothing of you is undefined, and zero-filling it would
 * drag every average down for days the user was owed nothing. Callers that want
 * a rate compute it over days where `planned > 0` — see
 * {@link missionAdherence}.
 *
 * `today` is injectable so the headless tests are deterministic.
 */
export function missionDailySeries(
  db: Database,
  days: number = 14,
  today: string = todayISODate()
): MissionDayPoint[] {
  const dates = localDaysList(today, days);
  const rows = db.all<{ date: string; planned: number; completed: number; skipped: number }>(
    `SELECT d.date AS date,
       count(*) AS planned,
       sum(CASE WHEN e.status = 'completed' THEN 1 ELSE 0 END) AS completed,
       sum(CASE WHEN e.status = 'skipped' THEN 1 ELSE 0 END) AS skipped
     FROM log_entries e
     JOIN daily_logs d ON d.id = e.daily_log_id
     WHERE d.date >= ? AND d.date <= ?
       -- The two shared predicates go in VERBATIM, unqualified "value" and all.
       -- That is safe here and only here because daily_logs has no "value"
       -- column, so the name resolves unambiguously to log_entries.value --
       -- and interpolating them verbatim is the point: a rewritten copy would
       -- be a fourth definition of "is this a mission row", which is exactly
       -- what the constants exist to prevent.
       AND ${PLANNED_ROW_SQL}
       AND ${NOT_REMOVED_SQL}
     GROUP BY d.date`,
    [dates[0] ?? today, today]
  );
  const byDate = new Map(rows.map((r) => [r.date, r]));
  return dates.map((date) => {
    const row = byDate.get(date);
    return {
      date,
      planned: row?.planned ?? 0,
      completed: row?.completed ?? 0,
      skipped: row?.skipped ?? 0,
    };
  });
}

/**
 * Completed ÷ planned across a series, counting **only days that had a plan**.
 * Returns null when no day in the window planned anything — there is no rate to
 * state, and "0%" for a fortnight nobody was asked to do anything is a lie the
 * §5 honesty rules exist to prevent.
 */
export function missionAdherence(points: MissionDayPoint[]): number | null {
  let planned = 0;
  let completed = 0;
  for (const point of points) {
    if (point.planned === 0) continue;
    planned += point.planned;
    completed += point.completed;
  }
  return planned === 0 ? null : completed / planned;
}

/**
 * The earliest date that ever carried a planned mission row — the day the
 * execution record BEGINS. `null` when nothing has ever been planned.
 *
 * This exists because {@link missionDailySeries} zero-fills, and zero-fill
 * renders two completely different facts identically:
 *
 *   - **a day inside the record with no plan** — real, and worth seeing: no
 *     protocol was active, or none of them applied to that day;
 *   - **a day before the record existed at all** — not a fact about execution.
 *     A 14-day window over a three-day-old install is eleven days of this, and
 *     drawing them is the "fortnight of failure" lie `missionDailySeries`' own
 *     header warns about, one level up.
 *
 * app/mission-history.tsx clips its window at this date, so a young install
 * shows four rows and says "4 days on record" rather than fourteen rows of
 * nothing that read as fourteen days of not bothering.
 *
 * Same two shared predicates as everything else here, so "the record" means
 * exactly the rows Home draws.
 */
export function missionRecordStart(db: Database): string | null {
  const row = db.get<{ date: string | null }>(
    `SELECT min(d.date) AS date
       FROM log_entries e
       JOIN daily_logs d ON d.id = e.daily_log_id
      WHERE ${PLANNED_ROW_SQL} AND ${NOT_REMOVED_SQL}`
  );
  return row?.date ?? null;
}

/**
 * Where a mission row came from, and therefore whether there is a route back to
 * it. `protocol` is navigable (the protocol still exists); `protocol_gone` is a
 * protocol that has since been deleted — `log_entries.protocol_id` is
 * ON DELETE SET NULL, so the row survives and the *name* survives in its
 * extras, but there is nothing left to open; `other` is a mode item, an
 * experiment's intervention, the mock seed, or a hand-added row.
 */
export type MissionSourceKind = 'protocol' | 'protocol_gone' | 'other';

/** One repeated mission item's record across a window — a title, not a row. */
export interface MissionItemRecord {
  title: string;
  /** Days in the window this item stood on the plan. */
  planned: number;
  completed: number;
  /** Explicitly marked skipped. */
  skipped: number;
  /** Marked partial — real progress, so it is neither a completion nor a miss. */
  partial: number;
}

/**
 * Everything one SOURCE put on the plan across a window, and how much of it got
 * done. The unit of the "where am I failing" question: an individual missed
 * item is evidence, but the thing the user can actually *change* is the
 * protocol that keeps generating it.
 */
export interface MissionSourceRecord {
  /** Stable list key. Not the protocol id — a deleted protocol has none. */
  key: string;
  /** Set only when the protocol still exists, i.e. only when it is navigable. */
  protocolId: string | null;
  name: string;
  kind: MissionSourceKind;
  planned: number;
  completed: number;
  skipped: number;
  partial: number;
  /** This source's items, worst (most missed) first. */
  items: MissionItemRecord[];
}

/** One grouped row of the {@link missionBySource} query, before attribution. */
type SourceQueryRow = {
  protocolId: string | null;
  title: string;
  /** The protocol's name TODAY, via the join — null once it is deleted. */
  liveName: string | null;
  /** The protocol's name when the row was generated (extras.protocol). */
  storedProtocol: string | null;
  /** A mode label or `Experiment · …` (extras.category). */
  storedCategory: string | null;
  planned: number;
  completed: number;
  skipped: number;
  /** Aliased away from `partial` — SQL-standard `MATCH PARTIAL` makes the bare
   *  word a parser hazard not worth taking for a column alias. */
  partialCount: number;
};

/** How many of a record's planned days ended without a completion. */
const missedOf = (r: { planned: number; completed: number }): number => r.planned - r.completed;

/** Worst first, then the larger sample, then alphabetical — fully deterministic. */
function byMissedDesc<T extends { planned: number; completed: number }>(
  label: (r: T) => string
): (a: T, b: T) => number {
  return (a, b) => {
    const missed = missedOf(b) - missedOf(a);
    if (missed !== 0) return missed;
    const size = b.planned - a.planned;
    if (size !== 0) return size;
    return label(a) < label(b) ? -1 : label(a) > label(b) ? 1 : 0;
  };
}

/** Which source a grouped row belongs to, and what to call it. */
function attribute(
  row: SourceQueryRow
): Pick<MissionSourceRecord, 'key' | 'protocolId' | 'name' | 'kind'> {
  if (row.protocolId !== null && row.liveName !== null) {
    return {
      key: row.protocolId,
      protocolId: row.protocolId,
      name: row.liveName,
      kind: 'protocol',
    };
  }
  // The protocol was deleted (protocol_id SET NULL) but the row still remembers
  // its name. Saying "Evening stack" and offering no chevron is more honest than
  // filing a year of history under "Unattributed".
  if (row.storedProtocol) {
    return {
      key: `gone:${row.storedProtocol}`,
      protocolId: null,
      name: row.storedProtocol,
      kind: 'protocol_gone',
    };
  }
  // A mode item or an experiment's intervention: `category` is the one
  // attribution those rows carry, by the exclusivity rule in mission-generate.ts.
  if (row.storedCategory) {
    return {
      key: `other:${row.storedCategory}`,
      protocolId: null,
      name: row.storedCategory,
      kind: 'other',
    };
  }
  return { key: 'other:unattributed', protocolId: null, name: 'Unattributed', kind: 'other' };
}

/**
 * Execution grouped by the thing that generated it, over the INCLUSIVE date
 * range `from … to`. Empty when `to < from`, which is the honest answer for a
 * record that starts today: there is nothing finished to judge.
 *
 * **Give it settled days only.** The caller passes a range that ends *before*
 * today, because a pending item at 09:00 is not a miss — it is a morning. Every
 * status here is read as final, and that is only true of a day that is over.
 *
 * The two shared predicates go in verbatim as everywhere else in this file.
 * They name `value` unqualified; that is unambiguous here for the same reason
 * it is in {@link missionDailySeries} — `daily_logs` has no `value` column, and
 * neither does `protocols`, which is the only column this query adds to the
 * scope.
 */
export function missionBySource(db: Database, from: string, to: string): MissionSourceRecord[] {
  if (to < from) return [];
  const rows = db.all<SourceQueryRow>(
    `SELECT e.protocol_id AS protocolId,
            e.title AS title,
            max(p.name) AS liveName,
            max(json_extract(e.value, '$.protocol')) AS storedProtocol,
            max(json_extract(e.value, '$.category')) AS storedCategory,
            count(*) AS planned,
            sum(CASE WHEN e.status = 'completed' THEN 1 ELSE 0 END) AS completed,
            sum(CASE WHEN e.status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
            sum(CASE WHEN e.status = 'partial' THEN 1 ELSE 0 END) AS partialCount
       FROM log_entries e
       JOIN daily_logs d ON d.id = e.daily_log_id
       LEFT JOIN protocols p ON p.id = e.protocol_id
      WHERE d.date >= ? AND d.date <= ?
        AND ${PLANNED_ROW_SQL}
        AND ${NOT_REMOVED_SQL}
      -- By (protocol, title), NOT by the display names: a protocol renamed
      -- mid-window is one protocol, and grouping on its name would split its
      -- record in two at the moment it was renamed.
      GROUP BY e.protocol_id, e.title`,
    [from, to]
  );

  const byKey = new Map<string, MissionSourceRecord>();
  for (const row of rows) {
    const source = attribute(row);
    let record = byKey.get(source.key);
    if (!record) {
      record = { ...source, planned: 0, completed: 0, skipped: 0, partial: 0, items: [] };
      byKey.set(source.key, record);
    }
    record.planned += row.planned;
    record.completed += row.completed;
    record.skipped += row.skipped;
    record.partial += row.partialCount;
    record.items.push({
      title: row.title,
      planned: row.planned,
      completed: row.completed,
      skipped: row.skipped,
      partial: row.partialCount,
    });
  }

  const sources = [...byKey.values()];
  for (const record of sources) record.items.sort(byMissedDesc((i) => i.title));
  sources.sort(byMissedDesc((s) => s.name));
  return sources;
}
