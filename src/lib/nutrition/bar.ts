import { kcalLevel, paceRatio, proteinLevel } from '@/lib/home/readiness';
import type { GoalDirection } from '@/lib/user/types';
import type { SignalLevel } from '@/types/home';

import type { DayMetric } from './remaining';

/**
 * The geometry of a progress bar against a daily target — the whole of the
 * arithmetic behind C6's Today-grid bars (docs/spikes/nutrition-readability.md
 * §3.1), pure so it can be pinned headlessly.
 *
 * Two numbers come out and nothing else:
 *
 *   `fillPct`  how much of the rail is inked — `eaten / target`, capped at 100.
 *   `met`      whether the target has been reached, which is what draws the
 *              terminator at the rail's end.
 *
 * **`met` no longer decides the fill's COLOUR** (FB2, 2026-09-21). It used to
 * turn the fill from `ink-secondary` to `pine`, a change measuring 1.01:1 — the
 * same luminance, so invisible to anyone not perceiving hue, which is why the
 * terminator was introduced to carry the state geometrically. The fill is now
 * coloured by {@link macroGrade} instead, and the terminator keeps its job: a
 * met bar reaches the mark, an unmet one does not.
 *
 * **The cap is the design, not a clamp for safety.** Over target the bar STOPS
 * at the mark and the number above it keeps counting — the cell's label already
 * flips to "PROTEIN OVER". Running the fill past the mark would make the rail
 * mean 125% of the target, so a bar AT target would read four-fifths full on the
 * day it is exactly right; and how far past is "too far" depends on goal
 * direction, which is C7's question rather than this one's. Adherence-neutral
 * either way: no warning colour, no shame state (docs/nutrition-subapp.md §8).
 *
 * A non-positive target never reaches here — `dayFigure` already refuses one
 * (remaining.ts), because a "0 kcal" goal is not a frame of reference and
 * dividing by it is how a progress rule reaches infinity. The guard below is the
 * backstop for any future caller, and it returns an EMPTY bar rather than a full
 * one: with no frame of reference there is no progress to claim.
 */

export type BarFigure = {
  /** 0–100 — the rail's inked fraction, as a percentage for a `style` width. */
  fillPct: number;
  /** True once `eaten` reaches `target` — the ink terminator at the rail's end. */
  met: boolean;
};

export function barFigure(eaten: number, target: number): BarFigure {
  if (!Number.isFinite(target) || target <= 0) return { fillPct: 0, met: false };
  // A negative or non-finite eaten figure draws nothing rather than reversing
  // the fill. Nothing upstream produces one (`sumRounded` skips NULL and adds
  // recorded values), so this is a floor, not a case.
  const value = Number.isFinite(eaten) && eaten > 0 ? eaten : 0;
  return { fillPct: Math.min(100, (value / target) * 100), met: value >= target };
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
