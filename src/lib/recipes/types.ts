/**
 * Types for the recipe book, mirroring db/migrations/0030_recipes.sql — see
 * docs/recipes-grocery.md. Kept beside the feature (the nutrition-types
 * pattern): hand-authored, lockstep with the schema.
 */
import type { DateString, JsonText, SqliteBool, TimeString, Timestamp } from '@/lib/db/types';

/** Recipe provenance: authored · imported from a URL/text/photo · Coach-designed. */
export type RecipeSource = 'user' | 'import' | 'ai';

export type RecipePlatform = 'instagram' | 'tiktok' | 'youtube' | 'website';

/** A `recipes` row as SELECT returns it. */
export type RecipeRow = {
  id: string;
  title: string;
  title_norm: string;
  source: RecipeSource;
  source_url: string | null;
  source_platform: RecipePlatform | null;
  source_author: string | null;
  source_image_url: string | null;
  /** The batch yield — the scaling denominator. */
  servings: number;
  total_weight_g: number | null;
  prep_min: number | null;
  cook_min: number | null;
  /** JSON array of instruction strings. */
  steps: JsonText;
  tags: JsonText | null;
  notes: string | null;
  is_favorite: SqliteBool;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/**
 * A `recipe_ingredients` row. `raw_text` is the source of truth; qty/unit/name
 * are the parsed overlay; food_id + grams + the macro/micro columns are the
 * EXPLICIT resolution's per-BATCH snapshots (0018 discipline — they survive
 * catalog churn; food_id is provenance only, ON DELETE SET NULL).
 *
 * Resolved ⇔ grams !== null && kcal !== null (the schema couples them).
 */
export type RecipeIngredientRow = {
  id: string;
  recipe_id: string;
  position: number;
  raw_text: string;
  qty: number | null;
  unit: string | null;
  name: string | null;
  food_id: string | null;
  grams: number | null;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  micros: JsonText | null;
  negligible: SqliteBool;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/** What the app supplies per ingredient line when creating/importing a recipe
 * — the unresolved shape (resolution is a separate, explicit act). */
export type NewRecipeIngredient = {
  raw_text: string;
  qty?: number | null;
  unit?: string | null;
  name?: string | null;
};

/** What the app supplies to create a recipe. Steps as a string array (the
 * repository serializes); `title_norm` is derived, never passed in. */
export type NewRecipe = {
  title: string;
  source?: RecipeSource;
  source_url?: string | null;
  source_platform?: RecipePlatform | null;
  source_author?: string | null;
  source_image_url?: string | null;
  servings: number;
  total_weight_g?: number | null;
  prep_min?: number | null;
  cook_min?: number | null;
  steps?: string[];
  tags?: string[] | null;
  notes?: string | null;
  ingredients: NewRecipeIngredient[];
};

/** A recipe list row: the recipe + derived cook stats + nutrition headline. */
export type RecipeSummary = {
  recipe: RecipeRow;
  ingredientCount: number;
  /** Per-serving kcal when nutrition is complete; null otherwise. */
  perServingKcal: number | null;
  nutritionComplete: boolean;
  timesCooked: number;
  lastCooked: DateString | null;
};

/**
 * Per-serving nutrition under the honesty gate (docs/recipes-grocery.md §2a):
 * `complete` requires every line resolved-or-negligible AND ≥1 non-negligible
 * resolved line. Macros other than kcal are per-macro honest — null when any
 * counted line's snapshot lacks that macro ("—", never a partial sum).
 */
export type RecipeNutrition = {
  complete: boolean;
  unresolvedCount: number;
  /** Lines counted into the sums (resolved, non-negligible). */
  countedCount: number;
  perServing: {
    kcal: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    fiber_g: number | null;
  };
};

/** The portion argument to logRecipe: servings XOR grams-of-cooked-dish. */
export type RecipePortion = { servings: number } | { grams: number };

/** logRecipe's date/time target (todayISODate + optional wall-clock time). */
export type RecipeLogTarget = { date: DateString; time: TimeString | null };
