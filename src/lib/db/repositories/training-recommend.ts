/**
 * Compose the "Train today" recommendation from the repos + the pure engine
 * (docs/exercise-subapp.md §4.4). This is the DB↔engine seam: it reads recent
 * loads → the freshness ledger, scores each routine's exercises for freshness +
 * progression, and hands the whole thing to the pure `recommendToday` selector.
 * With no routines it builds a freshest-muscle fallback. Depends only on the
 * {@link Database} interface (+ pure modules), so it runs in the headless tests.
 *
 * The Coach reads this whole result through its get_training_recommendation
 * tool (src/lib/ai/tools/read-tools.ts): the rule-based state computed here is
 * the offline ground truth the Coach reasons over — the engine reports, the
 * model (with the user) decides. The old coach-assist.ts wrapper seam was
 * deleted 2026-08-08 (never called, stale premise).
 */
import type { Database } from '../database';
import { getExercise, listExercises } from './exercise-catalog';
import { listMuscleAnchors } from './muscle-anchors';
import { getRoutine, listRoutines } from './routines';
import { exerciseSessionTops, recentMuscleLoads, weeklyMuscleSets } from './training-stats';
import {
  ANCHOR_MUSCLES,
  FRESHNESS_LOOKBACK_DAYS,
  REP_RANGE,
  progressionIncrementKg,
} from '@/lib/exercise/constants';
import { meanFreshness, muscleFreshness } from '@/lib/exercise/freshness';
import { suggestProgression } from '@/lib/exercise/progression';
import { type RoutineCandidate, recommendToday } from '@/lib/exercise/recommend';
import { volumeLedger } from '@/lib/exercise/volume';
import type {
  CatalogExercise,
  Muscle,
  MuscleFreshness,
  MuscleVolume,
  ProgressionSuggestion,
  Recommendation,
  RecommendedExercise,
} from '@/lib/exercise/types';

const WEIGHT_BASED = new Set([
  'weight_reps',
  'weighted_bodyweight',
  'weight_duration',
  'assisted_bodyweight',
]);

/** The progression suggestion for one catalog exercise from its history. */
function progressionFor(db: Database, ex: CatalogExercise): ProgressionSuggestion {
  const mechanic = ex.mechanic ?? 'compound';
  const repRange = REP_RANGE[mechanic];
  if (!WEIGHT_BASED.has(ex.loggingType)) {
    return {
      kind: 'hold',
      targetWeightKg: null,
      targetReps: repRange.high,
      note: 'Progress reps or time.',
    };
  }
  return suggestProgression({
    sessions: exerciseSessionTops(db, ex.id),
    repRange,
    incrementKg: progressionIncrementKg(ex.movementPattern, ex.mechanic),
  });
}

/** Turn a routine's lines into scored RecommendedExercises. */
function scoreRoutineExercises(
  db: Database,
  ledger: MuscleFreshness[],
  routineId: string
): RecommendedExercise[] {
  const detail = getRoutine(db, routineId);
  if (!detail) return [];
  return detail.exercises.map((line) => {
    const ex = getExercise(db, line.exerciseId);
    return {
      exerciseId: line.exerciseId,
      name: line.exerciseName,
      primaryMuscles: line.primaryMuscles,
      freshness: meanFreshness(ledger, line.primaryMuscles),
      suggestion: ex
        ? progressionFor(db, ex)
        : { kind: 'hold', targetWeightKg: null, targetReps: null, note: '' },
      // The plan's working sets — what a volume dial scales, and what the
      // Coach needs to state a session in real numbers.
      targetSets: line.targetSets,
    };
  });
}

/** Freshest anchor muscles → one representative compound each (no-routines case). */
function freshestMuscleFallback(db: Database, ledger: MuscleFreshness[]): RecommendedExercise[] {
  const freshByMuscle = new Map(ledger.map((e) => [e.muscle, e.freshness]));
  const muscles = [...ANCHOR_MUSCLES]
    .sort((a, b) => (freshByMuscle.get(b) ?? 100) - (freshByMuscle.get(a) ?? 100))
    .slice(0, 4);

  const out: RecommendedExercise[] = [];
  const used = new Set<string>();
  for (const muscle of muscles) {
    const candidates = listExercises(db, { muscle });
    // Prefer a compound whose PRIMARY muscle is this one; else any match.
    const pick =
      candidates.find(
        (c) => c.mechanic === 'compound' && c.primaryMuscles.includes(muscle) && !used.has(c.id)
      ) ??
      candidates.find((c) => c.primaryMuscles.includes(muscle) && !used.has(c.id)) ??
      candidates.find((c) => !used.has(c.id));
    if (!pick) continue;
    used.add(pick.id);
    out.push({
      exerciseId: pick.id,
      name: pick.name,
      primaryMuscles: pick.primaryMuscles,
      freshness: meanFreshness(ledger, pick.primaryMuscles),
      suggestion: progressionFor(db, pick),
    });
  }
  return out;
}

export type TrainingRecommendation = {
  ledger: MuscleFreshness[];
  /** Weekly volume vs MEV/MAV/MRV per muscle. */
  volume: MuscleVolume[];
  recommendation: Recommendation;
};

export type RecommendationOptions = {
  /**
   * Caller-supplied working-volume multiplier (see RecommendInput.volumeScale).
   * NOTHING here derives it — not readiness, not freshness. It carries a
   * decision the Coach already made with the user into real per-exercise sets.
   */
  volumeScale?: number;
};

/**
 * The freshness ledger, weekly-volume ledger, and today's recommendation: the
 * freshness-based pick over the saved workouts, or the freshest-muscle fallback
 * when none exist. `now` injected for deterministic tests.
 *
 * (Programs were retired 2026-08-11 — the schedule branch that used to take
 * precedence here is gone; the 0020 tables stay in the schema, dormant. The
 * signature and result shape are unchanged, so the Coach's
 * get_training_recommendation tool is untouched.)
 */
export function buildRecommendation(
  db: Database,
  now: Date = new Date(),
  options: RecommendationOptions = {}
): TrainingRecommendation {
  // Hand-set anchors ride along (0036): a correction made on the freshness
  // screen has to reach what the app RECOMMENDS, or the figure and the session
  // it proposes are reading two different bodies.
  const ledger = muscleFreshness(
    recentMuscleLoads(db, FRESHNESS_LOOKBACK_DAYS, now),
    now,
    listMuscleAnchors(db)
  );
  const volume = volumeLedger(weeklyMuscleSets(db, now));

  const routines = listRoutines(db);
  const candidates: RoutineCandidate[] = routines.map((r) => ({
    routineId: r.id,
    routineName: r.name,
    lastStartedAt: r.lastStartedAt,
    exercises: scoreRoutineExercises(db, ledger, r.id),
  }));
  const fallbackExercises = routines.length === 0 ? freshestMuscleFallback(db, ledger) : [];
  const recommendation = recommendToday(
    { ledger, routines: candidates, fallbackExercises, volumeScale: options.volumeScale },
    now
  );
  return { ledger, volume, recommendation };
}

// Re-export the muscle type users of this module commonly need.
export type { Muscle };
