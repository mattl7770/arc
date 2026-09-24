import { kcalLevel, paceRatio, proteinLevel } from '@/lib/home/readiness';
import type { GoalDirection } from '@/lib/user/types';
import type { SignalLevel } from '@/types/home';

import type { DayMetric } from './remaining';

/**
 * The geometry of a progress bar against a daily target — the whole of the
 * arithmetic behind C6's Today-grid bars (docs/spikes/nutrition-readability.md
 * §3.1), pure so it can be pinned headlessly.
 *
 * Four numbers come out and nothing else:
 *
 *   `fillPct`  how much of the RAIL is inked — `eaten / target`, capped at 100.
 *   `met`      whether the target has been reached, which is what draws the
 *              terminator at the rail's end.
 *   `overPct`  how far PAST the rail's end the excess runs, as a percentage of
 *              the rail's own length — 0 until the target is passed, at most
 *              {@link OVERFLOW_CAP} × 100.
 *   `capped`   whether the excess is longer than the cap can draw, which is
 *              what stamps the `+` on the run.
 *
 * **`met` no longer decides the fill's COLOUR** (FB2, 2026-09-21). It used to
 * turn the fill from `ink-secondary` to `pine`, a change measuring 1.01:1 — the
 * same luminance, so invisible to anyone not perceiving hue, which is why the
 * terminator was introduced to carry the state geometrically. The fill is now
 * coloured by {@link macroGrade} instead, and the terminator keeps its job: a
 * met bar reaches the mark, an unmet one does not.
 *
 * ## Over target: the run past the mark (FB3, 2026-09-21)
 *
 * The owner, from the device: *"the blue could also go over the bar again for
 * overflow."* Until FB3 the bar STOPPED at the mark and only the number kept
 * counting, so a 2,900 on 2,400 day drew exactly what a 2,400 day drew — full.
 *
 * **The rail still means the target, and the fill still caps at it.** C6's
 * objection to running the fill past the mark was that it rescales the rail —
 * make the rail mean 125% and a bar AT target reads four-fifths full on the day
 * it is exactly right. That objection stands, so the rail is not rescaled.
 * Instead the bar keeps room BESIDE the rail — bare sheet, half the rail's
 * length — and the excess is a second, separate run drawn there, past the
 * rail's end. A day at target is a full rail and nothing beyond it; a day over
 * target is a full rail and ink past its end.
 *
 * **The cap is 150% of the rail's length** ({@link OVERFLOW_CAP} = 0.5 of it
 * past the mark). Beyond that the run stops and `capped` stamps a `+` — the
 * figure above the bar already states the exact amount, so the bar only has to
 * say *over, by this much, or by more than this*.
 *
 * Adherence-neutral still: the run says HOW FAR past the plan the day went, not
 * whether that is a fault. Whether it is lives in the fill's grade, by goal
 * direction — protein over target is `optimal`, a gaining day's calories over
 * target can be too — so the run is never a warning colour on its own.
 *
 * A non-positive target never reaches here — `dayFigure` already refuses one
 * (remaining.ts), because a "0 kcal" goal is not a frame of reference and
 * dividing by it is how a progress rule reaches infinity. The guard below is the
 * backstop for any future caller, and it returns an EMPTY bar rather than a full
 * one: with no frame of reference there is no progress to claim.
 */

/** How far past the mark the run may reach, as a fraction of the rail's own
 *  length: 0.5 draws at most 150% of the rail in all. `MacroBar` lays the room
 *  past the mark out from this same constant (flex 1 : OVERFLOW_CAP), so a run
 *  at the cap fills the room exactly and never paints outside the bar. */
export const OVERFLOW_CAP = 0.5;

export type BarFigure = {
  /** 0–100 — the rail's inked fraction, as a percentage for a `style` width. */
  fillPct: number;
  /** True once `eaten` reaches `target` — the ink terminator at the rail's end. */
  met: boolean;
  /** 0–50 — the run past the mark, as a percentage of the RAIL's length. */
  overPct: number;
  /** True when the excess is longer than {@link OVERFLOW_CAP} can draw. */
  capped: boolean;
};

export function barFigure(eaten: number, target: number): BarFigure {
  if (!Number.isFinite(target) || target <= 0) {
    return { fillPct: 0, met: false, overPct: 0, capped: false };
  }
  // A negative or non-finite eaten figure draws nothing rather than reversing
  // the fill. Nothing upstream produces one (`sumRounded` skips NULL and adds
  // recorded values), so this is a floor, not a case.
  const value = Number.isFinite(eaten) && eaten > 0 ? eaten : 0;
  const excess = value / target - 1;
  return {
    fillPct: Math.min(100, (value / target) * 100),
    met: value >= target,
    overPct: excess > 0 ? Math.min(OVERFLOW_CAP, excess) * 100 : 0,
    // Strictly past the cap: a day at exactly 150% is drawable in full, and the
    // `+` means "more than is drawn", not "at the edge".
    capped: excess > OVERFLOW_CAP,
  };
}

