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
  allMealPhotos,
  dayMicroTotals,
  getMeal,
  latestMealPhoto,
  listMealItems,
  logMeal,
  logMealWithItems,
  nutritionHistory,
  replaceMealItems,
  setNutritionTargets,
  todayTotals,
  updateMealItemPortion,
  updateMealTime,
} from '../src/lib/db/repositories/nutrition.ts';
import {
  attachMealPhoto,
  deleteMealWithPhotos,
  MEAL_PHOTO_RETENTION_DAYS,
  mealPhotoView,
  sweepMealPhotos,
} from '../src/lib/media/meal-photo-store.ts';
import {
  buildFoodEntryRequest,
  buildMealEstimationRequest,
  buildMealRevisionRequest,
  FOOD_ENTRY_SYSTEM_PROMPT,
  groundMealEstimate,
  MEAL_ESTIMATION_SYSTEM_PROMPT,
  MEAL_REVISION_SYSTEM_PROMPT,
  parseFoodEntry,
  parseMealEstimate,
} from '../src/lib/nutrition/estimate.ts';
import {
  microsForAmount,
  MICROS,
  parseMicros,
  scaleMicros,
  serializeMicros,
  sumMicros,
} from '../src/lib/nutrition/micros.ts';
import { itemForPortion, rescaleLoggedItem } from '../src/lib/nutrition/servings.ts';

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
    serving_amount: 50,
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
  const scaled = microsForAmount(JSON.stringify({ sodium_mg: 200, calcium_mg: 120 }), 50);
  near(scaled.sodium_mg, 100) && near(scaled.calcium_mg, 60)
    ? ok('microsForAmount scales per-100 g to the portion')
    : bad('microsForAmount', JSON.stringify(scaled));
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
  const half = itemForPortion(food, { amount: 25 });
  near(parseMicros(half.micros).sodium_mg, 50)
    ? ok('a 25 g portion snapshots a quarter of the micros')
    : bad('item micros scaled', half.micros);
  const plain = createFood(db, { name: 'Plain', kcal_100g: 100 });
  itemForPortion(db.get('SELECT * FROM foods WHERE id = ?', [plain]), { amount: 100 }).micros ===
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
    items: [itemForPortion(food, { amount: 100 }), itemForPortion(food, { amount: 50 })],
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
    items: [itemForPortion(food, { amount: 100 })],
  });
  addMealItem(db, mealId, itemForPortion(food, { amount: 50 }));
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
    items: [itemForPortion(food, { amount: 100 }), { name: 'Berries', kcal: 50, carbs_g: 12 }],
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
    items: [itemForPortion(food, { amount: 100 })],
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
    items: [itemForPortion(food, { amount: 200 })], // 200 kcal, 20 P
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
    items: [itemForPortion(food, { amount: 100 })],
  });
  const t = todayTotals(db, TODAY);
  near(t.kcal, 100) && near(t.protein_g, 10) && t.mealCount === 1
    ? ok('todayTotals unchanged with micros present')
    : bad('todayTotals regression', JSON.stringify(t));
}

console.log('10. scaleMicros scales knowns, skips absent');
{
  const s = scaleMicros({ sodium_mg: 100, calcium_mg: 40 }, 0.5);
  near(s.sodium_mg, 50) && near(s.calcium_mg, 20) && s.iron_mg === undefined
    ? ok('scaleMicros halves present keys')
    : bad('scaleMicros', JSON.stringify(s));
}

console.log('11. rescaleLoggedItem: re-derive from a food; else proportional; null when neither');
{
  const { db } = freshDb();
  const food = db.get('SELECT * FROM foods WHERE id = ?', [microFood(db)]);
  // With the catalog food (100 kcal/100 g, sodium 200/100 g): re-derive at 200 g.
  const fromFood = rescaleLoggedItem(
    { amount: 100, kcal: 100, protein_g: 10, carbs_g: 5, fat_g: 2, fiber_g: 1, micros: null },
    food,
    { amount: 200 }
  );
  fromFood &&
  near(fromFood.kcal, 200) &&
  near(fromFood.protein_g, 20) &&
  near(parseMicros(fromFood.micros).sodium_mg, 400)
    ? ok('food present → macros + micros re-derived from the catalog')
    : bad('rescale food', JSON.stringify(fromFood));
  // Serving stepper needs the food; 2 servings of a 50 g serving = 100 g.
  const fromServing = rescaleLoggedItem({ amount: 50 }, food, { servingQty: 2 });
  fromServing && near(fromServing.amount, 100) && near(fromServing.kcal, 100)
    ? ok('food present → serving qty re-derives')
    : bad('rescale serving', JSON.stringify(fromServing));
  // No food: scale the snapshot proportionally (doubling 150 g → 300 g).
  const proportional = rescaleLoggedItem(
    {
      amount: 150,
      kcal: 300,
      protein_g: 30,
      carbs_g: null,
      fat_g: 12,
      fiber_g: 3,
      micros: '{"sodium_mg":90}',
    },
    undefined,
    { amount: 300 }
  );
  proportional &&
  near(proportional.kcal, 600) &&
  near(proportional.protein_g, 60) &&
  proportional.carbs_g === null &&
  near(parseMicros(proportional.micros).sodium_mg, 180)
    ? ok('no food → snapshot scaled proportionally, NULLs preserved')
    : bad('rescale proportional', JSON.stringify(proportional));
  rescaleLoggedItem({ amount: null }, undefined, { amount: 100 }) === null
    ? ok('no food + no amount → null (nothing to re-scale)')
    : bad('rescale null');
  rescaleLoggedItem({ amount: 100 }, undefined, { servingQty: 2 }) === null
    ? ok('no food + serving qty → null (a serving needs a food)')
    : bad('rescale serving-no-food');
}

