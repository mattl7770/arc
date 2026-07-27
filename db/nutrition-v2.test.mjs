/**
 * Headless test of the nutrition sub-app's round-2 features — micronutrient
 * snapshots (0017), meal templates (0018), the cross-day history read, and the
 * pure AI-estimate helpers — against real SQLite via node:sqlite. Mirrors
 * db/foods.test.mjs; op-sqlite is never loaded. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { todayISODate } from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { createFood } from '../src/lib/db/repositories/foods.ts';
import {
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplateItems,
  listTemplates,
  logMealFromTemplate,
  renameTemplate,
  saveMealAsTemplate,
} from '../src/lib/db/repositories/meal-templates.ts';
import {
  addMealItem,
  dayMicroTotals,
  getMeal,
  listMealItems,
  logMeal,
  logMealWithItems,
  nutritionHistory,
  setNutritionTargets,
  todayTotals,
} from '../src/lib/db/repositories/nutrition.ts';
import { buildMealEstimationRequest, parseMealEstimate } from '../src/lib/nutrition/estimate.ts';
import {
  microsForGrams,
  parseMicros,
  serializeMicros,
  sumMicros,
} from '../src/lib/nutrition/micros.ts';
import { itemForPortion } from '../src/lib/nutrition/servings.ts';

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

/** A catalog food with micros: 100 kcal / 10P / 5C / 2F / 1 fiber per 100 g,
 * 50 g serving, and sodium 200 mg + calcium 120 mg + b12 0.8 mcg per 100 g. */
function microFood(db, overrides = {}) {
  return createFood(db, {
    name: 'Micro food',
    serving_name: '1 unit',
    serving_grams: 50,
    kcal_100g: 100,
    protein_g_100g: 10,
    carbs_g_100g: 5,
    fat_g_100g: 2,
    fiber_g_100g: 1,
    micros: JSON.stringify({ sodium_mg: 200, calcium_mg: 120, b12_mcg: 0.8 }),
    ...overrides,
  });
}

console.log('0. migrations 0017 (meal_items.micros) + 0018 (templates) apply');
{
  const { raw } = freshDb();
  const v = raw.prepare('PRAGMA user_version').get().user_version;
  v >= 18 ? ok(`user_version is ${v} (>= 18)`) : bad('user_version', v);
  const miCols = raw
    .prepare("SELECT name FROM pragma_table_info('meal_items')")
    .all()
    .map((c) => c.name);
  miCols.includes('micros') ? ok('meal_items.micros column added') : bad('micros column missing');
  for (const t of ['meal_templates', 'meal_template_items']) {
    raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t)
      ? ok(`${t} table exists`)
      : bad(`${t} missing`);
  }
}

console.log('1. micros pure helpers: parse / serialize / scale / sum');
{
  parseMicros('{"sodium_mg":100,"nonsense_key":9,"iron_mg":-3}').sodium_mg === 100 &&
  parseMicros('{"sodium_mg":100,"nonsense_key":9,"iron_mg":-3}').iron_mg === undefined
    ? ok('parseMicros keeps known non-negative keys, drops unknown/negative')
    : bad('parseMicros filter');
  parseMicros(null) && Object.keys(parseMicros(null)).length === 0
    ? ok('parseMicros(null) is {}')
    : bad('parseMicros null');
  parseMicros('{bad json') && Object.keys(parseMicros('{bad json')).length === 0
    ? ok('parseMicros tolerates malformed JSON')
    : bad('parseMicros malformed');
  serializeMicros({ sodium_mg: 0 }) === '{"sodium_mg":0}'
    ? ok('serializeMicros keeps a real zero')
    : bad('serialize zero', serializeMicros({ sodium_mg: 0 }));
  serializeMicros({}) === null ? ok('serializeMicros({}) is null') : bad('serialize empty');
  const scaled = microsForGrams(JSON.stringify({ sodium_mg: 200, calcium_mg: 120 }), 50);
  near(scaled.sodium_mg, 100) && near(scaled.calcium_mg, 60)
    ? ok('microsForGrams scales per-100 g to the portion')
    : bad('microsForGrams', JSON.stringify(scaled));
  const summed = sumMicros([{ sodium_mg: 100, iron_mg: 2 }, { sodium_mg: 50 }, {}]);
  near(summed.sodium_mg, 150) && near(summed.iron_mg, 2)
    ? ok('sumMicros folds payloads, skipping absent keys')
    : bad('sumMicros', JSON.stringify(summed));
}

