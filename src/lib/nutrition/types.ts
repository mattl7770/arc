/**
 * Types for the Nutrition domain, mirroring db/migrations/0002_nutrition.sql
 * plus the food-catalog migrations 0014 (foods, meal_items) and 0015
 * (nutrition_targets), micros on meal_items (0017), and templates (0018) —
 * see docs/nutrition-subapp.md.
 *
 * Kept beside the nutrition feature rather than in src/lib/db/types.ts (the
 * 0001 rows) so parallel schema work doesn't collide in one file; same
 * hand-authored, lockstep-with-the-schema contract. Scalar shapes (Timestamp,
 * DateString…) are shared from the db types.
 */
import type {
  Authorship,
  DataSource,
  DateString,
  JsonText,
  SqliteBool,
  TimeString,
  Timestamp,
} from '@/lib/db/types';

/** A `meals` row as SELECT returns it. */
export type MealRow = {
  id: string;
  date: DateString;
  time: TimeString | null;
  name: string;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  source: DataSource;
  notes: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/**
 * What the app supplies when logging a meal. The id, source ('manual' — the
 * photo/NL path stamps its own when it lands) and timestamps are filled in by
 * the repository / DB defaults. Absent macros store as NULL, never 0 — "not
 * recorded" and "zero grams" are different facts.
 */
export type NewMeal = {
  date: DateString;
  time: TimeString | null;
  name: string;
  kcal?: number | null;
  protein_g?: number | null;
  carbs_g?: number | null;
  fat_g?: number | null;
  notes?: string | null;
};

/** The day's summed intake for the "Today" card. NULL macros sum as absent. */
export type DayTotals = {
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  /** Number of meals logged — lets the UI tell "no meals" from "all zeros". */
  mealCount: number;
};

// --- Foods catalog (0014) -----------------------------------------------------

/**
 * Catalog provenance — a different axis than the shared DataSource of *logged*
 * rows: 'seed' (the 0016 starter catalog), 'user' (custom foods), 'ai'
 * (synthesized by the estimation path), 'openfoodfacts' (cached barcode hits).
 */
export type FoodSource = 'seed' | 'user' | 'ai' | 'openfoodfacts';

/** Per-item confidence the AI estimation path stamps; manual items carry NULL. */
export type EstimateConfidence = 'high' | 'medium' | 'low';

/** A `foods` row as SELECT returns it. Macros are canonical per-100 g. */
export type FoodRow = {
  id: string;
  name: string;
  /** Lowercased search key, written by the repository on every insert/update. */
  name_norm: string;
  brand: string | null;
  barcode: string | null;
  serving_name: string | null;
  serving_grams: number | null;
  kcal_100g: number | null;
  protein_g_100g: number | null;
  carbs_g_100g: number | null;
  fat_g_100g: number | null;
  fiber_g_100g: number | null;
  /** JSON object of longevity-shortlist micros per 100 g (sodium_mg, …). */
  micros: JsonText | null;
  source: FoodSource;
  is_favorite: SqliteBool;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/**
 * What the app supplies when creating (or fully re-writing, see updateFood) a
 * catalog entry. `name_norm` is derived by the repository, never passed in.
 */
export type NewFood = {
  name: string;
  brand?: string | null;
  barcode?: string | null;
  serving_name?: string | null;
  serving_grams?: number | null;
  kcal_100g?: number | null;
  protein_g_100g?: number | null;
  carbs_g_100g?: number | null;
  fat_g_100g?: number | null;
  fiber_g_100g?: number | null;
  micros?: JsonText | null;
  /** Defaults to 'user' — runtime creates are the user's own foods. */
  source?: FoodSource;
};

/** A catalog food + the portion it was last logged at (the recents rail). */
export type RecentFood = {
  food: FoodRow;
  lastGrams: number | null;
  lastServingQty: number | null;
  lastLoggedAt: Timestamp;
};

// --- Meal items (0014; micros 0017) -------------------------------------------

/**
 * A `meal_items` row. `name` and the macro columns are a snapshot at log time —
 * catalog edits/deletes never rewrite eating history (food_id is provenance
 * only, ON DELETE SET NULL).
 */
export type MealItemRow = {
  id: string;
  meal_id: string;
  food_id: string | null;
  name: string;
  grams: number | null;
  serving_qty: number | null;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  confidence: EstimateConfidence | null;
  /** Per-portion micronutrient snapshot (JSON), scaled from the food at log
   * time — added in 0014. NULL when the food had no micro data. */
  micros: JsonText | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/** An item as listMealItems returns it: joined with the food's serving name
 * (NULL when the item was free-form or its catalog food was deleted). */
export type MealItemWithServing = MealItemRow & { food_serving_name: string | null };

/** What the app supplies per item when logging; macros already scaled to the
 * portion (src/lib/nutrition/servings.ts owns that math). */
export type NewMealItem = {
  food_id?: string | null;
  name: string;
  grams?: number | null;
  serving_qty?: number | null;
  kcal?: number | null;
  protein_g?: number | null;
  carbs_g?: number | null;
  fat_g?: number | null;
  fiber_g?: number | null;
  confidence?: EstimateConfidence | null;
  /** Per-portion micronutrient snapshot as a JSON string (serializeMicros). */
  micros?: JsonText | null;
};

/** A meal plus its items, logged atomically; the meal's macro columns are
 * written as the item sums so every existing `meals` read stays correct. */
export type NewMealWithItems = {
  date: DateString;
  time: TimeString | null;
  name: string;
  notes?: string | null;
  /** 'manual' for hand-logged; 'ai_suggested' when the estimation path saves. */
  source?: Extract<DataSource, 'manual' | 'ai_suggested'>;
  items: NewMealItem[];
};

// --- Daily targets (0015) -----------------------------------------------------

/** A `nutrition_targets` row — append-only and immutable (no updated_at). */
export type NutritionTargetsRow = {
  id: string;
  effective_date: DateString;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  created_by: Authorship;
  notes: string | null;
  created_at: Timestamp;
};

/** What the app supplies when appending a target version. At least one of the
 * five values must be non-null (the schema CHECK enforces it too). */
export type NewNutritionTargets = {
  effective_date: DateString;
  kcal?: number | null;
  protein_g?: number | null;
  carbs_g?: number | null;
  fat_g?: number | null;
  fiber_g?: number | null;
  /** Defaults to 'user'; the Coach's future proposals stamp 'ai'. */
  created_by?: Authorship;
  notes?: string | null;
};

// --- Meal templates (0018) ----------------------------------------------------

/** A `meal_templates` row — a reusable named meal. */
export type MealTemplateRow = {
  id: string;
  name: string;
  name_norm: string;
  notes: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/** A `meal_template_items` row — a food+portion snapshot inside a template
 * (mirrors MealItemRow minus confidence; templates are curated, not estimated). */
export type MealTemplateItemRow = {
  id: string;
  template_id: string;
  food_id: string | null;
  name: string;
  grams: number | null;
  serving_qty: number | null;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  micros: JsonText | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/** A template with its rolled-up totals + item count — the templates list row. */
export type MealTemplateSummary = {
  template: MealTemplateRow;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  itemCount: number;
};

/** What the app supplies to create a template (items reuse NewMealItem). */
export type NewMealTemplate = {
  name: string;
  notes?: string | null;
  items: NewMealItem[];
};

// --- Cross-day trends & micro rollups (view models) --------------------------

/** One day in the nutrition history view: totals + the active targets that day
 * (null where none were set), so adherence is judged against the era's targets. */
export type NutritionHistoryDay = {
  date: DateString;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  mealCount: number;
  /** Active kcal/protein/carbs/fat/fiber targets for this day, or null. */
  target: {
    kcal: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    fiber_g: number | null;
  } | null;
};
