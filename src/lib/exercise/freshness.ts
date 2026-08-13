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
  FRESHNESS_LOOKBACK_DAYS,
  FRESH_FULL,
  FRESH_THRESHOLDS,
  MUSCLE_ORDER,
  effortWeight,
  recoveryTauHours,
} from './constants';
import type { FreshnessAnchor, Muscle, MuscleFreshness, MuscleLoad } from './types';

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
 *
 * The same clamp applies to an anchor's own age ({@link anchorFatigue}), for the
 * same reason and from the same clock.
 */
const SKEW_TOLERANCE_HOURS = 1 / 60;

/**
 * The fatigue an ANCHOR contributes, decayed to now — the whole of migration
 * 0036's model in three lines.
 *
 * An anchor asserts a freshness AT AN INSTANT, so it converts straight back into
 * the fatigue units that would have produced it (`FRESH_FULL × (1 − f/100)`) and
 * then decays on the muscle's own τ, exactly as a set does. An assertion of
 * "spent" therefore recovers over the muscle's window instead of pinning the
 * figure at zero; an assertion of "fresh" contributes nothing at all and simply
 * clears the history before it.
 *
 * Returns null when the anchor is stale — older than the lookback window the
 * sets themselves use. By then three time constants have passed for every
 * muscle in the taxonomy and the contribution is under 5% of one set, so
 * dropping it changes no reading; what it does buy is that the LEDGER stops
 * calling the muscle hand-set, which would otherwise be a claim about the
 * reading's basis that is no longer true.
 */
function anchorFatigue(anchor: FreshnessAnchor, nowMs: number): number | null {
  const raw = (nowMs - Date.parse(anchor.anchoredAt)) / HOUR_MS;
  if (!Number.isFinite(raw) || raw < -SKEW_TOLERANCE_HOURS) return null;
  if (raw > FRESHNESS_LOOKBACK_DAYS * 24) return null;
  const dh = Math.max(0, raw);
  const f0 = FRESH_FULL * (1 - Math.max(0, Math.min(100, anchor.freshness)) / 100);
  return f0 * Math.exp(-dh / recoveryTauHours(anchor.muscle));
}

/**
 * The freshness ledger: one entry per muscle in display order, every muscle
 * present (a never-trained muscle reads 100 / fresh / null). Warmup sets are
 * ignored; so is a set genuinely dated in the future, while one that merely
 * parses a few milliseconds ahead of the clock is treated as just-now (see
 * {@link SKEW_TOLERANCE_HOURS}).
 *
 * `anchors` are the user's hand-set corrections (migration 0036). An anchor
 * SUPERSEDES every set older than itself — "the quads are at 40 right now" is a
 * complete statement about the quads right now, so replaying the sets that
 * produced the reading it corrects would double-count them — and later sets
 * deplete from it normally, which is how a real session takes the reading back
 * without anyone clearing anything.
 *
 * It is the THIRD parameter, after `now`, so that every existing call site and
 * every headless test that passes an injected clock positionally keeps working
 * unchanged. Ugly order, zero-risk change.
 */
export function muscleFreshness(
  loads: MuscleLoad[],
  now: Date = new Date(),
  anchors: FreshnessAnchor[] = []
): MuscleFreshness[] {
  const nowMs = now.getTime();
  const fatigue = new Map<Muscle, number>();
  const lastHours = new Map<Muscle, number>();
  const anchoredAt = new Map<Muscle, string>();

  for (const anchor of anchors) {
    const f = anchorFatigue(anchor, nowMs);
    if (f == null) continue;
    fatigue.set(anchor.muscle, (fatigue.get(anchor.muscle) ?? 0) + f);
    anchoredAt.set(anchor.muscle, anchor.anchoredAt);
  }

  for (const load of loads) {
    if (load.setType === 'warmup') continue;
    const raw = (nowMs - Date.parse(load.whenIso)) / HOUR_MS;
    if (!Number.isFinite(raw) || raw < -SKEW_TOLERANCE_HOURS) continue;
    // Superseded: an anchor is a statement about the muscle at its own instant,
    // so everything before it is already in that number.
    const anchor = anchoredAt.get(load.muscle);
    if (anchor != null && Date.parse(load.whenIso) < Date.parse(anchor)) continue;
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
      anchoredAt: anchoredAt.get(muscle) ?? null,
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
