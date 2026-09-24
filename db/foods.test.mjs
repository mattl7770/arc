/**
 * Headless test of the food-catalog layer — foods + meal_items (0014), the
 * versioned nutrition_targets (0015), the seed catalog (0016), and their
 * repositories (foods.ts + the nutrition.ts additions) — against real SQLite
 * via node:sqlite. Mirrors db/nutrition.test.mjs; op-sqlite is never loaded.
 * Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { todayISODate } from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  createFood,
  deleteFood,
  findFoodByBarcode,
  getFood,
  listFavoriteFoods,
  listRecentBarcodeFoods,
  listRecentFoods,
  normalizeFoodName,
  searchFoods,
  setFoodFavorite,
  updateFood,
} from '../src/lib/db/repositories/foods.ts';
import {
  activeNutritionTargets,
  addMealItem,
  dailyIntakeSeries,
  dayFiberTotal,
  deleteMeal,
  getMeal,
  listMealItems,
  listTodayMeals,
  logMeal,
  logMealWithItems,
  mealItemCounts,
  relogMeal,
  removeMealItem,
  setNutritionTargets,
  todayTotals,
  updateMealItemPortion,
} from '../src/lib/db/repositories/nutrition.ts';
import { itemForPortion, macrosForAmount } from '../src/lib/nutrition/servings.ts';
import {
  countLabel,
  fmtAmount,
  piecesLabel,
  pluralNoun,
  portionLabel,
} from '../src/lib/nutrition/format.ts';

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

const TODAY = todayISODate();

/** A plain catalog food for tests: 100 kcal / 10P / 5C / 2F / 1 fiber per
 * 100 g, with a 50 g named serving — numbers chosen for easy mental math. */
function testFood(db, overrides = {}) {
  return createFood(db, {
    name: 'Test food',
    serving_name: '1 unit',
    serving_amount: 50,
    kcal_100g: 100,
    protein_g_100g: 10,
    carbs_g_100g: 5,
    fat_g_100g: 2,
    fiber_g_100g: 1,
    ...overrides,
  });
}

console.log('0. migrations: 0014–0016 apply on top of the earlier set');
{
  const { raw } = freshDb();
  // user_version is the HIGHEST applied migration — >= 16 once 0016 has run
  // (assert the floor so this stays correct as later migrations land).
  const version = raw.prepare('PRAGMA user_version').get().user_version;
  version >= 16 ? ok(`user_version is ${version} (>= 16)`) : bad('user_version', version);
  for (const table of ['foods', 'meal_items', 'nutrition_targets']) {
    raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table)
      ? ok(`${table} table exists`)
      : bad(`${table} table missing`);
  }
}

console.log('1. createFood persists a custom food with derived name_norm and defaults');
{
  const { db, raw } = freshDb();
  const id = createFood(db, { name: '  My  Overnight OATS ', kcal_100g: 120 });
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
    ? ok('returned id is a v4 UUID')
    : bad('id shape', id);
  const row = raw.prepare('SELECT * FROM foods WHERE id = ?').get(id);
  row && row.name === '  My  Overnight OATS ' && row.name_norm === 'my overnight oats'
    ? ok('name kept verbatim, name_norm lowercased + whitespace-collapsed')
    : bad('name_norm', JSON.stringify(row));
  row && row.source === 'user' && row.is_favorite === 0 && row.serving_name === null
    ? ok('defaults: source=user, not favorite, no serving')
    : bad('defaults', JSON.stringify(row));
  normalizeFoodName('  Étouffée  Bowl ') === 'étouffée bowl'
    ? ok('normalizeFoodName lowercases beyond ASCII (JS, not SQL lower())')
    : bad('normalizeFoodName unicode');
}

console.log('2. foods CHECKs reject bad data at the DB layer');
{
  const { db } = freshDb();
  throws(() => testFood(db, { kcal_100g: -1 })) ? ok('negative kcal rejected') : bad('neg kcal');
  throws(() => testFood(db, { protein_g_100g: 101 }))
    ? ok('protein over 100 g/100 g rejected')
    : bad('protein bound');
  throws(() => testFood(db, { kcal_100g: 951 }))
    ? ok('kcal over 950/100 g rejected')
    : bad('kcal bound');
  throws(() => testFood(db, { source: 'carrier_pigeon' }))
    ? ok('unknown source rejected by the enum CHECK')
    : bad('source enum');
  throws(() => testFood(db, { serving_name: '1 cup', serving_amount: null }))
    ? ok('serving name without an amount rejected (pair-or-none)')
    : bad('serving pair');
  throws(() => testFood(db, { barcode: '12AB56' }))
    ? ok('non-digit barcode rejected')
    : bad('barcode digits');
  throws(() => testFood(db, { micros: '{not json' }))
    ? ok('invalid micros JSON rejected')
    : bad('micros json');
  testFood(db, { barcode: '0123456789012' });
  throws(() => testFood(db, { name: 'Other', barcode: '0123456789012' }))
    ? ok('duplicate barcode rejected (partial unique index)')
    : bad('barcode unique');
}

