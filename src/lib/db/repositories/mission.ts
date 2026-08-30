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
import { activeModesIn } from './day-modes';
import { getModeDefinition, type ModeKey } from '@/lib/modes/registry';
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

/**
 * Skips are judged by the day's MODE, and the mode is a fact about the day.
 *
 * `excusesSkips` (lib/modes/registry.ts) says a skip under Sick / Travel /
 * Social is the right call, not a miss — the Coach has honoured that since
 * 0026 and nothing downstream did, so a protocol correctly rested from during
 * an illness was ranked on mission-history's "Where it's failing" list as one
 * the user was failing. These two helpers are how every adherence figure in
 * this file reads the mode instead of ignoring it.
 *
 * ## The denominator: EXCLUDED, not counted as met
 *
 * Both are defensible and they give different rates. An excused skip is
 * **removed from the denominator** — it is not owed, so it is neither a
 * completion nor a miss — for three reasons, in order of weight:
 *
 *   1. **It is the call this file already made once.** A row the user removed
 *     from the day is tombstoned and excluded by `NOT_REMOVED_SQL` on exactly
 *     that reasoning ("was never owed"). A mode excusing a skip is the same
 *     fact arriving by a different route; giving it a different answer would
 *     make "what did the day owe me" mean two things in one module.
 *   2. **Counting it as met makes `completed` a lie.** `completed` is printed
 *     as "N done" and drawn as the completion bar, and a Sick week in which
 *     everything was skipped would render as 100% done — the honesty rule
 *     broken from the generous side. "I rested correctly" and "I did it" are
 *     different facts and must never render identically.
 *   3. **A fully-excused day falls out cleanly.** Its `owed` is 0, which this
 *     file already knows how to state: a day that asked nothing of you has no
 *     rate, and gets no bar and no zero (see {@link missionDailySeries}).
 *
 * The cost is that an excused day carries less weight in the window's rate
 * rather than pulling it up, which is correct: it is less evidence, not more
 * success.
 */
export function modeExcusesSkips(mode: ModeKey): boolean {
  return getModeDefinition(mode).excusesSkips;
}

/**
 * What a day actually OWED — planned items minus the ones its mode excused.
 * The denominator of every rate here; see {@link modeExcusesSkips} for why the
 * excused ones leave rather than count as met.
 */
export function missionOwed(point: { planned: number; excused: number }): number {
  return point.planned - point.excused;
}

/** One day of mission history — what was planned, and what was actually done. */
export interface MissionDayPoint {
  date: string;
  /**
   * The day's mode, from `day_modes` (0026). `normal` for a day with no
   * covering row, which is most days.
   */
  mode: ModeKey;
  /** Planned items that stood on the day (tombstoned removals excluded). */
  planned: number;
  /** Of those, the ones marked completed. */
  completed: number;
  /**
   * Skipped by hand AND counted against the day — i.e. skips under a mode that
   * does not excuse them (Normal, Deload). `planned - completed - skipped -
   * excused` is what was left pending or partial.
   */
  skipped: number;
  /**
   * Skipped by hand and EXCUSED by the day's mode: rest while sick, a gym
   * session missed in a foreign city. Never a miss, and never a completion —
   * held out of the rate's denominator entirely ({@link missionOwed}).
   */
  excused: number;
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
 * the whole reason this returns counts instead of a percentage: a rate over a
 * day that asked nothing of you is undefined, and zero-filling it would drag
 * every average down for days the user was owed nothing. Callers that want a
 * rate compute it over days where {@link missionOwed} is positive — see
 * {@link missionAdherence}.
 *
 * **Each day carries its mode**, and skips under an excusing mode are split
 * out as `excused` rather than counted as `skipped` — see
 * {@link modeExcusesSkips}. One extra query for the whole window, not one per
 * day.
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
  const modes = activeModesIn(db, dates[0] ?? today, today);
  return dates.map((date) => {
    const row = byDate.get(date);
    const mode = modes.get(date) ?? 'normal';
    const skipped = row?.skipped ?? 0;
    // A skip is either excused or a miss — never both, and never neither.
    const excused = modeExcusesSkips(mode) ? skipped : 0;
    return {
      date,
      mode,
      planned: row?.planned ?? 0,
      completed: row?.completed ?? 0,
      skipped: skipped - excused,
      excused,
    };
  });
}

/**
 * Completed ÷ OWED across a series, counting **only days that owed something**.
 * Returns null when no day in the window did — there is no rate to state, and
 * "0%" for a fortnight nobody was asked to do anything is a lie the §5 honesty
 * rules exist to prevent.
 *
 * Owed, not planned: a skip the day's mode excused was never owed, so it leaves
 * the denominator rather than counting as a miss OR as a completion
 * ({@link modeExcusesSkips}). A day whose every item was excused therefore owes
 * nothing and is skipped here exactly like a day with no plan.
 */
export function missionAdherence(points: MissionDayPoint[]): number | null {
  let owed = 0;
  let completed = 0;
  for (const point of points) {
    const dayOwed = missionOwed(point);
    if (dayOwed <= 0) continue;
    owed += dayOwed;
    completed += point.completed;
  }
  return owed === 0 ? null : completed / owed;
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
  /** Marked skipped on a day whose mode does NOT excuse skips — a real miss. */
  skipped: number;
  /** Marked skipped on a Sick/Travel/Social day: the right call, not a miss. */
  excused: number;
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
  /** Skips counted against the record — see {@link MissionItemRecord}. */
  skipped: number;
  /** Skips a mode excused. Held out of the miss count AND of `planned - excused`. */
  excused: number;
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
  /** ALL skips, excused or not. The split happens below, from `excusedCount`. */
  skipped: number;
  /** Skips that fell on a day whose mode excuses them. */
  excusedCount: number;
  /** Aliased away from `partial` — SQL-standard `MATCH PARTIAL` makes the bare
   *  word a parser hazard not worth taking for a column alias. */
  partialCount: number;
};

