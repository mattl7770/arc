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
  IngredientResolvedBy,
  RecipeFolderRow,
  RecipeFolderSummary,
  RecipeIngredientRow,
  RecipeLogTarget,
  RecipeNutrition,
  RecipePortion,
  RecipeRow,
  RecipeSummary,
  ScaledRecipeLine,
  ScaledRecipeTotals,
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
 *
 * `opts.folder` is the 0035 filing filter, and its three states are the three
 * things the book can be showing — expressed the way this file already
 * expresses a tri-state (see `updateRecipe`'s `tags`):
 *   - `undefined` — every recipe, filed or not. The default view, so a recipe
 *     in no folder is never harder to reach than one in a folder.
 *   - `null` — Unfiled only (`folder_id IS NULL`).
 *   - a folder id — that drawer only.
 */
export function listRecipes(
  db: Database,
  query: string = '',
  opts: { favoriteOnly?: boolean; limit?: number; folder?: string | null } = {}
): RecipeSummary[] {
  const q = normalizeFoodName(query);
  const tokens = q === '' ? [] : q.split(' ');
  const where: string[] = tokens.map(() => `r.title_norm LIKE ? ESCAPE '\\'`);
  if (opts.favoriteOnly) where.push('r.is_favorite = 1');
  const params: (string | number)[] = tokens.map((t) => `%${escapeLike(t)}%`);
  // `!== undefined` rather than a truthiness test: null is a MEANINGFUL value
  // here (Unfiled) and only `undefined` means "don't filter".
  if (opts.folder !== undefined) {
    if (opts.folder === null) {
      where.push('r.folder_id IS NULL');
    } else {
      where.push('r.folder_id = ?');
      params.push(opts.folder);
    }
  }

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
 *
 * `by` records WHO priced it (0034). `'user'` is a hand-pick in the food
 * search; `'catalog'` is the automatic pass finding an EXACT name match at a
 * mass quantity read off the line. Same data either way — the distinction is
 * provenance, and it is the whole reason the manual Link chore could be
 * retired without the numbers losing their origin.
 */
export function resolveIngredient(
  db: Database,
  ingredientId: string,
  foodId: string,
  grams: number,
  by: IngredientResolvedBy = 'user'
): void {
  if (!(grams > 0)) throw new Error('grams must be > 0');
  if (by === 'ai')
    throw new Error('a catalog resolution is never "ai" — use resolveIngredientByModel');
  const food = getFood(db, foodId);
  if (!food) throw new Error('food not found');
  if (food.kcal_100g === null) {
    throw new Error(`"${food.name}" has no energy data — it can't resolve an ingredient`);
  }
  const macros = macrosForGrams(food as FoodMacros, grams);
  db.run(
    `UPDATE recipe_ingredients SET food_id = ?, grams = ?, kcal = ?, protein_g = ?,
       carbs_g = ?, fat_g = ?, fiber_g = ?, micros = ?, resolved_by = ?
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
      by,
      ingredientId,
    ]
  );
}

/**
 * Price a line from a MODEL's estimate rather than from the catalog (0034).
 *
 * `food_id` stays NULL — there is no catalog food behind these numbers, and
 * pointing at one would claim a provenance the line does not have. `micros`
 * stays NULL for the same reason: the model is asked for macros only, and a
 * micronutrient it was never asked for must not appear as a zero. What makes
 * this honest is `resolved_by = 'ai'`, which every surface that draws the line
 * reads and states.
 *
 * kcal is required because the schema couples it to grams; the other macros
 * are individually nullable, so a model that could not reach fiber yields no
 * fiber rather than a confident zero.
 */
export function resolveIngredientByModel(
  db: Database,
  ingredientId: string,
  priced: {
    grams: number;
    kcal: number;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    fiber_g: number | null;
  }
): void {
  if (!(priced.grams > 0)) throw new Error('grams must be > 0');
  if (!(priced.kcal >= 0)) throw new Error('kcal must be >= 0');
  db.run(
    `UPDATE recipe_ingredients SET food_id = NULL, grams = ?, kcal = ?, protein_g = ?,
       carbs_g = ?, fat_g = ?, fiber_g = ?, micros = NULL, resolved_by = 'ai'
     WHERE id = ?`,
    [
      priced.grams,
      priced.kcal,
      priced.protein_g,
      priced.carbs_g,
      priced.fat_g,
      priced.fiber_g,
      ingredientId,
    ]
  );
}

/** Clear a line's resolution (food link, every snapshot, and its provenance)
 *  atomically — the NULL-resolved_by ⇔ NULL-grams pair the schema cannot
 *  enforce is maintained here (see the 0034 header). */
export function unresolveIngredient(db: Database, id: string): void {
  db.run(
    `UPDATE recipe_ingredients SET food_id = NULL, grams = NULL, kcal = NULL,
       protein_g = NULL, carbs_g = NULL, fat_g = NULL, fiber_g = NULL, micros = NULL,
       resolved_by = NULL
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
    // How many of the counted lines a MODEL priced rather than the catalog
    // (0034). The gate says the numbers are complete; this says what they are
    // made of, and every screen that prints the figures prints this beside
    // them. Without it "complete" would quietly mean two different things.
    estimatedCount: counted.filter((l) => l.resolved_by === 'ai').length,
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
 * Every ingredient line scaled by `factor` — the ONE derivation behind both the
 * Log sheet's live preview and what {@link logRecipe} writes.
 *
 * It exists because those two were about to be two implementations of the same
 * arithmetic (the owner asked for the sheet to list the ingredients and macros
 * and to move them as the servings change, 2026-08-12). A preview computed
 * separately from the write is a promise nothing enforces: the numbers on the
 * button and the numbers in the meal would agree only for as long as nobody
 * touched either.
 *
 * Pure over rows — no database, no clock — so the sheet can call it on every
 * keystroke, and so `db/recipes.test.mjs` can drive it directly.
 */
export function scaleRecipeLines(lines: RecipeIngredientRow[], factor: number): ScaledRecipeLine[] {
  const scale = (v: number | null): number | null => (v === null ? null : v * factor);
  return lines.map((line) => {
    const base = {
      id: line.id,
      raw_text: line.raw_text,
      name: line.name ?? line.raw_text,
      food_id: line.food_id,
    };
    if (line.negligible === 1) {
      return {
        ...base,
        state: 'negligible' as const,
        grams: null,
        kcal: null,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        fiber_g: null,
        micros: null,
      };
    }
    if (!isResolved(line)) {
      return {
        ...base,
        state: 'uncounted' as const,
        grams: null,
        kcal: null,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        fiber_g: null,
        micros: null,
      };
    }
    return {
      ...base,
      state: 'counted' as const,
      grams: line.grams * factor,
      kcal: line.kcal * factor,
      protein_g: scale(line.protein_g),
      carbs_g: scale(line.carbs_g),
      fat_g: scale(line.fat_g),
      fiber_g: scale(line.fiber_g),
      micros: serializeMicros(scaleMicros(parseMicros(line.micros), factor)),
    };
  });
}

/**
 * Per-macro-honest sums over scaled lines: a macro is null the moment ANY
 * counted line lacks it, exactly as {@link recipeNutrition} does one level up.
 * A partial sum shown as a total is the failure mode this refuses.
 *
 * Note what it does NOT do: it makes no claim about the UNCOUNTED lines. A
 * total of 640 kcal over three counted lines is a true statement about those
 * three, and it is the caller's job to say beside it that two more are not in
 * it — which is what the sheet's undercount line does.
 */
export function scaledTotals(scaled: ScaledRecipeLine[]): ScaledRecipeTotals {
  const counted = scaled.filter((l) => l.state === 'counted');
  const sum = (key: 'kcal' | 'protein_g' | 'carbs_g' | 'fat_g' | 'fiber_g'): number | null => {
    if (counted.length === 0) return null;
    let total = 0;
    for (const line of counted) {
      const v = line[key];
      if (v === null) return null;
      total += v;
    }
    return total;
  };
  return {
    kcal: sum('kcal'),
    protein_g: sum('protein_g'),
    carbs_g: sum('carbs_g'),
    fat_g: sum('fat_g'),
    fiber_g: sum('fiber_g'),
  };
}

/**
 * The portion's scale factor, or null when the portion cannot be honoured
 * (grams on a recipe with no recorded cooked weight, a non-positive amount).
 *
 * {@link portionFactor} throws, which is right for a write and wrong for a live
 * preview that re-renders on every keystroke — half a typed number is not an
 * error, it is a number being typed. Same function underneath, so the sheet and
 * the write can never disagree about what a portion means.
 */
export function portionFactorOrNull(recipe: RecipeRow, portion: RecipePortion): number | null {
  try {
    return portionFactor(recipe, portion);
  } catch {
    return null;
  }
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
 *
 * The scaling itself is {@link scaleRecipeLines}, shared with the Log sheet's
 * preview — this function only decides what becomes a meal item.
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

  const items: NewMealItem[] = [];
  let uncountedCount = 0;
  for (const line of scaleRecipeLines(lines, factor)) {
    if (line.state === 'negligible') continue;
    if (line.state === 'counted') {
      items.push({
        food_id: line.food_id,
        name: line.name,
        grams: line.grams,
        kcal: line.kcal,
        protein_g: line.protein_g,
        carbs_g: line.carbs_g,
        fat_g: line.fat_g,
        fiber_g: line.fiber_g,
        micros: line.micros,
      });
    } else {
      uncountedCount += 1;
      items.push({ name: line.name });
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

// --- Applying a plain-English revision ----------------------------------------

/** What a revision did to the ingredient list, in rows. */
export type RecipeRevisionApplication = {
  /** Lines whose wording is unchanged — and which therefore KEPT their
   *  resolution, snapshots and provenance untouched. */
  kept: number;
  /** Lines that are new or reworded. They land unresolved, so the automatic
   *  passes price them and stamp their own provenance. */
  added: number;
  /** Lines the revision dropped. */
  removed: number;
};

/**
 * Write an accepted revision (app/recipe-revise.tsx) over a recipe.
 *
 * ## Matching by wording is what protects provenance
 *
 * The naive write — delete every line, insert the revised ones — would be
 * correct about the text and catastrophic about everything else: a line the
 * user resolved BY HAND ("that's the 2% milk, 240 g") would come back
 * unresolved and be re-priced by whichever automatic pass got to it first, and
 * the strongest provenance on the screen would have been destroyed by an edit
 * that never mentioned it. It would also bill a model turn to re-derive
 * numbers the database already held.
 *
 * So lines are matched by exact `raw_text`, first-come, and a matched line is
 * KEPT — the row survives with its `food_id`, its per-batch snapshots and its
 * `resolved_by`, and only its `position` moves. A line whose wording changed
 * at all is a different line: it is inserted fresh and therefore UNRESOLVED,
 * which is exactly right, because "whole milk" becoming "almond milk" must not
 * inherit the numbers that were true of the milk.
 *
 * ## What it deliberately does not touch
 *
 * Notes, tags, the photo, `total_weight_g`, prep/cook minutes, the source
 * provenance, and every meal ever cooked from this recipe. A revision changes
 * the recipe's title, its yield, its lines and its steps — the four things the
 * instruction can be about — and nothing else (the `updateMealMeta` rule:
 * editors write only the fields they own).
 *
 * ## Pricing happens after, not here
 *
 * The caller runs `catalogResolveRecipe` (src/lib/recipes/estimate.ts) over the
 * result — the deterministic, offline, free pass — before anything reaches a
 * model, exactly as `save_recipe` does. This module cannot call it itself
 * without a circular import, and that separation is fine: the pass is
 * idempotent and the detail screen runs it on every open regardless.
 *
 * Returns null when the recipe is gone; throws when the revision is not a
 * recipe (no ingredients, a non-positive yield) rather than writing a husk.
 */
export function applyRecipeRevision(
  db: Database,
  recipeId: string,
  revision: { title: string; servings: number; ingredients: string[]; steps: string[] }
): RecipeRevisionApplication | null {
  const recipe = getRecipe(db, recipeId);
  if (!recipe) return null;
  if (!(revision.servings > 0)) throw new Error('servings must be > 0');
  const title = revision.title.trim() === '' ? recipe.title : revision.title.trim();
  const lines = revision.ingredients.map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length === 0) throw new Error('a revision cannot leave a recipe with no ingredients');
  const steps = revision.steps.map((s) => s.trim()).filter((s) => s !== '');

  let kept = 0;
  let added = 0;
  let removed = 0;
  db.transaction(() => {
    db.run('UPDATE recipes SET title = ?, title_norm = ?, servings = ?, steps = ? WHERE id = ?', [
      title,
      normalizeFoodName(title),
      revision.servings,
      JSON.stringify(steps),
      recipeId,
    ]);

    const existing = listIngredients(db, recipeId);
    // raw_text → the ids that still carry it, in display order. A recipe with
    // two identical lines ("1 tbsp olive oil" twice) matches them one for one
    // rather than collapsing them, which is why this is a queue and not a set.
    //
    // **Keyed on the TRIMMED text**, and that is load-bearing rather than
    // tidiness: the stored line goes up to the model untrimmed, and every line
    // that comes back is trimmed on the way through `stringList`. A stored
    // `raw_text` with a leading space (nothing trims on insert — import and the
    // Coach both write what they were given) could therefore never match its
    // own echo, so a line NOBODY asked to change would be deleted and
    // re-inserted unresolved, destroying a hand pick and its snapshots. The
    // review reads the same rule (`survivorFlags`, src/lib/recipes/estimate.ts)
    // so what it marks `kept` is what keeps its price.
    const byText = new Map<string, string[]>();
    for (const line of existing) {
      const key = line.raw_text.trim();
      const pool = byText.get(key);
      if (pool) pool.push(line.id);
      else byText.set(key, [line.id]);
    }

    const survivors = new Set<string>();
    lines.forEach((raw, position) => {
      const id = byText.get(raw)?.shift();
      if (id !== undefined) {
        db.run('UPDATE recipe_ingredients SET position = ? WHERE id = ?', [position, id]);
        survivors.add(id);
        kept += 1;
      } else {
        insertIngredient(db, recipeId, position, { raw_text: raw });
        added += 1;
      }
    });

    for (const line of existing) {
      if (survivors.has(line.id)) continue;
      db.run('DELETE FROM recipe_ingredients WHERE id = ?', [line.id]);
      removed += 1;
    }
  });
  return { kept, added, removed };
}

// --- 0035: folders — the book's filing system ---------------------------------
//
// Owner request, 2026-08-12: *"Make functionality for creating folders in the
// recipe book."* Flat, single-membership, and `ON DELETE SET NULL` so deleting
// a folder unfiles its recipes instead of destroying them — the full reasoning
// (including why this is not a join table and not a tree) is the 0035 header.

/** Thrown when a folder name is already taken. The UNIQUE index is the actual
 *  guarantee; this is what turns its error into a sentence the user reads. */
export class DuplicateFolderError extends Error {
  constructor(name: string) {
    super(`There's already a folder called "${name}".`);
    this.name = 'DuplicateFolderError';
  }
}

/**
 * Create a folder. Throws {@link DuplicateFolderError} when the name is taken
 * (case- and whitespace-insensitively — "Dinners" and "dinners " are the same
 * drawer) and a plain Error when the name is blank.
 */
export function createFolder(db: Database, name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') throw new Error('a folder needs a name');
  const nameNorm = normalizeFoodName(trimmed);
  if (getFolderByName(db, nameNorm)) throw new DuplicateFolderError(trimmed);
  const id = newId(db);
  // The pre-check and the INSERT are two statements, so the UNIQUE index is
  // the real guarantee and this catch is what stops its raw driver text —
  // "UNIQUE constraint failed: recipe_folders.name_norm" — reaching a screen
  // that prints `error.message` verbatim. Any other failure rethrows.
  try {
    db.run('INSERT INTO recipe_folders (id, name, name_norm) VALUES (?, ?, ?)', [
      id,
      trimmed,
      nameNorm,
    ]);
  } catch (error) {
    throw isUniqueViolation(error) ? new DuplicateFolderError(trimmed) : error;
  }
  return id;
}

/** Rename a folder. Same duplicate rule as creation, except that renaming a
 *  folder to its own name (a casing fix, say) is allowed. */
export function renameFolder(db: Database, id: string, name: string): void {
  const trimmed = name.trim();
  if (trimmed === '') throw new Error('a folder needs a name');
  const nameNorm = normalizeFoodName(trimmed);
  const clash = getFolderByName(db, nameNorm);
  if (clash && clash.id !== id) throw new DuplicateFolderError(trimmed);
  try {
    db.run('UPDATE recipe_folders SET name = ?, name_norm = ? WHERE id = ?', [
      trimmed,
      nameNorm,
      id,
    ]);
  } catch (error) {
    throw isUniqueViolation(error) ? new DuplicateFolderError(trimmed) : error;
  }
}

/** Whether a driver error is the folder-name UNIQUE index firing. Matched on
 *  the message because neither op-sqlite nor node:sqlite exposes a stable
 *  error code, and both spell it "UNIQUE constraint failed". */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

/**
 * Delete a folder. Its recipes are UNFILED, never deleted — the FK is
 * ON DELETE SET NULL and that is the whole point of the column's declaration
 * (0035 header). Requires `PRAGMA foreign_keys = ON`, which every connection
 * sets (CLAUDE.md §9).
 */
export function deleteFolder(db: Database, id: string): void {
  db.run('DELETE FROM recipe_folders WHERE id = ?', [id]);
}

export function getFolder(db: Database, id: string): RecipeFolderRow | undefined {
  return db.get<RecipeFolderRow>('SELECT * FROM recipe_folders WHERE id = ?', [id]);
}

/** Look a folder up by its normalized name — the uniqueness check's read half. */
export function getFolderByName(db: Database, nameNorm: string): RecipeFolderRow | undefined {
  return db.get<RecipeFolderRow>('SELECT * FROM recipe_folders WHERE name_norm = ?', [nameNorm]);
}

/**
 * Every folder with the number of recipes filed in it, alphabetically.
 *
 * Alphabetical rather than hand-ordered: a dozen drawers sort themselves, and
 * a `position` column with no reorder control behind it is schema that lies
 * about what the app can do.
 */
export function listFolders(db: Database): RecipeFolderSummary[] {
  const rows = db.all<RecipeFolderRow & { recipe_count: number }>(
    `SELECT f.*, (SELECT count(*) FROM recipes r WHERE r.folder_id = f.id) AS recipe_count
     FROM recipe_folders f ORDER BY f.name_norm, f.id`
  );
  return rows.map(({ recipe_count, ...folder }) => ({ folder, recipeCount: recipe_count }));
}

/** How many recipes are in no folder — the "Unfiled" tally. */
export function unfiledRecipeCount(db: Database): number {
  const row = db.get<{ n: number }>('SELECT count(*) AS n FROM recipes WHERE folder_id IS NULL');
  return row?.n ?? 0;
}

/**
 * File a recipe into a folder, or (with `null`) take it out of every folder.
 *
 * Moving is the only write here: nothing about the recipe itself changes, and
 * a recipe can be moved as often as the user likes without touching an
 * ingredient, a snapshot or a cooked meal.
 */
export function moveRecipeToFolder(db: Database, recipeId: string, folderId: string | null): void {
  db.run('UPDATE recipes SET folder_id = ? WHERE id = ?', [folderId, recipeId]);
}

// --- 0034: the photo, and the AI estimate --------------------------------------

/** Point a recipe at a photo file, or detach it. The FILE side is owned by
 *  src/lib/media/recipe-photo-store.ts — never call this directly, or a name
 *  and its bytes can disagree. */
export function setRecipePhotoName(db: Database, id: string, fileName: string | null): void {
  db.run('UPDATE recipes SET photo_file_name = ? WHERE id = ?', [fileName, id]);
}

/** Every recipe that claims a photo file — the sweep's first pass. */
export function allRecipePhotoNames(db: Database): { id: string; photo_file_name: string }[] {
  return db.all<{ id: string; photo_file_name: string }>(
    'SELECT id, photo_file_name FROM recipes WHERE photo_file_name IS NOT NULL'
  );
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
