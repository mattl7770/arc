/**
 * Composite foods, read side (0058, backlog C4): a flat `meal_items` list
 * becomes the one-level tree every screen draws.
 *
 * Pure and DB-free, in the style of `servings.ts` / `remaining.ts`, so the same
 * code runs in the UI and in db/nutrition-v2.test.mjs.
 *
 * ## The headline is the parts, by construction
 *
 * A composite header stores NO numbers (invariant 2). What the reader sees on a
 * collapsed pizza is {@link CompositeRollup} — computed here, at read time,
 * never stored. That satisfies the ledger rule ("the visible meals must add to
 * 2,180") by construction rather than by maintenance: the headline *is* the
 * children's sum, so it cannot disagree with them.
 *
 * ## Two rules the roll-up will not break
 *
 * - **No fabricated total.** An amount sums only when EVERY part has one; a
 *   macro sums only over the parts that recorded it, and is NULL when none did.
 *   The same NULL discipline as `sumOrNull` — "not recorded" never becomes 0.
 * - **Nothing converts (B2/0047).** Parts in different units do not sum to an
 *   amount at all. There is no ml↔g factor in this codebase and a roll-up is
 *   not the place to invent one; the macros still sum, because kcal and grams
 *   of macronutrient are absolute for the portion whatever it is measured in.
 */
import { fmtQty } from './format';
import type { AmountUnit, MealItemWithServing } from './types';

/** What a collapsed composite reads as — derived, never stored. */
export type CompositeRollup = {
  /** The parts' total portion, or null when they do not all have one, or do
   *  not share a unit. Never a converted number. */
  amount: number | null;
  /** The unit that total is in; the header's own unit when the parts disagree
   *  (in which case `amount` is null anyway and nothing prints it). */
  unit: AmountUnit;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
};

export type MealItemNode =
  | { kind: 'item'; item: MealItemWithServing }
  | {
      kind: 'composite';
      item: MealItemWithServing;
      components: MealItemWithServing[];
      rolled: CompositeRollup;
    };

/** NULL-skipping sum: absent everywhere → null, else the sum of the knowns. */
function sumOrNull(values: (number | null | undefined)[]): number | null {
  let sum: number | null = null;
  for (const v of values) {
    if (v != null) sum = (sum ?? 0) + v;
  }
  return sum;
}

/** The parts' total portion — see the header for the two rules it will not
 *  break. */
export function rollUpComponents(
  header: MealItemWithServing,
  components: MealItemWithServing[]
): CompositeRollup {
  const units = new Set(components.map((c) => c.unit));
  const everyPartPriced = components.length > 0 && components.every((c) => c.amount != null);
  const oneUnit = units.size === 1;
  return {
    amount:
      everyPartPriced && oneUnit ? components.reduce((sum, c) => sum + (c.amount ?? 0), 0) : null,
    unit: oneUnit ? (components[0]?.unit ?? header.unit) : header.unit,
    kcal: sumOrNull(components.map((c) => c.kcal)),
    protein_g: sumOrNull(components.map((c) => c.protein_g)),
    carbs_g: sumOrNull(components.map((c) => c.carbs_g)),
    fat_g: sumOrNull(components.map((c) => c.fat_g)),
    fiber_g: sumOrNull(components.map((c) => c.fiber_g)),
  };
}

/**
 * The tree, from `listMealItems`' flat rows in their logged order.
 *
 * Top-level order is the rows' own (`created_at, rowid`); components keep that
 * order inside their parent. **A row whose `parent_item_id` names a parent not
 * present is emitted TOP-LEVEL rather than dropped** — a ledger never silently
 * loses a row it is holding, and the sums already counted that row.
 *
 * A header that ended up with no components (invariant 4 says the repository
 * prevents this) is emitted as a plain item, so it is visible and removable
 * rather than an invisible row inside a total.
 */
export function assembleMealItems(rows: MealItemWithServing[]): MealItemNode[] {
  const byParent = new Map<string, MealItemWithServing[]>();
  const present = new Set(rows.map((r) => r.id));
  for (const row of rows) {
    const parent = row.parent_item_id;
    if (parent === null || !present.has(parent)) continue;
    const list = byParent.get(parent);
    if (list) list.push(row);
    else byParent.set(parent, [row]);
  }
  const nodes: MealItemNode[] = [];
  for (const row of rows) {
    // An orphan's parent is absent, so it was skipped above and lands here.
    if (row.parent_item_id !== null && present.has(row.parent_item_id)) continue;
    const components = byParent.get(row.id) ?? [];
    if (row.is_composite === 1 && components.length > 0) {
      nodes.push({
        kind: 'composite',
        item: row,
        components,
        rolled: rollUpComponents(row, components),
      });
    } else {
      nodes.push({ kind: 'item', item: row });
    }
  }
  return nodes;
}

/**
 * The rows that carry NUMBERS — headers dropped, components kept.
 *
 * What every consumer that cannot express a composite reads: a meal template, a
 * recipe captured from a meal, the model's view of a meal it is being asked to
 * revise. Flattening there is honest — a template IS a curated list of priced
 * lines — and it is the same set the meal's totals are summed from, so nothing
 * moves when a composite is flattened into one.
 */
export function leafMealItems(rows: MealItemWithServing[]): MealItemWithServing[] {
  return rows.filter((row) => row.is_composite !== 1);
}

/**
 * What typing a whole dish's new amount on a LOGGED composite does (owner,
 * 2026-10-21: *"update gram amount for a full 'pizza' after logged"*).
 *
 * The dish has no amount of its own (invariant 2) — what the row prints is the
 * parts' sum, `rolled`. So a new whole-dish amount can only mean "every part,
 * scaled by new / rolled", which is `scaleCompositeItem`'s one operation, the
 * same one the ½ ⅓ ¼ chips call. Nothing else is honest: moving one part
 * would be a claim about WHICH part, which nothing knows.
 *
 * - `unavailable` — the parts have no shared amount (a part with none, or parts
 *   in different units: invariant 5). There is nothing to scale FROM, and the
 *   field is not offered.
 * - `none` — untouched, or the same amount: Save closes, writes nothing.
 * - `invalid` — not a positive number at most 5,000 (the ceiling every amount
 *   field in food logging uses).
 * - `scale` — the factor Save hands to `scaleCompositeItem`.
 *
 * `text` null is an untouched field.
 */
export type DishAmountPlan =
  | { kind: 'unavailable' }
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'scale'; amount: number; factor: number };

export function planDishAmount(text: string | null, rolled: CompositeRollup): DishAmountPlan {
  if (rolled.amount == null || !(rolled.amount > 0)) return { kind: 'unavailable' };
  if (text === null) return { kind: 'none' };
  const t = text.trim();
  if (t === '') return { kind: 'invalid' };
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0 || n > 5000) return { kind: 'invalid' };
  // No change is judged against the amount AS THE FIELD PRINTS IT, so
  // retyping what it shows is a no-op: parts that sum to 799.9999 print "800",
  // and "800" must not scale them by 1.0000001.
  if (Math.abs(n - rolled.amount) < 1e-9 || n === Number(fmtQty(rolled.amount))) {
    return { kind: 'none' };
  }
  return { kind: 'scale', amount: n, factor: n / rolled.amount };
}
