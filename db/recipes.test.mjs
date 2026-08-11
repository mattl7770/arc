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
  relogMeal,
} from '../src/lib/db/repositories/nutrition.ts';
import {
  addIngredient,
  createRecipe,
  deleteRecipe,
  getRecipe,
  isResolved,
  listIngredients,
  listRecipes,
  logRecipe,
  parseSteps,
  portionFactor,
  recipeCookStats,
  recipeCount,
  recipeNutrition,
  recipesCookedSince,
  removeIngredient,
  reorderIngredients,
  resolveIngredient,
  saveMealAsRecipe,
  setIngredientNegligible,
  setRecipeFavorite,
  unresolveIngredient,
  updateIngredientLine,
  updateRecipe,
} from '../src/lib/db/repositories/recipes.ts';
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