console.log('3. searchFoods: tokens AND together, prefix ranks first, favorites boost');
{
  const { db } = freshDb();
  const plain = testFood(db, { name: 'Zzz chicken curry' });
  const prefix = testFood(db, { name: 'Zzz chicken' });
  const fav = testFood(db, { name: 'Ala zzz chicken soup' });
  setFoodFavorite(db, fav, true);
  const names = (q) => searchFoods(db, q).map((f) => f.id);
  const result = names('zzz chicken');
  result.length === 3 && result[0] === prefix
    ? ok('whole-query prefix match ranks first')
    : bad('prefix rank', JSON.stringify(searchFoods(db, 'zzz chicken').map((f) => f.name)));
  // 'chicken zzz' prefix-matches nothing, so all three compete as substring
  // matches — the favorite must surface first there.
  const reordered = names('chicken zzz');
  reordered.length === 3 ? ok('token order does not matter (AND semantics)') : bad('token AND');
  reordered[0] === fav
    ? ok('favorite ranks first among equal (non-prefix) matches')
    : bad('favorite boost', JSON.stringify(reordered));
  names('zzz curry').length === 1 && names('zzz curry')[0] === plain
    ? ok('all tokens must match')
    : bad('token filter');
  searchFoods(db, '   ').length === 0 ? ok('blank query returns nothing') : bad('blank query');
  // Escaping must be PROVABLE: with these rows present, an unescaped '%' or
  // '_' would wildcard-match every food instead of the one literal hit.
  const pct = testFood(db, { name: '100% juice' });
  const und = testFood(db, { name: 'under_score food' });
  const pctHits = searchFoods(db, '100%').map((f) => f.id);
  pctHits.length === 1 && pctHits[0] === pct
    ? ok("'100%' matches only the literal-percent food (escaped, not wildcard)")
    : bad('percent escape', JSON.stringify(searchFoods(db, '100%').map((f) => f.name)));
  const undHits = searchFoods(db, '_').map((f) => f.id);
  undHits.length === 1 && undHits[0] === und
    ? ok("'_' matches only the literal-underscore food")
    : bad('underscore escape', JSON.stringify(searchFoods(db, '_').map((f) => f.name)));
}

console.log('4. favorites list + the foods updated_at trigger');
{
  const { db, raw } = freshDb();
  const id = testFood(db, { name: 'Fav food' });
  setFoodFavorite(db, id, true);
  listFavoriteFoods(db).some((f) => f.id === id)
    ? ok('favorite shows in listFavoriteFoods')
    : bad('favorites list');
  raw.prepare('UPDATE foods SET updated_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', id);
  updateFood(db, id, { name: 'Fav food renamed', kcal_100g: 100 });
  const row = raw.prepare('SELECT * FROM foods WHERE id = ?').get(id);
  row && row.updated_at !== '2000-01-01T00:00:00.000Z' && row.name_norm === 'fav food renamed'
    ? ok('updateFood re-derives name_norm and the trigger restamps updated_at')
    : bad('update trigger', JSON.stringify(row));
  setFoodFavorite(db, id, false);
  listFavoriteFoods(db).length === 0 ? ok('unfavorite removes it') : bad('unfavorite');
}

console.log('5. logMealWithItems: one transaction, meal totals = item sums');
{
  const { db, raw } = freshDb();
  const foodId = testFood(db);
  const { mealId, itemIds } = logMealWithItems(db, {
    date: TODAY,
    time: '12:30',
    name: 'Lunch',
    items: [
      {
        food_id: foodId,
        name: 'Test food',
        amount: 200,
        serving_qty: 4,
        kcal: 200,
        protein_g: 20,
        carbs_g: 10,
        fat_g: 4,
        fiber_g: 2,
      },
      { name: 'Mystery side', kcal: 100 }, // free-form item, macros unknown
    ],
  });
  itemIds.length === 2 ? ok('both items inserted') : bad('item count', itemIds.length);
  const meal = getMeal(db, mealId);
  meal &&
  near(meal.kcal, 300) &&
  near(meal.protein_g, 20) &&
  near(meal.carbs_g, 10) &&
  near(meal.fat_g, 4)
    ? ok('meal totals are the item sums, NULL-skipping (missing macros don’t zero)')
    : bad('meal sums', JSON.stringify(meal));
  meal && meal.source === 'manual'
    ? ok('default source is manual')
    : bad('source', meal && meal.source);
  const t = todayTotals(db, TODAY);
  near(t.kcal, 300) && t.mealCount === 1
    ? ok('existing todayTotals sees the itemized meal unchanged')
    : bad('todayTotals compat', JSON.stringify(t));
  listTodayMeals(db, TODAY).length === 1
    ? ok('existing listTodayMeals sees it')
    : bad('listTodayMeals compat');
  const series = dailyIntakeSeries(db, 2, TODAY);
  near(series[1].kcal, 300)
    ? ok('existing dailyIntakeSeries sees it (Data-tab trend intact)')
    : bad('series compat', JSON.stringify(series));
  const counts = mealItemCounts(db, TODAY);
  counts[mealId] === 2
    ? ok('mealItemCounts maps the day')
    : bad('item counts', JSON.stringify(counts));
  raw.prepare('SELECT count(*) c FROM daily_logs').get().c === 0
    ? ok('no daily_log side effects')
    : bad('side effects');
  throws(() =>
    logMealWithItems(db, {
      date: TODAY,
      time: '13:00',
      name: 'Bad',
      items: [
        { name: 'ok item', kcal: 100 },
        { name: 'bad item', kcal: -5 },
      ],
    })
  )
    ? ok('a CHECK violation on any item rolls the whole meal back')
    : bad('atomicity throw');
  todayTotals(db, TODAY).mealCount === 1
    ? ok('nothing half-saved after the rollback')
    : bad('rollback left rows');
}