console.log('2. itemForPortion snapshots scaled micros onto the item');
{
  const { db } = freshDb();
  const foodId = microFood(db);
  const food = db.get('SELECT * FROM foods WHERE id = ?', [foodId]);
  const item = itemForPortion(food, { servingQty: 2 }); // 2 × 50 g = 100 g
  const m = parseMicros(item.micros);
  near(m.sodium_mg, 200) && near(m.calcium_mg, 120) && near(m.b12_mcg, 0.8)
    ? ok('a 100 g portion snapshots the full per-100 g micros')
    : bad('item micros', item.micros);
  const half = itemForPortion(food, { grams: 25 });
  near(parseMicros(half.micros).sodium_mg, 50)
    ? ok('a 25 g portion snapshots a quarter of the micros')
    : bad('item micros scaled', half.micros);
  const plain = createFood(db, { name: 'Plain', kcal_100g: 100 });
  itemForPortion(db.get('SELECT * FROM foods WHERE id = ?', [plain]), { grams: 100 }).micros ===
  null
    ? ok('a food with no micros yields NULL micros (not a fake {})')
    : bad('plain micros not null');
}

console.log('3. dayMicroTotals sums the day’s item micros; free-form days are empty');
{
  const { db } = freshDb();
  const foodId = microFood(db);
  const food = db.get('SELECT * FROM foods WHERE id = ?', [foodId]);
  logMealWithItems(db, {
    date: TODAY,
    time: '08:00',
    name: 'Breakfast',
    items: [itemForPortion(food, { grams: 100 }), itemForPortion(food, { grams: 50 })],
  });
  const totals = dayMicroTotals(db, TODAY);
  near(totals.sodium_mg, 300) && near(totals.calcium_mg, 180) && near(totals.b12_mcg, 1.2)
    ? ok('day micro totals sum across the day’s items (150 g worth)')
    : bad('day micros', JSON.stringify(totals));
  logMeal(db, { date: TODAY, time: '12:00', name: 'Free-form lunch', kcal: 600 });
  near(dayMicroTotals(db, TODAY).sodium_mg, 300)
    ? ok('a free-form meal adds no micros (none recorded)')
    : bad('freeform micros leak');
  const { db: db2 } = freshDb();
  Object.keys(dayMicroTotals(db2, TODAY)).length === 0
    ? ok('an empty day yields {} micros, not a zero panel')
    : bad('empty day micros');
}

console.log('4. addMealItem + relog carry micros through');
{
  const { db } = freshDb();
  const food = db.get('SELECT * FROM foods WHERE id = ?', [microFood(db)]);
  const { mealId } = logMealWithItems(db, {
    date: TODAY,
    time: '08:00',
    name: 'Breakfast',
    items: [itemForPortion(food, { grams: 100 })],
  });
  addMealItem(db, mealId, itemForPortion(food, { grams: 50 }));
  near(dayMicroTotals(db, TODAY).sodium_mg, 300)
    ? ok('addMealItem folds the new item’s micros in')
    : bad('add micros');
  const items = listMealItems(db, mealId);
  items.every((i) => i.micros !== null)
    ? ok('listMealItems returns the micros snapshot column')
    : bad('items micros null');
}

