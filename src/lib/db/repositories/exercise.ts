/**
 * The Exercise sub-app's data layer: sessions in, the week's training out.
 *
 * A session is one `workouts` row plus zero or more `workout_sets` children
 * (db/migrations/0003_exercise.sql). Strength sessions carry sets; cardio and
 * mobility usually carry only a duration. Set weight is CANONICAL kg — the UI
 * converts lb at the edge (src/lib/exercise/format.ts), matching how
 * body_metrics stores weight, so a future unit toggle never touches this file.
 *
 * Works against the {@link Database} interface only — never op-sqlite — so the
 * exact same code runs on device and in the headless tests (db/exercise.test.mjs).
 */
import type { Database } from '../database';
import { localWeekRange } from '../date';
import { newId } from '../id';
import type { DateString } from '../types';
import { resolveExerciseByName } from './exercise-catalog';
import { pairedIngestFor, pairedIngestForMany } from './workout-ingest';
import {
  asMeasures,
  maskByMeasures,
  type MeasuredFields,
  type Measures,
} from '@/lib/exercise/measures';
import type {
  LogWorkoutInput,
  RecentSession,
  SetInput,
  WeekSummary,
  WorkoutDetail,
  WorkoutRow,
  WorkoutSetRow,
} from '@/lib/exercise/types';

/**
 * Every set goes through here, which is exactly why the catalog-id backstop
 * lives here (2026-08-14).
 *
 * `exercise_id` is not decoration: it is the join `recentMuscleLoads` uses to
 * find the muscles a set worked, so a set stored with a NULL one is invisible
 * to muscle freshness, e1RM, PRs, weekly volume and progression alike. Three of
 * the four callers could produce that null — the Manual-log screen never asked
 * which movement it was, the Coach matched names strictly, an unmatched photo
 * import stayed free text — and the owner's whole back day moved the body
 * figure by almost nothing as a result.
 *
 * Fixing them one screen at a time would leave the fourth to find later, so the
 * resolve happens at the one point they all pass through. An id supplied by the
 * caller is always honoured; the lookup runs only when there is none
 * ({@link resolveExerciseByName} is confidence-gated and returns null rather
 * than guessing, so a genuinely custom movement still stores free text).
 */
