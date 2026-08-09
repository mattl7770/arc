/**
 * Headless test of the grocery list — grocery_items + grocery_name_prefs
 * (0031), the static category table, the prefs ownership rules, soft
 * check-off, and the consolidated view — against real SQLite via node:sqlite.
 * Mirrors db/foods.test.mjs; op-sqlite is never loaded. Spec:
 * docs/recipes-grocery.md §2b. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { createFood } from '../src/lib/db/repositories/foods.ts';
import {
  addGroceryItems,
  addRecipeToGroceryList,
  checkGroceryItem,
  clearCheckedItems,
  consolidatedOpenList,
  getGroceryItem,
  getNamePref,
  listCheckedGroceryItems,
  listOpenGroceryItems,
  listStaples,
  openGroceryCount,
  removeGroceryItem,
  searchGroceryHistory,
  setStaple,
  uncheckGroceryItem,
  updateGroceryItem,
} from '../src/lib/db/repositories/grocery.ts';
import {
  createRecipe,
  deleteRecipe,
  listIngredients,
  resolveIngredient,
} from '../src/lib/db/repositories/recipes.ts';
import { categorizeGroceryItem } from '../src/lib/grocery/categories.ts';
import { mergeQtyTexts } from '../src/lib/grocery/quantities.ts';

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

{
  console.log('0. Migrations applied (0031 present)');
  const { raw } = freshDb();
  const version = raw.prepare('PRAGMA user_version').get().user_version;
  if (version >= 31) ok(`user_version ${version} >= 31`);
  else bad('user_version >= 31', String(version));
  const tables = raw
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('grocery_items', 'grocery_name_prefs')`
    )
    .all();
  if (tables.length === 2) ok('grocery_items + grocery_name_prefs exist');
  else bad('grocery tables exist');
}

{
  console.log('1. categorizeGroceryItem — static table discipline');
  const cases = [
    ['milk', 'dairy_eggs'],
    ['chicken breast', 'meat_seafood'], // whole-word containment
    ['sweet potato', 'produce'], // longest keyword beats 'potato'
    ['buttermilk', 'other'], // substring matches banned
    ['olive oil', 'pantry'],
    ['frozen peas', 'frozen'],
    ['unicorn dust', 'other'],
    // Punctuation is a word boundary: recipe-derived "<food>, <prep-note>"
    // names must still categorize (bug-hunt 2026-08-08).
    ['garlic, minced', 'produce'],
    ['eggs, beaten', 'dairy_eggs'],
    ['butter, softened', 'dairy_eggs'],
  ];
  for (const [name, want] of cases) {
    const got = categorizeGroceryItem(name);
    if (got === want) ok(`${name} → ${want}`);
    else bad(`${name}`, got);
  }
  if (categorizeGroceryItem('milk', 'pantry') === 'pantry') {
    ok('learned category wins over the static table');
  } else bad('learned override');
}

{
  console.log('2. addGroceryItems — batch, categories, prefs ownership');
  const { db } = freshDb();
  const ids = addGroceryItems(db, [
    { name: 'Milk', qty_text: '2' },
    { name: 'Spinach' },
    { name: '  ' }, // blank — skipped, not an error
  ]);
  if (ids.length === 2) ok('batch add returns ids, blank names skipped');
  else bad('batch add', String(ids.length));
  const open = listOpenGroceryItems(db);
  if (open.find((i) => i.name === 'Milk')?.category === 'dairy_eggs') {
    ok('static category assigned at insert');
  } else bad('category at insert');

  let pref = getNamePref(db, 'milk');
  if (pref && pref.times_added === 1 && pref.last_qty_text === '2') {
    ok('add creates the prefs row (times_added 1, qty remembered)');
  } else bad('pref create', JSON.stringify(pref));

  addGroceryItems(db, [{ name: 'milk' }]);
  pref = getNamePref(db, 'milk');
  if (pref.times_added === 2 && pref.last_qty_text === '2') {
    ok('re-add increments once; null qty keeps the remembered one (coalesce)');
  } else bad('re-add', JSON.stringify(pref));

  // Ownership: check-off writes NOTHING to prefs.
  const milkId = open.find((i) => i.name === 'Milk').id;
  checkGroceryItem(db, milkId);
  pref = getNamePref(db, 'milk');
  if (pref.times_added === 2) ok('check-off does not touch times_added (ownership rule)');
  else bad('checkoff ownership', String(pref.times_added));
}

{
  console.log('3. Check-off is soft state; clear deletes only checked');
  const { db } = freshDb();
  addGroceryItems(db, [{ name: 'Eggs' }, { name: 'Bread' }, { name: 'Coffee' }]);
  const [a, b] = listOpenGroceryItems(db);
  checkGroceryItem(db, a.id);
  checkGroceryItem(db, b.id);
  if (listOpenGroceryItems(db).length === 1 && listCheckedGroceryItems(db).length === 2) {
    ok('checked items leave the open list, land in the cart section');
  } else bad('soft check-off');
  if (openGroceryCount(db) === 1) ok('openGroceryCount');
  else bad('openGroceryCount');
  uncheckGroceryItem(db, a.id);
  if (listOpenGroceryItems(db).length === 2) ok('uncheck restores an item');
  else bad('uncheck');
  checkGroceryItem(db, a.id);
  const cleared = clearCheckedItems(db);
  if (
    cleared === 2 &&
    listOpenGroceryItems(db).length === 1 &&
    listCheckedGroceryItems(db).length === 0
  ) {
    ok('clear deletes exactly the checked rows');
  } else bad('clear', String(cleared));
  if (getNamePref(db, 'eggs')?.times_added === 1) {
    ok('clearing the cart leaves the prefs memory intact');
  } else bad('prefs survive clear');
}

{
  console.log('4. updateGroceryItem — rename + the re-file learning loop');
  const { db } = freshDb();
  addGroceryItems(db, [{ name: 'Kimchi' }]);
  const item = listOpenGroceryItems(db)[0];
  if (item.category === 'other') ok('unknown item lands in other');
  else bad('unknown default', item.category);

  updateGroceryItem(db, item.id, { category: 'produce' });
  if (getGroceryItem(db, item.id).category === 'produce') ok('re-file moves the item');
  else bad('re-file');
  if (getNamePref(db, 'kimchi')?.category === 'produce') ok('re-file writes the learned pref');
  else bad('learned pref');
  addGroceryItems(db, [{ name: 'kimchi', qty_text: '1 jar' }]);
  const again = listOpenGroceryItems(db).find((i) => i.qty_text === '1 jar');
  if (again.category === 'produce') ok('the next add uses the learned category');
  else bad('learned add', again.category);

  updateGroceryItem(db, item.id, { name: 'Kimchi (spicy)' });
  if (getGroceryItem(db, item.id).name_norm === 'kimchi (spicy)') ok('rename re-derives name_norm');
  else bad('rename');

  removeGroceryItem(db, item.id);
  if (!getGroceryItem(db, item.id)) ok('removeGroceryItem deletes');
  else bad('remove');
}

{
  console.log('5. addRecipeToGroceryList — picker ids, backlinks, SET NULL');
  const { db } = freshDb();
  const foodId = createFood(db, { name: 'Soy sauce', kcal_100g: 53 });
  const recipeId = createRecipe(db, {
    title: 'Adobo',
    servings: 4,
    ingredients: [
      { raw_text: '1 kg chicken thighs' },
      { raw_text: '1/2 cup soy sauce' },
      { raw_text: 'salt to taste' },
    ],
  });
  const lines = listIngredients(db, recipeId);
  resolveIngredient(db, lines[1].id, foodId, 120);
  // The picker left the first two checked (user has salt).
  const ids = addRecipeToGroceryList(db, recipeId, [lines[0].id, lines[1].id]);
  if (ids.length === 2) ok('only the picker-checked lines are added');
  else bad('picker filter', String(ids.length));
  const soy = getGroceryItem(db, ids[1]);
  if (soy.source === 'recipe' && soy.recipe_id === recipeId && soy.food_id === foodId) {
    ok('items carry recipe + food backlinks');
  } else bad('backlinks', JSON.stringify(soy));
  if (soy.qty_text === '½ cup') ok('qty display built from the parsed overlay');
  else bad('qty display', soy.qty_text);
  const thighs = getGroceryItem(db, ids[0]);
  if (thighs.name === 'chicken thighs' && thighs.category === 'meat_seafood') {
    ok('line names categorize like typed items');
  } else bad('line categorize', JSON.stringify(thighs));

  deleteRecipe(db, recipeId);
  if (getGroceryItem(db, ids[0]).recipe_id === null) {
    ok('deleting the recipe never destroys the list (SET NULL)');
  } else bad('recipe SET NULL');
}

{
  console.log('6. History — autocomplete, staples, escapes');
  const { db } = freshDb();
  addGroceryItems(db, [{ name: 'Oat milk' }, { name: 'Oats' }, { name: 'Olive oil' }]);
  addGroceryItems(db, [{ name: 'oats' }]); // second add outranks
  const hits = searchGroceryHistory(db, 'oa');
  if (hits.length === 2 && hits[0].name_norm === 'oats') {
    ok('prefix autocomplete, most-added first');
  } else bad('autocomplete', JSON.stringify(hits.map((h) => h.name_norm)));
  if (searchGroceryHistory(db, '').length === 0) ok('empty prefix → nothing');
  else bad('empty prefix');

  addGroceryItems(db, [{ name: '100% juice' }]);
  const pct = searchGroceryHistory(db, '100%');
  if (pct.length === 1) ok('LIKE metacharacters escaped in autocomplete');
  else bad('escape', String(pct.length));

  setStaple(db, 'Coffee beans', true);
  setStaple(db, 'oats', true);
  const staples = listStaples(db);
  if (staples.length === 2 && staples[0].display_name === 'Coffee beans') {
    ok('staples upsert (new name creates the memory row)');
  } else bad('staples', JSON.stringify(staples.map((s) => s.display_name)));
  setStaple(db, 'oats', false);
  if (listStaples(db).length === 1) ok('unstar');
  else bad('unstar');
}

{
  console.log('7. Consolidated view — merge as display, never destructively');
  const cases = [
    [['2', '3'], '5'],
    [['1 cup', '2 cup'], '3 cup'],
    [['1 cup', '½ cup'], '1½ cup'],
    [['2 cup', '100 g'], '2 cup + 100 g'],
    // Duplicate same-unit members SUM even when a mixed member is present —
    // deduping them silently understated the shop (bug-hunt 2026-08-08).
    [['2 cup', '2 cup', '100 g'], '4 cup + 100 g'],
    // Verbatim members are NEVER deduplicated: two dozens are two dozens.
    [['1 dozen', '1 dozen'], '1 dozen + 1 dozen'],
    [['2 large', '1'], '1 + 2 large'],
    [[null, '2'], '2'],
    [[null, null], null],
  ];
  for (const [texts, want] of cases) {
    const got = mergeQtyTexts(texts);
    if (got === want) ok(`${JSON.stringify(texts)} → ${JSON.stringify(want)}`);
    else bad(JSON.stringify(texts), JSON.stringify(got));
  }

  const { db } = freshDb();
  addGroceryItems(db, [
    { name: 'Flour', qty_text: '2 cups' },
    { name: 'flour', qty_text: '1 cup' },
    { name: 'Milk' },
  ]);
  const lines = consolidatedOpenList(db);
  const flour = lines.find((l) => l.name_norm === 'flour');
  if (lines.length === 2 && flour.items.length === 2 && flour.qtyDisplay === '3 cup') {
    ok('duplicates merge for display with member items preserved');
  } else bad('consolidation', JSON.stringify(flour));
}

{
  console.log('8. Schema guards');
  const { raw, db } = freshDb();
  if (
    throws(() =>
      raw
        .prepare(
          `INSERT INTO grocery_items (id, name, name_norm, source) VALUES ('g-bad', 'x', 'x', 'martian')`
        )
        .run()
    )
  ) {
    ok('unknown source rejected (CHECK)');
  } else bad('source CHECK');
  addGroceryItems(db, [{ name: 'Trigger test' }]);
  const item = listOpenGroceryItems(db)[0];
  const before = item.updated_at;
  raw.prepare(`UPDATE grocery_items SET qty_text = '9' WHERE id = ?`).run(item.id);
  const after = raw
    .prepare('SELECT updated_at FROM grocery_items WHERE id = ?')
    .get(item.id).updated_at;
  if (after >= before) ok('grocery_items updated_at trigger stamps');
  else bad('trigger');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
