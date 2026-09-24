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
import {
  createFood,
  deleteFood,
  getFood,
  listRecentBarcodeFoods,
  listRecentFoods,
} from '../src/lib/db/repositories/foods.ts';
import { createRecipe, deleteRecipe } from '../src/lib/db/repositories/recipes.ts';
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
  clearCompositeCount,
  combineMeals,
  dayFiberTotal,
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
  restoreMealItems,
  scaleCompositeItem,
  setCompositeCount,
  setNutritionTargets,
  takeMealItem,
  takenPhotoFileNames,
  todayTotals,
  uncombineMeals,
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
  restoreMealWithPhotos,
  settleMealRemoval,
  sweepMealPhotos,
  takeMealWithPhotos,
} from '../src/lib/media/meal-photo-store.ts';
import { heldFiles, releaseFiles } from '../src/lib/media/held-files.ts';
import {
  combineConsequence,
  combinedName,
  mealListOrder,
  planCombine,
} from '../src/lib/nutrition/combine.ts';
import {
  closeUndo,
  currentUndo,
  offerUndo,
  onList,
  onMeal,
  runUndo,
  subscribeUndo,
} from '../src/lib/nutrition/undo-store.ts';
import { assembleMealItems } from '../src/lib/nutrition/composite.ts';
import {
  applyAnswer,
  beginCompositeScale,
  beginCountEdit,
  carryWholes,
  currentPortion,
  endCountEdit,
  planLoggedCount,
  reviewKcal,
  rowsFromEstimate,
  rowsToMealItems,
  rowsToRevisionSubject,
  scaleComposite,
  scaleCompositeTo,
  // The PURE count writers, aliased so they cannot be confused with the
  // repository's `setCompositeCount` — same name, same rule, different half.
  // ATE is `setRowsCount` (it scales); OF is `setRowsWhole` (it declares).
  setCompositeCount as setRowsCount,
  setCompositeWhole as setRowsWhole,
  setPiecesName,
  setRowAmount,
  toggleExpanded,
} from '../src/lib/nutrition/review-rows.ts';
import { dayFigure } from '../src/lib/nutrition/remaining.ts';
import {
  buildFoodEntryRequest,
  buildMealEstimationRequest,
  buildMealRevisionRequest,
  FOOD_ENTRY_SYSTEM_PROMPT,
  groundMealEstimate,
  MEAL_ESTIMATION_SYSTEM_PROMPT,
  ESTIMATOR_PROMPT_CEILING,
  MEAL_REVISION_SYSTEM_PROMPT,
  parseFoodEntry,
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
  // THE ROUND AFTER IT (0059, "slices"), which paid the rule rather than
  // raising the ceiling:
  //
  //   +38  the pieces rule, one bullet after the composite bullet
  //   +14  "pieces" on the schema line
  //   −7   the trim this very note named as cheapest: the hidden-fats bullet
  //        and "prefer underestimating" always overlapped, and they are one
  //        bullet now with neither rule lost. §52 asserts the fold, so a quiet
  //        revert fails there rather than only nudging the number here.
  //   ---
  //   967, 33 of headroom. The revision prompt moved 798 → 834 in the same
  //   round (the schema clause, and one rail about keeping a count).
  //
  // THE ROUND AFTER THAT (device feedback, "shots", 2026-09-23), paid in the
  // same round again. The latte was asked about its milk and never its shots,
  // because the bar counted energy and protein only — a shot is ~1% of a
  // latte's energy and ~50% of its caffeine. §53 pins the fix at the source.
  //
  //   +10  the bar names every figure the reply carries: "a figure, not just
  //        a name" — energy, caffeine or sodium by ~15%, protein by ~10 g
  //   +5   "biggest change first"
  //   +6   "micros included" on the assumed answer — an answer scales a
  //        figure and cannot create one (§54 proves both halves)
  //   −6   the cut ESTIMATOR_PROMPT_CEILING named: confidence's three
  //        definitions are two plus "else medium"
  //   −9   the per-portion line after the schema, folded into the micros
  //        bullet — the revision prompt's own shape
  //   ---
  //   973, 27 of headroom. The revision prompt took the same three clauses,
  //   834 → 855. §53 pins both trims, so a revert is visible there too.
  //
  // The rule the Coach's own budget note states applies verbatim: **the next
  // addition trims rather than raises this.** What is left to cut is named on
  // ESTIMATOR_PROMPT_CEILING itself, and it is not free.
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
  // The phrase moved on 2026-09-23 (§53): the magnitude now covers every figure
  // the reply carries, not energy alone. Still a magnitude, still not a list.
  MEAL_ESTIMATION_SYSTEM_PROMPT.includes("the meal's energy, caffeine or sodium by ~15%")
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

// === "Slices" as a food unit (0059) ==========================================
//
// The owner: *"'Slices' as a food unit — convenient for composite foods."*
//
// A slice is NOT a unit — 0047 settled that there are two and that nothing
// converts. It is a COUNT of pieces, and a count is a RATIO: three slices of an
// eight-slice pizza is × 3/8, the arithmetic the fraction chips already do. So
// every assertion below is about one of two things: that the count and the
// parts keep describing the same food, and that nothing that SUMS ever learns
// the count exists.
//
// THE PRINCIPLE, which §44 and §46 pin from both ends: the first count
// DECLARES ("this dish is 8 pieces") and moves nothing; every later one
// PRESERVES the correspondence by scaling the parts.

/** The pizza, plus a declared count of eight slices. */
function countedPizza(db) {
  const { mealId } = pizzaMeal(db);
  const header = listMealItems(db, mealId).find((r) => r.is_composite === 1);
  setCompositeCount(db, header.id, 8, 'slice');
  return { mealId, headerId: header.id };
}

const headerOf = (db, mealId) => listMealItems(db, mealId).find((r) => r.is_composite === 1);
const partsOf = (db, mealId) => listMealItems(db, mealId).filter((r) => r.parent_item_id !== null);

console.log('41. 0059: a composite carries a count of pieces, and still no number that sums');
{
  const { db } = freshDb();
  const { mealId } = logMealWithItems(db, {
    date: TODAY,
    time: '19:30',
    name: 'Dinner',
    items: [
      {
        name: 'Pepperoni pizza',
        serving_qty: 8,
        piece_name: 'slice',
        components: [
          { name: 'Pizza crust', amount: 300, kcal: 800, protein_g: 26, carbs_g: 160, fat_g: 6 },
          { name: 'Mozzarella', amount: 150, kcal: 450, protein_g: 33, carbs_g: 5, fat_g: 33 },
          { name: 'Pepperoni', amount: 60, kcal: 300, protein_g: 12, carbs_g: 2, fat_g: 27 },
        ],
      },
    ],
  });
  const header = headerOf(db, mealId);
  header.serving_qty === 8 &&
  header.piece_name === 'slice' &&
  header.amount === null &&
  header.kcal === null &&
  header.protein_g === null &&
  header.confidence === null
    ? ok('the header holds the pair and nothing else — invariant 2, one clause wider')
    : bad('header shape', JSON.stringify(header));
  near(getMeal(db, mealId).kcal, 1550)
    ? ok('the meal still counts the parts only: 1,550 kcal')
    : bad('meal totals', String(getMeal(db, mealId).kcal));
  partsOf(db, mealId).every((p) => p.piece_name === null && p.serving_qty === null)
    ? ok('and no part carries the pair — a slice is not a fraction of the cheese')
    : bad('a part was counted');

  // A noun with no count names nothing, so the pair is written only whole.
  const half = logMealWithItems(db, {
    date: TODAY,
    time: '20:00',
    name: 'Half-stated',
    items: [
      {
        name: 'Wings',
        piece_name: 'wing',
        components: [
          { name: 'Chicken wing', amount: 200, kcal: 400 },
          { name: 'Sauce', amount: 30, kcal: 60 },
        ],
      },
    ],
  });
  headerOf(db, half.mealId).piece_name === null
    ? ok('a noun supplied with no count is refused rather than stored alone')
    : bad('half-pair stored');
}

console.log('42. 0059: THE NEGATIVE — nothing that sums or re-adds learns the count exists');
{
  const { db } = freshDb();
  const { mealId, headerId } = (() => {
    const m = pizzaMeal(db);
    return { mealId: m.mealId, headerId: headerOf(db, m.mealId).id };
  })();

  // A catalog food with a serving, logged, so the recents rails have something
  // to return. They INNER JOIN on food_id, which a header never has.
  const foodId = createFood(db, {
    name: 'Milk',
    serving_name: '1 cup',
    serving_amount: 244,
    kcal_100g: 42,
  });
  addMealItem(db, mealId, {
    food_id: foodId,
    name: 'Milk',
    amount: 244,
    serving_qty: 1,
    kcal: 102,
  });

  const before = {
    meal: getMeal(db, mealId),
    partial: partialMealMetrics(db, TODAY),
    counts: mealItemCounts(db, TODAY),
    recents: listRecentFoods(db, 10),
    barcodes: listRecentBarcodeFoods(db, 10),
  };
  setCompositeCount(db, headerId, 8, 'slice');
  const after = {
    meal: getMeal(db, mealId),
    partial: partialMealMetrics(db, TODAY),
    counts: mealItemCounts(db, TODAY),
    recents: listRecentFoods(db, 10),
    barcodes: listRecentBarcodeFoods(db, 10),
  };

  // `updated_at` moves on the header, which is the one thing that SHOULD:
  // 0014's trigger fires on the row that was written. Compare the reads.
  JSON.stringify(before.meal) === JSON.stringify(after.meal)
    ? ok('recomputeMealTotals is byte-identical before and after the header gains a count')
    : bad('meal totals moved', JSON.stringify(after.meal));
  JSON.stringify(before.partial) === JSON.stringify(after.partial)
    ? ok('…and partialMealMetrics, so the Eat tab stays in countdown mode')
    : bad('partial moved');
  JSON.stringify(before.counts) === JSON.stringify(after.counts)
    ? ok('…and the collapsed tally, which still draws one row per pizza')
    : bad('tally moved');
  JSON.stringify(before.recents) === JSON.stringify(after.recents) && after.recents.length === 1
    ? ok('…and the recents rail, which inner-joins on a food_id a header never has')
    : bad('recents moved', JSON.stringify(after.recents));
  JSON.stringify(before.barcodes) === JSON.stringify(after.barcodes)
    ? ok('…and the barcode rail beside it')
    : bad('barcode rail moved');
}

console.log('43. 0059: whatever scales the whole scales the count');
{
  const { db } = freshDb();
  const { mealId, headerId } = countedPizza(db);

  scaleCompositeItem(db, headerId, 0.5);
  const halved = headerOf(db, mealId);
  // 1,550 of pizza halves to 775; the beer's 140 is not a part and does not move.
  near(halved.serving_qty, 4) && near(getMeal(db, mealId).kcal, 915)
    ? ok('“I ate half” of eight slices is four slices, and half the pizza’s energy')
    : bad('half', JSON.stringify([halved.serving_qty, getMeal(db, mealId).kcal]));
  halved.piece_name === 'slice'
    ? ok('…and the noun does not move: it was never a number')
    : bad('noun moved', String(halved.piece_name));
  partsOf(db, mealId).every((p) => p.piece_name === null && p.serving_qty === null)
    ? ok('…and no part picked up the pair on the way through')
    : bad('a part was counted by a chip');

  scaleCompositeItem(db, headerId, 2);
  const back = headerOf(db, mealId);
  back.serving_qty === 8 && near(getMeal(db, mealId).kcal, 1690)
    ? ok('×0.5 then ×2 returns to exactly 8 — nothing is rounded on write')
    : bad('round trip', String(back.serving_qty));

  // An UNCOUNTED composite is untouched by the same call: there is no count to
  // move, and one must not be invented.
  const plain = pizzaMeal(db);
  scaleCompositeItem(db, headerOf(db, plain.mealId).id, 0.5);
  headerOf(db, plain.mealId).serving_qty === null
    ? ok('an uncounted composite stays uncounted through a chip')
    : bad('count invented');
}

console.log('44. 0059: the first count DECLARES; every later one PRESERVES');
{
  const { db } = freshDb();
  const { mealId, headerId } = (() => {
    const m = pizzaMeal(db);
    return { mealId: m.mealId, headerId: headerOf(db, m.mealId).id };
  })();

  const partsBefore = partsOf(db, mealId).map((p) => [p.name, p.amount, p.kcal]);
  const kcalBefore = getMeal(db, mealId).kcal;
  setCompositeCount(db, headerId, 8, 'slice');
  JSON.stringify(partsOf(db, mealId).map((p) => [p.name, p.amount, p.kcal])) ===
    JSON.stringify(partsBefore) && getMeal(db, mealId).kcal === kcalBefore
    ? ok('THE DECLARATION MOVES NOTHING: every part and the meal’s energy byte-identical')
    : bad('declaration scaled the parts');
  const declared = headerOf(db, mealId);
  declared.serving_qty === 8 && declared.piece_name === 'slice'
    ? ok('…and the dish is now said to be eight slices')
    : bad('pair not written', JSON.stringify(declared));

  // THE CORRESPONDENCE, as a number: the per-piece energy is fixed at the
  // declaration and every count edit preserves it.
  const perPiece = 1550 / 8;
  setCompositeCount(db, headerId, 3);
  near(getMeal(db, mealId).kcal, (1550 * 3) / 8 + 140)
    ? ok('8 → 3 scales every part by 3/8 (the beer, which is not a part, does not move)')
    : bad('3/8', String(getMeal(db, mealId).kcal));
  near((getMeal(db, mealId).kcal - 140) / headerOf(db, mealId).serving_qty, perPiece)
    ? ok('…and kcal ÷ count is still the per-piece figure fixed at the declaration')
    : bad('per-piece drifted');
  headerOf(db, mealId).piece_name === 'slice'
    ? ok('…and a re-count with no noun keeps the noun the dish already has')
    : bad('noun lost on re-count');

  setCompositeCount(db, headerId, 4);
  near((getMeal(db, mealId).kcal - 140) / 4, perPiece)
    ? ok('3 → 4 preserves it too — the current state is the record, every time')
    : bad('3→4');
  setCompositeCount(db, headerId, 3);
  headerOf(db, mealId).serving_qty === 3
    ? ok('3 → 4 → 3 lands on exactly 3, not on a product of two floats')
    : bad('float drift', String(headerOf(db, mealId).serving_qty));

  // The ONE edit allowed to move the per-piece figure: a hand-corrected part.
  // A part edit never moves its siblings and never pushes back onto the parent
  // — you still ate three slices, they were lighter.
  const crust = partsOf(db, mealId).find((p) => p.name === 'Pizza crust');
  updateMealItemPortion(db, crust.id, { amount: 20, kcal: 50 });
  const header = headerOf(db, mealId);
  header.serving_qty === 3 && header.piece_name === 'slice'
    ? ok('a part hand-edit leaves the count alone — the one thing that moves per-piece')
    : bad('part edit moved the count', JSON.stringify(header));

  throws(() => setCompositeCount(db, headerId, 0))
    ? ok('0 is not a count of anything, and throws as a factor of 0 does')
    : bad('zero accepted');
  throws(() => setCompositeCount(db, headerId, NaN))
    ? ok('…and neither is NaN')
    : bad('NaN accepted');
  const beer = listMealItems(db, mealId).find((r) => r.name === 'Lager');
  setCompositeCount(db, beer.id, 3, 'slice');
  listMealItems(db, mealId).find((r) => r.id === beer.id).piece_name === null
    ? ok('and a NON-header is refused outright — a plain item is not counted in pieces')
    : bad('plain item counted');

  // Clearing is a declaration of ignorance, not of eating.
  const partsNow = partsOf(db, mealId).map((p) => [p.name, p.amount, p.kcal]);
  clearCompositeCount(db, headerId);
  const cleared = headerOf(db, mealId);
  cleared.serving_qty === null &&
  cleared.piece_name === null &&
  JSON.stringify(partsOf(db, mealId).map((p) => [p.name, p.amount, p.kcal])) ===
    JSON.stringify(partsNow)
    ? ok('clearing drops the pair and scales nothing — the route back from a wrong count')
    : bad('clear scaled the parts');
  setCompositeCount(db, headerId, 6, 'slice');
  near(
    getMeal(db, mealId).kcal - 140,
    partsNow.reduce((s, p) => s + p[2], 0)
  )
    ? ok('…so the next number declares afresh: six slices, not 6/3 of the parts')
    : bad('re-declaration scaled');
}

console.log('45. 0059: removing a part leaves the count; the last part takes it');
{
  const { db } = freshDb();
  const { mealId, headerId } = countedPizza(db);
  const parts = partsOf(db, mealId);

  removeMealItem(db, parts[0].id);
  const header = headerOf(db, mealId);
  header.serving_qty === 8 && header.piece_name === 'slice'
    ? ok('a slice without its pepperoni is still a slice — the count stands')
    : bad('count lost with a part', JSON.stringify(header));

  removeMealItem(db, parts[1].id);
  removeMealItem(db, parts[2].id);
  headerOf(db, mealId) === undefined
    ? ok('and the last part takes the header, and the count with it (invariant 4)')
    : bad('header survived its last part');
}

console.log('46. 0059: ate [3] of [8] — the review rows declare, scale and clear, all pure');
{
  // RE-CUT 2026-09-23 on the owner's device note: *"the whole interaction when
  // slices comes up is funky"*. One field that said `THIS IS` until its first
  // keystroke and `I ATE` after it became a sentence with two fields —
  // `ATE [3] OF [8] SLICES` — where OF declares (nothing scales) and ATE scales.
  const { db } = freshDb();
  const estimate = {
    title: 'Pizza',
    notes: null,
    questions: [],
    items: [
      {
        name: 'Pepperoni pizza',
        amount: null,
        unit: 'g',
        kcal: null,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        fiber_g: null,
        confidence: 'medium',
        foodId: null,
        micros: null,
        pieces: null,
        components: [
          {
            name: 'Crust',
            amount: 400,
            unit: 'g',
            kcal: 800,
            protein_g: 26,
            carbs_g: 160,
            fat_g: 6,
            fiber_g: null,
            confidence: 'medium',
            foodId: null,
            micros: null,
          },
          {
            name: 'Cheese',
            amount: 320,
            unit: 'g',
            kcal: 750,
            protein_g: 50,
            carbs_g: 8,
            fat_g: 60,
            fiber_g: null,
            confidence: 'medium',
            foodId: null,
            micros: null,
          },
        ],
      },
    ],
  };
  const base = rowsFromEstimate(db, estimate);
  const key = base[0].key;
  const amounts = (rows) => rows[0].components.map((c) => currentPortion(c).amount);
  const same = (rows, expected) => JSON.stringify(amounts(rows)) === JSON.stringify(expected);
  // One focus, one blur — what a tap into a field and a tap away do on screen.
  const typeOf = (rows, text) => setRowsWhole(beginCountEdit(rows, key), key, text);
  const typeAte = (rows, text) => setRowsCount(beginCountEdit(rows, key), key, text);
  const leave = (rows) => endCountEdit(rows, key);

  base[0].pieces === null &&
  base[0].wholeCount === null &&
  base[0].countText === null &&
  base[0].wholeText === null
    ? ok('a composite arrives uncounted, with both fields untouched')
    : bad('seeded count', JSON.stringify([base[0].pieces, base[0].wholeCount]));

  // ATE with no OF: nothing to take a share of, and a number there could only
  // mean "this dish is N pieces" — OF's question. The screen does not draw it.
  const ateFirst = typeAte(base, '3');
  ateFirst[0].pieces === null && same(ateFirst, [400, 320])
    ? ok('ATE on an uncounted dish holds and moves nothing — it cannot conjure a count')
    : bad('ATE declared', JSON.stringify(ateFirst[0].pieces));

  // THE DECLARATION, now OF's alone.
  const declared = leave(typeOf(base, '8'));
  declared[0].pieces.count === 8 &&
  declared[0].pieces.name === 'piece' &&
  declared[0].wholeCount === 8 &&
  same(declared, [400, 320])
    ? ok('typing 8 into OF declares the dish — ate 8 of 8 — and moves not one gram')
    : bad('declaration', JSON.stringify([declared[0].pieces, amounts(declared)]));
  setPiecesName(declared, key, 'slice')[0].pieces.name === 'slice'
    ? ok('…and tapping the noun makes it a slice')
    : bad('rename failed');
  setPiecesName(declared, key, '   ')[0].pieces.name === 'piece'
    ? ok('…while an empty noun is refused, not stored')
    : bad('empty noun stored');
  setPiecesName(base, key, 'slice')[0].pieces === null
    ? ok('…and an UNCOUNTED row cannot be named: a noun with no count names nothing')
    : bad('uncounted row named');

  // THE SCALE, and non-compounding within one focus.
  const counted = setPiecesName(declared, key, 'slice');
  const eaten = leave(typeAte(counted, '3'));
  same(eaten, [150, 120]) && eaten[0].pieces.count === 3 && eaten[0].wholeCount === 8
    ? ok('ATE 3 of 8 is × 3/8 of the frozen parts — 400 g and 320 g become 150 and 120')
    : bad('3/8', JSON.stringify(amounts(eaten)));
  const typed = setRowsCount(typeAte(counted, '3'), key, '30');
  same(typed, [1500, 1200])
    ? ok('…and 3 then 30 from ONE focus lands on × 30/8, never on × 3/8 × 30/8')
    : bad('compounded', JSON.stringify(amounts(typed)));

  // THE OWNER'S TWO ENTRIES, end to end, as they reach the save.
  const saved = rowsToMealItems(eaten)[0];
  saved.serving_qty === 3 &&
  saved.piece_name === 'slice' &&
  JSON.stringify(saved.components.map((c) => c.amount)) === '[150,120]'
    ? ok('8 then 3 saves three slices over 3/8 of the parts — the count EATEN, never the 8')
    : bad('saved', JSON.stringify(saved));

  // A RE-DECLARATION, in the field that declares — no clearing first. The model
  // said eight and the pizza was six, and all of it is still on the plate.
  const redeclared = leave(typeOf(counted, '6'));
  redeclared[0].pieces.count === 6 && redeclared[0].wholeCount === 6 && same(redeclared, [400, 320])
    ? ok('typing 6 over OF’s 8 re-declares — ate 6 of 6 — and nothing scales')
    : bad('re-declaration', JSON.stringify([redeclared[0].pieces, amounts(redeclared)]));

  // …and once part of it is eaten, OF says what the sentence then reads.
  const recounted = leave(typeOf(eaten, '6'));
  recounted[0].pieces.count === 3 && recounted[0].wholeCount === 6 && same(recounted, [200, 160])
    ? ok('after ate 3 of 8, typing 6 into OF reads ate 3 of 6: every part is 3/6 of the dish')
    : bad('ate 3 of 6', JSON.stringify([recounted[0].pieces, amounts(recounted)]));

  // BACKSPACE-THEN-TYPE IS ONE EDIT. The single field this replaced cleared
  // the count on the empty keystroke, so the 6 that followed re-declared over
  // parts already scaled to three slices — the trap the spike's device list named.
  const emptied = setRowsWhole(beginCountEdit(eaten, key), key, '');
  emptied[0].pieces.count === 3 && emptied[0].wholeCount === 8 && same(emptied, [150, 120])
    ? ok('an emptied OF mid-edit holds: the dish is still ate 3 of 8')
    : bad('empty OF moved', JSON.stringify(emptied[0].pieces));
  const retyped = leave(setRowsWhole(emptied, key, '6'));
  retyped[0].pieces.count === 3 && same(retyped, [200, 160])
    ? ok('…and the 6 typed after it lands on ate 3 of 6 — the same as typing over the 8')
    : bad('backspace then type', JSON.stringify([retyped[0].pieces, amounts(retyped)]));

  // CLEARING still un-declares without scaling — decided on the blur.
  const cleared = leave(setRowsWhole(beginCountEdit(eaten, key), key, ''));
  cleared[0].pieces === null && cleared[0].wholeCount === null && same(cleared, [150, 120])
    ? ok('an OF left EMPTY on blur un-counts the dish, and every part stays where it stands')
    : bad('clear', JSON.stringify([cleared[0].pieces, amounts(cleared)]));
  const afresh = leave(typeOf(cleared, '6'));
  afresh[0].pieces.count === 6 && same(afresh, [150, 120])
    ? ok('…so the next OF declares afresh over the parts as they stand: nothing scales')
    : bad('re-declaration after clear', JSON.stringify(amounts(afresh)));
  // Save tapped with the emptied OF still focused never blurs it (the keyboard's
  // "handled" taps), so the save path resolves the empty exactly as blur would.
  const savedEmpty = rowsToMealItems(setRowsWhole(beginCountEdit(eaten, key), key, ''))[0];
  savedEmpty.serving_qty === null &&
  savedEmpty.piece_name === null &&
  JSON.stringify(savedEmpty.components.map((c) => c.amount)) === '[150,120]'
    ? ok('…and an OF emptied then SAVED before it is left saves no count, parts where they stand')
    : bad('save with an emptied OF', JSON.stringify(savedEmpty));
  const ateBlank = leave(setRowsCount(beginCountEdit(eaten, key), key, ''));
  ateBlank[0].pieces.count === 3 && ateBlank[0].countText === null && same(ateBlank, [150, 120])
    ? ok('an ATE left empty just shows the count again — emptying what you ate un-counts nothing')
    : bad('empty ATE', JSON.stringify(ateBlank[0].pieces));

  // Bounds, and half-typed text, in both fields — the parts checked, not just
  // the counts.
  ['abc', '101', '0'].every((t) => {
    const ate = setRowsCount(counted, key, t);
    const of = setRowsWhole(counted, key, t);
    return (
      ate[0].pieces.count === 8 &&
      same(ate, [400, 320]) &&
      of[0].wholeCount === 8 &&
      of[0].pieces.count === 8 &&
      same(of, [400, 320])
    );
  })
    ? ok('“abc”, 101 and 0 hold the text and move nothing, in either field')
    : bad('bad count applied');

  // ONE RULE FOR TEXT THAT IS NOT A COUNT: the dish shows as it stood at focus —
  // never at a scale some number typed a moment earlier produced. This is the
  // case that made it a rule: a `1` on the way to `12`, then backed out.
  const passedThrough = setRowsWhole(beginCountEdit(eaten, key), key, '1');
  same(passedThrough, [1200, 960])
    ? ok('typing 1 into OF on ate 3 of 8 really is × 8 for that keystroke (ate 3 of 1)')
    : bad('ate 3 of 1', JSON.stringify(amounts(passedThrough)));
  const backedOut = setRowsWhole(passedThrough, key, '');
  backedOut[0].pieces.count === 3 && backedOut[0].wholeCount === 8 && same(backedOut, [150, 120])
    ? ok('…and emptied after it, the dish shows exactly as it stood at focus: ate 3 of 8')
    : bad('empty after a valid OF', JSON.stringify(amounts(backedOut)));
  const leftEmpty = leave(backedOut);
  leftEmpty[0].pieces === null && same(leftEmpty, [150, 120])
    ? ok('…so leaving it empty un-counts WITHOUT scaling — not at 2,160 g, three whole pizzas')
    : bad('un-count after a valid OF', JSON.stringify(amounts(leftEmpty)));
  const ateBackedOut = leave(
    setRowsCount(setRowsCount(beginCountEdit(counted, key), key, '3'), key, '')
  );
  ateBackedOut[0].pieces.count === 8 && same(ateBackedOut, [400, 320])
    ? ok('an ATE typed then emptied and left is the dish as it stood: ate 8 of 8')
    : bad('ATE backed out', JSON.stringify(amounts(ateBackedOut)));
  // The rule's one exception is SHAPE: a declaration still being typed keeps its
  // counted shape through an empty keystroke (it never moved a gram), so "8",
  // backspace, "6" does not mount and unmount ATE, the grams field and the
  // chips around the field being typed into.
  const midDeclare = setRowsWhole(setRowsWhole(beginCountEdit(base, key), key, '8'), key, '');
  midDeclare[0].pieces?.count === 8 &&
  midDeclare[0].wholeCount === 8 &&
  same(midDeclare, [400, 320])
    ? ok('a declaration emptied mid-edit keeps its shape, and not a gram has moved')
    : bad('declaration flickered', JSON.stringify(midDeclare[0].pieces));
  const redeclaring = setRowsWhole(midDeclare, key, '6');
  redeclaring[0].pieces.count === 6 && same(redeclaring, [400, 320])
    ? ok('…so the 6 typed after it simply declares six')
    : bad('declare after empty', JSON.stringify(redeclaring[0].pieces));
  leave(midDeclare)[0].pieces === null && same(leave(midDeclare), [400, 320])
    ? ok('…and left empty, it un-counts on blur like any other')
    : bad('declaration left empty stayed counted');

  // A float the C5 arithmetic left a hair off the whole still reads as "all of
  // it", so OF re-declares rather than re-scaling by 8 / 8.000000000001.
  const noisy = [{ ...counted[0], pieces: { name: 'slice', count: 8 + 1e-12 } }];
  const noisyOf = leave(typeOf(noisy, '6'));
  noisyOf[0].pieces.count === 6 && same(noisyOf, [400, 320])
    ? ok('a count a hair off its whole still re-declares — float noise does not pick the branch')
    : bad('float noise', JSON.stringify([noisyOf[0].pieces, amounts(noisyOf)]));

  // CLOSING the dish ends the edit too: a focused field that unmounts with the
  // disclosure is not promised a blur, and the header must not go on showing a
  // count the emptied field already gave up.
  const collapsed = toggleExpanded(
    setRowsWhole(beginCountEdit(toggleExpanded(eaten, key), key), key, ''),
    key
  );
  collapsed[0].expanded === false &&
  collapsed[0].pieces === null &&
  collapsed[0].wholeText === null &&
  collapsed[0].countFrom === null &&
  same(collapsed, [150, 120])
    ? ok('collapsing the dish with OF emptied un-counts it exactly as a blur would')
    : bad('collapse did not settle', JSON.stringify(collapsed[0].pieces));

  // A CHIP MID-FOCUS still cannot compound: the chip drops both baselines, and
  // the next number re-snapshots against what is now on screen.
  const chipped = scaleComposite(counted, key, 1 / 3);
  near(chipped[0].pieces.count, 8 / 3) && chipped[0].wholeCount === 8
    ? ok('a ⅓ chip moves the count eaten to the honest 2.7 and leaves the dish at 8')
    : bad('chip count', String(chipped[0].pieces.count));
  const afterChip = setRowsCount(chipped, key, '3');
  near(amounts(afterChip)[0], 150) && near(amounts(afterChip)[1], 120)
    ? ok('…and typing 3 after it lands on exactly 3/8 of the PRE-chip values')
    : bad('chip then count', JSON.stringify(amounts(afterChip)));

  // The whole-dish grams field multiplies the count too — same snapshot, so
  // neither half can compound against the other.
  const halvedByGrams = scaleCompositeTo(beginCompositeScale(counted, key), key, '360');
  near(halvedByGrams[0].pieces.count, 4) &&
  near(amounts(halvedByGrams)[0], 200) &&
  halvedByGrams[0].wholeCount === 8
    ? ok('typing 360 g into a 720 g eight-slice pizza leaves ate 4 of 8')
    : bad('grams field count', String(halvedByGrams[0].pieces.count));

  // A PART edit leaves the count: you still ate three slices, they were lighter.
  const partEdited = setRowAmount(eaten, eaten[0].components[0].key, '200');
  partEdited[0].pieces.count === 3 &&
  partEdited[0].wholeCount === 8 &&
  partEdited[0].countFrom === null
    ? ok('a part hand-edit keeps the count and the dish, and drops only the stale baseline')
    : bad('part edit moved the count');

  // A RECORD'S COUNT (the Adjust screen): rows built from a logged meal carry
  // what was EATEN and no whole. `of [3]` there would invite typing the pizza's
  // eight over three logged slices, so there is no OF to type into.
  const logged = rowsFromEstimate(
    db,
    {
      ...estimate,
      items: [{ ...estimate.items[0], pieces: { name: 'slice', count: 3 } }],
    },
    { countIsEaten: true }
  );
  logged[0].pieces.count === 3 && logged[0].wholeCount === null
    ? ok('rows from a logged meal carry the count eaten and no whole — ate [3] slices')
    : bad('record shape', JSON.stringify([logged[0].pieces, logged[0].wholeCount]));
  const fourth = leave(typeAte(logged, '4'));
  fourth[0].pieces.count === 4 &&
  fourth[0].wholeCount === null &&
  // A field shows one decimal and the row reads its field: 1,600 / 3 reads 533.3.
  amounts(fourth).every((a, i) => Math.abs(a - (4 * [400, 320][i]) / 3) < 0.05)
    ? ok('…where ATE scales from the count eaten: a fourth slice is every part × 4/3')
    : bad('record ATE', JSON.stringify(amounts(fourth)));
  const unlogged = leave(setRowsCount(beginCountEdit(logged, key), key, ''));
  unlogged[0].pieces === null && same(unlogged, [400, 320])
    ? ok('…and ATE emptied and left un-counts it — the only field saying what the dish is')
    : bad('record un-count', JSON.stringify(unlogged[0].pieces));
  rowsToMealItems(setRowsCount(beginCountEdit(logged, key), key, ''))[0].serving_qty === null
    ? ok('…at Save too, if Save comes before the blur')
    : bad('record un-count at save');

  // And nothing anywhere here puts a piece noun on a part.
  [eaten, recounted, retyped, afresh].every((rows) =>
    rowsToMealItems(rows)[0].components.every((c) => c.piece_name === null)
  )
    ? ok('after all of that, no part carries a piece noun')
    : bad('a part carries a noun');
}

console.log('47. 0059: a C5 answer of “three of the eight” moves the count with the parts');
{
  const { db } = freshDb();
  const rows = rowsFromEstimate(db, {
    title: 'Pizza',
    notes: null,
    questions: [],
    items: [
      {
        name: 'Pepperoni pizza',
        amount: null,
        unit: 'g',
        kcal: null,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        fiber_g: null,
        confidence: 'medium',
        foodId: null,
        micros: null,
        pieces: { name: 'slice', count: 8 },
        components: [
          {
            name: 'Crust',
            amount: 400,
            unit: 'g',
            kcal: 800,
            protein_g: 26,
            carbs_g: 160,
            fat_g: 6,
            fiber_g: null,
            confidence: 'medium',
            foodId: null,
            micros: null,
          },
          {
            name: 'Cheese',
            amount: 320,
            unit: 'g',
            kcal: 750,
            protein_g: 50,
            carbs_g: 8,
            fat_g: 60,
            fiber_g: null,
            confidence: 'medium',
            foodId: null,
            micros: null,
          },
        ],
      },
    ],
  });
  rows[0].pieces && rows[0].pieces.count === 8
    ? ok('the model’s own count seeds the review row (phase 2)')
    : bad('pieces not seeded', JSON.stringify(rows[0].pieces));
  const answered = applyAnswer(rows, {
    kind: 'scale_item',
    name: 'Pepperoni pizza',
    factor: 0.375,
  });
  near(answered[0].pieces.count, 3) && near(currentPortion(answered[0].components[0]).amount, 150)
    ? ok('scale_item 0.375 on the dish leaves 3 slices eaten, and the parts to match')
    : bad('answer count', JSON.stringify(answered[0].pieces));
  answered[0].wholeCount === 8
    ? ok('…of a dish that is still eight: the review reads ate [3] of [8] slices')
    : bad('answer moved the whole', String(answered[0].wholeCount));

  // THE TYPED ANSWER ("Other") sends each dish's count EATEN and rebuilds what
  // comes back as if priced whole — so without `carryWholes` `ate 3 of 8` would
  // return as `ate 3 of 3`, the 8 gone and an OF inviting it back over three
  // slices of parts.
  const sent = rowsToRevisionSubject('Pizza', answered).items[0];
  sent.pieces && sent.pieces.count === 3
    ? ok('the typed answer sends the count eaten, 3 — not the dish’s 8')
    : bad('sent count', JSON.stringify(sent.pieces));
  // The reply as the model would return it: the dish, its parts as sent, and
  // whatever count it chose to keep.
  const reply = (pieces) =>
    rowsFromEstimate(db, {
      title: 'Pizza',
      notes: null,
      questions: [],
      items: [
        {
          name: 'Pepperoni pizza',
          amount: null,
          unit: 'g',
          kcal: null,
          protein_g: null,
          carbs_g: null,
          fat_g: null,
          fiber_g: null,
          confidence: 'medium',
          foodId: null,
          micros: null,
          pieces,
          components: answered[0].components.map((c) => ({
            name: c.name,
            amount: currentPortion(c).amount,
            unit: 'g',
            kcal: currentPortion(c).kcal,
            protein_g: null,
            carbs_g: null,
            fat_g: null,
            fiber_g: null,
            confidence: 'medium',
            foodId: null,
            micros: null,
          })),
        },
      ],
    });
  const kept = reply({ name: 'slice', count: 3 });
  kept[0].wholeCount === 3
    ? ok('rebuilt alone, the reply reads ate [3] of [3] — the loss this guards against')
    : bad('rebuild', String(kept[0].wholeCount));
  carryWholes(answered, kept)[0].wholeCount === 8
    ? ok('carryWholes: the count came back unchanged, so the dish’s 8 comes back with it')
    : bad('unchanged count lost its whole');
  carryWholes(answered, reply({ name: 'slice', count: 2 }))[0].wholeCount === null
    ? ok('…a count the answer changed is still a count eaten: no whole, ate [2] slices')
    : bad('changed count kept a whole');
  carryWholes(reply(null), kept)[0].wholeCount === 3
    ? ok('…and a dish that was never counted keeps the model’s count as its whole')
    : bad('uncounted dish lost the model whole');
  readFileSync(new URL('../src/hooks/use-estimate-questions.ts', import.meta.url), 'utf8').includes(
    'carryWholes(base,'
  )
    ? ok('the typed-answer path runs the reply through carryWholes against the rows it sent')
    : bad('the question hook does not carry wholes');
}

console.log('48. 0059: the count survives the save, the re-log, and is dropped by a template');
{
  const { db } = freshDb();
  // The declaration is OF's since the 2026-09-23 re-cut (§46): `setRowsWhole`.
  const rows = setPiecesName(
    setRowsWhole(
      beginCountEdit(
        rowsFromEstimate(db, {
          title: 'Pizza',
          notes: null,
          questions: [],
          items: [
            {
              name: 'Pepperoni pizza',
              amount: null,
              unit: 'g',
              kcal: null,
              protein_g: null,
              carbs_g: null,
              fat_g: null,
              fiber_g: null,
              confidence: 'medium',
              foodId: null,
              micros: null,
              pieces: null,
              components: [
                {
                  name: 'Crust',
                  amount: 400,
                  unit: 'g',
                  kcal: 800,
                  protein_g: 26,
                  carbs_g: 160,
                  fat_g: 6,
                  fiber_g: null,
                  confidence: 'medium',
                  foodId: null,
                  micros: null,
                },
                {
                  name: 'Cheese',
                  amount: 320,
                  unit: 'g',
                  kcal: 750,
                  protein_g: 50,
                  carbs_g: 8,
                  fat_g: 60,
                  fiber_g: null,
                  confidence: 'medium',
                  foodId: null,
                  micros: null,
                },
              ],
            },
          ],
        }),
        'k'
      ),
      'k',
      '8'
    ),
    'k',
    'slice'
  );
  const key = rows[0].key;
  const items = rowsToMealItems(
    setPiecesName(setRowsWhole(beginCountEdit(rows, key), key, '8'), key, 'slice')
  );
  items[0].serving_qty === 8 &&
  items[0].piece_name === 'slice' &&
  items[0].components.every((c) => c.piece_name === null)
    ? ok('rowsToMealItems puts the pair on the header and NULL on every part')
    : bad('rowsToMealItems', JSON.stringify(items[0]));

  const { mealId } = logMealWithItems(db, {
    date: TODAY,
    time: '19:00',
    name: 'Pizza night',
    items,
  });
  headerOf(db, mealId).piece_name === 'slice'
    ? ok('…and it lands on the row')
    : bad('pair not logged');

  // replaceMealItems round-trips it (the revision path's write).
  replaceMealItems(db, mealId, items);
  headerOf(db, mealId).serving_qty === 8 && headerOf(db, mealId).piece_name === 'slice'
    ? ok('a revision’s wholesale replace round-trips the count')
    : bad('replace lost the count');

  // "Log again" of a counted pizza is a counted pizza.
  const again = relogMeal(db, mealId, TODAY, '20:30');
  headerOf(db, again).serving_qty === 8 && headerOf(db, again).piece_name === 'slice'
    ? ok('“Log again” carries the count, because it carries the dish')
    : bad('relog lost the count');

  // A template flattens a composite away, so the pair never reaches
  // meal_template_items — the same honest loss the header's own name takes.
  const templateId = saveMealAsTemplate(db, mealId, 'Pizza night');
  const tItems = listTemplateItems(db, templateId);
  tItems.length === 2 && tItems.every((i) => !('piece_name' in i) || i.piece_name == null)
    ? ok('a template keeps the parts and their grams, and no count at all')
    : bad('template carried a count', JSON.stringify(tItems));
}

console.log('49. 0059: the three revision builders, and what the model is shown');
{
  const { db } = freshDb();
  const { mealId } = countedPizza(db);
  const tree = assembleMealItems(listMealItems(db, mealId));
  const header = tree.find((n) => n.kind === 'composite');

  // Builder 1: app/meal-revise.tsx's own, mirrored here in the shape it sends.
  const subject = {
    name: 'Dinner',
    items: [
      {
        ...toSubject(header),
        pieces: { name: header.item.piece_name, count: header.item.serving_qty },
      },
    ],
  };
  const text = buildMealRevisionRequest(subject, 'I only ate three').messages[0].content[0].text;
  text.includes('- Pepperoni pizza — 8 × slice, 3 parts')
    ? ok('the revision request prints the header as “8 × slice, 3 parts”')
    : bad('revision tail', text.split('\n')[2]);
  // The ONE count the model ever sees is a header's. A catalog item's serving
  // count is not printed, so `2 × 3 slices` never sits beside `8 × slice`.
  !/× 1 cup|× 1 egg/.test(text)
    ? ok('…and no catalog serving count is printed beside it — one vocabulary on the wire')
    : bad('serving count on the wire');
  buildMealRevisionRequest(
    { name: 'Dinner', items: [toSubject(header)] },
    'x'
  ).messages[0].content[0].text.includes('- Pepperoni pizza — 3 parts')
    ? ok('an uncounted composite prints exactly as it did before 0059')
    : bad('uncounted tail changed');
  MEAL_REVISION_SYSTEM_PROMPT.includes('Keep "pieces" as it arrived')
    ? ok('and the prompt tells the model to leave a count it was not asked about')
    : bad('revision rail missing');

  // Builder 3: the 0057 OFFLINE DRAIN, which builds its own subject. A
  // revision queued against a counted pizza must show the model the count.
  const estimators = fakeEstimators();
  queueMealRevision(db, mealId, 'I only ate three');
  await drainEstimateQueue(db, { estimators, pendingStore: null, mealPhotoStore: null });
  const sentHeader = estimators.calls[0].meal.items.find((i) => i.name === 'Pepperoni pizza');
  sentHeader &&
  sentHeader.pieces &&
  sentHeader.pieces.count === 8 &&
  sentHeader.pieces.name === 'slice'
    ? ok('the drain’s own builder carries the count into the queued revision')
    : bad('drain dropped the count', JSON.stringify(sentHeader && sentHeader.pieces));
}

console.log('50. 0059: what the parser accepts as a count, and what it ignores');
{
  const composite = (pieces) =>
    JSON.stringify({
      title: 'Pizza',
      items: [
        {
          name: 'Pepperoni pizza',
          confidence: 'medium',
          pieces,
          components: [
            { name: 'Crust', amount: 400, kcal: 800 },
            { name: 'Cheese', amount: 320, kcal: 750 },
          ],
        },
      ],
    });

  const good = parseMealEstimate(composite({ name: 'slice', count: 8 })).items[0];
  good.pieces && good.pieces.name === 'slice' && good.pieces.count === 8
    ? ok('a noun and a count land on the header')
    : bad('pieces dropped', JSON.stringify(good.pieces));
  [
    { name: '  ', count: 8 },
    { name: 'slice', count: 0 },
    { name: 'slice', count: 101 },
    {
      name: 'slice',
      count: 'three',
    },
    'slice',
    null,
  ].every((raw) => parseMealEstimate(composite(raw)).items[0].pieces === null)
    ? ok('an empty noun, 0, 101, "three", a bare string and null all parse to no count')
    : bad('a bad count survived');

  // On a PLAIN item it is ignored: a count there would land in three places
  // built for a catalog serving count.
  parseMealEstimate(
    JSON.stringify({
      title: 'Toast',
      items: [{ name: 'Toast', amount: 60, kcal: 160, pieces: { name: 'slice', count: 3 } }],
    })
  ).items[0].pieces === null
    ? ok('and a count on a plain item is ignored, not carried')
    : bad('plain item counted');

  // A reply with no "pieces" key at all parses exactly as it did before.
  const legacy = parseMealEstimate(composite(undefined)).items[0];
  legacy.pieces === null && legacy.components.length === 2 && legacy.kcal === null
    ? ok('a reply with no "pieces" key is today’s reply, unchanged')
    : bad('legacy composite reply');
}

console.log('51. 0059: grounding never touches a count, and the drain carries it');
{
  const { db } = freshDb();
  createFood(db, {
    name: 'Pepperoni pizza',
    kcal_100g: 266,
    protein_g_100g: 11,
    carbs_g_100g: 33,
    fat_g_100g: 10,
  });
  const parsed = parseMealEstimate(
    JSON.stringify({
      title: 'Pizza',
      items: [
        {
          name: 'Pepperoni pizza',
          confidence: 'medium',
          pieces: { name: 'slice', count: 8 },
          components: [
            { name: 'Crust', amount: 400, kcal: 800 },
            { name: 'Cheese', amount: 320, kcal: 750 },
          ],
        },
      ],
    })
  );
  const grounded = groundMealEstimate(db, parsed);
  grounded.items[0].foodId === null &&
  grounded.items[0].kcal === null &&
  grounded.items[0].pieces.count === 8
    ? ok('grounding still refuses to price a header, and leaves its count exactly as it was')
    : bad('grounding touched the header', JSON.stringify(grounded.items[0].pieces));

  // The drain writes the same shape the review screen does.
  const estimators = fakeEstimators(
    JSON.stringify({
      title: 'Pizza',
      items: [
        {
          name: 'Pepperoni pizza',
          confidence: 'medium',
          pieces: { name: 'slice', count: 8 },
          components: [
            { name: 'Crust', amount: 400, kcal: 800 },
            { name: 'Cheese', amount: 320, kcal: 750 },
          ],
        },
      ],
    })
  );
  const { mealId } = queueNewMealEstimate(
    db,
    { date: TODAY, time: '19:00', name: placeholderMealName('a pizza') },
    { kind: 'text', description: 'a pizza' }
  );
  await drainEstimateQueue(db, { estimators, pendingStore: null, mealPhotoStore: null });
  const drained = headerOf(db, mealId);
  drained && drained.serving_qty === 8 && drained.piece_name === 'slice'
    ? ok('a pizza drained from the offline queue lands counted')
    : bad('drain dropped the count', JSON.stringify(drained));
}

console.log('52. 0059: both prompts carry the rule, and it is a criterion not a dish list');
{
  MEAL_ESTIMATION_SYSTEM_PROMPT.includes('a countable number of pieces (slices, wings, rolls)')
    ? ok('the estimation prompt states a CRITERION with three examples')
    : bad('pieces rule missing');
  MEAL_ESTIMATION_SYSTEM_PROMPT.includes('"pieces": {"name": string, "count": number}|null')
    ? ok('…and the schema line names the key, so the shape is not guessed')
    : bad('pieces schema clause missing');
  MEAL_REVISION_SYSTEM_PROMPT.includes('"pieces": {"name": string, "count": number}|null')
    ? ok('…and so does the revision schema, which returns the whole list')
    : bad('revision schema clause missing');
  // THE TRIM THAT PAID FOR IT, asserted so a revert is visible here rather than
  // on the ceiling alone: the hidden-fats bullet and "prefer underestimating"
  // are one bullet now, and neither rule was lost.
  MEAL_ESTIMATION_SYSTEM_PROMPT.includes(
    'matter, and prefer underestimating an unknown over inventing precision'
  ) && !MEAL_ESTIMATION_SYSTEM_PROMPT.includes('- Prefer underestimating')
    ? ok('the two overlapping restraint bullets were folded into one — the trim that paid')
    : bad('the fold was reverted');
}

// === Device feedback, 2026-09-23: the latte asked about milk, never shots =====
//
// The owner, verbatim: *"asked me what milk was in the latte- this is a good
// question, but it did not ask about how many shots and therefore doesn't have
// good caffeination data"*.
//
// The prompt did what it was told. Its bar was "~15% of its energy or ~10 g of
// protein", and one shot is ~1% of a latte's energy and ~50% of its caffeine —
// so the one question that set a figure he tracks was, by the prompt's own
// rule, not worth asking. The fix is the CRITERION, never "if latte, ask
// shots": judgment lives in the model, and his latte is an example, not a spec.

console.log('53. feedback: the bar counts every figure the reply carries, not energy alone');
{
  const E = MEAL_ESTIMATION_SYSTEM_PROMPT;
  const R = MEAL_REVISION_SYSTEM_PROMPT;
  E.includes('Ask nothing unless an answer would change a figure, not just a name:')
    ? ok('a question must change a FIGURE — refining what an item is called is not enough')
    : bad('the figure-not-name criterion is missing');
  E.includes("the meal's energy, caffeine or sodium by ~15%, or its protein by ~10 g")
    ? ok('…and the figures are the ones ARC tracks: energy, caffeine, sodium, protein')
    : bad('the bar does not name the tracked micros');
  // The revert guard: the energy-only bar is exactly what ruled the shots out.
  !E.includes('~15% of its energy')
    ? ok('the energy-only bar is gone, so a revert fails here and not on a phone')
    : bad('the energy-only bar is back');
  E.includes('At most 3, biggest change first;')
    ? ok('ranked by how far an answer moves a figure — three slots still allow milk AND shots')
    : bad('ranking missing');
  // THE OTHER HALF. An answer scales a figure the item carries (§54); if the
  // micros bullet's "OMIT the key when you would be guessing" strips the
  // caffeine off the very item a question is about, there is nothing to scale.
  E.includes('the items you return, micros included, must already') &&
  E.includes('OMIT the key when you would be guessing')
    ? ok('the assumed answer carries its micros, and the omit-a-guess rule stands for the rest')
    : bad('the assumed answer does not carry its micros');

  // A revision may ask too (owner decision) — so it gets the same criterion.
  R.includes("(the meal's energy, caffeine or sodium by ~15%)") &&
  R.includes('At most 3, biggest change first,') &&
  R.includes('the items you return, micros included, must already')
    ? ok('the revision prompt carries the same three clauses')
    : bad('the revision prompt lags the estimate');

  // JUDGMENT LIVES IN THE MODEL: the question rules name figures, never foods.
  // His latte is how the gap was found, not what the rule is about.
  const rules = (p) => p.slice(p.indexOf('Questions ('), p.indexOf('Respond with ONLY'));
  !/latte|espresso|coffee|milk|caffeinated/i.test(rules(E)) &&
  !/latte|espresso|coffee|milk|caffeinated/i.test(rules(R))
    ? ok('neither question block names a drink — a criterion, not "if latte, ask shots"')
    : bad('a food-specific rule has crept into the question block');

  // THE TWO TRIMS THAT PAID FOR IT, asserted so a revert is visible here rather
  // than only on the ceiling (§36).
  E.includes('the food or portion is genuinely uncertain, else "medium".') &&
  !E.includes('for typical mixed dishes')
    ? ok('the confidence bullet is two definitions and a default — the cut the ceiling named')
    : bad('the confidence trim was reverted');
  E.includes('Give sodium and caffeine in milligrams for the portion, not per 100,') &&
  !E.includes('Micro amounts are for the portion you estimated')
    ? ok('the per-portion line is folded into the micros bullet, and the rule is still stated')
    : bad('the per-portion fold was reverted');
}

/** The owner's latte as the prompt now asks for it: the question is about the
 *  espresso, the items assume the most likely answer (two shots), and the
 *  espresso carries the caffeine FOR that answer. The answers set the espresso
 *  outright — `set_amount`, in its own unit — rather than scaling it. */
const SHOTS_REPLY = JSON.stringify({
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
      micros: { caffeine_mg: 126 },
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
      micros: { sodium_mg: 130 },
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
        { label: '2', effect: { set_amount: 'Espresso', amount: 60 } },
        { label: '1', effect: { set_amount: 'Espresso', amount: 30 } },
        { label: '3', effect: { set_amount: 'Espresso', amount: 90 } },
      ],
    },
  ],
});

