/**
 * Portion math for the foods catalog: per-100 g canonical values × a portion →
 * the macro snapshot a meal_item stores. Pure and DB-free, so the same code
 * runs in the UI, the repositories, and the headless tests (db/foods.test.mjs).
 *
 * NULL discipline matches the schema: a food that doesn't record a macro
 * yields NULL for it at any portion — "not recorded" never becomes 0.
 */
import { microsForGrams, parseMicros, scaleMicros, serializeMicros } from './micros';
import type { FoodRow, MealItemRow, NewMealItem } from './types';

/** The per-100 g columns portion math reads — satisfied by a full FoodRow. */
export type FoodMacros = Pick<
  FoodRow,
  | 'kcal_100g'
  | 'protein_g_100g'
  | 'carbs_g_100g'
  | 'fat_g_100g'
  | 'fiber_g_100g'
  | 'serving_name'
  | 'serving_grams'
>;

/** Grams for `qty` of the food's named serving; null when it has none. */
export function gramsForQty(food: FoodMacros, qty: number): number | null {
  return food.serving_grams === null ? null : qty * food.serving_grams;
}

const scale = (per100: number | null, grams: number): number | null =>
  per100 === null ? null : (per100 * grams) / 100;

/** The macro snapshot for `grams` of a food — what a meal_item stores. */
export function macrosForGrams(
  food: FoodMacros,
  grams: number
): Pick<NewMealItem, 'kcal' | 'protein_g' | 'carbs_g' | 'fat_g' | 'fiber_g'> {
  return {
    kcal: scale(food.kcal_100g, grams),
    protein_g: scale(food.protein_g_100g, grams),
    carbs_g: scale(food.carbs_g_100g, grams),
    fat_g: scale(food.fat_g_100g, grams),
    fiber_g: scale(food.fiber_g_100g, grams),
  };
}

/**
 * A ready-to-insert item for `qty` servings (when the food names one) or for
 * `grams` directly — the one place the search screen's "Add" builds its row.
 */
export function itemForPortion(
  food: FoodRow,
  portion: { servingQty: number } | { grams: number }
): NewMealItem {
  const grams = 'grams' in portion ? portion.grams : (gramsForQty(food, portion.servingQty) ?? 0);
  return {
    food_id: food.id,
    name: food.name,
    grams: grams > 0 ? grams : null,
    serving_qty: 'servingQty' in portion ? portion.servingQty : null,
    ...(grams > 0
      ? macrosForGrams(food, grams)
      : { kcal: null, protein_g: null, carbs_g: null, fat_g: null, fiber_g: null }),
    // Snapshot the food's micros scaled to this portion (0017); NULL when the
    // food carries none, so "not recorded" never becomes a fake zero.
    micros: grams > 0 ? serializeMicros(microsForGrams(food.micros, grams)) : null,
  };
}

/** The columns updateMealItemPortion rewrites for a re-portioned logged item. */
export type PortionUpdate = Pick<
  NewMealItem,
  'grams' | 'serving_qty' | 'kcal' | 'protein_g' | 'carbs_g' | 'fat_g' | 'fiber_g' | 'micros'
>;

/**
 * Recompute a logged item's macro/micro snapshot for a new portion — what
 * meal-detail's inline editor feeds updateMealItemPortion.
 *
 * When the catalog food is still present it RE-DERIVES from the food's per-100 g
 * values (accurate, and the only way to honour a serving stepper). When the food
 * is gone or the item was never linked (a free-form or AI item), it scales the
 * item's own snapshot PROPORTIONALLY by grams — the best that can be done from a
 * snapshot alone. Returns null when neither basis exists (a food-less item
 * logged without grams, e.g. an "≈300 kcal" AI estimate): such an item has no
 * portion to re-scale, so the UI must not offer inline editing for it.
 */
export function rescaleLoggedItem(
  item: Pick<
    MealItemRow,
    'grams' | 'kcal' | 'protein_g' | 'carbs_g' | 'fat_g' | 'fiber_g' | 'micros'
  >,
  food: FoodRow | undefined,
  portion: { grams: number } | { servingQty: number }
): PortionUpdate | null {
  if (food) {
    const next = itemForPortion(food, portion);
    return {
      grams: next.grams ?? null,
      serving_qty: next.serving_qty ?? null,
      kcal: next.kcal ?? null,
      protein_g: next.protein_g ?? null,
      carbs_g: next.carbs_g ?? null,
      fat_g: next.fat_g ?? null,
      fiber_g: next.fiber_g ?? null,
      micros: next.micros ?? null,
    };
  }
  // No catalog food: a serving stepper is impossible, and proportional scaling
  // needs a positive old grams to divide by.
  if (!('grams' in portion)) return null;
  const oldGrams = item.grams;
  if (oldGrams == null || oldGrams <= 0 || portion.grams <= 0) return null;
  const ratio = portion.grams / oldGrams;
  const s = (v: number | null): number | null => (v == null ? null : v * ratio);
  return {
    grams: portion.grams,
    serving_qty: null,
    kcal: s(item.kcal),
    protein_g: s(item.protein_g),
    carbs_g: s(item.carbs_g),
    fat_g: s(item.fat_g),
    fiber_g: s(item.fiber_g),
    micros: serializeMicros(scaleMicros(parseMicros(item.micros), ratio)),
  };
}
