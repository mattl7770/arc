/**
 * Headless test of the recipe book — recipes + recipe_ingredients (0030), the
 * ingredient-line parser, explicit resolution snapshots, the honesty-gated
 * nutrition rollup, logRecipe's snapshot-only scaling, and saveMealAsRecipe —
 * against real SQLite via node:sqlite. Mirrors db/foods.test.mjs; op-sqlite is
 * never loaded. Spec: docs/recipes-grocery.md. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { createFood, deleteFood } from '../src/lib/db/repositories/foods.ts';
import {
  getMeal,
  listMealItems,
  logMealWithItems,
  partialMealMetrics,
  relogMeal,
} from '../src/lib/db/repositories/nutrition.ts';
import {
  addIngredient,
  applyRecipeRevision,
  createFolder,
  createRecipe,
  deleteFolder,
  deleteRecipe,
  getFolder,
  getRecipe,
  isResolved,
  listFolders,
  listIngredients,
  listRecipes,
  logRecipe,
  moveRecipeToFolder,
  parseSteps,
  portionFactor,
  portionFactorOrNull,
  recipeCookStats,
  recipeCount,
  recipeNutrition,
  recipesCookedSince,
  removeIngredient,
  renameFolder,
  reorderIngredients,
  resolveIngredient,
  resolveIngredientByModel,
  saveMealAsRecipe,
  scaledTotals,
  scaleRecipeLines,
  setIngredientNegligible,
  setRecipeFavorite,
  unfiledRecipeCount,
  unresolveIngredient,
  updateIngredientLine,
  updateRecipe,
} from '../src/lib/db/repositories/recipes.ts';
import {
  buildRecipePricingRequest,
  buildRecipeRevisionRequest,
  catalogResolveRecipe,
  diffRecipeLines,
  droppedRecipeLines,
  isConfidentFoodMatch,
  lineGrams,
  parseRecipePricing,
  parseRecipeRevision,
} from '../src/lib/recipes/estimate.ts';
import {
  formatQty,
  normalizeUnit,
  parseIngredientLine,
  scaleIngredientLine,
} from '../src/lib/recipes/ingredients.ts';

let pass = 0;
let fail = 0;
const ok = (n) => {
  pass++;
  console.log(`  ok   ${n}`);
};
const bad = (n, e) => {
  fail++;
  console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`);
};
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-6;
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

function makeDb(raw) {
  return {
    run: (sql, params = []) => {
      raw.prepare(sql).run(...params);
    },
    all: (sql, params = []) => raw.prepare(sql).all(...params),
    get: (sql, params = []) => raw.prepare(sql).get(...params),
    transaction: (fn) => {
      raw.exec('BEGIN');
      try {
        fn();
        raw.exec('COMMIT');
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

function freshDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const db = makeDb(raw);
  migrate(
    {
      exec: (sql) => raw.exec(sql),
      getUserVersion: () => raw.prepare('PRAGMA user_version').get().user_version,
      setUserVersion: (n) => raw.exec(`PRAGMA user_version = ${n}`),
      transaction: db.transaction,
    },
    MIGRATIONS
  );
  return { raw, db };
}

/** A deterministic catalog food (never the seed — tests own their fixtures). */
function fixtureFood(db, overrides = {}) {
  return createFood(db, {
    name: 'Test chicken breast',
    kcal_100g: 165,
    protein_g_100g: 31,
    carbs_g_100g: 0,
    fat_g_100g: 3.6,
    fiber_g_100g: 0,
    micros: JSON.stringify({ potassium_mg: 256 }),
    ...overrides,
  });
}

