/**
 * The geometry of a progress bar against a daily target — the whole of the
 * arithmetic behind C6's Today-grid bars (docs/spikes/nutrition-readability.md
 * §3.1), pure so it can be pinned headlessly.
 *
 * Two numbers come out and nothing else:
 *
 *   `fillPct`  how much of the rail is inked — `eaten / target`, capped at 100.
 *   `met`      whether the target has been reached, which is what turns the fill
 *              pine AND draws the terminator. Both cues, never one: `pine` and
 *              `ink-secondary` measure 1.01:1 against each other, so hue alone
 *              is a state change nobody can see (app/nutrition.tsx carries the
 *              measured table).
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
  /** True once `eaten` reaches `target`: pine fill AND the ink terminator. */
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