console.log('12. updateMealItemPortion via rescaleLoggedItem keeps meal totals honest');
{
  const { db } = freshDb();
  const foodId = microFood(db);
  const food = db.get('SELECT * FROM foods WHERE id = ?', [foodId]);
  const { mealId } = logMealWithItems(db, {
    date: TODAY,
    time: '08:00',
    name: 'Breakfast',
    items: [itemForPortion(food, { amount: 100 })],
  });
  const item = listMealItems(db, mealId)[0];
  const update = rescaleLoggedItem(item, food, { amount: 250 });
  updateMealItemPortion(db, item.id, update);
  near(getMeal(db, mealId).kcal, 250) && near(dayMicroTotals(db, TODAY).sodium_mg, 500)
    ? ok('re-portioning an item re-derives its macros + micros and the meal total')
    : bad('update portion', JSON.stringify(getMeal(db, mealId)));
}

console.log('13. groundMealEstimate matches items to the catalog and re-prices them');
{
  const { db } = freshDb();
  // A catalog food the estimate should ground to (100 kcal / 20 P per 100 g).
  createFood(db, {
    name: 'Grilled chicken',
    kcal_100g: 100,
    protein_g_100g: 20,
    carbs_g_100g: 0,
    fat_g_100g: 2,
    micros: JSON.stringify({ sodium_mg: 60 }),
  });
  const estimate = {
    title: 'Lunch',
    notes: null,
    items: [
      // Model guessed 250 kcal for 150 g; grounding should re-price to 150 kcal.
      {
        name: 'Grilled chicken',
        amount: 150,
        unit: 'g',
        kcal: 250,
        protein_g: 25,
        carbs_g: 0,
        fat_g: 10,
        fiber_g: null,
        confidence: 'medium',
        foodId: null,
      },
      // No catalog match → left as the model gave it.
      {
        name: 'Mystery sauce',
        amount: 30,
        kcal: 90,
        protein_g: 0,
        carbs_g: 5,
        fat_g: 7,
        fiber_g: null,
        confidence: 'low',
        foodId: null,
      },
    ],
  };
  const grounded = groundMealEstimate(db, estimate);
  const chicken = grounded.items[0];
  chicken.foodId != null && near(chicken.kcal, 150) && near(chicken.protein_g, 30)
    ? ok('a catalog match is re-priced from known per-100 g values (foodId set)')
    : bad('ground match', JSON.stringify(chicken));
  chicken.confidence === 'medium'
    ? ok('confidence is untouched (portion uncertainty remains)')
    : bad('ground confidence');
  const sauce = grounded.items[1];
  sauce.foodId === null && near(sauce.kcal, 90)
    ? ok('an unmatched item keeps the model’s numbers')
    : bad('ground unmatched', JSON.stringify(sauce));
}

console.log('13b. grounding is conservative — generic single words never mis-ground');
{
  const { db } = freshDb();
  // The seed catalog has "Rice cakes", "Chicken and rice bowl", "Egg white" etc.
  // — a bare "rice"/"chicken"/"egg" must NOT ground to those (categorical error).
  const generic = groundMealEstimate(db, {
    title: 'Bowl',
    notes: null,
    items: [
      {
        name: 'rice',
        amount: 150,
        kcal: 200,
        protein_g: 4,
        carbs_g: 44,
        fat_g: 0,
        fiber_g: 1,
        confidence: 'high',
        foodId: null,
      },
      {
        name: 'chicken',
        amount: 120,
        kcal: 200,
        protein_g: 37,
        carbs_g: 0,
        fat_g: 4,
        fiber_g: null,
        confidence: 'high',
        foodId: null,
      },
    ],
  });
  generic.items.every((i) => i.foodId === null && near(i.kcal, 200))
    ? ok('single-token generic names keep the model’s numbers (no wrong ground)')
    : bad('generic grounded', JSON.stringify(generic.items.map((i) => [i.name, i.foodId, i.kcal])));
  // A partial-macro catalog food is not grounded to (would mix model + catalog).
  createFood(db, { name: 'Overnight oats mix', kcal_100g: 300 }); // protein/carbs/fat NULL
  const partial = groundMealEstimate(db, {
    title: 'B',
    notes: null,
    items: [
      {
        name: 'Overnight oats mix',
        amount: 100,
        kcal: 250,
        protein_g: 10,
        carbs_g: 40,
        fat_g: 5,
        fiber_g: null,
        confidence: 'medium',
        foodId: null,
      },
    ],
  });
  partial.items[0].foodId === null && near(partial.items[0].kcal, 250)
    ? ok('a catalog food missing macros is not grounded to (no mixed item)')
    : bad('partial grounded', JSON.stringify(partial.items[0]));
}

// === Meal photos (0033) ======================================================
//
// The file half of this feature is behind the `PhotoFileStore` seam precisely
// so it can be driven here: a Map stands in for the Documents directory while
// the REAL database runs the REAL migrations underneath. That is what makes the
// retention sweep — three passes, two stores, an ordering that matters — a
// tested thing rather than a hoped-for one.

/** An in-memory stand-in for the app's photo directory. */
function fakeStore(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    list: () => [...files.keys()],
    exists: (name) => files.has(name),
    remove: (name) => {
      files.delete(name);
      return true;
    },
    write: (name, base64) => {
      files.set(name, base64);
      return true;
    },
    uri: (name) => (files.has(name) ? `file:///documents/meal-photos/${name}` : null),
  };
}

const JPEG = { base64Jpeg: '/9j/fake', width: 1024, height: 768, source: 'camera' };

