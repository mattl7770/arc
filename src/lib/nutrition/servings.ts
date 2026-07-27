/**
 * Portion math for the foods catalog: per-100 g canonical values × a portion →
 * the macro snapshot a meal_item stores. Pure and DB-free, so the same code
 * runs in the UI, the repositories, and the headless tests (db/foods.test.mjs).
 *
 * NULL discipline matches the schema: a food that doesn't record a macro
 * yields NULL for it at any portion — "not recorded" never becomes 0.
 */
import { microsForGrams, serializeMicros } from './micros';
import type { FoodRow, NewMealItem } from './types';

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
