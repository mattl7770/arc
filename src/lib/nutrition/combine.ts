/**
 * Combining meals, decided — which of a day's meals can become one, which one
 * survives, and what the result will read as (owner, device, 2026-09-23:
 * *"some way to easily combine multiple food logs that are the same meal"*).
 *
 * Pure and DB-free, like `remaining.ts` and `composite.ts`: the Eat tab reads
 * the plan to draw its sentence and its button, and `combineMeals`
 * (src/lib/db/repositories/nutrition.ts) runs the SAME plan before it writes, so
 * the sentence above the control and the write it performs cannot disagree.
 *
 * ## The rules, and why each one
 *
 * - **The earliest meal survives**, in the day list's own order — timed meals
 *   by clock, untimed ones after them, then by when they were logged. Its id,
 *   its date and its time are the result's. "The earliest time" is the only
 *   default that needs no explaining: the meal started when its first part was
 *   eaten. Keeping that meal's ROW (not minting a new one) is what keeps every
 *   reference to it pointing at something.
 * - **The name is the earliest meal's until the user types another** — the
 *   same rule the barcode scanner uses for a multi-scan meal (A4): the thing
 *   that started it names it, and a rename is one field away.
 * - **Same day only.** A meal belongs to one day's totals; combining across a
 *   boundary would silently move energy between days. The Eat tab only ever
 *   offers one day's meals, so this is the backstop, not the UI's rule.
 * - **Not while an estimate is pending (0057).** A queued estimate is applied
 *   with `replaceMealItems` onto ITS meal when it lands — onto a combined meal
 *   that would replace every other meal's items with the one estimate. So the
 *   waiting meal is refused, by name, until its numbers are in.
 * - **At most one recipe.** `meals.recipe_id` is how "times cooked" is counted
 *   (0031); a meal carries one. Two meals cooked from two different recipes
 *   combined into one would un-cook one of them, so they are refused rather
 *   than one being chosen silently. Two meals from the SAME recipe combine and
 *   keep it.
 */
import { fmtInt } from './format';
import type { MealRow } from './types';

/** What the planner needs of a meal — a `MealRow` satisfies it. */
export type CombinableMeal = Pick<
  MealRow,
  'id' | 'date' | 'time' | 'name' | 'kcal' | 'recipe_id' | 'created_at'
>;

/**
 * The day list's own order (`listTodayMeals`): timed meals by clock, untimed
 * after them, then by when they were logged, then by id. The first meal in
 * this order is the one a combine keeps.
 */
export function mealListOrder(a: CombinableMeal, b: CombinableMeal): number {
  const aUntimed = a.time === null ? 1 : 0;
  const bUntimed = b.time === null ? 1 : 0;
  if (aUntimed !== bUntimed) return aUntimed - bUntimed;
  if (a.time !== b.time) return (a.time ?? '') < (b.time ?? '') ? -1 : 1;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A plan that can be carried out. */
export type CombineOk<M extends CombinableMeal = CombinableMeal> = {
  kind: 'ok';
  /** The meal whose row, id, date and time the result keeps. */
  keep: M;
  /** The others, in list order — their rows go, their items move. */
  absorb: M[];
  count: number;
  /** The result's time: the kept meal's, which is the earliest. */
  time: string | null;
  /** The energy the chosen meals add up to now, over the ones that recorded
   *  any — and so the energy the result will carry. Null when none did. */
  kcal: number | null;
};

export type CombinePlan<M extends CombinableMeal = CombinableMeal> =
  /** Fewer than two chosen — nothing to combine yet. */
  | { kind: 'too-few'; count: number }
  /** Chosen, and not combinable; `reason` is the sentence the screen shows. */
  | { kind: 'refused'; reason: string }
  | CombineOk<M>;

/**
 * Plan a combine of `chosen` — every meal in it, in any order.
 *
 * `pending` is the set of meal ids still waiting on a queued estimate
 * (`pendingEstimateMealIds`); a chosen meal in it refuses the whole plan.
 */
export function planCombine<M extends CombinableMeal>(
  chosen: readonly M[],
  pending: ReadonlySet<string> = new Set()
): CombinePlan<M> {
  const unique = [...new Map(chosen.map((m) => [m.id, m])).values()];
  if (unique.length < 2) return { kind: 'too-few', count: unique.length };

  const ordered = [...unique].sort(mealListOrder);
  const keep = ordered[0]!;

  if (ordered.some((m) => m.date !== keep.date)) {
    return {
      kind: 'refused',
      reason:
        'These were logged on different days. A meal belongs to one day, so only meals from the same day combine.',
    };
  }

  const waiting = ordered.find((m) => pending.has(m.id));
  if (waiting) {
    return {
      kind: 'refused',
      reason: `“${waiting.name}” is still waiting on its estimate. Combine it once its numbers are in.`,
    };
  }

  const cooked = ordered.filter((m) => m.recipe_id !== null);
  const first = cooked[0];
  const other = cooked.find((m) => m.recipe_id !== first?.recipe_id);
  if (first && other) {
    return {
      kind: 'refused',
      reason: `“${first.name}” and “${other.name}” were each cooked from a recipe, and a meal carries one recipe — so they stay separate.`,
    };
  }

  let kcal: number | null = null;
  for (const meal of ordered) {
    if (meal.kcal != null) kcal = (kcal ?? 0) + meal.kcal;
  }

  return {
    kind: 'ok',
    keep,
    absorb: ordered.slice(1),
    count: ordered.length,
    time: keep.time,
    kcal,
  };
}

/**
 * The name a combine writes: what was typed, trimmed — or, when the field is
 * untouched or emptied, the kept meal's own name. Never empty, because
 * `meals.name` is `NOT NULL` and nothing derives one.
 */
export function combinedName(typed: string | null, keep: CombinableMeal): string {
  const trimmed = (typed ?? '').trim();
  return trimmed === '' ? keep.name : trimmed;
}

/**
 * The consequence, in future tense, for the line above the control
 * (00-design-spec.md §5: a pending write states what it will do before it does
 * it). It names the name, the time and the energy, and says the day's total
 * does not move — which is the thing a person hesitating over this is checking.
 */
export function combineConsequence(plan: CombineOk, name: string): string {
  const when = plan.time !== null ? `at ${plan.time}` : 'with no time';
  const energy =
    plan.kcal !== null
      ? `${fmtInt(plan.kcal)} kcal, so the day’s total does not change`
      : 'no energy recorded';
  return `On combine: these ${plan.count} become one meal, “${name}”, ${when} — ${energy}. Their items and photos move into it.`;
}