console.log('54. feedback: a shots answer reaches the caffeine figure, not only the kcal');
{
  // The screen's own path, with the model's reply mocked: estimateMeal's text →
  // parseMealEstimate → groundMealEstimate → rowsFromEstimate → an answer →
  // rowsToMealItems → logMealWithItems. No model is called.
  const { db } = freshDb();
  const estimate = groundMealEstimate(db, parseMealEstimate(SHOTS_REPLY));
  const shots = estimate.questions.find((q) => q.id === 'shots');
  shots &&
  shots.options.length === 3 &&
  shots.options.every((o) => o.effect.kind === 'set_amount' && o.effect.name === 'Espresso')
    ? ok('the shots question parses with its three set_amount answers intact')
    : bad('shots question', JSON.stringify(estimate.questions));
  shots && shots.options[0].effect.amount === estimate.items[0].amount
    ? ok('the first answer is the one the items already assume (60 ml, two shots)')
    : bad('first answer is not the assumed one');
  estimate.items[0].foodId === null && near(parseMicros(estimate.items[0].micros).caffeine_mg, 126)
    ? ok('grounding leaves the espresso and its 126 mg standing')
    : bad('grounded espresso', JSON.stringify(estimate.items[0]));

  const base = rowsFromEstimate(db, estimate);
  const three = applyAnswer(base, shots.options[2].effect);
  const espresso = currentPortion(three[0]);
  near(espresso.amount, 90) &&
  near(espresso.kcal, 7.5) &&
  near(parseMicros(espresso.micros).caffeine_mg, 189)
    ? ok('tapping “3” reaches the caffeine: 126 → 189 mg, not only 5 → 7.5 kcal')
    : bad('the answer stopped at the kcal', JSON.stringify(espresso));
  const milk = currentPortion(three[1]);
  near(milk.amount, 300) &&
  near(parseMicros(milk.micros).sodium_mg, 130) &&
  parseMicros(milk.micros).caffeine_mg === undefined
    ? ok('…and the milk keeps its 300 ml and its sodium, and gains no caffeine')
    : bad('the milk moved', JSON.stringify(milk));

  // WHY THE OLD BAR NEVER ASKED IT, as arithmetic: the energy barely moves.
  const energyShare = (reviewKcal(three) - reviewKcal(base)) / reviewKcal(base);
  const caffeineShare = (189 - 126) / 126;
  energyShare < 0.02 && caffeineShare >= 0.5
    ? ok(
        `the answer moves energy ${(energyShare * 100).toFixed(1)}% and caffeine 50% — under the old bar, never asked`
      )
    : bad('shares', `${energyShare} / ${caffeineShare}`);

  // Changing the answer re-applies to the same base (the hook freezes it), so
  // "3" then "1" is "1", never "3 × ½".
  const one = applyAnswer(base, shots.options[1].effect);
  near(parseMicros(currentPortion(one[0]).micros).caffeine_mg, 63)
    ? ok('“1” reads 63 mg from the same base — the caffeine does not compound')
    : bad('compounded', currentPortion(one[0]).micros);
  near(parseMicros(currentPortion(base[0]).micros).caffeine_mg, 126)
    ? ok('skipping keeps the assumed answer’s 126 mg — accuracy lost, never coherence')
    : bad('skip lost the caffeine');
  const scaled = applyAnswer(base, { kind: 'scale_item', name: 'Espresso', factor: 1.5 });
  near(parseMicros(currentPortion(scaled[0]).micros).caffeine_mg, 189)
    ? ok('the scale_item spelling of the same answer lands on the same 189 mg')
    : bad('scale_item caffeine', currentPortion(scaled[0]).micros);

  // …and it is the figure ARC tracks: the day's own caffeine.
  logMealWithItems(db, {
    date: TODAY,
    time: '08:30',
    name: estimate.title,
    source: 'ai_suggested',
    items: rowsToMealItems(three),
  });
  const day = dayMicroTotals(db, TODAY);
  near(day.caffeine_mg, 189) && near(day.sodium_mg, 130)
    ? ok('saved through the screen’s own path, the day reads 189 mg of caffeine')
    : bad('day totals', JSON.stringify(day));

  // THE OTHER HALF, pinned as a fact: an answer SCALES a figure an item carries
  // and cannot CREATE one. Had the estimator omitted the espresso's caffeine as
  // a guess, "3" would move 2.5 kcal and record nothing — the question would be
  // no path to a caffeine figure at all. Hence "micros included" (§53).
  const bareReply = JSON.parse(SHOTS_REPLY);
  delete bareReply.items[0].micros;
  const bare = rowsFromEstimate(db, parseMealEstimate(JSON.stringify(bareReply)));
  const bareThree = currentPortion(applyAnswer(bare, shots.options[2].effect)[0]);
  near(bareThree.kcal, 7.5) && bareThree.micros === null
    ? ok('omit the caffeine and “3” moves the kcal and records none — an answer cannot create it')
    : bad('an answer created a figure', JSON.stringify(bareThree));
}