console.log('5. templates: create, list rollup, log-from, cascade delete');
{
  const { db, raw } = freshDb();
  const food = db.get('SELECT * FROM foods WHERE id = ?', [microFood(db)]);
  const templateId = createTemplate(db, {
    name: 'Protein Oats',
    items: [itemForPortion(food, { grams: 100 }), { name: 'Berries', kcal: 50, carbs_g: 12 }],
  });
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(templateId)
    ? ok('createTemplate returns a v4 id')
    : bad('template id', templateId);
  raw.prepare('SELECT name_norm FROM meal_templates WHERE id = ?').get(templateId).name_norm ===
  'protein oats'
    ? ok('name_norm derived')
    : bad('name_norm');
  const list = listTemplates(db);
  const summary = list.find((t) => t.template.id === templateId);
  summary && near(summary.kcal, 150) && summary.itemCount === 2
    ? ok('listTemplates rolls up kcal + item count')
    : bad('template rollup', JSON.stringify(summary));
  // Log it onto today → real meal + items, micros preserved, source manual.
  const mealId = logMealFromTemplate(db, templateId, TODAY, '08:30');
  const meal = getMeal(db, mealId);
  meal && meal.name === 'Protein Oats' && near(meal.kcal, 150) && meal.source === 'manual'
    ? ok('logMealFromTemplate stamps a real meal (source manual)')
    : bad('log from template', JSON.stringify(meal));
  near(dayMicroTotals(db, TODAY).sodium_mg, 200)
    ? ok('the logged meal carries the template’s micro snapshot')
    : bad('template micros', JSON.stringify(dayMicroTotals(db, TODAY)));
  listMealItems(db, mealId).length === 2 ? ok('both template items logged') : bad('logged items');
  // Editing/deleting the template must not touch the logged meal (stamp, not link).
  deleteTemplate(db, templateId);
  raw.prepare('SELECT count(*) c FROM meal_template_items').get().c === 0
    ? ok('deleting a template cascades its items')
    : bad('template cascade');
  getMeal(db, mealId) && near(getMeal(db, mealId).kcal, 150)
    ? ok('the meal logged from it survives the template’s deletion')
    : bad('meal survived');
}

console.log('6. saveMealAsTemplate captures a logged meal; free-form meals can’t');
{
  const { db } = freshDb();
  const food = db.get('SELECT * FROM foods WHERE id = ?', [microFood(db)]);
  const { mealId } = logMealWithItems(db, {
    date: TODAY,
    time: '12:00',
    name: 'Lunch',
    items: [itemForPortion(food, { grams: 100 })],
  });
  const templateId = saveMealAsTemplate(db, mealId, 'My lunch');
  const items = listTemplateItems(db, templateId);
  items.length === 1 && near(parseMicros(items[0].micros).sodium_mg, 200)
    ? ok('saveMealAsTemplate snapshots items including micros')
    : bad('save as template', JSON.stringify(items));
  const freeform = logMeal(db, { date: TODAY, time: '18:00', name: 'Dinner', kcal: 700 });
  saveMealAsTemplate(db, freeform, 'nope') === null
    ? ok('a free-form meal (no items) can’t become a template')
    : bad('freeform to template');
  renameTemplate(db, templateId, { name: 'Renamed lunch' });
  getTemplate(db, templateId).name === 'Renamed lunch' &&
  getTemplate(db, templateId).name_norm === 'renamed lunch'
    ? ok('renameTemplate updates name + name_norm')
    : bad('rename');
  logMealFromTemplate(db, 'no-such-template', TODAY, null) === null
    ? ok('logging a missing template returns null')
    : bad('log missing template');
}

