/**
 * Headless test of the barcode path — the pure Open Food Facts mapping/lookup
 * (openfoodfacts.ts) and the catalog cache (cacheBarcodeFood) — against real
 * SQLite via node:sqlite. The network is a mock fetch; op-sqlite is never
 * loaded. Mirrors db/foods.test.mjs. Run: npm run db:test.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  cacheBarcodeFood,
  createFood,
  findFoodByBarcode,
  getFood,
  refreshOffFood,
  updateFood,
} from '../src/lib/db/repositories/foods.ts';
import {
  addMealItem,
  dayMicroTotals,
  getMeal,
  listMealItems,
  logMealWithItems,
  updateMealName,
} from '../src/lib/db/repositories/nutrition.ts';
import { keyMicroLabel } from '../src/lib/nutrition/key-micro.ts';
import { mealNameForProduct, mealNameToSave } from '../src/lib/nutrition/format.ts';
import { commitScanMealName, offersScanMealName } from '../src/lib/nutrition/scan-meal-name.ts';
import { itemForPortion, portionAfterHeal } from '../src/lib/nutrition/servings.ts';
import { foodFormFromRow, readFoodForm } from '../src/lib/nutrition/food-form.ts';
import {
  lookupOffProduct,
  normalizeBarcode,
  offProductUrl,
  OffLookupError,
  drinkLooksPerServing,
  energyLooksWrong,
  readOffProduct,
  servingSizeMeasure,
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
  hit?.kind === 'food' && hit.food.name === 'Greek Yogurt'
    ? ok('a 200 hit maps to a reading carrying the NewFood')
    : bad('lookup hit');
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

  // A solid is untouched. A `cl` product is a VOLUME (2026-10-21; it used to
  // fall back to grams): recognising a unit is not converting a figure. Its
  // serving of "33" does not agree with 33 cl (330 ml), so it is left off.
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
  solid.basis === 'g' && cl.basis === 'ml' && cl.serving_amount === null && cl.serving_name === null
    ? ok('a solid stays g; a `33 cl` product is a volume (ml), and a quantity of 33 that does not agree with 33 cl is left off, not converted')
    : bad('solid/cl basis', `${solid.basis} / ${cl.basis} / ${cl.serving_amount}`);
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

  // WHEN the field is offered — the screen's own gate.
  !offersScanMealName(null, 5) &&
  !offersScanMealName('Greek Yogurt · Fage', 1) &&
  offersScanMealName('Greek Yogurt · Fage', 2)
    ? ok('the field appears at the second food, and never for a meal passed in by id')
    : bad('offersScanMealName');

  // The session as app/barcode-scan.tsx runs it: the first add creates the
  // meal named after its product, the second add joins it, and the name field
  // commits through commitScanMealName — the function the screen calls.
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
  const nameRow = () => JSON.stringify(getMeal(db, mealId));
  const untouched = nameRow();
  commitScanMealName(db, mealId, null) === null &&
  nameRow() === untouched &&
  getMeal(db, mealId)?.name === 'Greek Yogurt · Fage' &&
  listMealItems(db, mealId).length === 2
    ? ok(
        'two scans, Done untouched: one meal, two items, still named after the first product — no write'
      )
    : bad('untouched session', getMeal(db, mealId)?.name);
  const written = commitScanMealName(db, mealId, ' Breakfast ');
  const meal = getMeal(db, mealId);
  written === 'Breakfast' &&
  meal?.name === 'Breakfast' &&
  meal.time === '08:05' &&
  listMealItems(db, mealId).length === 2
    ? ok('named at Done: the meal is “Breakfast”, its time and items untouched')
    : bad('typed session', JSON.stringify(meal));
  // Done commits, then the unmount right after it commits again from a render
  // that still holds the typed draft: compared with the STORED name, the second
  // writes nothing.
  const afterDone = nameRow();
  commitScanMealName(db, mealId, 'Breakfast') === null && nameRow() === afterDone
    ? ok('the unmount after Done writes nothing a second time — the stored name already reads it')
    : bad('double commit');
  commitScanMealName(db, 'no-such-meal', 'Lunch') === null
    ? ok('a meal gone by then is left alone, not an error')
    : bad('missing meal');

  // THE WIRING — the screen decides nothing itself: it shows the field behind
  // offersScanMealName and commits through commitScanMealName, on Done, when
  // the field is left, and on unmount.
  const screen = readFileSync(new URL('../app/barcode-scan.tsx', import.meta.url), 'utf8');
  const doneAt = screen.indexOf('const done = () => {');
  const doneBody = screen.slice(doneAt, screen.indexOf('};', doneAt));
  screen.includes('offersScanMealName(createdName, added)') &&
  screen.includes('commitScanMealName(getDb(), targetMealId, nameDraft)') &&
  doneBody.indexOf('commitName()') > -1 &&
  doneBody.indexOf('commitName()') < doneBody.indexOf('router.dismiss(doneDismissCount(via))') &&
  screen.includes('useEffect(() => () => commitNameRef.current(), [])') &&
  screen.includes('onPress={done}') &&
  screen.includes('onCommit={commitName}') &&
  !screen.includes('updateMealName(')
    ? ok(
        'barcode-scan: the field is gated and committed by these functions — Done, leaving the field, leaving the screen'
      )
    : bad('barcode-scan wiring');
}

console.log('11. 2026-09-23 — a scanned product keeps its caffeine');
{
  // The owner's example was a latte; a scanned energy drink or cold brew is the
  // same fact, and the mapping used to drop it. OFF normalises every mass
  // nutrient's `_100g` into GRAMS — a label's 32 mg per 100 ml arrives as
  // 0.032 — so it converts to milligrams exactly as sodium does.
  const energy = parseOffProduct(
    {
      status: 1,
      product: {
        product_name: 'Energy drink',
        nutrition_data_per: '100ml',
        serving_size: '250 ml',
        serving_quantity: 250,
        nutriments: {
          'energy-kcal_100g': 45,
          carbohydrates_100g: 11,
          sodium_100g: 0.08,
          caffeine_100g: 0.032,
          caffeine_unit: 'mg',
          caffeine_value: 32,
        },
      },
    },
    '9002490100070'
  );
  const m = parseMicros(energy.micros);
  near(m.caffeine_mg, 32) && near(m.sodium_mg, 80) && energy.basis === 'ml'
    ? ok('caffeine_100g 0.032 g → 32 mg per 100 ml, beside the sodium, on a ml product')
    : bad('caffeine mapping', JSON.stringify(energy));

  // Through the catalog to the day: cached, logged at its 250 ml serving, and
  // read by the Eat tab's Caffeine cell and the item row.
  const { db } = freshDb();
  const cached = cacheBarcodeFood(db, energy);
  const item = itemForPortion(cached, { servingQty: 1 });
  near(parseMicros(item.micros).caffeine_mg, 80)
    ? ok('one 250 ml can carries 80 mg')
    : bad('portion caffeine', item.micros);
  const { mealId } = logMealWithItems(db, {
    date: '2026-09-23',
    time: '15:00',
    name: 'Energy drink',
    items: [item],
  });
  const logged = listMealItems(db, mealId)[0];
  near(dayMicroTotals(db, '2026-09-23').caffeine_mg, 80) &&
  keyMicroLabel(logged) === '80 mg caffeine'
    ? ok('…the day reads 80 mg of caffeine, and the row says “80 mg caffeine”')
    : bad(
        'day / row',
        `${JSON.stringify(dayMicroTotals(db, '2026-09-23'))} / ${keyMicroLabel(logged)}`
      );

  // The unit error the ceiling exists for: the milligram figure typed into the
  // grams field. 32 g of caffeine per 100 ml is 32,000 mg — under the generic
  // 50,000 ceiling, and a can of it would read 80,000 mg on the day.
  const typo = parseOffProduct(
    { status: 1, product: { product_name: 'Typo', nutriments: { caffeine_100g: 32 } } },
    '1'
  );
  parseMicros(typo.micros).caffeine_mg === undefined
    ? ok('a milligram figure in the grams field (32 → 32,000 mg) is dropped, not cached')
    : bad('caffeine ceiling', typo.micros);
  // The densest real food stays: instant coffee powder, ~3,142 mg per 100 g.
  const instant = parseOffProduct(
    { status: 1, product: { product_name: 'Instant', nutriments: { caffeine_100g: 3.142 } } },
    '1'
  );
  near(parseMicros(instant.micros).caffeine_mg, 3142)
    ? ok('instant coffee’s 3,142 mg per 100 g is kept — the ceiling is a tenth, not a guess')
    : bad('instant coffee', instant.micros);
  // Absent, negative or text is not recorded — never a 0.
  const none = [undefined, -0.01, '0.03'].map(
    (v) =>
      parseMicros(
        parseOffProduct(
          {
            status: 1,
            product: {
              product_name: 'X',
              nutriments: v === undefined ? {} : { caffeine_100g: v },
            },
          },
          '1'
        ).micros
      ).caffeine_mg
  );
  none.every((v) => v === undefined)
    ? ok('no caffeine_100g, a negative one, or a string records nothing — not 0')
    : bad('absent caffeine', JSON.stringify(none));
}

/**
 * 12. Item 81 (owner, 2026-10-21): "barcode scanner for food logging
 * misinterprets per serving and per 100g / other sometimes."
 *
 * The case that came with it: Lewis Road Creamery Fresh Chocolate Milk,
 * 9421903483058, 750 ml. Two 250 ml servings logged 1,660 kcal, because the
 * cached row's "per 100" figures were the label's per-serving ones (332 kcal,
 * P 10.8, C 31, F 18.4) in grams. LEWIS_ROAD_LIVE is OFF's response as of
 * 2026-10-21 (the fields OFF_FIELDS asks for); the others are the shapes the
 * entry has been in, and the shapes the mapping must refuse or flag. No
 * network anywhere: every payload is a fixture.
 */