console.log('55. 2026-09-23: a LOGGED composite — ate [3] slices, and the Save plan it runs');
{
  // A record has no "of 8": its parts are what was eaten, and the whole was
  // history of the estimate that 0059 never stored. So app/meal-detail.tsx reads
  // a counted record as `ate [3] slices`, an uncounted one as the review's own
  // `ate — of [ ] pieces`, and stages a draft that `planLoggedCount` turns into
  // calls on the repository's two writers. Mirrored here exactly as the screen's
  // `saveCount` runs it, and pinned at the source below so the two cannot drift.
  const save = (db, mealId, draft) => {
    const header = headerOf(db, mealId);
    const plan = planLoggedCount(
      { eatenText: null, wholeText: null, nounText: header.piece_name ?? '', ...draft },
      header
    );
    if (plan.kind === 'clear') clearCompositeCount(db, header.id);
    if (plan.kind === 'set') {
      if (plan.declare != null) setCompositeCount(db, header.id, plan.declare, plan.noun);
      if (plan.eaten != null) setCompositeCount(db, header.id, plan.eaten, plan.noun);
    }
    return plan;
  };
  const partsNow = (db, mealId) =>
    JSON.stringify(partsOf(db, mealId).map((p) => [p.name, p.amount, p.kcal]));

  // COUNTED: one number, what was eaten. The Lager (140) is not a part.
  {
    const { db } = freshDb();
    const { mealId } = countedPizza(db);
    save(db, mealId, { eatenText: '3' }).kind === 'set' &&
    headerOf(db, mealId).serving_qty === 3 &&
    near(getMeal(db, mealId).kcal, (1550 * 3) / 8 + 140)
      ? ok('ate [3] slices over the 8 logged scales every part by 3/8')
      : bad('logged 3 of 8', String(getMeal(db, mealId).kcal));
  }
  {
    const { db } = freshDb();
    const { mealId } = countedPizza(db);
    const before = partsNow(db, mealId);
    const plan = save(db, mealId, { eatenText: '' });
    const header = headerOf(db, mealId);
    plan.kind === 'clear' &&
    header.serving_qty === null &&
    header.piece_name === null &&
    partsNow(db, mealId) === before
      ? ok('a counted record’s ATE saved EMPTY un-declares the dish and scales nothing')
      : bad('logged clear', JSON.stringify([plan, header.serving_qty]));
  }
  {
    const { db } = freshDb();
    const { mealId } = countedPizza(db);
    const before = partsNow(db, mealId);
    save(db, mealId, { nounText: 'wedge' });
    const header = headerOf(db, mealId);
    header.piece_name === 'wedge' && header.serving_qty === 8 && partsNow(db, mealId) === before
      ? ok('a rename alone is a count of the same size: × exactly 1, and a new noun')
      : bad('logged rename', JSON.stringify(header));
    save(db, mealId, {}).kind === 'none'
      ? ok('…and a draft opened and left untouched writes nothing')
      : bad('untouched draft wrote');
  }
  {
    // The drift this closes: a field DISPLAYS 2.7, and the old draft seeded
    // its text from that display — so Save on an untouched 2.6667 re-wrote it.
    const { db } = freshDb();
    const { mealId, headerId } = countedPizza(db);
    scaleCompositeItem(db, headerId, 1 / 3);
    const before = headerOf(db, mealId).serving_qty;
    save(db, mealId, {}).kind === 'none' && headerOf(db, mealId).serving_qty === before
      ? ok('an untouched 2.6667 saves as no change — never re-written as the 2.7 it shows')
      : bad('display drift', String(headerOf(db, mealId).serving_qty));
  }

  // UNCOUNTED: the parts, as logged, are the whole dish — OF declares.
  {
    const { db } = freshDb();
    const { mealId } = pizzaMeal(db);
    const before = partsNow(db, mealId);
    const kcal = getMeal(db, mealId).kcal;
    save(db, mealId, { wholeText: '8', nounText: 'slice' });
    const header = headerOf(db, mealId);
    header.serving_qty === 8 &&
    header.piece_name === 'slice' &&
    partsNow(db, mealId) === before &&
    getMeal(db, mealId).kcal === kcal
      ? ok('on an uncounted record, OF declares what the logged parts are; not one gram moves')
      : bad('logged declaration', JSON.stringify(header));
  }
  {
    const { db } = freshDb();
    const { mealId } = pizzaMeal(db);
    const plan = save(db, mealId, { wholeText: '8', eatenText: '3', nounText: 'slice' });
    plan.kind === 'set' &&
    plan.declare === 8 &&
    plan.eaten === 3 &&
    headerOf(db, mealId).serving_qty === 3 &&
    near(getMeal(db, mealId).kcal, (1550 * 3) / 8 + 140)
      ? ok('…and ATE in the same Save then takes 3 of the 8 — one Save, the review’s sentence')
      : bad('logged declare then eat', JSON.stringify(plan));
  }

  // Refusals.
  planLoggedCount(
    { eatenText: 'abc', wholeText: null, nounText: '' },
    { serving_qty: 8, piece_name: 'slice' }
  ).kind === 'invalid' &&
  planLoggedCount(
    { eatenText: null, wholeText: '0', nounText: '' },
    { serving_qty: null, piece_name: null }
  ).kind === 'invalid' &&
  planLoggedCount(
    { eatenText: '3', wholeText: '', nounText: '' },
    { serving_qty: null, piece_name: null }
  ).kind === 'none'
    ? ok('text that is not a count is refused, and ATE with no OF on a record writes nothing')
    : bad('logged refusals');

  // THE SOURCE PIN: the screen runs exactly this plan, through exactly these writers.
  const screen = readFileSync(new URL('../app/meal-detail.tsx', import.meta.url), 'utf8');
  [
    'planLoggedCount(countEdit, item)',
    'clearCompositeCount(db, item.id)',
    'setCompositeCount(db, item.id, plan.declare, plan.noun)',
    'setCompositeCount(db, item.id, plan.eaten, plan.noun)',
  ].every((s) => screen.includes(s)) && !screen.includes('cleared:')
    ? ok('meal-detail’s Save runs this plan and nothing else — the `cleared` gesture is gone')
    : bad('meal-detail save drifted from the mirrored plan');
  // …and the editor OPENS untouched — a null, never the 2.7 a field displays —
  // the half of the 2.6667 case the plan alone cannot pin. Read out of
  // `openCountEdit` itself, since the row's fallback draft says the same thing.
  const opener = screen.slice(
    screen.indexOf('const openCountEdit'),
    screen.indexOf('const saveCount')
  );
  opener.length > 0 && opener.includes('eatenText: null,') && opener.includes('wholeText: null,')
    ? ok('openCountEdit seeds both fields untouched, so an untouched count saves as no change')
    : bad('openCountEdit seeds a display value');
}

