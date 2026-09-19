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
import { timezoneChangedDaysIn } from './day-meta';
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
  /**
   * A CARRIED row (0050): a debt from an earlier day, re-offered here. It is
   * shown on Home like anything else and is deliberately held out of every
   * denominator — see {@link NOT_CARRIED_SQL}.
   */
  carried?: boolean;
  /** 1 on the first carry, 2 on the second … — what the row prints. */
  carried_days?: number;
  /** On a NATIVE row whose own cadence superseded an outstanding debt: how many
   *  days of it are outstanding. Informational; it settles nothing. */
  missed_days?: number;
  /** The `ProtocolItem.id` this row came from — present on protocol rows only. */
  item?: string;
  /** The day and row id a carried copy is owed from. */
  carried_from?: { date: string; entry: string };
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
    // Two different facts, and they must not render identically: `carriedDays`
    // is "this row is a debt, N days old"; `missedDays` is "today's own
    // occurrence, with N days of it still outstanding behind it".
    carriedDays: extras.carried === true ? (extras.carried_days ?? 1) : undefined,
    missedDays: extras.carried === true ? undefined : extras.missed_days,
    // The four fields that make the row a door (see MissionItem). Every one of
    // them was already on the stored row; nothing new is written to get them,
    // and each is left UNDEFINED rather than null when absent, so `item.protocolId
    // ? …` is the whole of "is there a protocol behind this row".
    dailyLogId: row.daily_log_id,
    protocolId: row.protocol_id ?? undefined,
    itemId: extras.item,
    carriedFrom: extras.carried === true ? extras.carried_from : undefined,
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

/**
 * A CARRIED row — a debt from an earlier day, re-offered on this one (0050,
 * backlog C11). The third shared predicate, and the one that keeps the feature
 * from punishing the user for using it.
 *
 * ## The rule, stated once
 *
 * > **The original day keeps the obligation. A carried row is a REMINDER, not a
 * > new obligation.**
 *
 * Tuesday did not owe you Monday's creatine; Monday did. So every query that
 * counts what a day **owed** carries this predicate — {@link missionDailySeries},
 * {@link missionBySource}, and the protocol-detail adherence read
 * (./protocol-adherence.ts). Without it one item asked for once reads as
 * *3 planned, 1 completed*, and turning carry-over on would make the rate worse
 * than leaving it off: the exact opposite of what it is for.
 *
 * {@link listMission} deliberately does NOT carry it — a carried row renders on
 * Home, it just is not an obligation of that day. Neither does the quota count
 * or the adjusting clock's last-completion read (mission-generate.ts): a late
 * completion IS a completion, and both of those ask what was done, not what was
 * owed.
 */
export const NOT_CARRIED_SQL = "json_extract(value, '$.carried') IS NULL";

/**
 * The ORIGINAL row of a debt that was finally paid on a later day — `late_on`
 * holds the day the carried copy was completed. It stays `skipped`, so it is
 * still a miss on the day it was missed; this only lets a surface say so out
 * loud ("2 skipped (1 done late)") rather than filing a late completion and a
 * flat refusal under one word.
 */
export const DONE_LATE_SQL = "json_extract(value, '$.late_on') IS NOT NULL";

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
 * One mission row by id, as the view-model — what a pushed sheet reads.
 *
 * The same two standing predicates as {@link listMission}, so a sheet can only
 * ever be opened on a row Home actually draws: an ad-hoc Log-tab capture and a
 * tombstoned removal both read as absent here, and the screen says the row is
 * gone rather than offering verbs on something invisible.
 */
export function getMissionItem(db: Database, id: string): MissionItem | null {
  const row = db.get<LogEntryRow>(
    `SELECT * FROM log_entries WHERE id = ? AND ${PLANNED_ROW_SQL} AND ${NOT_REMOVED_SQL}`,
    [id]
  );
  return row ? toMissionItem(row) : null;
}

