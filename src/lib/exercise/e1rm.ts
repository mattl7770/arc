/**
 * Estimated 1RM (e1RM) — pure, DB-free, offline.
 *
 * Epley over an effort-adjusted rep count: n = reps + RIR (RIR = 10 − RPE when
 * RPE is logged, else 0). The RTS RPE chart is a pure diagonal in reps + RIR, so
 * this one formula covers the RPE-aware case within ~1% (docs/exercise-subapp.md
 * §4.1). Only near-failure sets of a sane rep count carry a real max signal, so
 * everything else is filtered out rather than mis-estimated.
 */
import { E1RM_MAX_RIR, E1RM_REP_CAP } from './constants';
import type { SetType } from './types';

/** Reps in reserve implied by an RPE (RPE 10 = 0 RIR = failure). */
export const rirFromRpe = (rpe: number | null): number => (rpe == null ? 0 : 10 - rpe);

/** Effort-adjusted rep count n = reps + RIR (what the athlete could have done). */
export const effectiveReps = (reps: number, rpe: number | null): number =>
  reps + Math.max(0, rirFromRpe(rpe));

/** Epley 1RM from a load and effort-adjusted reps: w × (1 + n/30). */
export const epley = (weightKg: number, n: number): number => weightKg * (1 + n / 30);

/**
 * Whether a set carries a usable max signal: a real load and rep count, not a
 * warmup, within the rep cap, and near enough to failure (RIR ≤ 4).
 */
export function countsForE1rm(
  weightKg: number | null,
  reps: number | null,
  rpe: number | null,
  setType: SetType
): boolean {
  if (setType === 'warmup') return false;
  if (weightKg == null || weightKg <= 0) return false;
  if (reps == null || reps < 1 || reps > E1RM_REP_CAP) return false;
  if (rirFromRpe(rpe) > E1RM_MAX_RIR) return false;
  return true;
}

/** e1RM (kg) for one set, or null when the set carries no max signal. */
export function e1rmForSet(
  weightKg: number | null,
  reps: number | null,
  rpe: number | null,
  setType: SetType
): number | null {
  if (!countsForE1rm(weightKg, reps, rpe, setType)) return null;
  return epley(weightKg as number, effectiveReps(reps as number, rpe));
}

/**
 * Inverse: the working weight (kg) that should land `targetReps` at `targetRir`
 * given an e1RM. Used to translate a progression suggestion into a load.
 * `targetRir` defaults to 2 (a hard but not failure set).
 */
export function weightForReps(e1rmKg: number, targetReps: number, targetRir = 2): number {
  const n = targetReps + Math.max(0, targetRir);
  return e1rmKg / (1 + n / 30);
}