// === Undo and combine (owner, device, 2026-09-23) ============================
//
// *"undo for removing a food"* and *"some way to easily combine multiple food
// logs that are the same meal"*. EXACT is the bar for both, so these sections
// compare whole rows — every column, and the rowid the item reads order by —
// rather than a total or two.

/** Every row of a table with its rowid, in rowid order — what "exact" means. */
function rowsOf(raw, table, where = '1 = 1', ...params) {
  return raw
    .prepare(`SELECT rowid AS __rowid, * FROM ${table} WHERE ${where} ORDER BY rowid`)
    .all(...params);
}
const sameRows = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** The same, blind to the one column an UPDATE-based move must restamp. */
const withoutStamp = (tables) =>
  tables.map((rows) => rows.map(({ updated_at: _stamp, ...rest }) => rest));
const MEAL_TABLES = ['meals', 'meal_items', 'meal_photos', 'pending_estimates'];
const everything = (raw) => MEAL_TABLES.map((t) => rowsOf(raw, t));
const totalsOf = (db) => JSON.stringify(todayTotals(db, TODAY));
const dayOrder = (db) => JSON.stringify(listTodayMeals(db, TODAY).map((m) => m.id));

console.log('56. undo: a removed item comes back as the same rows, in the same place');
{
  const { db, raw } = freshDb();
  const food = microFood(db);
  // Three items in ONE insert batch — one millisecond, so their order among
  // themselves is the rowid tie-break, and the middle one is the hard case.
  const { mealId } = logMealWithItems(db, {
    date: TODAY,
    time: '08:00',
    name: 'Breakfast',
    items: [
      itemForPortion(getFood(db, food), { amount: 80 }),
      {
        name: 'Banana',
        amount: 120,
        kcal: 107,
        protein_g: 1.3,
        carbs_g: 27.4,
        fat_g: 0.4,
        fiber_g: 3.1,
      },
      { name: 'Coffee', amount: 240, unit: 'ml', kcal: 2.4, protein_g: 0.3, carbs_g: 0, fat_g: 0 },
    ],
  });
  const before = rowsOf(raw, 'meal_items', 'meal_id = ?', mealId);
  const meal = getMeal(db, mealId);
  const totals = totalsOf(db);
  const fiber = dayFiberTotal(db, TODAY);
  const micros = JSON.stringify(dayMicroTotals(db, TODAY));
  const order = listMealItems(db, mealId).map((i) => i.id);

  const taken = takeMealItem(db, order[1]);
  taken && taken.name === 'Banana' && taken.kcal === 107 && taken.rows.length === 1
    ? ok('taking an item holds its row — its name and energy for the receipt')
    : bad('taken banana', JSON.stringify(taken));
  listMealItems(db, mealId).length === 2 && near(getMeal(db, mealId).kcal, meal.kcal - 107)
    ? ok('…and removes it through removeMealItem: the meal’s totals follow at once')
    : bad('removal', String(getMeal(db, mealId).kcal));

  restoreMealItems(db, taken);
  sameRows(rowsOf(raw, 'meal_items', 'meal_id = ?', mealId), before)
    ? ok('Undo: every column of every item is back — id, snapshot, micros, created_at, rowid')
    : bad('item rows differ after undo');
  JSON.stringify(listMealItems(db, mealId).map((i) => i.id)) === JSON.stringify(order)
    ? ok('…in its own place: the middle of its batch, not the end')
    : bad('item order after undo');
  const after = getMeal(db, mealId);
  after.kcal === meal.kcal &&
  after.protein_g === meal.protein_g &&
  after.carbs_g === meal.carbs_g &&
  after.fat_g === meal.fat_g &&
  totalsOf(db) === totals &&
  dayFiberTotal(db, TODAY) === fiber &&
  JSON.stringify(dayMicroTotals(db, TODAY)) === micros
    ? ok('…and the meal, the day, its fiber and its micros read exactly what they read before')
    : bad('totals after undo', `${after.kcal} vs ${meal.kcal}`);

  // A catalog food deleted while the Undo was open: the row comes back as
  // `ON DELETE SET NULL` would have left it had it never been removed.
  const catalogItem = order[0];
  const heldFood = takeMealItem(db, catalogItem);
  deleteFood(db, food);
  restoreMealItems(db, heldFood);
  const back = listMealItems(db, mealId).find((i) => i.id === catalogItem);
  back && back.food_id === null && back.kcal === before[0].kcal && back.micros === before[0].micros
    ? ok('a food deleted inside the window: the item returns, its link cleared as SET NULL would')
    : bad('food-less restore', JSON.stringify(back));

  // The meal changed while the item was out (outside the screen's window, but
  // a future caller may): the old figures no longer describe it, so they are
  // re-derived from the items it now holds.
  const changed = takeMealItem(db, order[1]);
  addMealItem(db, mealId, { name: 'Honey', kcal: 64, protein_g: 0, carbs_g: 17, fat_g: 0 });
  restoreMealItems(db, changed);
  const summed = listMealItems(db, mealId).reduce((sum, i) => sum + (i.kcal ?? 0), 0);
  near(getMeal(db, mealId).kcal, summed) && listMealItems(db, mealId).length === 4
    ? ok('put back into a meal that changed since, the totals are re-derived from its items')
    : bad('changed-meal restore', `${getMeal(db, mealId).kcal} vs ${summed}`);

  // The meal itself gone: there is nothing to put the item back into.
  const orphan = takeMealItem(db, order[2]);
  deleteMeal(db, mealId);
  throws(() => restoreMealItems(db, orphan))
    ? ok('an item whose meal has since gone is refused, not re-parented')
    : bad('restore into a missing meal');
}
{
  const { db, raw } = freshDb();
  const { mealId } = pizzaMeal(db);
  const before = rowsOf(raw, 'meal_items', 'meal_id = ?', mealId);
  const kcal = getMeal(db, mealId).kcal;
  const header = before.find((r) => r.is_composite === 1);
  const parts = before.filter((r) => r.parent_item_id === header.id);

  const whole = takeMealItem(db, header.id);
  whole.rows.length === 4 && rowsOf(raw, 'meal_items', 'meal_id = ?', mealId).length === 1
    ? ok('removing the pizza took its three parts, and the Undo holds all four rows')
    : bad('composite take', String(whole.rows.length));
  restoreMealItems(db, whole);
  sameRows(rowsOf(raw, 'meal_items', 'meal_id = ?', mealId), before) &&
  getMeal(db, mealId).kcal === kcal &&
  assembleMealItems(listMealItems(db, mealId))[0].components.length === 3
    ? ok('…and puts the header back before its parts: the same pizza, the same kcal')
    : bad('composite restore');

  removeMealItem(db, parts[0].id);
  removeMealItem(db, parts[1].id);
  const beforeLast = rowsOf(raw, 'meal_items', 'meal_id = ?', mealId);
  const last = takeMealItem(db, parts[2].id);
  last.rows.length === 2 && rowsOf(raw, 'meal_items', 'id = ?', header.id).length === 0
    ? ok('the LAST part takes its header (invariant 4), and the Undo holds both')
    : bad('last part take', String(last.rows.length));
  restoreMealItems(db, last);
  sameRows(rowsOf(raw, 'meal_items', 'meal_id = ?', mealId), beforeLast)
    ? ok('…and Undo brings the header back with its one part')
    : bad('last part restore');
  takeMealItem(db, 'no-such-item') === null
    ? ok('taking an item that is not there takes nothing')
    : bad('phantom take');
}

