/**
 * A finished session ticks the day's Training row (item 70, 2026-10-21, no
 * migration).
 *
 * Owner, from the device: *"exercise protocol should auto complete when i
 * finish exercising"*. His decision on the shape:
 *
 * > Finishing any workout session today ticks the EARLIEST OPEN Training row of
 * > today's mission, with Undo. If that row names a saved workout, only that
 * > saved workout ticks it; a different session goes to the next open Training
 * > row that doesn't name a different workout, or ticks nothing.
 *
 * ## The definitions, each the one the rest of the app already uses
 *
 * - **A Training row** is a row Home labels TRAINING: `toMissionItem(row)
 *   .category === 'Training'` — a `training_block` protocol's items (type
 *   `workout`, falling back to that label). No second definition.
 * - **Open** is `pending` on today's planned, un-removed rows — the meaning
 *   `plannedItemRowsOn` gives it. Done, skipped and partial rows have been
 *   acted on, and are never touched. A carried row is open and on today's
 *   mission, so it takes its turn like any other.
 * - **Earliest** is Home's own order: scheduled time, untimed last, then
 *   insertion (`listMission`'s ORDER BY).
 * - **Names a saved workout**: there is no link field between a protocol item
 *   and a saved workout, so a row names one when its title IS a saved
 *   workout's name — trimmed, case-folded, otherwise exact. Never a substring
 *   or a fuzzy match (the Labs rule: `Push` is not `Push Day`). The session
 *   matches when its `routine_id` is that workout.
 *
 * ## What never ticks
 *
 * - A session dated anything but TODAY (the logical day). Ticking a past row
 *   is a backfill, and that is a deliberate gesture with its own guards
 *   (`backfillPastRow`: the window, a carried row, a row a copy settled) and
 *   its own re-derive of today. Doing it behind a "Log workout" card or a photo
 *   import would rewrite the record of a day he has already closed.
 * - An **Away** session (0055). His rule.
 * - A Health session he has not confirmed. Those live in `wearable_data` and
 *   are not sessions at all until he fills one in (the logger's `ingestId`
 *   door), which goes through Finish like any other — so it ticks then, if it
 *   is today's. **Pairing never ticks**: it attaches the watch's numbers to a
 *   session that was already saved, and so already ticked or not.
 * - A second row for the same session, and the same session twice: one call
 *   per save, refused if any row already carries this session's mark.
 *
 * An EDIT never calls this. The tick belongs to the save that created the
 * session, and correcting the session later re-judges nothing.
 *
 * ## The status rule is untouched
 *
 * A day status is read by nothing here. Which row ticks depends only on the
 * mission and the session (docs/information-architecture.md).
 *
 * ## The link, and the two things that read it
 *
 * The ticked row's `value.by_workout` holds the session's id (no migration:
 * `log_entries.value` is the row's payload json). `setMissionStatus` removes it
 * on any status but completed, so it is only ever on a row this session's tick
 * still holds. The Undo ({@link untickTraining}) and the session's delete
 * ({@link releaseWorkoutTick}) both re-open a row only while it still carries
 * that mark.
 */
import type { Database } from '../database';
import type { LogEntryRow } from '../types';
import { arriveDay } from '../seed';
import { NOT_REMOVED_SQL, PLANNED_ROW_SQL, setMissionStatus, toMissionItem } from './mission';
import { rederiveDaysAhead } from './mission-generate';

/** The mission label a training row wears (`CATEGORY_BY_TYPE.workout`). */
export const TRAINING_CATEGORY = 'Training';

/** What a session's save ticked — what the Undo needs to take it back. */
export type TrainingTick = {
  /** The `log_entries.id` ticked. */
  entryId: string;
  /** The session that ticked it. */
  workoutId: string;
  /** The row's title, as Home prints it. */
  title: string;
  /** The day the row sits on — always the day the session was saved for. */
  date: string;
};

/** The three facts about a session the choice reads. */
export type SessionForTick = {
  date: string;
  routineId: string | null;
  away: boolean;
};