console.log('6. item add / portion edit / remove keep the meal totals honest');
{
  const { db } = freshDb();
  const foodId = testFood(db);
  const { mealId } = logMealWithItems(db, {
    date: TODAY,
    time: '08:00',
    name: 'Breakfast',
    items: [
      {
        food_id: foodId,
        name: 'Test food',
        amount: 100,
        kcal: 100,
        protein_g: 10,
        carbs_g: 5,
        fat_g: 2,
        fiber_g: 1,
      },
    ],
  });
  const itemId = addMealItem(db, mealId, {
    food_id: foodId,
    name: 'Test food',
    amount: 50,
    serving_qty: 1,
    kcal: 50,
    protein_g: 5,
    carbs_g: 2.5,
    fat_g: 1,
    fiber_g: 0.5,
  });
  near(getMeal(db, mealId).kcal, 150)
    ? ok('addMealItem folds the new item into the totals')
    : bad('add recompute', getMeal(db, mealId).kcal);
  updateMealItemPortion(db, itemId, {
    amount: 100,
    serving_qty: 2,
    kcal: 100,
    protein_g: 10,
    carbs_g: 5,
    fat_g: 2,
    fiber_g: 1,
  });
  near(getMeal(db, mealId).kcal, 200)
    ? ok('updateMealItemPortion re-derives the totals')
    : bad('update recompute', getMeal(db, mealId).kcal);
  near(dayFiberTotal(db, TODAY), 2)
    ? ok('dayFiberTotal sums item fiber')
    : bad('fiber total', dayFiberTotal(db, TODAY));
  const items = listMealItems(db, mealId);
  items.length === 2 && items.every((i) => i.food_serving_name === '1 unit')
    ? ok('listMealItems joins the catalog serving name')
    : bad('items join', JSON.stringify(items));
  removeMealItem(db, itemId);
  near(getMeal(db, mealId).kcal, 100) ? ok('removeMealItem re-derives') : bad('remove recompute');
  // Remove whatever remains (same-ms created_at makes items[0] ambiguous).
  for (const left of listMealItems(db, mealId)) removeMealItem(db, left.id);
  const emptied = getMeal(db, mealId);
  emptied.kcal === null && emptied.protein_g === null
    ? ok('a meal emptied of items returns to free-form NULLs, not fake zeros')
    : bad('emptied meal', JSON.stringify(emptied));
}

console.log('6b. itemizing a free-form meal preserves its typed totals as an item');
{
  const { db } = freshDb();
  const mealId = logMeal(db, {
    date: TODAY,
    time: '19:00',
    name: 'Dinner',
    kcal: 800,
    protein_g: 60,
  });
  addMealItem(db, mealId, { name: 'Forgotten egg', kcal: 78, protein_g: 6.3 });
  const meal = getMeal(db, mealId);
  meal && near(meal.kcal, 878) && near(meal.protein_g, 66.3)
    ? ok('typed totals + the new item — never a silent overwrite')
    : bad('freeform preserve', JSON.stringify(meal));
  const items = listMealItems(db, mealId);
  items.length === 2 && items.some((i) => i.name === 'Dinner (as logged)' && near(i.kcal, 800))
    ? ok('the typed totals became their own "(as logged)" item')
    : bad('as-logged item', JSON.stringify(items.map((i) => i.name)));
  const bare = logMeal(db, { date: TODAY, time: '21:00', name: 'Name only' });
  addMealItem(db, bare, { name: 'Snack bite', kcal: 50 });
  listMealItems(db, bare).length === 1 && near(getMeal(db, bare).kcal, 50)
    ? ok('a name-only meal gains no synthetic item (nothing to preserve)')
    : bad('bare meal', JSON.stringify(listMealItems(db, bare).map((i) => i.name)));
}

console.log('7. delete semantics: meals cascade items; foods SET NULL and history survives');
{
  const { db, raw } = freshDb();
  const foodId = testFood(db);
  const { mealId } = logMealWithItems(db, {
    date: TODAY,
    time: '19:00',
    name: 'Dinner',
    items: [
      {
        food_id: foodId,
        name: 'Test food',
        amount: 100,
        kcal: 100,
        protein_g: 10,
        carbs_g: 5,
        fat_g: 2,
      },
    ],
  });
  deleteFood(db, foodId);
  const orphan = raw.prepare('SELECT * FROM meal_items WHERE meal_id = ?').get(mealId);
  orphan && orphan.food_id === null && orphan.name === 'Test food' && near(orphan.kcal, 100)
    ? ok('deleting the catalog food nulls the link but keeps the snapshot')
    : bad('food SET NULL', JSON.stringify(orphan));
  throws(() => addMealItem(db, 'no-such-meal', { name: 'x', kcal: 1 }))
    ? ok('an item cannot attach to a missing meal (FK enforced)')
    : bad('fk enforcement');
  deleteMeal(db, mealId);
  raw.prepare('SELECT count(*) c FROM meal_items').get().c === 0
    ? ok('deleting the meal cascades its items')
    : bad('meal cascade');
}