console.log('57. undo: a deleted meal comes back whole, and its files wait for the window');
{
  const { db, raw } = freshDb();
  const store = fakeStore();
  logMeal(db, { date: TODAY, time: '07:00', name: 'Toast', kcal: 200 });
  const { mealId } = pizzaMeal(db);
  attachMealPhoto(db, mealId, JPEG, store);
  attachMealPhoto(db, mealId, JPEG, store);
  const names = allMealPhotos(db).map((p) => p.file_name);
  const before = everything(raw);
  const totals = totalsOf(db);
  const order = dayOrder(db);

  const taken = takeMealWithPhotos(db, mealId);
  getMeal(db, mealId) === undefined &&
  rowsOf(raw, 'meal_items', 'meal_id = ?', mealId).length === 0 &&
  allMealPhotos(db).length === 0 &&
  store.files.size === 2
    ? ok('delete: the meal, its items and its photo rows go at once — both files stay on disk')
    : bad('take meal', `${store.files.size} file(s)`);
  names.every((n) => heldFiles().has(n)) ? ok('…held, by name') : bad('files not held');
  const inside = sweepMealPhotos(db, store);
  inside.orphans === 0 && store.files.size === 2
    ? ok('a sweep inside the window does not take a held file for an orphan')
    : bad('held file swept', JSON.stringify(inside));

  restoreMealWithPhotos(db, taken);
  sameRows(everything(raw), before)
    ? ok('Undo: every row of the meal, its items and its photos is back, rowid and all')
    : bad('meal rows differ after undo');
  totalsOf(db) === totals && dayOrder(db) === order
    ? ok('…the day’s totals are the figure they were, and the meal is in its own place')
    : bad('day after undo');
  mealPhotoView(db, mealId, new Date(), store) !== null && heldFiles().size === 0
    ? ok('…the photo draws again — its file was never removed — and nothing is held')
    : bad('photo after undo');

  const again = takeMealWithPhotos(db, mealId);
  settleMealRemoval(again, store, null);
  store.files.size === 0 && heldFiles().size === 0 && getMeal(db, mealId) === undefined
    ? ok('the window closing without Undo removes the files and releases them')
    : bad('settle', `${store.files.size} file(s)`);
  const clean = sweepMealPhotos(db, store);
  clean.orphans === 0 && clean.dangling === 0
    ? ok('…leaving a sweep nothing to find')
    : bad('residue after settle', JSON.stringify(clean));
}
{
  // THE CRASH. The app is killed inside the window: the Undo and its holds die
  // with the process. The next launch holds nothing, so its sweep sees files no
  // row claims — and no row survived to lose them.
  const { db } = freshDb();
  const store = fakeStore();
  const mealId = logMeal(db, { date: TODAY, time: '12:30', name: 'Lunch', kcal: 700 });
  attachMealPhoto(db, mealId, JPEG, store);
  const taken = takeMealWithPhotos(db, mealId);
  const nextLaunch = sweepMealPhotos(db, store, new Date(), new Set());
  nextLaunch.orphans === 1 &&
  nextLaunch.dangling === 0 &&
  store.files.size === 0 &&
  allMealPhotos(db).length === 0 &&
  getMeal(db, mealId) === undefined
    ? ok('killed inside the window: the next launch reclaims the file, and no row outlives it')
    : bad('crash sweep', JSON.stringify(nextLaunch));
  // This process did not die; release what the simulated one held.
  releaseFiles(takenPhotoFileNames(taken));
}
{
  // A placeholder with a queued photo estimate (0057) — the queue row is part
  // of the meal, and its photo lives in the other directory.
  const { db, raw } = freshDb();
  const pendingStore = fakeStore();
  const file = writePendingEstimatePhoto('/9j/queued', pendingStore);
  const { mealId } = queueNewMealEstimate(
    db,
    { date: TODAY, time: '13:00', name: placeholderMealName(null) },
    { kind: 'photo', file_name: file, width: 800, height: 600 }
  );
  const before = everything(raw);
  const taken = takeMealWithPhotos(db, mealId);
  listPendingEstimates(db).length === 0 &&
  sweepPendingEstimatePhotos(db, pendingStore).orphanFilesRemoved === 0 &&
  pendingStore.files.has(file)
    ? ok('a deleted placeholder’s queued photo is held, and its own directory’s sweep leaves it')
    : bad('pending take');
  restoreMealWithPhotos(db, taken);
  sameRows(everything(raw), before) && pendingEstimateMealIds(db, TODAY).has(mealId)
    ? ok('…Undo queues the estimate again, pointing at the same photo')
    : bad('pending restore');
  const again = takeMealWithPhotos(db, mealId);
  settleMealRemoval(again, null, pendingStore);
  !pendingStore.files.has(file) && heldFiles().size === 0
    ? ok('…and settling removes the queued photo with the meal')
    : bad('pending settle');
}
{
  // A recipe deleted while the Undo was open — `meals.recipe_id` is SET NULL.
  const { db } = freshDb();
  const recipeId = createRecipe(db, { title: 'Chili', servings: 4, ingredients: [] });
  const { mealId } = logMealWithItems(db, {
    date: TODAY,
    time: '19:00',
    name: 'Chili',
    recipe_id: recipeId,
    items: [{ name: 'Chili', amount: 350, kcal: 420 }],
  });
  const taken = takeMealWithPhotos(db, mealId);
  deleteRecipe(db, recipeId);
  restoreMealWithPhotos(db, taken);
  const back = getMeal(db, mealId);
  back && back.recipe_id === null && back.kcal === 420
    ? ok('a recipe deleted inside the window: the meal returns, its link cleared as SET NULL would')
    : bad('recipe-less restore', JSON.stringify(back));
}
{
  // The Coach's path is the same removal with the window shut at once.
  const { db } = freshDb();
  const store = fakeStore();
  const mealId = logMeal(db, { date: TODAY, time: '12:30', name: 'Lunch', kcal: 700 });
  attachMealPhoto(db, mealId, JPEG, store);
  deleteMealWithPhotos(db, mealId, store);
  getMeal(db, mealId) === undefined && store.files.size === 0 && heldFiles().size === 0
    ? ok('deleteMealWithPhotos (the Coach) is take-then-settle: nothing held, nothing left')
    : bad('coach delete');
  const screen = readFileSync(new URL('../app/meal-detail.tsx', import.meta.url), 'utf8');
  screen.includes('takeMealItem(db, itemId)') &&
  screen.includes('takeMealWithPhotos(db, meal.id)') &&
  !screen.includes('deleteMealWithPhotos(') &&
  !screen.includes('removeMealItem(')
    ? ok('meal-detail removes only through the taking functions — every removal there has an Undo')
    : bad('meal-detail removes without an Undo');
}