console.log('7. nutritionHistory: per-day totals + each day’s own targets');
{
  const { db } = freshDb();
  const food = db.get('SELECT * FROM foods WHERE id = ?', [microFood(db)]);
  // Targets that changed over time: 2000 kcal from Jan, 2200 from a recent day.
  setNutritionTargets(db, { effective_date: '2000-01-01', kcal: 2000 });
  const anchor = '2026-06-15';
  logMealWithItems(db, {
    date: anchor,
    time: '12:00',
    name: 'Lunch',
    items: [itemForPortion(food, { grams: 200 })], // 200 kcal, 20 P
  });
  const hist = nutritionHistory(db, 3, '2026-06-16');
  hist.length === 3
    ? ok('history returns exactly the window length')
    : bad('history length', hist.length);
  const anchorDay = hist.find((d) => d.date === anchor);
  anchorDay &&
  near(anchorDay.kcal, 200) &&
  near(anchorDay.protein_g, 20) &&
  anchorDay.mealCount === 1
    ? ok('the logged day carries its real totals')
    : bad('history totals', JSON.stringify(anchorDay));
  anchorDay && anchorDay.target && anchorDay.target.kcal === 2000
    ? ok('each day resolves the targets of its own era (2000, not a later value)')
    : bad('history target', JSON.stringify(anchorDay && anchorDay.target));
  const emptyDay = hist.find((d) => d.date === '2026-06-16');
  emptyDay && emptyDay.kcal === 0 && emptyDay.mealCount === 0
    ? ok('a day with no meals zero-fills')
    : bad('history empty day', JSON.stringify(emptyDay));
  near(anchorDay.fiber_g, 2)
    ? ok('history fiber comes from item snapshots (200 g × 1 g/100 g)')
    : bad('history fiber', anchorDay && anchorDay.fiber_g);
}

console.log('8. estimate helpers: request builder + tolerant JSON parser (pure)');
{
  const photoReq = buildMealEstimationRequest({
    kind: 'photo',
    base64Jpeg: 'QUJD',
    mediaType: 'image/jpeg',
  });
  const blocks = photoReq.messages[0].content;
  blocks[0].type === 'image' &&
  blocks[0].source.data === 'QUJD' &&
  blocks[1].type === 'text' &&
  photoReq.system.includes('JSON')
    ? ok('photo request puts the image block first, then the prompt')
    : bad('photo request', JSON.stringify(blocks.map((b) => b.type)));
  const textReq = buildMealEstimationRequest({ kind: 'text', description: '2 eggs and toast' });
  textReq.messages[0].content.length === 1 &&
  textReq.messages[0].content[0].text.includes('2 eggs and toast')
    ? ok('text request is a single text block')
    : bad('text request');
  const est = parseMealEstimate(
    'Here you go:\n```json\n{"title":"Eggs","items":[{"name":"Egg","grams":100,"kcal":155,"protein_g":13,"carbs_g":1,"fat_g":11,"fiber_g":null,"confidence":"high"}],"notes":"no oil visible"}\n```'
  );
  est.title === 'Eggs' &&
  est.items.length === 1 &&
  est.items[0].confidence === 'high' &&
  est.items[0].foodId === null &&
  est.notes === 'no oil visible'
    ? ok('parseMealEstimate extracts JSON from fenced/prosey replies')
    : bad('parse estimate', JSON.stringify(est));
  const coerced = parseMealEstimate('{"items":[{"name":"Mystery","confidence":"wat"}]}');
  coerced.items[0].confidence === 'low' && coerced.items[0].kcal === 0 && coerced.title === 'Meal'
    ? ok('unknown confidence → low, missing macros → 0, missing title → "Meal"')
    : bad('parse coercion', JSON.stringify(coerced));
  throws(() => parseMealEstimate('sorry, no idea'))
    ? ok('a reply with no JSON throws (caller tells the user it failed)')
    : bad('parse no-json');
  throws(() => parseMealEstimate('{"title":"Empty","items":[]}'))
    ? ok('a reply with no usable items throws (never logs an empty meal)')
    : bad('parse empty items');
}

console.log('9. existing exports still behave (no regression from micros/templates)');
{
  const { db } = freshDb();
  const food = db.get('SELECT * FROM foods WHERE id = ?', [microFood(db)]);
  logMealWithItems(db, {
    date: TODAY,
    time: '08:00',
    name: 'B',
    items: [itemForPortion(food, { grams: 100 })],
  });
  const t = todayTotals(db, TODAY);
  near(t.kcal, 100) && near(t.protein_g, 10) && t.mealCount === 1
    ? ok('todayTotals unchanged with micros present')
    : bad('todayTotals regression', JSON.stringify(t));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
