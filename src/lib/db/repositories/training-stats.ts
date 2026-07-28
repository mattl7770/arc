/**
 * Training analytics reads — the data the rule-based engine and the exercise
 * detail screen run on (docs/exercise-subapp.md §4). Per-exercise history and
 * personal records, the e1RM trend, previous-set prefill, and the recent
 * per-muscle set loads that drive the freshness ledger.
 *
 * These reads compute e1RM/PRs by importing the PURE e1rm module (no DB), so
 * there is one estimator shared by screens, the recommender, and the tests.
 * The repo itself still depends only on the {@link Database} interface, so it
 * runs headless in db/training-engine.test.mjs. Warmup sets are excluded from
 * every stat (the Hevy/Strong rule).
 */
import type { Database } from '../database';
import type { DateString } from '../types';
import { localWeekRange } from './exercise';
import { e1rmForSet } from '@/lib/exercise/e1rm';
import type {
  E1rmPoint,
  Muscle,
  MuscleLoad,
  MuscleRole,
  PersonalRecords,
  SetType,
} from '@/lib/exercise/types';
import type { SessionTopSet } from '@/lib/exercise/progression';

const ROLE_WEIGHT: Record<MuscleRole, number> = { primary: 1, secondary: 0.5 };

type SetRow = {
  workout_id: string;
  date: DateString;
  when_iso: string;
  reps: number | null;
  weight_kg: number | null;
  rpe: number | null;
  set_type: SetType;
};

/** Every non-warmup set logged for an exercise, newest workout first. */
function workingSets(db: Database, exerciseId: string): SetRow[] {
  return db.all<SetRow>(
    `SELECT s.workout_id, w.date, w.created_at AS when_iso,
            s.reps, s.weight_kg, s.rpe, s.set_type
     FROM workout_sets s
     JOIN workouts w ON w.id = s.workout_id
     WHERE s.exercise_id = ? AND s.set_type != 'warmup'
     ORDER BY w.date DESC, w.created_at DESC, s.set_index`,
    [exerciseId]
  );
}

/** The "strength" of a set for picking the best per session: e1RM, else load. */
function setStrength(s: SetRow): number {
  const e = e1rmForSet(s.weight_kg, s.reps, s.rpe, s.set_type);
  if (e != null) return e;
  return s.weight_kg ?? 0;
}

/**
 * Best working set per session for an exercise, oldest → newest, capped at
 * `limit` most-recent sessions — the input to progression + the e1RM trend.
 */
export function exerciseSessionTops(db: Database, exerciseId: string, limit = 12): SessionTopSet[] {
  const rows = workingSets(db, exerciseId);
  const byWorkout = new Map<string, { date: DateString; best: SetRow }>();
  for (const r of rows) {
    const cur = byWorkout.get(r.workout_id);
    if (!cur || setStrength(r) > setStrength(cur.best)) {
      byWorkout.set(r.workout_id, { date: r.date, best: r });
    }
  }
  // rows are newest-first, so map insertion order is newest-first; take the most
  // recent `limit` and flip to oldest-first for the progression walk.
  const sessions = [...byWorkout.values()].slice(0, limit).reverse();
  return sessions.map(({ date, best }) => ({
    date,
    weightKg: best.weight_kg,
    reps: best.reps,
    rpe: best.rpe,
  }));
}

/** Personal records for one exercise (all canonical kg). Empty-safe (nulls). */
export function personalRecords(db: Database, exerciseId: string): PersonalRecords {
  const rows = workingSets(db, exerciseId);
  let maxWeightKg: number | null = null;
  let bestE1rmKg: number | null = null;
  let bestSetVolumeKg: number | null = null;
  for (const r of rows) {
    if (r.weight_kg != null) {
      if (maxWeightKg == null || r.weight_kg > maxWeightKg) maxWeightKg = r.weight_kg;
      if (r.reps != null) {
        const vol = r.weight_kg * r.reps;
        if (bestSetVolumeKg == null || vol > bestSetVolumeKg) bestSetVolumeKg = vol;
      }
    }
    const e = e1rmForSet(r.weight_kg, r.reps, r.rpe, r.set_type);
    if (e != null && (bestE1rmKg == null || e > bestE1rmKg)) bestE1rmKg = e;
  }
  return { maxWeightKg, bestE1rmKg, bestSetVolumeKg };
}