/** Backdate a photo row so the sweep can see it as expired without waiting. */
function agePhoto(raw, id, days) {
  const at = new Date(Date.now() - days * 86_400_000).toISOString();
  raw.prepare('UPDATE meal_photos SET created_at = ? WHERE id = ?').run(at, id);
}

console.log('14. 0033 schema: a name (never a path), unique, and CASCADE off the meal');
{
  const { db, raw } = freshDb();
  const mealId = logMeal(db, { date: TODAY, time: '12:30', name: 'Lunch', kcal: 700 });
  raw
    .prepare('INSERT INTO meal_photos (id, meal_id, file_name, source) VALUES (?, ?, ?, ?)')
    .run('p1', mealId, 'abc.jpg', 'camera');
  raw.prepare('SELECT count(*) c FROM meal_photos').get().c === 1
    ? ok('a plain base name inserts')
    : bad('base name rejected');

  // The column stores a NAME. A path would survive an install and then dangle,
  // which is the whole reason the CHECK is there.
  throws(() =>
    db.run('INSERT INTO meal_photos (id, meal_id, file_name, source) VALUES (?, ?, ?, ?)', [
      'p2',
      mealId,
      'sub/dir.jpg',
      'camera',
    ])
  )
    ? ok('a name containing a separator is rejected')
    : bad('path accepted');
  throws(() =>
    db.run('INSERT INTO meal_photos (id, meal_id, file_name, source) VALUES (?, ?, ?, ?)', [
      'p3',
      mealId,
      'abc.png',
      'camera',
    ])
  )
    ? ok('a non-.jpg name is rejected')
    : bad('non-jpg accepted');
  throws(() =>
    db.run('INSERT INTO meal_photos (id, meal_id, file_name, source) VALUES (?, ?, ?, ?)', [
      'p4',
      mealId,
      'abc.jpg',
      'camera',
    ])
  )
    ? ok('two rows cannot claim one file (UNIQUE file_name)')
    : bad('duplicate file_name accepted');
  throws(() =>
    db.run('INSERT INTO meal_photos (id, meal_id, file_name, source) VALUES (?, ?, ?, ?)', [
      'p5',
      mealId,
      'd.jpg',
      'scanner',
    ])
  )
    ? ok('an unknown source is rejected by the enum CHECK')
    : bad('unknown source accepted');
  throws(() =>
    db.run('INSERT INTO meal_photos (id, meal_id, file_name, source) VALUES (?, ?, ?, ?)', [
      'p6',
      'no-such-meal',
      'e.jpg',
      'camera',
    ])
  )
    ? ok('a photo cannot hang off a meal that does not exist (FK)')
    : bad('orphan FK accepted');

  db.run('DELETE FROM meals WHERE id = ?', [mealId]);
  raw.prepare('SELECT count(*) c FROM meal_photos').get().c === 0
    ? ok('deleting the meal CASCADEs its photo rows away')
    : bad('cascade');
}

console.log('15. attachMealPhoto writes the file first, then the row — and undoes itself');
{
  const { db } = freshDb();
  const store = fakeStore();
  const mealId = logMeal(db, { date: TODAY, time: '12:30', name: 'Lunch', kcal: 700 });
  const photoId = attachMealPhoto(db, mealId, JPEG, store);
  const row = latestMealPhoto(db, mealId);
  photoId && row && store.files.has(row.file_name)
    ? ok('the row and the file land together')
    : bad('attach', JSON.stringify(row));
  row && row.width === 1024 && row.height === 768 && row.source === 'camera'
    ? ok('dimensions and provenance are recorded (the frame is the photo’s own)')
    : bad('attach metadata', JSON.stringify(row));
  store.files.get(row.file_name) === '/9j/fake'
    ? ok('the bytes written are the bytes handed in')
    : bad('written bytes');

  // A rejected row must not leave the file behind — that is the leak this
  // module exists to prevent. This case logs a FOREIGN KEY warning on the way
  // through; that line in the run output is the rollback working, not a fault.
  const bogus = attachMealPhoto(db, 'no-such-meal', JPEG, store);
  bogus === null && store.files.size === 1
    ? ok('a rejected row removes the file it had just written')
    : bad('rollback', `${bogus} / ${store.files.size} file(s)`);

  attachMealPhoto(db, mealId, { ...JPEG, source: 'library' }, store) && store.files.size === 2
    ? ok('a second photo gets its own file (names never collide)')
    : bad('second photo');
  latestMealPhoto(db, mealId).source === 'library'
    ? ok('the newest photo is the one the meal shows — a re-shoot is a correction')
    : bad('latest photo');

  // No file system at all (the web preview, a headless render): no row, no lie.
  const before = allMealPhotos(db).length;
  attachMealPhoto(db, mealId, JPEG, null) === null && allMealPhotos(db).length === before
    ? ok('with no store there is no row — never a pointer to a file nobody wrote')
    : bad('null store attach');
}

