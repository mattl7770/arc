/**
 * Headless test of the barcode path — the pure Open Food Facts mapping/lookup
 * (openfoodfacts.ts) and the catalog cache (cacheBarcodeFood) — against real
 * SQLite via node:sqlite. The network is a mock fetch; op-sqlite is never
 * loaded. Mirrors db/foods.test.mjs. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { cacheBarcodeFood, findFoodByBarcode } from '../src/lib/db/repositories/foods.ts';
import {
  addMealItem,
  getMeal,
  listMealItems,
  logMealWithItems,
  updateMealName,
} from '../src/lib/db/repositories/nutrition.ts';
import { mealNameForProduct, mealNameToSave } from '../src/lib/nutrition/format.ts';
import { itemForPortion } from '../src/lib/nutrition/servings.ts';
import {
  lookupOffProduct,
  normalizeBarcode,
  offProductUrl,
  OffLookupError,
  parseOffProduct,
} from '../src/lib/nutrition/openfoodfacts.ts';
import { parseMicros } from '../src/lib/nutrition/micros.ts';

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

const GREEK_YOGURT = {
  status: 1,
  product: {
    product_name: 'Greek Yogurt',
    brands: 'Fage, Total',
    nutriments: {
      'energy-kcal_100g': 97,
      proteins_100g: 9,
      carbohydrates_100g: 4,
      fat_100g: 5,
      fiber_100g: 0,
      sodium_100g: 0.05, // 50 mg
      calcium_100g: 0.11, // 110 mg
    },
    serving_size: '170 g',
    serving_quantity: 170,
  },
};

console.log('0. normalizeBarcode + offProductUrl');
{
  normalizeBarcode(' 40063-813 ') === '40063813' ? ok('strips non-digits') : bad('normalize');
  normalizeBarcode('abc') === '' ? ok('non-numeric → empty') : bad('normalize empty');
  offProductUrl('123').startsWith('https://world.openfoodfacts.org/api/v2/product/123')
    ? ok('product URL shape')
    : bad('url', offProductUrl('123'));
}

console.log('1. parseOffProduct maps a found product to a NewFood');
{
  const f = parseOffProduct(GREEK_YOGURT, '0123456789012');
  f &&
  f.name === 'Greek Yogurt' &&
  f.brand === 'Fage' &&
  f.barcode === '0123456789012' &&
  f.serving_name === '170 g' &&
  near(f.serving_amount, 170) &&
  near(f.kcal_100g, 97) &&
  near(f.protein_g_100g, 9) &&
  near(f.carbs_g_100g, 4) &&
  near(f.fat_g_100g, 5) &&
  near(f.fiber_g_100g, 0) &&
  f.source === 'openfoodfacts'
    ? ok('name/brand/serving/macros/source mapped')
    : bad('mapping', JSON.stringify(f));
  const micros = parseMicros(f.micros);
  near(micros.sodium_mg, 50) && near(micros.calcium_mg, 110)
    ? ok('sodium + calcium converted grams → mg')
    : bad('micros', JSON.stringify(micros));
}

console.log('2. parseOffProduct rejects the unusable');
{
  parseOffProduct({ status: 0 }, '1') === null ? ok('status 0 → null') : bad('status0');
  parseOffProduct({ status: 1, product: { nutriments: {} } }, '1') === null
    ? ok('no name → null')
    : bad('noname');
  parseOffProduct('not an object', '1') === null ? ok('non-object → null') : bad('nonobject');
}

console.log('3. parseOffProduct clamps out-of-range numbers so createFood never throws');
{
  const hi = parseOffProduct(
    {
      status: 1,
      product: { product_name: 'X', nutriments: { 'energy-kcal_100g': 5000, proteins_100g: 250 } },
    },
    '1'
  );
  hi && hi.kcal_100g === null && hi.protein_g_100g === null
    ? ok('kcal > 950 and protein > 100 drop to null')
    : bad('clamp', JSON.stringify(hi));
}

console.log('4. parseOffProduct derives sodium from salt when sodium is absent');
{
  const f = parseOffProduct(
    { status: 1, product: { product_name: 'Salty', nutriments: { salt_100g: 1.25 } } },
    '1'
  );
  near(parseMicros(f.micros).sodium_mg, 500)
    ? ok('salt 1.25 g → sodium 500 mg (÷2.5 ×1000)')
    : bad('salt fallback', f.micros);
}

console.log('4b. parseOffProduct drops physically-impossible micro values (unit-entry errors)');
{
  // A contributor typing 500 into the per-100 g sodium GRAMS field → 500,000 mg.
  const f = parseOffProduct(
    {
      status: 1,
      product: { product_name: 'Bad data', nutriments: { sodium_100g: 500, calcium_100g: 0.1 } },
    },
    '1'
  );
  const m = parseMicros(f.micros);
  m.sodium_mg === undefined && near(m.calcium_mg, 100)
    ? ok('an absurd sodium is dropped; a sane calcium is kept')
    : bad('micro cap', JSON.stringify(m));
}

console.log('5. parseOffProduct: pair-or-none serving (no gram quantity → no serving)');
{
  const f = parseOffProduct(
    {
      status: 1,
      product: { product_name: 'No serving', serving_size: 'a handful', nutriments: {} },
    },
    '1'
  );
  f && f.serving_name === null && f.serving_amount === null
    ? ok('serving text without grams stores no serving')
    : bad('serving pair', JSON.stringify(f));
}

console.log('6. cacheBarcodeFood inserts and is idempotent');
{
  const { db, raw } = freshDb();
  const food = parseOffProduct(GREEK_YOGURT, '0123456789012');
  const row = cacheBarcodeFood(db, food);
  row.source === 'openfoodfacts' && row.barcode === '0123456789012' && row.name === 'Greek Yogurt'
    ? ok('caches an OFF food into the catalog')
    : bad('cache', JSON.stringify(row));
  findFoodByBarcode(db, '0123456789012')?.id === row.id
    ? ok('findFoodByBarcode now hits it offline')
    : bad('cache lookup');
  const again = cacheBarcodeFood(db, { ...food, name: 'Different name' });
  const offCount = () =>
    raw.prepare("SELECT count(*) c FROM foods WHERE source = 'openfoodfacts'").get().c;
  again.id === row.id && offCount() === 1
    ? ok('re-caching the same barcode returns the existing row, no duplicate')
    : bad('idempotent', String(offCount()));
  const scanned = cacheBarcodeFood(db, { ...food, barcode: ' 0123456789012 ' });
  scanned.id === row.id ? ok('barcode is normalized before the dup check') : bad('normalize dup');
  // A short (< 6 digit) code would trip the schema CHECK — store it as no
  // barcode instead of throwing (the food is still cached).
  const shortCoded = cacheBarcodeFood(db, {
    name: 'Short code food',
    kcal_100g: 100,
    barcode: '12345',
    source: 'user',
  });
  shortCoded.barcode === null
    ? ok('a < 6-digit code is stored as no barcode (CHECK held, no throw)')
    : bad('short barcode', shortCoded.barcode);
}

console.log('7. lookupOffProduct over a mocked fetch');
{
  const mkResponse = (ok, status, body) => ({
    ok,
    status,
    json: async () => body,
  });
  const hit = await lookupOffProduct('0123456789012', async () =>
    mkResponse(true, 200, GREEK_YOGURT)
  );
  hit && hit.name === 'Greek Yogurt' ? ok('a 200 hit maps to a NewFood') : bad('lookup hit');
  const notInOff = await lookupOffProduct('999', async () => mkResponse(true, 200, { status: 0 }));
  notInOff === null ? ok('status 0 body → null (not found)') : bad('lookup status0');
  const missing = await lookupOffProduct('999', async () => mkResponse(false, 404, {}));
  missing === null ? ok('HTTP 404 → null (not found)') : bad('lookup 404');
  let threw = false;
  try {
    await lookupOffProduct('999', async () => mkResponse(false, 500, {}));
  } catch (e) {
    threw = e instanceof OffLookupError;
  }
  threw ? ok('HTTP 500 → OffLookupError (offline/error path)') : bad('lookup 500');
  let networkThrew = false;
  try {
    await lookupOffProduct('999', async () => {
      throw new Error('offline');
    });
  } catch (e) {
    networkThrew = e instanceof OffLookupError;
  }
  networkThrew ? ok('a network throw becomes OffLookupError') : bad('lookup network');
  (await lookupOffProduct('abc', async () => mkResponse(true, 200, GREEK_YOGURT))) === null
    ? ok('a non-numeric barcode short-circuits to null (no fetch)')
    : bad('lookup non-numeric');
}

/**
 * 8. A4: what a scanned product's meal is CALLED.
 *
 * The owner's report: a barcode scan lands as a meal named "Snack". That came
 * from `daypartName(now)` — the clock's answer to a question the barcode had
 * already answered better. This pins the naming rule and the end-to-end write,
 * because "the name is set at creation" is a fact about the row, not about a
 * string function.
 */
