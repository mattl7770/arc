/**
 * "Train today" — the rule-based recommendation, pure and offline.
 *
 * Given the freshness ledger and the user's routines (each exercise already
 * carrying the mean freshness of its primary muscles and a progression
 * suggestion), pick the routine whose muscles are freshest, or — with no
 * routines — surface the freshest muscle groups and a suggested movement each.
 * Recovery prioritizes, never gates: a low-freshness routine is still
 * recommended, just flagged with a caution (docs/exercise-subapp.md §4.4).
 *
 * The DB work (assembling per-exercise freshness + progression) is the repo's
 * job; this module only scores, selects, and writes the human "why".
 */
import { MUSCLE_LABEL, ROUTINE_CAUTION } from './constants';
import type { MuscleFreshness, Recommendation, RecommendedExercise } from './types';

/** A routine offered to the recommender, exercises pre-scored for freshness. */
export type RoutineCandidate = {
  routineId: string;
  routineName: string;
  lastStartedAt: string | null;
  exercises: RecommendedExercise[];
};

export type RecommendInput = {
  ledger: MuscleFreshness[];
  routines: RoutineCandidate[];
  /** Freshest-muscle movements to offer when there are no routines. */
  fallbackExercises: RecommendedExercise[];
};

/** Mean freshness across a routine's exercises (100 when it has none). */
export function routineFreshness(exercises: RecommendedExercise[]): number {
  if (exercises.length === 0) return 100;
  const sum = exercises.reduce((acc, e) => acc + e.freshness, 0);
  return Math.round(sum / exercises.length);
}

/** "N days ago" / "today" / "yesterday" from an ISO instant, else null. */
function daysAgoLabel(iso: string | null, now: Date): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const days = Math.floor((now.getTime() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/** The two or three freshest primary muscles across a set of exercises. */
function topMuscles(exercises: RecommendedExercise[], ledger: MuscleFreshness[]): string {
  const fresh = new Map(ledger.map((e) => [e.muscle, e.freshness]));
  const muscles = [...new Set(exercises.flatMap((e) => e.primaryMuscles))];
  return muscles
    .sort((a, b) => (fresh.get(b) ?? 0) - (fresh.get(a) ?? 0))
    .slice(0, 3)
    .map((m) => `${MUSCLE_LABEL[m]} ${fresh.get(m) ?? 100}%`)
    .join(' · ');
}

export function recommendToday(input: RecommendInput, now: Date = new Date()): Recommendation {
  const { ledger, routines, fallbackExercises } = input;

  if (routines.length > 0) {
    // Pick the freshest routine; ties break toward the one done longest ago.
    const scored = routines
      .map((r) => ({ r, freshness: routineFreshness(r.exercises) }))
      .sort((a, b) => {
        if (b.freshness !== a.freshness) return b.freshness - a.freshness;
        return (
          (Date.parse(a.r.lastStartedAt ?? '0') || 0) - (Date.parse(b.r.lastStartedAt ?? '0') || 0)
        );
      });
    const best = scored[0]!;
    const caution = best.freshness < ROUTINE_CAUTION;
    const last = daysAgoLabel(best.r.lastStartedAt, now);
    const muscles = topMuscles(best.r.exercises, ledger);
    const why = caution
      ? `${muscles || 'These muscles'} — still recovering; go lighter or swap if it's flat.`
      : `${muscles}${last ? ` · last done ${last}` : ''}`;
    return {
      kind: 'routine',
      routineId: best.r.routineId,
      routineName: best.r.routineName,
      freshness: best.freshness,
      caution,
      exercises: best.r.exercises,
      why,
    };
  }

  if (fallbackExercises.length > 0) {
    const muscles = [...new Set(fallbackExercises.flatMap((e) => e.primaryMuscles))];
    return {
      kind: 'muscles',
      muscles,
      exercises: fallbackExercises,
      why: `Freshest right now: ${topMuscles(fallbackExercises, ledger)}`,
    };
  }

  return {
    kind: 'empty',
    why: 'Build a routine or log a few sessions and ARC will start recommending your next workout.',
  };
}