function insertSet(db: Database, workoutId: string, set: SetInput, setIndex: number): string {
  const id = newId(db);
  const exerciseId = set.exerciseId ?? resolveExerciseByName(db, set.exercise);
  const fields = measuredFields(db, exerciseId, set);
  db.run(
    `INSERT INTO workout_sets
       (id, workout_id, exercise, set_index, reps, weight_kg,
        exercise_id, set_type, rpe, duration_sec, distance_m, superset_group)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      workoutId,
      set.exercise,
      setIndex,
      fields.reps,
      fields.weightKg,
      exerciseId,
      set.setType ?? 'normal',
      set.rpe ?? null,
      fields.durationSec,
      fields.distanceM,
      set.supersetGroup ?? null,
    ]
  );
  return id;
}

/**
 * **A set carries the fields its exercise implies** (migration 0046) — the
 * cross-table rule, enforced here because the schema cannot enforce it.
 *
 * A plank measures time; reps on a plank are not a small inaccuracy, they are a
 * number that would go on to count as volume, feed `setStrength`, and read as a
 * rep record on a movement that has none. So whatever the caller passes, only
 * the columns the movement actually measures survive; the rest store NULL.
 *
 * ## Why not a CHECK
 *
 * The obvious form is a cross-column CHECK on `workout_sets`, and 0034 is why
 * it is not: a constraint added by ALTER is validated against the table as it
 * IS, so one written against an empty test fixture passes CI and then rejects
 * the ALTER on the owner's populated device — where the offending rows are his
 * own training history and there is no second copy to restore from. A CHECK
 * would also have to reach `exercises` to know what the movement measures,
 * which SQLite does not allow at all.
 *
 * ## Why NULL rather than throw
 *
 * Every caller writes inside `logWorkout`/`replaceWorkout`'s single
 * transaction, so a throw here rolls the WHOLE session back — losing sets that
 * were fine because one field was surplus. The loggers never send a surplus
 * field (they draw the columns from the same `measures`); the ones that can are
 * the Coach and the photo import, i.e. a model, and quietly refusing a model's
 * invented reps is the right answer rather than failing the user's save.
 *
 * A set with no catalog movement (free text, `exercise_id` null) has nothing to
 * imply anything, so it keeps whatever it was given.
 */
function measuredFields(db: Database, exerciseId: string | null, set: SetInput): MeasuredFields {
  const given = {
    reps: set.reps ?? null,
    weightKg: set.weightKg ?? null,
    durationSec: set.durationSec ?? null,
    distanceM: set.distanceM ?? null,
  };
  const measures = exerciseId == null ? null : exerciseMeasures(db, exerciseId);
  return measures == null ? given : maskByMeasures(measures, given);
}

/**
 * What one catalog movement measures, or null when the id names no live row.
 * Exported because the Coach's `log_workout` confirmation card has to mask its
 * display line with exactly what {@link measuredFields} will store — see
 * {@link maskByMeasures} for why that had to become one rule.
 */
export function exerciseMeasures(db: Database, exerciseId: string): Measures | null {
  const row = db.get<{ measures: string }>('SELECT measures FROM exercises WHERE id = ?', [
    exerciseId,
  ]);
  return row ? asMeasures(row.measures) : null;
}

/**
 * Persist one session and its sets in a single transaction — a CHECK violation
 * on any set rolls the whole workout back, so a session can never half-save.
 * Returns the new workout id.
 *
 * ## `workouts.name` is dormant, not gone (owner, 2026-08-14)
 *
 * *"Workouts dont need names, remove this."* No screen asks for one now and no
 * screen shows one, and `input.name` defaults to `''` here so a caller does not
 * have to invent one.
 *
 * The column itself stays `text NOT NULL` and that is a deliberate call, not
 * laziness. SQLite cannot drop a NOT NULL constraint in place: it needs the
 * twelve-step table rebuild — create the replacement, copy every row, drop the
 * original, rename, then re-create the index, the `updated_at` trigger and the
 * `workout_sets.workout_id` foreign key that points at it. Dropping the parent
 * of a live FK while `PRAGMA foreign_keys = ON` is exactly the manoeuvre that
 * loses child rows if any step of it is wrong, and `workout_sets` is the
 * owner's execution history — years of it eventually, and no server copy
 * anywhere, because ARC is local-first by design. The upside of the rebuild is
 * one unused column. That trade is not close.
 *
 * So it joins the 0020 program tables as schema that a device keeps and nothing
 * reads. If it ever needs to actually go, it goes in a migration whose only job
 * is that, with a backup taken first — not as a footnote to a UI change.
 */
export function logWorkout(db: Database, input: LogWorkoutInput, sets: SetInput[] = []): string {
  const id = newId(db);
  db.transaction(() => {
    db.run(
      `INSERT INTO workouts (id, date, name, kind, duration_min, notes, routine_id, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.date,
        input.name ?? '',
        input.kind,
        input.durationMin ?? null,
        input.notes ?? null,
        input.routineId ?? null,
        // 0054. Omitted means "no knowable span", which is the honest reading
        // for a backdated log, a photo import and anything the Coach writes —
        // and it is what keeps those from auto-pairing with whatever the watch
        // happened to record that day. Only the live logger passes one.
        input.startedAt ?? null,
      ]
    );
    sets.forEach((set, i) => insertSet(db, id, set, i + 1));
  });
  return id;
}

/**
 * One past session, with its sets in performed order — what the editor opens
 * (owner, 2026-08-14: *"Introduce the ability to edit and view past
 * workouts"*). `undefined` when the id is unknown.
 *
 * Ordering is `set_index`, then `rowid` for the pre-0013 rows whose index is
 * NULL, so a session logged before the structured logger existed still opens in
 * the order it was written rather than in whatever order the page returns.
 */
export function getWorkoutDetail(db: Database, id: string): WorkoutDetail | undefined {
  const row = db.get<WorkoutRow>('SELECT * FROM workouts WHERE id = ?', [id]);
  if (!row) return undefined;
  const sets = db.all<WorkoutSetRow>(
    `SELECT * FROM workout_sets WHERE workout_id = ?
     ORDER BY set_index IS NULL, set_index, rowid`,
    [id]
  );
  // The watch's record of this same session, JOINED through the 0054 link —
  // never copied onto the row, so a corrected calorie figure corrects here too.
  const ingested = pairedIngestFor(db, id);
  return {
    id: row.id,
    date: row.date,
    kind: row.kind,
    durationMin: row.duration_min,
    notes: row.notes,
    routineId: row.routine_id,
    createdAt: row.created_at,
    ...(ingested ? { ingested } : {}),
    sets: sets.map((s) => ({
      id: s.id,
      exercise: s.exercise,
      exerciseId: s.exercise_id,
      setIndex: s.set_index,
      reps: s.reps,
      weightKg: s.weight_kg,
      rpe: s.rpe,
      setType: s.set_type,
      durationSec: s.duration_sec,
      distanceM: s.distance_m,
      supersetGroup: s.superset_group,
    })),
  };
}