console.log('16. mealPhotoView: what the meal screen draws, and when it draws nothing');
{
  const { db, raw } = freshDb();
  const store = fakeStore();
  const mealId = logMeal(db, { date: TODAY, time: '12:30', name: 'Lunch', kcal: 700 });
  mealPhotoView(db, mealId, new Date(), store) === null
    ? ok('a meal with no photo yields null (the screen draws no frame at all)')
    : bad('empty view');

  const photoId = attachMealPhoto(db, mealId, JPEG, store);
  const view = mealPhotoView(db, mealId, new Date(), store);
  view && view.uri.endsWith('.jpg') && view.width === 1024 && view.height === 768
    ? ok('a fresh photo yields a uri and its true dimensions')
    : bad('view', JSON.stringify(view));
  view && view.clearsInDays === MEAL_PHOTO_RETENTION_DAYS
    ? ok(`a photo taken now clears in ${MEAL_PHOTO_RETENTION_DAYS} days`)
    : bad('clearsInDays fresh', view && view.clearsInDays);

  agePhoto(raw, photoId, MEAL_PHOTO_RETENTION_DAYS - 1);
  mealPhotoView(db, mealId, new Date(), store).clearsInDays === 1
    ? ok('a photo one day short of the window says so — rounded up, never "0 days"')
    : bad('clearsInDays near', mealPhotoView(db, mealId, new Date(), store).clearsInDays);

  // Clock skew, which a flaky run of this very suite surfaced: SQLite's 'now'
  // reads a finer clock than Date.now() does on Windows, so a just-written row
  // can parse a few ms AHEAD of the JS clock. Unclamped that reported 8 days
  // left on a 7-day window. Simulated here by reading against an earlier `now`.
  agePhoto(raw, photoId, -1);
  mealPhotoView(db, mealId, new Date(), store).clearsInDays === MEAL_PHOTO_RETENTION_DAYS
    ? ok('a created_at ahead of the clock never reports more than the whole window')
    : bad('future created_at', mealPhotoView(db, mealId, new Date(), store).clearsInDays);

  // The file vanishes under us (an OS purge, a restore that carried the
  // database but not the media). A broken frame is worse than no frame.
  store.files.clear();
  mealPhotoView(db, mealId, new Date(), store) === null
    ? ok('a row whose file has gone yields null, not a broken image')
    : bad('dangling view');
}

console.log('17. deleteMealWithPhotos clears the bytes the CASCADE leaves behind');
{
  const { db, raw } = freshDb();
  const store = fakeStore();
  const mealId = logMeal(db, { date: TODAY, time: '12:30', name: 'Lunch', kcal: 700 });
  attachMealPhoto(db, mealId, JPEG, store);
  attachMealPhoto(db, mealId, JPEG, store);
  const keeper = logMeal(db, { date: TODAY, time: '08:00', name: 'Breakfast', kcal: 300 });
  attachMealPhoto(db, keeper, JPEG, store);
  store.files.size === 3 ? ok('three files on disk') : bad('setup', store.files.size);

  deleteMealWithPhotos(db, mealId, store);
  getMeal(db, mealId) === undefined &&
  raw.prepare('SELECT count(*) c FROM meal_photos').get().c === 1
    ? ok('the meal and both its rows are gone')
    : bad('delete rows');
  store.files.size === 1
    ? ok('both its FILES are gone too — the CASCADE alone would have leaked them')
    : bad('delete files', store.files.size);
  store.files.has(latestMealPhoto(db, keeper).file_name)
    ? ok('the other meal’s photo is untouched')
    : bad('collateral file deletion');
}

console.log('18. the retention sweep: expire, then reconcile both directions');
{
  const { db, raw } = freshDb();
  const store = fakeStore();
  const mealId = logMeal(db, { date: TODAY, time: '12:30', name: 'Lunch', kcal: 700 });

  const fresh = attachMealPhoto(db, mealId, JPEG, store);
  const old = attachMealPhoto(db, mealId, JPEG, store);
  agePhoto(raw, old, MEAL_PHOTO_RETENTION_DAYS + 1);
  const oldName = raw.prepare('SELECT file_name FROM meal_photos WHERE id = ?').get(old).file_name;

  // A row whose file went missing, and a file no row claims.
  const dangling = attachMealPhoto(db, mealId, JPEG, store);
  const danglingName = raw
    .prepare('SELECT file_name FROM meal_photos WHERE id = ?')
    .get(dangling).file_name;
  store.files.delete(danglingName);
  store.files.set('orphan.jpg', '/9j/nobodys');

  const result = sweepMealPhotos(db, store, new Date());
  result.expired === 1 && result.dangling === 1 && result.orphans === 1
    ? ok('one expired, one dangling row, one orphan file — all three passes fire')
    : bad('sweep counts', JSON.stringify(result));
  !store.files.has(oldName)
    ? ok('the expired photo’s file is off disk')
    : bad('expired file survived');
  allMealPhotos(db).length === 1 && allMealPhotos(db)[0].id === fresh
    ? ok('only the fresh photo’s row survives')
    : bad('surviving rows', JSON.stringify(allMealPhotos(db).map((p) => p.id)));
  !store.files.has('orphan.jpg') && store.files.size === 1
    ? ok('the orphan file is reclaimed and the claimed one is not')
    : bad('orphan pass', [...store.files.keys()].join(','));

  // Idempotent: a second sweep on a reconciled store does nothing at all.
  const again = sweepMealPhotos(db, store, new Date());
  again.expired === 0 && again.dangling === 0 && again.orphans === 0 && store.files.size === 1
    ? ok('a second sweep is a no-op')
    : bad('second sweep', JSON.stringify(again));

  // And with no file system module there is nothing to sweep and nothing to
  // break — the boot path must survive a runtime without expo-file-system.
  const none = sweepMealPhotos(db, null, new Date());
  none.expired === 0 && allMealPhotos(db).length === 1
    ? ok('with no store the sweep is inert — rows are never dropped blind')
    : bad('null-store sweep', JSON.stringify(none));
}

