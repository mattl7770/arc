/**
 * Headless test of the food-catalog layer — foods + meal_items (0008), the
 * versioned nutrition_targets (0009), the seed catalog (0010), and their
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
import { itemForPortion, macrosForGrams } from '../src/lib/nutrition/servings.ts';

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
    serving_grams: 50,
    kcal_100g: 100,
    protein_g_100g: 10,
    carbs_g_100g: 5,
    fat_g_100g: 2,
    fiber_g_100g: 1,
    ...overrides,
  });
}

console.log('0. migrations: 0008–0010 apply on top of the earlier set');
{
  const { raw } = freshDb();
  // user_version is the HIGHEST applied migration — >= 10 once 0010 has run
  // (assert the floor so this stays correct as later migrations land).
  const version = raw.prepare('PRAGMA user_version').get().user_version;
  version >= 10 ? ok(`user_version is ${version} (>= 10)`) : bad('user_version', version);
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
  throws(() => testFood(db, { serving_name: '1 cup', serving_grams: null }))
    ? ok('serving name without grams rejected (pair-or-none)')
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
        grams: 200,
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
        grams: 100,
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
    grams: 50,
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
    grams: 100,
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
        grams: 100,
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
        grams: 150,
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
    items: [{ food_id: a, name: 'Food A', grams: 100, serving_qty: 2, kcal: 100 }],
  });
  addMealItem(db, mealId, { food_id: b, name: 'Food B', grams: 75, kcal: 75 });
  // Force distinct created_at stamps so "latest portion" is deterministic.
  raw
    .prepare('UPDATE meal_items SET created_at = ? WHERE food_id = ?')
    .run('2020-01-01T00:00:00.000Z', a);
  const later = addMealItem(db, mealId, {
    food_id: a,
    name: 'Food A',
    grams: 30,
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
  near(recents[0].lastGrams, 30) && near(recents[0].lastServingQty, 0.5)
    ? ok('recent carries the LATEST portion, not the first')
    : bad('last portion', JSON.stringify(recents[0]));
  const orphanFood = testFood(db, { name: 'Deleted later' });
  addMealItem(db, mealId, { food_id: orphanFood, name: 'Deleted later', grams: 10, kcal: 10 });
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
    serving_grams: 80,
  };
  const m = macrosForGrams(food, 50);
  near(m.kcal, 100) && near(m.protein_g, 10) && m.carbs_g === null && near(m.fat_g, 5)
    ? ok('macrosForGrams scales knowns and preserves NULLs')
    : bad('macrosForGrams', JSON.stringify(m));
  const item = itemForPortion({ ...food, id: 'f1', name: 'Cup food' }, { servingQty: 2 });
  near(item.grams, 160) &&
  near(item.serving_qty, 2) &&
  near(item.kcal, 320) &&
  item.food_id === 'f1'
    ? ok('itemForPortion builds a serving-based item (2 × 80 g)')
    : bad('itemForPortion serving', JSON.stringify(item));
  const gramsItem = itemForPortion({ ...food, id: 'f1', name: 'Cup food' }, { grams: 25 });
  near(gramsItem.grams, 25) && gramsItem.serving_qty === null && near(gramsItem.kcal, 50)
    ? ok('itemForPortion builds a grams-based item')
    : bad('itemForPortion grams', JSON.stringify(gramsItem));
}

console.log('13. the 0010 seed catalog is present and sane');
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
  seeds.every((f) => f.serving_name !== null && f.serving_grams > 0)
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
  egg && near(egg.serving_grams, 50)
    ? ok('seeded serving data survives round-trip (1 large egg = 50 g)')
    : bad('seed serving', JSON.stringify(egg));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