const LEWIS_ROAD_LIVE = {
  status: 1,
  product: {
    product_name: 'Fresh Chocolate Milk',
    brands: 'Lewis Road Creamery',
    nutrition_data_per: '100ml',
    serving_size: '0.33 of bottle (250 ml)',
    serving_quantity: 250,
    nutriments: {
      'energy-kcal_100g': 132.887,
      proteins_100g: 4.32,
      carbohydrates_100g: 12.4,
      fat_100g: 7.32,
      'energy-kcal_serving': 332,
      proteins_serving: 10.8,
      carbohydrates_serving: 31,
      fat_serving: 18.3,
    },
  },
};
const withNutriments = (base, nutriments, extra = {}) => ({
  ...base,
  product: { ...base.product, ...extra, nutriments },
});

console.log('12. Item 81 — per 100, per serving, and what each is measured in');
{
  // (a) TODAY'S ENTRY reads right: per 100 ml, a 250 ml serving, nothing flagged.
  const live = readOffProduct(LEWIS_ROAD_LIVE, '9421903483058');
  const f = live?.food;
  live?.kind === 'food' &&
  f.basis === 'ml' &&
  f.serving_amount === 250 &&
  near(f.kcal_100g, 132.887) &&
  near(f.fat_g_100g, 7.32) &&
  live.label.read === 'per100' &&
  live.label.doubtful === false &&
  live.label.servingDropped === null
    ? ok('the live Lewis Road entry: 132.9 kcal per 100 ml, a 250 ml serving, not doubtful')
    : bad('live entry', JSON.stringify(live));
  const { db } = freshDb();
  const cached = cacheBarcodeFood(db, f);
  const two = itemForPortion(cached, { servingQty: 2 });
  near(two.amount, 500) && Math.round(two.kcal) === 664 && two.unit === 'ml'
    ? ok('…and two servings are 500 ml and 664 kcal — not the 1,660 the owner saw')
    : bad('two servings', JSON.stringify(two));

  // (b) THE BAD ENTRY: the per-serving figures typed into the per-100 column.
  // `_100g` ≈ `_serving` with a 250 ml serving — rebuilt per 100 from them.
  const swapped = readOffProduct(
    withNutriments(LEWIS_ROAD_LIVE, {
      'energy-kcal_100g': 332,
      proteins_100g: 10.8,
      carbohydrates_100g: 31,
      fat_100g: 18.4,
      sodium_100g: 0.125,
      'energy-kcal_serving': 332,
      proteins_serving: 10.8,
      carbohydrates_serving: 31,
      fat_serving: 18.3,
      sodium_serving: 0.125,
    }),
    '9421903483058'
  );
  swapped?.kind === 'food' &&
  near(swapped.food.kcal_100g, 132.8) &&
  near(swapped.food.protein_g_100g, 4.32) &&
  near(swapped.food.fat_g_100g, 7.32) &&
  near(parseMicros(swapped.food.micros).sodium_mg, 50) &&
  swapped.label.read === 'rescaled' &&
  swapped.label.doubtful === false
    ? ok('per-serving figures in the per-100 column are rebuilt per 100 ml (332 → 132.8 kcal), micros too')
    : bad('swapped columns', JSON.stringify(swapped));

  // (c) NEITHER FITS (the search index's fat_100g 73): keep _100g, flag it.
  const messy = readOffProduct(
    withNutriments(LEWIS_ROAD_LIVE, { ...LEWIS_ROAD_LIVE.product.nutriments, fat_100g: 73 }),
    '9421903483058'
  );
  messy?.kind === 'food' && near(messy.food.fat_g_100g, 73) && messy.label.doubtful === true
    ? ok('two sets that cannot both be true keep OFF’s per-100 figures and are marked doubtful')
    : bad('conflict', JSON.stringify(messy));

  // (d) PER SERVING ONLY, with a serving in the food's own unit: divided here.
  const bar = readOffProduct(
    {
      status: 1,
      product: {
        product_name: 'Protein bar',
        brands: 'Bar Co',
        nutrition_data_per: 'serving',
        serving_size: '1 bar (40 g)',
        serving_quantity: 40,
        serving_quantity_unit: 'g',
        nutriments: {
          'energy-kcal_serving': 156,
          proteins_serving: 20,
          carbohydrates_serving: 14,
          fat_serving: 5,
        },
      },
    },
    '5000000000040'
  );
  bar?.kind === 'food' &&
  bar.food.basis === 'g' &&
  near(bar.food.kcal_100g, 390) &&
  near(bar.food.protein_g_100g, 50) &&
  bar.label.read === 'serving'
    ? ok('per-serving-only figures are divided by the 40 g serving (156 → 390 kcal per 100 g)')
    : bad('per-serving only', JSON.stringify(bar));

  // (e) …and with no serving to divide by, the product is REFUSED, named.
  const mystery = {
    status: 1,
    product: {
      product_name: 'Mystery bar',
      brands: 'Somebody, Else',
      serving_size: '1 bar',
      nutriments: { 'energy-kcal_serving': 200, proteins_serving: 10 },
    },
  };
  const unplaced = readOffProduct(mystery, '5000000000041');
  unplaced?.kind === 'refused' &&
  unplaced.name === 'Mystery bar' &&
  unplaced.brand === 'Somebody' &&
  /per serving only/.test(unplaced.reason) &&
  parseOffProduct(mystery, '5000000000041') === null
    ? ok('per-serving figures with nothing to read them against are refused (name and brand kept for manual entry)')
    : bad('unplaced', JSON.stringify(unplaced));

  // (f) A DRINK whose figures OFF holds per 100 g, with a 330 ml serving: the
  // serving is in a different unit, so it is left off — never a "330 g" can.
  const can = readOffProduct(
    {
      status: 1,
      product: {
        product_name: 'Sparkling tea',
        nutrition_data_per: '100g',
        serving_size: '1 can (330 ml)',
        serving_quantity: 330,
        serving_quantity_unit: 'ml',
        nutriments: { 'energy-kcal_100g': 20, carbohydrates_100g: 5 },
      },
    },
    '5000000000042'
  );
  can?.kind === 'food' &&
  can.food.basis === 'g' &&
  can.food.serving_amount === null &&
  can.food.serving_name === null &&
  /330 ml but its figures are per 100 g/.test(can.label.servingDropped ?? '')
    ? ok('a 330 ml serving on per-100 g figures is left off, and the review says why')
    : bad('ml serving on g figures', JSON.stringify(can));

  // (g) "250ml" — no space — is millilitres. The old `\bml\b` never matched it.
  const tight = parseOffProduct(
    {
      status: 1,
      product: {
        product_name: 'Iced coffee',
        serving_size: '250ml',
        serving_quantity: 250,
        nutriments: { 'energy-kcal_100g': 60 },
      },
    },
    '5000000000043'
  );
  const m = (s) => JSON.stringify(servingSizeMeasure(s));
  tight.basis === 'ml' &&
  tight.serving_amount === 250 &&
  m('250ml') === '{"unit":"ml","amount":250}' &&
  m('(250 ml)') === '{"unit":"ml","amount":250}' &&
  m('0.33 of bottle (250 ml)') === '{"unit":"ml","amount":250}' &&
  m('33 cl') === '{"unit":"ml","amount":330}' &&
  m('30g') === '{"unit":"g","amount":30}' &&
  servingSizeMeasure('250mlg') === null &&
  servingSizeMeasure('1 bar') === null
    ? ok('"250ml", "(250 ml)", "33 cl" and "30g" are measured; "250mlg" and "1 bar" are not')
    : bad('serving measure', `${tight.basis} ${m('250ml')} ${m('250mlg')}`);

  // (h) Energy given only in kJ is read as kJ ÷ 4.184.
  const kj = parseOffProduct(
    {
      status: 1,
      product: {
        product_name: 'Crackers',
        nutrition_data_per: '100g',
        nutriments: {
          'energy-kj_100g': 1757.28,
          proteins_100g: 10,
          carbohydrates_100g: 70,
          fat_100g: 12,
        },
      },
    },
    '5000000000044'
  );
  near(kj.kcal_100g, 420)
    ? ok('kJ only: 1,757 kJ per 100 g reads as 420 kcal')
    : bad('kJ fallback', String(kj.kcal_100g));

  // (i) ENERGY AGAINST THE MACROS: 4P + 4C + 9F more than 35 % off is doubtful.
  const odd = readOffProduct(
    {
      status: 1,
      product: {
        product_name: 'Odd',
        nutrition_data_per: '100g',
        nutriments: {
          'energy-kcal_100g': 50,
          proteins_100g: 10,
          carbohydrates_100g: 10,
          fat_100g: 10,
        },
      },
    },
    '5000000000045'
  );
  const row = (kcal, p, c, fat) => ({
    kcal_100g: kcal,
    protein_g_100g: p,
    carbs_g_100g: c,
    fat_g_100g: fat,
  });
  odd?.label.doubtful === true &&
  energyLooksWrong(row(50, 10, 10, 10)) &&
  !energyLooksWrong(row(132.887, 4.32, 12.4, 7.32)) &&
  !energyLooksWrong(row(15, 0, 0, 5)) &&
  !energyLooksWrong(row(100, null, 10, 2))
    ? ok('energy 35 % off its macros is doubtful; the live chocolate milk is not; small or partial rows are not judged')
    : bad('energy plausibility', JSON.stringify(odd?.label));

  // (j) A per-serving figure that divides to more than the food weighs is a
  // wrong serving size — refused, not cached.
  const tooDense = readOffProduct(
    {
      status: 1,
      product: {
        product_name: 'Dense',
        serving_size: '5 g',
        serving_quantity: 5,
        nutriments: { 'energy-kcal_serving': 200, proteins_serving: 10 },
      },
    },
    '5000000000046'
  );
  tooDense?.kind === 'refused' && /more than the food itself/.test(tooDense.reason)
    ? ok('per-serving figures that exceed the serving itself are refused')
    : bad('too dense', JSON.stringify(tooDense));

  // (k) A lookup over a mocked fetch carries the same reading.
  const looked = await lookupOffProduct('9421903483058', async () => ({
    ok: true,
    status: 200,
    json: async () => LEWIS_ROAD_LIVE,
  }));
  looked?.kind === 'food' && looked.food.basis === 'ml' && looked.label.read === 'per100'
    ? ok('lookupOffProduct returns the reading, label included (mocked fetch)')
    : bad('lookup reading', JSON.stringify(looked));
}

