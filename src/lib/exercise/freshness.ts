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
 * How far ahead of `now` a set may parse and still be treated as having just
 * happened, rather than as a future set to ignore.
 *
 * **One minute, and the reason is a real bug this hid.** `whenIso` comes from a
 * row stamped by SQLite's `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, which reads a
 * finer-grained clock than `Date.now()` exposes on Windows (and on any platform
 * whose timer granularity is coarser than a millisecond). So a set written
 * microseconds ago can parse a few MILLISECONDS ahead of the JS clock — and the
 * old guard, a bare `dh < 0`, then discarded every set of the workout just
 * logged and reported **"16 of 16 fresh" immediately after a session**. It was
 * found by a flaky render test on 2026-08-12, exactly as the identical hazard
 * in `daysUntilExpiry` (src/lib/media/meal-photo-store.ts) was.
 *
 * The guard itself is kept, because it is doing real work: a set genuinely
 * dated in the future is a plan, not a session, and must not deplete anything
 * today. A minute separates the two beyond argument — no clock skew produces
 * it, and no user logs a set sixty seconds before doing it.
 */
const SKEW_TOLERANCE_HOURS = 1 / 60;

/**
 * The freshness ledger: one entry per muscle in display order, every muscle
 * present (a never-trained muscle reads 100 / fresh / null). Warmup sets are
 * ignored; so is a set genuinely dated in the future, while one that merely
 * parses a few milliseconds ahead of the clock is treated as just-now (see
 * {@link SKEW_TOLERANCE_HOURS}).
 */
export function muscleFreshness(loads: MuscleLoad[], now: Date = new Date()): MuscleFreshness[] {
  const nowMs = now.getTime();
  const fatigue = new Map<Muscle, number>();
  const lastHours = new Map<Muscle, number>();

  for (const load of loads) {
    if (load.setType === 'warmup') continue;
    const raw = (nowMs - Date.parse(load.whenIso)) / HOUR_MS;
    if (!Number.isFinite(raw) || raw < -SKEW_TOLERANCE_HOURS) continue;
    // Clamped, not discarded — see SKEW_TOLERANCE_HOURS. A set logged this
    // instant is zero hours old, which is the most fatiguing it will ever be;
    // dropping it was the opposite answer.
    const dh = Math.max(0, raw);
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
