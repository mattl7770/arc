/**
 * Headless RENDER test of the recipes/grocery screens — the real .tsx screen
 * components (app/recipes, recipe-detail, recipe-edit, recipe-import, grocery,
 * plus the edited nutrition hub and meal-detail) rendered to HTML via
 * react-native-web + react-dom/server, over a node:sqlite database running the
 * REAL migrations. Every synchronous DB read the screens do in their useState
 * initializers executes for real; a crash in any component body fails the
 * suite; key content is asserted in the rendered output.
 *
 * What this deliberately is NOT: a look/feel or interaction verdict — effects
 * don't run in a server render, and taps can't be simulated here. Device
 * verification stays the on-device checklist in docs/recipes-grocery.md §10
 * (memory: verify on device, not web).
 *
 * Run: npm run db:test (via node --import ./db/register-render-hooks.mjs).
 */
import React from 'react';
import { renderToString } from 'react-dom/server';

import { __setParams } from './render-stubs/expo-router.mjs';
import { getDb } from './render-stubs/db-client.mjs';

import { todayISODate } from '../src/lib/db/date.ts';
import { createFood } from '../src/lib/db/repositories/foods.ts';
import {
  logMeal,
  logMealWithItems,
  setNutritionTargets,
  updateMealName,
} from '../src/lib/db/repositories/nutrition.ts';
import {
  createFolder,
  createRecipe,
  listIngredients,
  moveRecipeToFolder,
  resolveIngredient,
  setIngredientNegligible,
  setRecipeFavorite,
} from '../src/lib/db/repositories/recipes.ts';
import {
  addGroceryItems,
  checkGroceryItem,
  setStaple,
} from '../src/lib/db/repositories/grocery.ts';

import { logWorkout } from '../src/lib/db/repositories/exercise.ts';
import { importProgressPhotos } from '../src/lib/media/progress-photo-store.ts';
import { createProtocolWithVersion } from '../src/lib/db/repositories/protocols.ts';
import { generateMissionForDay } from '../src/lib/db/repositories/mission-generate.ts';
import { setMissionStatus } from '../src/lib/db/repositories/mission.ts';
import { clearMuscleAnchor, setMuscleAnchor } from '../src/lib/db/repositories/muscle-anchors.ts';

import { ingestCorpus } from '../src/lib/rag/corpus.ts';
import { saveKnowledgeEntry } from '../src/lib/db/repositories/knowledge.ts';

import ExerciseScreen from '../app/exercise.tsx';
import MissionHistoryScreen from '../app/mission-history.tsx';
import WaterScreen from '../app/water.tsx';
import MuscleFreshnessScreen from '../app/muscle-freshness.tsx';
import ExerciseDetailScreen from '../app/exercise-detail.tsx';
import RecipesScreen from '../app/recipes.tsx';
import RecipeDetailScreen from '../app/recipe-detail.tsx';
import RecipeEditScreen from '../app/recipe-edit.tsx';
import RecipeImportScreen from '../app/recipe-import.tsx';
import RecipeFoldersScreen from '../app/recipe-folders.tsx';
import RecipeReviseScreen from '../app/recipe-revise.tsx';
import GroceryScreen from '../app/grocery.tsx';
import NutritionScreen from '../app/nutrition.tsx';
import MealDetailScreen from '../app/meal-detail.tsx';
// The two camera screens. They could not be imported here until `expo-camera`
// moved behind the guarded seam (src/lib/media/camera.ts) — a static native
// import is a resolve failure under node, not a render failure.
import BarcodeScanScreen from '../app/barcode-scan.tsx';
import MealEstimateScreen from '../app/meal-estimate.tsx';
import { apiKeyStore } from '../src/lib/ai/api-key-store.ts';
import ProgressPhotosScreen from '../app/progress-photos.tsx';
import ProgressPhotoAddScreen from '../app/progress-photo-add.tsx';
import ProgressPhotoDetailScreen from '../app/progress-photo-detail.tsx';
import ProgressPhotoCompareScreen from '../app/progress-photo-compare.tsx';
import KnowledgeScreen from '../app/knowledge.tsx';
import KnowledgeEntryScreen from '../app/knowledge-entry.tsx';
import KnowledgeEntryEditScreen from '../app/knowledge-entry-edit.tsx';
import KnowledgeImportScreen from '../app/knowledge-import.tsx';
import ReportsScreen from '../app/reports.tsx';
import ReportViewScreen from '../app/report-view.tsx';
import DataScreen from '../app/(tabs)/data.tsx';
import HomeScreen from '../app/(tabs)/index.tsx';

import { logWater } from '../src/lib/db/repositories/water.ts';
import { setWaterTarget } from '../src/lib/db/repositories/user.ts';
import { insertReport } from '../src/lib/db/repositories/reports.ts';
import { assembleSelfReview } from '../src/lib/reports/assemble-self-review.ts';
import { periodFromBounds } from '../src/lib/reports/period.ts';

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