/**
 * How many rows each protocol has on `date`'s COMMITTED mission — the hub's
 * `3 today`.
 *
 * One grouped query for the whole screen, handed to each row inside the loop.
 * Never one query per row: the hub draws every protocol on the device, and a
 * per-row read is the shape that turns a six-protocol screen into a stutter.
 *
 * **Today is counted, not projected.** Today's plan already exists as rows, and
 * re-deriving it to count it would produce a second, subtly different answer
 * beside the one the user has been ticking.
 *
 * **A carried row counts.** It is on the list and it has to be done, which is
 * what the figure answers. {@link NOT_CARRIED_SQL} is for denominators — what a
 * day OWED — and this is not one.
 */
export function missionCountByProtocol(db: Database, date: string): Map<string, number> {
  const rows = db.all<{ protocolId: string | null; n: number }>(
    `SELECT e.protocol_id AS protocolId, count(*) AS n
       FROM log_entries e
       JOIN daily_logs d ON d.id = e.daily_log_id
      WHERE d.date = ?
        AND e.protocol_id IS NOT NULL
        AND ${PLANNED_ROW_SQL}
        AND ${NOT_REMOVED_SQL}
      GROUP BY e.protocol_id`,
    [date]
  );
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.protocolId !== null) counts.set(row.protocolId, row.n);
  }
  return counts;
}

/** One mission row that has asked for an OS notification (C10). */
export type RemindableEntry = {
  id: string;
  protocolId: string;
  /** The `ProtocolItem.id` — half of the key the scheduler dedupes on. */
  itemId: string;
  title: string;
  /** Always non-null: `remind` is meaningless without a moment to fire at. */
  scheduledTime: string;
  /** The item's rationale line, used as the notification body. */
  why: string | null;
};

/**
 * The rows on `date` that are still PENDING and have asked for a notification.
 *
 * `status = 'pending'` is the whole of "a completed item's reminder must not
 * fire": the scheduler re-runs on every status write, and a ticked item simply
 * stops appearing here, so the next reconciliation drops its notification. The
 * same is true of a skip and of a tombstoned removal — all three are decisions,
 * and none of them should buzz the phone three hours later.
 *
 * Carried rows are deliberately INCLUDED (no {@link NOT_CARRIED_SQL}): a debt
 * you asked to be reminded about is exactly the thing worth a nudge. This asks
 * what is still to be DONE, not what the day owed.
 */
export function remindableEntries(db: Database, date: string): RemindableEntry[] {
  return db.all<RemindableEntry>(
    `SELECT e.id AS id,
            e.protocol_id AS protocolId,
            json_extract(e.value, '$.item') AS itemId,
            e.title AS title,
            e.scheduled_time AS scheduledTime,
            json_extract(e.value, '$.why') AS why
       FROM log_entries e
       JOIN daily_logs d ON d.id = e.daily_log_id
      WHERE d.date = ?
        AND e.status = 'pending'
        AND e.scheduled_time IS NOT NULL
        AND e.protocol_id IS NOT NULL
        AND json_extract(e.value, '$.item') IS NOT NULL
        AND json_extract(e.value, '$.remind') = 1
        AND ${PLANNED_ROW_SQL}
        AND ${NOT_REMOVED_SQL}
      ORDER BY e.scheduled_time, e.created_at, e.id`,
    [date]
  );
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
    settleCarriedOriginal(db, id, null);
    return;
  }
  db.run(
    "UPDATE log_entries SET status = 'completed', completed_at = COALESCE(completed_at, ?) WHERE id = ?",
    [new Date().toISOString(), id]
  );
  settleCarriedOriginal(db, id, dayOfEntry(db, id));
}

/** The calendar day a log entry sits under, via its parent daily_log. */
function dayOfEntry(db: Database, id: string): string | null {
  const row = db.get<{ date: string }>(
    'SELECT d.date AS date FROM log_entries e JOIN daily_logs d ON d.id = e.daily_log_id WHERE e.id = ?',
    [id]
  );
  return row?.date ?? null;
}

