/**
 * The recipe book's data layer (0031_recipes.sql): recipes + ingredient lines,
 * explicit food resolution, the honesty-gated nutrition rollup, and cooking a
 * recipe into a real logged meal. Spec: docs/recipes-grocery.md.
 *
 * Three disciplines, load-bearing:
 *  - `raw_text` is the source of truth per line; qty/unit/name are a parsed
 *    overlay (src/lib/recipes/ingredients.ts) that never overwrites it.
 *  - Resolution is EXPLICIT (the user picks a food) and snapshots per-BATCH
 *    macros+micros onto the line at that moment — the 0018 stamp discipline,
 *    so recipe nutrition survives catalog edits and food deletion (food_id is
 *    ON DELETE SET NULL; the snapshots keep the line resolved).
 *  - logRecipe scales those SNAPSHOTS by pure multiplication — never a live
 *    catalog lookup — exactly like logMealFromTemplate copies template
 *    snapshots. A deleted or since-edited food must not change what the
 *    confirmation card promised.
 *
 * Like every repository, this depends only on the {@link Database} interface —
 * never op-sqlite — so the same code runs on device and against node:sqlite in
 * db/recipes.test.mjs.
 */
import type { Database } from '../database';
import { newId } from '../id';
import { escapeLike, getFood, normalizeFoodName } from './foods';
import { listMealItems, logMealWithItems } from './nutrition';
import { parseIngredientLine } from '@/lib/recipes/ingredients';
import { macrosForGrams, type FoodMacros } from '@/lib/nutrition/servings';
import { microsForGrams, parseMicros, scaleMicros, serializeMicros } from '@/lib/nutrition/micros';
import type { NewMealItem } from '@/lib/nutrition/types';
import type {
  NewRecipe,
  NewRecipeIngredient,
  RecipeIngredientRow,
  RecipeLogTarget,
  RecipeNutrition,
  RecipePortion,
  RecipeRow,
  RecipeSummary,
} from '@/lib/recipes/types';

/** A line is resolved ⇔ it has per-batch grams + kcal snapshots (the schema
 * couples them). Survives the catalog food's deletion by design. */
export function isResolved(
  line: Pick<RecipeIngredientRow, 'grams' | 'kcal'>
): line is RecipeIngredientRow & { grams: number; kcal: number } {
  return line.grams !== null && line.kcal !== null;
}

/** Internal: the full column set an ingredient INSERT can carry (snapshots
 * included — saveMealAsRecipe builds resolved lines directly). */
type FullIngredient = NewRecipeIngredient & {
  food_id?: string | null;
  grams?: number | null;
  kcal?: number | null;
  protein_g?: number | null;
  carbs_g?: number | null;
  fat_g?: number | null;
  fiber_g?: number | null;
  micros?: string | null;
  negligible?: boolean;
};

function insertIngredient(
  db: Database,
  recipeId: string,
  position: number,
  line: FullIngredient
): string {
  const id = newId(db);
  // The caller's overlay wins where provided; otherwise it's parsed from the
  // raw line — one consistent behavior for the manual, import, and Coach paths.
  const parsed = parseIngredientLine(line.raw_text);
  db.run(
    `INSERT INTO recipe_ingredients (id, recipe_id, position, raw_text, qty, unit, name,
       food_id, grams, kcal, protein_g, carbs_g, fat_g, fiber_g, micros, negligible)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      recipeId,
      position,
      line.raw_text,
      line.qty !== undefined ? line.qty : parsed.qty,
      line.unit !== undefined ? line.unit : parsed.unit,
      line.name !== undefined ? line.name : parsed.name,
      line.food_id ?? null,
      line.grams ?? null,
      line.kcal ?? null,
      line.protein_g ?? null,
      line.carbs_g ?? null,
      line.fat_g ?? null,
      line.fiber_g ?? null,
      line.micros ?? null,
      line.negligible ? 1 : 0,
    ]
  );
  return id;
}

/** Create a recipe and its ingredient lines in one transaction. */
export function createRecipe(db: Database, recipe: NewRecipe): string {
  const id = newId(db);
  db.transaction(() => {
    db.run(
      `INSERT INTO recipes (id, title, title_norm, source, source_url, source_platform,
         source_author, source_image_url, servings, total_weight_g, prep_min, cook_min,
         steps, tags, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        recipe.title,
        normalizeFoodName(recipe.title),
        recipe.source ?? 'user',
        recipe.source_url ?? null,
        recipe.source_platform ?? null,
        recipe.source_author ?? null,
        recipe.source_image_url ?? null,
        recipe.servings,
        recipe.total_weight_g ?? null,
        recipe.prep_min ?? null,
        recipe.cook_min ?? null,
        JSON.stringify(recipe.steps ?? []),
        recipe.tags && recipe.tags.length > 0 ? JSON.stringify(recipe.tags) : null,
        recipe.notes ?? null,
      ]
    );
    recipe.ingredients.forEach((line, i) => insertIngredient(db, id, i, line));
  });
  return id;
}