console.log('19. retention is keyed on the PHOTO’s age, not on the meal’s date');
{
  const { db, raw } = freshDb();
  const store = fakeStore();
  const mealId = logMeal(db, { date: TODAY, time: '00:40', name: 'Late plate', kcal: 500 });
  const photoId = attachMealPhoto(db, mealId, JPEG, store);

  // The owner corrects the meal onto a day well outside the retention window.
  // Nothing about the photo may move: it was taken today.
  updateMealTime(db, mealId, { date: '2026-01-01', time: '23:40' });
  const swept = sweepMealPhotos(db, store, new Date());
  swept.expired === 0 && latestMealPhoto(db, mealId) && store.files.size === 1
    ? ok('re-dating a meal to January does not expire the photo taken today')
    : bad('re-date expired the photo', JSON.stringify(swept));

  // And the converse: an old photo on a meal re-dated to today still expires.
  agePhoto(raw, photoId, MEAL_PHOTO_RETENTION_DAYS + 1);
  updateMealTime(db, mealId, { date: TODAY, time: '12:00' });
  sweepMealPhotos(db, store, new Date()).expired === 1 && store.files.size === 0
    ? ok('re-dating a meal to today does not resurrect a photo past its window')
    : bad('re-date resurrected the photo');
  getMeal(db, mealId)
    ? ok('and the meal itself is untouched by either sweep')
    : bad('sweep deleted a meal');
}

// ============================================================================
// 20. The plain-English revision (owner, 2026-08-12): "Actually, that was
// cooked in olive oil not butter". Two halves — the write, which must replace
// ONLY the items, and the request, which must show the model what it is
// correcting.
// ============================================================================

console.log('\n20. replaceMealItems: swaps the items and nothing else');
{
  const { db } = freshDb();
  const { mealId } = logMealWithItems(db, {
    date: '2026-08-12',
    time: '19:30',
    name: 'Steak dinner',
    notes: 'felt heavy',
    source: 'ai_suggested',
    items: [
      { name: 'Ribeye', amount: 300, kcal: 800, protein_g: 60, carbs_g: 0, fat_g: 62 },
      { name: 'Butter', amount: 28, kcal: 200, protein_g: 0, carbs_g: 0, fat_g: 23 },
    ],
  });
  const beforeMeal = getMeal(db, mealId);

  const ids = replaceMealItems(db, mealId, [
    { name: 'Ribeye', amount: 300, kcal: 800, protein_g: 60, carbs_g: 0, fat_g: 62 },
    { name: 'Olive oil', amount: 28, kcal: 248, protein_g: 0, carbs_g: 0, fat_g: 28 },
  ]);
  const items = listMealItems(db, mealId);
  const after = getMeal(db, mealId);

  ids.length === 2 && items.length === 2
    ? ok('the old items are gone and exactly the new ones remain')
    : bad('item swap', String(items.length));
  items.map((i) => i.name).join(',') === 'Ribeye,Olive oil'
    ? ok('in the order they were given')
    : bad('order', items.map((i) => i.name).join(','));
  after.kcal === 1048 && after.fat_g === 90
    ? ok('the meal’s totals are re-derived from the new items (1048 kcal, 90 g fat)')
    : bad('totals', `${after.kcal}/${after.fat_g}`);
  after.date === beforeMeal.date &&
  after.time === beforeMeal.time &&
  after.name === beforeMeal.name &&
  after.notes === beforeMeal.notes &&
  after.source === beforeMeal.source
    ? ok('date, time, name, notes and source are all untouched — a revision is about the items')
    : bad('meal identity moved', JSON.stringify(after));

  let refused = false;
  try {
    replaceMealItems(db, mealId, []);
  } catch {
    refused = true;
  }
  refused && listMealItems(db, mealId).length === 2
    ? ok('an empty revision is REFUSED — emptying a meal is a different, deliberate act')
    : bad('empty revision accepted');
}

console.log('\n20b. buildMealRevisionRequest: the model sees the meal it is correcting');
{
  const req = buildMealRevisionRequest(
    {
      name: 'Steak dinner',
      items: [
        { name: 'Ribeye', amount: 300, unit: 'g', kcal: 800, protein_g: 60, carbs_g: 0, fat_g: 62 },
        // The unpriced case: a blank tail would read as zero and come back zero.
        {
          name: 'Side salad',
          amount: null,
          unit: 'g',
          kcal: null,
          protein_g: null,
          carbs_g: null,
          fat_g: null,
        },
      ],
    },
    'that was cooked in olive oil, not butter'
  );
  const text = req.messages[0].content[0].text;
  text.includes('Logged meal: Steak dinner') && text.includes('- Ribeye — 300 g, 800 kcal')
    ? ok('the current items are listed with their numbers')
    : bad('items in request', text);
  text.includes('- Side salad — no numbers recorded')
    ? ok('and an unpriced item SAYS so rather than showing a blank tail')
    : bad('unpriced item', text);
  text.includes('Correction from the user: that was cooked in olive oil, not butter')
    ? ok('the correction is quoted verbatim')
    : bad('correction missing', text);
  req.system.includes('Change ONLY what the correction implies')
    ? ok('and the system prompt leads with restraint, not with estimation')
    : bad('system prompt');

  // The reply shape is the estimator's, which is the whole point — one parser.
  const parsed = parseMealEstimate(
    '{"title":"Steak dinner","items":[{"name":"Ribeye","grams":300,"kcal":800,"protein_g":60,' +
      '"carbs_g":0,"fat_g":62,"fiber_g":0,"confidence":"high"},{"name":"Olive oil","grams":28,' +
      '"kcal":248,"protein_g":0,"carbs_g":0,"fat_g":28,"fiber_g":0,"confidence":"medium"}],' +
      '"notes":"Swapped butter for olive oil at the same weight."}'
  );
  parsed.items.length === 2 && parsed.items[1].name === 'Olive oil' && parsed.notes !== null
    ? ok('a revision reply parses through the estimator’s own parser')
    : bad('revision parse', JSON.stringify(parsed));
}