/** Best e1RM per session date, oldest → newest, capped at `limit` — the trend. */
export function e1rmSeries(db: Database, exerciseId: string, limit = 12): E1rmPoint[] {
  const rows = workingSets(db, exerciseId);
  const byDate = new Map<DateString, number>();
  for (const r of rows) {
    const e = e1rmForSet(r.weight_kg, r.reps, r.rpe, r.set_type);
    if (e == null) continue;
    const cur = byDate.get(r.date);
    if (cur == null || e > cur) byDate.set(r.date, e);
  }
  // byDate keys arrive newest-first (rows are date DESC); take latest `limit`,
  // then sort ascending by date for the chart.
  return [...byDate.entries()]
    .slice(0, limit)
    .map(([date, e1rm]) => ({ date, e1rm: Math.round(e1rm * 10) / 10 }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** One prior set for the previous-values prefill in the logger. */
export type PrevSet = { reps: number | null; weightKg: number | null; rpe: number | null };

/**
 * The sets from the most recent session that included this exercise, in set
 * order — the placeholders the logger pre-fills so a repeat is one confirm per
 * set. Includes warmups (the logger shows them too). Empty when never done.
 */
export function lastSessionSets(db: Database, exerciseId: string): PrevSet[] {
  const latest = db.get<{ workout_id: string }>(
    `SELECT s.workout_id
     FROM workout_sets s JOIN workouts w ON w.id = s.workout_id
     WHERE s.exercise_id = ?
     ORDER BY w.date DESC, w.created_at DESC
     LIMIT 1`,
    [exerciseId]
  );
  if (!latest) return [];
  const rows = db.all<{ reps: number | null; weight_kg: number | null; rpe: number | null }>(
    `SELECT reps, weight_kg, rpe FROM workout_sets
     WHERE workout_id = ? AND exercise_id = ? AND set_type != 'warmup'
     ORDER BY set_index`,
    [latest.workout_id, exerciseId]
  );
  return rows.map((r) => ({ reps: r.reps, weightKg: r.weight_kg, rpe: r.rpe }));
}

/**
 * Every non-warmup set in the last `days`, expanded to (muscle, role-weight)
 * loads — the fuel for the freshness ledger. One input row becomes one output
 * row per muscle it works. `now` injected for deterministic tests.
 */
export function recentMuscleLoads(
  db: Database,
  days: number,
  now: Date = new Date()
): MuscleLoad[] {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const rows = db.all<{
    reps: number | null;
    weight_kg: number | null;
    rpe: number | null;
    set_type: SetType;
    when_iso: string;
    muscle: Muscle;
    role: MuscleRole;
  }>(
    `SELECT s.reps, s.weight_kg, s.rpe, s.set_type, w.created_at AS when_iso, m.muscle, m.role
     FROM workout_sets s
     JOIN workouts w ON w.id = s.workout_id
     JOIN exercise_muscles m ON m.exercise_id = s.exercise_id
     WHERE s.exercise_id IS NOT NULL AND s.set_type != 'warmup' AND w.created_at >= ?`,
    [cutoff]
  );
  return rows.map((r) => ({
    muscle: r.muscle,
    roleWeight: ROLE_WEIGHT[r.role],
    reps: r.reps,
    rpe: r.rpe,
    weightKg: r.weight_kg,
    setType: r.set_type,
    whenIso: r.when_iso,
  }));
}

/**
 * Fractional weekly set count per muscle (primary 1.0, secondary 0.5) for the
 * current Monday-start week — the volume side of the ledger. Empty-safe.
 */
export function weeklyMuscleSets(
  db: Database,
  now: Date = new Date()
): { muscle: Muscle; sets: number }[] {
  const { start, end } = localWeekRange(now);
  const rows = db.all<{ muscle: Muscle; sets: number }>(
    `SELECT m.muscle AS muscle,
            sum(CASE WHEN m.role = 'primary' THEN 1.0 ELSE 0.5 END) AS sets
     FROM workout_sets s
     JOIN workouts w ON w.id = s.workout_id
     JOIN exercise_muscles m ON m.exercise_id = s.exercise_id
     WHERE s.exercise_id IS NOT NULL AND s.set_type != 'warmup'
       AND w.date >= ? AND w.date <= ?
     GROUP BY m.muscle`,
    [start, end]
  );
  return rows.map((r) => ({ muscle: r.muscle, sets: Math.round(r.sets * 10) / 10 }));
}