console.log('8. relogMeal duplicates a meal onto today — items and free-form both');
{
  const { db, raw } = freshDb();
  const foodId = testFood(db);
  const { mealId } = logMealWithItems(db, {
    date: '2000-01-01',
    time: '12:00',
    name: 'Old lunch',
    items: [
      {
        food_id: foodId,
        name: 'Test food',
        amount: 150,
        kcal: 150,
        protein_g: 15,
        carbs_g: 7.5,
        fat_g: 3,
        fiber_g: 1.5,
      },
    ],
  });
  const newId = relogMeal(db, mealId, TODAY, '12:15');
  const copy = getMeal(db, newId);
  copy && copy.date === TODAY && copy.time === '12:15' && near(copy.kcal, 150)
    ? ok('itemized meal duplicated with its totals')
    : bad('relog itemized', JSON.stringify(copy));
  listMealItems(db, newId).length === 1 ? ok('items copied too') : bad('relog items');
  const freeform = logMeal(db, { date: '2000-01-01', time: '08:00', name: 'Old shake', kcal: 220 });
  const copy2 = getMeal(db, relogMeal(db, freeform, TODAY, '08:30'));
  copy2 && near(copy2.kcal, 220) && copy2.name === 'Old shake' && copy2.source === 'manual'
    ? ok('free-form meal duplicated directly, source manual')
    : bad('relog freeform', JSON.stringify(copy2));
  relogMeal(db, 'no-such-meal', TODAY, null) === null
    ? ok('relog of a missing meal returns null')
    : bad('relog missing');
  // AI provenance survives a relog: an estimate stays labelled an estimate.
  const aiMeal = logMealWithItems(db, {
    date: '2000-01-02',
    time: '12:00',
    name: 'AI lunch',
    source: 'ai_suggested',
    items: [{ name: 'Estimated bowl', kcal: 500, confidence: 'medium' }],
  }).mealId;
  const aiCopy = getMeal(db, relogMeal(db, aiMeal, TODAY, '12:30'));
  aiCopy && aiCopy.source === 'ai_suggested'
    ? ok('relog of an AI-estimated meal keeps ai_suggested')
    : bad('relog ai source', aiCopy && aiCopy.source);
  raw.prepare(`UPDATE meals SET source = 'ai_suggested' WHERE id = ?`).run(freeform);
  const aiFree = getMeal(db, relogMeal(db, freeform, TODAY, '09:00'));
  aiFree && aiFree.source === 'ai_suggested'
    ? ok('free-form AI meal relog keeps provenance too')
    : bad('relog ai freeform', aiFree && aiFree.source);
}

console.log('9. recents: newest-first, carrying the last-logged portion');
{
  const { db, raw } = freshDb();
  const a = testFood(db, { name: 'Food A' });
  const b = testFood(db, { name: 'Food B' });
  const { mealId } = logMealWithItems(db, {
    date: TODAY,
    time: '08:00',
    name: 'Breakfast',
    items: [{ food_id: a, name: 'Food A', amount: 100, serving_qty: 2, kcal: 100 }],
  });
  addMealItem(db, mealId, { food_id: b, name: 'Food B', amount: 75, kcal: 75 });
  // Force distinct created_at stamps so "latest portion" is deterministic.
  raw
    .prepare('UPDATE meal_items SET created_at = ? WHERE food_id = ?')
    .run('2020-01-01T00:00:00.000Z', a);
  const later = addMealItem(db, mealId, {
    food_id: a,
    name: 'Food A',
    amount: 30,
    serving_qty: 0.5,
    kcal: 30,
  });
  raw
    .prepare('UPDATE meal_items SET created_at = ? WHERE id = ?')
    .run('2030-01-01T00:00:00.000Z', later);
  const recents = listRecentFoods(db);
  recents.length === 2 && recents[0].food.id === a
    ? ok('most recently logged food first')
    : bad('recents order', JSON.stringify(recents.map((r) => r.food.name)));
  near(recents[0].lastAmount, 30) && near(recents[0].lastServingQty, 0.5)
    ? ok('recent carries the LATEST portion, not the first')
    : bad('last portion', JSON.stringify(recents[0]));
  const orphanFood = testFood(db, { name: 'Deleted later' });
  addMealItem(db, mealId, { food_id: orphanFood, name: 'Deleted later', amount: 10, kcal: 10 });
  deleteFood(db, orphanFood);
  listRecentFoods(db).length === 2
    ? ok('items whose food is gone drop out of recents (join, no crash)')
    : bad('recents after delete');
}

console.log('10. barcode lookup against the grown local cache');
{
  const { db } = freshDb();
  const id = testFood(db, {
    name: 'Scanned bar',
    barcode: '4006381333931',
    source: 'openfoodfacts',
  });
  const hit = findFoodByBarcode(db, '4006381333931');
  hit && hit.id === id ? ok('exact barcode hit') : bad('barcode hit');
  const scanned = findFoodByBarcode(db, ' 4006381-333931 ');
  scanned && scanned.id === id
    ? ok('scanner noise (spaces/dashes) is stripped before lookup')
    : bad('barcode normalize');
  findFoodByBarcode(db, '0000000000000') === undefined
    ? ok('miss returns undefined (UI falls back to search/manual)')
    : bad('barcode miss');
}