console.log('8. A4 — a scanned product names its own meal');
{
  const food = parseOffProduct(GREEK_YOGURT, '0123456789012');

  mealNameForProduct(food, 'Snack') === 'Greek Yogurt · Fage'
    ? ok('name · brand, in the order the scanner already draws them')
    : bad('product meal name', mealNameForProduct(food, 'Snack'));
  mealNameForProduct({ name: 'Oat milk' }, 'Snack') === 'Oat milk'
    ? ok('no brand → just the product')
    : bad('brandless name');
  mealNameForProduct({ name: 'Oatly', brand: 'oatly' }, 'Snack') === 'Oatly'
    ? ok('a brand that only repeats the name is dropped')
    : bad('repeated brand');
  // meals.name is NOT NULL: a nameless product must still produce a name.
  mealNameForProduct({ name: '   ', brand: 'Fage' }, 'Lunch') === 'Lunch'
    ? ok('a blank product name falls back to the day part, never to an empty string')
    : bad('blank product name');

  // The write, as app/barcode-scan.tsx performs it on the add that creates the
  // meal — and then the rename path on top, because A4 must not cost it.
  const { db } = freshDb();
  const cached = cacheBarcodeFood(db, food);
  const { mealId } = logMealWithItems(db, {
    date: '2026-09-14',
    time: '10:15',
    name: mealNameForProduct(cached, 'Snack'),
    items: [itemForPortion(cached, { grams: 170 })],
  });
  const meal = getMeal(db, mealId);
  meal && meal.name === 'Greek Yogurt · Fage'
    ? ok('the meal row carries the product name, not the day part')
    : bad('meal name at creation', meal && meal.name);
  meal && meal.name !== 'Snack' && meal.name !== 'Breakfast'
    ? ok('and no clock-derived placeholder survives anywhere on it')
    : bad('placeholder name');
  updateMealName(db, mealId, 'Second breakfast');
  getMeal(db, mealId)?.name === 'Second breakfast'
    ? ok('renaming by hand still works over an auto-named meal')
    : bad('updateMealName after auto-naming');
}

