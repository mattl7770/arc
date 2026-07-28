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
  near(f.serving_grams, 170) &&
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
  f && f.serving_name === null && f.serving_grams === null
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
