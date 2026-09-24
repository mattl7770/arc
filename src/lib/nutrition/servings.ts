/**
 * Portion math for the foods catalog: per-100 canonical values × a portion →
 * the macro snapshot a meal_item stores. Pure and DB-free, so the same code
 * runs in the UI, the repositories, and the headless tests (db/foods.test.mjs).
 *
 * NULL discipline matches the schema: a food that doesn't record a macro
 * yields NULL for it at any portion — "not recorded" never becomes 0.
 *
 * **Unit-blind by construction (0047).** A food's per-100 values are per 100 of
 * its own `basis` and every portion of it is in that same basis, so the ratio
 * below is identical arithmetic for 250 ml of milk and 250 g of rice. The unit
 * is carried onto the item so it can be PRINTED, never so it can be converted —
 * there is no ml↔g factor here or anywhere else.
 */
import {
  mergeMicros,
  type Micros,
  microsForAmount,
  parseMicros,
  scaleMicros,
  serializeMicros,
} from './micros';
import type { FoodRow, MealItemRow, NewMealItem } from './types';

/** The per-100 columns portion math reads — satisfied by a full FoodRow. */
export type FoodMacros = Pick<
  FoodRow,
  | 'kcal_100g'
  | 'protein_g_100g'
  | 'carbs_g_100g'
  | 'fat_g_100g'
  | 'fiber_g_100g'
  | 'serving_name'
  | 'serving_amount'
>;

/** The food's own amount for `qty` of its named serving; null when it has none.
 * In the food's basis, like every other amount it carries. */
export function amountForQty(food: FoodMacros, qty: number): number | null {
  return food.serving_amount === null ? null : qty * food.serving_amount;
}

const scale = (per100: number | null, amount: number): number | null =>
  per100 === null ? null : (per100 * amount) / 100;

/** The macro snapshot for `amount` of a food — what a meal_item stores. */
export function macrosForAmount(
  food: FoodMacros,
  amount: number
): Pick<NewMealItem, 'kcal' | 'protein_g' | 'carbs_g' | 'fat_g' | 'fiber_g'> {
  return {
    kcal: scale(food.kcal_100g, amount),
    protein_g: scale(food.protein_g_100g, amount),
    carbs_g: scale(food.carbs_g_100g, amount),
    fat_g: scale(food.fat_g_100g, amount),
    fiber_g: scale(food.fiber_g_100g, amount),
  };
}

/**
 * A ready-to-insert item for `qty` servings (when the food names one) or for an
 * `amount` directly — the one place the search screen's "Add" builds its row.
 *
 * The item's `unit` is the food's `basis`, SNAPSHOTTED here: editing a food's
 * basis later (or deleting the food) must not restate what an eaten portion was.
 */
export function itemForPortion(
  food: FoodRow,
  portion: { servingQty: number } | { amount: number }
): NewMealItem {
  const amount =
    'amount' in portion ? portion.amount : (amountForQty(food, portion.servingQty) ?? 0);
  return {
    food_id: food.id,
    name: food.name,
    amount: amount > 0 ? amount : null,
    serving_qty: 'servingQty' in portion ? portion.servingQty : null,
    unit: food.basis,
    ...(amount > 0
      ? macrosForAmount(food, amount)
      : { kcal: null, protein_g: null, carbs_g: null, fat_g: null, fiber_g: null }),
    // Snapshot the food's micros scaled to this portion (0017); NULL when the
    // food carries none, so "not recorded" never becomes a fake zero.
    micros: amount > 0 ? serializeMicros(microsForAmount(food.micros, amount)) : null,
  };
}

/** The columns updateMealItemPortion rewrites for a re-portioned logged item. */
export type PortionUpdate = Pick<
  NewMealItem,
  'amount' | 'serving_qty' | 'kcal' | 'protein_g' | 'carbs_g' | 'fat_g' | 'fiber_g' | 'micros'
>;

/**
 * Recompute a logged item's macro/micro snapshot for a new portion — what
 * meal-detail's inline editor feeds updateMealItemPortion.
 *
 * When the catalog food is still present it RE-DERIVES from the food's per-100
 * values (accurate, and the only way to honour a serving stepper) — every figure
 * the food records. A figure it does NOT record (fiber, or a micro key) keeps
 * the item's own value, scaled by the same ratio, so an AI item's sodium and
 * caffeine survive a food with no micros row (2026-09-23). When the food
 * is gone or the item was never linked (a free-form or AI item), it scales the
 * item's own snapshot PROPORTIONALLY by amount — the best that can be done from a
 * snapshot alone. Returns null when neither basis exists (a food-less item
 * logged without an amount, e.g. an "≈300 kcal" AI estimate): such an item has no
 * portion to re-scale, so the UI must not offer inline editing for it.
 *
 * **The unit is never rewritten.** It is absent from {@link PortionUpdate}
 * entirely: re-portioning answers "how much", and a food does not change what it
 * is measured in because the user typed a different number. A catalog food whose
 * basis was edited after the fact therefore re-prices the item at its new
 * per-100 values while the item keeps the unit it was logged in — which is the
 * same rule the name and the macro snapshot already follow.
 */
export function rescaleLoggedItem(
  item: Pick<
    MealItemRow,
    'amount' | 'kcal' | 'protein_g' | 'carbs_g' | 'fat_g' | 'fiber_g' | 'micros'
  >,
  food: FoodRow | undefined,
  portion: { amount: number } | { servingQty: number }
): PortionUpdate | null {
  if (food) {
    const next = itemForPortion(food, portion);
    // What the FOOD does not record, the item's own snapshot still does — an
    // AI item grounded to a seed food with no micros row carries the model's
    // sodium and caffeine, and one grounded to a food with no fiber figure
    // carries the model's fiber (grounding keeps both: `groundMealEstimate`).
    // Re-deriving from the food alone threw them away on the first re-price,
    // which the review screen does on every render (2026-09-23 — 77 of the 187
    // seed foods). So the food's figures win where it has them, and the item's
    // own scale proportionally everywhere else: each figure keeps the one
    // source it had.
    const oldAmount = item.amount;
    const newAmount = next.amount ?? null;
    const ratio =
      oldAmount != null && oldAmount > 0 && newAmount != null && newAmount > 0
        ? newAmount / oldAmount
        : null;
    const own: Micros = ratio === null ? {} : scaleMicros(parseMicros(item.micros), ratio);
    return {
      amount: newAmount,
      serving_qty: next.serving_qty ?? null,
      kcal: next.kcal ?? null,
      protein_g: next.protein_g ?? null,
      carbs_g: next.carbs_g ?? null,
      fat_g: next.fat_g ?? null,
      fiber_g:
        next.fiber_g ?? (ratio === null || item.fiber_g == null ? null : item.fiber_g * ratio),
      micros: serializeMicros(mergeMicros(parseMicros(next.micros), own)),
    };
  }
  // No catalog food: a serving stepper is impossible, and proportional scaling
  // needs a positive old amount to divide by.
  if (!('amount' in portion)) return null;
  const oldAmount = item.amount;
  if (oldAmount == null || oldAmount <= 0 || portion.amount <= 0) return null;
  const ratio = portion.amount / oldAmount;
  const s = (v: number | null): number | null => (v == null ? null : v * ratio);
  return {
    amount: portion.amount,
    serving_qty: null,
    kcal: s(item.kcal),
    protein_g: s(item.protein_g),
    carbs_g: s(item.carbs_g),
    fat_g: s(item.fat_g),
    fiber_g: s(item.fiber_g),
    micros: serializeMicros(scaleMicros(parseMicros(item.micros), ratio)),
  };
}
