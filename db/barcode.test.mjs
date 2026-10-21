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
import { itemForPortion } from '../src/lib/nutrition/servings.ts';
import {
  lookupOffProduct,
  normalizeBarcode,
  offProductUrl,
  OffLookupError,
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
  (screen.match(/void refreshFromOff\(/g) || []).length === 2 &&
  screen.includes('openPortion(local, false);')
    ? ok('barcode-scan: a local hit and a recents tap open at once and heal in the background')
    : bad('refresh wiring');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