{
  console.log('0. Migrations applied (0030 present)');
  const { raw } = freshDb();
  const version = raw.prepare('PRAGMA user_version').get().user_version;
  // The floor convention: >= 30 so this stays correct as later migrations land.
  if (version >= 30) ok(`user_version ${version} >= 30`);
  else bad('user_version >= 30', String(version));
  const tables = raw
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('recipes', 'recipe_ingredients')`
    )
    .all();
  if (tables.length === 2) ok('recipes + recipe_ingredients exist');
  else bad('recipes tables exist', JSON.stringify(tables));
  const cols = raw
    .prepare(`SELECT name FROM pragma_table_info('meals') WHERE name = 'recipe_id'`)
    .all();
  if (cols.length === 1) ok('meals.recipe_id added');
  else bad('meals.recipe_id added');
}

{
  console.log('1. parseIngredientLine — the overlay table');
  const cases = [
    ['2 cups flour', { qty: 2, unit: 'cup', name: 'flour' }],
    ['1/2 tsp salt', { qty: 0.5, unit: 'tsp', name: 'salt' }],
    ['1 1/2 cups rolled oats', { qty: 1.5, unit: 'cup', name: 'rolled oats' }],
    ['½ cup milk', { qty: 0.5, unit: 'cup', name: 'milk' }],
    ['1½ cups broth', { qty: 1.5, unit: 'cup', name: 'broth' }],
    ['100g chicken thighs', { qty: 100, unit: 'g', name: 'chicken thighs' }],
    ['2-3 cloves garlic, minced', { qty: 2, unit: 'clove', name: 'garlic, minced' }],
    ['2 cups of flour', { qty: 2, unit: 'cup', name: 'flour' }],
    ['- 2 tbsp olive oil', { qty: 2, unit: 'tbsp', name: 'olive oil' }],
    ['• 1 lemon', { qty: 1, unit: null, name: 'lemon' }],
    ['2 large eggs', { qty: 2, unit: null, name: 'large eggs' }],
    ['1 cup (120g) flour', { qty: 1, unit: 'cup', name: 'flour' }],
    ['salt to taste', { qty: null, unit: null, name: 'salt to taste' }],
    ['1.5 l water', { qty: 1.5, unit: 'l', name: 'water' }],
  ];
  for (const [raw_text, want] of cases) {
    const got = parseIngredientLine(raw_text);
    if (near(got.qty ?? NaN, want.qty ?? NaN) || got.qty === want.qty) {
      if (got.unit === want.unit && got.name === want.name) {
        ok(`"${raw_text}"`);
        continue;
      }
    }
    bad(`"${raw_text}"`, JSON.stringify(got));
  }
  const empty = parseIngredientLine('   ');
  if (empty.qty === null && empty.name === null) ok('blank line → all-null overlay');
  else bad('blank line', JSON.stringify(empty));
  if (normalizeUnit('Tablespoons') === 'tbsp' && normalizeUnit('carrots') === null) {
    ok('normalizeUnit canonicalizes known, rejects unknown');
  } else bad('normalizeUnit');
}

{
  console.log('2. formatQty + scaleIngredientLine');
  const cases = [
    [2, '2'],
    [1.5, '1½'],
    [0.25, '¼'],
    [1 / 3, '⅓'],
    [0.75, '¾'],
    [2.5, '2½'],
    [0.4, '0.4'],
    [1.33, '1⅓'],
  ];
  for (const [qty, want] of cases) {
    const got = formatQty(qty);
    if (got === want) ok(`formatQty(${qty}) = ${want}`);
    else bad(`formatQty(${qty})`, got);
  }
  const line = { raw_text: '2 cups flour', qty: 2, unit: 'cup', name: 'flour' };
  if (scaleIngredientLine(line, 0.75) === '1½ cup flour') ok('scaled line renders fractions');
  else bad('scaled line', scaleIngredientLine(line, 0.75));
  const prose = {
    raw_text: 'a splash of vinegar',
    qty: null,
    unit: null,
    name: 'a splash of vinegar',
  };
  if (scaleIngredientLine(prose, 2) === 'a splash of vinegar') {
    ok('unparsed line scales to its raw text (Paprika constraint)');
  } else bad('raw fallback');
}

{
  console.log('3. createRecipe + schema CHECKs');
  const { raw, db } = freshDb();
  const id = createRecipe(db, {
    title: 'Chicken Adobo',
    source: 'import',
    source_url: 'https://www.instagram.com/reel/TEST/',
    source_platform: 'instagram',
    source_author: 'testchef',
    servings: 4,
    prep_min: 10,
    cook_min: 45,
    steps: ['Brown the chicken.', 'Simmer in the sauce.'],
    tags: ['dinner'],
    ingredients: [
      { raw_text: '1 kg chicken thighs' },
      { raw_text: '1/2 cup soy sauce' },
      { raw_text: 'salt to taste' },
    ],
  });
  const recipe = getRecipe(db, id);
  if (recipe && recipe.title_norm === 'chicken adobo' && recipe.source === 'import') {
    ok('recipe row lands with derived title_norm');
  } else bad('recipe row', JSON.stringify(recipe));
  if (parseSteps(recipe.steps).length === 2) ok('steps round-trip as JSON array');
  else bad('steps', recipe.steps);
  const lines = listIngredients(db, id);
  if (lines.length === 3 && lines[0].qty === 1 && lines[0].unit === 'kg') {
    ok('ingredient overlay auto-parsed from raw lines');
  } else bad('overlay parse', JSON.stringify(lines[0]));
  if (lines.map((l) => l.position).join(',') === '0,1,2') ok('positions sequential');
  else bad('positions', lines.map((l) => l.position).join(','));

  if (throws(() => createRecipe(db, { title: 'x', servings: 0, ingredients: [] }))) {
    ok('servings = 0 rejected (CHECK)');
  } else bad('servings CHECK');
  const before = raw.prepare('SELECT count(*) AS n FROM recipes').get().n;
  if (
    throws(() =>
      createRecipe(db, {
        title: 'bad platform',
        servings: 1,
        source_platform: 'facebook',
        ingredients: [],
      })
    ) &&
    raw.prepare('SELECT count(*) AS n FROM recipes').get().n === before
  ) {
    ok('unknown platform rejected, nothing half-saved (transaction rollback)');
  } else bad('platform CHECK rollback');
  if (
    throws(() =>
      raw
        .prepare(
          `INSERT INTO recipe_ingredients (id, recipe_id, position, raw_text, grams) VALUES ('t-null-kcal', ?, 9, 'x', 100)`
        )
        .run(id)
    )
  ) {
    ok('grams without kcal snapshot rejected (coupling CHECK)');
  } else bad('coupling CHECK');
}

{
  console.log('4. Resolution — explicit, snapshotting, refusal, SET NULL survival');
  const { db } = freshDb();
  const foodId = fixtureFood(db);
  const recipeId = createRecipe(db, {
    title: 'Grilled chicken',
    servings: 2,
    ingredients: [{ raw_text: '500 g chicken breast' }, { raw_text: 'pepper to taste' }],
  });
  const [line, pepper] = listIngredients(db, recipeId);

  resolveIngredient(db, line.id, foodId, 500);
  let resolved = listIngredients(db, recipeId)[0];
  if (isResolved(resolved) && near(resolved.kcal, 825) && near(resolved.protein_g, 155)) {
    ok('resolution snapshots per-batch macros (500 g × per-100g)');
  } else bad('resolution snapshot', JSON.stringify(resolved));
  if (JSON.parse(resolved.micros).potassium_mg === 1280) ok('micros snapshot scaled');
  else bad('micros snapshot', resolved.micros);

  // Catalog edits must not rewrite the snapshot (stamp, not link).
  db.run('UPDATE foods SET kcal_100g = 900 WHERE id = ?', [foodId]);
  resolved = listIngredients(db, recipeId)[0];
  if (near(resolved.kcal, 825)) ok('catalog edit does not rewrite the snapshot');
  else bad('snapshot immune to catalog edit', String(resolved.kcal));

  // Deleting the food SET NULLs the link but the line STAYS resolved.
  deleteFood(db, foodId);
  resolved = listIngredients(db, recipeId)[0];
  if (resolved.food_id === null && isResolved(resolved)) {
    ok('food deletion keeps the line resolved (snapshots survive)');
  } else bad('SET NULL survival', JSON.stringify(resolved));

  unresolveIngredient(db, resolved.id);
  const cleared = listIngredients(db, recipeId)[0];
  if (!isResolved(cleared) && cleared.kcal === null && cleared.micros === null) {
    ok('unresolve clears every snapshot atomically');
  } else bad('unresolve', JSON.stringify(cleared));

  const kcalless = createFood(db, { name: 'Mystery herb', protein_g_100g: 2 });
  if (throws(() => resolveIngredient(db, pepper.id, kcalless, 10))) {
    ok('a food with no kcal_100g refuses to resolve (labs posture)');
  } else bad('kcal-less refusal');
  if (throws(() => resolveIngredient(db, pepper.id, 'nope', 10))) ok('missing food throws');
  else bad('missing food');
}

{
  console.log('5. recipeNutrition — the honesty gate');
  const { db } = freshDb();
  const chicken = fixtureFood(db);
  const rice = createFood(db, {
    name: 'Test rice',
    kcal_100g: 130,
    protein_g_100g: 2.7,
    carbs_g_100g: 28,
    fat_g_100g: 0.3,
    // fiber deliberately absent — the per-macro honesty case.
  });
  const recipeId = createRecipe(db, {
    title: 'Chicken and rice',
    servings: 2,
    ingredients: [{ raw_text: '300 g chicken' }, { raw_text: '200 g rice' }, { raw_text: 'water' }],
  });
  const [l1, l2, l3] = listIngredients(db, recipeId);

  let n = recipeNutrition(db, recipeId);
  if (!n.complete && n.unresolvedCount === 3 && n.perServing.kcal === null) {
    ok('nothing resolved → gate closed, all values null');
  } else bad('gate closed', JSON.stringify(n));

  resolveIngredient(db, l1.id, chicken, 300);
  resolveIngredient(db, l2.id, rice, 200);
  n = recipeNutrition(db, recipeId);
  if (!n.complete && n.unresolvedCount === 1) {
    ok('one unresolved line still closes the gate (no partial totals)');
  } else bad('partial gate', JSON.stringify(n));

  setIngredientNegligible(db, l3.id, true);
  n = recipeNutrition(db, recipeId);
  // chicken 300g: 495 kcal; rice 200g: 260 kcal → 755 / 2 servings = 377.5
  if (n.complete && near(n.perServing.kcal, 377.5) && near(n.perServing.protein_g, 49.2)) {
    ok('negligible water opens the gate; per-serving sums correct');
  } else bad('per-serving', JSON.stringify(n));
  if (n.perServing.fiber_g === null) {
    ok('per-macro honesty: rice lacks fiber → fiber is null, not a partial sum');
  } else bad('per-macro honesty', String(n.perServing.fiber_g));

  // Vacuous completeness: all lines negligible → NOT complete.
  const vacId = createRecipe(db, {
    title: 'Water and salt',
    servings: 1,
    ingredients: [{ raw_text: 'water' }, { raw_text: 'salt' }],
  });
  for (const l of listIngredients(db, vacId)) setIngredientNegligible(db, l.id, true);
  const vac = recipeNutrition(db, vacId);
  if (!vac.complete && vac.countedCount === 0) ok('all-negligible recipe is not "complete"');
  else bad('vacuous completeness', JSON.stringify(vac));
}

{
  console.log('6. logRecipe — snapshot-only scaling, disclosure, provenance');
  const { db } = freshDb();
  const chicken = fixtureFood(db);
  const recipeId = createRecipe(db, {
    title: 'Meal-prep chicken',
    servings: 4,
    total_weight_g: 1000,
    ingredients: [
      { raw_text: '800 g chicken breast' },
      { raw_text: '2 tbsp mystery marinade' },
      { raw_text: 'salt to taste' },
    ],
  });
  const [l1, , l3] = listIngredients(db, recipeId);
  resolveIngredient(db, l1.id, chicken, 800);
  setIngredientNegligible(db, l3.id, true);

  // Delete the catalog food FIRST — logging must not need it (snapshot-only).
  deleteFood(db, chicken);

  const result = logRecipe(db, recipeId, { servings: 1 }, { date: '2026-08-08', time: '18:30' });
  if (result && result.uncountedCount === 1) ok('partial resolution reported (1 uncounted)');
  else bad('uncountedCount', JSON.stringify(result));
  const meal = getMeal(db, result.mealId);
  // 800 g × 1.65 kcal/g = 1320 per batch; 1 of 4 servings = 330.
  if (meal && near(meal.kcal, 330) && meal.recipe_id === recipeId && meal.source === 'manual') {
    ok('meal scaled from snapshots (no catalog needed), recipe_id stamped, source manual');
  } else bad('logged meal', JSON.stringify(meal));
  const items = listMealItems(db, result.mealId);
  if (items.length === 2) ok('negligible line skipped; counted + uncounted stamped');
  else bad('item count', String(items.length));
  const uncounted = items.find((i) => i.kcal === null);
  if (uncounted && uncounted.name === 'mystery marinade' && uncounted.grams === null) {
    ok('unresolved line lands as a name-only NULL-macro item');
  } else bad('uncounted item', JSON.stringify(uncounted));

  // …and the Eat tab must be able to SEE that undercount. The meal's own kcal
  // column is a non-null sum over the priced half, so nothing about the row
  // says 'short' — partialMealMetrics is what tells the countdown to refuse it.
  const partial = partialMealMetrics(db, '2026-08-08');
  if (partial[result.mealId] && partial[result.mealId].kcal === true) {
    ok('partialMealMetrics flags the cooked meal as knowingly short on kcal');
  } else bad('partial flag', JSON.stringify(partial));
  if (meal && meal.kcal !== null) {
    ok('even though the meal row itself carries a perfectly non-null total');
  } else bad('meal total unexpectedly null');

  // Grams mode against total cooked weight.
  const byGrams = logRecipe(db, recipeId, { grams: 250 }, { date: '2026-08-08', time: null });
  const gramsMeal = getMeal(db, byGrams.mealId);
  if (near(gramsMeal.kcal, 330)) ok('grams mode: 250 g of a 1000 g batch = a quarter');
  else bad('grams mode', String(gramsMeal.kcal));

  const recipe = getRecipe(db, recipeId);
  if (throws(() => portionFactor({ ...recipe, total_weight_g: null }, { grams: 100 }))) {
    ok('grams without total_weight_g refused with a corrective error');
  } else bad('grams refusal');
  if (throws(() => portionFactor(recipe, { servings: 1, grams: 100 }))) {
    ok('servings AND grams refused');
  } else bad('XOR');
  if (throws(() => portionFactor(recipe, { servings: 0 }))) ok('servings = 0 refused');
  else bad('zero servings');

  const stats = recipeCookStats(db, recipeId);
  if (stats.timesCooked === 2 && stats.lastCooked === '2026-08-08') {
    ok('cook stats derive from meals');
  } else bad('cook stats', JSON.stringify(stats));

  // relogMeal carries the recipe provenance.
  const again = relogMeal(db, result.mealId, '2026-08-09', null);
  if (getMeal(db, again).recipe_id === recipeId) ok('relogMeal carries recipe_id');
  else bad('relog provenance');

  // Deleting the recipe: meals keep snapshots, recipe_id goes NULL.
  deleteRecipe(db, recipeId);
  const orphan = getMeal(db, result.mealId);
  if (orphan && orphan.recipe_id === null && near(orphan.kcal, 330)) {
    ok('recipe deletion never touches eating history (SET NULL)');
  } else bad('history survival', JSON.stringify(orphan));
  if (listIngredients(db, recipeId).length === 0) ok('ingredients CASCADE with the recipe');
  else bad('ingredient cascade');
  if (logRecipe(db, recipeId, { servings: 1 }, { date: '2026-08-10', time: null }) === null) {
    ok('logRecipe of a deleted recipe returns null');
  } else bad('deleted recipe log');
}

{
  console.log('7. saveMealAsRecipe — retroactive assembly');
  const { db } = freshDb();
  const foodId = fixtureFood(db);
  const { mealId } = logMealWithItems(db, {
    date: '2026-08-08',
    time: '12:00',
    name: 'Lunch bowl',
    items: [
      { food_id: foodId, name: 'Test chicken breast', grams: 150, kcal: 247.5, protein_g: 46.5 },
      { name: 'splash of dressing' }, // no grams/kcal — must land unresolved
    ],
  });
  const recipeId = saveMealAsRecipe(db, mealId, 'Lunch bowl (recipe)', 1);
  const lines = listIngredients(db, recipeId);
  const resolved = lines.filter((l) => isResolved(l));
  if (lines.length === 2 && resolved.length === 1 && resolved[0].food_id === foodId) {
    ok('grams+kcal items arrive resolved; the rest honest-unresolved');
  } else bad('assembly', JSON.stringify(lines));
  // Insertion order survives the round trip: a same-millisecond batch must not
  // tie-break on random UUIDs (bug-hunt 2026-08-08; rowid ordering).
  if (lines[0].name === 'Test chicken breast' && lines[1].name === 'splash of dressing') {
    ok('meal→recipe keeps the items in insertion order');
  } else bad('order preservation', JSON.stringify(lines.map((l) => l.name)));
  if (near(resolved[0].kcal, 247.5)) ok('snapshots copy across verbatim');
  else bad('snapshot copy', String(resolved[0].kcal));
  if (saveMealAsRecipe(db, 'missing', 'x', 1) === null) ok('missing meal → null');
  else bad('missing meal');
  if (throws(() => saveMealAsRecipe(db, mealId, 'x', 0))) ok('servings = 0 refused');
  else bad('servings validation');
}

{
  console.log('8. listRecipes — search, ranking, honest headline');
  const { db } = freshDb();
  const chicken = fixtureFood(db);
  const completeId = createRecipe(db, {
    title: 'Complete chicken',
    servings: 2,
    ingredients: [{ raw_text: '400 g chicken' }],
  });
  resolveIngredient(db, listIngredients(db, completeId)[0].id, chicken, 400);
  createRecipe(db, {
    title: 'Chicken mystery',
    servings: 2,
    ingredients: [{ raw_text: 'some chicken' }],
  });
  const favId = createRecipe(db, { title: 'Avocado toast', servings: 1, ingredients: [] });
  setRecipeFavorite(db, favId, true);

  const all = listRecipes(db);
  if (all.length === 3 && all[0].recipe.id === favId) ok('favorites rank first');
  else bad('favorite ranking', all.map((r) => r.recipe.title).join(' | '));
  const complete = all.find((r) => r.recipe.id === completeId);
  if (complete.nutritionComplete && near(complete.perServingKcal, 330)) {
    ok('per-serving kcal only via the gate (660 / 2)');
  } else bad('headline kcal', JSON.stringify(complete));
  const incomplete = all.find((r) => r.recipe.title === 'Chicken mystery');
  if (!incomplete.nutritionComplete && incomplete.perServingKcal === null) {
    ok('incomplete recipe shows no number');
  } else bad('incomplete headline');
  const search = listRecipes(db, 'chicken');
  if (search.length === 2) ok('tokenized search over title_norm');
  else bad('search', String(search.length));
  if (listRecipes(db, '', { favoriteOnly: true }).length === 1) ok('favoriteOnly filter');
  else bad('favoriteOnly');
}

{
  console.log('9. Editing — lines, reorder, meta, triggers');
  const { raw, db } = freshDb();
  const recipeId = createRecipe(db, {
    title: 'Editable',
    servings: 2,
    ingredients: [{ raw_text: '1 cup oats' }, { raw_text: '2 tbsp honey' }],
  });
  const [a, b] = listIngredients(db, recipeId);

  updateIngredientLine(db, a.id, { raw_text: '2 cups oats' });
  const edited = listIngredients(db, recipeId).find((l) => l.id === a.id);
  if (edited.qty === 2 && edited.unit === 'cup') ok('editing raw re-parses the overlay');
  else bad('re-parse', JSON.stringify(edited));

  reorderIngredients(db, recipeId, [b.id, a.id]);
  const order = listIngredients(db, recipeId).map((l) => l.id);
  if (order[0] === b.id && order[1] === a.id) ok('reorder renumbers positions');
  else bad('reorder');

  const c = addIngredient(db, recipeId, { raw_text: '1 pinch cinnamon' });
  if (listIngredients(db, recipeId)[2].id === c) ok('addIngredient appends after the last');
  else bad('append position');
  removeIngredient(db, c);
  if (listIngredients(db, recipeId).length === 2) ok('removeIngredient');
  else bad('remove');

  updateRecipe(db, recipeId, { title: 'Edited title', servings: 3, steps: ['Mix.'] });
  const recipe = getRecipe(db, recipeId);
  if (recipe.title_norm === 'edited title' && recipe.servings === 3)
    ok('updateRecipe rewrites meta');
  else bad('updateRecipe', JSON.stringify(recipe));

  // Tags survive a meta edit that doesn't mention them (bug-hunt 2026-08-08:
  // undefined = keep; explicit null/[] = clear).
  db.run(`UPDATE recipes SET tags = '["dinner"]' WHERE id = ?`, [recipeId]);
  updateRecipe(db, recipeId, { title: 'Edited title', servings: 3 });
  if (getRecipe(db, recipeId).tags === '["dinner"]') ok('meta edit without tags keeps tags');
  else bad('tags preserved', String(getRecipe(db, recipeId).tags));
  updateRecipe(db, recipeId, { title: 'Edited title', servings: 3, tags: null });
  if (getRecipe(db, recipeId).tags === null) ok('explicit tags: null clears them');
  else bad('tags cleared');

  const before = raw
    .prepare('SELECT updated_at FROM recipes WHERE id = ?')
    .get(recipeId).updated_at;
  raw.prepare(`UPDATE recipes SET notes = 'x' WHERE id = ?`).run(recipeId);
  const after = raw.prepare('SELECT updated_at FROM recipes WHERE id = ?').get(recipeId).updated_at;
  if (after >= before) ok('recipes updated_at trigger stamps');
  else bad('trigger');
}

console.log("20. the Eat tab's Kitchen counts");
{
  const { db } = freshDb();
  recipeCount(db) === 0 ? ok('an empty book counts 0') : bad('empty book');

  const first = createRecipe(db, {
    title: 'Salmon bowl',
    servings: 2,
    ingredients: [{ raw_text: '200 g salmon' }],
  });
  createRecipe(db, {
    title: 'Chili',
    servings: 4,
    ingredients: [{ raw_text: '500 g beef' }],
  });
  recipeCount(db) === 2
    ? ok('two recipes in the book')
    : bad('book count', String(recipeCount(db)));

  // A fixed window, so the assertion never depends on today's date.
  const WINDOW_START = '2026-07-15';
  recipesCookedSince(db, WINDOW_START) === 0 ? ok('nothing cooked yet') : bad('cooked baseline');

  logRecipe(db, first, { servings: 1 }, { date: '2026-08-08', time: '18:30' });
  recipesCookedSince(db, WINDOW_START) === 1
    ? ok('cooking one logs a meal the window count sees')
    : bad('cooked count', String(recipesCookedSince(db, WINDOW_START)));

  recipesCookedSince(db, '2026-08-09') === 0
    ? ok('and a window that starts after the meal excludes it')
    : bad('window boundary');

  // Derived from meals.recipe_id, never a counter column: deleting the recipe
  // SET-NULLs the link, so the meal survives and drops out of the count.
  deleteRecipe(db, first);
  recipesCookedSince(db, WINDOW_START) === 0
    ? ok('deleting the recipe drops it from the count without touching eating history')
    : bad('after delete');
  db.get('SELECT count(*) AS n FROM meals').n === 1
    ? ok('and the meal itself is still on the record')
    : bad('meal destroyed by recipe delete');
}

// ============================================================================
// scaleRecipeLines / scaledTotals — the Log sheet's live preview, which is the
// SAME derivation logRecipe writes through. The property that matters is that
// they cannot disagree, so the tests drive both against one recipe.
// ============================================================================

console.log('\n15. scaleRecipeLines: three states, and the preview IS the write');
{
  const { db } = freshDb();
  const chicken = fixtureFood(db);
  const id = createRecipe(db, {
    title: 'Preview test',
    servings: 2,
    ingredients: [
      { raw_text: '200 g chicken' },
      { raw_text: 'a splash of soy sauce' },
      { raw_text: 'salt to taste' },
    ],
  });
  const [meat, soy, salt] = listIngredients(db, id);
  resolveIngredient(db, meat.id, chicken, 200);
  setIngredientNegligible(db, salt.id, true);

  // One serving of a two-serving batch = half of everything.
  const scaled = scaleRecipeLines(listIngredients(db, id), 0.5);
  scaled.map((l) => l.state).join(',') === 'counted,uncounted,negligible'
    ? ok('each line reports which of the three things it is')
    : bad('states', scaled.map((l) => l.state).join(','));
  near(scaled[0].grams, 100) && near(scaled[0].kcal, 165)
    ? ok('a counted line is scaled by pure multiplication (100 g, 165 kcal)')
    : bad('counted scale', JSON.stringify(scaled[0]));
  scaled[1].kcal === null && scaled[2].kcal === null
    ? ok('uncounted and negligible lines carry no numbers at all')
    : bad('non-counted carry numbers');
  scaled[0].micros !== null && scaled[1].micros === null
    ? ok('micros ride the counted line only')
    : bad('micros');

  const totals = scaledTotals(scaled);
  near(totals.kcal, 165) && near(totals.protein_g, 31)
    ? ok('totals sum the counted lines only — the uncounted one is NOT in them')
    : bad('totals', JSON.stringify(totals));

  // The reconciliation that matters: what the sheet shows is what gets written.
  const logged = logRecipe(db, id, { servings: 1 }, { date: '2026-08-12', time: '19:00' });
  const items = listMealItems(db, logged.mealId);
  logged.uncountedCount === 1
    ? ok('logRecipe reports the same one uncounted line the preview showed')
    : bad('uncounted count', String(logged.uncountedCount));
  items.length === 2
    ? ok('the negligible line is skipped by the write, as the preview implies')
    : bad('item count', String(items.length));
  near(items.find((i) => i.kcal !== null).kcal, totals.kcal)
    ? ok('and the written kcal is exactly the previewed total')
    : bad('preview vs write', JSON.stringify(items.map((i) => i.kcal)));
}

console.log('\n15b. scaledTotals: per-macro honesty, and no vacuous total');
{
  const line = (over) => ({
    id: 'x',
    raw_text: 'x',
    name: 'x',
    food_id: null,
    state: 'counted',
    grams: 100,
    kcal: 100,
    protein_g: 10,
    carbs_g: 5,
    fat_g: 2,
    fiber_g: 1,
    micros: null,
    ...over,
  });
  const mixed = scaledTotals([line({}), line({ fiber_g: null })]);
  near(mixed.kcal, 200) && mixed.fiber_g === null
    ? ok('one line missing fiber makes the FIBER total null, not a partial sum')
    : bad('per-macro honesty', JSON.stringify(mixed));

  const none = scaledTotals([line({ state: 'uncounted' }), line({ state: 'negligible' })]);
  none.kcal === null
    ? ok('with nothing counted every total is null, never a confident 0')
    : bad('vacuous total', JSON.stringify(none));
}

console.log('\n15c. portionFactorOrNull: a half-typed number is null, not a throw');
{
  const { db } = freshDb();
  const id = createRecipe(db, {
    title: 'Factor',
    servings: 4,
    total_weight_g: 800,
    ingredients: [{ raw_text: '1 thing' }],
  });
  const recipe = getRecipe(db, id);
  near(portionFactorOrNull(recipe, { servings: 2 }), 0.5)
    ? ok('2 of 4 servings = 0.5')
    : bad('servings factor');
  near(portionFactorOrNull(recipe, { grams: 200 }), 0.25)
    ? ok('200 g of an 800 g batch = 0.25')
    : bad('grams factor');
  portionFactorOrNull(recipe, { grams: NaN }) === null &&
  portionFactorOrNull(recipe, { servings: 0 }) === null
    ? ok('NaN and zero are null rather than exceptions')
    : bad('invalid portions');
  const noWeight = getRecipe(
    db,
    createRecipe(db, { title: 'No weight', servings: 1, ingredients: [{ raw_text: 'x' }] })
  );
  portionFactorOrNull(noWeight, { grams: 100 }) === null
    ? ok('grams on a recipe with no cooked weight is null (portionFactor still throws)')
    : bad('grams without weight');
  throws(() => portionFactor(noWeight, { grams: 100 }))
    ? ok('and the write path keeps its corrective error')
    : bad('portionFactor no longer throws');
}

// ============================================================================
// 0034 — LINKING IS GONE. Lines are priced automatically, and the thing that
// replaced the user's explicit act is a PROVENANCE column. Three properties
// have to hold: the catalog pass never guesses, a hand pick is never
// overwritten by it, and "complete" nutrition always states what it is made of.
// ============================================================================

console.log('\n16. lineGrams: mass converts, everything else is honestly null');
{
  const g = (qty, unit) => lineGrams({ qty, unit });
  near(g(300, 'g'), 300) && near(g(1.5, 'kg'), 1500)
    ? ok('g and kg')
    : bad('metric mass', `${g(300, 'g')}/${g(1.5, 'kg')}`);
  near(g(4, 'oz'), 113.398092) && near(g(1, 'lb'), 453.59237)
    ? ok('oz and lb convert exactly, not to a rounded folk value')
    : bad('imperial mass', `${g(4, 'oz')}/${g(1, 'lb')}`);
  // The refusal that matters: a cup of flour and a cup of oil differ by
  // density, and this module has no density data.
  g(2, 'cup') === null && g(2, 'tbsp') === null && g(2, 'clove') === null
    ? ok('volumetric and countable units yield NULL — no density is invented')
    : bad('volume/count converted');
  g(null, 'g') === null && g(300, null) === null && g(0, 'g') === null
    ? ok('a missing qty, a missing unit and a zero all yield null')
    : bad('degenerate inputs');
}

console.log('\n16b. isConfidentFoodMatch: exact or leading phrase, never a guess');
{
  isConfidentFoodMatch('chicken breast', 'chicken breast')
    ? ok('an exact name matches')
    : bad('exact');
  isConfidentFoodMatch('chicken breast', 'chicken breast, cooked') &&
  isConfidentFoodMatch('chicken breast', 'chicken breast fillet')
    ? ok('a multi-token name that leads the food matches')
    : bad('leading phrase');
  // The whole reason this exists: the top substring hit for a generic single
  // token is alphabetical noise, and pricing chicken as rice cakes silently
  // would be worse than leaving the line to the model.
  !isConfidentFoodMatch('rice', 'rice cakes') && !isConfidentFoodMatch('chicken', 'chicken stock')
    ? ok('a GENERIC SINGLE TOKEN never matches, however close the hit looks')
    : bad('single token matched');
  !isConfidentFoodMatch('chicken breast', 'grilled chicken breast')
    ? ok('and a name buried mid-string is not a leading phrase')
    : bad('mid-string matched');
}

console.log('\n17. catalogResolveRecipe: prices what it can, provenance and all');
{
  const { db } = freshDb();
  const chicken = fixtureFood(db, { name: 'Chicken breast' });
  const id = createRecipe(db, {
    title: 'Auto test',
    servings: 2,
    ingredients: [
      // Mass + an exact catalog name: the catalog pass owns this one.
      { raw_text: '200 g chicken breast' },
      // A mass with no catalog food behind it — left for the model.
      { raw_text: '150 g quinoa' },
      // No mass at all — left for the model.
      { raw_text: '2 tbsp butter' },
      // Declared zero: never touched by any pass.
      { raw_text: 'salt to taste' },
    ],
  });
  const [, , , salt] = listIngredients(db, id);
  setIngredientNegligible(db, salt.id, true);

  const pass = catalogResolveRecipe(db, id);
  const lines = listIngredients(db, id);
  pass.resolved === 1 && pass.remaining === 2
    ? ok('one line priced from the catalog, two left for the model')
    : bad('pass counts', JSON.stringify(pass));
  lines[0].resolved_by === 'catalog' &&
  near(lines[0].grams, 200) &&
  near(lines[0].kcal, 330) &&
  lines[0].food_id === chicken
    ? ok('the priced line carries the food, the grams, the macros AND its provenance')
    : bad('catalog line', JSON.stringify(lines[0]));
  lines[1].resolved_by === null && lines[2].resolved_by === null
    ? ok('the two it could not reach are honestly untouched')
    : bad('over-reach');
  lines[3].resolved_by === null && lines[3].negligible === 1
    ? ok('and the negligible line is left alone')
    : bad('negligible touched');

  // Idempotent: the whole reason it can run on every screen open.
  catalogResolveRecipe(db, id).resolved === 0
    ? ok('a second pass changes nothing')
    : bad('not idempotent');

  // And it NEVER overwrites a hand pick, which is what makes the correction
  // path worth using.
  const beans = fixtureFood(db, { name: 'Quinoa, cooked', kcal_100g: 120 });
  resolveIngredient(db, lines[1].id, beans, 150, 'user');
  catalogResolveRecipe(db, id);
  listIngredients(db, id)[1].resolved_by === 'user'
    ? ok('a user-resolved line survives every later automatic pass')
    : bad('hand pick overwritten');
}

console.log('\n17b. resolveIngredientByModel + estimatedCount: the numbers say what they are');
{
  const { db } = freshDb();
  const chicken = fixtureFood(db, { name: 'Chicken breast' });
  const id = createRecipe(db, {
    title: 'Provenance',
    servings: 1,
    ingredients: [{ raw_text: '200 g chicken breast' }, { raw_text: '2 tbsp butter' }],
  });
  catalogResolveRecipe(db, id);
  const [, butter] = listIngredients(db, id);

  recipeNutrition(db, id).complete === false
    ? ok('the gate is still shut with one line unpriced')
    : bad('gate open too early');

  resolveIngredientByModel(db, butter.id, {
    grams: 28,
    kcal: 200,
    protein_g: 0.2,
    carbs_g: 0,
    fat_g: 23,
    fiber_g: null,
  });
  const line = listIngredients(db, id)[1];
  line.resolved_by === 'ai' && line.food_id === null && line.micros === null
    ? ok('a model-priced line points at NO catalog food and carries no micros')
    : bad('model line', JSON.stringify(line));
  line.fiber_g === null
    ? ok('and a macro it could not reach stays null, never a confident zero')
    : bad('fiber invented');

  const nutrition = recipeNutrition(db, id);
  nutrition.complete && nutrition.countedCount === 2 && nutrition.estimatedCount === 1
    ? ok('the gate opens, and the rollup states that 1 of 2 lines is estimated')
    : bad('nutrition', JSON.stringify(nutrition));
  near(nutrition.perServing.kcal, 530)
    ? ok('the figures are the sum of both, catalog and estimate alike')
    : bad('per serving', String(nutrition.perServing.kcal));
  void chicken;

  // Un-pricing clears the provenance with the numbers — the pair the schema
  // cannot enforce as a CHECK (0034 header) and this maintains.
  unresolveIngredient(db, line.id);
  const cleared = listIngredients(db, id)[1];
  cleared.resolved_by === null && cleared.grams === null && cleared.kcal === null
    ? ok('unresolving clears provenance and snapshots together')
    : bad('partial unresolve', JSON.stringify(cleared));
}

console.log('\n17c. the pricing prompt and its parser');
{
  const req = buildRecipePricingRequest('Stir-fry', [
    { index: 0, raw: '2 tbsp butter' },
    { index: 1, raw: '2 cloves garlic' },
  ]);
  const body = req.messages[0].content;
  body.includes('0. 2 tbsp butter') && body.includes('1. 2 cloves garlic')
    ? ok('the lines go out NUMBERED — the index is the contract')
    : bad('request body', body);
  req.system.includes('WHOLE BATCH')
    ? ok('and the prompt insists the quantities are per batch, not per serving')
    : bad('system prompt');

  const parsed = parseRecipePricing(
    '```json\n{"lines":[{"index":0,"grams":28,"kcal":200,"protein_g":0.2,"carbs_g":0,' +
      '"fat_g":23,"fiber_g":null,"note":" 2 tbsp assumed at 28 g "},' +
      '{"index":1,"grams":null,"kcal":null,"note":null}]}\n```'
  );
  parsed.length === 2 && parsed[0].grams === 28 && parsed[0].fiber_g === null
    ? ok('fenced JSON parses; a null macro stays null')
    : bad('parse', JSON.stringify(parsed));
  parsed[0].note === '2 tbsp assumed at 28 g'
    ? ok('the assumption comes back trimmed, to be shown with the figures')
    : bad('note', String(parsed[0].note));
  parsed[1].grams === null
    ? ok('a line the model declined to price returns null rather than a guess')
    : bad('declined line', JSON.stringify(parsed[1]));

  const junk = parseRecipePricing(
    '{"lines":[{"index":"nope","grams":10,"kcal":10},{"index":0,"grams":-5,"kcal":10}]}'
  );
  junk.length === 1 && junk[0].grams === null
    ? ok('a non-integer index is dropped and a negative gram is not coerced')
    : bad('coercion', JSON.stringify(junk));
  throws(() => parseRecipePricing('{"lines":[]}'))
    ? ok('a reply with no usable line throws rather than reporting a silent success')
    : bad('empty reply accepted');
  throws(() => parseRecipePricing('sorry, I cannot help with that'))
    ? ok('and prose with no JSON object throws')
    : bad('prose accepted');
}

console.log('\n18. Folders (0035) — a filing system, and deleting one keeps the recipes');
{
  const { db } = freshDb();
  const dinners = createFolder(db, ' Dinners ');
  const quick = createFolder(db, 'Quick');
  getFolder(db, dinners)?.name === 'Dinners'
    ? ok('a folder name is stored trimmed, in the user’s own casing')
    : bad('folder name', JSON.stringify(getFolder(db, dinners)));

  throws(() => createFolder(db, 'dinners'))
    ? ok('a duplicate name is refused case- and whitespace-insensitively')
    : bad('duplicate folder accepted');
  throws(() => createFolder(db, '   '))
    ? ok('and a blank name is refused')
    : bad('blank folder name accepted');

  const adobo = createRecipe(db, {
    title: 'Chicken Adobo',
    servings: 2,
    ingredients: [{ raw_text: '400 g chicken thighs' }],
  });
  const soup = createRecipe(db, {
    title: 'Lentil soup',
    servings: 4,
    ingredients: [{ raw_text: '200 g lentils' }],
  });
  getRecipe(db, adobo).folder_id === null
    ? ok('a new recipe lands UNFILED — a place, not a failure')
    : bad('folder_id default', String(getRecipe(db, adobo).folder_id));
  unfiledRecipeCount(db) === 2 ? ok('both are unfiled') : bad('unfiled count');

  moveRecipeToFolder(db, adobo, dinners);
  moveRecipeToFolder(db, soup, dinners);
  const filed = listFolders(db);
  filed.length === 2 && filed[0].folder.name === 'Dinners' && filed[0].recipeCount === 2
    ? ok('listFolders counts what is in each drawer, alphabetically')
    : bad('listFolders', JSON.stringify(filed.map((f) => [f.folder.name, f.recipeCount])));
  filed[1].recipeCount === 0 ? ok('an empty drawer counts 0') : bad('empty drawer count');
  unfiledRecipeCount(db) === 0 ? ok('and nothing is unfiled now') : bad('unfiled after move');

  // The three states of listRecipes' filter.
  listRecipes(db, '', { folder: dinners }).length === 2
    ? ok('listRecipes scoped to a folder returns only that drawer')
    : bad('scoped list');
  listRecipes(db, '', { folder: null }).length === 0
    ? ok('scoped to null returns only the unfiled')
    : bad('unfiled list');
  listRecipes(db, '').length === 2
    ? ok('and unscoped returns everything, so a filed recipe is never hidden')
    : bad('unscoped list');
  listRecipes(db, 'adobo', { folder: dinners }).length === 1
    ? ok('search composes with the scope')
    : bad('scoped search');

  // ALL THREE optional terms at once. listRecipes binds positionally across
  // the WHERE tokens, the ORDER BY prefix-rank `?` and LIMIT, and the folder
  // term was inserted between the first two — a misordered push would not
  // throw, it would silently filter on the wrong string. So the combination
  // that exercises every `?` is pinned rather than reasoned about.
  setRecipeFavorite(db, adobo, true);
  {
    const three = listRecipes(db, 'chicken', { favoriteOnly: true, folder: dinners });
    three.length === 1 && three[0].recipe.id === adobo
      ? ok('query + favoriteOnly + folder bind in the right order together')
      : bad('three-term bind', JSON.stringify(three.map((r) => r.recipe.title)));
    listRecipes(db, 'chicken', { favoriteOnly: true, folder: null }).length === 0
      ? ok('and the same three with an UNFILED scope — which contributes no param — still line up')
      : bad('three-term bind, unfiled scope');
  }
  setRecipeFavorite(db, adobo, false);

  moveRecipeToFolder(db, soup, null);
  getRecipe(db, soup).folder_id === null && unfiledRecipeCount(db) === 1
    ? ok('a recipe can be taken back out of every folder')
    : bad('move out');

  renameFolder(db, dinners, 'Weeknights');
  getFolder(db, dinners)?.name === 'Weeknights'
    ? ok('a folder renames')
    : bad('rename', JSON.stringify(getFolder(db, dinners)));
  throws(() => renameFolder(db, dinners, 'Quick'))
    ? ok('but not onto another drawer’s name')
    : bad('rename collision accepted');
  renameFolder(db, dinners, 'weeknights');
  getFolder(db, dinners)?.name === 'weeknights'
    ? ok('and renaming a folder to its own name (a casing fix) is allowed')
    : bad('self-rename refused');

  // THE LOAD-BEARING ONE.
  deleteFolder(db, dinners);
  const survivor = getRecipe(db, adobo);
  survivor !== undefined && survivor.folder_id === null
    ? ok('DELETING A FOLDER UNFILES ITS RECIPES — it never deletes one')
    : bad('folder delete destroyed a recipe', JSON.stringify(survivor));
  listIngredients(db, adobo).length === 1
    ? ok('and the recipe keeps its ingredient lines')
    : bad('lines lost on folder delete');
  recipeCount(db) === 2 ? ok('the book still holds both recipes') : bad('recipeCount after delete');

  // A recipe's own deletion must not take its folder with it.
  deleteRecipe(db, adobo);
  listFolders(db).length === 1
    ? ok('and deleting a recipe leaves the drawers alone')
    : bad('drawers');
}

console.log('\n19. applyRecipeRevision — matched lines keep their price AND their provenance');
{
  const { db } = freshDb();
  const chicken = fixtureFood(db, { name: 'Revision chicken', kcal_100g: 200 });
  const recipeId = createRecipe(db, {
    title: 'Sweet milk oats',
    servings: 2,
    steps: ['Warm the milk.', 'Stir in the oats.'],
    notes: 'Matt’s own note',
    tags: ['breakfast'],
    ingredients: [
      { raw_text: '200 g rolled oats' },
      { raw_text: '300 ml whole milk' },
      { raw_text: 'pinch of salt' },
    ],
  });
  const before = listIngredients(db, recipeId);
  resolveIngredient(db, before[0].id, chicken, 200, 'user'); // a HAND pick
  setIngredientNegligible(db, before[2].id, true);
  const oatsId = before[0].id;

  const applied = applyRecipeRevision(db, recipeId, {
    title: 'Sweet almond oats',
    servings: 2,
    ingredients: ['200 g rolled oats', '300 ml unsweetened almond milk', '2 tsp maple syrup'],
    steps: ['Warm the almond milk.', 'Stir in the oats.'],
  });
  applied.kept === 1 && applied.added === 2 && applied.removed === 2
    ? ok('one line survives verbatim; the reworded and the new are added; two go')
    : bad('counts', JSON.stringify(applied));

  const after = listIngredients(db, recipeId);
  after.length === 3 ? ok('the recipe holds the revised lines') : bad('line count', after.length);
  const oats = after.find((l) => l.id === oatsId);
  oats && oats.resolved_by === 'user' && near(oats.grams, 200) && oats.food_id === chicken
    ? ok('THE HAND PICK SURVIVES — same row, same snapshot, same provenance')
    : bad('hand pick lost', JSON.stringify(oats));
  oats.position === 0 ? ok('and only its position was rewritten') : bad('position', oats.position);

  const almond = after.find((l) => l.raw_text.includes('almond'));
  almond && almond.resolved_by === null && almond.grams === null
    ? ok('a reworded line lands UNRESOLVED — it never inherits the milk’s numbers')
    : bad('reworded line inherited numbers', JSON.stringify(almond));
  almond.qty === 300 && almond.unit === 'ml'
    ? ok('and its overlay is parsed deterministically from the raw line, not by the model')
    : bad('overlay', JSON.stringify([almond.qty, almond.unit]));

  const recipe = getRecipe(db, recipeId);
  recipe.title === 'Sweet almond oats' && recipe.title_norm === 'sweet almond oats'
    ? ok('the title and its search key move together')
    : bad('title', recipe.title_norm);
  parseSteps(recipe.steps).length === 2 && parseSteps(recipe.steps)[0].includes('almond')
    ? ok('the steps are rewritten')
    : bad('steps', recipe.steps);
  recipe.notes === 'Matt’s own note' && recipe.tags === '["breakfast"]'
    ? ok('and notes and tags are NOT touched — a revision writes only what it owns')
    : bad('notes/tags clobbered', JSON.stringify([recipe.notes, recipe.tags]));

  throws(() =>
    applyRecipeRevision(db, recipeId, { title: 'x', servings: 2, ingredients: [], steps: [] })
  )
    ? ok('a revision cannot leave a recipe with no ingredients')
    : bad('empty revision accepted');
  throws(() =>
    applyRecipeRevision(db, recipeId, { title: 'x', servings: 0, ingredients: ['a'], steps: [] })
  )
    ? ok('nor a non-positive yield')
    : bad('zero servings accepted');
  applyRecipeRevision(db, 'nope', { title: 'x', servings: 1, ingredients: ['a'], steps: [] }) ===
  null
    ? ok('and a missing recipe returns null rather than throwing')
    : bad('missing recipe');

  // Duplicate lines pair off one for one rather than collapsing.
  const dupes = createRecipe(db, {
    title: 'Oil twice',
    servings: 1,
    ingredients: [{ raw_text: '1 tbsp olive oil' }, { raw_text: '1 tbsp olive oil' }],
  });
  const dupeResult = applyRecipeRevision(db, dupes, {
    title: 'Oil twice',
    servings: 1,
    ingredients: ['1 tbsp olive oil'],
    steps: [],
  });
  dupeResult.kept === 1 && dupeResult.removed === 1 && listIngredients(db, dupes).length === 1
    ? ok('two identical lines match one for one — one kept, one dropped')
    : bad('duplicate matching', JSON.stringify(dupeResult));
}

console.log('\n19b. The revision diff, and its agreement with the write');
{
  const rows = diffRecipeLines(
    ['200 g oats', '300 ml whole milk', 'pinch of salt'],
    ['200 g oats', '300 ml almond milk', '2 tsp maple syrup']
  );
  rows.map((r) => r.state).join(',') === 'same,added,added,removed,removed'
    ? ok('the revised list comes back in order, then what left')
    : bad('diff states', JSON.stringify(rows));
  rows[3].text === '300 ml whole milk' && rows[4].text === 'pinch of salt'
    ? ok('and the dropped lines keep their original order')
    : bad('dropped order', JSON.stringify(rows.slice(3)));
  diffRecipeLines(['a', 'a'], ['a']).filter((r) => r.state === 'removed').length === 1
    ? ok('duplicates pair off one for one here too')
    : bad('diff duplicates');
  diffRecipeLines(['a'], ['a', 'a']).filter((r) => r.state === 'added').length === 1
    ? ok('and in the other direction')
    : bad('diff duplicates reversed');

  const dropped = droppedRecipeLines(
    [{ raw_text: 'a' }, { raw_text: 'b' }, { raw_text: 'a' }],
    ['a', 'c']
  );
  dropped.length === 2 && dropped[0].raw_text === 'b' && dropped[1].raw_text === 'a'
    ? ok('droppedRecipeLines returns the ROWS that go, first-come — same rule')
    : bad('dropped rows', JSON.stringify(dropped));

  // The screen must not describe a different write than the one that lands.
  const { db } = freshDb();
  const id = createRecipe(db, {
    title: 'Agreement',
    servings: 1,
    ingredients: [{ raw_text: 'a' }, { raw_text: 'b' }, { raw_text: 'a' }],
  });
  const revised = ['a', 'c'];
  const predicted = diffRecipeLines(['a', 'b', 'a'], revised);
  const result = applyRecipeRevision(db, id, {
    title: 'Agreement',
    servings: 1,
    ingredients: revised,
    steps: [],
  });
  result.kept === predicted.filter((r) => r.state === 'same').length &&
  result.added === predicted.filter((r) => r.state === 'added').length &&
  result.removed === predicted.filter((r) => r.state === 'removed').length
    ? ok('THE REVIEW AND THE WRITE AGREE — one matching rule, two callers')
    : bad('review/write disagree', JSON.stringify([predicted, result]));
}

console.log('\n19c. The revision prompt and its parser');
{
  const req = buildRecipeRevisionRequest(
    { title: 'Oats', servings: 2, ingredients: ['200 g oats', '300 ml milk'], steps: ['Warm it.'] },
    'change the milk for almond milk and keep the sweetness'
  );
  const body = req.messages[0].content;
  body.includes('- 200 g oats') && body.includes('1. Warm it.') && body.includes('Servings: 2')
    ? ok('the recipe goes up as words — lines, steps and yield')
    : bad('request body', body);
  body.includes('almond milk')
    ? ok('and the instruction rides with it')
    : bad('instruction missing');
  !body.includes('kcal') && !body.includes('grams')
    ? ok('no macros, no snapshots — the model rewrites, the pricing passes price')
    : bad('macros leaked into the prompt');
  req.system ===
  buildRecipeRevisionRequest(
    { title: 'Other', servings: 1, ingredients: ['x'], steps: [] },
    'anything'
  ).system
    ? ok('the system prompt is a CONSTANT, so it rides the cached prefix')
    : bad('system prompt varies per call');
  req.system.includes('COMPLETE revised recipe') && req.system.includes('SMALLEST set of changes')
    ? ok('and it demands a whole recipe plus minimal change for a goal-shaped instruction')
    : bad('system prompt rules');

  const current = { servings: 2, steps: ['Warm the milk.', 'Stir in the oats.'] };
  const parsed = parseRecipeRevision(
    '```json\n{"title":" Almond oats ","servings":2,' +
      '"ingredients":["200 g oats","",300,"300 ml almond milk"],' +
      '"steps":["Warm it."],"notes":" swapped the milk "}\n```',
    current
  );
  parsed.title === 'Almond oats' && parsed.notes === 'swapped the milk'
    ? ok('fenced JSON parses and trims')
    : bad('parse', JSON.stringify(parsed));
  parsed.ingredients.length === 2
    ? ok('a blank line and a non-string are dropped — the shape is never trusted')
    : bad('ingredients', JSON.stringify(parsed.ingredients));

  parseRecipeRevision('{"ingredients":["a"],"servings":-3}', { servings: 6, steps: [] })
    .servings === 6
    ? ok('a nonsense yield falls back to the recipe’s own, never to a made-up 1')
    : bad('servings fallback');
  parseRecipeRevision('{"ingredients":["a"]}', { servings: 4, steps: [] }).title === ''
    ? ok('a missing title comes back empty for the caller to keep the current one')
    : bad('title fallback');
  // A model that drops the "steps" key must not erase the method as a side
  // effect of "swap the milk" — an omitted field is an omission, not an order.
  {
    const noSteps = parseRecipeRevision('{"ingredients":["a"]}', current);
    noSteps.steps.join('|') === current.steps.join('|')
      ? ok('a reply carrying no steps KEEPS the recipe’s method rather than wiping it')
      : bad('steps wiped', JSON.stringify(noSteps.steps));
    parseRecipeRevision('{"ingredients":["a"],"steps":["Only this."]}', current).steps.length === 1
      ? ok('and a reply that does carry steps replaces them')
      : bad('steps not replaced');
  }
  throws(() => parseRecipeRevision('{"ingredients":[]}', current))
    ? ok('a reply with no usable ingredient line throws rather than offering an empty recipe')
    : bad('empty revision accepted');
  throws(() => parseRecipeRevision('sorry, I cannot help with that', current))
    ? ok('and prose with no JSON object throws')
    : bad('prose accepted');
}

console.log('\n19d. The review-pass regressions');
{
  // WHITESPACE. A stored raw_text is never trimmed on insert (import and the
  // Coach write what they were given), and every line the model returns is
  // trimmed on the way in. An untrimmed match would therefore delete a line
  // NOBODY asked to change — taking its hand pick and its snapshots with it.
  const { db } = freshDb();
  const food = fixtureFood(db, { name: 'Whitespace chicken', kcal_100g: 200 });
  const id = createRecipe(db, {
    title: 'Padded',
    servings: 1,
    ingredients: [{ raw_text: '  400 g chicken thighs  ' }, { raw_text: '1 tbsp soy sauce' }],
  });
  const padded = listIngredients(db, id)[0];
  resolveIngredient(db, padded.id, food, 400, 'user');

  const result = applyRecipeRevision(db, id, {
    title: 'Padded',
    servings: 1,
    ingredients: ['400 g chicken thighs', '2 tbsp soy sauce'],
    steps: [],
  });
  const survivor = listIngredients(db, id).find((l) => l.id === padded.id);
  survivor && survivor.resolved_by === 'user' && result.kept === 1
    ? ok('a padded stored line matches its own trimmed echo — the hand pick survives')
    : bad('whitespace destroyed a hand pick', JSON.stringify([result, survivor]));
  diffRecipeLines(['  a  ', 'b'], ['a']).filter((r) => r.state === 'same').length === 1
    ? ok('and the review marks it kept by the same trimmed rule, so the two still agree')
    : bad('diff disagrees on whitespace', JSON.stringify(diffRecipeLines(['  a  ', 'b'], ['a'])));

  // A duplicate folder name reaching the UNIQUE index must not print the
  // driver's own sentence at the user.
  createFolder(db, 'Dinners');
  let raised;
  try {
    db.run('INSERT INTO recipe_folders (id, name, name_norm) VALUES (?, ?, ?)', [
      'x',
      'Dinners',
      'dinners',
    ]);
  } catch (e) {
    raised = e;
  }
  raised && /UNIQUE constraint failed/i.test(raised.message)
    ? ok('the UNIQUE index is the real guarantee (raw driver message confirmed)')
    : bad('no UNIQUE index on recipe_folders.name_norm');
  let friendly;
  try {
    createFolder(db, '  DINNERS ');
  } catch (e) {
    friendly = e;
  }
  friendly &&
  !/UNIQUE constraint/i.test(friendly.message) &&
  /already a folder/.test(friendly.message)
    ? ok('and createFolder answers in a sentence, never in SQLite’s')
    : bad('raw driver message escaped', friendly && friendly.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
