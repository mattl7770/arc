/**
 * Per-muscle "freshness" — the recovery model, pure and offline.
 *
 * Fatigue for a muscle is the sum over recent sets of
 *   roleWeight × effortWeight × e^(−Δhours / τ_muscle)
 * (fractional set counting: primary 1.0, secondary 0.5; effort from proximity
 * to failure; τ from the muscle's recovery window). Freshness is
 *   100 × e^(−fatigue / FRESH_SCALE)   — see {@link freshnessFromFatigue}.
 * This is FitBod's 0-100% recovery score restated as offline arithmetic
 * (docs/exercise-subapp.md §4.2). `now` is injected so the headless tests are
 * deterministic.
 */
import {
  FRESHNESS_LOOKBACK_DAYS,
  FRESH_SCALE,
  FRESH_THRESHOLDS,
  MUSCLE_ORDER,
  effortWeight,
  recoveryTauHours,
} from './constants';
import type { FreshnessAnchor, Muscle, MuscleFreshness, MuscleLoad } from './types';

const HOUR_MS = 3_600_000;

/**
 * Fatigue (in fractional working sets) → freshness percent, and the whole shape
 * of the model in one line: **100 × e^(−F / FRESH_SCALE)**.
 *
 * ## Calibration — what a session of N sets actually reads
 *
 * `N` is FRACTIONAL sets on one muscle, counted the way the ledger counts them:
 * a set of an exercise that lists the muscle *primary* is 1.0, *secondary* is
 * 0.5, and effort scales it (0.5 submaximal · 1.0 hard · 1.25 to failure). Read
 * immediately after the session, before any decay:
 *
 * | N sets | 1 | 2 | 3 | 4 | 6 | 8 | 10 | 12 | 16 | 20 | 24 |
 * |--------|---|---|---|---|---|---|----|----|----|----|----|
 * | fresh% |88 |78 |69 |61 |47 |37 | 29 | 22 | 14 |  8 |  5 |
 *
 * So a **hard back day** — say 4×lat pulldown, 3×pull-up, 4×barbell row,
 * 3×cable row, 3×face pull, 17 working sets — lands lats at **27**, upper back
 * at **22**, biceps at **42**, rear delts at **44**. A **light accessory day**
 * (3 sets of lateral raises) leaves side delts at **69**. A **single set**
 * leaves its muscle at **88** — a dent, not an annihilation. Those four are
 * pinned as tests in db/training-engine.test.mjs §5b, which is the real
 * specification: if you retune FRESH_SCALE, that table is what you are moving.
 *
 * ## Why exponential and not the old linear ramp
 *
 * It used to be `100 × (1 − min(1, F/8))` and the owner's complaint on
 * 2026-08-14 — *"I just did a whole back day and it only hit related muscles
 * down to 80%"* — turned out to be two faults, only one of them here. The
 * loads mostly never arrived (see {@link recentMuscleLoads}); but when they DO
 * arrive, that `min` clipped, so eight fractional sets and twenty-four both
 * printed **0**, and a muscle sitting at clipped-zero then stayed frozen at
 * zero for hours — F had to decay all the way back under 8 before the number
 * could move at all. A model whose most-fatigued reading is also its least
 * informative one is the wrong shape, not the wrong constant.
 *
 * The exponential fixes all of it with one operator: it is monotone over the
 * whole range so more work always reads as more spent, it never reaches 0 (a
 * real muscle never is), it starts moving the instant recovery starts, and it
 * is the natural conjugate of the exponential decay already applied to fatigue
 * — freshness(t) = e^(−F₀e^(−t/τ)/C) — so recovery is a smooth S rather than a
 * plateau and a cliff. Lats at 27% recover to 45 by +12 h, 61 by +24 h, 84 by
 * +48 h and 94 by +72 h, which is the muscle's published 72 h window.
 */
export function freshnessFromFatigue(fatigue: number): number {
  return Math.round(100 * Math.exp(-Math.max(0, fatigue) / FRESH_SCALE));
}

/**
 * The inverse of {@link freshnessFromFatigue} — a freshness percent back into
 * the fatigue that would have produced it. Only anchors need this (see
 * {@link anchorFatigue}); it round-trips exactly for every value the adjuster
 * can write.
 *
 * Zero has no exact preimage under an exponential, so it is floored at
 * {@link ANCHOR_FLOOR_PERCENT}: "spent" means *as spent as the model can
 * represent*, not infinitely spent.
 */
function fatigueForFreshness(percent: number): number {
  const clamped = Math.max(ANCHOR_FLOOR_PERCENT, Math.min(100, percent));
  return -FRESH_SCALE * Math.log(clamped / 100);
}

/**
 * What a hand-asserted "Spent" (0) actually means to the model, as a percent.
 *
 * The floor is set by the DISPLAY, not by taste: the adjuster's Spent button
 * has to make the row it is attached to read `0%`, and 0.4 is the largest value
 * that still rounds there. It implies F₀ = −8·ln(0.004) ≈ 44 fatigue units.
 *
 * That is deliberately worse than any session can produce (24 fractional sets
 * is ≈ 24 units), and it makes a hand-asserted wipe recover over about five
 * days rather than three: for a 72 h muscle (τ = 24 h) it reads 13% at +24 h,
 * 47% at +48 h, 76% at +72 h, 90% at +96 h. The old linear model let "totally
 * destroyed" reach 95% in three days — exactly as fast as one ordinary hard
 * session — which made the assertion meaningless. If the user says a muscle is
 * at literal zero, he is saying something stronger than "I trained it".
 */
const ANCHOR_FLOOR_PERCENT = 0.4;

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
 * 0037's model in three lines.
 *
 * An anchor asserts a freshness AT AN INSTANT, so it converts straight back into
 * the fatigue units that would have produced it ({@link fatigueForFreshness})
 * and then decays on the muscle's own τ, exactly as a set does. An assertion of
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
  const f0 = fatigueForFreshness(anchor.freshness);
  return f0 * Math.exp(-dh / recoveryTauHours(anchor.muscle));
}

/**
 * The freshness ledger: one entry per muscle in display order, every muscle
 * present (a never-trained muscle reads 100 / fresh / null). Warmup sets are
 * ignored; so is a set genuinely dated in the future, while one that merely
 * parses a few milliseconds ahead of the clock is treated as just-now (see
 * {@link SKEW_TOLERANCE_HOURS}).
 *
 * `anchors` are the user's hand-set corrections (migration 0037). An anchor
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
    const freshness = freshnessFromFatigue(f);
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
