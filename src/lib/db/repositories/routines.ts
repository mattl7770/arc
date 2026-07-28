/**
 * The routines data layer (0012_routines.sql).
 *
 * A routine is a named, ordered exercise list with per-exercise targets. The
 * builder saves the whole line set atomically (delete + reinsert inside one
 * transaction — routine_exercises has no external references, so a full replace
 * is simplest and can't strand orphans). `last_started_at` is stamped when a
 * workout is started from the routine, powering "last done N days ago".
 *
 * Depends only on the {@link Database} interface — runs on device and in
 * db/routines.test.mjs against node:sqlite.
 */
import type { Database } from '../database';
import { newId } from '../id';
import type {
  Muscle,
  RoutineDetail,
  RoutineExerciseDetail,
  RoutineInput,
  RoutineListItem,
  RoutineRow,
} from '@/lib/exercise/types';

/** Insert the ordered exercise lines for a routine (position = 1-based order). */
function insertLines(db: Database, routineId: string, input: RoutineInput): void {
  input.exercises.forEach((ex, i) => {
    db.run(
      `INSERT INTO routine_exercises
         (id, routine_id, exercise_id, position, target_sets, rep_low, rep_high, rest_sec)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId(db), routineId, ex.exerciseId, i + 1, ex.targetSets, ex.repLow, ex.repHigh, ex.restSec]
    );
  });
}

/** Create a routine and its lines in one transaction. Returns the routine id. */
export function createRoutine(db: Database, input: RoutineInput): string {
  const id = newId(db);
  db.transaction(() => {
    db.run('INSERT INTO routines (id, name, notes) VALUES (?, ?, ?)', [
      id,
      input.name.trim(),
      input.notes,
    ]);
    insertLines(db, id, input);
  });
  return id;
}

/**
 * Overwrite a routine's identity and lines atomically: update the row, delete
 * the old lines, insert the new ones. A full replace keeps position contiguous
 * and avoids diffing.
 */
export function updateRoutine(db: Database, id: string, input: RoutineInput): void {
  db.transaction(() => {
    db.run('UPDATE routines SET name = ?, notes = ? WHERE id = ?', [
      input.name.trim(),
      input.notes,
      id,
    ]);
    db.run('DELETE FROM routine_exercises WHERE routine_id = ?', [id]);
    insertLines(db, id, input);
  });
}

/** Delete a routine (its lines CASCADE; workouts run under it keep a null link). */
export function deleteRoutine(db: Database, id: string): void {
  db.run('DELETE FROM routines WHERE id = ?', [id]);
}

/** Stamp when a routine was last used to start a workout. */
export function touchRoutineStarted(db: Database, id: string, whenIso: string): void {
  db.run('UPDATE routines SET last_started_at = ? WHERE id = ?', [whenIso, id]);
}

/**
 * Routines for the hub list — active only, name-ordered, each with its exercise
 * count, total target sets, and last-started stamp. json1 counts/sums in SQL so
 * the list never loads the lines. Empty-safe.
 */
export function listRoutines(db: Database): RoutineListItem[] {
  const rows = db.all<RoutineRow & { exercise_count: number | null; total_sets: number | null }>(
    `SELECT r.*,
            count(re.id) AS exercise_count,
            coalesce(sum(re.target_sets), 0) AS total_sets
     FROM routines r
     LEFT JOIN routine_exercises re ON re.routine_id = r.id
     WHERE r.archived = 0
     GROUP BY r.id
     ORDER BY r.name COLLATE NOCASE, r.id`
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    exerciseCount: r.exercise_count ?? 0,
    totalSets: r.total_sets ?? 0,
    lastStartedAt: r.last_started_at,
  }));
}

/** One routine with its ordered exercises (joined name + primary muscles), or undefined. */
export function getRoutine(db: Database, id: string): RoutineDetail | undefined {
  const routine = db.get<RoutineRow>('SELECT * FROM routines WHERE id = ?', [id]);
  if (!routine) return undefined;
  const lines = db.all<{
    id: string;
    exercise_id: string;
    exercise_name: string;
    position: number;
    target_sets: number;
    rep_low: number | null;
    rep_high: number | null;
    rest_sec: number | null;
    primary_json: string | null;
  }>(
    `SELECT re.id, re.exercise_id, e.name AS exercise_name, re.position,
            re.target_sets, re.rep_low, re.rep_high, re.rest_sec,
            (SELECT json_group_array(m.muscle)
             FROM exercise_muscles m
             WHERE m.exercise_id = re.exercise_id AND m.role = 'primary') AS primary_json
     FROM routine_exercises re
     JOIN exercises e ON e.id = re.exercise_id
     WHERE re.routine_id = ?
     ORDER BY re.position`,
    [id]
  );
  const exercises: RoutineExerciseDetail[] = lines.map((l) => ({
    id: l.id,
    exerciseId: l.exercise_id,
    exerciseName: l.exercise_name,
    position: l.position,
    targetSets: l.target_sets,
    repLow: l.rep_low,
    repHigh: l.rep_high,
    restSec: l.rest_sec,
    primaryMuscles: (l.primary_json ? (JSON.parse(l.primary_json) as Muscle[]) : []) ?? [],
  }));
  return {
    id: routine.id,
    name: routine.name,
    notes: routine.notes,
    archived: routine.archived === 1,
    exercises,
  };
}