console.log("10b. the scanner's running list — recently LOGGED barcodes (owner, 2026-08-14)");
{
  const { db, raw } = freshDb();
  // Three foods: two barcoded, one not. Only the eaten, barcoded ones may show.
  const scanned = testFood(db, {
    name: 'Scanned yoghurt',
    barcode: '4006381333931',
    source: 'openfoodfacts',
  });
  const older = testFood(db, {
    name: 'Scanned oat drink',
    barcode: '5000000000000',
    source: 'openfoodfacts',
  });
  const plain = testFood(db, { name: 'Plain rice' });
  const cachedNeverEaten = testFood(db, {
    name: 'Cached crisps',
    barcode: '5011111111111',
    source: 'openfoodfacts',
  });

  listRecentBarcodeFoods(db).length === 0
    ? ok('nothing logged yet → the list is empty (the screen draws no heading)')
    : bad('empty running list');

  const { mealId } = logMealWithItems(db, {
    date: TODAY,
    time: '08:00',
    name: 'Breakfast',
    items: [
      itemForPortion({ ...getFood(db, older), id: older }, { amount: 250 }),
      itemForPortion({ ...getFood(db, plain), id: plain }, { amount: 100 }),
    ],
  });
  const newest = addMealItem(db, mealId, {
    food_id: scanned,
    name: 'Scanned yoghurt',
    amount: 170,
    kcal: 100,
  });
  // Same-millisecond writes tie on created_at (the knowledge-base round's
  // flake), so the ordering assertion pins the timestamps explicitly.
  raw
    .prepare('UPDATE meal_items SET created_at = ? WHERE id = ?')
    .run('2030-01-01T00:00:00.000Z', newest);

  const list = listRecentBarcodeFoods(db);
  list.length === 2
    ? ok('only barcoded foods are listed — a plain catalog food is excluded')
    : bad('barcode narrowing', JSON.stringify(list.map((r) => r.food.name)));
  list[0] && list[0].food.id === scanned
    ? ok('most recently logged first')
    : bad('running-list order', JSON.stringify(list.map((r) => r.food.name)));
  near(list[0].lastAmount, 170)
    ? ok('the row carries the portion it was last logged at')
    : bad('last portion on the running list', JSON.stringify(list[0]));
  !list.some((r) => r.food.id === cachedNeverEaten)
    ? ok('a barcode cached but never eaten is NOT on the list (logged, not scanned)')
    : bad('cached-never-eaten leaked onto the running list');

  listRecentBarcodeFoods(db, 1).length === 1
    ? ok('the limit holds — a running list is not an archive')
    : bad('running-list limit');
}

console.log('11. nutrition_targets: versioned, immutable, date-resolved');
{
  const { db, raw } = freshDb();
  activeNutritionTargets(db, TODAY) === undefined
    ? ok('no targets until first set — no seeded placeholder')
    : bad('unset targets');
  throws(() => setNutritionTargets(db, { effective_date: TODAY }))
    ? ok('an all-NULL target set is rejected (at-least-one CHECK)')
    : bad('all-null targets');
  throws(() => setNutritionTargets(db, { effective_date: TODAY, kcal: 0 }))
    ? ok('kcal target of 0 rejected (> 0 CHECK)')
    : bad('zero kcal target');
  const v1 = setNutritionTargets(db, { effective_date: '2000-01-01', kcal: 2000, protein_g: 150 });
  const v2 = setNutritionTargets(db, {
    effective_date: TODAY,
    kcal: 2200,
    protein_g: 180,
    fiber_g: 30,
  });
  setNutritionTargets(db, { effective_date: '2999-01-01', kcal: 1800 });
  const active = activeNutritionTargets(db, TODAY);
  active && active.id === v2 && near(active.kcal, 2200) && near(active.fiber_g, 30)
    ? ok('active = newest effective_date <= today; future versions ignored')
    : bad('active resolution', JSON.stringify(active));
  const past = activeNutritionTargets(db, '2001-06-15');
  past && past.id === v1
    ? ok('a past day resolves to the targets of its own era')
    : bad('past resolution', JSON.stringify(past));
  // Same-day re-set: created_at breaks the tie in favour of the newer row.
  raw
    .prepare('UPDATE nutrition_targets SET created_at = ? WHERE id = ?')
    .run('2020-01-01T00:00:00.000Z', v2);
  const v3 = setNutritionTargets(db, { effective_date: TODAY, kcal: 2100 });
  raw
    .prepare('UPDATE nutrition_targets SET created_at = ? WHERE id = ?')
    .run('2030-01-01T00:00:00.000Z', v3);
  activeNutritionTargets(db, TODAY)?.id === v3
    ? ok('same-day re-set: the newer version wins')
    : bad('same-day tiebreak');
  const cols = raw
    .prepare("SELECT name FROM pragma_table_info('nutrition_targets')")
    .all()
    .map((c) => c.name);
  !cols.includes('updated_at')
    ? ok('no updated_at column — versions are immutable by design')
    : bad('immutability', JSON.stringify(cols));
  active && active.created_by === 'user'
    ? ok("created_by defaults to 'user' (the Coach will stamp 'ai')")
    : bad('created_by default');
}

