/**
 * Headless test of the nutrition sub-app's round-2 features — micronutrient
 * snapshots (0017), meal templates (0018), the cross-day history read, and the
 * pure AI-estimate helpers — against real SQLite via node:sqlite. Mirrors
 * db/foods.test.mjs; op-sqlite is never loaded. Run: npm run db:test.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { ModelRequestError } from '../src/lib/ai/model-client.ts';
import { todayISODate } from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { createFood, getFood } from '../src/lib/db/repositories/foods.ts';
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
  deleteMeal,
  getMeal,
  latestMealPhoto,
  listMealItems,
  logMeal,
  listTodayMeals,
  logMealWithItems,
  mealItemCounts,
  nutritionHistory,
  partialMealMetrics,
  relogMeal,
  removeMealItem,
  replaceMealItems,
  scaleCompositeItem,
  setNutritionTargets,
  todayTotals,
  updateMealItemPortion,
  updateMealTime,
} from '../src/lib/db/repositories/nutrition.ts';
import {
  listPendingEstimates,
  pendingEstimateForMeal,
  pendingEstimateMealIds,
  placeholderMealName,
  queueMealRevision,
  queueNewMealEstimate,
} from '../src/lib/db/repositories/pending-estimates.ts';
import {
  drainEstimateQueue,
  failureReason,
  isQueueableFailure,
} from '../src/lib/nutrition/estimate-queue.ts';
import {
  sweepPendingEstimatePhotos,
  writePendingEstimatePhoto,
} from '../src/lib/media/pending-estimate-store.ts';
import {
  attachMealPhoto,
  deleteMealWithPhotos,
  MEAL_PHOTO_RETENTION_DAYS,
  mealPhotoView,
  sweepMealPhotos,
} from '../src/lib/media/meal-photo-store.ts';
import { assembleMealItems } from '../src/lib/nutrition/composite.ts';
import {
  applyAnswer,
  currentPortion,
  reviewKcal,
  rowsFromEstimate,
  rowsToMealItems,
} from '../src/lib/nutrition/review-rows.ts';
import { dayFigure } from '../src/lib/nutrition/remaining.ts';
import {
  buildMealEstimationRequest,
  buildMealRevisionRequest,
  groundMealEstimate,
  MEAL_ESTIMATION_SYSTEM_PROMPT,
  ESTIMATOR_PROMPT_CEILING,
  MEAL_REVISION_SYSTEM_PROMPT,
  MealEstimateParseError,
  MealEstimationUnavailableError,
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
import { lookupOffProduct, OffLookupError } from '../src/lib/nutrition/openfoodfacts.ts';
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
    readBase64: (name) => files.get(name) ?? null,
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

// === Offline food logging (0057, backlog C3) =================================
//
// Two halves, tested as two different kinds of claim:
//
//   · the catalog / template / manual path is offline BY CONSTRUCTION, which is
//     a fact about the SOURCE (nothing on it calls fetch) and is asserted as
//     one — a behavioural test would pass just as happily on a path that calls
//     the network and swallows the failure;
//   · the AI path QUEUES, which is a fact about behaviour and is walked end to
//     end: offline → a visible placeholder → a restart → a reconnect → the
//     items landing, with the placeholder never once reading 0 kcal.

/** An estimate reply, as the model would send it. */
const REPLY = JSON.stringify({
  title: 'Chicken and rice',
  items: [
    {
      name: 'Grilled chicken breast',
      amount: 180,
      unit: 'g',
      kcal: 297,
      protein_g: 56,
      carbs_g: 0,
      fat_g: 7,
      fiber_g: 0,
      confidence: 'high',
    },
    {
      name: 'White rice',
      amount: 200,
      unit: 'g',
      kcal: 260,
      protein_g: 5,
      carbs_g: 56,
      fat_g: 1,
      fiber_g: 1,
      confidence: 'medium',
    },
  ],
  notes: 'Cooking oil not visible; assumed a teaspoon.',
});

/** The network being gone, as `expo/fetch` actually reports it. */
const offline = () => new TypeError('Network request failed');

/** Estimators that answer, count their calls, and record what they were sent. */
function fakeEstimators(reply = REPLY) {
  const calls = [];
  return {
    calls,
    estimate: async (input) => {
      calls.push({ kind: 'estimate', input });
      return parseMealEstimate(reply);
    },
    revise: async (meal, instruction) => {
      calls.push({ kind: 'revise', meal, instruction });
      return parseMealEstimate(reply);
    },
  };
}

/** Estimators that are still offline. */
function deadEstimators() {
  return {
    estimate: async () => {
      throw offline();
    },
    revise: async () => {
      throw offline();
    },
  };
}