/** Edit a recipe's descriptive fields. `source*` is provenance and never
 * changes (the foods.updateFood rule); ingredients have their own functions. */
export function updateRecipe(
  db: Database,
  id: string,
  meta: {
    title: string;
    servings: number;
    total_weight_g?: number | null;
    prep_min?: number | null;
    cook_min?: number | null;
    steps?: string[];
    tags?: string[] | null;
    notes?: string | null;
  }
): void {
  // `tags` undefined = KEEP the stored value (the edit screen doesn't own
  // tags); explicit null/[] = clear. Writing null unconditionally would turn
  // every typo fix into silent tag destruction (the updateMealMeta rule:
  // editors only write the fields they own).
  const tagsValue =
    meta.tags === undefined
      ? (getRecipe(db, id)?.tags ?? null)
      : meta.tags && meta.tags.length > 0
        ? JSON.stringify(meta.tags)
        : null;
  db.run(
    `UPDATE recipes SET title = ?, title_norm = ?, servings = ?, total_weight_g = ?,
       prep_min = ?, cook_min = ?, steps = ?, tags = ?, notes = ?
     WHERE id = ?`,
    [
      meta.title,
      normalizeFoodName(meta.title),
      meta.servings,
      meta.total_weight_g ?? null,
      meta.prep_min ?? null,
      meta.cook_min ?? null,
      JSON.stringify(meta.steps ?? []),
      tagsValue,
      meta.notes ?? null,
      id,
    ]
  );
}

/** Delete a recipe; ingredients CASCADE. Meals cooked from it keep their
 * snapshots — their recipe_id goes NULL (history survives, per the ADR). */
export function deleteRecipe(db: Database, id: string): void {
  db.run('DELETE FROM recipes WHERE id = ?', [id]);
}

export function getRecipe(db: Database, id: string): RecipeRow | undefined {
  return db.get<RecipeRow>('SELECT * FROM recipes WHERE id = ?', [id]);
}

export function setRecipeFavorite(db: Database, id: string, favorite: boolean): void {
  db.run('UPDATE recipes SET is_favorite = ? WHERE id = ?', [favorite ? 1 : 0, id]);
}

/** Parse a recipe's steps JSON into a string array (tolerant — bad shapes
 * degrade to [], the DB already guarantees valid JSON). */
export function parseSteps(stepsJson: string): string[] {
  try {
    const raw: unknown = JSON.parse(stepsJson);
    if (!Array.isArray(raw)) return [];
    return raw.filter((s): s is string => typeof s === 'string');
  } catch {
    return [];
  }
}

type SummaryRow = RecipeRow & {
  ingredient_count: number;
  unresolved_count: number;
  counted_count: number;
  counted_kcal: number | null;
  times_cooked: number;
  last_cooked: string | null;
};

/**
 * The recipe book, as list rows: favorites first, then most recently cooked,
 * then newest. `query` is tokenized LIKE over title_norm (the foods.searchFoods
 * pattern — every token must match, whole-query prefix ranks first).
 * Per-serving kcal appears only when the nutrition gate passes (every line
 * resolved-or-negligible AND ≥1 counted line) — no partial numbers.
 */