console.log('12. servings helpers: per-100 g × portion, NULLs preserved');
{
  const food = {
    kcal_100g: 200,
    protein_g_100g: 20,
    carbs_g_100g: null,
    fat_g_100g: 10,
    fiber_g_100g: null,
    serving_name: '1 cup',
    serving_amount: 80,
  };
  const m = macrosForAmount(food, 50);
  near(m.kcal, 100) && near(m.protein_g, 10) && m.carbs_g === null && near(m.fat_g, 5)
    ? ok('macrosForAmount scales knowns and preserves NULLs')
    : bad('macrosForAmount', JSON.stringify(m));
  const item = itemForPortion({ ...food, id: 'f1', name: 'Cup food' }, { servingQty: 2 });
  near(item.amount, 160) &&
  near(item.serving_qty, 2) &&
  near(item.kcal, 320) &&
  item.food_id === 'f1'
    ? ok('itemForPortion builds a serving-based item (2 × 80 g)')
    : bad('itemForPortion serving', JSON.stringify(item));
  const amountItem = itemForPortion({ ...food, id: 'f1', name: 'Cup food' }, { amount: 25 });
  near(amountItem.amount, 25) && amountItem.serving_qty === null && near(amountItem.kcal, 50)
    ? ok('itemForPortion builds an amount-based item')
    : bad('itemForPortion amount', JSON.stringify(amountItem));
}

console.log('13. the 0016 seed catalog is present and sane');
{
  const { db, raw } = freshDb();
  const seeds = db.all(`SELECT * FROM foods WHERE source = 'seed'`);
  // Floor, not exact: later catalog-update migrations may append rows.
  seeds.length >= 187
    ? ok(`seed catalog present (${seeds.length} rows)`)
    : bad('seed count', seeds.length);
  raw.prepare('SELECT count(DISTINCT name_norm) c FROM foods').get().c === seeds.length
    ? ok('no duplicate names')
    : bad('dup names');
  seeds.every(
    (f) =>
      f.kcal_100g !== null &&
      f.protein_g_100g !== null &&
      f.carbs_g_100g !== null &&
      f.fat_g_100g !== null
  )
    ? ok('every seed row records kcal + all three macros')
    : bad('seed completeness');
  seeds.every((f) => f.serving_name !== null && f.serving_amount > 0)
    ? ok('every seed row has a usable household serving')
    : bad('seed servings');
  // Energy consistency: kcal should sit near 4P + 4C + 9F. Alcohol carries
  // energy Atwater can't see from macros, so those rows skip the upper bound.
  const ALCOHOL = new Set(['Beer', 'Red wine', 'White wine', 'Whiskey', 'Kombucha']);
  const derived = (f) => f.protein_g_100g * 4 + f.carbs_g_100g * 4 + f.fat_g_100g * 9;
  const lowOutliers = seeds.filter(
    (f) => !ALCOHOL.has(f.name) && f.kcal_100g < derived(f) * 0.72 - 15
  );
  lowOutliers.length === 0
    ? ok('no seed row claims materially less energy than its macros imply')
    : bad('atwater low', JSON.stringify(lowOutliers.map((f) => f.name)));
  const highOutliers = seeds.filter(
    (f) => !ALCOHOL.has(f.name) && f.kcal_100g > derived(f) * 1.35 + 25
  );
  highOutliers.length === 0
    ? ok('no seed row claims materially more energy than its macros imply (alcohol exempt)')
    : bad('atwater high', JSON.stringify(highOutliers.map((f) => f.name)));
  const microed = seeds.filter((f) => f.micros !== null);
  microed.length >= 40 &&
  microed.every((f) => {
    const m = JSON.parse(f.micros);
    return Object.entries(m).every(
      ([k, v]) => /^[a-z0-9_]+$/.test(k) && typeof v === 'number' && v >= 0
    );
  })
    ? ok(`micros JSON parses with sane keys/values (${microed.length} rows carry micros)`)
    : bad('micros sanity');
  searchFoods(db, 'chicken breast')[0]?.name === 'Chicken breast, cooked'
    ? ok('seeded staple is findable by search')
    : bad('seed search', JSON.stringify(searchFoods(db, 'chicken breast').map((f) => f.name)));
  const egg = searchFoods(db, 'egg, whole')[0] ?? searchFoods(db, 'egg whole')[0];
  egg && near(egg.serving_amount, 50)
    ? ok('seeded serving data survives round-trip (1 large egg = 50 g)')
    : bad('seed serving', JSON.stringify(egg));
}

