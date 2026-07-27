/**
 * Progressive overload — pure, DB-free, offline.
 *
 * Dynamic double progression (docs/exercise-subapp.md §4.3): hold the load until
 * the top of the rep range is reached, then add the smallest sensible jump and
 * reset to the bottom. A run of sessions with no strength gain and reps stuck
 * below the top triggers a deload suggestion (StrongLifts' 3-stall rule). The
 * engine returns a raw kg target + an action; the screen renders the number in
 * the user's unit and snaps it to real plates.
 */
import { DELOAD_FRACTION, STALL_SESSIONS } from './constants';
import { epley, effectiveReps } from './e1rm';
import type { ProgressionSuggestion } from './types';

/** One prior session's best working set for an exercise (oldest → newest). */
export type SessionTopSet = {
  date: string;
  weightKg: number | null;
  reps: number | null;
  rpe: number | null;
};

export type ProgressionInput = {
  /** Best working set per past session, oldest → newest. */
  sessions: SessionTopSet[];
  repRange: { low: number; high: number };
  /** The smallest load bump to suggest, kg (from progressionIncrementKg). */
  incrementKg: number;
};

/** A comparable "strength" for a set: e1RM when loaded, else the raw load. */
function setStrength(s: SessionTopSet): number {
  if (s.weightKg == null || s.reps == null) return 0;
  return epley(s.weightKg, effectiveReps(s.reps, s.rpe));
}

/**
 * Suggest the next session's load + reps for one exercise from its history.
 * No loaded history → 'find_weight' (honest: converges in ~2 sessions anyway).
 */
export function suggestProgression(input: ProgressionInput): ProgressionSuggestion {
  const { repRange, incrementKg } = input;
  const loaded = input.sessions.filter((s) => s.weightKg != null && s.reps != null);

  if (loaded.length === 0) {
    return {
      kind: 'find_weight',
      targetWeightKg: null,
      targetReps: repRange.low,
      note: 'Find a working weight — aim for the bottom of the range.',
    };
  }

  const last = loaded[loaded.length - 1]!;
  const lastWeight = last.weightKg as number;
  const lastReps = last.reps as number;
  const rir = last.rpe == null ? null : 10 - last.rpe;

  // Top of range reached with a rep in reserve → add load, reset reps.
  if (lastReps >= repRange.high && (rir == null || rir >= 1)) {
    return {
      kind: 'progress',
      targetWeightKg: lastWeight + incrementKg,
      targetReps: repRange.low,
      note: 'Top of range hit — add a small jump, reset to the bottom.',
    };
  }

  // Stall: no strength gain across the last few sessions and still short of the
  // top of the range → back off and rebuild.
  if (loaded.length >= STALL_SESSIONS) {
    const recent = loaded.slice(-STALL_SESSIONS);
    const strengths = recent.map(setStrength);
    const improved = strengths.some((v, i) => i > 0 && v > strengths[i - 1]! + 1e-6);
    const belowTop = recent.every((s) => (s.reps as number) < repRange.high);
    if (!improved && belowTop) {
      return {
        kind: 'deload',
        targetWeightKg: lastWeight * (1 - DELOAD_FRACTION),
        targetReps: repRange.low,
        note: `Stalled ${STALL_SESSIONS} sessions — drop ~${Math.round(DELOAD_FRACTION * 100)}% and rebuild.`,
      };
    }
  }

  // Otherwise hold the load and chase one more rep toward the top.
  return {
    kind: 'hold',
    targetWeightKg: lastWeight,
    targetReps: Math.min(lastReps + 1, repRange.high),
    note: 'Hold the load — add a rep toward the top of the range.',
  };
}