console.log('9. B2 — a scanned DRINK is cached in millilitres (0047)');
{
  // OFF states its own answer in `nutrition_data_per`, and it is authoritative
  // for the very per-100 numbers being cached — so it is read before anything
  // is guessed from the product's name.
  const drink = parseOffProduct(
    {
      status: 1,
      product: {
        product_name: 'Oat Drink',
        brands: 'Oatly',
        nutrition_data_per: '100ml',
        serving_size: '250 ml',
        serving_quantity: 250,
        nutriments: { 'energy-kcal_100g': 46, proteins_100g: 1, carbohydrates_100g: 6.7 },
      },
    },
    '7394376616037'
  );
  drink.basis === 'ml' && near(drink.serving_amount, 250)
    ? ok('nutrition_data_per "100ml" makes it a drink, serving in ml')
    : bad('drink basis', JSON.stringify(drink));

  // The fallback: no nutrition_data_per, but the label's serving string is a
  // volume. OFF writes that string the way the package does.
  const fallback = parseOffProduct(
    {
      status: 1,
      product: {
        product_name: 'Cola',
        serving_size: '330 ml',
        serving_quantity: 330,
        nutriments: {},
      },
    },
    '5449000000996'
  );
  fallback.basis === 'ml'
    ? ok('and a volumetric serving_size is the fallback when OFF states no basis')
    : bad('serving_size fallback', JSON.stringify(fallback));

  // "serving" says nothing about a unit. A loose match would read its `g` as an
  // answer and mark a solid food as… still a solid, but for the wrong reason,
  // ignoring a serving_size that did know.
  const perServing = parseOffProduct(
    {
      status: 1,
      product: {
        product_name: 'Smoothie',
        nutrition_data_per: 'serving',
        serving_size: '250 ml',
        serving_quantity: 250,
        nutriments: {},
      },
    },
    '5060000000017'
  );
  perServing.basis === 'ml'
    ? ok('nutrition_data_per "serving" is not an answer — the serving_size still is')
    : bad('per-serving basis', JSON.stringify(perServing));

  // A solid is untouched, and a `cl` product falls back to grams rather than
  // being converted — there is no unit table in this app, by design.
  const solid = parseOffProduct(
    {
      status: 1,
      product: {
        product_name: 'Crisps',
        nutrition_data_per: '100g',
        serving_size: '30 g',
        serving_quantity: 30,
        nutriments: {},
      },
    },
    '5000000000001'
  );
  const cl = parseOffProduct(
    {
      status: 1,
      product: {
        product_name: 'Beer',
        serving_size: '33 cl',
        serving_quantity: 33,
        nutriments: {},
      },
    },
    '5000000000002'
  );
  solid.basis === 'g' && cl.basis === 'g'
    ? ok('a solid stays g, and a `cl` product falls back to g rather than converting')
    : bad('solid/cl basis', `${solid.basis} / ${cl.basis}`);
}