/**
 * Close (or re-open) the debt behind a CARRIED row.
 *
 * Completing a carried row is a statement about the day it came FROM, not only
 * about today, so the original row is settled in the same breath: `skipped`,
 * plus `value.late_on = <the day it was actually done>`. Every existing query
 * then does the right thing with no change at all — a skipped row on a
 * non-excusing day is already a miss — and the only new surface is an
 * annotation. **The missed day stays a miss and the late completion earns no
 * rate credit** (owner's call, 2026-09-14: "did it late" and "did it on time"
 * must not produce the same number).
 *
 * `day = null` UNDOES that: un-ticking a carried row on Home puts the original
 * back to `pending` and clears the stamp, so the debt is live again and the
 * generator re-carries it tomorrow. Without this the toggle would be one-way —
 * a mis-tap would permanently convert an untouched row into a skip.
 *
 * NOT wrapped in a transaction of its own: `Database.transaction` is a plain
 * BEGIN and does not nest, and the Coach's mission-ops batch already calls
 * {@link setMissionStatus} from inside one. The two statements are sequential
 * and the divergence if the second never ran is self-healing — the debt is
 * simply still outstanding, and the next generation carries it again.
 *
 * Every guard is defence in depth on a statement that reaches a row the caller
 * never named: it can only touch the row this one was carried FROM, and only
 * while that row is in the state this function itself put it in.
 */
function settleCarriedOriginal(db: Database, id: string, day: string | null): void {
  const row = db.get<{ origin: string | null }>(
    `SELECT json_extract(value, '$.carried_from.entry') AS origin FROM log_entries WHERE id = ?`,
    [id]
  );
  const origin = row?.origin;
  if (typeof origin !== 'string' || origin === '') return;
  if (day === null) {
    // ONE undo path for the TWO ways a copy can settle its original: a late
    // completion (`late_on`, written just below) and a hand-tapped skip on the
    // copy ({@link skipCarried}'s `skipped_via`). Both marks are removed, and
    // the `skipped_via` half is keyed to THIS copy — a debt another copy
    // skipped is not this row's to re-open. An original marked neither is
    // untouched, which is what keeps a plain un-tick from converting an
    // unrelated row.
    db.run(
      `UPDATE log_entries
          SET status = 'pending',
              value = json_remove(value, '$.late_on', '$.skipped_via')
        WHERE id = ? AND status = 'skipped'
          AND (${DONE_LATE_SQL} OR json_extract(value, '$.skipped_via') = ?)`,
      [origin, id]
    );
    return;
  }
  db.run(
    `UPDATE log_entries
        SET status = 'skipped',
            value = json_set(COALESCE(value, '{}'), '$.late_on', ?)
      WHERE id = ? AND status = 'pending' AND ${PLANNED_ROW_SQL} AND ${NOT_REMOVED_SQL}`,
    [day, origin]
  );
}

/**
 * Skip a CARRIED row, and the debt behind it, in one gesture.
 *
 * A carried copy is not an obligation of the day it appears on — the ORIGINAL
 * day keeps that ({@link NOT_CARRIED_SQL}) — so skipping only the copy would be
 * a decision that evaporates overnight: `outstandingCarries` reads `pending`
 * ORIGINALS, so the debt would be re-levied tomorrow, and the tap the user made
 * to say "not this one" would mean nothing. A hand-tapped skip is a DECISION
 * not to do it (the rule 0050 already settled for native rows), and here it has
 * to reach the row that holds the obligation.
 *
 * So both rows are written: the copy is settled `skipped`, and the original is
 * settled `skipped` plus `value.skipped_via = <this copy's id>`. That mark is
 * the mirror of `late_on` — the second of exactly two ways a copy can close its
 * original — and it exists so the undo in {@link setMissionStatus} can re-open
 * the right row and only the right row.
 *
 * **What the record then reads:** the original's day moves from untouched to
 * `skipped`, which on a non-excusing day is a miss either way, and back on
 * undo. No adherence figure reads either mark: `late_on` feeds only the
 * `doneLate` annotation and `skipped_via` feeds only the undo guard. This is a
 * deliberate write on a row the user is looking at — the same class as the
 * settle-on-completion write above — not an annotation stamped on week-old
 * history behind his back, which the carry-over spike considered and rejected.
 *
 * Returns false when the row is not a carried copy, so a caller can report
 * which of its operations applied rather than claiming one that did not.
 */
