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
  /**
   * A CALLER-SUPPLIED working-volume multiplier (0.1–1.5), applied to every
   * exercise's target sets. Deliberately not derived from anything: this
   * engine never decides that a day should be lighter or harder. It exists so
   * that when the Coach (with the user) decides "today should be ~60%", that
   * decision compiles into real per-exercise numbers instead of a sticky note
   * saying "go easier". Absent = the plan as written.
   *
   * See docs/coach-intelligence-review.md §4 — deterministic code perceives
   * and compiles; judgment is the model's.
   */
  volumeScale?: number;
};

/** Clamp a caller's dial to a sane band; undefined/NaN means "no adjustment". */
export function normalizeVolumeScale(scale: number | undefined): number | undefined {
  if (scale === undefined || !Number.isFinite(scale)) return undefined;
  const clamped = Math.min(1.5, Math.max(0.1, scale));
  // A 1.0 dial is a no-op; treat it as absent so nothing renders "adjusted".
  return Math.abs(clamped - 1) < 0.001 ? undefined : clamped;
}

/**
 * Apply the dial to one exercise's planned sets. Always leaves at least one
 * working set — "lighter" never silently means "nothing".
 */
export function scaleExerciseVolume(
  exercise: RecommendedExercise,
  scale: number
): RecommendedExercise {
  if (exercise.targetSets == null) return exercise;
  return { ...exercise, targetSets: Math.max(1, Math.ceil(exercise.targetSets * scale)) };
}

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

/** " · volume cut to 60% (your call)" — names the dial on the session's why. */
function volumeNote(scale: number): string {
  return ` · volume ${scale < 1 ? 'cut' : 'raised'} to ${Math.round(scale * 100)}% of the plan`;
}

export function recommendToday(input: RecommendInput, now: Date = new Date()): Recommendation {
  const { ledger, routines } = input;
  const scale = normalizeVolumeScale(input.volumeScale);
  const apply = (list: RecommendedExercise[]) =>
    scale === undefined ? list : list.map((e) => scaleExerciseVolume(e, scale));
  const fallbackExercises = apply(input.fallbackExercises);

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
    const base = caution
      ? `${muscles || 'These muscles'} — still recovering; go lighter or swap if it's flat.`
      : `${muscles}${last ? ` · last done ${last}` : ''}`;
    return {
      kind: 'routine',
      routineId: best.r.routineId,
      routineName: best.r.routineName,
      freshness: best.freshness,
      caution,
      exercises: apply(best.r.exercises),
      why: scale === undefined ? base : `${base}${volumeNote(scale)}`,
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