console.log('23. C3: the catalog and manual paths need no network at all');
{
  // A SOURCE assertion, deliberately. "Logging a food works offline" is only
  // true if nothing on the path reaches for the network in the first place —
  // a runtime test cannot tell that from a fetch whose failure is swallowed,
  // and the swallowed one degrades silently the day someone adds a lookup.
  const OFFLINE_PATH = [
    'src/lib/db/repositories/foods.ts',
    'src/lib/db/repositories/nutrition.ts',
    'src/lib/db/repositories/meal-templates.ts',
    'src/lib/nutrition/servings.ts',
    'src/lib/nutrition/micros.ts',
    'src/components/nutrition/log-sheet.tsx',
    'app/food-search.tsx',
    'app/food-new.tsx',
    'app/meal-templates.tsx',
  ];
  const networked = OFFLINE_PATH.filter((file) => {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    return /\bfetch\s*\(/.test(source) || /from '.*openfoodfacts'/.test(source);
  });
  networked.length === 0
    ? ok(`all ${OFFLINE_PATH.length} catalog/manual modules are network-free at the source`)
    : bad('a catalog/manual module reaches the network', networked.join(' · '));

  // And the whole path runs, with no network in the room: create a food, price a
  // portion, log it, read the day back.
  const { db } = freshDb();
  const foodId = createFood(db, {
    name: 'Skyr',
    kcal_100g: 63,
    protein_g_100g: 11,
    carbs_g_100g: 4,
    fat_g_100g: 0.2,
  });
  const { mealId } = logMealWithItems(db, {
    date: TODAY,
    time: '08:00',
    name: 'Breakfast',
    items: [itemForPortion(getFood(db, foodId), { amount: 200 })],
  });
  near(todayTotals(db, TODAY).kcal, 126) && listMealItems(db, mealId).length === 1
    ? ok('catalog → portion → logged meal → day total, with nothing to connect to')
    : bad('offline catalog path', JSON.stringify(todayTotals(db, TODAY)));

  // The one nutrition path that DOES use the network already degrades rather
  // than throwing something raw into a screen: a rejecting fetch becomes an
  // OffLookupError the scanner reads as "you're offline" (its ladder then falls
  // back to manual entry). Confirmed here beside the rest of the offline story,
  // because "the OFF lookup already degrades — confirm" is a C3 requirement.
  let offErr = null;
  try {
    await lookupOffProduct('5060000000000', () => Promise.reject(offline()));
  } catch (e) {
    offErr = e;
  }
  offErr instanceof OffLookupError
    ? ok('the Open Food Facts lookup degrades to a named error, never a raw throw')
    : bad('OFF lookup does not degrade', String(offErr));
}

console.log('24. C3: an estimate made offline is QUEUED, and the meal is visible');
{
  const { db } = freshDb();
  const { mealId } = queueNewMealEstimate(
    db,
    { date: TODAY, time: '13:05', name: placeholderMealName('a chicken burrito and a lager') },
    { kind: 'text', description: 'a chicken burrito and a lager' }
  );

  const meal = getMeal(db, mealId);
  meal && meal.source === 'ai_suggested' && meal.name === 'a chicken burrito and a lager'
    ? ok('the placeholder is in the day, named with the user’s own words')
    : bad('placeholder meal', JSON.stringify(meal));

  // THE 0-KCAL TRAP. A placeholder must never read as a meal that was measured
  // at zero: NULL is "not recorded", 0 is "I ate nothing", and only one of them
  // is true. The Eat tab draws NULL as an em-dash.
  meal.kcal === null && meal.protein_g === null && meal.carbs_g === null && meal.fat_g === null
    ? ok('…with NULL macros — never a fabricated 0 kcal')
    : bad('placeholder carries numbers', JSON.stringify(meal));
  const totals = todayTotals(db, TODAY);
  totals.kcal === 0 && totals.mealCount === 1
    ? ok('the day counts the meal but no energy (sum() skips NULL)')
    : bad('day totals', JSON.stringify(totals));

  const queued = pendingEstimateForMeal(db, mealId);
  queued && queued.kind === 'text' && queued.attempts === 0 && queued.file_name === null
    ? ok('the request is queued beside it, in one transaction')
    : bad('queue row', JSON.stringify(queued));

  pendingEstimateMealIds(db, TODAY).has(mealId)
    ? ok('and the Eat tab can see which meals are waiting')
    : bad('pendingEstimateMealIds missed the meal');

  // A name the row can actually hold at phone width.
  placeholderMealName(null) === 'Photographed meal' &&
  placeholderMealName('   ') === 'Photographed meal' &&
  placeholderMealName('x'.repeat(200)).length <= 61
    ? ok('a wordless capture gets a plain name, and a paragraph is cut to one line')
    : bad('placeholderMealName', placeholderMealName('x'.repeat(200)));
}

console.log('25. C3: which failures are worth waiting on');
{
  // The whole classifier, as a table. The dangerous mistake is the last row: an
  // HTTP error means the API ANSWERED, so queueing it re-bills the same
  // rejection tomorrow — and a parse failure will parse identically badly.
  isQueueableFailure(offline())
    ? ok('a transport failure (expo/fetch rejecting) queues')
    : bad('network failure not queued');
  isQueueableFailure(
    new ModelRequestError(0, null, 'Model stream ended before the reply completed.')
  )
    ? ok('a stream that died mid-reply queues (status 0 = no HTTP response)')
    : bad('status-0 ModelRequestError not queued');
  !isQueueableFailure(new ModelRequestError(401, 'authentication_error', 'invalid key'))
    ? ok('a 401 does NOT queue — the API answered; waiting fixes nothing')
    : bad('401 queued');
  !isQueueableFailure(new ModelRequestError(429, 'rate_limit_error', 'slow down'))
    ? ok('nor does a 429')
    : bad('429 queued');
  !isQueueableFailure(new MealEstimateParseError('Meal estimate reply was not valid JSON.'))
    ? ok('nor an unreadable reply — the same request produces the same nonsense')
    : bad('parse failure queued');
  !isQueueableFailure(new MealEstimationUnavailableError())
    ? ok('nor a missing model key')
    : bad('unavailable queued');
  const aborted = new Error('aborted');
  aborted.name = 'AbortError';
  !isQueueableFailure(aborted)
    ? ok('nor an abort — the user left the screen')
    : bad('abort queued');
  failureReason(offline()) === 'TypeError: Network request failed'
    ? ok('and the reason recorded on the row is the error, not a stack')
    : bad('failureReason', failureReason(offline()));
}

console.log('26. C3: the queue survives a restart, then drains');
{
  const { db, raw } = freshDb();
  const { mealId } = queueNewMealEstimate(
    db,
    { date: TODAY, time: '13:05', name: 'a chicken burrito' },
    { kind: 'text', description: 'a chicken burrito' }
  );

  // STILL OFFLINE. The row is kept, the attempt is counted, and the placeholder
  // is untouched — in particular it still reads NULL, not 0.
  const stillDown = await drainEstimateQueue(db, {
    estimators: deadEstimators(),
    pendingStore: null,
    mealPhotoStore: null,
  });
  const kept = pendingEstimateForMeal(db, mealId);
  stillDown.applied === 0 && stillDown.kept === 1 && kept.attempts === 1 && kept.last_error !== null
    ? ok('a drain with no network keeps the request and counts the attempt')
    : bad('offline drain', JSON.stringify({ stillDown, kept }));
  getMeal(db, mealId).kcal === null
    ? ok('…and the placeholder still reads “not recorded”, never 0 kcal')
    : bad('placeholder gained numbers on a failed drain');

  // A RESTART. Re-running the migration runner over the same file is exactly
  // what the app does on every launch; the queue is rows, so it is still there.
  migrate(
    {
      exec: (sql) => raw.exec(sql),
      getUserVersion: () => raw.prepare('PRAGMA user_version').get().user_version,
      setUserVersion: (n) => raw.exec(`PRAGMA user_version = ${n}`),
      transaction: db.transaction,
    },
    MIGRATIONS
  );
  listPendingEstimates(db).length === 1
    ? ok('the queue survives a restart (it is rows, not React state)')
    : bad('queue lost on restart');

  // BACK ONLINE.
  const estimators = fakeEstimators();
  const drained = await drainEstimateQueue(db, {
    estimators,
    pendingStore: null,
    mealPhotoStore: null,
  });
  const after = getMeal(db, mealId);
  const items = listMealItems(db, mealId);
  drained.applied === 1 && drained.kept === 0
    ? ok('a drain with a connection applies the estimate and empties the queue')
    : bad('drain', JSON.stringify(drained));
  items.length === 2 && near(after.kcal, 557) && after.name === 'Chicken and rice'
    ? ok('the placeholder becomes the estimated meal — items, totals and the model’s title')
    : bad('applied meal', JSON.stringify({ name: after.name, kcal: after.kcal, n: items.length }));
  after.notes === 'Cooking oil not visible; assumed a teaspoon.'
    ? ok('and the model’s caveat lands as the meal’s note')
    : bad('notes not carried', String(after.notes));
  items.every((i) => i.confidence !== null) && after.source === 'ai_suggested'
    ? ok('still labelled an estimate: per-item confidence, source ai_suggested')
    : bad('provenance lost', JSON.stringify(items.map((i) => i.confidence)));
  estimators.calls.length === 1 && estimators.calls[0].input.kind === 'text'
    ? ok('exactly one model call was made, as a text request')
    : bad('calls', JSON.stringify(estimators.calls.map((c) => c.kind)));
}

console.log('27. C3: a queued PHOTO carries its bytes, and lands them on the meal');
{
  const { db } = freshDb();
  const pendingStore = fakeStore();
  const mealPhotoStore = fakeStore();

  const fileName = writePendingEstimatePhoto('/9j/plate', pendingStore);
  const { mealId } = queueNewMealEstimate(
    db,
    { date: TODAY, time: '19:40', name: placeholderMealName(null) },
    { kind: 'photo', file_name: fileName, width: 1024, height: 768 }
  );
  getMeal(db, mealId).name === 'Photographed meal' && pendingStore.files.size === 1
    ? ok('the shot is parked in its own directory, not in meal-photos')
    : bad('photo not parked');

  const estimators = fakeEstimators();
  await drainEstimateQueue(db, { estimators, pendingStore, mealPhotoStore });

  estimators.calls[0].input.kind === 'photo' && estimators.calls[0].input.base64Jpeg === '/9j/plate'
    ? ok('the drain re-reads the bytes and sends them as a photo request')
    : bad('photo request', JSON.stringify(estimators.calls[0]?.input?.kind));
  const photo = latestMealPhoto(db, mealId);
  photo && mealPhotoStore.files.get(photo.file_name) === '/9j/plate' && photo.width === 1024
    ? ok('…and the picture ends up on the meal, in the meal-photo directory')
    : bad('photo not attached', JSON.stringify(photo));
  pendingStore.files.size === 0 && listPendingEstimates(db).length === 0
    ? ok('the queued copy and its row are gone — one photo, not two')
    : bad('pending copy left behind');
}

console.log('28. C3: giving up, orphans, and a photo whose file vanished');
{
  const { db } = freshDb();
  const pendingStore = fakeStore();
  const fileName = writePendingEstimatePhoto('/9j/plate', pendingStore);
  const { mealId } = queueNewMealEstimate(
    db,
    { date: TODAY, time: '19:40', name: 'Photographed meal' },
    { kind: 'photo', file_name: fileName, description: 'a bowl of pho' }
  );

  // Deleting the placeholder is the whole of "forget it" — the queue row goes
  // with the meal, and the sweep reclaims the file it leaves behind.
  deleteMeal(db, mealId);
  listPendingEstimates(db).length === 0
    ? ok('deleting the placeholder CASCADEs its queued request away')
    : bad('queue row survived the meal');
  const swept = sweepPendingEstimatePhotos(db, pendingStore);
  swept.orphanFilesRemoved === 1 && pendingStore.files.size === 0
    ? ok('and the orphan pass reclaims the file nothing claims any more')
    : bad('orphan not swept', JSON.stringify(swept));

  // A row whose FILE went missing degrades to its words rather than losing the
  // meal. (One direction only — the sweep never deletes a row.)
  const store2 = fakeStore();
  const second = queueNewMealEstimate(
    db,
    { date: TODAY, time: '20:10', name: 'a bowl of pho' },
    { kind: 'photo', file_name: 'gone.jpg', description: 'a bowl of pho' }
  );
  sweepPendingEstimatePhotos(db, store2).orphanFilesRemoved === 0 &&
  listPendingEstimates(db).length === 1
    ? ok('a row whose file is missing keeps its row — the words are still a request')
    : bad('row deleted by the sweep');
  const estimators = fakeEstimators();
  await drainEstimateQueue(db, { estimators, pendingStore: store2, mealPhotoStore: fakeStore() });
  estimators.calls[0].input.kind === 'text' &&
  estimators.calls[0].input.description === 'a bowl of pho' &&
  listMealItems(db, second.mealId).length === 2
    ? ok('…and the drain sends them as a text request rather than dropping the meal')
    : bad('degrade to text', JSON.stringify(estimators.calls[0]?.input));
}

console.log('29. C3: a queued REVISION is applied to the items as they stand then');
{
  const { db } = freshDb();
  const { mealId } = logMealWithItems(db, {
    date: TODAY,
    time: '12:00',
    name: 'Lunch',
    items: [
      { name: 'Butter', amount: 10, kcal: 72, protein_g: 0, carbs_g: 0, fat_g: 8 },
      { name: 'Steak', amount: 200, kcal: 500, protein_g: 50, carbs_g: 0, fat_g: 32 },
    ],
  });
  queueMealRevision(db, mealId, 'that was olive oil, not butter');
  // Nothing moved: a queued revision leaves the meal countable.
  near(getMeal(db, mealId).kcal, 572) && listMealItems(db, mealId).length === 2
    ? ok('the meal keeps its items while the correction waits')
    : bad('meal changed while queued');

  // The user edits the meal by hand while still offline. The drain must send
  // THAT as the "before", not a snapshot taken when the correction was typed.
  addMealItem(db, mealId, {
    name: 'Bread',
    amount: 60,
    kcal: 160,
    protein_g: 6,
    carbs_g: 30,
    fat_g: 1,
  });
  const estimators = fakeEstimators();
  await drainEstimateQueue(db, { estimators, pendingStore: null, mealPhotoStore: null });
  const sent = estimators.calls[0];
  sent.kind === 'revise' &&
  sent.instruction === 'that was olive oil, not butter' &&
  sent.meal.items.length === 3 &&
  sent.meal.items.some((i) => i.name === 'Bread')
    ? ok('the drain re-reads the items at drain time — the hand-edit is the “before”')
    : bad('stale subject', JSON.stringify(sent?.meal?.items?.map((i) => i.name)));
  const revised = getMeal(db, mealId);
  revised.name === 'Lunch' && listMealItems(db, mealId).length === 2
    ? ok('…and a revision replaces the items only, never the meal’s name')
    : bad('revision touched the meal', revised.name);
  listPendingEstimates(db).length === 0
    ? ok('the queue is empty afterwards')
    : bad('revision left in the queue');
}

// === Composite foods (0058, backlog C4) ======================================
//
// The owner: *"one composite item (pepperoni pizza) as well as rows below that
// are pizza crust, cheese, and pepperoni. If I ate the whole pizza but took the
// pepperoni off half, I could change just one thing. If I ate only half, I
// could change the entire thing together."*
//
// The asymmetry that shapes every assertion below: a header carrying its
// children's sum would let a forgetful query DOUBLE the pizza in the day's
// calories, while a NULL-macro header makes a forgetful query under-count by
// zero. So the numbers are asserted as numbers, twice — once through
// `meals.kcal`, once through `partialMealMetrics`, which is the read that would
// otherwise fail silently.

/** A three-part pizza in a meal that also holds a beer. */
function pizzaMeal(db, date = TODAY) {
  return logMealWithItems(db, {
    date,
    time: '19:30',
    name: 'Dinner',
    items: [
      {
        name: 'Pepperoni pizza',
        // Deliberately supplied WITH numbers, to prove they are dropped.
        kcal: 9999,
        protein_g: 999,
        amount: 9999,
        components: [
          { name: 'Pizza crust', amount: 300, kcal: 800, protein_g: 26, carbs_g: 160, fat_g: 6 },
          { name: 'Mozzarella', amount: 150, kcal: 450, protein_g: 33, carbs_g: 5, fat_g: 33 },
          { name: 'Pepperoni', amount: 60, kcal: 300, protein_g: 12, carbs_g: 2, fat_g: 27 },
        ],
      },
      { name: 'Lager', amount: 330, unit: 'ml', kcal: 140, protein_g: 1, carbs_g: 11, fat_g: 0 },
    ],
  });
}

/** One tree node as the revision model is shown it. */
function toSubject(node) {
  const plain = (i) => ({
    name: i.name,
    amount: i.amount,
    unit: i.unit,
    kcal: i.kcal,
    protein_g: i.protein_g,
    carbs_g: i.carbs_g,
    fat_g: i.fat_g,
  });
  return node.kind === 'composite'
    ? { ...plain(node.item), components: node.components.map(plain) }
    : plain(node.item);
}

console.log('30. C4: the totals count the PARTS, and the header carries nothing');
{
  const { db } = freshDb();
  const { mealId } = pizzaMeal(db);
  const rows = listMealItems(db, mealId);
  const header = rows.find((r) => r.is_composite === 1);

  header &&
  header.kcal === null &&
  header.protein_g === null &&
  header.amount === null &&
  header.confidence === null &&
  header.parent_item_id === null
    ? ok('a composite header stores no numbers of its own — invariants 1 and 2')
    : bad('header carries numbers', JSON.stringify(header));
  rows.filter((r) => r.parent_item_id === header.id).length === 3
    ? ok('its three parts hang off it')
    : bad('parts missing');

  // THE DOUBLE-COUNT GUARD, as a number: 800 + 450 + 300 + 140 = 1,690. The
  // header's 9,999 was supplied and dropped.
  near(getMeal(db, mealId).kcal, 1690) && near(todayTotals(db, TODAY).kcal, 1690)
    ? ok('the meal and the day count the parts only (1,690 kcal, not 11,689)')
    : bad('double count', String(getMeal(db, mealId).kcal));
  near(getMeal(db, mealId).protein_g, 72)
    ? ok('…and the same for protein')
    : bad('protein', String(getMeal(db, mealId).protein_g));

  // THE REGRESSION THAT WOULD OTHERWISE SHIP SILENTLY. A macro-less header
  // trips partialMealMetrics on every metric, and the Eat tab's hero stops
  // counting down for a meal that is fully priced.
  const partial = partialMealMetrics(db, TODAY);
  partial[mealId] === undefined
    ? ok('a NULL-macro header does NOT mark the meal knowingly short')
    : bad('composite marked partial', JSON.stringify(partial[mealId]));
  setNutritionTargets(db, { effective_date: TODAY, kcal: 2400 });
  const figure = dayFigure(listTodayMeals(db, TODAY), 'kcal', 2400, partial);
  figure.mode === 'remaining' && figure.remaining === 710
    ? ok('…so the day stays in countdown mode: 710 kcal left of 2,400')
    : bad('countdown mode lost', JSON.stringify(figure));

  // The tally answers a DIFFERENT question from the sums: it counts what the
  // collapsed ledger draws, which is one row per pizza.
  mealItemCounts(db, TODAY)[mealId] === 2
    ? ok('the Eat-tab tally reads "2 items" — the pizza and the beer, as drawn')
    : bad('item count', String(mealItemCounts(db, TODAY)[mealId]));
}

console.log('31. C4: the tree the screens read');
{
  const { db } = freshDb();
  const { mealId } = pizzaMeal(db);
  const nodes = assembleMealItems(listMealItems(db, mealId));

  nodes.length === 2 && nodes[0].kind === 'composite' && nodes[1].kind === 'item'
    ? ok('assembleMealItems returns the pizza as one node and the beer as another')
    : bad('tree shape', JSON.stringify(nodes.map((n) => n.kind)));
  const rolledUp = nodes[0].rolled;
  near(rolledUp.kcal, 1550) && near(rolledUp.amount, 510) && rolledUp.unit === 'g'
    ? ok('the collapsed headline IS the parts’ sum — 510 g, 1,550 kcal')
    : bad('rollup', JSON.stringify(rolledUp));

  // Nothing converts (B2/0047): parts in two units do not sum to an amount.
  const mixed = logMealWithItems(db, {
    date: TODAY,
    time: '10:00',
    name: 'Odd',
    items: [
      {
        name: 'Affogato',
        components: [
          { name: 'Espresso', amount: 60, unit: 'ml', kcal: 5 },
          { name: 'Gelato', amount: 90, unit: 'g', kcal: 200 },
        ],
      },
    ],
  });
  const mixedRoll = assembleMealItems(listMealItems(db, mixed.mealId))[0].rolled;
  mixedRoll.amount === null && near(mixedRoll.kcal, 205)
    ? ok('parts in ml and g roll up their energy but NOT their amount — nothing converts')
    : bad('units converted', JSON.stringify(mixedRoll));

  // A ledger never silently loses a row it is holding.
  const all = listMealItems(db, mealId);
  const orphaned = all
    .filter((r) => r.parent_item_id === null || r.is_composite === 0)
    .filter((r) => r.is_composite === 0);
  const withOrphan = assembleMealItems([
    ...orphaned,
    { ...all.find((r) => r.parent_item_id !== null), parent_item_id: 'gone' },
  ]);
  withOrphan.some((n) => n.item.parent_item_id === 'gone')
    ? ok('a component whose parent is absent is emitted top-level, never dropped')
    : bad('orphan dropped');
}

console.log('32. C4: editing — one part, the whole dish, and the last part');
{
  const { db } = freshDb();
  const { mealId } = pizzaMeal(db);
  const rows = listMealItems(db, mealId);
  const header = rows.find((r) => r.is_composite === 1);
  const pepperoni = rows.find((r) => r.name === 'Pepperoni');
  const crustBefore = rows.find((r) => r.name === 'Pizza crust');

  // "I took the pepperoni off half": one part, 60 g → 30 g.
  updateMealItemPortion(db, pepperoni.id, rescaleLoggedItem(pepperoni, undefined, { amount: 30 }));
  const afterOne = listMealItems(db, mealId);
  const crustAfter = afterOne.find((r) => r.name === 'Pizza crust');
  near(afterOne.find((r) => r.name === 'Pepperoni').kcal, 150) &&
  near(crustAfter.kcal, crustBefore.kcal) &&
  near(crustAfter.amount, crustBefore.amount)
    ? ok('editing one part leaves its siblings byte-identical')
    : bad('sibling moved', JSON.stringify(crustAfter));
  near(getMeal(db, mealId).kcal, 1540)
    ? ok('…and moves only the totals: 1,690 − 150 = 1,540')
    : bad('totals after part edit', String(getMeal(db, mealId).kcal));

  // "I only ate half" — AFTER the hand-correction, so it halves the CORRECTED
  // pepperoni (the owner's own answer to that question).
  scaleCompositeItem(db, header.id, 0.5);
  const halved = listMealItems(db, mealId);
  near(halved.find((r) => r.name === 'Pepperoni').kcal, 75) &&
  near(halved.find((r) => r.name === 'Pepperoni').amount, 15) &&
  near(halved.find((r) => r.name === 'Pizza crust').kcal, 400)
    ? ok('“I ate half” halves the CORRECTED values, not the originals')
    : bad('scale', JSON.stringify(halved.map((r) => [r.name, r.kcal])));
  near(getMeal(db, mealId).kcal, 840)
    ? ok('…and the meal follows: (800+450+150)/2 + 140 = 840')
    : bad('totals after scale', String(getMeal(db, mealId).kcal));

  // No rounding on write, so changing your mind costs nothing.
  scaleCompositeItem(db, header.id, 2);
  const back = listMealItems(db, mealId);
  near(back.find((r) => r.name === 'Pepperoni').amount, 30) &&
  near(back.find((r) => r.name === 'Pizza crust').amount, 300)
    ? ok('×0.5 then ×2 round-trips EXACTLY — nothing is rounded on write')
    : bad('round trip lost precision', JSON.stringify(back.map((r) => [r.name, r.amount])));

  // Removing parts: a non-last one leaves the composite; the last takes it.
  removeMealItem(db, back.find((r) => r.name === 'Pepperoni').id);
  listMealItems(db, mealId).some((r) => r.is_composite === 1)
    ? ok('removing one part of three leaves the composite standing')
    : bad('composite removed too early');
  removeMealItem(db, listMealItems(db, mealId).find((r) => r.name === 'Mozzarella').id);
  removeMealItem(db, listMealItems(db, mealId).find((r) => r.name === 'Pizza crust').id);
  const left = listMealItems(db, mealId);
  left.length === 1 && left[0].name === 'Lager'
    ? ok('removing the LAST part removes the composite with it (invariant 4)')
    : bad('header left over nothing', JSON.stringify(left.map((r) => r.name)));
  near(getMeal(db, mealId).kcal, 140)
    ? ok('…and the meal is left holding the beer alone')
    : bad('totals after emptying', String(getMeal(db, mealId).kcal));
}

console.log('33. C4: deleting a composite takes its parts (the FK cascade)');
{
  const { db } = freshDb();
  const { mealId } = pizzaMeal(db);
  const header = listMealItems(db, mealId).find((r) => r.is_composite === 1);
  removeMealItem(db, header.id);
  const left = listMealItems(db, mealId);
  left.length === 1 && left[0].name === 'Lager' && near(getMeal(db, mealId).kcal, 140)
    ? ok('removing the header cascades its three parts away, and the totals follow')
    : bad('cascade', JSON.stringify(left.map((r) => r.name)));
}

console.log('34. C4: the estimator returns a composite, and grounding will not price it');
{
  const { db } = freshDb();
  // The seeded whole-dish archetype most likely to be matched wrongly.
  createFood(db, {
    name: 'Cheeseburger, fast food',
    kcal_100g: 250,
    protein_g_100g: 13,
    carbs_g_100g: 20,
    fat_g_100g: 13,
  });
  createFood(db, {
    name: 'Beef patty, grilled',
    kcal_100g: 250,
    protein_g_100g: 26,
    carbs_g_100g: 0,
    fat_g_100g: 17,
  });

  const parsed = parseMealEstimate(
    JSON.stringify({
      title: 'Burger and fries',
      items: [
        {
          name: 'Cheeseburger',
          amount: 220,
          kcal: 550,
          protein_g: 30,
          carbs_g: 40,
          fat_g: 28,
          confidence: 'medium',
          micros: { sodium_mg: 900 },
          components: [
            { name: 'Bun', amount: 80, kcal: 210, protein_g: 7, carbs_g: 40, fat_g: 2 },
            { name: 'Beef patty', amount: 110, kcal: 275, protein_g: 29, carbs_g: 0, fat_g: 19 },
            { name: 'Cheese slice', amount: 20, kcal: 70, protein_g: 4, carbs_g: 1, fat_g: 6 },
            { name: 'Sauce', amount: 10, kcal: 50, protein_g: 0, carbs_g: 2, fat_g: 5 },
            { name: 'Pickle', amount: 5, kcal: 1, protein_g: 0, carbs_g: 0, fat_g: 0 },
          ],
        },
        { name: 'Fries', amount: 120, kcal: 380, protein_g: 4, carbs_g: 48, fat_g: 19 },
      ],
      notes: null,
    })
  );
  const burger = parsed.items[0];
  burger.kcal === null && burger.amount === null && burger.micros === null
    ? ok('the header’s own macros are DROPPED, not reconciled')
    : bad('header kept numbers', JSON.stringify(burger));
  burger.components.length === 4
    ? ok('five parts are capped at four — the parser enforces it, not the prompt')
    : bad('cap', String(burger.components?.length));
  burger.components.every((c) => c.confidence === 'medium')
    ? ok('each part inherits the dish’s confidence')
    : bad('confidence not inherited');
  parsed.items[1].components === null && parsed.items[1].kcal === 380
    ? ok('a plain item beside it is untouched')
    : bad('plain item changed');

  // A one-part "composite" is not a composite — it is the item wearing a header.
  parseMealEstimate(
    JSON.stringify({
      title: 'X',
      items: [{ name: 'Toast', amount: 40, kcal: 100, components: [{ name: 'Bread', kcal: 100 }] }],
    })
  ).items[0].components === null
    ? ok('a single-part components array collapses — a chevron over nothing is noise')
    : bad('one-part composite kept');
  parseMealEstimate(
    JSON.stringify({ title: 'X', items: [{ name: 'Toast', kcal: 100, components: [] }] })
  ).items[0].kcal === 100
    ? ok('an empty components array is a plain item, with its macros intact')
    : bad('empty components mishandled');

  const grounded = groundMealEstimate(db, parsed);
  grounded.items[0].foodId === null && grounded.items[0].kcal === null
    ? ok('grounding NEVER prices a header — not even against "Cheeseburger, fast food"')
    : bad('header grounded', JSON.stringify(grounded.items[0]));
  const patty = grounded.items[0].components.find((c) => c.name === 'Beef patty');
  patty.foodId !== null && near(patty.kcal, 275)
    ? ok('…while its parts DO ground: the beef patty re-prices from the catalog')
    : bad('component not grounded', JSON.stringify(patty));
}

console.log('35. C4: a composite round-trips through a revision, a re-log and a template');
{
  const { db } = freshDb();
  const { mealId } = pizzaMeal(db);

  // The revision path (app/meal-revise.tsx → replaceMealItems) takes a TREE.
  const tree = assembleMealItems(listMealItems(db, mealId));
  replaceMealItems(
    db,
    mealId,
    tree.map((node) =>
      node.kind === 'composite'
        ? {
            name: node.item.name,
            components: node.components.map((c) => ({
              name: c.name,
              amount: c.amount,
              unit: c.unit,
              kcal: c.kcal,
              protein_g: c.protein_g,
              carbs_g: c.carbs_g,
              fat_g: c.fat_g,
            })),
          }
        : {
            name: node.item.name,
            amount: node.item.amount,
            unit: node.item.unit,
            kcal: node.item.kcal,
          }
    )
  );
  const after = assembleMealItems(listMealItems(db, mealId));
  after.length === 2 && after[0].kind === 'composite' && after[0].components.length === 3
    ? ok('replaceMealItems round-trips a tree without flattening it')
    : bad('revision flattened the pizza', JSON.stringify(after.map((n) => n.kind)));

  // The model is SHOWN the tree, indented, so a correction can name a part.
  const req = buildMealRevisionRequest(
    { name: 'Dinner', items: [toSubject(after[0]), toSubject(after[1])] },
    'no pepperoni'
  );
  const text = req.messages[0].content[0].text;
  text.includes('- Pepperoni pizza — 3 parts') && text.includes('  - Pepperoni — 60 g')
    ? ok('the revision request prints the dish with its parts indented beneath it')
    : bad('revision text', text);
  req.system.includes('is ONE composite dish')
    ? ok('and the revision prompt tells the model to keep it composite')
    : bad('revision prompt missing the composite rail');

  // "Log again" re-logs a pizza, not four loose rows.
  const again = relogMeal(db, mealId, TODAY, '20:00');
  const relogged = assembleMealItems(listMealItems(db, again));
  relogged.length === 2 && relogged[0].kind === 'composite' && near(getMeal(db, again).kcal, 1690)
    ? ok('“Log again” carries the tree, and the copy totals the same 1,690 kcal')
    : bad('relog flattened', JSON.stringify(relogged.map((n) => n.kind)));

  // A template cannot express a composite, so it saves the PARTS — honest, and
  // the rollup is unchanged because the parts are what the totals summed.
  const templateId = saveMealAsTemplate(db, mealId, 'Pizza night');
  listTemplateItems(db, templateId).length === 4
    ? ok('a template flattens the pizza to its parts (4 priced lines), never a null header')
    : bad('template items', String(listTemplateItems(db, templateId).length));
  const logged = logMealFromTemplate(db, templateId, TODAY, '21:00');
  near(getMeal(db, logged).kcal, 1690)
    ? ok('…and logging that template comes to the same 1,690 kcal')
    : bad('template totals', String(getMeal(db, logged).kcal));
}

console.log('36. C4/C5: the estimator prompts have a ceiling now');
{
  // ~3.6 chars/token for prose — db/coach-eval.test.mjs §6's own estimator.
  const proseTok = (s) => Math.round(s.length / 3.6);
  const estimation = proseTok(MEAL_ESTIMATION_SYSTEM_PROMPT);
  const revision = proseTok(MEAL_REVISION_SYSTEM_PROMPT);

  // THE ACCOUNTING. This prompt was guarded by NOTHING until this round, and it
  // grew 296 → 449 tokens in a single day (backlog A8's caffeine/sodium lines),
  // then 449 → 542 when `ml` landed (0047) — 83% in a week, unnoticed, because
  // the two Coach ceilings measure buildCoachSystemPrompt and toWireTools and
  // the estimator is neither: a different system prompt, on a tool-less turn.
  //
  //   542  the head of `main` when this branch started
  //   +149 C4: the composite rule + the "components" schema clause
  //   +279 C5: the question rules + the "questions" schema clause
  //   −48  trimmed in the SAME round, because the rule binds this round too:
  //        three enumerations became three examples each, no rule lost
  //   ---
  //   922, against a ceiling of 1,000 — 78 tokens of headroom.
  //
  // The rule the Coach's own budget note states applies verbatim: **the next
  // addition trims rather than raises this.** What is left to cut is named on
  // ESTIMATOR_PROMPT_CEILING itself, and neither candidate is free.
  estimation < ESTIMATOR_PROMPT_CEILING
    ? ok(
        `the estimation prompt fits its budget (~${estimation} tok of ${ESTIMATOR_PROMPT_CEILING})`
      )
    : bad('estimation prompt over budget', `${estimation} tok — trim before adding more`);
  revision < ESTIMATOR_PROMPT_CEILING
    ? ok(`and so does the revision prompt (~${revision} tok)`)
    : bad('revision prompt over budget', `${revision} tok`);

  // A ceiling nothing approaches is not a guard. If this trips, the prompts
  // were cut and the ceiling should come down with them.
  estimation > ESTIMATOR_PROMPT_CEILING * 0.6
    ? ok('…and the ceiling is close enough to the real size to actually bite')
    : bad('ceiling is vacuous', `${estimation} tok is far under ${ESTIMATOR_PROMPT_CEILING}`);
}

// === Auto-ask clarifying questions (backlog C5) ===============================
//
// The owner's five rules, each pinned: fires from ANY AI logging method; max 3;
// button-answerable; only what matters and what he would actually know; and the
// archetype — *"how many shots are in this latte?"*
//
// The shape that makes it cheap is ONE CALL: the estimate and the questions
// come back together, and each button answer carries the EFFECT of choosing it,
// so answering is pure on-device arithmetic over the review rows.

/** The owner's own archetype, as the model would send it. */
const LATTE_REPLY = JSON.stringify({
  title: 'Latte',
  items: [
    {
      name: 'Espresso',
      amount: 60,
      unit: 'ml',
      kcal: 5,
      protein_g: 0,
      carbs_g: 1,
      fat_g: 0,
      confidence: 'medium',
    },
    {
      name: 'Whole milk',
      amount: 300,
      unit: 'ml',
      kcal: 186,
      protein_g: 10,
      carbs_g: 14,
      fat_g: 10,
      confidence: 'medium',
    },
  ],
  notes: null,
  questions: [
    {
      id: 'shots',
      ask: 'How many shots?',
      allow_other: false,
      options: [
        { label: '1', effect: { scale_item: 'Espresso', factor: 0.5 } },
        { label: '2', effect: { scale_item: 'Espresso', factor: 1 } },
        { label: '3', effect: { scale_item: 'Espresso', factor: 1.5 } },
      ],
    },
  ],
});

console.log('37. C5: the estimate and its questions arrive together');
{
  const parsed = parseMealEstimate(LATTE_REPLY);
  parsed.questions.length === 1 && parsed.questions[0].ask === 'How many shots?'
    ? ok('the owner’s archetype parses: one question, asked in words')
    : bad('latte question', JSON.stringify(parsed.questions));
  const options = parsed.questions[0].options;
  options.length === 3 &&
  options[2].effect.kind === 'scale_item' &&
  options[2].effect.factor === 1.5
    ? ok('…and each button answer carries the EFFECT of choosing it')
    : bad('effects', JSON.stringify(options));
  parsed.questions[0].allowOther === false
    ? ok('“Other” is offered only when the model says so')
    : bad('allowOther defaulted true');

  // The whole point of carrying the effect: no second round trip.
  const { db } = freshDb();
  const rows = rowsFromEstimate(db, parsed);
  const answered = applyAnswer(rows, options[2].effect);
  near(currentPortion(answered[0]).amount, 90) && near(currentPortion(answered[0]).kcal, 7.5)
    ? ok('tapping “3” re-prices the espresso on-device: 60 ml → 90 ml')
    : bad('applyAnswer scale', JSON.stringify(currentPortion(answered[0])));
  currentPortion(answered[1]).amount === 300
    ? ok('…and touches nothing else on the plate')
    : bad('sibling moved');

  // THE LEDGER RULE, as arithmetic: after any answer the plate's total is the
  // sum of the rows drawn.
  const total = reviewKcal(answered);
  near(total, currentPortion(answered[0]).kcal + currentPortion(answered[1]).kcal)
    ? ok('after an answer the total still equals the rows beneath it')
    : bad('ledger broken', String(total));
}

console.log('38. C5: the four effects, as on-device arithmetic');
{
  const { db } = freshDb();
  const base = rowsFromEstimate(
    db,
    parseMealEstimate(
      JSON.stringify({
        title: 'Salad',
        items: [
          {
            name: 'Greens',
            amount: 100,
            kcal: 25,
            protein_g: 2,
            carbs_g: 4,
            fat_g: 0,
            confidence: 'medium',
          },
          {
            name: 'Bun',
            amount: 80,
            kcal: 210,
            protein_g: 7,
            carbs_g: 40,
            fat_g: 2,
            confidence: 'low',
          },
        ],
      })
    )
  );

  const setAmount = applyAnswer(base, { kind: 'set_amount', name: 'Greens', amount: 200 });
  near(currentPortion(setAmount[0]).amount, 200) && near(currentPortion(setAmount[0]).kcal, 50)
    ? ok('set_amount re-prices through the tested rescale, in the item’s own unit')
    : bad('set_amount', JSON.stringify(currentPortion(setAmount[0])));

  const added = applyAnswer(base, {
    kind: 'add_item',
    name: 'Vinaigrette',
    amount: 30,
    unit: 'g',
    kcal: 130,
    protein_g: 0,
    carbs_g: 1,
    fat_g: 14,
  });
  added.length === 3 && added[2].name === 'Vinaigrette' && near(reviewKcal(added), 365)
    ? ok('add_item appends a priced row and the total follows')
    : bad('add_item', JSON.stringify(added.map((r) => r.name)));
  applyAnswer(added, {
    kind: 'add_item',
    name: 'Vinaigrette',
    amount: 30,
    unit: 'g',
    kcal: 130,
    protein_g: 0,
    carbs_g: 1,
    fat_g: 14,
  }).length === 3
    ? ok('…and applying the same answer twice cannot produce two of it')
    : bad('add_item duplicated');

  const removed = applyAnswer(base, { kind: 'remove_item', name: 'Bun' });
  removed.length === 1 && removed[0].name === 'Greens'
    ? ok('remove_item drops the row it names')
    : bad('remove_item', JSON.stringify(removed.map((r) => r.name)));

  // An effect naming a row the user already deleted is a no-op, not a crash.
  applyAnswer(removed, { kind: 'scale_item', name: 'Bun', factor: 0.5 }).length === 1
    ? ok('an effect naming a row that is gone does nothing')
    : bad('missing-row effect');

  // NO ACCUMULATION: answering, then changing the answer, is the same state as
  // having chosen the second option first — because both are applied to the
  // base, which is what the screen's hook freezes per question.
  const first = applyAnswer(base, { kind: 'scale_item', name: 'Greens', factor: 0.5 });
  const changed = applyAnswer(base, { kind: 'scale_item', name: 'Greens', factor: 2 });
  const direct = applyAnswer(base, { kind: 'scale_item', name: 'Greens', factor: 2 });
  near(currentPortion(first[0]).amount, 50) &&
  near(currentPortion(changed[0]).amount, 200) &&
  near(currentPortion(direct[0]).amount, currentPortion(changed[0]).amount)
    ? ok('changing an answer does not compound — it re-applies to the same base')
    : bad(
        'accumulation',
        JSON.stringify([currentPortion(changed[0]).amount, currentPortion(direct[0]).amount])
      );

  // SKIPPING every question leaves the estimate byte-identical to the
  // unanswered one — the rule "the items already assume the most likely answer"
  // is what makes that safe.
  JSON.stringify(rowsToMealItems(base)) === JSON.stringify(rowsToMealItems(base))
    ? ok('skipping writes exactly the estimate as it came back')
    : bad('skip changed the estimate');
}

console.log('39. C5: the three gates, and what the parser refuses');
{
  const q = (options, extra = {}) => ({ id: 'q', ask: 'Ask?', options, ...extra });
  const reply = (questions, confidence = 'medium') =>
    JSON.stringify({
      title: 'T',
      items: [
        { name: 'Espresso', amount: 60, kcal: 5, confidence },
        { name: 'Milk', amount: 300, kcal: 186, confidence },
      ],
      questions,
    });

  // GATE 3: the owner said three.
  parseMealEstimate(
    reply(
      [1, 2, 3, 4].map((n) => ({
        id: `q${n}`,
        ask: `Ask ${n}?`,
        options: [
          { label: 'a', effect: { scale_item: 'Milk', factor: 0.5 } },
          { label: 'b', effect: { scale_item: 'Milk', factor: 1 } },
        ],
      }))
    )
  ).questions.length === 3
    ? ok('four questions become three — the model is not the enforcer of that')
    : bad('cap');

  // GATE 2: a model certain about every item and still asking has contradicted
  // itself, and a certain estimate is where an extra tap is pure friction.
  parseMealEstimate(
    reply(
      [
        q([
          { label: 'a', effect: { scale_item: 'Milk', factor: 0.5 } },
          { label: 'b', effect: { scale_item: 'Milk', factor: 1 } },
        ]),
      ],
      'high'
    )
  ).questions.length === 0
    ? ok('an all-high-confidence estimate returns ZERO questions after the gate')
    : bad('confidence gate');

  // The commonest model error: an effect naming an item it renamed.
  parseMealEstimate(
    reply([
      q([
        { label: 'a', effect: { scale_item: 'Cappuccino', factor: 0.5 } },
        { label: 'b', effect: { scale_item: 'Milk', factor: 1 } },
      ]),
    ])
  ).questions.length === 0
    ? ok(
        'an option naming an item not in the estimate is dropped, and a one-option question with it'
      )
    : bad('unknown item kept');

  // Bounds — the schema's own CHECK(amount > 0) and the review screen's ceiling.
  const bounded = parseMealEstimate(
    reply([
      q([
        { label: 'zero', effect: { scale_item: 'Milk', factor: 0 } },
        { label: 'neg', effect: { scale_item: 'Milk', factor: -1 } },
        { label: 'none', effect: { set_amount: 'Milk', amount: 0 } },
        { label: 'huge', effect: { set_amount: 'Milk', amount: 9000 } },
      ]),
      q(
        [
          { label: 'ok', effect: { set_amount: 'Milk', amount: 250 } },
          { label: 'also', effect: { remove_item: 'Milk' } },
        ],
        { id: 'survivor' }
      ),
    ])
  ).questions;
  bounded.length === 1 && bounded[0].id === 'survivor'
    ? ok('factor 0/−1 and amount 0/9000 are dropped, and the sound question still renders')
    : bad('bounds', JSON.stringify(bounded));

  // An unknown effect key is dropped — the vocabulary is closed on purpose.
  parseMealEstimate(
    reply([
      q([
        { label: 'a', effect: { season_item: 'Milk' } },
        { label: 'b', effect: { scale_item: 'Milk', factor: 1 } },
      ]),
    ])
  ).questions.length === 0
    ? ok('an unknown effect key is dropped — the vocabulary is closed')
    : bad('unknown effect kept');

  // A reply with no questions key parses exactly as it did before C5.
  const legacy = parseMealEstimate(
    JSON.stringify({ title: 'T', items: [{ name: 'Rice', amount: 200, kcal: 260 }] })
  );
  legacy.questions.length === 0 && legacy.items.length === 1
    ? ok('a reply with no "questions" key parses as it always did — the key is optional')
    : bad('legacy reply');
}

console.log('40. C5: which logging methods may ask — and which must never');
{
  // Both AI prompts carry the rules, in the owner's own terms.
  MEAL_ESTIMATION_SYSTEM_PROMPT.includes('USUALLY ABSENT') &&
  MEAL_ESTIMATION_SYSTEM_PROMPT.includes('an empty list is the norm')
    ? ok('the prompt says zero questions is normal — twice, which is the cheapest defence there is')
    : bad('absence not stated twice');
  MEAL_ESTIMATION_SYSTEM_PROMPT.includes('a kitchen they did not stand in')
    ? ok('…and knowability is stated as a PLACE, with the owner’s own restaurant example')
    : bad('knowability rule missing');
  MEAL_ESTIMATION_SYSTEM_PROMPT.includes('~15% of its energy')
    ? ok('…and materiality as a magnitude, not a list of askable topics')
    : bad('materiality rule missing');
  MEAL_REVISION_SYSTEM_PROMPT.includes('Questions (optional, and USUALLY ABSENT)')
    ? ok('a revision may ask too (owner decision) — the same rules, the same parser')
    : bad('revision prompt has no questions block');

  // BARCODE NEVER ASKS, and that is a design position rather than an omission:
  // a barcode is an exact identity against an exact per-100 panel, the portion
  // sheet already asks the one unknown, and the path is offline-first by
  // construction — a path that works with the network unplugged must not grow a
  // question that needs the network. Pinned at the SOURCE, as the negative.
  const scanner = readFileSync(new URL('../app/barcode-scan.tsx', import.meta.url), 'utf8');
  !/QuestionsPlate|useEstimateQuestions|estimateMeal\(/.test(scanner)
    ? ok('the barcode screen has no question surface at all, and cannot grow one by accident')
    : bad('barcode-scan reaches the estimator');
  const logSheet = readFileSync(
    new URL('../src/components/nutrition/log-sheet.tsx', import.meta.url),
    'utf8'
  );
  !/QuestionsPlate|useEstimateQuestions/.test(logSheet)
    ? ok('…and neither do the catalog, template and manual rungs of the log sheet')
    : bad('log sheet grew a question surface');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