/**
 * Rewrite a past session: the workout's own fields, and its sets replaced
 * wholesale, in one transaction.
 *
 * **Delete-and-reinsert, not a diff.** The editor hands back a list of sets in
 * their new order, and a set has no identity the user can see — reordering,
 * inserting in the middle and deleting are all just "the list is different
 * now". Matching rows up to preserve `workout_sets.id` would buy nothing
 * (nothing references a set) and cost a merge algorithm that can be subtly
 * wrong. The transaction is what makes it safe: a CHECK violation on any set
 * rolls back to the sets that were there before, so a bad edit cannot leave a
 * session emptied.
 *
 * Everything derived — muscle freshness, e1RM history, PRs, weekly volume,
 * progression targets — is computed from `workout_sets` at read time, with the
 * screens re-reading on focus, so correcting a session moves all of it with no
 * cache to invalidate. db/exercise.test.mjs §7 pins that end to end.
 */
export function replaceWorkout(
  db: Database,
  id: string,
  input: Omit<LogWorkoutInput, 'date'> & { date?: DateString },
  sets: SetInput[]
): void {
  db.transaction(() => {
    const existing = db.get<{ date: DateString }>('SELECT date FROM workouts WHERE id = ?', [id]);
    if (!existing) throw new Error(`No workout ${id}`);
    db.run(`UPDATE workouts SET date = ?, kind = ?, duration_min = ?, notes = ? WHERE id = ?`, [
      input.date ?? existing.date,
      input.kind,
      input.durationMin ?? null,
      input.notes ?? null,
      id,
    ]);
    db.run('DELETE FROM workout_sets WHERE workout_id = ?', [id]);
    sets.forEach((set, i) => insertSet(db, id, set, i + 1));
  });
}

/**
 * Delete a session and its sets. The sets go with it through
 * `workout_sets.workout_id`'s `ON DELETE CASCADE` (0003) — which is the right
 * cascade here, unlike the ones pointing at a log from a protocol: a set has no
 * meaning without the session it belongs to, so an orphan would be worse than
 * nothing. Unknown ids are a no-op.
 */
export function deleteWorkout(db: Database, id: string): void {
  db.run('DELETE FROM workouts WHERE id = ?', [id]);
}

/**
 * Append one set to an existing workout, continuing its 1-based set_index.
 *
 * A session logged before the 0013 structured logger has every set at
 * `set_index = NULL`, and `getWorkoutDetail` orders `set_index IS NULL,
 * set_index, rowid` — so a NOT-NULL index (which is what `max(set_index)+1`
 * would produce, since `max` of all-NULLs is NULL → 1) sorts AHEAD of those
 * NULL rows and the "append" visually prepends. So reindex the whole session
 * to 1..n by its current performed order first, the way `replaceWorkout` does,
 * then the new set lands at n+1 and reads last. All in one transaction.
 */
export function addSet(db: Database, workoutId: string, set: SetInput): string {
  let id = '';
  db.transaction(() => {
    const existing = db.all<{ id: string }>(
      `SELECT id FROM workout_sets WHERE workout_id = ?
       ORDER BY set_index IS NULL, set_index, rowid`,
      [workoutId]
    );
    existing.forEach((r, i) => {
      db.run('UPDATE workout_sets SET set_index = ? WHERE id = ?', [i + 1, r.id]);
    });
    id = insertSet(db, workoutId, set, existing.length + 1);
  });
  return id;
}

// `localWeekRange` (the Monday-start "this week" definition) now lives in the
// shared date module so the Exercise screen, the Data tab, and the Coach all
// agree. Re-exported here because the training screens import it from this repo.
export { localWeekRange };

/**
 * "This week" aggregates: Zone 2 (cardio) minutes and strength-session count.
 * Empty-safe — a fresh database reports zeros. `now` is injectable so the
 * headless tests are deterministic.
 */
