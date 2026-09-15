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
  /** The recipe this meal was cooked from (0030) — provenance only, ON DELETE
   * SET NULL; "times cooked" derives from it. NULL for every other meal. */
  recipe_id: string | null;
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

/**
 * What a food is measured in, and what a logged portion of it is counted in —
 * ARC's whole unit vocabulary (0047, backlog B2). `'g'` for anything solid,
 * `'ml'` for a drink.
 *
 * **The two never convert.** A food declares one basis and every portion of it
 * is in that basis for life; there is no ml↔g factor in this codebase, because
 * one would need a density per food and nobody here has measured those. Energy
 * and macros are the common currency instead — they are absolute amounts per
 * portion, so a day's totals sum across units without knowing about either.
 */
export type AmountUnit = 'g' | 'ml';

/** A `foods` row as SELECT returns it. Macros are canonical per 100 of `basis`. */
export type FoodRow = {
  id: string;
  name: string;
  /** Lowercased search key, written by the repository on every insert/update. */
  name_norm: string;
  brand: string | null;
  barcode: string | null;
  serving_name: string | null;
  /** The named serving's size, in this food's {@link FoodRow.basis} (0047 —
   * `serving_grams` until a drink could be one of these). */
  serving_amount: number | null;
  kcal_100g: number | null;
  protein_g_100g: number | null;
  carbs_g_100g: number | null;
  fat_g_100g: number | null;
  fiber_g_100g: number | null;
  /** JSON object of longevity-shortlist micros per 100 of `basis` (sodium_mg, …). */
  micros: JsonText | null;
  source: FoodSource;
  is_favorite: SqliteBool;
  /** What this food is measured in — 'g' (the default, and every pre-0047 row)
   * or 'ml' for a drink. The per-100 columns above are per 100 OF THIS. */
  basis: AmountUnit;
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
  serving_amount?: number | null;
  kcal_100g?: number | null;
  protein_g_100g?: number | null;
  carbs_g_100g?: number | null;
  fat_g_100g?: number | null;
  fiber_g_100g?: number | null;
  micros?: JsonText | null;
  /** Defaults to 'user' — runtime creates are the user's own foods. */
  source?: FoodSource;
  /** Defaults to 'g'. 'ml' marks a drink (0047). */
  basis?: AmountUnit;
};

/** A catalog food + the portion it was last logged at (the recents rail). The
 * amount is in the food's own basis, which is what the item recorded. */