const nameKey = (name: string): string => name.trim().toLowerCase();

/**
 * Today's OPEN Training rows in Home's order — the one definition both the
 * tick below and the caffeine cut-off (item 72) read. Read-only.
 */
function openTrainingRows(db: Database, today: string): LogEntryRow[] {
  const rows = db.all<LogEntryRow>(
    `SELECT e.* FROM log_entries e
       JOIN daily_logs d ON d.id = e.daily_log_id
      WHERE d.date = ? AND e.status = 'pending'
        AND ${PLANNED_ROW_SQL} AND ${NOT_REMOVED_SQL}
      ORDER BY (e.scheduled_time IS NULL), e.scheduled_time, e.created_at, e.id`,
    [today]
  );
  return rows.filter((row) => toMissionItem(row).category === TRAINING_CATEGORY);
}

/**
 * Today's open Training rows that carry a time, as `{ title, time }` — what
 * the caffeine cut-off measures against (src/lib/nutrition/caffeine-cutoff.ts).
 * An untimed row has no "hours before" and is left out. Read-only, so the
 * Coach's card can call it before the gate.
 */
export function openTimedTrainingRows(
  db: Database,
  today: string
): { title: string; time: string }[] {
  return openTrainingRows(db, today).flatMap((row) =>
    row.scheduled_time ? [{ title: row.title, time: row.scheduled_time }] : []
  );
}

/**
 * The row a session dated `session.date` would tick on `today`, or null —
 * read-only, so the Coach's card can say it before the gate.
 */
export function trainingRowFor(
  db: Database,
  session: SessionForTick,
  today: string
): { id: string; title: string } | null {
  return eligibleTrainingRows(db, session, today)[0] ?? null;
}

/**
 * Every open Training row this session MAY tick, in Home's order: the first is
 * {@link trainingRowFor}'s. The whole list is what a named tick (the Coach's
 * card, fix3) checks its row against past the gate.
 */
function eligibleTrainingRows(
  db: Database,
  session: SessionForTick,
  today: string
): { id: string; title: string }[] {
  if (session.away || session.date !== today) return [];
  const training = openTrainingRows(db, today);
  if (training.length === 0) return [];

  // Every saved workout, archived ones too: a row titled after a workout he
  // has since archived still names it, and must not fall to just any session.
  const named = new Map<string, Set<string>>();
  for (const r of db.all<{ id: string; name: string }>('SELECT id, name FROM routines')) {
    const key = nameKey(r.name);
    if (key === '') continue;
    const ids = named.get(key) ?? new Set<string>();
    ids.add(r.id);
    named.set(key, ids);
  }

  return training.flatMap((row) => {
    const names = named.get(nameKey(row.title));
    // An unnamed row takes any session; a named one only its own workout.
    return names === undefined || (session.routineId !== null && names.has(session.routineId))
      ? [{ id: row.id, title: row.title }]
      : [];
  });
}

/**
 * Tick the Training row a just-saved session earns, through the normal tick
 * ({@link setMissionStatus}), and mark it with the session. Null when nothing
 * was ticked.
 *
 * Call it AFTER the session is committed, in its own try: like pair-on-save, it
 * is bookkeeping around a write that has already happened, and a problem here
 * must never report the session as unsaved.
 *
 * `arriveDay` first, because the day's rows are what is ticked and the session
 * may be the first thing to touch today (a cold launch straight into the
 * logger). It is the same idempotent call Home makes on every read.
 *
 * The status write and the mark are one transaction, so a row is never ticked
 * without the link its Undo and its delete read. `rederiveDaysAhead` follows,
 * as it follows every status write in the app (a completion can move a later
 * day under a quota or an adjusting clock). Neither `arriveDay` nor the
 * re-derive can sit inside the transaction: both open their own, and
 * `Database.transaction` does not nest.
 *
 * `only` (fix3, 2026-10-21) is for a save behind a confirmation card that
 * NAMED its row: the approval covered that row and no other. `null` (the card
 * named none) ticks nothing; an id ticks that row only while it is still an
 * open Training row this session may tick, and otherwise nothing. Left out,
 * the earliest such row ticks, which is every finish path that has no card.
 */