export function weekSummary(db: Database, now: Date = new Date()): WeekSummary {
  const { start, end } = localWeekRange(now);
  const row = db.get<{ zone2: number | null; strength: number | null }>(
    `SELECT
       sum(CASE WHEN kind = 'cardio' THEN coalesce(duration_min, 0) ELSE 0 END) AS zone2,
       sum(CASE WHEN kind = 'strength' THEN 1 ELSE 0 END) AS strength
     FROM workouts
     WHERE date >= ? AND date <= ?`,
    [start, end]
  );
  return { zone2Min: row?.zone2 ?? 0, strengthSessions: row?.strength ?? 0 };
}

export interface WeekPoint {
  weekStart: string;
  zone2Min: number;
  strengthCount: number;
  /**
   * Total sessions that week across every kind — the "has data" signal. The
   * headline aggregates only cover cardio (zone2Min) and strength (strengthCount);
   * a week of only mobility/other sessions has real workouts but zero of both, so
   * emptiness must key on this count, not on the headline metrics.
   */
  workoutCount: number;
}

/**
 * Zone 2 minutes + strength-session count per Monday-start week, oldest ->
 * current, zero-filled — the Exercise trend chart's data source. Steps back
 * 7 days per prior week and reuses {@link localWeekRange} / {@link
 * weekSummary}'s own aggregation for each week's bounds, so "current week"
 * here matches weekSummary's definition exactly. `now` is injectable so the
 * headless tests are deterministic.
 */
export function weeklyTrainingSeries(
  db: Database,
  weeks: number = 6,
  now: Date = new Date()
): WeekPoint[] {
  const points: WeekPoint[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const weekNow = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i * 7);
    const { start, end } = localWeekRange(weekNow);
    const row = db.get<{ zone2: number | null; strength: number | null; total: number | null }>(
      `SELECT
         sum(CASE WHEN kind = 'cardio' THEN coalesce(duration_min, 0) ELSE 0 END) AS zone2,
         sum(CASE WHEN kind = 'strength' THEN 1 ELSE 0 END) AS strength,
         count(*) AS total
       FROM workouts
       WHERE date >= ? AND date <= ?`,
      [start, end]
    );
    points.push({
      weekStart: start,
      zone2Min: row?.zone2 ?? 0,
      strengthCount: row?.strength ?? 0,
      workoutCount: row?.total ?? 0,
    });
  }
  return points;
}

/**
 * Recent sessions, newest first (by date, then by insertion time within a
 * date), each with its set count and the movements it contained. Empty-safe.
 *
 * The movements arrive as a `json_group_array` of one row per set, ordered, and
 * are de-duplicated in JS. SQLite has no ordered `DISTINCT` inside an
 * aggregate, and a second query per session would be the N+1 the catalog repo
 * already refuses; over six sessions this stays one statement.
 *
 * They exist because the list has nothing to call a session any more (owner,
 * 2026-08-14: workouts have no names). "Lat Pulldown · Barbell Row · Seated
 * Cable Row" is a better title than "Back day" ever was — it is what happened,
 * not what someone typed before it happened.
 */
export function listRecentSessions(db: Database, limit: number = 10): RecentSession[] {
  const rows = db.all<WorkoutRow & { set_count: number; movements_json: string | null }>(
    `SELECT w.*, count(s.id) AS set_count,
            (SELECT json_group_array(x.exercise) FROM (
               SELECT s2.exercise AS exercise FROM workout_sets s2
               WHERE s2.workout_id = w.id AND s2.set_type != 'warmup'
               ORDER BY s2.set_index IS NULL, s2.set_index, s2.rowid
             ) x) AS movements_json
     FROM workouts w
     LEFT JOIN workout_sets s ON s.workout_id = w.id
     GROUP BY w.id
     ORDER BY w.date DESC, w.created_at DESC, w.id
     LIMIT ?`,
    [limit]
  );
  // One statement for the page (0054), not one per row — the N+1 the catalog
  // repo already refuses. Empty-safe.
  const paired = pairedIngestForMany(
    db,
    rows.map((r) => r.id)
  );
  return rows.map((r) => {
    let names: string[] = [];
    try {
      const parsed: unknown = r.movements_json ? JSON.parse(r.movements_json) : [];
      if (Array.isArray(parsed)) names = parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      names = [];
    }
    return {
      id: r.id,
      date: r.date,
      name: r.name,
      kind: r.kind,
      durationMin: r.duration_min,
      setCount: r.set_count,
      movements: [...new Set(names.map((n) => n.trim()).filter((n) => n !== ''))],
      createdAt: r.created_at,
      ...(paired.has(r.id) ? { ingested: paired.get(r.id)! } : {}),
    };
  });
}