console.log('10. 2026-09-23 — a meal of several scans can be named before it is left');
{
  // The owner, from the device: "meal name for scanning multiple foods". The
  // field is prefilled with the name the meal has; what is typed is written
  // only when it changes something, so the quick path writes nothing.
  mealNameToSave(null, 'Greek Yogurt · Fage') === null
    ? ok('an untouched field writes nothing — the first product’s name stands')
    : bad('untouched');
  mealNameToSave('   ', 'Greek Yogurt · Fage') === null
    ? ok('an emptied field writes nothing — a meal keeps its name')
    : bad('emptied');
  mealNameToSave(' Greek Yogurt · Fage ', 'Greek Yogurt · Fage') === null
    ? ok('the name it already has, re-typed, writes nothing')
    : bad('same name');
  mealNameToSave('  Breakfast ', 'Greek Yogurt · Fage') === 'Breakfast'
    ? ok('a typed name is trimmed and written')
    : bad('typed name', String(mealNameToSave('  Breakfast ', 'Greek Yogurt · Fage')));

  // The session as app/barcode-scan.tsx runs it: the first add creates the
  // meal named after its product, the second add joins it, and the name field
  // commits through the meal screen's own rename.
  const { db } = freshDb();
  const yogurt = cacheBarcodeFood(db, parseOffProduct(GREEK_YOGURT, '0123456789012'));
  const created = mealNameForProduct(yogurt, 'Breakfast');
  const { mealId } = logMealWithItems(db, {
    date: '2026-09-23',
    time: '08:05',
    name: created,
    items: [itemForPortion(yogurt, { amount: 170 })],
  });
  addMealItem(db, mealId, itemForPortion(yogurt, { amount: 50 }));
  const untouched = mealNameToSave(null, created);
  if (untouched !== null) updateMealName(db, mealId, untouched);
  getMeal(db, mealId)?.name === 'Greek Yogurt · Fage' && listMealItems(db, mealId).length === 2
    ? ok('two scans, Done untouched: one meal, two items, still named after the first product')
    : bad('untouched session', getMeal(db, mealId)?.name);
  const typed = mealNameToSave('Breakfast', created);
  if (typed !== null) updateMealName(db, mealId, typed);
  const meal = getMeal(db, mealId);
  meal?.name === 'Breakfast' && meal.time === '08:05' && listMealItems(db, mealId).length === 2
    ? ok('named at Done: the meal is “Breakfast”, its time and items untouched')
    : bad('typed session', JSON.stringify(meal));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
