/**
 * Types for the recipe book, mirroring db/migrations/0031_recipes.sql — see
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
  /** 0034: the photo's BASE NAME inside the recipe photo directory, never a
   *  path (iOS re-issues the container UUID on every install). Resolved to a
   *  URI at read time by src/lib/media/recipe-photo-store.ts. */
  photo_file_name: string | null;
  /** 0035: where the recipe is filed. NULL = Unfiled, which is a place and not
   *  a failure — every recipe arrives here and stays reachable from the book's
   *  default view. Deleting a folder SET NULLs this; it never deletes a
   *  recipe. */
  folder_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/**
 * A `recipe_folders` row (0035) — one drawer of the recipe book.
 *
 * Flat and single-membership by design: a recipe carries one `folder_id`, so a
 * folder is a PLACE rather than a label. The reasoning, and what tags are for
 * instead, is in the 0035 migration header.
 */
export type RecipeFolderRow = {
  id: string;
  name: string;
  /** Lowercased, whitespace-collapsed; UNIQUE (two drawers labelled "Dinners"
   *  is a filing error). Written by the repository, never by SQL. */
  name_norm: string;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/** A folder as the book lists it: the row plus how many recipes it holds. */
export type RecipeFolderSummary = {
  folder: RecipeFolderRow;
  recipeCount: number;
};

/**
 * Who priced an ingredient line (0034). NULL ⇔ the line is unresolved.
 *
 * The manual Link chore was retired on 2026-08-12 in favour of pricing every
 * line automatically — but the reason it existed was PROVENANCE, not the
 * tapping, so the provenance became a column instead of disappearing with it:
 *
 *   `user`     the user picked the catalog food by hand (still available as the
 *              correction path, and what every pre-0034 resolution was)
 *   `catalog`  an EXACT catalog name match at a mass quantity read off the line
 *              itself — same data as `user`, reached without asking. Never
 *              fuzzy: exact name or leading phrase, or no match at all.
 *   `ai`       a model priced the line. A genuine estimate, and every surface
 *              that draws it says so.
 */
export type IngredientResolvedBy = 'user' | 'catalog' | 'ai';

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
  /** 0034: who priced this line. NULL ⇔ unresolved — the pair the schema
   *  cannot enforce as a CHECK (see the 0034 header) and the repository
   *  maintains. */
  resolved_by: IngredientResolvedBy | null;
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
  /**
   * Of those, how many a MODEL priced rather than the catalog (0034).
   * `complete` says the numbers add up; this says what they are made of, and
   * every screen that prints the figures prints this beside them — otherwise
   * "complete" would quietly mean two different things.
   */
  estimatedCount: number;
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

/**
 * Which of the three things an ingredient line is, once a portion is applied.
 * The distinction is the whole honesty story of a recipe log:
 *   - `counted`    — resolved, carries real scaled numbers.
 *   - `uncounted`  — unresolved and not excused: it WILL be logged by name with
 *                    no macros, so the meal is a known undercount.
 *   - `negligible` — zero by the user's own declaration ("salt to taste"), so
 *                    it is neither counted nor a shortfall.
 */
export type RecipeLineState = 'counted' | 'uncounted' | 'negligible';

/**
 * One ingredient line scaled to a portion. The single derivation behind both
 * what the Log sheet lists and what `logRecipe` writes — so the preview cannot
 * promise a number the write does not produce.
 *
 * Every macro is null on a non-counted line, and individually nullable on a
 * counted one (a resolving food may genuinely lack fiber).
 */
export type ScaledRecipeLine = {
  id: string;
  /** The line as written — what the reader recognises on the sheet. */
  raw_text: string;
  /** The name the logged meal item takes. */
  name: string;
  food_id: string | null;
  state: RecipeLineState;
  grams: number | null;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  micros: JsonText | null;
};

/** Per-macro-honest sums over a set of scaled lines: null where ANY counted
 *  line lacks that macro, never a partial sum printed as a total. */
export type ScaledRecipeTotals = {
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
};

/** logRecipe's date/time target (todayISODate + optional wall-clock time). */
export type RecipeLogTarget = { date: DateString; time: TimeString | null };
