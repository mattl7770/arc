/**
 * Per-muscle "freshness" — the recovery model, pure and offline.
 *
 * Fatigue for a muscle is the sum over recent sets of
 *   roleWeight × effortWeight × e^(−Δhours / τ_muscle)
 * (fractional set counting: primary 1.0, secondary 0.5; effort from proximity
 * to failure; τ from the muscle's recovery window). Freshness is
 *   100 × (1 − min(1, fatigue / FRESH_FULL)).
 * This is FitBod's 0-100% recovery score restated as offline arithmetic
 * (docs/exercise-subapp.md §4.2). `now` is injected so the headless tests are
 * deterministic.
 */
import {
  FRESH_FULL,
  FRESH_THRESHOLDS,
  MUSCLE_ORDER,
  effortWeight,
  recoveryTauHours,
} from './constants';
import type { Muscle, MuscleFreshness, MuscleLoad } from './types';

const HOUR_MS = 3_600_000;

function bucket(freshness: number): MuscleFreshness['state'] {
  if (freshness >= FRESH_THRESHOLDS.fresh) return 'fresh';
  if (freshness >= FRESH_THRESHOLDS.recovering) return 'recovering';
  return 'fatigued';
}

/**
 * The freshness ledger: one entry per muscle in display order, every muscle
 * present (a never-trained muscle reads 100 / fresh / null). Warmup sets and
 * sets in the future relative to `now` are ignored.
 */
export function muscleFreshness(loads: MuscleLoad[], now: Date = new Date()): MuscleFreshness[] {
  const nowMs = now.getTime();
  const fatigue = new Map<Muscle, number>();
  const lastHours = new Map<Muscle, number>();

  for (const load of loads) {
    if (load.setType === 'warmup') continue;
    const dh = (nowMs - Date.parse(load.whenIso)) / HOUR_MS;
    if (!Number.isFinite(dh) || dh < 0) continue;
    const contrib =
      load.roleWeight *
      effortWeight(load.rpe, load.setType === 'failure') *
      Math.exp(-dh / recoveryTauHours(load.muscle));
    fatigue.set(load.muscle, (fatigue.get(load.muscle) ?? 0) + contrib);
    const prev = lastHours.get(load.muscle);
    if (prev == null || dh < prev) lastHours.set(load.muscle, dh);
  }

  return MUSCLE_ORDER.map((muscle) => {
    const f = fatigue.get(muscle) ?? 0;
    const freshness = Math.round(100 * (1 - Math.min(1, f / FRESH_FULL)));
    const lh = lastHours.get(muscle);
    return {
      muscle,
      freshness,
      state: bucket(freshness),
      hoursSinceLast: lh == null ? null : Math.floor(lh),
    };
  });
}

/** Freshness of a set of muscles, as their mean score (100 when the set is empty). */
export function meanFreshness(ledger: MuscleFreshness[], muscles: Muscle[]): number {
  if (muscles.length === 0) return 100;
  const byMuscle = new Map(ledger.map((e) => [e.muscle, e.freshness]));
  const sum = muscles.reduce((acc, m) => acc + (byMuscle.get(m) ?? 100), 0);
  return Math.round(sum / muscles.length);
}