console.log('13. Item 81 — the cache heals, and never over a correction');
{
  const { db } = freshDb();
  // HIS ROW, as cached before this round: per-serving figures as per-100, in g.
  const id = createFood(db, {
    name: 'Fresh Chocolate Milk',
    brand: 'Lewis Road Creamery',
    barcode: '9421903483058',
    serving_name: '250ml',
    serving_amount: 250,
    basis: 'g',
    kcal_100g: 332,
    protein_g_100g: 10.8,
    carbs_g_100g: 31,
    fat_g_100g: 18.4,
    source: 'openfoodfacts',
  });
  // A meal logged from it before the heal keeps its own snapshot.
  const before = itemForPortion(getFood(db, id), { servingQty: 2 });
  const { mealId } = logMealWithItems(db, {
    date: '2026-10-20',
    time: '15:00',
    name: 'Chocolate milk',
    items: [before],
  });
  const fresh = readOffProduct(LEWIS_ROAD_LIVE, '9421903483058').food;
  const healed = refreshOffFood(db, id, fresh);
  healed &&
  healed.basis === 'ml' &&
  near(healed.kcal_100g, 132.887) &&
  healed.serving_amount === 250 &&
  healed.source === 'openfoodfacts' &&
  healed.barcode === '9421903483058'
    ? ok('a re-read heals his row: per 100 ml, 132.9 kcal, still OFF’s, same barcode')
    : bad('heal', JSON.stringify(healed));
  Math.round(listMealItems(db, mealId)[0].kcal) === 1660
    ? ok('…and the meal logged before keeps its own figures (1,660), as after any catalog edit')
    : bad('snapshot', String(listMealItems(db, mealId)[0].kcal));
  refreshOffFood(db, id, fresh) === null
    ? ok('a second read that says the same thing writes nothing')
    : bad('idempotent heal');

  // A CORRECTION IS NEVER OVERWRITTEN. An edit through updateFood — the edit
  // screen's and the Coach's one writer — makes the row the user's.
  updateFood(db, id, { ...getFood(db, id), kcal_100g: 140 });
  const other = readOffProduct(
    withNutriments(LEWIS_ROAD_LIVE, {
      ...LEWIS_ROAD_LIVE.product.nutriments,
      'energy-kcal_100g': 120,
      'energy-kcal_serving': 300,
    }),
    '9421903483058'
  ).food;
  getFood(db, id).source === 'user' &&
  refreshOffFood(db, id, other) === null &&
  getFood(db, id).kcal_100g === 140
    ? ok('an edited OFF row becomes the user’s, and a re-read leaves the correction alone')
    : bad('edited row', JSON.stringify(getFood(db, id)));

  // THE WIRING: a local hit (and a recents tap) opens at once and re-reads in
  // the background only through refreshOffFood.
  const screen = readFileSync(new URL('../app/barcode-scan.tsx', import.meta.url), 'utf8');
  screen.includes("if (food.source !== 'openfoodfacts' || !food.barcode) return;") &&
  screen.includes('const healed = refreshOffFood(getDb(), food.id, off.food);') &&
  // Three: a local hit, a recents tap, and the restart after an edit (§14).
  (screen.match(/void refreshFromOff\(/g) || []).length === 3 &&
  screen.includes('openPortion(local, false);')
    ? ok('barcode-scan: a local hit and a recents tap open at once and heal in the background')
    : bad('refresh wiring');
}

/**
 * 14. The 2026-10-21 review of item 81, each finding proved on real SQLite
 * first (review/r3/probe1.mjs). Fixtures only — no network.
 */
console.log('14. Item 81 review — a late heal, a single small figure, alcohol and polyols');
{
  // (a) AN EDIT OPENED BEFORE THE HEAL LANDS (probe T1). The form is read from
  // the stale row; the heal lands; Save must not write the stale figures back.
  const { db } = freshDb();
  const id = createFood(db, {
    name: 'Fresh Chocolate Milk',
    brand: 'Lewis Road Creamery',
    barcode: '9421903483058',
    serving_name: '250ml',
    serving_amount: 250,
    basis: 'g',
    kcal_100g: 332,
    protein_g_100g: 10.8,
    carbs_g_100g: 31,
    fat_g_100g: 18.4,
    source: 'openfoodfacts',
  });
  const editing = getFood(db, id);
  const opened = foodFormFromRow(editing);
  refreshOffFood(db, id, readOffProduct(LEWIS_ROAD_LIVE, '9421903483058').food);
  const form = readFoodForm(
    { ...opened, kcal: '133' },
    { barcode: editing.barcode, source: editing.source, original: { food: editing, form: opened } }
  );
  const wrote = updateFood(db, id, form.food, editing);
  const after = getFood(db, id);
  wrote === false &&
  after.basis === 'ml' &&
  near(after.kcal_100g, 132.887) &&
  after.source === 'openfoodfacts'
    ? ok('a Save from a form opened before the heal is refused: the healed row stands, still OFF’s')
    : bad('stale edit', JSON.stringify({ wrote, after }));
  const changedAgain = readOffProduct(
    withNutriments(LEWIS_ROAD_LIVE, {
      ...LEWIS_ROAD_LIVE.product.nutriments,
      'energy-kcal_100g': 120,
      'energy-kcal_serving': 300,
    }),
    '9421903483058'
  ).food;
  refreshOffFood(db, id, changedAgain)?.kcal_100g === 120
    ? ok('…so later heals are not blocked (the probe’s save had made the row the user’s)')
    : bad('heal after refusal');
  // Reopened, it saves; a row whose stamp moved with the same contents refuses.
  const reopened = getFood(db, id);
  const reForm = foodFormFromRow(reopened);
  const ok2 = updateFood(
    db,
    id,
    readFoodForm(
      { ...reForm, kcal: '125' },
      { barcode: reopened.barcode, source: reopened.source, original: { food: reopened, form: reForm } }
    ).food,
    reopened
  );
  const stamped = getFood(db, id);
  // A write that changes no content but moves the stamp (a star, say). The
  // trigger stamps `now` at millisecond grain, so let the clock tick first.
  const t0 = Date.now();
  while (Date.now() - t0 < 5) {
    /* spin */
  }
  db.run('UPDATE foods SET is_favorite = is_favorite WHERE id = ?', [id]);
  ok2 === true &&
  stamped.kcal_100g === 125 &&
  stamped.source === 'user' &&
  updateFood(db, id, { ...stamped, kcal_100g: 1 }, stamped) === false &&
  updateFood(db, 'no-such-food', { name: 'x' }, stamped) === false
    ? ok('a fresh form saves; a moved stamp or a vanished row refuses; the Coach (no expected) is unchanged')
    : bad('cas', JSON.stringify(stamped));
  const screen = readFileSync(new URL('../app/food-new.tsx', import.meta.url), 'utf8');
  screen.includes('if (!updateFood(getDb(), editing.id, result.food, editing)) {') &&
  screen.includes('This food changed while you were editing — reopen it.')
    ? ok('food-new: Save is a compare-and-swap against the row as it opened, and says so in a sentence')
    : bad('cas wiring');

  // (b) ONE SMALL FIGURE NO LONGER TRIPS A SWAP (probe T4): energy, carbs and
  // fat are consistent, so protein 0.5 ≈ 1 vetoes nothing into a rescale; and
  // fibre and sodium, which have no _serving, are never divided.
  const oat = readOffProduct(
    {
      status: 1,
      product: {
        product_name: 'Oat drink',
        nutrition_data_per: '100ml',
        serving_size: '500 ml',
        serving_quantity: 500,
        serving_quantity_unit: 'ml',
        nutriments: {
          'energy-kcal_100g': 42,
          'energy-kcal_serving': 210,
          carbohydrates_100g: 6.6,
          carbohydrates_serving: 33,
          fat_100g: 1.5,
          fat_serving: 7.5,
          proteins_100g: 0.5,
          proteins_serving: 1,
          fiber_100g: 0.8,
          sodium_100g: 0.04,
        },
      },
    },
    '5000000000100'
  );
  oat.label.read === 'per100' &&
  oat.food.kcal_100g === 42 &&
  oat.food.protein_g_100g === 0.5 &&
  oat.food.fiber_g_100g === 0.8 &&
  near(parseMicros(oat.food.micros).sodium_mg, 40)
    ? ok('a consistent oat drink is read per 100 as given — fibre 0.8, sodium 40, not divided by 5')
    : bad('one small figure', JSON.stringify(oat));
  // A true swap still rebuilds — and a figure with no _serving is left as given.
  const swapped = readOffProduct(
    withNutriments(LEWIS_ROAD_LIVE, {
      'energy-kcal_100g': 332,
      proteins_100g: 10.8,
      carbohydrates_100g: 31,
      fat_100g: 18.4,
      fiber_100g: 0.5,
      'energy-kcal_serving': 332,
      proteins_serving: 10.8,
      carbohydrates_serving: 31,
      fat_serving: 18.3,
    }),
    '9421903483058'
  );
  swapped.label.read === 'rescaled' &&
  near(swapped.food.kcal_100g, 132.8) &&
  swapped.food.fiber_g_100g === 0.5
    ? ok('the owner’s swapped entry is still rebuilt; its fibre, with no _serving, is not divided')
    : bad('swap with lone figure', JSON.stringify(swapped));

  // (c) IDENTICAL COLUMNS are ambiguous (probe T7b): kept, and doubtful.
  const pot = readOffProduct(
    {
      status: 1,
      product: {
        product_name: 'Yogurt pot',
        nutrition_data_per: '100g',
        serving_size: '125 g',
        serving_quantity: 125,
        nutriments: {
          'energy-kcal_100g': 97,
          'energy-kcal_serving': 97,
          proteins_100g: 9,
          proteins_serving: 9,
          carbohydrates_100g: 4,
          carbohydrates_serving: 4,
          fat_100g: 5,
          fat_serving: 5,
        },
      },
    },
    '5000000000102'
  );
  pot.label.read === 'per100' && pot.food.kcal_100g === 97 && pot.label.doubtful === true
    ? ok('a 125 g pot with identical columns keeps 97 per 100 g and is marked doubtful, not rescaled')
    : bad('ambiguous', JSON.stringify(pot));

  // (d) ALCOHOL AND POLYOLS (probe T5, T8). Correct labels are not flagged.
  const r = (k, p, c, f, fiber = null, basis = 'g') => ({
    basis,
    kcal_100g: k,
    protein_g_100g: p,
    carbs_g_100g: c,
    fat_g_100g: f,
    fiber_g_100g: fiber,
  });
  !energyLooksWrong(r(43, 0.5, 3.6, 0, null, 'ml')) &&
  !energyLooksWrong(r(83, 0.1, 2.6, 0, null, 'ml')) &&
  !energyLooksWrong(r(231, 0, 0, 0, null, 'ml')) &&
  !energyLooksWrong(r(43, 0.5, 3.6, 0, null, 'ml'), { abv: 4.5 }) &&
  !energyLooksWrong(r(240, 0, 98, 0), { polyols: 95 }) &&
  !energyLooksWrong(r(260, 13, 74, 5, 29))
    ? ok('beer, wine and vodka (alcohol unknown or known), a polyol mint and a US-label bran cereal read clean')
    : bad('false flags');
  energyLooksWrong(r(240, 0, 98, 0)) &&
  energyLooksWrong(r(43, 0.5, 3.6, 0), { abv: 40 }) &&
  energyLooksWrong(r(300, 1, 2, 0), { abv: 0 }) &&
  energyLooksWrong(r(50, 10, 10, 10))
    ? ok('macros that over-shoot, or an under-shoot alcohol cannot explain, are still flagged')
    : bad('true flags');

  // (d2) 2026-10-21 fix round. A SOLID whose macros under-shoot its energy is
  // a typo again — unknown alcohol excuses only a drink, or a product listing
  // an alcohol figure; a US high-fibre label's low estimate counts fibre at 0;
  // and a stored row (no polyols kept) is not flagged for carbohydrate alone.
  energyLooksWrong(r(450, 5, 6, 20)) &&
  energyLooksWrong(r(520, 8, 60, 2.8)) &&
  !energyLooksWrong(r(450, 5, 6, 20, null, 'ml')) &&
  !energyLooksWrong(r(450, 5, 6, 20), { alcoholListed: true }) &&
  energyLooksWrong(r(450, 5, 6, 20), { abv: 0, alcoholListed: true })
    ? ok('a carbs typo (450 kcal, C 6 for 60) and a fat typo (F 2.8 for 28) on a solid are flagged; a drink or a listed alcohol excuses it')
    : bad('under-shoot on a solid');
  !energyLooksWrong(r(200, 6.7, 83, 3.3, 47))
    ? ok('Fiber One (200 kcal, C 83 incl. 47 fibre) reads clean: the low estimate gives fibre 0 kcal')
    : bad('US high-fibre label flagged');
  !energyLooksWrong(r(240, 0, 98, 0), { storedRow: true }) &&
  !energyLooksWrong(r(160, 0, 64, 0.5), { storedRow: true }) &&
  energyLooksWrong(r(240, 0, 98, 0)) &&
  energyLooksWrong(r(50, 10, 10, 10), { storedRow: true }) &&
  energyLooksWrong(r(450, 5, 6, 20), { storedRow: true }) &&
  energyLooksWrong(r(100, 0, 60, 0), { storedRow: true })
    ? ok('a cached sugar-free mint or gum (polyols not stored) is clean; protein/fat excess, a solid under-shoot and carbohydrate even polyols cannot pay for still flag')
    : bad('stored-row verdict');

  // The fresh path on the reviewer's 27 products: the 26 ordinary ones stay
  // clean (Fiber One newly so), and so do beer, wine, vodka and the polyol
  // sweets.
  {
    const P = (per, q, n) => ({
      status: 1,
      product: {
        product_name: 'Product',
        nutrition_data_per: per,
        serving_size: q + (per === '100ml' ? ' ml' : ' g'),
        serving_quantity: q,
        nutriments: n,
      },
    });
    const both = (q, k, p, c, f, more = {}) => ({
      'energy-kcal_100g': k, proteins_100g: p, carbohydrates_100g: c, fat_100g: f,
      'energy-kcal_serving': +((k * q) / 100).toFixed(1), proteins_serving: +((p * q) / 100).toFixed(1),
      carbohydrates_serving: +((c * q) / 100).toFixed(1), fat_serving: +((f * q) / 100).toFixed(1), ...more,
    });
    const products = {
      'beer 5%': P('100ml', 330, both(330, 43, 0.5, 3.6, 0, { alcohol_100g: 5 })),
      'beer, no abv': P('100ml', 330, both(330, 43, 0.5, 3.6, 0)),
      'wine 12.5%': P('100ml', 150, both(150, 83, 0.1, 2.6, 0, { alcohol_100g: 12.5 })),
      'vodka 40%': P('100ml', 30, both(30, 231, 0, 0, 0, { alcohol_100g: 40 })),
      'sugar-free mints': P('100g', 2, { 'energy-kcal_100g': 240, proteins_100g: 0, carbohydrates_100g: 98, fat_100g: 0, polyols_100g: 97 }),
      'sugar-free gum': P('100g', 1.5, { 'energy-kcal_100g': 160, proteins_100g: 0, carbohydrates_100g: 64, fat_100g: 0.5, polyols_100g: 63 }),
      cola: P('100ml', 330, both(330, 42, 0, 10.6, 0)),
      'whole milk': P('100ml', 250, both(250, 64, 3.3, 4.8, 3.6)),
      'peanut butter': P('100g', 32, both(32, 588, 25, 20, 50, { fiber_100g: 6 })),
      'EU bran': P('100g', 40, both(40, 334, 14, 48, 3.5, { fiber_100g: 27 })),
      'Fiber One (US)': P('100g', 40, both(40, 200, 6.7, 83, 3.3, { fiber_100g: 47 })),
      'greek yoghurt': P('100g', 170, both(170, 97, 9, 3.9, 5)),
      'protein bar': P('100g', 60, both(60, 350, 33, 38, 12, { fiber_100g: 15, polyols_100g: 12 })),
      'diet cola': P('100ml', 330, { 'energy-kcal_100g': 0.4, proteins_100g: 0, carbohydrates_100g: 0, fat_100g: 0, 'energy-kcal_serving': 1.3, proteins_serving: 0, carbohydrates_serving: 0, fat_serving: 0 }),
      'oat drink': P('100ml', 250, both(250, 46, 1, 6.6, 1.5, { fiber_100g: 0.8 })),
      'cream liqueur 17%': P('100ml', 50, both(50, 327, 3, 20, 13, { alcohol_100g: 17 })),
      'cream 35%': P('100ml', 15, both(15, 340, 2, 3, 35)),
      'soda, abv 0': P('100ml', 330, both(330, 42, 0, 10.6, 0, { alcohol_100g: 0 })),
      kombucha: P('100ml', 330, both(330, 18, 0, 4, 0, { alcohol_100g: 0.5 })),
      honey: P('100g', 21, both(21, 304, 0.3, 82, 0)),
      'olive oil': P('100ml', 15, both(15, 824, 0, 0, 91.6)),
      bread: P('100g', 40, both(40, 247, 13, 41, 3.4, { fiber_100g: 7 })),
      soup: P('100ml', 500, both(500, 38, 1.2, 5, 1.4, { fiber_100g: 0.9 })),
      milkshake: P('100ml', 500, both(500, 85, 3.4, 12, 2.5)),
      water: P('100ml', 500, both(500, 0, 0, 0, 0)),
      tuna: P('100g', 95, both(95, 116, 26, 0, 1)),
      crisps: P('100g', 150, both(150, 536, 6.6, 53, 33, { fiber_100g: 4.4 })),
    };
    const flagged = Object.entries(products)
      .filter(([, response]) => {
        const read = readOffProduct(response, '5000000000999');
        return read?.kind !== 'food' || read.label.doubtful;
      })
      .map(([name]) => name);
    Object.keys(products).length === 27 && flagged.length === 0
      ? ok('all 27 of the reviewer’s products read clean on the fresh path — drinks, polyol sweets and Fiber One included')
      : bad('fresh path flags an ordinary product', flagged.join(', '));
    const typo = readOffProduct(P('100g', 40, both(40, 450, 5, 6, 20)), '5000000000998');
    typo?.kind === 'food' && typo.label.doubtful === true
      ? ok('…while a solid with C 6 where the label means 60 reads doubtful on the fresh path')
      : bad('fresh typo', JSON.stringify(typo?.label));
  }
  const lager = readOffProduct(
    {
      status: 1,
      product: {
        product_name: 'Lager',
        nutrition_data_per: '100ml',
        serving_size: '330 ml',
        serving_quantity: 330,
        nutriments: {
          'energy-kcal_100g': 43,
          'energy-kcal_serving': 141.9,
          proteins_100g: 0.5,
          proteins_serving: 1.65,
          carbohydrates_100g: 3.6,
          carbohydrates_serving: 11.9,
          fat_100g: 0,
          fat_serving: 0,
          alcohol_100g: 4.5,
        },
      },
    },
    '5000000000103'
  );
  const mints = readOffProduct(
    {
      status: 1,
      product: {
        product_name: 'Sugar-free mints',
        nutrition_data_per: '100g',
        nutriments: {
          'energy-kcal_100g': 240,
          proteins_100g: 0,
          carbohydrates_100g: 98,
          polyols_100g: 95,
          fat_100g: 0,
        },
      },
    },
    '5000000000104'
  );
  lager.label.doubtful === false && mints.label.doubtful === false
    ? ok('read from OFF, a 4.5 % lager and a polyol mint are not doubtful')
    : bad('off alcohol/polyols', JSON.stringify([lager.label, mints.label]));

  // (e) A DRINK READING LIKE ONE SERVING (probe T9): only the line, never a number.
  const t9 = readOffProduct(
    withNutriments(LEWIS_ROAD_LIVE, {
      'energy-kcal_100g': 332,
      proteins_100g: 10.8,
      carbohydrates_100g: 31,
      fat_100g: 18.4,
      'energy-kcal_serving': 830,
      proteins_serving: 27,
      carbohydrates_serving: 77.5,
      fat_serving: 46,
    }),
    '9421903483058'
  );
  t9.label.doubtful === true &&
  t9.food.kcal_100g === 332 &&
  !drinkLooksPerServing({ basis: 'ml', kcal_100g: 340, serving_amount: 15 }) &&
  !drinkLooksPerServing({ basis: 'g', kcal_100g: 500, serving_amount: 250 }) &&
  !drinkLooksPerServing({ basis: 'ml', kcal_100g: 330, serving_amount: 250 }, 17) &&
  !drinkLooksPerServing({ basis: 'ml', kcal_100g: 132.887, serving_amount: 250 })
    ? ok('332 kcal “per 100 ml” in a 250 ml glass is doubtful (numbers kept); cream by the spoon, a solid, a liqueur and the real milk are not')
    : bad('drink per serving', JSON.stringify(t9.label));

  // (f) THE HEAL KEEPS THE PORTION CHOSEN (finding 4).
  const milkG = { serving_amount: 250, basis: 'g' };
  const milkMl = { serving_amount: 250, basis: 'ml' };
  const two = { mode: 'serving', qty: 2, amountText: '500' };
  const typed = { mode: 'amount', qty: 1, amountText: '330' };
  const sameServing = portionAfterHeal(milkMl, { serving_amount: 250, basis: 'ml' }, two);
  const sameUnitTyped = portionAfterHeal(milkMl, { serving_amount: 300, basis: 'ml' }, typed);
  const newServing = portionAfterHeal(milkMl, { serving_amount: 300, basis: 'ml' }, two);
  const newUnit = portionAfterHeal(milkG, milkMl, typed);
  JSON.stringify(sameServing) === JSON.stringify(two) &&
  JSON.stringify(sameUnitTyped) === JSON.stringify(typed) &&
  JSON.stringify(newServing) === '{"mode":"serving","qty":1,"amountText":"300"}' &&
  JSON.stringify(newUnit) === '{"mode":"serving","qty":1,"amountText":"250"}'
    ? ok('a heal keeps “2 × serving” and a typed 330; a resized serving or a new unit starts again')
    : bad('portion after heal', JSON.stringify([sameServing, sameUnitTyped, newServing, newUnit]));
  const scan = readFileSync(new URL('../app/barcode-scan.tsx', import.meta.url), 'utf8');
  scan.includes('const next = portionAfterHeal(current.food, healed, portionRef.current);') &&
  scan.includes('if (controller.signal.aborted) return;') &&
  scan.includes('onPress={() => editFood(phase.food)}') &&
  scan.includes('if (healed && added !== undefined) setStaleAdd({ name: healed.name, mealId: added });') &&
  /\? label\.doubtful\s+: energyLooksWrong\(food, \{ storedRow: true \}\) \|\| drinkLooksPerServing\(food\)/.test(scan) &&
  !scan.includes('product whose two sets of figures disagree is not cached')
    ? ok('barcode-scan: the heal keeps the portion, Edit aborts it, a late heal names the item added, the reading’s verdict wins')
    : bad('heal wiring');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