// --- The grade a bar is coloured by (FB2, 2026-09-21) ------------------------

/**
 * **The level a macro bar is coloured with — the day's own verdict, per metric.**
 *
 * The owner, from the device on 2026-09-21: *"colors for nutrition bars are hard
 * to see, should be more colourful."* C6 drew every bar in the accent on purpose
 * (the firewall: signal marks biology, the accent marks behaviour) and that
 * restraint is overruled here. The override and its reasoning are recorded with
 * the firewall rule itself, in docs/project-status.md §3.
 *
 * **It computes no band of its own.** Every grade below comes out of the three
 * functions the Home pillar is built from — {@link paceRatio}, {@link kcalLevel}
 * and {@link proteinLevel} — so a bar's colour is a COMPONENT of the pillar
 * rather than a second opinion about it:
 *
 *   - **kcal** → `kcalLevel(ratio, direction)`. The pillar's calorie half,
 *     argument for argument.
 *   - **protein** → `proteinLevel(ratio)`, which is ONE-SIDED. Overshooting a
 *     protein target is not a failure in any of the three goal directions, so
 *     grading protein with the calorie bands would paint a 200 g day on a 180 g
 *     target amber — the exact opposite of what the pillar says about that same
 *     number. This is the one place a shared band table would have lied.
 *   - **carbs / fat** → `kcalLevel(ratio, direction)`. They are budget
 *     components, two-sided like the budget, and the direction applies to them
 *     as it applies to calories: while cutting, under target is the point and
 *     over target is the fault. Reusing the table is the whole reason there is
 *     no third band list to keep in sync with the pillar's.
 *
 * ## The ratio is PROJECTED, the fill is LITERAL
 *
 * The colour is graded on {@link paceRatio} — eaten plus the share of the target
 * still expected today — while {@link barFigure} inks `eaten ÷ target` flat.
 * That reads like a mismatch and is the only pairing that works: at 10:00 a
 * perfectly-paced day has eaten 15% of its calories, so a colour graded on the
 * raw fraction would read `poor` every morning of every good day. Length answers
 * *how much have I eaten*, colour answers *where is this day going to land* —
 * the question the pillar answers, in the pillar's own arithmetic. At the day's
 * close `expected` is 1 and the two collapse onto the same number.
 *
 * ## The four refusals, in the pillar's own order
 *
 * `unknown` is not a grade, it is the withholding of one, and it comes back in
 * exactly the cases `nutritionVerdict` withholds. Otherwise the Eat tab would
 * paint a verdict onto a day Home is refusing to judge, which is the one way
 * these colours could contradict the pillar they are drawn from:
 *
 *   1. **the day changed timezone** — a 24-hour target cannot judge a 31-hour
 *      day, so the numbers are shown and the verdict withheld (D4);
 *   2. **no target governs this metric** — nothing to grade against, and a rail
 *      with no denominator behind it may not claim one;
 *   3. **nothing logged** — an empty day is not a bad day;
 *   4. **before the pace clock starts** (10:00, `PACE_ANCHORS`) — with
 *      `expected` at 0 the projection is the whole target, so every bar would
 *      open the morning green.
 *
 * Cases 3 and 4 still draw a bar at its real length: showing the quantity and
 * withholding the judgment is the same move the timezone ADR made.
 */
export type MacroGradeInputs = {
  metric: DayMetric;
  /** What has been recorded today for this metric. */
  eaten: number;
  /** The governing target, or null when none does. */
  target: number | null;
  /** `users.preferences.goals.direction` — `maintain` when unset. */
  direction: GoalDirection;
  /** `expectedDayFraction` — 0 before the first anchor, 1 once the day closes. */
  expected: number;
  /** Meals logged today. Zero is not a grade. */
  mealCount: number;
  /** D4 — the day was not 24 hours long, so it is not graded at all. */
  timezoneChanged?: boolean;
};

export function macroGrade(inputs: MacroGradeInputs): SignalLevel {
  const { metric, eaten, target, direction, expected, mealCount } = inputs;
  if (inputs.timezoneChanged) return 'unknown';
  if (typeof target !== 'number' || !Number.isFinite(target) || target <= 0) return 'unknown';
  if (mealCount <= 0) return 'unknown';
  if (expected <= 0) return 'unknown';
  const ratio = paceRatio(Number.isFinite(eaten) && eaten > 0 ? eaten : 0, target, expected);
  return metric === 'protein_g' ? proteinLevel(ratio) : kcalLevel(ratio, direction);
}
