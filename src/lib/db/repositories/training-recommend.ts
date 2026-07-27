/**
 * Compose the "Train today" recommendation from the repos + the pure engine
 * (docs/exercise-subapp.md §4.4). This is the DB↔engine seam: it reads recent
 * loads → the freshness ledger, scores each routine's exercises for freshness +
 * progression, and hands the whole thing to the pure `recommendToday` selector.
 * With no routines it builds a freshest-muscle fallback. Depends only on the
 * {@link Database} interface (+ pure modules), so it runs in the headless tests.
 *
 * This is the seam where an online, AI-assisted recommendation would layer in
 * later (src/lib/exercise/coach-assist.ts): the rule-based result computed here
 * is the offline default the Coach refines, never replaces.
 */
import type { Database } from '../database';
import { getExercise, listExercises } from './exercise-catalog';
import { getRoutine, listRoutines } from './routines';
import { exerciseSessionTops, recentMuscleLoads } from './training-stats';
import {
  ANCHOR_MUSCLES,
  FRESHNESS_LOOKBACK_DAYS,
  REP_RANGE,
  progressionIncrementKg,
} from '@/lib/exercise/constants';
import { meanFreshness, muscleFreshness } from '@/lib/exercise/freshness';
import { suggestProgression } from '@/lib/exercise/progression';
import { type RoutineCandidate, recommendToday } from '@/lib/exercise/recommend';
import type {
  CatalogExercise,
  Muscle,
  MuscleFreshness,
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
  recommendation: Recommendation;
};

/** The freshness ledger + today's recommendation. `now` injected for tests. */
export function buildRecommendation(db: Database, now: Date = new Date()): TrainingRecommendation {
  const ledger = muscleFreshness(recentMuscleLoads(db, FRESHNESS_LOOKBACK_DAYS, now), now);
  const routines = listRoutines(db);
  const candidates: RoutineCandidate[] = routines.map((r) => ({
    routineId: r.id,
    routineName: r.name,
    lastStartedAt: r.lastStartedAt,
    exercises: scoreRoutineExercises(db, ledger, r.id),
  }));
  const fallbackExercises = routines.length === 0 ? freshestMuscleFallback(db, ledger) : [];
  const recommendation = recommendToday({ ledger, routines: candidates, fallbackExercises }, now);
  return { ledger, recommendation };
}

// Re-export the muscle type users of this module commonly need.
export type { Muscle };
