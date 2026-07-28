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
import { todayISODate } from '../date';
import { newId } from '../id';
import type {
  LogWorkoutInput,
  RecentSession,
  SetInput,
  WeekSummary,
  WorkoutRow,
} from '@/lib/exercise/types';

function insertSet(db: Database, workoutId: string, set: SetInput, setIndex: number): string {
  const id = newId(db);
  db.run(
    `INSERT INTO workout_sets
       (id, workout_id, exercise, set_index, reps, weight_kg,
        exercise_id, set_type, rpe, duration_sec, superset_group)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      workoutId,
      set.exercise,
      setIndex,
      set.reps ?? null,
      set.weightKg ?? null,
      set.exerciseId ?? null,
      set.setType ?? 'normal',
      set.rpe ?? null,
      set.durationSec ?? null,
      set.supersetGroup ?? null,
    ]
  );
  return id;
}

/**
 * Persist one session and its sets in a single transaction — a CHECK violation
 * on any set rolls the whole workout back, so a session can never half-save.
 * Returns the new workout id.
 */
export function logWorkout(db: Database, input: LogWorkoutInput, sets: SetInput[] = []): string {
  const id = newId(db);
  db.transaction(() => {
    db.run(
      `INSERT INTO workouts (id, date, name, kind, duration_min, notes, routine_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.date,
        input.name,
        input.kind,
        input.durationMin ?? null,
        input.notes ?? null,
        input.routineId ?? null,
      ]
    );
    sets.forEach((set, i) => insertSet(db, id, set, i + 1));
  });
  return id;
}

/** Append one set to an existing workout, continuing its 1-based set_index. */
export function addSet(db: Database, workoutId: string, set: SetInput): string {
  const row = db.get<{ next: number }>(
    'SELECT coalesce(max(set_index), 0) + 1 AS next FROM workout_sets WHERE workout_id = ?',
    [workoutId]
  );
  return insertSet(db, workoutId, set, row?.next ?? 1);
}

/**
 * The Monday-start local calendar week containing `now`, as inclusive
 * YYYY-MM-DD bounds — the meaning of "This week" on the Exercise screen.
 * Local like todayISODate: a Sunday-night session belongs to the week the
 * wall clock says it does.
 */
export function localWeekRange(now: Date = new Date()): { start: string; end: string } {
  const sinceMonday = (now.getDay() + 6) % 7; // getDay: 0 = Sunday
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - sinceMonday);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return { start: todayISODate(monday), end: todayISODate(sunday) };
}

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
 * date), each with its set count. Empty-safe.
 */
export function listRecentSessions(db: Database, limit: number = 10): RecentSession[] {
  const rows = db.all<WorkoutRow & { set_count: number }>(
    `SELECT w.*, count(s.id) AS set_count
     FROM workouts w
     LEFT JOIN workout_sets s ON s.workout_id = w.id
     GROUP BY w.id
     ORDER BY w.date DESC, w.created_at DESC, w.id
     LIMIT ?`,
    [limit]
  );
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    name: r.name,
    kind: r.kind,
    durationMin: r.duration_min,
    setCount: r.set_count,
    createdAt: r.created_at,
  }));
}