// ===========================================================================
// 14. `ml` — a drink is logged in millilitres and stays in millilitres (0047).
//
// The arithmetic is deliberately the SAME arithmetic as grams: per-100 values
// times a portion. What is new is that the unit rides along with the number,
// all the way from the catalog food to what the screen prints — and that
// nothing anywhere converts it.
// ===========================================================================
console.log('14. ml as a unit: a drink prices, logs and reads in millilitres');
{
  const { db } = freshDb();

  // 42 kcal / 100 ml is semi-skimmed milk. A 250 ml glass is 105 kcal.
  const milk = createFood(db, {
    name: 'Milk, semi-skimmed',
    basis: 'ml',
    serving_name: '1 glass',
    serving_amount: 250,
    kcal_100g: 42,
    protein_g_100g: 3.4,
    carbs_g_100g: 4.8,
    fat_g_100g: 1.7,
    micros: JSON.stringify({ calcium_mg: 120 }),
  });
  const milkRow = getFood(db, milk);
  milkRow.basis === 'ml' && near(milkRow.serving_amount, 250)
    ? ok('a food declares its basis, and its named serving is in that basis')
    : bad('ml food', JSON.stringify(milkRow));

  const glass = itemForPortion(milkRow, { amount: 250 });
  glass.unit === 'ml' && near(glass.amount, 250) && near(glass.kcal, 105)
    ? ok('250 ml of a per-100-ml food prices to 105 kcal and carries unit ml')
    : bad('ml portion', JSON.stringify(glass));
  near(glass.protein_g, 8.5) && near(JSON.parse(glass.micros).calcium_mg, 300)
    ? ok('macros and micros scale by the same ratio — the unit changes nothing about the math')
    : bad('ml macros', JSON.stringify(glass));
  const stepped = itemForPortion(milkRow, { servingQty: 2 });
  stepped.unit === 'ml' && near(stepped.amount, 500) && near(stepped.kcal, 210)
    ? ok('and the serving stepper works in millilitres too (2 × 1 glass = 500 ml)')
    : bad('ml serving', JSON.stringify(stepped));

  // A gram food through the same code is untouched — the regression that
  // matters most, since every food that exists today is one.
  const oats = createFood(db, { name: 'Oats', kcal_100g: 379, protein_g_100g: 13 });
  const bowl = itemForPortion(getFood(db, oats), { amount: 50 });
  bowl.unit === 'g' && near(bowl.amount, 50) && near(bowl.kcal, 189.5)
    ? ok('a gram food is unchanged: 50 g of oats is 189.5 kcal, unit g')
    : bad('g portion', JSON.stringify(bowl));

  // The day's totals sum ACROSS units, because kcal is kcal whatever the
  // portion was measured in. This is the property that lets the two units
  // coexist without a conversion anywhere.
  const { mealId } = logMealWithItems(db, {
    date: '2026-09-14',
    time: '08:00',
    name: 'Breakfast',
    items: [glass, bowl],
  });
  const totals = todayTotals(db, '2026-09-14');
  near(totals.kcal, 294.5)
    ? ok('a millilitre item and a gram item sum into one day total (294.5 kcal)')
    : bad('mixed totals', JSON.stringify(totals));

  const items = listMealItems(db, mealId);
  const logged = items.find((i) => i.name === 'Milk, semi-skimmed');
  logged.unit === 'ml' && near(logged.amount, 250)
    ? ok('the unit is snapshotted on the row, beside the amount it qualifies')
    : bad('stored unit', JSON.stringify(logged));

  // Deleting the catalog food must not take the unit with it: the item is the
  // record of what was drunk, and it reads the same afterwards.
  deleteFood(db, milk);
  const orphan = listMealItems(db, mealId).find((i) => i.name === 'Milk, semi-skimmed');
  orphan.food_id === null && orphan.unit === 'ml' && near(orphan.amount, 250)
    ? ok('and it survives the food being deleted — history is not the catalog’s to rewrite')
    : bad('orphaned unit', JSON.stringify(orphan));
}

console.log('15. the suffix a portion prints, and the oz preference over ml');
{
  fmtAmount(250, 'ml') === '250 ml' && fmtAmount(150, 'g') === '150 g'
    ? ok('an amount prints with the unit it was logged in')
    : bad('fmtAmount', `${fmtAmount(250, 'ml')} / ${fmtAmount(150, 'g')}`);
  // The same preference water already honours (src/lib/log/metrics.ts owns the
  // factor; there is exactly one copy of it). 250 / 29.5735 = 8.45 → 8.5.
  fmtAmount(250, 'ml', 'oz') === '8.5 oz'
    ? ok('the oz preference converts a millilitre READING, and only the reading')
    : bad('oz preference', fmtAmount(250, 'ml', 'oz'));
  fmtAmount(150, 'g', 'oz') === '150 g'
    ? ok('a gram amount is untouched by it — the toggle is a VOLUME preference')
    : bad('grams converted by volume preference', fmtAmount(150, 'g', 'oz'));

  portionLabel({ amount: 250, unit: 'ml', serving_qty: null, food_serving_name: null }) === '250 ml'
    ? ok('portionLabel prints a bare millilitre portion')
    : bad('portionLabel ml');
  portionLabel({ amount: 330, unit: 'ml', serving_qty: 1, food_serving_name: '1 can' }) ===
  '1 × 1 can (330 ml)'
    ? ok('and a named serving states what it comes to, in millilitres')
    : bad(
        'portionLabel serving',
        portionLabel({ amount: 330, unit: 'ml', serving_qty: 1, food_serving_name: '1 can' })
      );
  portionLabel({ amount: 330, unit: 'ml', serving_qty: null, food_serving_name: null }, 'oz') ===
  '11.2 oz'
    ? ok('the preference reaches the portion label too')
    : bad(
        'portionLabel oz',
        portionLabel({ amount: 330, unit: 'ml', serving_qty: null, food_serving_name: null }, 'oz')
      );
  portionLabel({ amount: 150, unit: 'g', serving_qty: null, food_serving_name: null }) === '150 g'
    ? ok('a gram portion reads exactly as it did before 0047')
    : bad('portionLabel g');
}