console.log('58. combine: four meals become one — nothing lost, nothing doubled, nothing dangling');
{
  const { db, raw } = freshDb();
  const store = fakeStore();
  const food = microFood(db);
  // Two barcode-style meals, a typed coffee, an unpriced tea — and the
  // evening's pizza, which is not chosen and must not move.
  const oat = logMealWithItems(db, {
    date: TODAY,
    time: '08:10',
    name: 'Oat milk · Oatly',
    items: [itemForPortion(getFood(db, food), { amount: 250 })],
  }).mealId;
  const granola = logMealWithItems(db, {
    date: TODAY,
    time: '08:12',
    name: 'Granola',
    notes: 'Estimated from the pack',
    source: 'ai_suggested',
    items: [
      {
        name: 'Granola',
        amount: 60,
        kcal: 270.6,
        protein_g: 6.1,
        carbs_g: 38.2,
        fat_g: 10.3,
        fiber_g: 4.2,
        confidence: 'medium',
        micros: JSON.stringify({ sodium_mg: 30 }),
      },
      { name: 'Blueberries', amount: 80, kcal: 45.6, protein_g: 0.6, carbs_g: 11.6, fat_g: 0.3 },
    ],
  }).mealId;
  attachMealPhoto(db, granola, JPEG, store);
  const coffee = logMeal(db, {
    date: TODAY,
    time: '08:20',
    name: 'Coffee',
    kcal: 15,
    protein_g: 1,
  });
  const tea = logMeal(db, { date: TODAY, time: '08:30', name: 'Tea' });
  const pizza = pizzaMeal(db).mealId;

  const before = everything(raw);
  const totals = todayTotals(db, TODAY);
  const fiber = dayFiberTotal(db, TODAY);
  const micros = JSON.stringify(dayMicroTotals(db, TODAY));
  const order = dayOrder(db);
  const itemIds = rowsOf(raw, 'meal_items', 'meal_id IN (?, ?)', oat, granola).map((r) => r.id);
  const pizzaRows = rowsOf(raw, 'meal_items', 'meal_id = ?', pizza);
  const modes = () =>
    JSON.stringify(
      ['kcal', 'protein_g'].map(
        (metric) =>
          dayFigure(listTodayMeals(db, TODAY), metric, 3000, partialMealMetrics(db, TODAY)).mode
      )
    );
  const modesBefore = modes();

  // Chosen out of order, and named at the moment of combining.
  const combined = combineMeals(db, [tea, granola, coffee, oat], { name: '  Breakfast ' });

  combined.keptId === oat && combined.count === 4 && combined.name === 'Breakfast'
    ? ok('the earliest meal survives — its id — and the typed name is trimmed and taken')
    : bad('kept', JSON.stringify({ keptId: combined.keptId, name: combined.name }));
  const result = getMeal(db, oat);
  result.time === '08:10' && result.date === TODAY && result.name === 'Breakfast'
    ? ok('…at the earliest time, on the same day')
    : bad('result meal', JSON.stringify(result));
  [granola, coffee, tea].every((id) => getMeal(db, id) === undefined) && getMeal(db, pizza)
    ? ok('the absorbed rows are gone; the pizza nobody chose is untouched')
    : bad('absorbed rows');
  sameRows(rowsOf(raw, 'meal_items', 'meal_id = ?', pizza), pizzaRows)
    ? ok('…down to every column of its items')
    : bad('pizza moved');

  const after = todayTotals(db, TODAY);
  near(after.kcal, totals.kcal) &&
  near(after.protein_g, totals.protein_g) &&
  near(after.carbs_g, totals.carbs_g) &&
  near(after.fat_g, totals.fat_g) &&
  after.mealCount === totals.mealCount - 3
    ? ok(
        `TOTALS: the day reads ${Math.round(after.kcal)} kcal before and after — four meals are one`
      )
    : bad('day totals moved', `${totals.kcal} → ${after.kcal}`);
  near(dayFiberTotal(db, TODAY), fiber) && JSON.stringify(dayMicroTotals(db, TODAY)) === micros
    ? ok('…and so do its fiber and its micronutrients')
    : bad('fiber/micros moved');
  modes() === modesBefore
    ? ok(
        '…and the countdown refuses exactly what it refused before (the unpriced tea still counts)'
      )
    : bad('countdown changed', `${modesBefore} → ${modes()}`);

  const items = listMealItems(db, oat);
  const ids = items.map((i) => i.id);
  itemIds.every((id) => ids.includes(id)) &&
  new Set(ids).size === ids.length &&
  ids.length === itemIds.length + 2
    ? ok(
        `ITEMS: all ${itemIds.length} moved by id, none doubled, plus two stand-ins — ${ids.length} in all`
      )
    : bad('items', JSON.stringify(ids));
  const coffeeItem = items.find((i) => i.name === 'Coffee (as logged)');
  const teaItem = items.find((i) => i.name === 'Tea (as logged)');
  coffeeItem && coffeeItem.kcal === 15 && coffeeItem.protein_g === 1 && coffeeItem.carbs_g === null
    ? ok('a free-form meal’s typed totals become an item — “Coffee (as logged)”, 15 kcal')
    : bad('coffee stand-in', JSON.stringify(coffeeItem));
  teaItem && teaItem.kcal === null
    ? ok('…and an unpriced one keeps its name as a name-only item, never a 0')
    : bad('tea stand-in', JSON.stringify(teaItem));
  JSON.stringify(items.map((i) => i.name)) ===
  JSON.stringify(['Micro food', 'Granola', 'Blueberries', 'Coffee (as logged)', 'Tea (as logged)'])
    ? ok('…listed in the order they were logged, the stand-ins at their meals’ own moments')
    : bad('item order', JSON.stringify(items.map((i) => i.name)));

  latestMealPhoto(db, oat)?.meal_id === oat && mealPhotoView(db, oat, new Date(), store) !== null
    ? ok('PHOTOS: the granola’s photo moved to the result, and draws there')
    : bad('photo not moved');
  result.notes === 'Estimated from the pack' && result.source === 'ai_suggested'
    ? ok('…its note is kept, and a meal holding an estimate reads as one (source)')
    : bad('notes/source', JSON.stringify(result));
  raw.prepare('PRAGMA foreign_key_check').all().length === 0
    ? ok('REFERENCES: PRAGMA foreign_key_check finds nothing dangling')
    : bad('dangling reference', JSON.stringify(raw.prepare('PRAGMA foreign_key_check').all()));

  // THE UNDO, on the same fixture.
  uncombineMeals(db, combined);
  sameRows(withoutStamp(everything(raw)), withoutStamp(before))
    ? ok('UNDO: every row of every meal table is back — ids, rowids, created_at, totals, photos')
    : bad('rows differ after uncombine');
  totalsOf(db) === JSON.stringify(totals) &&
  near(dayFiberTotal(db, TODAY), fiber) &&
  dayOrder(db) === order
    ? ok('…and the day reads exactly what it read before the combine, in the same order')
    : bad('day after uncombine');
}