export function tickTrainingForWorkout(
  db: Database,
  workoutId: string,
  today: string,
  only?: string | null
): TrainingTick | null {
  if (only === null) return null;
  const workout = db.get<{ date: string; routine_id: string | null; away: number }>(
    'SELECT date, routine_id, away FROM workouts WHERE id = ?',
    [workoutId]
  );
  if (!workout) return null;
  const session: SessionForTick = {
    date: workout.date,
    routineId: workout.routine_id,
    away: workout.away === 1,
  };
  if (session.away || session.date !== today) return null;
  // One row per session, ever: a second call for the same save writes nothing.
  const already = db.get<{ one: number }>(
    `SELECT 1 AS one FROM log_entries WHERE json_extract(value, '$.by_workout') = ? LIMIT 1`,
    [workoutId]
  );
  if (already) return null;

  arriveDay(db, today);
  const eligible = eligibleTrainingRows(db, session, today);
  const row = only === undefined ? eligible[0] : eligible.find((r) => r.id === only);
  if (!row) return null;
  db.transaction(() => {
    setMissionStatus(db, row.id, 'completed', today);
    db.run(
      `UPDATE log_entries SET value = json_set(COALESCE(value, '{}'), '$.by_workout', ?)
        WHERE id = ? AND status = 'completed'`,
      [workoutId, row.id]
    );
  });
  rederiveDaysAhead(db, today);
  return { entryId: row.id, workoutId, title: row.title, date: today };
}

/**
 * The Undo: put back exactly the row this tick ticked. Throws, writing
 * nothing, when that row no longer holds this session's tick — he un-ticked
 * it on Home, or it was removed — so a late Undo can never re-open a row he
 * decided about since. A thrown Undo is a refused one (undo-store.ts).
 */
export function untickTraining(db: Database, tick: TrainingTick, today: string): void {
  const row = db.get<{ status: string; by: string | null }>(
    `SELECT status, json_extract(value, '$.by_workout') AS by FROM log_entries WHERE id = ?`,
    [tick.entryId]
  );
  if (!row || row.status !== 'completed' || row.by !== tick.workoutId) {
    throw new Error(`Training row ${tick.entryId} no longer holds this session's tick`);
  }
  setMissionStatus(db, tick.entryId, 'pending', today);
  rederiveDaysAhead(db, today);
}

/** The rows still completed AND marked with this session — what its delete re-opens. */
function heldTicks(db: Database, workoutId: string): { id: string; title: string }[] {
  return db.all<{ id: string; title: string }>(
    `SELECT id, title FROM log_entries
      WHERE status = 'completed' AND json_extract(value, '$.by_workout') = ?
      ORDER BY created_at, id`,
    [workoutId]
  );
}

/**
 * The titles {@link releaseWorkoutTick} would re-open, read-only — so the
 * Coach's delete card can say so before the gate (fix3, 2026-10-21).
 */
export function workoutTickTitles(db: Database, workoutId: string): string[] {
  return heldTicks(db, workoutId).map((row) => row.title);
}

/**
 * Deleting a session takes back the tick it made, and only that one: every
 * row still completed AND marked with this session goes back to pending
 * through the normal path. A row he ticked by hand carries no mark (or lost
 * it when he un-ticked), so it is never touched. Returns the titles re-opened.
 *
 * Called by `deleteWorkout` after its DELETE, so the session screen and the
 * Coach's `delete_record` share it.
 */
export function releaseWorkoutTick(db: Database, workoutId: string, today: string): string[] {
  const rows = heldTicks(db, workoutId);
  if (rows.length === 0) return [];
  for (const row of rows) setMissionStatus(db, row.id, 'pending', today);
  rederiveDaysAhead(db, today);
  return rows.map((row) => row.title);
}
