import type { MealRow } from './types';

/**
 * What the Eat tab is allowed to say about the day.
 *
 * The tab leads with what is LEFT rather than what has been eaten (owner call,
 * 2026-08-10: *"it leads with a retrospective total… 'what am I short' exists
 * only as a `/ 140g` denominator on a 3px progress rule"*). That flip is only
 * honest if the subtraction is sound, and by default it is not:
 *
 * **A day's totals skip NULL by design.** `sumRounded` adds a meal's value or
 * nothing at all — a meal logged by name with no kcal contributes 0, and the
 * ledger row honestly renders an em-dash for it. Eaten-so-far survives that (it
 * is "what has been recorded", and the rows visibly add to it). *What's left*
 * does not: `target − incomplete sum` is too large by exactly the meals nobody
 * measured, and it would print as a confident figure on the very day the screen
 * below it admits it has no number. That is the one thing 00-design-spec.md §5
 * rules out — "no data, no number… never a plausible-looking estimate".
 *
 * So a remainder is computed **per metric**, and only when
 *
 *   1. a target governs that metric (else there is nothing to subtract from), and
 *   2. every meal logged today carries a value for it.
 *
 * Otherwise the metric falls back to the reading that shipped before this
 * redesign — eaten, with its denominator and its progress rule — and the screen
 * states the reason in words. An empty day passes the test vacuously, which is
 * right: with nothing logged, the whole target is what's left.
 *
 * Fiber deliberately has no place in this model. It is summed from `meal_items`
 * (`dayFiberTotal`), so a manually-entered meal contributes none by
 * construction — its total is known-partial on every day that mixes entry
 * methods, and there is no per-meal column to test completeness against. It
 * stays on the micronutrients screen, where it is read against a reference
 * rather than counted down.
 */

/** The per-meal macro columns a remainder can be computed from. */
export type DayMetric = 'kcal' | 'protein_g' | 'carbs_g' | 'fat_g';

export const DAY_METRIC_LABELS: Record<DayMetric, string> = {
  kcal: 'energy',
  protein_g: 'protein',
  carbs_g: 'carbs',
  fat_g: 'fat',
};

export type DayFigure =
  /** Guarded: every meal reported this metric and a target governs it. */
  | { mode: 'remaining'; eaten: number; target: number; remaining: number }
  /** The shipped reading: what has been recorded, against its target if any. */
  | { mode: 'eaten'; eaten: number; target: number | null };

/**
 * The day's displayed total for one metric: the sum of the values the rows
 * actually show. Rounded per row and then added, never rounded again from a raw
 * sum — the ledger has to add up to its own header (00-design-spec.md §5).
 * NULL is skipped, not zeroed: a meal with no recorded protein must not drag the
 * day's protein down, and its row shows nothing for it either.
 */
export function sumRounded(values: (number | null | undefined)[]): number {
  return values.reduce<number>(
    (total, value) => total + (value == null ? 0 : Math.round(value)),
    0
  );
}

/** True when every meal on the day carries a value for this metric. */
export function metricIsComplete(meals: MealRow[], metric: DayMetric): boolean {
  return meals.every((meal) => meal[metric] != null);
}

/**
 * What to draw for one metric. `target` is the governing target or null; a
 * non-positive target is treated as no target (a "0 kcal" goal is not a frame of
 * reference, and dividing by it is how a progress rule reaches infinity).
 */
export function dayFigure(meals: MealRow[], metric: DayMetric, target: number | null): DayFigure {
  const eaten = sumRounded(meals.map((meal) => meal[metric]));
  if (target == null || target <= 0) return { mode: 'eaten', eaten, target: null };
  if (!metricIsComplete(meals, metric)) return { mode: 'eaten', eaten, target };
  return { mode: 'remaining', eaten, target, remaining: Math.round(target - eaten) };
}

/**
 * The metrics that HAVE a target but could not be counted down, in display
 * order — what the authored line under the grid names. Empty when the grid is
 * fully guarded, which is the ordinary case.
 */
export function unguardedMetrics(
  meals: MealRow[],
  targets: Partial<Record<DayMetric, number | null>>
): DayMetric[] {
  const order: DayMetric[] = ['kcal', 'protein_g', 'carbs_g', 'fat_g'];
  return order.filter((metric) => {
    const target = targets[metric];
    if (target == null || target <= 0) return false;
    return !metricIsComplete(meals, metric);
  });
}

/** How many of today's meals are missing at least one targeted metric. */
export function mealsMissingValues(
  meals: MealRow[],
  targets: Partial<Record<DayMetric, number | null>>
): number {
  const tracked: DayMetric[] = (['kcal', 'protein_g', 'carbs_g', 'fat_g'] as DayMetric[]).filter(
    (metric) => {
      const target = targets[metric];
      return target != null && target > 0;
    }
  );
  if (tracked.length === 0) return 0;
  return meals.filter((meal) => tracked.some((metric) => meal[metric] == null)).length;
}

/**
 * The sentence that replaces a remainder when the day cannot support one.
 * Written as a fact plus its consequence, never an apology — and it names the
 * count, so it reconciles with the em-dashes visible in the ledger below.
 * Returns null when nothing is missing (the grid says it all).
 */
export function unguardedNote(
  meals: MealRow[],
  targets: Partial<Record<DayMetric, number | null>>
): string | null {
  const missing = unguardedMetrics(meals, targets);
  if (missing.length === 0) return null;
  const mealCount = mealsMissingValues(meals, targets);
  const names = missing.map((metric) => DAY_METRIC_LABELS[metric]);
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const subject = mealCount === 1 ? 'One meal has' : `${mealCount} meals have`;
  return `${subject} no ${list} recorded, so what is left of today is not known. This is what has been logged.`;
}