/**
 * How many of a record's days ended without a completion **and were owed**.
 *
 * The mode-aware definition, and the reason "Where it's failing" no longer
 * ranks a protocol you correctly rested from during a sick week as one you are
 * failing: an excused skip leaves the denominator instead of counting as a
 * miss ({@link modeExcusesSkips}).
 */
const missedOf = (r: { planned: number; completed: number; excused: number }): number =>
  r.planned - r.completed - r.excused;

/** Worst first, then the larger sample, then alphabetical — fully deterministic. */
function byMissedDesc<T extends { planned: number; completed: number; excused: number }>(
  label: (r: T) => string
): (a: T, b: T) => number {
  return (a, b) => {
    const missed = missedOf(b) - missedOf(a);
    if (missed !== 0) return missed;
    // Larger sample next — the sample is what was OWED, not what was listed.
    const size = missionOwed(b) - missionOwed(a);
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

  // The days in this window whose mode EXCUSES a skip. Resolved once in JS from
  // the registry (`excusesSkips`) rather than restated in SQL, so the rule has
  // exactly one definition; bound as values, never interpolated. `'0'` — a
  // false literal — covers the ordinary case of no excusing day in the window,
  // and keeps the sum in the query rather than folding a per-day breakdown in
  // JS afterwards. The list is bounded by the caller's range (14 days on
  // app/mission-history.tsx).
  const excusedDates = [...activeModesIn(db, from, to)]
    .filter(([, mode]) => modeExcusesSkips(mode))
    .map(([date]) => date);
  const isExcusedDay =
    excusedDates.length > 0 ? `d.date IN (${excusedDates.map(() => '?').join(', ')})` : '0';

  const rows = db.all<SourceQueryRow>(
    `SELECT e.protocol_id AS protocolId,
            e.title AS title,
            max(p.name) AS liveName,
            max(json_extract(e.value, '$.protocol')) AS storedProtocol,
            max(json_extract(e.value, '$.category')) AS storedCategory,
            count(*) AS planned,
            sum(CASE WHEN e.status = 'completed' THEN 1 ELSE 0 END) AS completed,
            sum(CASE WHEN e.status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
            sum(CASE WHEN e.status = 'skipped' AND ${isExcusedDay} THEN 1 ELSE 0 END)
              AS excusedCount,
            sum(CASE WHEN e.status = 'partial' THEN 1 ELSE 0 END) AS partialCount
       FROM log_entries e
       JOIN daily_logs d ON d.id = e.daily_log_id
       LEFT JOIN protocols p ON p.id = e.protocol_id
      WHERE d.date >= ? AND d.date <= ?
        AND ${PLANNED_ROW_SQL}
        AND ${NOT_REMOVED_SQL}
      -- For PROTOCOL rows (protocol_id present): by (protocol_id, title), NOT by
      -- the display names — a protocol renamed mid-window is one protocol, and
      -- grouping on its name would split its record in two at the rename.
      --
      -- For NULL-protocol_id rows (mode items, experiment interventions, and
      -- items of a since-deleted protocol — protocol_id is SET NULL on delete)
      -- protocol_id alone can't tell distinct sources apart, so two such rows
      -- that merely share a title would collapse into one group and have their
      -- adherence summed before attribute() ever runs, then be filed under
      -- whichever source max() happened to pick. Add the SAME discriminators
      -- attribute() keys those rows on — the stored protocol name and the stored
      -- category — so each source stays its own group. (Left empty for protocol
      -- rows so their grouping and rename-safety are untouched.)
      GROUP BY e.protocol_id,
        CASE WHEN e.protocol_id IS NULL
          THEN COALESCE(json_extract(e.value, '$.protocol'), '') || char(31)
            || COALESCE(json_extract(e.value, '$.category'), '')
          ELSE '' END,
        e.title`,
    // Bound in TEXTUAL order: the excused-day list sits in the SELECT list,
    // which precedes the WHERE clause.
    [...excusedDates, from, to]
  );

  const byKey = new Map<string, MissionSourceRecord>();
  for (const row of rows) {
    const source = attribute(row);
    let record = byKey.get(source.key);
    if (!record) {
      record = {
        ...source,
        planned: 0,
        completed: 0,
        skipped: 0,
        excused: 0,
        partial: 0,
        items: [],
      };
      byKey.set(source.key, record);
    }
    // `skipped` arrives from SQL as ALL skips; the excused ones move out of it
    // into their own bucket so `completed + skipped + excused + partial +
    // untouched` still sums to `planned` with one more, truer term.
    const skipped = row.skipped - row.excusedCount;
    record.planned += row.planned;
    record.completed += row.completed;
    record.skipped += skipped;
    record.excused += row.excusedCount;
    record.partial += row.partialCount;
    record.items.push({
      title: row.title,
      planned: row.planned,
      completed: row.completed,
      skipped,
      excused: row.excusedCount,
      partial: row.partialCount,
    });
  }

  const sources = [...byKey.values()];
  for (const record of sources) record.items.sort(byMissedDesc((i) => i.title));
  sources.sort(byMissedDesc((s) => s.name));
  return sources;
}