console.log('\n21. caffeine and sodium: from an estimated item to the day’s total (A8)');
{
  // The owner's three are caffeine, fiber and sodium. Fiber has a column and a
  // target; the other two ride the micros JSON, which is why A8 needed no
  // migration. This walks one caffeinated item the whole way: model reply →
  // parser → grounding → logged meal → day total.
  MEAL_ESTIMATION_SYSTEM_PROMPT.includes('"caffeine_mg"') &&
  MEAL_ESTIMATION_SYSTEM_PROMPT.includes('sodium') &&
  MEAL_REVISION_SYSTEM_PROMPT.includes('"caffeine_mg"')
    ? ok('both system prompts ask for sodium and caffeine in micros')
    : bad('prompts do not request the two micros');

  const parsed = parseMealEstimate(
    '{"title":"Afternoon","items":[{"name":"Flat white","grams":240,"kcal":120,"protein_g":7,' +
      '"carbs_g":10,"fat_g":6,"fiber_g":0,"confidence":"high",' +
      // sodium and caffeine survive; the invented key and the non-number do not.
      '"micros":{"caffeine_mg":145,"sodium_mg":90,"vitamin_q_mg":3,"iron_mg":"lots"}},' +
      '{"name":"Rice cake","grams":9,"kcal":35,"protein_g":1,"carbs_g":7,"fat_g":0,' +
      '"fiber_g":0,"confidence":"medium"}],"notes":null}'
  );
  const coffeeMicros = parseMicros(parsed.items[0].micros);
  near(coffeeMicros.caffeine_mg, 145) &&
  near(coffeeMicros.sodium_mg, 90) &&
  coffeeMicros.iron_mg === undefined &&
  Object.keys(coffeeMicros).length === 2
    ? ok('parseMealEstimate keeps the model’s caffeine/sodium and drops the rest')
    : bad('parsed micros', parsed.items[0].micros);
  parsed.items[1].micros === null
    ? ok('an item that returned no micros stays NULL, never a fake {}')
    : bad('empty micros not null', parsed.items[1].micros);

  const { db } = freshDb();
  // A catalog coffee with macros but NO micros row — the seeded "Coffee, black"
  // is exactly this (0016). Grounding re-prices the macros and must leave the
  // model's caffeine standing, or the most caffeinated food in the catalog
  // would be the one that loses its caffeine.
  createFood(db, {
    name: 'Flat white',
    kcal_100g: 50,
    protein_g_100g: 3,
    carbs_g_100g: 4,
    fat_g_100g: 2.5,
  });
  const grounded = groundMealEstimate(db, parsed);
  const coffee = grounded.items[0];
  const groundedMicros = parseMicros(coffee.micros);
  coffee.foodId != null && near(coffee.kcal, 120) && near(groundedMicros.caffeine_mg, 145)
    ? ok('grounding to a micro-less food keeps the model’s caffeine')
    : bad('grounded coffee', JSON.stringify(coffee));

  logMealWithItems(db, {
    date: TODAY,
    time: '15:10',
    name: grounded.title,
    items: grounded.items.map((i) => ({
      name: i.name,
      amount: i.amount,
      kcal: i.kcal,
      protein_g: i.protein_g,
      carbs_g: i.carbs_g,
      fat_g: i.fat_g,
      fiber_g: i.fiber_g,
      micros: i.micros,
      confidence: i.confidence,
    })),
  });
  const totals = dayMicroTotals(db, TODAY);
  near(totals.caffeine_mg, 145) && near(totals.sodium_mg, 90)
    ? ok('the day’s totals carry caffeine and sodium from the estimate')
    : bad('day totals', JSON.stringify(totals));
  MICROS.some((m) => m.key === 'caffeine_mg' && m.reference === 400 && m.ceiling === true)
    ? ok('caffeine is in the vocabulary, referenced at the FDA’s 400 mg ceiling')
    : bad('caffeine descriptor missing or wrong');

  // And a revision SHOWS the model what it must hand back untouched — without
  // this, correcting one item would silently strip the caffeine off the others.
  const revisionText = buildMealRevisionRequest(
    {
      name: 'Afternoon',
      items: [
        {
          name: 'Flat white',
          amount: 240,
          kcal: 120,
          protein_g: 7,
          carbs_g: 10,
          fat_g: 6,
          micros: parsed.items[0].micros,
        },
      ],
    },
    'it was a double shot'
  ).messages[0].content[0].text;
  revisionText.includes('sodium 90 mg') && revisionText.includes('caffeine 145 mg')
    ? ok('the revision request states each item’s sodium and caffeine')
    : bad('revision row micros', revisionText);
}

