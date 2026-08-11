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
 *   2. every meal logged today carries a TRUSTWORTHY value for it — not NULL,
 *      and not a sum over items one of which was never priced (see
 *      metricIsComplete).
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

/**
 * meal_id → the metrics whose total that meal is knowingly SHORT on, because an
 * item inside it was never priced. Produced by `partialMealMetrics`
 * (repositories/nutrition.ts). An empty map is the honest default for a caller
 * with no itemized meals in play.
 */
export type PartialMealMetrics = Record<string, Partial<Record<DayMetric, boolean>>>;

/**
 * True when every meal on the day carries a TRUSTWORTHY value for this metric.
 *
 * Two different ways a meal fails, and the second is the subtle one:
 *
 *   1. The column is NULL — nothing was recorded. The row shows an em-dash.
 *   2. The column is a SUM OVER ITEMS, one of which had no number. This is what
 *      `logRecipe` writes for a partially resolved recipe: the priced lines land
 *      with snapshots, the rest land as name-only items with NULL macros, and
 *      the meal's own kcal is the sum of the priced half. The meal *looks*
 *      complete — it shows 620 kcal — but it means "at least 620".
 *
 * Case 2 is honest as a ledger row and dishonest as a minuend, which is the
 * whole reason this parameter exists.
 */
export function metricIsComplete(
  meals: MealRow[],
  metric: DayMetric,
  partial: PartialMealMetrics = {}
): boolean {
  return meals.every((meal) => meal[metric] != null && partial[meal.id]?.[metric] !== true);
}

/**
 * What to draw for one metric. `target` is the governing target or null; a
 * non-positive target is treated as no target (a "0 kcal" goal is not a frame of
 * reference, and dividing by it is how a progress rule reaches infinity).
 */
export function dayFigure(
  meals: MealRow[],
  metric: DayMetric,
  target: number | null,
  partial: PartialMealMetrics = {}
): DayFigure {
  const eaten = sumRounded(meals.map((meal) => meal[metric]));
  if (target == null || target <= 0) return { mode: 'eaten', eaten, target: null };
  if (!metricIsComplete(meals, metric, partial)) return { mode: 'eaten', eaten, target };
  return { mode: 'remaining', eaten, target, remaining: Math.round(target - eaten) };
}

/** The targeted metrics — the only ones a note may name, because they are the
 *  only ones the screen was counting down. */
function trackedMetrics(targets: Partial<Record<DayMetric, number | null>>): DayMetric[] {
  const order: DayMetric[] = ['kcal', 'protein_g', 'carbs_g', 'fat_g'];
  return order.filter((metric) => {
    const target = targets[metric];
    return target != null && target > 0;
  });
}

/**
 * The metrics that HAVE a target but could not be counted down, in display
 * order — what the authored line under the grid names. Empty when the grid is
 * fully guarded, which is the ordinary case.
 */
export function unguardedMetrics(
  meals: MealRow[],
  targets: Partial<Record<DayMetric, number | null>>,
  partial: PartialMealMetrics = {}
): DayMetric[] {
  return trackedMetrics(targets).filter((metric) => !metricIsComplete(meals, metric, partial));
}

/** How many of today's meals are missing or short on at least one targeted metric. */
export function mealsMissingValues(
  meals: MealRow[],
  targets: Partial<Record<DayMetric, number | null>>,
  partial: PartialMealMetrics = {}
): number {
  const tracked = trackedMetrics(targets);
  if (tracked.length === 0) return 0;
  return meals.filter((meal) =>
    tracked.some((metric) => meal[metric] == null || partial[meal.id]?.[metric] === true)
  ).length;
}

/**
 * The sentence that replaces a remainder when the day cannot support one.
 * Written as a fact plus its consequence, never an apology — and it names the
 * count, so it reconciles with the em-dashes visible in the ledger below.
 * Returns null when nothing is missing (the grid says it all).
 */
export function unguardedNote(
  meals: MealRow[],
  targets: Partial<Record<DayMetric, number | null>>,
  partial: PartialMealMetrics = {}
): string | null {
  const missing = unguardedMetrics(meals, targets, partial);
  if (missing.length === 0) return null;
  const mealCount = mealsMissingValues(meals, targets, partial);
  const names = missing.map((metric) => DAY_METRIC_LABELS[metric]);
  // "energy or protein", never "and": the claim distributes over the meals, and
  // each counted meal is short on at LEAST one of the named metrics — not on
  // every one of them. An earlier draft wrote "and", which asserted a
  // conjunction no meal in the repro case satisfied.
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  const subject = mealCount === 1 ? 'One meal is' : `${mealCount} meals are`;

  // Scope the consequence to what actually failed. When only some of the
  // targeted metrics are unguarded, the others ARE counting down in the cells
  // right above this line — claiming "what is left of today is not known" over
  // a grid that is visibly showing what is left of protein is a false whole-day
  // generalisation of a per-metric fallback.
  const tracked = trackedMetrics(targets);
  if (missing.length === tracked.length) {
    return `${subject} not fully counted for ${list}, so what is left of today is not known. This is what has been logged.`;
  }
  const those = missing.length === 1 ? 'that figure is' : 'those figures are';
  return `${subject} not fully counted for ${list}, so ${those} what has been logged rather than what is left.`;
}