/** Render a screen to HTML; a throw anywhere in the tree is a failure. */
function render(name, Component, params = {}, props = {}) {
  __setParams(params);
  try {
    return renderToString(React.createElement(Component, props));
  } catch (e) {
    bad(`${name} rendered`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** The negative of expect: these strings must NOT be on the screen. Used where
 *  the absence IS the behaviour — a remainder the day cannot support, a setup
 *  affordance that has retired. */
function refute(name, html, substrings) {
  if (html === null) return;
  for (const sub of substrings) {
    if (html.includes(sub)) bad(`${name} must NOT show "${sub}"`);
    else ok(`${name} does not show "${sub}"`);
  }
}

/**
 * The body figure actually DREW — the check that came in with the SVG rewrite
 * (2026-08-25), when the figure stopped being `View`s and became `<Path>`
 * elements with gradient fills.
 *
 * The render stub maps every react-native-svg element to its real DOM tag, so a
 * server render emits genuine markup and three silent failures become visible
 * here: a figure that mounted no paths at all, a `url(#…)` fill pointing at a
 * gradient id that is not in the document (which paints the muscle BLACK on
 * iOS and nothing at all on web), and a NaN in any coordinate — all of which a
 * text assertion walks straight past.
 *
 * It says nothing about how the drawing LOOKS. That stays db/figure-preview.mjs
 * and the device (memory: verify on device, not web).
 */
function figureDrew(name, html) {
  if (html === null) return;
  const paths = (html.match(/<path/g) || []).length;
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const refs = [...html.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]);
  const dangling = refs.filter((r) => !ids.has(r));
  paths >= 100
    ? ok(`${name}: the figure pair drew ${paths} paths`)
    : bad(`${name}: figure drew only ${paths} paths`);
  refs.length > 0 && dangling.length === 0
    ? ok(`${name}: all ${refs.length} gradient references resolve inside the document`)
    : bad(`${name}: dangling gradient refs`, dangling.join(' ') || 'no gradients at all');
  html.includes('NaN')
    ? bad(`${name}: NaN in the rendered markup`)
    : ok(`${name}: no NaN reached the path data`);
}

function expect(name, html, substrings) {
  if (html === null) return;
  ok(`${name} rendered without throwing (${html.length} chars)`);
  for (const s of substrings) {
    if (html.includes(s)) ok(`${name} shows "${s}"`);
    else bad(`${name} shows "${s}"`);
  }
}

const db = getDb();

{
  console.log('0. Empty states (fresh DB, real migrations)');
  expect('recipes (empty)', render('recipes (empty)', RecipesScreen), [
    'Import a recipe',
    'No recipes yet',
  ]);
  expect('grocery (empty)', render('grocery (empty)', GroceryScreen), [
    'Grocery list',
    'The list is clear.',
  ]);
  expect(
    'recipe-detail (missing id)',
    render('recipe-detail (missing id)', RecipeDetailScreen, { id: 'nope' }),
    ['This recipe is gone.']
  );
  expect('recipe-edit (new)', render('recipe-edit (new)', RecipeEditScreen), [
    'New recipe',
    'Add ingredient',
    'Save recipe',
  ]);
  expect('recipe-import', render('recipe-import', RecipeImportScreen), [
    'Import a recipe',
    'From a link',
    'Paste text',
    'No model key is set', // honest no-key state under node
  ]);

  // The execution record on a database that has never planned a day. This
  // render has to happen HERE, before any fixture touches log_entries: the
  // never-planned state is the one this screen most has to get right, and it
  // only exists once.
  const virgin = render('mission-history (never planned)', MissionHistoryScreen);
  expect('mission-history (never planned)', virgin, [
    'Mission',
    'No mission has been planned yet',
    'Set up a protocol', // the accent moves to the one action when there are no bars
  ]);
  // Nothing may imply a record that does not exist: no rate, no denominators,
  // no day rows, and above all no "nothing was missed" — which is a claim about
  // a plan, and there has never been one.
  refute('mission-history (never planned)', virgin, [
    '0 of 0',
    '0%',
    'Nothing was missed',
    'on record',
    'By day',
  ]);

  // The water record on a database that has never logged a drop. Like
  // mission-history above, this render must happen HERE — the never-logged
  // state exists exactly once, and §14 below is what fills the table.
  const dry = render('water (never logged)', WaterScreen);
  expect('water (never logged)', dry, [
    'Water',
    'No water logged yet. Tap an amount below and the record starts.',
    // The stamp takes the accent when there are no bars to spend it on.
    'No water yet',
    'The record starts with one glass',
    // Logging is on the screen itself — that is the whole point of it.
    'Glass',
    'Bottle',
    'Large',
    // No goal is an authored state, not a guess.
    'None set — totals show without a target.',
  ]);
  // Nothing may imply a record that does not exist, and above all no
  // plausible-looking zero: a day with nothing logged and a day of 0 oz are
  // different facts. No goal means no denominator, no percentage, no bar.
  refute('water (never logged)', dry, [
    '0 oz',
    '0 ml',
    'of goal',
    'By day',
    'on record',
    'average',
  ]);

  // 0035: the cabinet before there is anything in it. "Unfiled is a place" is
  // the design statement the whole feature turns on, so it is asserted.
  expect('recipe-folders (empty)', render('recipe-folders (empty)', RecipeFoldersScreen), [
    'Folders',
    'New folder',
    'No folders yet',
  ]);
  expect(
    'recipe-revise (missing id)',
    render('recipe-revise (missing id)', RecipeReviseScreen, { id: 'nope' }),
    ['This recipe is gone']
  );
}

{
  console.log('1. Fixtures through the real repositories');
  const chicken = createFood(db, {
    name: 'Render chicken',
    kcal_100g: 165,
    protein_g_100g: 31,
    carbs_g_100g: 0,
    fat_g_100g: 3.6,
  });
  const adobo = createRecipe(db, {
    title: 'Chicken Adobo',
    source: 'import',
    source_platform: 'instagram',
    source_author: 'renderchef',
    servings: 2,
    steps: ['Brown the chicken pieces.', 'Simmer in the sauce.'],
    ingredients: [
      { raw_text: '400 g chicken thighs' },
      { raw_text: '1/2 cup soy sauce' },
      { raw_text: 'salt to taste' },
    ],
  });
  const lines = listIngredients(db, adobo);
  resolveIngredient(db, lines[0].id, chicken, 400);
  resolveIngredient(db, lines[1].id, chicken, 120); // stand-in food; math is what's rendered
  setIngredientNegligible(db, lines[2].id, true);

  const draft = createRecipe(db, {
    title: 'Mystery stew',
    servings: 4,
    ingredients: [{ raw_text: 'some vegetables' }],
  });
  setRecipeFavorite(db, draft, true);

  addGroceryItems(db, [
    { name: 'Milk', qty_text: '2' },
    { name: 'Spinach' },
    { name: 'Sourdough' },
  ]);
  setStaple(db, 'Coffee beans', true);

  const { mealId } = logMealWithItems(db, {
    date: '2026-08-08',
    time: '12:00',
    name: 'Render lunch',
    items: [{ food_id: chicken, name: 'Render chicken', grams: 150, kcal: 247.5, protein_g: 46.5 }],
  });

  // A BARCODED food, logged — the two facts the scanner's running list joins
  // (§7b). `Render chicken` above is deliberately left barcode-less, so the
  // list's narrowing is proved by an exclusion and not only by an inclusion.
  const oatDrink = createFood(db, {
    name: 'Render oat drink',
    brand: 'Oatly-ish',
    barcode: '5060000000000',
    kcal_100g: 46,
    protein_g_100g: 1,
    carbs_g_100g: 6.7,
    fat_g_100g: 1.5,
  });
  logMealWithItems(db, {
    date: '2026-08-08',
    time: '07:30',
    name: 'Render breakfast',
    items: [{ food_id: oatDrink, name: 'Render oat drink', grams: 250, kcal: 115 }],
  });

  ok('fixtures seeded (recipes, grocery, meal)');

  console.log('2. Populated renders');
  expect('recipes (populated)', render('recipes (populated)', RecipesScreen), [
    'Chicken Adobo',
    'Mystery stew',
    'kcal/serving', // the complete recipe's honest headline
    'ingredient',
  ]);
  // Complete recipe: per-serving numbers + steps + the per-line PROVENANCE
  // that replaced the Link chore (0034). `your pick` is the fixture's
  // hand-resolved line; the negligible one still says so in words.
  expect(
    'recipe-detail (complete)',
    render('recipe-detail (complete)', RecipeDetailScreen, { id: adobo }),
    [
      'Chicken Adobo',
      'renderchef',
      '400 g chicken thighs',
      'Brown the chicken pieces.',
      'Per serving',
      'Log it',
      'Add to grocery list',
      'counts as 0, on purpose', // the negligible salt line
      'your pick', // provenance, not an affordance
      'priced', // the Ingredients tally
    ]
  );
  // Incomplete recipe. The headless runtime has no model key, so the model pass
  // never fires and the screen must say WHY the lines are unpriced rather than
  // handing the user a chore — which is the whole point of the 0034 change.
  const incomplete = render('recipe-detail (incomplete)', RecipeDetailScreen, { id: draft });
  expect('recipe-detail (incomplete)', incomplete, [
    'Mystery stew',
    'not priced yet',
    'aren’t in your food catalog',
  ]);
  !incomplete.includes('Link each line') && !incomplete.includes('Nutrition not computed')
    ? ok('recipe-detail no longer asks the user to link anything')
    : bad('the Link chore is still on the screen');
  expect(
    'recipe-edit (existing)',
    render('recipe-edit (existing)', RecipeEditScreen, { id: adobo }),
    ['Edit recipe', '400 g chicken thighs', 'Save changes']
  );
  expect('grocery (populated)', render('grocery (populated)', GroceryScreen), [
    'Dairy &amp; Eggs', // category section from the static table
    'Milk',
    'Produce',
    'Spinach',
    'Bakery',
    'Sourdough',
    'Staples',
    'Coffee beans',
  ]);

  console.log('3. The Eat tab, redrawn — first run (no targets, nothing logged today)');
  {
    // The fixture meal is dated 2026-08-08; the hub reads TODAY, so this render
    // is the genuine first-run state even with the book and list populated.
    const html = render('nutrition hub (first run)', NutritionScreen);
    expect('nutrition hub (first run)', html, [
      'Nothing logged yet today, and no targets set',
      'Set daily targets', // promoted to a full-width control while it is needed
      // The capture pair is the accent in every state, and the chooser sits
      // under it outlined — the owner's words, verbatim (2026-08-15). Asserted
      // by NAME so a sweep that quietly restores "Log" fails the suite.
      'Other ways to log',
      'Photo',
      'Describe',
      'Kitchen',
      'Recipe book',
      'Grocery list',
      '2 recipes',
      '3 to buy',
      'Over time',
      'Energy',
      'Protein',
      'Micronutrients',
    ]);
    // No target exists, so no figure may carry a denominator and nothing may
    // claim a remainder.
    refute('nutrition hub (first run)', html, ['kcal left', 'left of']);
  }

  console.log('4. The Eat tab — the guarded remainder, when the day has earned it');
  const today = todayISODate();
  {
    setNutritionTargets(db, {
      effective_date: today,
      kcal: 2400,
      protein_g: 180,
      carbs_g: 240,
      fat_g: 70,
    });
    logMeal(db, {
      date: today,
      time: '08:30',
      name: 'Protein oats',
      kcal: 620,
      protein_g: 42,
      carbs_g: 68,
      fat_g: 20,
    });
    logMeal(db, {
      date: today,
      time: '12:40',
      name: 'Salmon + lentils',
      kcal: 740,
      protein_g: 46,
      carbs_g: 62,
      fat_g: 33,
    });

    const html = render('nutrition hub (guarded)', NutritionScreen);
    expect('nutrition hub (guarded)', html, [
      'kcal left', // 2,400 − 1,360 = 1,040
      '1,040',
      'Protein left', // the cell label carries the mode
      '1,360 of 2,400 kcal', // the corner note the hero was subtracted from
      'Eaten today',
      '1,360 kcal', // and the ledger sums to the same figure
      'Protein oats',
      'Salmon + lentils',
    ]);
    // The setup affordance retires the moment it is satisfied.
    refute('nutrition hub (guarded)', html, ['Set daily targets', 'no targets set']);
  }

  console.log('5. The Eat tab — the fallback, when a meal has no numbers');
  {
    logMeal(db, {
      date: today,
      time: '19:05',
      name: 'Dinner out',
      kcal: null,
      protein_g: null,
      carbs_g: null,
      fat_g: null,
    });

    const html = render('nutrition hub (fallback)', NutritionScreen);
    expect('nutrition hub (fallback)', html, [
      'One meal is not fully counted for energy, protein, carbs or fat',
      'what is left of today is not known',
      'Nothing recorded — tap to fill it in', // the same fact, stated on the row
      '1,360 of 2,400 kcal', // the eaten reading, denominator intact
    ]);
    // THE POINT OF THE GUARD: no remainder is drawn on a day it cannot compute.
    refute('nutrition hub (fallback)', html, ['kcal left', 'Protein left']);
  }

  console.log('6. Both routes of the same file still render');
  {
    // The tab root is a PROP now, not global route state — app/(tabs)/eat.tsx
    // renders <NutritionScreen asTab />, so that is what this renders.
    const tabRoot = render('nutrition hub (tab root)', NutritionScreen, {}, { asTab: true });
    expect('nutrition hub (tab root)', tabRoot, [
      'Nutrition',
      // The two capture shortcuts (owner, 2026-08-14), promoted above the
      // chooser and given the accent on 2026-08-15. They stand in every state
      // of the tab, so they are asserted on the tab render.
      'Photograph a meal',
      'Describe a meal in words',
      'Other ways to log a meal', // the renamed chooser's spoken label
    ]);
    // The old label is GONE. "Log a meal" was the accent button's spoken label
    // and `Log` its visible word; the owner renamed it by name, so a silent
    // revert has to fail here rather than on the device.
    refute('nutrition hub (tab root)', tabRoot, ['Log a meal', '>Log<']);
    const pushed = render('nutrition hub (pushed)', NutritionScreen);
    expect('nutrition hub (pushed)', pushed, ['Nutrition']);
  }

  console.log('7. Edited shipped screens still render');
  {
    const detail = render('meal-detail', MealDetailScreen, { id: mealId });
    expect('meal-detail (+ Save as recipe)', detail, [
      'Render lunch',
      'Save as template',
      'Save as recipe',
      // The rename affordance (owner, 2026-08-15) sits in StackHeader's new
      // trailing slot, on the title it changes. Asserted by name — the owner
      // asked for this control, so a sweep that removes it fails here.
      'Rename',
      'Rename this meal',
    ]);
    // The editor is CLOSED on arrival: a rename is a deliberate act, and a
    // field sitting open under the title would look like the name is unsaved.
    refute('meal-detail', detail, ['Meal name', 'Stop renaming this meal']);

    // And the rename really writes — through the same repository call the
    // screen's Save uses, so the assertion covers the write and not a mock.
    updateMealName(db, mealId, 'Render lunch, corrected');
    const renamed = render('meal-detail (renamed)', MealDetailScreen, { id: mealId });
    expect('meal-detail (renamed)', renamed, [
      'Render lunch, corrected',
      'Render chicken', // the items are untouched by a rename
      '248', // ...and so are the totals derived from them (247.5 kcal, rounded)
    ]);
    updateMealName(db, mealId, 'Render lunch');
  }

  console.log('8. Check-off state renders');
  const milk = db.get(`SELECT id FROM grocery_items WHERE name = 'Milk'`);
  checkGroceryItem(db, milk.id);
  expect('grocery (with cart)', render('grocery (with cart)', GroceryScreen), ['In cart']);

  // -------------------------------------------------------------------------
  console.log('7b. The two CAPTURE screens — on this walk for the first time');
  {
    // Both used to `import { CameraView } from 'expo-camera'` at module scope,
    // which made them unloadable under node and therefore untestable. They now
    // go through the guarded seam (src/lib/media/camera.ts), so under node the
    // module is absent and each screen renders its ABSENT branch — which is
    // precisely the branch that has to be honest rather than a dead spinner.

    // a. The scanner, and the running list of recently logged barcodes
    //    (owner, 2026-08-14). `barcodeFood` was logged in the fixtures above.
    const scan = render('barcode-scan', BarcodeScanScreen);
    expect('barcode-scan', scan, [
      'Scan barcode',
      // The absence is a sentence, and it says the rest of the screen still works.
      'Scanning needs the next app build',
      'Anything below can still be logged',
      // THE FEATURE: name and brand, never the digits, and last time's portion.
      'Recently logged',
      'Render oat drink',
      'Oatly-ish',
      '250 g',
    ]);
    // A barcode number means nothing to a human, so the list never prints one;
    // and a food with no barcode is not on this list however recently it was
    // eaten — the query is narrowed to barcoded rows on purpose.
    refute('barcode-scan', scan, ['5060000000000', 'Render chicken']);

    // b. The estimator with no model key — unchanged behaviour, now covered.
    expect('meal-estimate (no key)', render('meal-estimate (no key)', MealEstimateScreen), [
      'Describe or snap',
      'AI meal estimation needs a model key',
    ]);

    // c. With a key, the input phase — and `start=camera` (the Eat tab's Photo
    //    button) opening straight into the viewfinder. The key is an in-memory
    //    placeholder; rendering makes no model call, and none is made here.
    await apiKeyStore.setKey('render-test-key');
    expect('meal-estimate (input)', render('meal-estimate (input)', MealEstimateScreen), [
      'Describe the meal',
      'Take a photo',
      'Choose a photo',
    ]);
    const straightToCamera = render('meal-estimate (start=camera)', MealEstimateScreen, {
      start: 'camera',
    });
    expect('meal-estimate (start=camera)', straightToCamera, [
      // The camera phase, entered from the param rather than from a tap.
      'The camera needs the next app build',
      'Describe it instead',
    ]);
    // Never the spinner: `permission` stays null forever without the module, so
    // "Preparing the camera…" here would be a lie that never resolves.
    refute('meal-estimate (start=camera)', straightToCamera, ['Preparing the camera']);
    await apiKeyStore.clearKey();

    // d. HOME — regression cover for the safe-area round, which rewrapped
    //    src/components/home/mode-control.tsx. This is as close as a server
    //    render gets: RN's `Modal` returns null while `visible` is false, so the
    //    picker's BODY (and every other modal's) cannot be rendered here at all
    //    — nothing can set the flag. What this does prove is that the mode chip
    //    and banner still mount around the rewrapped modal.
    expect('home (after the ModalScreen rewrap)', render('home', HomeScreen), ['Today']);
  }

  // -------------------------------------------------------------------------
  console.log('8b. Folders (0035) — the filter strip, the drawer, and the unfiled place');
  {
    const dinners = createFolder(db, 'Dinners');
    moveRecipeToFolder(db, adobo, dinners);

    const book = render('recipes (with folders)', RecipesScreen);
    expect('recipes (with folders)', book, [
      'Folders',
      'Dinners',
      'Unfiled', // the draft recipe is still in no folder, so the chip is drawn
      'Manage',
      'Chicken Adobo',
      'Mystery stew',
    ]);
    // The strip is a FILTER, never an editor: nothing destructive may appear
    // on the book, or a scoping tap and a deleting tap share a row.
    refute('recipes (with folders)', book, ['Delete folder', 'Confirm delete']);

    // Scoped by the route param the folders screen pushes with.
    const scoped = render('recipes (scoped)', RecipesScreen, { folder: dinners });
    expect('recipes (scoped)', scoped, ['Chicken Adobo']);
    refute('recipes (scoped)', scoped, ['Mystery stew']);

    expect('recipe-folders (populated)', render('recipe-folders', RecipeFoldersScreen), [
      'Dinners',
      '1 recipe',
      'recipe is unfiled', // "Unfiled is a place, not a backlog"
    ]);

    // A filed recipe says where it lives; an unfiled one says so too.
    expect(
      'recipe-detail (filed)',
      render('recipe-detail (filed)', RecipeDetailScreen, { id: adobo }),
      ['Dinners', 'Edit in words']
    );
    expect(
      'recipe-detail (unfiled)',
      render('recipe-detail (unfiled)', RecipeDetailScreen, { id: draft }),
      ['Unfiled']
    );
  }

  console.log('8c. recipe-revise — the honest no-key state, and the recipe it is about');
  {
    // No model key exists under node, so the screen must say what is missing
    // rather than drawing a field that cannot work.
    const html = render('recipe-revise (no key)', RecipeReviseScreen, { id: adobo });
    expect('recipe-revise (no key)', html, [
      'Edit in words',
      'needs a model key',
      'Settings › Coach',
    ]);
    // And nothing may look like a write is pending.
    refute('recipe-revise (no key)', html, ['Save changes', 'Apply']);
  }

  // -------------------------------------------------------------------------
  // The body figure (contoured rewrite, 2026-08-12 — the third round). What a
  // server render CAN prove about a drawing is narrow, but it is exactly the
  // part that keeps failing: the figure's ~490 positioned views cost nothing to
  // VoiceOver, so the whole burden of saying WHICH muscle is in WHICH state
  // falls on words — the roll call, the section tally, and the ramp's two named
  // ends. Those are text, so they are assertable here. Everything about how it
  // LOOKS stays an on-device check (memory: verify on device, not web).
  console.log('9. Muscle freshness — the figure key states its case in words');
  {
    const empty = render('exercise hub (never trained)', ExerciseScreen);
    expect('exercise hub (never trained)', empty, [
      'Muscle freshness',
      '16 of 16 fresh',
      // The scale beside the figure names both ends. A continuous opacity ramp
      // with no stated direction is a ramp anyone can read backwards.
      'Fresh',
      'Spent',
      // Empty is AUTHORED, never blank — and "nothing logged" is not the same
      // fact as "nothing depleted", which the model renders identically.
      'No sessions logged yet, so every muscle reads fresh.',
    ]);

    logWorkout(
      db,
      { date: today, name: 'Render push', kind: 'strength', notes: null },
      Array.from({ length: 6 }, () => ({
        exercise: 'Bench',
        exerciseId: 'barbell-bench-press',
        reps: 8,
        weightKg: 80,
      }))
    );

    const worked = render('exercise hub (after a session)', ExerciseScreen);
    figureDrew('exercise hub', worked);
    expect('exercise hub (after a session)', worked, [
      'Fatigued', // the WORD is the primary carrier: the two fills are 1.03:1
      'Chest', // ...and the muscle is NAMED, which the old figure never did
    ]);
    // The tally moved off 16/16, and the never-logged caveat retired with it.
    refute('exercise hub (after a session)', worked, [
      '16 of 16 fresh',
      'No sessions logged yet, so every muscle reads fresh.',
    ]);

    const pushed = render('muscle-freshness', MuscleFreshnessScreen);
    figureDrew('muscle-freshness', pushed);
    expect('muscle-freshness (pushed)', pushed, [
      'Muscle freshness',
      'Per muscle',
      'Fatigued',
      'Chest',
    ]);
    // Nothing is hand-set yet, so nothing claims to be.
    refute('muscle-freshness (pushed)', pushed, ['Set by hand']);

    // An asserted number and a derived one must not wear the same face
    // (the rule `resolved_by` applies to recipe lines, 0034). Anchor a muscle
    // and the row says so — 0037's whole visible contract.
    setMuscleAnchor(db, 'calves', 20);
    const anchored = render('muscle-freshness (hand-set)', MuscleFreshnessScreen);
    expect('muscle-freshness (hand-set)', anchored, ['Set by hand', 'Calves']);
    clearMuscleAnchor(db, 'calves');
    refute(
      'muscle-freshness (cleared)',
      render('muscle-freshness (cleared)', MuscleFreshnessScreen),
      ['Set by hand']
    );

    // exercise-detail is the figure's ONLY `mode: 'muscles'` consumer, and the
    // one screen in this area carrying a design firewall: which muscles a
    // MOVEMENT works is a fact about an exercise, never a biological state, so
    // it must never wear the signal green (00-design-spec.md §2). It joined the
    // walk on 2026-08-25 — see db/render-stubs/exercise-images.mjs for the
    // static-require blocker that had kept it off.
    const detail = render('exercise detail', ExerciseDetailScreen, { id: 'barbell-bench-press' });
    figureDrew('exercise detail', detail);
    expect('exercise detail', detail, ['Muscles worked', 'Primary', 'Assists', 'Chest']);
    // The firewall, asserted rather than asserted-about: the freshness green
    // must not appear anywhere in this screen's markup.
    refute('exercise detail', detail, ['#185A36', '#185a36']);
  }

  // -------------------------------------------------------------------------
  // The execution record with a real, YOUNG record behind it — the state a
  // brand-new install is actually in, and the one the standing rule is about:
  // three days of history must SAY three days, not draw a fortnight of nothing.
  //
  // The fixture is deliberately lopsided: one protocol item done every day, one
  // never done. That is the shape the screen exists to name — a protocol whose
  // items are not getting done is a protocol to change.
  console.log('10. Mission — the execution record behind Data’s Mission row');
  {
    const day = (n) => {
      const d = new Date();
      d.setDate(d.getDate() - n);
      return todayISODate(d);
    };
    const settledDays = [day(3), day(2), day(1)];

    createProtocolWithVersion(
      db,
      { name: 'Morning stack', type: 'supplement_stack' },
      {
        items: [
          { title: 'Creatine', scheduled_time: '07:00', dose: '5 g', notes: null },
          { title: 'Magnesium', scheduled_time: '21:00', dose: '400 mg', notes: null },
        ],
      }
    );
    for (const date of [...settledDays, today]) generateMissionForDay(db, date);

    const idsOn = (date) =>
      new Map(
        db
          .all(
            `SELECT e.id, e.title FROM log_entries e
               JOIN daily_logs d ON d.id = e.daily_log_id
              WHERE d.date = ?`,
            [date]
          )
          .map((r) => [r.title, r.id])
      );
    // Creatine every day, Magnesium never — including today, which is still
    // open and must therefore not be judged.
    for (const date of [...settledDays, today]) {
      setMissionStatus(db, idsOn(date).get('Creatine'), 'completed');
    }

    const young = render('mission-history (4-day record)', MissionHistoryScreen);
    expect('mission-history (4-day record)', young, [
      '50%', // 3 of 6 over the three days that are OVER
      'of 6 planned',
      '3 done', // the ledger sums to the denominator beside the rate
      '0 skipped',
      '3 untouched',
      '4 days on record', // the record's true extent, stated
      'too little to read as a trend', // ...and disclaimed, because it is 3 days
      'Judged ', // the window the rate is over, stated
      '3 finished days', // ...and the section that shares it
      'Morning stack', // the source, worst first
      '3 missed', // every figure on that plate is framed as a miss
      'of 6 planned',
      'Magnesium', // its worst item, named
      '3 of 3 missed',
      'today, still open', // today is on the record but is not judged
    ]);
    // Today has 2 planned and 1 done. If today were folded into the rate it
    // would read 4 of 8 = 50%… identical here by coincidence, which is exactly
    // why the DENOMINATOR is the assertion: 6, never 8.
    refute('mission-history (4-day record)', young, [
      'of 8 planned',
      'Nothing was missed',
      '0 of 0',
    ]);

    // Now do the missing item on every settled day. "Nothing was missed" and
    // "nothing was ever planned" are different facts and must not render
    // alike — this is the same pair the codebase has confused twice before.
    for (const date of settledDays) {
      setMissionStatus(db, idsOn(date).get('Magnesium'), 'completed');
    }
    const clean = render('mission-history (all done)', MissionHistoryScreen);
    expect('mission-history (all done)', clean, [
      '100%',
      'Nothing was missed. All 6 planned items were completed.',
    ]);
    refute('mission-history (all done)', clean, [
      '3 missed',
      'No mission has been planned yet', // the never-planned sentence, which is a different fact
    ]);
  }
}

// ---------------------------------------------------------------------------
// Progress photos (0036, docs/progress-photos-subapp.md). The point of walking
// these four through a real render is the degradation ledger: under node there
// is no expo-image-picker, no expo-file-system and no model key, which is
// EXACTLY the state of the owner's current binary. Every one of those absences
// has to be a sentence on the screen rather than a crash or a dead control.
{
  console.log('11. Progress photos — empty, populated, and honestly degraded');

  expect('progress photos (empty)', render('progress photos (empty)', ProgressPhotosScreen), [
    'Progress photos',
    'Bring in your progress photos',
    'No photos yet',
    // The picker is not in this binary: the control is disabled and says why.
    'rides the next app build',
  ]);
  refute('progress photos (empty)', render('progress photos (empty)', ProgressPhotosScreen), [
    // Nothing may claim a tally before there is anything to tally.
    'photos · ',
  ]);

  expect('progress photo add', render('progress photo add', ProgressPhotoAddScreen), [
    'Add photos',
    'From your library',
    'Choose photos',
    'not today',
  ]);

  // Fixtures through the REAL store seam, with an in-memory file system.
  const photoFiles = new Map();
  const fakeStore = {
    list: () => [...photoFiles.keys()],
    exists: (name) => photoFiles.has(name),
    remove: (name) => {
      photoFiles.delete(name);
      return true;
    },
    write: (name, bytes) => {
      photoFiles.set(name, bytes);
      return true;
    },
    uri: (name) => (photoFiles.has(name) ? `file:///documents/progress-photos/${name}` : null),
  };
  const photoIds = importProgressPhotos(
    db,
    [
      { taken_on: '2026-01-12', pose: 'front', workingBase64Jpeg: '/9j/jan' },
      { taken_on: '2026-08-09', pose: 'front', workingBase64Jpeg: '/9j/aug' },
      { taken_on: '2026-08-09', pose: 'side', workingBase64Jpeg: '/9j/augside' },
    ],
    fakeStore
  );
  ok('progress photo fixtures seeded through the real store');

  const gallery = render('progress photos (populated)', ProgressPhotosScreen);
  expect('progress photos (populated)', gallery, [
    'August 2026',
    'January 2026',
    '2 photos · 2 poses',
    '1 photo · 1 pose',
    'Compare',
    'Front',
    'Side',
    // No expo-file-system under node, so every cell resolves to no URI — and
    // draws the authored state rather than a broken frame.
    'Not on this phone',
  ]);

  expect(
    'progress photo detail',
    render('progress photo detail', ProgressPhotoDetailScreen, { id: photoIds[1] }),
    [
      '9 Aug 2026',
      'Details',
      'Taken on',
      'Pose',
      'Important',
      // No weigh-in exists near that date in this fixture DB.
      'no weigh-in near this date',
      // No model key under node: the reading affordance is a sentence, not a button.
      'needs a model key',
      'Delete photo',
      // The honest retro-flag caveat is on the row that could mislead.
      'at import time',
      // Provenance is the PERSISTED fact, not a guess from `taken_at`.
      'Set by you.',
    ]
  );

  // THE HONESTY CASE THE SWEEP IS BUILT TO PRODUCE: a row that claims a
  // full-size original whose file did not come across. The screen must not say
  // "a full-size original is kept inside ARC" directly beneath "Image not on
  // this phone". Under node there is no file system at all, so every row is in
  // exactly this state — which makes it the cheapest possible assertion and the
  // one whose absence let the bug ship.
  db.run('UPDATE progress_photos SET original_file_name = ?, is_important = 1 WHERE id = ?', [
    'orphaned-original.jpg',
    photoIds[0],
  ]);
  const orphaned = render('progress photo detail (no files)', ProgressPhotoDetailScreen, {
    id: photoIds[0],
  });
  expect('progress photo detail (no files)', orphaned, [
    'Image not on this phone.',
    'isn’t on this phone either',
  ]);
  refute('progress photo detail (no files)', orphaned, [
    'A full-size original is kept inside ARC for this one.',
  ]);
  expect(
    'progress photo detail (missing id)',
    render('progress photo detail (missing)', ProgressPhotoDetailScreen, { id: 'nope' }),
    ['This photo is gone.']
  );

  expect(
    'progress photo compare',
    render('progress photo compare', ProgressPhotoCompareScreen, {
      a: photoIds[0],
      b: photoIds[1],
    }),
    [
      'Compare',
      '12 Jan 2026',
      '9 Aug 2026',
      'days apart',
      'both front',
      'Compare against',
      'no weigh-in near this date',
    ]
  );

  // The weigh-in caption, with its distance — the claim the whole compare
  // surface rests on. A weigh-in two days after the January photo must print
  // that distance, not just a number.
  //
  // 84.2 kg renders as **185.6 lb** because DEFAULT_UNIT_PREFERENCES.weight is
  // 'lb' and this surface goes through the same resolveDisplay/formatMeasured
  // pair as every other measured value in the app. Asserting the converted
  // figure is the point: a photo caption that hard-coded "kg" would be the one
  // number on the phone that ignored the owner's unit choice.
  db.run('INSERT INTO body_metrics (id, measured_at, weight_kg, source) VALUES (?, ?, ?, ?)', [
    'render-weigh-1',
    '2026-01-14T07:00:00.000Z',
    84.2,
    'manual',
  ]);
  expect(
    'progress photo compare (with a weigh-in)',
    render('progress photo compare (weighed)', ProgressPhotoCompareScreen, {
      a: photoIds[0],
      b: photoIds[1],
    }),
    ['185.6 lb', 'weighed 2 days later']
  );
}

{
  console.log('12. The knowledge base (0038, docs/knowledge-subapp.md)');

  // Before the pack: the hub is honest that the reference has not loaded, and
  // the "your entries" empty is AUTHORED rather than blank.
  const cold = render('knowledge hub (cold)', KnowledgeScreen);
  expect('knowledge hub (cold)', cold, [
    'Knowledge',
    'Import an article',
    'Your entries',
    'Nothing of your own yet',
    'ARC reference',
  ]);

  ingestCorpus(db);
  const withPack = render('knowledge hub (pack loaded)', KnowledgeScreen);
  expect('knowledge hub (pack loaded)', withPack, [
    // Grouped by topic, the labs category-plate model.
    'Cardiovascular',
    'Supplements',
    'ApoB is ARC',
  ]);
  // The pack ships, so the screen is never globally empty — the first-run state
  // is a reading, not a void.
  refute('knowledge hub (pack loaded)', withPack, ['ARC’s reference hasn’t loaded yet']);

  const entryId = saveKnowledgeEntry(db, {
    title: 'Render entry: my own magnesium stance',
    topic: 'supplements',
    body:
      'Glycinate over citrate, at 300 mg, taken with the evening meal.\n\n' +
      'Citrate is notably laxative at the doses people actually take it at, which is the ' +
      'whole reason the form matters more than the milligrams here.',
  });
  const withEntry = render('knowledge hub (with an entry)', KnowledgeScreen);
  expect('knowledge hub (with an entry)', withEntry, [
    'Render entry: my own magnesium stance',
    'written by you', // provenance, from the shared provenanceLine
  ]);
  refute('knowledge hub (with an entry)', withEntry, ['Nothing of your own yet']);

  // The reader, both kinds behind one route.
  expect(
    'knowledge-entry (user entry)',
    render('knowledge-entry (user entry)', KnowledgeEntryScreen, {
      id: entryId,
      kind: 'entry',
    }),
    [
      'Your entry',
      'Render entry: my own magnesium stance',
      'Written by you · since',
      'Edit',
      'Archive',
    ]
  );

  const packId = db.get(
    `SELECT id FROM knowledge_chunks WHERE source = 'arc-longevity-v1' ORDER BY chunk_index LIMIT 1`
  ).id;
  const packRead = render('knowledge-entry (pack)', KnowledgeEntryScreen, {
    id: packId,
    kind: 'pack',
  });
  expect('knowledge-entry (pack)', packRead, [
    'ARC reference',
    'Part of ARC’s shipped reference',
    'Write your own entry on this topic',
  ]);
  // Pack entries are read-only, decisively — a version bump would eat any edit.
  refute('knowledge-entry (pack)', packRead, ['Archive']);

  expect(
    'knowledge-entry (deleted id)',
    render('knowledge-entry (deleted id)', KnowledgeEntryScreen, { id: 'nope', kind: 'entry' }),
    ['That entry is no longer here']
  );

  expect(
    'knowledge-entry-edit (new)',
    render('knowledge-entry-edit (new)', KnowledgeEntryEditScreen),
    [
      'Write an entry',
      'Topic',
      'supplements', // the vocabulary chips
      'Save entry',
    ]
  );
  expect(
    'knowledge-entry-edit (editing)',
    render('knowledge-entry-edit (editing)', KnowledgeEntryEditScreen, { id: entryId }),
    ['Edit entry', 'Save changes']
  );

  expect('knowledge-import', render('knowledge-import', KnowledgeImportScreen), [
    'Import an article',
    'From a link',
    'Paste the text',
    // Honest no-key state under node — and the manual floor is still offered.
    'Reading an article needs a model key',
    'Write it yourself',
  ]);
}

{
  console.log('13. Reports (docs/reports-subapp.md, migration 0039');

  // a. The index, before anything has been generated.
  const emptyReports = render('reports (empty)', ReportsScreen);
  expect('reports (empty)', emptyReports, [
    'Reports',
    'Self-review',
    'Doctor visit pack',
    // Empty is AUTHORED — it says what a report IS, not "no data".
    'Nothing generated yet. A report is a document',
    // The pointer to export's real home, not a second export button.
    'lives in Settings › Security &amp; data',
  ]);
  // ⚑ MATT #4: the export ACTION does not live here.
  refute('reports (empty)', emptyReports, ['Export data', 'Reports & export']);

  // b. A draft self-review over a real period, assembled for real.
  const period = {
    kind: 'self_review',
    periodKind: 'custom',
    start: '2026-08-01',
    end: '2026-08-07',
  };
  const draft = render('report-view (draft self-review)', ReportViewScreen, period);
  expect('report-view (draft self-review)', draft, [
    'Draft report',
    'Custom range',
    '1 – 7 Aug 2026',
    'Adherence',
    'Sleep &amp; recovery',
    'What changed',
    // The one accent in the flow.
    'Save &amp; share',
    // The honesty rules, printed.
    'days in this period carry at least one logged entry',
    'not a medical record',
  ]);
  // The tripwires the HTML renderer is held to apply to the native one too.
  refute('report-view (draft self-review)', draft, ['undefined', 'NaN', '[object']);

  // c. The doctor pack, on a database with no profile: authored blanks and a
  //    warning BEFORE the document, never a guess.
  const pack = render('report-view (doctor pack)', ReportViewScreen, { kind: 'doctor_pack' });
  expect('report-view (doctor pack)', pack, [
    'Doctor visit pack',
    'Missing from your profile',
    'Current regimen',
    'Laboratory results',
    'tracked markers measured',
    // The two absences a clinician looks for, stated rather than left blank.
    'does not record blood pressure',
    'no BMI',
  ]);
  // NO MODEL SURFACE on the clinical document, ever.
  refute('report-view (doctor pack)', pack, ["Add Coach's read", 'undefined', 'NaN', '[object']);

  // d. A malformed range is a dead end with an authored explanation, not a crash.
  expect(
    'report-view (bad range)',
    render('report-view (bad range)', ReportViewScreen, {
      kind: 'self_review',
      periodKind: 'custom',
      start: 'nonsense',
      end: '2026-08-07',
    }),
    ['the range it was asked for is not a real one']
  );

  // e. A PERSISTED report re-renders from its snapshot, not from a re-assembly.
  const stored = assembleSelfReview(db, periodFromBounds('last_week', '2026-08-03', '2026-08-09'), {
    appVersion: '0.2.0',
  });
  const storedId = insertReport(db, {
    data: stored,
    read: null,
    fileName: 'arc-report-self-review-20260812-143308.html',
    filePath: 'reports/arc-report-self-review-20260812-143308.html',
  });
  expect(
    'report-view (persisted)',
    render('report-view (persisted)', ReportViewScreen, { id: storedId }),
    [
      'Last week',
      '3 – 9 Aug 2026',
      // A saved report offers the file again rather than a second save.
      'Share again',
    ]
  );

  // f. The history now has a row, and the Data tab's index row carries it.
  expect('reports (with history)', render('reports (with history)', ReportsScreen), [
    'Self-review',
    '3 – 9 Aug 2026',
  ]);

  const dataTab = render('data tab', DataScreen);
  expect('data tab', dataTab, [
    'The full file',
    // The relabel (⚑ MATT #4) and the row's LIVE state — the thing that makes
    // this row a reading rather than another index entry.
    '1 report · last ',
  ]);
  refute('data tab', dataTab, ['Reports &amp; export', 'Reports & export']);
}

// ---------------------------------------------------------------------------
// 14. The water record — the one screen that tracks, LOGS and EDITS a metric.
//
// Its never-logged state is asserted up in §0, before any fixture exists. What
// is left is the pair this codebase keeps confusing: a YOUNG record that must
// say it is young, and a full one that may finally state a trend. Water is
// stored one row per capture (db/water.test.mjs §1), which is the fact that
// makes the Entries block — and therefore "edit" — expressible at all.
{
  console.log('14. Water — track, log and edit');
  const db = getDb();
  const now = todayISODate();
  const day = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return todayISODate(d);
  };

  // Three days of record, two captures today. Deliberately under TREND_FLOOR.
  logWater(db, day(2), 500);
  logWater(db, day(1), 750);
  logWater(db, now, 500);
  logWater(db, now, 250);

  const young = render('water (3-day record)', WaterScreen);
  expect('water (3-day record)', young, [
    'Water',
    '3 days on record', // the record's true extent, stated...
    'too little to read as a trend', // ...and disclaimed, because it is 3 days
    'By day', // the record itself
    'Entries', // the editable half
    '2 entries', // today's two captures, counted
    'today, still open',
  ]);
  // 750 ml is 25 oz and the default unit is oz, so the day rows read in oz.
  // Nothing may print a stand-in zero for the eleven days with no capture, and
  // with no goal set there is still no denominator anywhere.
  refute('water (3-day record)', young, [
    'No water logged yet', // there IS a record now — a different fact
    'of goal',
    '0 oz',
    'No water yet', // the stamp retires the moment a record exists
  ]);

  // A goal turns the denominator on — and ONLY a goal does. 100 oz ≈ 2957 ml.
  setWaterTarget(db, 2957);
  const withGoal = render('water (with goal)', WaterScreen);
  expect('water (with goal)', withGoal, [
    'of 100 oz', // the denominator the user chose, in the user's unit
    '% of goal',
  ]);
  refute('water (with goal)', withGoal, ['None set']);

  // Eleven more days, taking the record past TREND_FLOOR: the disclaimer must
  // retire on its own rather than becoming permanent furniture.
  for (let n = 3; n <= 13; n++) logWater(db, day(n), 500);
  const full = render('water (14-day record)', WaterScreen);
  expect('water (14-day record)', full, ['14 days on record', 'average', '14 of 14 days logged']);
  refute('water (14-day record)', full, ['too little to read as a trend']);

  // ---------------------------------------------------------------------
  // The Data tab now carries a Water trend row — and no longer carries a
  // single "Set up" box (owner, 2026-08-14). The chips were never controls,
  // so their removal strands nothing; this is what keeps them removed.
  const dataWithWater = render('data tab (water + no chips)', DataScreen);
  expect('data tab (water + no chips)', dataWithWater, [
    'Water',
    'Intake today',
    // The tally counts the very array it renders, so the denominator proves
    // Water joined the strip. The NUMERATOR is deliberately not asserted: it
    // counts whichever domains happen to be populated by this point in the
    // shared fixture DB, which is a fact about test ordering, not about Water.
    ' of 6 tracked',
  ]);
  refute('data tab (water + no chips)', dataWithWater, ['Set up', 'Later']);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