// ===========================================================================
// 22. The estimator speaks `ml` (0047, backlog B2).
//
// The owner's ask in full: *"the AI should estimate how many ML a drink is,
// instead of grams, when using ml instead of g."* Three things have to hold for
// that to be true end to end — the prompt asks for it, the parser keeps it, and
// grounding cannot quietly swap a volume for a mass on the way past.
// ===========================================================================
console.log('22. the estimator returns, and the parser keeps, a drink in millilitres');
{
  MEAL_ESTIMATION_SYSTEM_PROMPT.includes('"unit": "g"|"ml"') &&
  MEAL_ESTIMATION_SYSTEM_PROMPT.includes('"ml" for anything DRUNK')
    ? ok('the prompt asks for a unit and says when it is ml')
    : bad('estimation prompt missing the unit rule');
  MEAL_ESTIMATION_SYSTEM_PROMPT.includes('never convert it to grams')
    ? ok('and forbids the conversion this whole design refuses')
    : bad('estimation prompt allows conversion');

  const est = parseMealEstimate(
    '{"title":"Flat white and toast","items":[' +
      '{"name":"Flat white","amount":240,"unit":"ml","kcal":120,"protein_g":7,"carbs_g":10,' +
      '"fat_g":6,"fiber_g":0,"micros":{"caffeine_mg":130},"confidence":"high"},' +
      '{"name":"Sourdough toast","amount":60,"unit":"g","kcal":160,"protein_g":6,"carbs_g":30,' +
      '"fat_g":1,"fiber_g":2,"confidence":"medium"}],"notes":null}'
  );
  est.items[0].unit === 'ml' && near(est.items[0].amount, 240)
    ? ok('a drink parses as 240 ml, not 240 of nothing')
    : bad('parsed drink', JSON.stringify(est.items[0]));
  est.items[1].unit === 'g' && near(est.items[1].amount, 60)
    ? ok('and the solid beside it is still grams')
    : bad('parsed solid', JSON.stringify(est.items[1]));

  // Two coercions, both deliberately permissive rather than throwing: an
  // estimate always lands on an editable review screen, so a wrong unit is
  // visible and one tap from fixed, while a refusal loses the whole meal.
  const legacy = parseMealEstimate(
    '{"items":[{"name":"Egg","grams":100,"kcal":155,"protein_g":13,"carbs_g":1,"fat_g":11,' +
      '"confidence":"high"}]}'
  );
  near(legacy.items[0].amount, 100) && legacy.items[0].unit === 'g'
    ? ok('a reply that still says "grams" lands as a gram amount rather than as no portion')
    : bad('legacy grams key', JSON.stringify(legacy.items[0]));
  const nonsense = parseMealEstimate(
    '{"items":[{"name":"Soup","amount":300,"unit":"cups","kcal":200,"protein_g":5,"carbs_g":20,' +
      '"fat_g":10,"confidence":"low"}]}'
  );
  nonsense.items[0].unit === 'g'
    ? ok('an unknown unit falls back to g — the review screen is where that gets corrected')
    : bad('unknown unit', nonsense.items[0].unit);
}

console.log('22b. grounding will not price a volume from a mass (or the reverse)');
{
  const { db } = freshDb();
  // Two foods with the SAME name, one per 100 g and one per 100 ml, is the
  // sharpest form of the trap: the name match is perfect, and only the unit
  // tells them apart.
  createFood(db, {
    name: 'Oat drink',
    basis: 'ml',
    kcal_100g: 46,
    protein_g_100g: 1,
    carbs_g_100g: 6.7,
    fat_g_100g: 1.5,
  });
  const mlHit = groundMealEstimate(db, {
    title: 'Coffee',
    notes: null,
    items: [
      {
        name: 'Oat drink',
        amount: 200,
        unit: 'ml',
        kcal: 120,
        protein_g: 3,
        carbs_g: 15,
        fat_g: 4,
        fiber_g: null,
        confidence: 'medium',
        foodId: null,
        micros: null,
      },
    ],
  }).items[0];
  mlHit.foodId !== null && near(mlHit.kcal, 92)
    ? ok('a millilitre item grounds to a per-100-ml food and is re-priced (200 ml → 92 kcal)')
    : bad('ml grounding', JSON.stringify(mlHit));

  const gMiss = groundMealEstimate(db, {
    title: 'Baking',
    notes: null,
    items: [
      {
        name: 'Oat drink',
        amount: 200,
        unit: 'g',
        kcal: 120,
        protein_g: 3,
        carbs_g: 15,
        fat_g: 4,
        fiber_g: null,
        confidence: 'medium',
        foodId: null,
        micros: null,
      },
    ],
  }).items[0];
  gMiss.foodId === null && near(gMiss.kcal, 120)
    ? ok('the same name at the wrong unit does NOT ground — the model’s own numbers stand')
    : bad('unit mismatch grounded anyway', JSON.stringify(gMiss));
}

console.log('22c. a revision is shown the meal in the units it was logged in');
{
  const req = buildMealRevisionRequest(
    {
      name: 'Afternoon',
      items: [
        {
          name: 'Flat white',
          amount: 240,
          unit: 'ml',
          kcal: 120,
          protein_g: 7,
          carbs_g: 10,
          fat_g: 6,
        },
        { name: 'Almonds', amount: 30, unit: 'g', kcal: 174, protein_g: 6, carbs_g: 6, fat_g: 15 },
      ],
    },
    'the flat white was a double'
  );
  const text = req.messages[0].content[0].text;
  text.includes('- Flat white — 240 ml, 120 kcal') && text.includes('- Almonds — 30 g, 174 kcal')
    ? ok('each item is stated in its own unit, so "leave it unchanged" can mean something')
    : bad('revision units', text);
  req.system.includes('restate a millilitre amount as grams')
    ? ok('and the revision prompt forbids re-uniting an item it was not asked about')
    : bad('revision prompt missing the unit rail');
}