export function skipCarried(db: Database, copyId: string): boolean {
  const row = db.get<{ origin: string | null }>(
    `SELECT json_extract(value, '$.carried_from.entry') AS origin FROM log_entries WHERE id = ?`,
    [copyId]
  );
  const origin = row?.origin;
  if (typeof origin !== 'string' || origin === '') return false;
  // The copy first. Its own settle-branch call is a no-op while the original is
  // still `pending` — the undo guard below requires a `skipped` original — so
  // the order is safe and the stamp lands on a row in the state it expects.
  setMissionStatus(db, copyId, 'skipped');
  // Every guard is defence in depth on a statement reaching a row the caller
  // never named: `pending` only, so a completed original is never overwritten,
  // and the two standing predicates so it can never touch an ad-hoc capture or
  // a tombstone. Exactly the settle branch's shape.
  db.run(
    `UPDATE log_entries
        SET status = 'skipped',
            value = json_set(COALESCE(value, '{}'), '$.skipped_via', ?)
      WHERE id = ? AND status = 'pending' AND ${PLANNED_ROW_SQL} AND ${NOT_REMOVED_SQL}`,
    [copyId, origin]
  );
  return true;
}

/**
 * The row-tap gesture: `completed → pending`, **`skipped → pending`**, anything
 * else → `completed`.
 *
 * ## Why a skip now toggles BACK rather than forward
 *
 * A skip used to move to `completed`, so a mis-tapped Skip on the hero was
 * awkward to undo: you had to tick the very item you had just declined and then
 * untick it to get back to undecided. The hero's own docblock named this fix
 * rather than a third row of chrome (src/components/home/hero-card.tsx) —
 * *"the fix is `toggleMission` — the undo — not a third row of chrome"*.
 *
 * So the gesture reads as **take back whatever was decided**: a row the user
 * settled either way returns to undecided, and only an undecided row commits.
 * Its one cost, recorded because it is real: completing a skipped item is two
 * taps instead of one. That is the right price — deciding to do something you
 * had already declined is rarer than taking back a mis-tap, and the two-tap path
 * passes through the honest intermediate state instead of jumping between two
 * opposite decisions.
 *
 * `partial` still commits on a tap: partial is progress, not a decision, so the
 * obvious next move is to finish it. The item sheet's *Put back* is what returns
 * a partial row to pending.
 *
 * A carried row's undo still reaches its original through
 * {@link setMissionStatus} — this function only decides which status to ask for.
 */