console.log('16. the count of pieces, and the two vocabularies that name one (0059)');
{
  // `countLabel` is a count of a catalog SERVING and the serving's own phrase —
  // `2 × 3 slices` is six slices — and the revision request's header tail,
  // which the model reads. Unchanged by the 2026-09-23 re-cut.
  countLabel(3, 'slice') === '3 × slice'
    ? ok('countLabel is a count and the thing it counts, in one place')
    : bad('countLabel', countLabel(3, 'slice'));
  countLabel(8 / 3, 'slice') === '2.7 × slice'
    ? ok('…and keeps its decimal rather than lying')
    : bad('countLabel fraction', countLabel(8 / 3, 'slice'));

  // THE OWNER'S NOTE, 2026-09-23: "grams are still being used as the unit of
  // measurement, when it should've changed to slices". A composite's count of
  // its own pieces reads as a quantity of pieces — `3 slices` — not as the
  // `3 × slice` that read on the phone as "three times slice".
  piecesLabel(3, 'slice') === '3 slices'
    ? ok('piecesLabel reads a counted dish as a person says it: 3 slices')
    : bad('piecesLabel', piecesLabel(3, 'slice'));
  piecesLabel(1, 'slice') === '1 slice'
    ? ok('…one slice in the singular')
    : bad('piecesLabel singular', piecesLabel(1, 'slice'));
  // A third of eight slices, honestly. Rounding to 3 would print a count the
  // parts do not add up to, which is the one thing this design exists to avoid.
  piecesLabel(8 / 3, 'slice') === '2.7 slices'
    ? ok('…a fraction of a counted dish keeps its decimal, in the plural')
    : bad('piecesLabel fraction', piecesLabel(8 / 3, 'slice'));
  // The noun agrees with the number PRINTED, so a 0.95 that prints as 1 does
  // not read "1 slices".
  piecesLabel(0.95, 'slice') === '1 slice'
    ? ok('…and agrees with the number it prints, not the one it stores')
    : bad('piecesLabel agreement', piecesLabel(0.95, 'slice'));
  const plurals = [
    ['slice', 'slices'],
    ['wing', 'wings'],
    ['roll', 'rolls'],
    ['patty', 'patties'],
    ['sandwich', 'sandwiches'],
    ['glass', 'glasses'],
    ['half', 'halves'],
    ['Half', 'Halves'],
    ['potato', 'potatoes'],
    ['chicken wing', 'chicken wings'],
    ['piece of sushi', 'pieces of sushi'],
    // Already plural, or a word no rule this size reaches: left alone, because
    // `3 slicess` is worse than `3 fries`.
    ['slices', 'slices'],
    ['fries', 'fries'],
  ];
  const wrong = plurals.filter(([one, many]) => pluralNoun(one) !== many);
  wrong.length === 0
    ? ok(`pluralNoun reaches the pieces people count (${plurals.length} nouns, capitals kept)`)
    : bad('pluralNoun', wrong.map(([one]) => `${one} → ${pluralNoun(one)}`).join(', '));

  portionLabel({
    amount: 270,
    unit: 'g',
    serving_qty: 3,
    food_serving_name: null,
    piece_name: 'slice',
  }) === '3 slices (270 g)'
    ? ok('a counted composite leads with its pieces; the grams follow, secondary')
    : bad('portionLabel piece');
  // A header has no food_id, so food_serving_name is NULL on it by
  // construction — but state the precedence anyway, because the alternative is
  // a row that reads `3 × 1 egg` for a pizza.
  portionLabel({
    amount: 270,
    unit: 'g',
    serving_qty: 3,
    food_serving_name: '1 egg',
    piece_name: 'slice',
  }) === '3 slices (270 g)'
    ? ok('…and the piece noun wins over a joined serving name, never mixes with it')
    : bad('portionLabel precedence');
  portionLabel({ amount: 100, unit: 'g', serving_qty: 2, food_serving_name: '1 egg' }) ===
  '2 × 1 egg (100 g)'
    ? ok('a catalog item reads exactly as it did before 0059, off the live join')
    : bad('portionLabel serving unchanged');
  // MIXED UNITS: 0058 invariant 5 refuses to sum a fabricated amount, and the
  // count is then the only whole-dish figure the row has.
  portionLabel({
    amount: null,
    unit: 'g',
    serving_qty: 3,
    food_serving_name: null,
    piece_name: 'slice',
  }) === '3 slices'
    ? ok('a counted dish whose parts do not share a unit prints the bare count')
    : bad('portionLabel mixed units');
  portionLabel({
    amount: 270,
    unit: 'g',
    serving_qty: null,
    food_serving_name: null,
    piece_name: null,
  }) === '270 g'
    ? ok('and an uncounted composite prints the bare amount, as it always did')
    : bad('portionLabel uncounted');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