console.log('23. AI add food (C2): one described food becomes one catalog entry');
{
  // The prompt is its own, not the meal estimator's — the two jobs share a
  // model and nothing else, and every word one does not need is a word the
  // other pays for on every call.
  FOOD_ENTRY_SYSTEM_PROMPT !== MEAL_ESTIMATION_SYSTEM_PROMPT &&
  FOOD_ENTRY_SYSTEM_PROMPT.includes('PER 100 of the basis, never per serving') &&
  FOOD_ENTRY_SYSTEM_PROMPT.includes('"ml" for anything DRUNK') &&
  FOOD_ENTRY_SYSTEM_PROMPT.includes('Use null for any figure you cannot estimate')
    ? ok('the food-entry prompt states per-100, the ml rule, and null-over-a-guess')
    : bad('food-entry prompt', FOOD_ENTRY_SYSTEM_PROMPT.slice(0, 200));

  const req = buildFoodEntryRequest('Costco rotisserie chicken thigh, skin on');
  req.system === FOOD_ENTRY_SYSTEM_PROMPT &&
  req.messages.length === 1 &&
  req.messages[0].content[0].text.includes('Costco rotisserie chicken thigh, skin on')
    ? ok('and the request is that prompt plus the description — no image block, one turn')
    : bad('food-entry request', JSON.stringify(req.messages));

  const entry = parseFoodEntry(`\`\`\`json
    {"name": "Rotisserie chicken thigh, skin on", "brand": "Costco", "basis": "g",
     "serving_name": "1 thigh", "serving_amount": 110,
     "kcal_100": 229, "protein_g_100": 24.5, "carbs_g_100": 0, "fat_g_100": 14.7,
     "fiber_g_100": 0, "micros": {"sodium_mg": 430, "caffeine_mg": 0, "unobtainium_mg": 9}}
    \`\`\``);
  entry.name === 'Rotisserie chicken thigh, skin on' &&
  entry.brand === 'Costco' &&
  entry.basis === 'g' &&
  entry.serving_name === '1 thigh' &&
  near(entry.serving_amount, 110) &&
  near(entry.kcal_100g, 229) &&
  near(entry.protein_g_100g, 24.5) &&
  near(entry.fat_g_100g, 14.7)
    ? ok('a fenced reply parses into one entry, per 100 of its basis, with its serving')
    : bad('food entry parse', JSON.stringify(entry));

  // A 0 is a measurement ("measured none") and survives; an invented key does
  // not. Same vocabulary filter the meal path uses.
  const micros = JSON.parse(entry.micros);
  micros.sodium_mg === 430 && micros.caffeine_mg === 0 && micros.unobtainium_mg === undefined
    ? ok('micros keep a measured 0 and drop a key the vocabulary has never heard of')
    : bad('food entry micros', entry.micros);

  // The unit model (0047): a drink is described in millilitres and nothing
  // converts it. The basis governs what the per-100 figures are per 100 OF.
  const drink = parseFoodEntry(
    '{"name": "Oat milk", "basis": "ml", "serving_name": "1 glass", "serving_amount": 250,' +
      ' "kcal_100": 47, "protein_g_100": 1, "carbs_g_100": 6.7, "fat_g_100": 1.5,' +
      ' "micros": {"caffeine_mg": 0}}'
  );
  drink.basis === 'ml' && near(drink.serving_amount, 250) && near(drink.kcal_100g, 47)
    ? ok('a drink comes back as ml with its serving in ml — nothing is converted to grams')
    : bad('ml basis', JSON.stringify(drink));

  parseFoodEntry('{"name": "Mystery", "basis": "cups"}').basis === 'g'
    ? ok('an unknown basis falls back to g, which is what every food was before 0047')
    : bad('basis fallback');
}

console.log('23b. what the parser refuses to pass on to a form the owner will save');
{
  // OUT OF RANGE IS DROPPED, NOT CLAMPED. A clamp invents a number the model
  // never gave and hides that it was wrong; a blank is this catalog's own word
  // for "not recorded", and it is one tap from corrected on the form.
  const wild = parseFoodEntry(
    '{"name": "Priced a serving by mistake", "kcal_100": 1200, "protein_g_100": 140,' +
      ' "carbs_g_100": 30, "fat_g_100": -3, "fiber_g_100": "some"}'
  );
  wild.kcal_100g === null &&
  wild.protein_g_100g === null &&
  near(wild.carbs_g_100g, 30) &&
  wild.fat_g_100g === null &&
  wild.fiber_g_100g === null
    ? ok('over the schema bounds, negative, and non-numeric all become null; the sane one stays')
    : bad('bounds', JSON.stringify(wild));

  // Pair-or-none, because the table CHECK is: a name with no size is unusable,
  // a size with no name is meaningless, and either half alone fails on save.
  const half = parseFoodEntry('{"name": "Half a serving claim", "serving_name": "1 scoop"}');
  half.serving_name === null && half.serving_amount === null
    ? ok('half a serving claim is dropped whole rather than tripping the CHECK at save')
    : bad('serving pairing', JSON.stringify(half));

  const zero = parseFoodEntry(
    '{"name": "Zero serving", "serving_name": "1 jar", "serving_amount": 0}'
  );
  zero.serving_amount === null && zero.serving_name === null
    ? ok('a 0 g serving is not a serving (the column is CHECK > 0)')
    : bad('zero serving', JSON.stringify(zero));

  let threw = 0;
  for (const reply of ['no json here', '{"brand": "Anon"}', '{"name": "   "}', '{']) {
    try {
      parseFoodEntry(reply);
    } catch {
      threw++;
    }
  }
  threw === 4
    ? ok('a nameless or unparseable reply throws — a blank form typed wrong is worse than none')
    : bad('parse refusals', `${threw} of 4 threw`);
}

console.log('23c. the described entry is marked, and nothing is written before Save');
{
  // parseFoodEntry takes no database and returns a value — the whole C2 path up
  // to the Save tap is pure. The row appears only when the screen calls
  // createFood, and the stamp it carries then is what the catalog reads.
  const { db } = freshDb();
  const before = db.get('SELECT count(*) AS n FROM foods').n;
  const proposed = parseFoodEntry('{"name": "Described but never saved", "kcal_100": 100}');
  db.get('SELECT count(*) AS n FROM foods').n === before && proposed.name !== ''
    ? ok('parsing a reply writes nothing — the proposal lives in the form until it is saved')
    : bad('parse wrote a row');

  const id = createFood(db, {
    name: proposed.name,
    kcal_100g: proposed.kcal_100g,
    micros: proposed.micros,
    source: 'ai',
  });
  const saved = db.get('SELECT source, name FROM foods WHERE id = ?', [id]);
  saved.source === 'ai'
    ? ok('and when it IS saved it carries source=ai, so an inferred number never reads as typed')
    : bad('ai stamp', JSON.stringify(saved));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