export function toggleMission(db: Database, id: string): void {
  const row = db.get<{ status: LogEntryStatus }>('SELECT status FROM log_entries WHERE id = ?', [
    id,
  ]);
  if (!row) return;
  const settled = row.status === 'completed' || row.status === 'skipped';
  setMissionStatus(db, id, settled ? 'pending' : 'completed');
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
 *
 * ## What counts as "a skip" here
 *
 * A hand-tapped skip **and**, once the day is over, an item that was simply
 * never touched. The first version excused only the former, which made the
 * record say something absurd: on a Travel day the item he deliberately marked
 * skipped was forgiven and the identical item he never opened the app to touch
 * was held against him. The tap is bookkeeping, not virtue — the mode already
 * said that not doing this today was the right call. Found in passing by the
 * protocol-carryover spike (docs/spikes/protocol-carryover.md §1).
 *
 * The denominator rule above is unchanged and applies to both: excused leaves
 * the denominator, and never counts as met.
 */
export function modeExcusesSkips(mode: ModeKey): boolean {
  return getModeDefinition(mode).excusesSkips;
}

/**
 * Every day in `from … to` whose skips are EXCUSED — the union of two
 * independent reasons, resolved once so no figure on any screen can honour one
 * and miss the other.
 *
 * 1. **The day's MODE excuses them** ({@link modeExcusesSkips}) — Sick, Travel,
 *    Social. The user declared it.
 * 2. **The device's timezone changed on it** (D4, migration 0053). Nobody
 *    declared anything: a 19-hour day simply ends before its 21:00 items come
 *    round, and a 29-hour one gets 24 hours of plan for 29 hours of living.
 *    Counting either as a compliance dip would be describing the calendar as a
 *    character flaw — which is the complaint a trip would actually produce.
 *
 * **A timezone change deliberately does NOT set a mode**, and this is where
 * that decision is mechanically kept (owner, 2026-09-14). ARC cannot tell a
 * flight from a Settings change, and Travel mode reshapes the plan and the
 * Coach's tone — that is the user's call. What ARC observed is one fact about
 * one day, so it changes exactly one thing: how the skips are judged. Anything
 * that wants to say WHY a day was excused reads the mode and the timezone note
 * separately (app/mission-history.tsx does).
 */
export function excusedDatesIn(db: Database, from: string, to: string): Set<string> {
  const dates = new Set<string>();
  for (const [date, mode] of activeModesIn(db, from, to)) {
    if (modeExcusesSkips(mode)) dates.add(date);
  }
  for (const date of timezoneChangedDaysIn(db, from, to)) dates.add(date);
  return dates;
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
   * EXCUSED by the day's mode: rest while sick, a gym session missed in a
   * foreign city. Never a miss, and never a completion — held out of the rate's
   * denominator entirely ({@link missionOwed}).
   *
   * On an excusing day this covers **both** a hand-tapped skip and an item the
   * user simply never touched, once the day is over. Only skips used to count,
   * which made the ledger say something absurd: on a Travel day the item he
   * deliberately marked skipped was forgiven, and the identical item he never
   * opened the app to touch was held against him. The mode's whole claim is that
   * not doing this today was the right call, and not-touching is the same fact
   * as tapping skip — the tap is bookkeeping, not virtue.
   *
   * **Only on a settled day.** A pending item at 09:00 is a morning, not a
   * decision, so the current day's untouched items stay pending until it ends.
   */
  excused: number;
  /**
   * Of `skipped`, the ones that were finally DONE on a later day through a
   * carried row (0050). A subset, never an extra term — the ledger still sums
   * to `planned`, and the day is still a miss. It exists so a surface can say
   * "2 skipped (1 done late)" instead of filing a late completion and a flat
   * refusal under one word.
   */
  doneLate: number;
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
 * **Each day carries its mode**, and what an excusing mode forgives is split out
 * as `excused` rather than counted against the day — see
 * {@link modeExcusesSkips}. That is a hand-tapped skip, and on a day that has
 * ENDED an untouched item too: the mode's claim is that not doing this today was
 * the right call, and never touching it is the same fact as tapping skip. One
 * extra query for the whole window, not one per day.
 *
 * `today` is injectable so the headless tests are deterministic — and it is also
 * what makes "the day has ended" answerable here at all.
 */
export function missionDailySeries(
  db: Database,
  days: number = 14,
  today: string = todayISODate()
): MissionDayPoint[] {
  const dates = localDaysList(today, days);
  const rows = db.all<{
    date: string;
    planned: number;
    completed: number;
    skipped: number;
    pending: number;
    doneLate: number;
  }>(
    `SELECT d.date AS date,
       count(*) AS planned,
       sum(CASE WHEN e.status = 'completed' THEN 1 ELSE 0 END) AS completed,
       sum(CASE WHEN e.status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
       sum(CASE WHEN e.status = 'pending' THEN 1 ELSE 0 END) AS pending,
       -- A SUBSET of skipped, never a term of its own: the day stayed a miss.
       sum(CASE WHEN e.status = 'skipped' AND ${DONE_LATE_SQL} THEN 1 ELSE 0 END) AS doneLate
     FROM log_entries e
     JOIN daily_logs d ON d.id = e.daily_log_id
     WHERE d.date >= ? AND d.date <= ?
       -- The three shared predicates go in VERBATIM, unqualified "value" and
       -- all. That is safe here and only here because daily_logs has no "value"
       -- column, so the name resolves unambiguously to log_entries.value --
       -- and interpolating them verbatim is the point: a rewritten copy would
       -- be a fourth definition of "is this a mission row", which is exactly
       -- what the constants exist to prevent.
       AND ${PLANNED_ROW_SQL}
       AND ${NOT_REMOVED_SQL}
       -- A carried row is a reminder of an older day's obligation, not a new
       -- one. Counting it here would make one item asked for once read as
       -- "3 planned, 1 completed" and punish the user for using carry-over.
       AND ${NOT_CARRIED_SQL}
     GROUP BY d.date`,
    [dates[0] ?? today, today]
  );
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const modes = activeModesIn(db, dates[0] ?? today, today);
  // Mode OR timezone change — one definition, resolved once for the window.
  const excusedDates = excusedDatesIn(db, dates[0] ?? today, today);
  return dates.map((date) => {
    const row = byDate.get(date);
    const mode = modes.get(date) ?? 'normal';
    const skipped = row?.skipped ?? 0;
    const excusing = excusedDates.has(date);
    // A skip is either excused or a miss — never both, and never neither.
    const excusedSkips = excusing ? skipped : 0;
    // An UNTOUCHED item is excused too, but only once the day is over: at 09:00
    // a pending item is a morning, not a decision, and forgiving it early would
    // flatter the day while it is still live. `date < today` is the same
    // settled-day test app/mission-history.tsx grades over.
    const excusedPending = excusing && date < today ? (row?.pending ?? 0) : 0;
    return {
      date,
      mode,
      planned: row?.planned ?? 0,
      completed: row?.completed ?? 0,
      skipped: skipped - excusedSkips,
      excused: excusedSkips + excusedPending,
      doneLate: row?.doneLate ?? 0,
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
  /**
   * Excused by a Sick/Travel/Social day: the right call, not a miss. Both the
   * skips the user tapped AND the days he simply never touched it — see
   * {@link MissionDayPoint.excused} for why those are the same fact.
   */
  excused: number;
  /** Marked partial — real progress, so it is neither a completion nor a miss. */
  partial: number;
  /** Of `skipped`, the ones a carried row finally paid. A subset, not a term. */
  doneLate: number;
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
  /** What a mode excused. Held out of the miss count AND of `planned - excused`. */
  excused: number;
  partial: number;
  /** Of `skipped`, the ones a carried row finally paid. A subset, not a term. */
  doneLate: number;
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
  /** ALL skips, excused or not. The split happens below, from `excusedSkips`. */
  skipped: number;
  /** Skips that fell on a day whose mode excuses them. */
  excusedSkips: number;
  /**
   * UNTOUCHED rows that fell on such a day. Counted separately from
   * {@link excusedSkips} because they were never part of `skipped`, so the two
   * cannot be summed into one column without corrupting the skip arithmetic
   * below — and because they are the half this query used to miss entirely.
   */
  excusedPending: number;
  /** Aliased away from `partial` — SQL-standard `MATCH PARTIAL` makes the bare
   *  word a parser hazard not worth taking for a column alias. */
  partialCount: number;
  /** Skips a carried row finally paid, on a day that was NOT excused. */
  doneLate: number;
};

/**
 * How many of a record's days ended without a completion **and were owed**.
 *
 * The mode-aware definition, and the reason "Where it's failing" no longer
 * ranks a protocol you correctly rested from during a sick week as one you are
 * failing: what the mode excused leaves the denominator instead of counting as
 * a miss — a tapped skip and an untouched item alike ({@link modeExcusesSkips}).
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

  // The days in this window whose skips are EXCUSED — by the day's mode or by a
  // timezone change on it ({@link excusedDatesIn}). Resolved once in JS rather
  // than restated in SQL, so the rule has exactly one definition; bound as
  // values, never interpolated. `'0'` — a false literal — covers the ordinary
  // case of no excusing day in the window, and keeps the sum in the query rather
  // than folding a per-day breakdown in JS afterwards. The list is bounded by
  // the caller's range (14 days on app/mission-history.tsx). Sorted so the
  // bound parameters are deterministic.
  const excusedDates = [...excusedDatesIn(db, from, to)].sort();
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
              AS excusedSkips,
            -- An untouched row on an excusing day is excused too: the mode said
            -- skipping was the right call, and never touching it is the same
            -- fact. This query is only ever given SETTLED days (see the header),
            -- so there is no live-day case to guard here — unlike
            -- missionDailySeries, whose window ends on today.
            sum(CASE WHEN e.status = 'pending' AND ${isExcusedDay} THEN 1 ELSE 0 END)
              AS excusedPending,
            sum(CASE WHEN e.status = 'partial' THEN 1 ELSE 0 END) AS partialCount,
            -- Of the skips counted AGAINST the record, the ones a carried row
            -- finally paid. A SUBSET of the skips, so the four terms still sum
            -- to the planned count; the day it was missed is still a miss.
            sum(CASE WHEN e.status = 'skipped' AND NOT (${isExcusedDay}) AND ${DONE_LATE_SQL}
                     THEN 1 ELSE 0 END) AS doneLate
       FROM log_entries e
       JOIN daily_logs d ON d.id = e.daily_log_id
       LEFT JOIN protocols p ON p.id = e.protocol_id
      WHERE d.date >= ? AND d.date <= ?
        AND ${PLANNED_ROW_SQL}
        AND ${NOT_REMOVED_SQL}
        -- The carried copy renders on Home but is never an obligation of the
        -- day it appears on. See NOT_CARRIED_SQL.
        AND ${NOT_CARRIED_SQL}
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
    // which precedes the WHERE clause — and it appears THREE times there now
    // (the excused skips, the excused untouched, then the done-late skips that
    // were NOT excused), so it is bound three times, in that order.
    [...excusedDates, ...excusedDates, ...excusedDates, from, to]
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
        doneLate: 0,
        items: [],
      };
      byKey.set(source.key, record);
    }
    // `skipped` arrives from SQL as ALL skips; only the EXCUSED SKIPS move out
    // of it. The excused untouched rows were never in `skipped` to begin with —
    // they come out of the leftover `untouched` term — so the two are summed
    // only into `excused`, and `completed + skipped + excused + partial +
    // untouched` still sums to `planned`.
    const skipped = row.skipped - row.excusedSkips;
    const excused = row.excusedSkips + row.excusedPending;
    record.planned += row.planned;
    record.completed += row.completed;
    record.skipped += skipped;
    record.excused += excused;
    record.partial += row.partialCount;
    record.doneLate += row.doneLate;
    record.items.push({
      title: row.title,
      planned: row.planned,
      completed: row.completed,
      skipped,
      excused,
      partial: row.partialCount,
      doneLate: row.doneLate,
    });
  }

  const sources = [...byKey.values()];
  for (const record of sources) record.items.sort(byMissedDesc((i) => i.title));
  sources.sort(byMissedDesc((s) => s.name));
  return sources;
}