export function listRecipes(
  db: Database,
  query: string = '',
  opts: { favoriteOnly?: boolean; limit?: number } = {}
): RecipeSummary[] {
  const q = normalizeFoodName(query);
  const tokens = q === '' ? [] : q.split(' ');
  const where: string[] = tokens.map(() => `r.title_norm LIKE ? ESCAPE '\\'`);
  if (opts.favoriteOnly) where.push('r.is_favorite = 1');
  const params: (string | number)[] = tokens.map((t) => `%${escapeLike(t)}%`);

  // A bare integer in ORDER BY is a column index to SQLite, so the prefix-rank
  // term is added only when there is a query to rank against.
  const prefixRank = q === '' ? '' : `(r.title_norm LIKE ? ESCAPE '\\') DESC, `;
  if (q !== '') params.push(`${escapeLike(q)}%`);

  const rows = db.all<SummaryRow>(
    `SELECT r.*,
       (SELECT count(*) FROM recipe_ingredients ri WHERE ri.recipe_id = r.id) AS ingredient_count,
       (SELECT count(*) FROM recipe_ingredients ri
         WHERE ri.recipe_id = r.id AND ri.negligible = 0 AND ri.grams IS NULL) AS unresolved_count,
       (SELECT count(*) FROM recipe_ingredients ri
         WHERE ri.recipe_id = r.id AND ri.negligible = 0 AND ri.grams IS NOT NULL) AS counted_count,
       (SELECT sum(ri.kcal) FROM recipe_ingredients ri
         WHERE ri.recipe_id = r.id AND ri.negligible = 0 AND ri.grams IS NOT NULL) AS counted_kcal,
       (SELECT count(*) FROM meals m WHERE m.recipe_id = r.id) AS times_cooked,
       (SELECT max(m.date) FROM meals m WHERE m.recipe_id = r.id) AS last_cooked
     FROM recipes r
     ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY ${prefixRank}r.is_favorite DESC, (last_cooked IS NULL), last_cooked DESC,
       r.created_at DESC, r.id
     LIMIT ?`,
    [...params, opts.limit ?? 100]
  );
  return rows.map((row) => {
    const {
      ingredient_count,
      unresolved_count,
      counted_count,
      counted_kcal,
      times_cooked,
      last_cooked,
      ...recipe
    } = row;
    const complete = unresolved_count === 0 && counted_count > 0;
    return {
      recipe,
      ingredientCount: ingredient_count,
      perServingKcal: complete && counted_kcal !== null ? counted_kcal / recipe.servings : null,
      nutritionComplete: complete,
      timesCooked: times_cooked,
      lastCooked: last_cooked,
    };
  });
}

/** A recipe's ingredient lines in display order. */
export function listIngredients(db: Database, recipeId: string): RecipeIngredientRow[] {
  return db.all<RecipeIngredientRow>(
    'SELECT * FROM recipe_ingredients WHERE recipe_id = ? ORDER BY position, created_at, id',
    [recipeId]
  );
}

/** Append one ingredient line (position after the current last). */
export function addIngredient(db: Database, recipeId: string, line: NewRecipeIngredient): string {
  const row = db.get<{ p: number | null }>(
    'SELECT max(position) AS p FROM recipe_ingredients WHERE recipe_id = ?',
    [recipeId]
  );
  return insertIngredient(db, recipeId, (row?.p ?? -1) + 1, line);
}

/**
 * Rewrite a line's raw text + overlay. The resolution snapshot is kept —
 * resolving was the user's explicit act and editing the wording doesn't undo
 * it (unresolveIngredient exists for that).
 */
export function updateIngredientLine(
  db: Database,
  id: string,
  line: { raw_text: string; qty?: number | null; unit?: string | null; name?: string | null }
): void {
  const parsed = parseIngredientLine(line.raw_text);
  db.run('UPDATE recipe_ingredients SET raw_text = ?, qty = ?, unit = ?, name = ? WHERE id = ?', [
    line.raw_text,
    line.qty !== undefined ? line.qty : parsed.qty,
    line.unit !== undefined ? line.unit : parsed.unit,
    line.name !== undefined ? line.name : parsed.name,
    id,
  ]);
}

export function removeIngredient(db: Database, id: string): void {
  db.run('DELETE FROM recipe_ingredients WHERE id = ?', [id]);
}

/** Re-number a recipe's lines to the given id order (one transaction). Ids not
 * belonging to the recipe are ignored by the WHERE. */
export function reorderIngredients(db: Database, recipeId: string, orderedIds: string[]): void {
  db.transaction(() => {
    orderedIds.forEach((id, i) => {
      db.run('UPDATE recipe_ingredients SET position = ? WHERE id = ? AND recipe_id = ?', [
        i,
        id,
        recipeId,
      ]);
    });
  });
}

/**
 * Resolve a line to a catalog food at `grams` per batch, snapshotting macros +
 * micros at this moment (the stamp). REFUSES a food with no kcal_100g — a food
 * that can't price energy can't resolve a line (the labs refusal posture);
 * the schema's grams⇔kcal coupling makes that structural.
 */