export type RecentFood = {
  food: FoodRow;
  lastAmount: number | null;
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
  /** The portion, in {@link MealItemRow.unit} (0047 — `grams` until a drink
   * could be one of these). */
  amount: number | null;
  serving_qty: number | null;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  /** What `amount` counts — snapshotted from the food's basis at log time, like
   * every other column here, so catalog churn can never restate a portion. */
  unit: AmountUnit;
  confidence: EstimateConfidence | null;
  /** Per-portion micronutrient snapshot (JSON), scaled from the food at log
   * time — added in 0014. NULL when the food had no micro data. */
  micros: JsonText | null;
  /** The composite this row is a PART of (0049), or NULL for a top-level row.
   * One level only — a component never has components of its own. */
  parent_item_id: string | null;
  /** 1 when this row is a composite HEADER: a name over its parts, carrying no
   * numbers of its own. Every sum over `meal_items` filters it out, and its
   * macro columns are NULL as well — two belts, because a header that carried
   * its children's sum would let a forgetful query DOUBLE the pizza. */
  is_composite: SqliteBool;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/** An item as listMealItems returns it: joined with the food's serving name
 * (NULL when the item was free-form or its catalog food was deleted). */
export type MealItemWithServing = MealItemRow & { food_serving_name: string | null };

/** The columns every supplied item carries — a top-level item, or one part of a
 * composite. Macros are already scaled to the portion
 * (src/lib/nutrition/servings.ts owns that math). */
export type NewMealItemFields = {
  food_id?: string | null;
  name: string;
  amount?: number | null;
  serving_qty?: number | null;
  kcal?: number | null;
  protein_g?: number | null;
  carbs_g?: number | null;
  fat_g?: number | null;
  fiber_g?: number | null;
  /** Defaults to 'g' — an item with no stated unit is grams, which is what
   * every item logged before 0047 was. */
  unit?: AmountUnit;
  confidence?: EstimateConfidence | null;
  /** Per-portion micronutrient snapshot as a JSON string (serializeMicros). */
  micros?: JsonText | null;
};

/** One part of a composite (0049). Deliberately NOT nestable: invariant 1 is
 *  one level only, and the type is where that is easiest to keep true. */
export type NewMealItemComponent = NewMealItemFields;

/**
 * What the app supplies per item when logging.
 *
 * With `components` present and non-empty the row becomes a COMPOSITE HEADER
 * (0049): its own macros are ignored and stored NULL, and the parts are
 * inserted beneath it. A flat list of plain items is unchanged — which is why
 * every existing caller needed no edit.
 */
export type NewMealItem = NewMealItemFields & {
  components?: NewMealItemComponent[];
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
  /** Set by logRecipe (0030) — the meal's cooked-from provenance. */
  recipe_id?: string | null;
  items: NewMealItem[];
};

// --- Meal photos (0033) -------------------------------------------------------

/** Which capture path produced a photo. Provenance only — nothing branches on
 *  it — recorded because every other logged row in this schema records where it
 *  came from. */
export type MealPhotoSource = 'camera' | 'library';

/**
 * A `meal_photos` row. `file_name` is a BASE NAME inside the app's photo
 * directory, never a path: iOS re-issues the container UUID on every install,
 * so an absolute `file://` URI stored today dangles after the next build. The
 * directory is resolved at read time (src/lib/media/meal-photo-store.ts).
 *
 * `created_at` is the retention clock — when the photo was TAKEN — deliberately
 * independent of `meals.date`, which the user can now edit.
 */
export type MealPhotoRow = {
  id: string;
  meal_id: string;
  file_name: string;
  width: number | null;
  height: number | null;
  source: MealPhotoSource;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/** What the media layer supplies when attaching a photo; the id and timestamps
 *  are filled in by the repository / DB defaults. */
export type NewMealPhoto = {
  meal_id: string;
  file_name: string;
  width?: number | null;
  height?: number | null;
  source: MealPhotoSource;
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
  amount: number | null;
  serving_qty: number | null;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  unit: AmountUnit;
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

// --- Queued AI estimates (0048) -----------------------------------------------

/**
 * Which model call is waiting. `'photo'` and `'text'` create a meal that does
 * not exist yet (a placeholder the user can see); `'revise'` corrects a meal
 * that already has items.
 */
export type PendingEstimateKind = 'photo' | 'text' | 'revise';

/**
 * A `pending_estimates` row — one AI request that could not be made because the
 * network was gone, kept until it can be (0048, backlog C3).
 *
 * `file_name` is a BASE NAME inside the pending-estimate directory, never a
 * path (0033's rule), and the directory is deliberately not `meal-photos`:
 * that one is swept against `meal_photos` rows on every app open and would
 * delete a queued file as an orphan.
 */
export type PendingEstimateRow = {
  id: string;
  meal_id: string;
  kind: PendingEstimateKind;
  /** The description, the correction, or extra context for a photo. */
  description: string | null;
  file_name: string | null;
  width: number | null;
  height: number | null;
  attempts: number;
  last_error: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/** What the estimator screens supply when a call could not be made. The meal
 *  (or its placeholder) is created by the repository in the same transaction. */
export type NewPendingEstimate = {
  kind: PendingEstimateKind;
  description?: string | null;
  file_name?: string | null;
  width?: number | null;
  height?: number | null;
};
