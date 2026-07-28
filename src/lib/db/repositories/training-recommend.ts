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
import { todayISODate } from '../date';
import { getExercise, listExercises } from './exercise-catalog';
import { scheduledToday } from './programs';
import { getRoutine, listRoutines } from './routines';
import { exerciseSessionTops, recentMuscleLoads, weeklyMuscleSets } from './training-stats';
import {
  ANCHOR_MUSCLES,
  FRESHNESS_LOOKBACK_DAYS,
  MUSCLE_LABEL,
  REP_RANGE,
  ROUTINE_CAUTION,
  progressionIncrementKg,
} from '@/lib/exercise/constants';
import { meanFreshness, muscleFreshness } from '@/lib/exercise/freshness';
import { suggestProgression } from '@/lib/exercise/progression';
import { type RoutineCandidate, recommendToday, routineFreshness } from '@/lib/exercise/recommend';
import { volumeLedger } from '@/lib/exercise/volume';
import type {
  CatalogExercise,
  Muscle,
  MuscleFreshness,
  MuscleVolume,
  ProgramContext,
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
  /** Weekly volume vs MEV/MAV/MRV per muscle. */
  volume: MuscleVolume[];
  recommendation: Recommendation;
};

/** The top few primary muscles of a session with their freshness, for the "why". */
function musclesLine(exercises: RecommendedExercise[], ledger: MuscleFreshness[]): string {
  const fresh = new Map(ledger.map((e) => [e.muscle, e.freshness]));
  return [...new Set(exercises.flatMap((e) => e.primaryMuscles))]
    .sort((a, b) => (fresh.get(b) ?? 0) - (fresh.get(a) ?? 0))
    .slice(0, 3)
    .map((m) => `${MUSCLE_LABEL[m]} ${fresh.get(m) ?? 100}%`)
    .join(' · ');
}

/** Build the routine recommendation for a program-scheduled training day. */
function programTrainRecommendation(
  db: Database,
  ledger: MuscleFreshness[],
  program: ProgramContext,
  routineId: string,
  routineName: string
): Recommendation {
  const exercises = scoreRoutineExercises(db, ledger, routineId);
  const freshness = routineFreshness(exercises);
  const weekLine = `Week ${program.week} of ${program.weeks}`;
  const why =
    program.weekKind === 'deload'
      ? `${weekLine} · deload — cut sets ~50%, keep RPE ≤ 7 and the movements light.`
      : `${weekLine} · ${musclesLine(exercises, ledger)}`;
  return {
    kind: 'routine',
    routineId,
    routineName,
    freshness,
    // On a deload week the low-freshness caution would be noise — the plan IS to
    // go easy — so suppress it there.
    caution: program.weekKind !== 'deload' && freshness < ROUTINE_CAUTION,
    exercises,
    why,
    program,
  };
}

/**
 * The freshness ledger, weekly-volume ledger, and today's recommendation.
 * Priority: an active program's scheduled session wins; otherwise the
 * freshness-based routine pick (or freshest-muscle fallback). `now` injected
 * for deterministic tests.
 */
export function buildRecommendation(db: Database, now: Date = new Date()): TrainingRecommendation {
  const ledger = muscleFreshness(recentMuscleLoads(db, FRESHNESS_LOOKBACK_DAYS, now), now);
  const volume = volumeLedger(weeklyMuscleSets(db, now));
  const today = todayISODate(now);

  // 1) An active program's schedule takes precedence — it's the deliberate plan.
  const scheduled = scheduledToday(db, today);
  if (scheduled) {
    if (scheduled.kind === 'rest') {
      const lead = scheduled.program.weekKind === 'deload' ? 'Deload week — planned ' : 'Planned ';
      return {
        ledger,
        volume,
        recommendation: {
          kind: 'rest',
          why: `${lead}rest day. Recover, walk, mobilise — no lifting scheduled.`,
          program: scheduled.program,
        },
      };
    }
    return {
      ledger,
      volume,
      recommendation: programTrainRecommendation(
        db,
        ledger,
        scheduled.program,
        scheduled.routineId,
        scheduled.routineName
      ),
    };
  }

  // 2) No program running → freshness-based pick, with the no-routine fallback.
  const routines = listRoutines(db);
  const candidates: RoutineCandidate[] = routines.map((r) => ({
    routineId: r.id,
    routineName: r.name,
    lastStartedAt: r.lastStartedAt,
    exercises: scoreRoutineExercises(db, ledger, r.id),
  }));
  const fallbackExercises = routines.length === 0 ? freshestMuscleFallback(db, ledger) : [];
  const recommendation = recommendToday({ ledger, routines: candidates, fallbackExercises }, now);
  return { ledger, volume, recommendation };
}

// Re-export the muscle type users of this module commonly need.
export type { Muscle };