export function resolveIngredient(
  db: Database,
  ingredientId: string,
  foodId: string,
  grams: number
): void {
  if (!(grams > 0)) throw new Error('grams must be > 0');
  const food = getFood(db, foodId);
  if (!food) throw new Error('food not found');
  if (food.kcal_100g === null) {
    throw new Error(`"${food.name}" has no energy data — it can't resolve an ingredient`);
  }
  const macros = macrosForGrams(food as FoodMacros, grams);
  db.run(
    `UPDATE recipe_ingredients SET food_id = ?, grams = ?, kcal = ?, protein_g = ?,
       carbs_g = ?, fat_g = ?, fiber_g = ?, micros = ?
     WHERE id = ?`,
    [
      foodId,
      grams,
      macros.kcal ?? null,
      macros.protein_g ?? null,
      macros.carbs_g ?? null,
      macros.fat_g ?? null,
      macros.fiber_g ?? null,
      serializeMicros(microsForGrams(food.micros, grams)),
      ingredientId,
    ]
  );
}

/** Clear a line's resolution (food link + every snapshot) atomically. */
export function unresolveIngredient(db: Database, id: string): void {
  db.run(
    `UPDATE recipe_ingredients SET food_id = NULL, grams = NULL, kcal = NULL,
       protein_g = NULL, carbs_g = NULL, fat_g = NULL, fiber_g = NULL, micros = NULL
     WHERE id = ?`,
    [id]
  );
}

/** Mark a line as counting-as-zero on purpose (water, "salt to taste"). */
export function setIngredientNegligible(db: Database, id: string, negligible: boolean): void {
  db.run('UPDATE recipe_ingredients SET negligible = ? WHERE id = ?', [negligible ? 1 : 0, id]);
}

/**
 * Per-serving nutrition under the honesty gate (docs/recipes-grocery.md §2a):
 * complete ⇔ zero unresolved non-negligible lines AND ≥1 counted line (no
 * vacuous completeness). kcal is guaranteed on counted lines by the resolved
 * predicate; the other macros are per-macro honest — null when ANY counted
 * line's snapshot lacks that macro, never a partial sum shown as the total.
 * When the gate fails, every perServing value is null.
 */
export function recipeNutrition(db: Database, recipeId: string): RecipeNutrition {
  const recipe = getRecipe(db, recipeId);
  const lines = listIngredients(db, recipeId);
  const counted = lines.filter((l) => l.negligible === 0 && isResolved(l));
  const unresolvedCount = lines.filter((l) => l.negligible === 0 && !isResolved(l)).length;
  const complete = recipe !== undefined && unresolvedCount === 0 && counted.length > 0;

  const per = (key: 'kcal' | 'protein_g' | 'carbs_g' | 'fat_g' | 'fiber_g'): number | null => {
    if (!complete) return null;
    let sum = 0;
    for (const line of counted) {
      const v = line[key];
      if (v === null) return null; // per-macro honesty: one unknown → "—"
      sum += v;
    }
    return sum / recipe!.servings;
  };

  return {
    complete,
    unresolvedCount,
    countedCount: counted.length,
    perServing: {
      kcal: per('kcal'),
      protein_g: per('protein_g'),
      carbs_g: per('carbs_g'),
      fat_g: per('fat_g'),
      fiber_g: per('fiber_g'),
    },
  };
}

/** The scale factor for a portion of `recipe`, with the §4 validation rules:
 * servings XOR grams; grams requires a recorded total cooked weight. */
export function portionFactor(recipe: RecipeRow, portion: RecipePortion): number {
  if ('servings' in portion && 'grams' in portion) {
    throw new Error('log by servings OR grams, not both');
  }
  if ('grams' in portion) {
    if (recipe.total_weight_g === null) {
      throw new Error('this recipe has no cooked weight — log by servings');
    }
    if (!(portion.grams > 0)) throw new Error('grams must be > 0');
    return portion.grams / recipe.total_weight_g;
  }
  if (!(portion.servings > 0)) throw new Error('servings must be > 0');
  return portion.servings / recipe.servings;
}

/**
 * Cook a recipe into a real logged meal — the "explode": each counted line
 * becomes a meal_item with its per-batch SNAPSHOT scaled by pure
 * multiplication (never a catalog read); unresolved non-negligible lines
 * become name-only items with NULL macros (the disclosure rule: a partially
 * resolved recipe logs a KNOWN UNDERCOUNT the UI/card must surface, §2a);
 * negligible lines are skipped (they count as zero by declaration — listing
 * "salt to taste" as an uncounted meal item would false-flag the meal as
 * undercounted). The meal carries recipe_id and keeps source='manual'.
 * Returns null when the recipe is gone or has no ingredient lines.
 */