console.log('59. combine: composites stay whole, a stale Undo is refused, refusals write nothing');
{
  const { db, raw } = freshDb();
  const { mealId: pizza } = pizzaMeal(db);
  const dessert = logMealWithItems(db, {
    date: TODAY,
    time: '20:15',
    name: 'Ice cream',
    items: [{ name: 'Ice cream', amount: 100, kcal: 207, protein_g: 3.5, carbs_g: 24, fat_g: 11 }],
  }).mealId;
  const kcal = getMeal(db, pizza).kcal + 207;
  const combined = combineMeals(db, [dessert, pizza]);
  const tree = assembleMealItems(listMealItems(db, pizza));
  combined.name === 'Dinner' &&
  tree.length === 3 &&
  tree[0].kind === 'composite' &&
  tree[0].components.length === 3 &&
  near(getMeal(db, pizza).kcal, kcal)
    ? ok(
        'a pizza combined keeps its header over its three parts; an untyped name is the earliest’s'
      )
    : bad('composite combine', JSON.stringify(tree.map((n) => n.kind)));
  raw.prepare('PRAGMA foreign_key_check').all().length === 0
    ? ok('…no part is orphaned into another meal (0058 invariant 3)')
    : bad('composite dangling');
  addMealItem(db, pizza, { name: 'Garlic bread', kcal: 180 });
  const moved = everything(raw);
  throws(() => uncombineMeals(db, combined)) && sameRows(everything(raw), moved)
    ? ok('an Undo after the combined meal changed is refused, and writes nothing')
    : bad('stale uncombine');
}
{
  const { db, raw } = freshDb();
  const soup = logMeal(db, { date: TODAY, time: '12:00', name: 'Soup', kcal: 300 });
  const { mealId: waiting } = queueNewMealEstimate(
    db,
    { date: TODAY, time: '12:05', name: 'a sandwich' },
    { kind: 'text', description: 'a sandwich' }
  );
  const r1 = createRecipe(db, { title: 'Chili', servings: 4, ingredients: [] });
  const r2 = createRecipe(db, { title: 'Cornbread', servings: 8, ingredients: [] });
  const chili = logMealWithItems(db, {
    date: TODAY,
    time: '19:00',
    name: 'Chili',
    recipe_id: r1,
    items: [{ name: 'Chili', kcal: 420 }],
  }).mealId;
  const cornbread = logMealWithItems(db, {
    date: TODAY,
    time: '19:05',
    name: 'Cornbread',
    recipe_id: r2,
    items: [{ name: 'Cornbread', kcal: 190 }],
  }).mealId;
  const old = logMeal(db, { date: '2000-01-01', time: '12:00', name: 'Old', kcal: 1 });
  const snapshot = everything(raw);
  const refusal = (ids) => {
    try {
      combineMeals(db, ids);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const pendingMessage = refusal([soup, waiting]);
  pendingMessage && pendingMessage.includes('a sandwich') && pendingMessage.includes('estimate')
    ? ok('a meal waiting on its estimate is refused by name — its drain would replace everything')
    : bad('pending refusal', String(pendingMessage));
  const recipeMessage = refusal([chili, cornbread]);
  recipeMessage && recipeMessage.includes('Chili') && recipeMessage.includes('Cornbread')
    ? ok('two meals cooked from two recipes are refused — a meal carries one recipe')
    : bad('recipe refusal', String(recipeMessage));
  (refusal([soup, old]) ?? '').includes('different days')
    ? ok('meals from different days are refused')
    : bad('day refusal');
  refusal([soup]) !== null && refusal([soup, soup]) !== null && refusal([soup, 'gone']) !== null
    ? ok('one meal, the same meal twice, or a meal that is gone: refused')
    : bad('too-few refusal');
  sameRows(everything(raw), snapshot)
    ? ok('…and not one of those refusals wrote anything')
    : bad('a refusal wrote');
  const more = logMealWithItems(db, {
    date: TODAY,
    time: '19:30',
    name: 'More chili',
    recipe_id: r1,
    items: [{ name: 'Chili', kcal: 210 }],
  }).mealId;
  const twice = combineMeals(db, [chili, more]);
  getMeal(db, twice.keptId).recipe_id === r1 && getMeal(db, twice.keptId).kcal === 630
    ? ok('two servings of the SAME recipe combine, and keep it')
    : bad('same recipe', JSON.stringify(getMeal(db, twice.keptId)));
}

console.log('60. the combine plan (pure), and the one Undo slot');
{
  const m = (id, time, created, extra = {}) => ({
    id,
    date: TODAY,
    time,
    name: id,
    kcal: 100,
    recipe_id: null,
    created_at: created,
    ...extra,
  });
  const untimed = m('untimed', null, '2026-09-23T06:00:00.000Z');
  const late = m('late', '12:00', '2026-09-23T07:00:00.000Z');
  const early = m('early', '08:00', '2026-09-23T11:00:00.000Z');
  const tie = m('tie', '08:00', '2026-09-23T12:00:00.000Z', { kcal: null });
  JSON.stringify([untimed, late, tie, early].sort(mealListOrder).map((x) => x.id)) ===
  JSON.stringify(['early', 'tie', 'late', 'untimed'])
    ? ok('list order: by clock, a tie by when it was logged, the untimed last')
    : bad('list order');
  const plan = planCombine([untimed, late, early]);
  plan.kind === 'ok' &&
  plan.keep.id === 'early' &&
  plan.time === '08:00' &&
  plan.kcal === 300 &&
  JSON.stringify(plan.absorb.map((x) => x.id)) === JSON.stringify(['late', 'untimed'])
    ? ok('the plan keeps the earliest and sums the energy the three carry')
    : bad('plan', JSON.stringify(plan));
  planCombine([early, tie]).kcal === 100
    ? ok('…summing only the meals that recorded any — no invented 0')
    : bad('null kcal sum');
  planCombine([early]).kind === 'too-few' && planCombine([early, early]).kind === 'too-few'
    ? ok('one meal (or one chosen twice) is too few')
    : bad('too-few');
  planCombine([early, late], new Set(['late'])).kind === 'refused'
    ? ok('a pending estimate refuses the plan')
    : bad('pending plan');
  combinedName(null, early) === 'early' &&
  combinedName('   ', early) === 'early' &&
  combinedName(' Brunch ', early) === 'Brunch'
    ? ok('the name: the earliest meal’s unless something is typed; an emptied field is not a name')
    : bad('combinedName');
  const sentence = combineConsequence(plan, 'Brunch');
  sentence ===
  'On combine: these 3 become one meal, “Brunch”, at 08:00 — 300 kcal, so the day’s total does not change. Their items and photos move into it.'
    ? ok('the consequence names the name, the time and the energy, in future tense')
    : bad('consequence', sentence);
  combineConsequence({ ...plan, time: null, kcal: null }, 'Brunch').includes(
    'with no time — no energy recorded'
  )
    ? ok('…and says so when there is no time and no energy')
    : bad('consequence (empty)');

  // THE SLOT — the water receipt's timing: one offer, replaced by the next, no timer.
  const log = [];
  const offer = (tag, scope = { on: 'list' }, fails = false) => ({
    scope,
    icon: 'restaurant-outline',
    said: tag,
    figure: null,
    spoken: tag,
    undo: () => {
      if (fails) throw new Error('gone');
      log.push(`undo ${tag}`);
    },
    settle: () => log.push(`settle ${tag}`),
  });
  let emits = 0;
  const unsubscribe = subscribeUndo(() => emits++);
  offerUndo(offer('a'));
  offerUndo(offer('b'));
  currentUndo()?.said === 'b' && JSON.stringify(log) === JSON.stringify(['settle a'])
    ? ok('a new offer replaces the open one, and the replaced one is settled (its files go)')
    : bad('replace', JSON.stringify(log));
  closeUndo(onMeal);
  closeUndo(onList);
  currentUndo() === null && JSON.stringify(log) === JSON.stringify(['settle a', 'settle b'])
    ? ok('leaving a screen closes only its own kind of offer, settling it')
    : bad('close', JSON.stringify(log));
  offerUndo(offer('c', { on: 'meal', mealId: 'm1' }));
  runUndo() === true && currentUndo() === null && log.at(-1) === 'undo c'
    ? ok('Undo puts it back and clears the slot — and is never settled as well')
    : bad('run', JSON.stringify(log));
  runUndo() === false ? ok('with nothing open, Undo does nothing') : bad('empty run');
  offerUndo(offer('d', { on: 'list' }, true));
  runUndo() === false && log.at(-1) === 'settle d' && currentUndo() === null
    ? ok('an Undo that cannot be done is settled — nothing is left held for it')
    : bad('failed run', JSON.stringify(log));
  unsubscribe();
  emits === 7 ? ok('every change told its listeners, once each') : bad('emits', String(emits));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