export function logRecipe(
  db: Database,
  recipeId: string,
  portion: RecipePortion,
  target: RecipeLogTarget
): { mealId: string; uncountedCount: number } | null {
  const recipe = getRecipe(db, recipeId);
  if (!recipe) return null;
  const lines = listIngredients(db, recipeId);
  const factor = portionFactor(recipe, portion);

  const scale = (v: number | null): number | null => (v === null ? null : v * factor);
  const items: NewMealItem[] = [];
  let uncountedCount = 0;
  for (const line of lines) {
    if (line.negligible === 1) continue;
    if (isResolved(line)) {
      items.push({
        food_id: line.food_id,
        name: line.name ?? line.raw_text,
        grams: line.grams * factor,
        kcal: line.kcal * factor,
        protein_g: scale(line.protein_g),
        carbs_g: scale(line.carbs_g),
        fat_g: scale(line.fat_g),
        fiber_g: scale(line.fiber_g),
        micros: serializeMicros(scaleMicros(parseMicros(line.micros), factor)),
      });
    } else {
      uncountedCount += 1;
      items.push({ name: line.name ?? line.raw_text });
    }
  }
  if (items.length === 0) return null;

  const { mealId } = logMealWithItems(db, {
    date: target.date,
    time: target.time,
    name: recipe.title,
    recipe_id: recipeId,
    items,
  });
  return { mealId, uncountedCount };
}

/**
 * Capture a logged meal as a recipe (the MacroFactor assemble-from-timeline
 * pattern). Items with usable grams+kcal snapshots arrive as RESOLVED lines
 * (their snapshots copy across — the whole meal is one batch of `servings`
 * servings); items without land as honest unresolved raw lines. Returns the
 * new recipe id, or null when the meal is gone or has no items.
 */
export function saveMealAsRecipe(
  db: Database,
  mealId: string,
  title: string,
  servings: number
): string | null {
  const items = listMealItems(db, mealId);
  if (items.length === 0) return null;
  if (!(servings > 0)) throw new Error('servings must be > 0');
  const id = newId(db);
  db.transaction(() => {
    db.run(
      `INSERT INTO recipes (id, title, title_norm, source, servings, steps)
       VALUES (?, ?, ?, 'user', ?, '[]')`,
      [id, title, normalizeFoodName(title), servings]
    );
    items.forEach((item, i) => {
      const resolved = item.grams !== null && item.grams > 0 && item.kcal !== null;
      insertIngredient(db, id, i, {
        raw_text: item.grams !== null ? `${Math.round(item.grams)} g ${item.name}` : item.name,
        qty: item.grams,
        unit: item.grams !== null ? 'g' : null,
        name: item.name,
        food_id: resolved ? item.food_id : null,
        grams: resolved ? item.grams : null,
        kcal: resolved ? item.kcal : null,
        protein_g: resolved ? item.protein_g : null,
        carbs_g: resolved ? item.carbs_g : null,
        fat_g: resolved ? item.fat_g : null,
        fiber_g: resolved ? item.fiber_g : null,
        micros: resolved ? item.micros : null,
      });
    });
  });
  return id;
}

/** Book size — the Nutrition hub's "N recipes" line. */
export function recipeCount(db: Database): number {
  const row = db.get<{ n: number }>('SELECT count(*) AS n FROM recipes');
  return row?.n ?? 0;
}

/**
 * How many meals since `sinceDate` were cooked from the book — the Eat tab's
 * "N cooked this month". Derived from `meals.recipe_id` (indexed by 0031), so
 * it stays true when a recipe is renamed and survives a recipe being deleted
 * (the FK is ON DELETE SET NULL, which correctly drops the meal out of this
 * count without touching the meal itself).
 */
export function recipesCookedSince(db: Database, sinceDate: string): number {
  const row = db.get<{ n: number }>(
    'SELECT count(*) AS n FROM meals WHERE recipe_id IS NOT NULL AND date >= ?',
    [sinceDate]
  );
  return row?.n ?? 0;
}

/** Derived cook stats — meals are the record; nothing here is a counter. */
export function recipeCookStats(
  db: Database,
  recipeId: string
): { timesCooked: number; lastCooked: string | null } {
  const row = db.get<{ n: number; last: string | null }>(
    'SELECT count(*) AS n, max(date) AS last FROM meals WHERE recipe_id = ?',
    [recipeId]
  );
  return { timesCooked: row?.n ?? 0, lastCooked: row?.last ?? null };
}
