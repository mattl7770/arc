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
import { readFileSync } from 'node:fs';

import React from 'react';
import { renderToString } from 'react-dom/server';

import { selectAllOnFocus } from '../src/components/ui/select-on-focus.ts';

import { __setParams } from './render-stubs/expo-router.mjs';
import { getDb } from './render-stubs/db-client.mjs';

import { shiftISODate, todayISODate } from '../src/lib/db/date.ts';
import { dayPhrase } from '../src/lib/utils/day-cursor.ts';
import { estimateServings } from '../src/lib/recipes/servings.ts';
import { createFood, setFoodFavorite } from '../src/lib/db/repositories/foods.ts';

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
import { clearWorkoutDraft, saveWorkoutDraft } from '../src/lib/db/repositories/workout-drafts.ts';
import { DRAFT_VERSION } from '../src/lib/exercise/draft.ts';
import { importProgressPhotos } from '../src/lib/media/progress-photo-store.ts';
import { addVersion, createProtocolWithVersion } from '../src/lib/db/repositories/protocols.ts';
import { generateMissionForDay } from '../src/lib/db/repositories/mission-generate.ts';
import { setMissionStatus } from '../src/lib/db/repositories/mission.ts';
import { clearMuscleAnchor, setMuscleAnchor } from '../src/lib/db/repositories/muscle-anchors.ts';
import { upsertWearableRows } from '../src/lib/db/repositories/wearables.ts';

import { ingestCorpus } from '../src/lib/rag/corpus.ts';
import { saveKnowledgeEntry } from '../src/lib/db/repositories/knowledge.ts';
import { forgetMemory, rememberFact } from '../src/lib/db/repositories/coach-memory.ts';

import ExerciseScreen from '../app/exercise.tsx';
import MissionHistoryScreen from '../app/mission-history.tsx';
import WaterScreen from '../app/water.tsx';
import MuscleFreshnessScreen from '../app/muscle-freshness.tsx';
import ExerciseDetailScreen from '../app/exercise-detail.tsx';
import RecipesScreen from '../app/recipes.tsx';
import RecipeDetailScreen from '../app/recipe-detail.tsx';
import RecipeEditScreen from '../app/recipe-edit.tsx';
import RecipeImportScreen, { ReviewDraft } from '../app/recipe-import.tsx';
import RecipeFoldersScreen from '../app/recipe-folders.tsx';
import RecipeReviseScreen from '../app/recipe-revise.tsx';
import GroceryScreen from '../app/grocery.tsx';
import NutritionScreen from '../app/nutrition.tsx';
import NutritionMicrosScreen from '../app/nutrition-micros.tsx';
import NutritionHistoryScreen from '../app/nutrition-history.tsx';
import MealDetailScreen from '../app/meal-detail.tsx';
// The two camera screens. They could not be imported here until `expo-camera`
// moved behind the guarded seam (src/lib/media/camera.ts) — a static native
// import is a resolve failure under node, not a render failure.
import BarcodeScanScreen from '../app/barcode-scan.tsx';
import MealEstimateScreen from '../app/meal-estimate.tsx';
import FoodNewScreen from '../app/food-new.tsx';
import FoodSearchScreen from '../app/food-search.tsx';
import { apiKeyStore } from '../src/lib/ai/api-key-store.ts';
import ProgressPhotosScreen from '../app/progress-photos.tsx';
import ProgressPhotoAddScreen from '../app/progress-photo-add.tsx';
import ProgressPhotoDetailScreen from '../app/progress-photo-detail.tsx';
import ProgressPhotoCompareScreen from '../app/progress-photo-compare.tsx';
import KnowledgeScreen from '../app/knowledge.tsx';
import KnowledgeEntryScreen from '../app/knowledge-entry.tsx';
import KnowledgeEntryEditScreen from '../app/knowledge-entry-edit.tsx';
import KnowledgeImportScreen from '../app/knowledge-import.tsx';
import CoachMemoryScreen from '../app/coach-memory.tsx';
import ReportsScreen from '../app/reports.tsx';
import ReportViewScreen from '../app/report-view.tsx';
import ProtocolsScreen from '../app/protocols.tsx';
import ProtocolDetailScreen from '../app/protocol-detail.tsx';
import ProtocolEditScreen from '../app/protocol-edit.tsx';
import ProtocolVersionsScreen from '../app/protocol-versions.tsx';
import DataScreen from '../app/(tabs)/data.tsx';
import HomeScreen from '../app/(tabs)/index.tsx';
import LogScreen from '../app/(tabs)/log.tsx';

import { logWater } from '../src/lib/db/repositories/water.ts';
import {
  setHealthSyncEnabled,
  setUnitPreference,
  setWaterTarget,
} from '../src/lib/db/repositories/user.ts';
import { setHealthSyncLog } from '../src/lib/db/repositories/wearables.ts';
import SettingsHealthScreen from '../app/settings-health.tsx';
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

/**
 * **Every number pad on the screen has a way out.**
 *
 * iOS number pads have no return key, so a `TextInput` whose `keyboardType` is
 * `number-pad` / `decimal-pad` / `numeric` traps the keyboard unless
 * `returnKeyType` is set — that prop is the whole trigger for the native Done
 * toolbar RN builds over those keyboards (the mechanism, and why it looks like
 * dead code at a call site, is documented in src/components/ui/keyboard.ts).
 * The owner hit this on the water goal: *"you cant close the keyboard so its
 * impossible to actually put a number in."*
 *
 * react-native-web translates the pair faithfully — `keyboardType` becomes
 * `inputMode="numeric"|"decimal"` and `returnKeyType` becomes `enterKeyHint` —
 * so the rule is checkable in the rendered markup, on every screen this suite
 * walks, without naming any of them. `numbers-and-punctuation` and `url` fields
 * emit no `inputMode` and are correctly ignored: those keyboards have a return
 * key already.
 *
 * What it CANNOT establish: that the toolbar actually appears, or that the field
 * is visible while you type (that half is the scroll container's keyboard inset
 * — {@link Screen}). Both are device facts. Nor does it see a field behind an
 * interaction: the water goal editor and the per-entry editor only mount after a
 * tap, so what is proved here for app/water.tsx is the Add field.
 */
function findKeypads(html) {
  const all = (html.match(/<input[^>]*>/g) || []).filter((tag) =>
    /inputMode="(numeric|decimal)"/.test(tag)
  );
  return { all, stuck: all.filter((tag) => !tag.includes('enterKeyHint=')) };
}

/** How many number pads the whole walk has seen — so a silently vacuous check
 *  (a regex that stopped matching anything at all) fails at the end. */
let keypadsSeen = 0;

function keypadsDismissable(name, html) {
  const { all, stuck } = findKeypads(html);
  if (all.length === 0) return;
  keypadsSeen += all.length;
  stuck.length === 0
    ? ok(`${name}: all ${all.length} number pad(s) can be dismissed`)
    : bad(
        `${name}: ${stuck.length} of ${all.length} number pad(s) have no Done key`,
        stuck[0].slice(0, 140)
      );
}

/** Render a screen to HTML; a throw anywhere in the tree is a failure. */
function render(name, Component, params = {}, props = {}) {
  __setParams(params);
  try {
    const html = renderToString(React.createElement(Component, props));
    keypadsDismissable(name, html);
    return html;
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

/**
 * The C6 progress bars, read out of the markup.
 *
 * NativeWind's className is a babel transform that does not run here, so colour
 * is invisible in a server render — `bg-pine` and `bg-ink-secondary` both come
 * out as the same empty `<div>`. What IS visible is the two things the bar
 * computes: the fill's inline `style="width:N%"`, and whether the rail holds a
 * SECOND child, which is the terminator. Those are one-to-one with the state —
 * the fill reaches 100% exactly when `met` is true, which is exactly when the
 * terminator is drawn — so the pair pins the render even though the hue does
 * not survive. The hue and its contrast are asserted numerically in
 * db/nutrition-remaining.test.mjs §13; what only a device can judge is how much
 * pine four bars plus two buttons puts on one screen.
 *
 * The optional group cannot over-reach: when there is no terminator the next
 * characters after the fill are the rail's own closing tag, which does not match.
 */
function readBars(html) {
  const pattern =
    /<div class="css-view-g5y9jx" style="width:([\d.]+)%"><\/div>(<div class="css-view-g5y9jx"><\/div>)?/g;
  return [...html.matchAll(pattern)].map((m) => ({
    pct: Number(m[1]),
    terminator: m[2] !== undefined,
  }));
}

function barsDrawn(name, html, count, metCount) {
  if (html === null) return;
  const bars = readBars(html);
  bars.length === count
    ? ok(
        `${name}: ${count} progress bar(s) drawn (${bars.map((b) => `${b.pct.toFixed(0)}%`).join(' ')})`
      )
    : bad(`${name}: expected ${count} bars`, `found ${bars.length}`);
  const met = bars.filter((b) => b.terminator);
  met.length === metCount && met.every((b) => b.pct === 100)
    ? ok(`${name}: ${metCount} of them carry the terminator, each at the mark`)
    : bad(
        `${name}: expected ${metCount} terminator(s) at 100%`,
        JSON.stringify(bars.filter((b) => b.terminator || b.pct === 100))
      );
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

  // The Protocols sub-app on a database that has never held one. This has to
  // happen HERE, before any fixture creates a protocol: the empty hub is the
  // first screen a fresh install reaches from Home's mission area, and it is a
  // state the owner's own device can never show (their device has data).
  const emptyHub = render('protocols (empty)', ProtocolsScreen);
  expect('protocols (empty)', emptyHub, [
    'Protocols',
    'New protocol',
    'No protocols yet',
    // Both first-run routes: build it yourself, or have the Coach draft one.
    // There is deliberately no template library — the Coach is the template
    // engine, and it can read a record a canned "Morning Stack" cannot.
    'Ask the Coach to draft one',
  ]);
  // Nothing may claim a rate, a phase or a group on a database with none.
  // ("Running" itself is not refutable — the closing margin note says *running
  //  protocols build Today's Mission*, which is true of an empty hub too.)
  refute('protocols (empty)', emptyHub, [
    'Ended',
    'Paused',
    '0%',
    'no record yet',
    'no version yet',
  ]);

  expect(
    'protocol-detail (missing id)',
    render('protocol-detail (missing id)', ProtocolDetailScreen, { id: 'nope' }),
    ['This protocol no longer exists.']
  );
  expect(
    'protocol-versions (missing id)',
    render('protocol-versions (missing id)', ProtocolVersionsScreen, { id: 'nope' }),
    ['This protocol no longer exists.']
  );

  // The CREATE path — the one the owner reported as "boxes covering other
  // boxes", and the path where every field is empty so a collapsed wrapper is
  // total. It must open on ONE open-ended phase with no phase chrome at all.
  const newProtocol = render('protocol-edit (new)', ProtocolEditScreen);
  expect('protocol-edit (new)', newProtocol, [
    'New Protocol',
    'Items',
    'Add item',
    'Add a phase',
    'Every day', // the cadence control, collapsed, stating the default
    'Create protocol',
  ]);
  refute('protocol-edit (new)', newProtocol, [
    'Phase 1', // no phase chrome until a second phase exists
    'Save as', // that is the edit path's label
    'Delete protocol',
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

  // The Log tab's Water tile with nothing to learn from — and this render, like
  // the two above, only exists here. `usualWaterAmount` returns null on an empty
  // record and the tile falls back to the Glass literal, which is the state the
  // owner will actually see on day one. The number has to be ON THE FACE: a
  // tile that commits and looks like its three navigating neighbours is the one
  // failure mode this design has (src/components/log/quick-add-grid.tsx).
  const freshLog = render('log tab (no water on record)', LogScreen);
  expect('log tab (no water on record)', freshLog, [
    'Quick add',
    'Supplement',
    'Water',
    'Weight',
    'Therapy',
    '+8 oz', // the Glass literal, printed in mono on the tile's own face
    // The label must say the amount AND that the tap commits — "Water" alone
    // would describe a door, which this tile no longer is.
    'Log water, 8 oz',
    'Nothing logged yet today.',
  ]);

  // A long-press is invisible to VoiceOver, so the other amounts have to be
  // exposed as a real ACTION and not only as a gesture. Neither
  // `accessibilityHint` nor `accessibilityActions` survives react-native-web —
  // RNW drops both — so this is the only place the pair is checkable headlessly,
  // and a source scan is honest about being one. The device check stays the
  // VoiceOver pass in docs/wearables-subapp.md's on-device list.
  {
    const tile = readFileSync(
      new URL('../src/components/log/quick-add-grid.tsx', import.meta.url),
      'utf8'
    );
    /accessibilityHint=/.test(tile) &&
    /accessibilityActions=\{\[\{ name: 'longpress'/.test(tile) &&
    /onAccessibilityAction=/.test(tile)
      ? ok('the Water tile exposes its long-press as a VoiceOver action, not only as a gesture')
      : bad('the long-press is gesture-only — undiscoverable to VoiceOver');
  }
  // The amounts are BEHIND the long-press: they must not be on the sheet until
  // the gesture opens them, or the block is five controls tall at rest. (A
  // server render runs no effects and simulates no taps, so their absence here
  // is exactly the closed state.) Nor may the tile carry a chevron — that mark
  // means "this pushes a screen", and this one does not.
  refute('log tab (no water on record)', freshLog, ['Other…', 'Keypad', 'Logged 8 oz']);

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
    // All four 0031 provenance columns, because since 2026-09-14 the detail
    // screen READS them (A6): the source line is a link, and the og:image is
    // drawn when the recipe has no photo of its own.
    source_url: 'https://www.instagram.com/reel/RENDER1/',
    source_platform: 'instagram',
    source_author: 'renderchef',
    source_image_url: 'https://scontent.cdninstagram.com/v/render.jpg',
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
    items: [
      { food_id: chicken, name: 'Render chicken', amount: 150, kcal: 247.5, protein_g: 46.5 },
    ],
  });

  // A BARCODED food, logged — the two facts the scanner's running list joins
  // (§7b). `Render chicken` above is deliberately left barcode-less, so the
  // list's narrowing is proved by an exclusion and not only by an inclusion.
  // …and it is a DRINK (0047), so the running list is also where a millilitre
  // portion has to survive a real render — including through the oz preference.
  const oatDrink = createFood(db, {
    name: 'Render oat drink',
    brand: 'Oatly-ish',
    barcode: '5060000000000',
    basis: 'ml',
    kcal_100g: 46,
    protein_g_100g: 1,
    carbs_g_100g: 6.7,
    fat_g_100g: 1.5,
  });
  logMealWithItems(db, {
    date: '2026-08-08',
    time: '07:30',
    name: 'Render breakfast',
    items: [{ food_id: oatDrink, name: 'Render oat drink', amount: 250, unit: 'ml', kcal: 115 }],
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
  /**
   * A6 — the source line and the source photo, both READ from stored columns.
   *
   * 0031 has held `source_url` / `source_platform` / `source_author` /
   * `source_image_url` since the importer shipped, and the screen printed only
   * the last two, as dead text, with the raw enum ("instagram") after the
   * author. Now the line names the platform the way it names itself, the whole
   * line is a link, and the og:image is drawn because this fixture has no photo
   * of its own.
   */
  {
    const html = render('recipe-detail (source)', RecipeDetailScreen, { id: adobo });
    expect('recipe-detail (source)', html, [
      'Instagram · renderchef',
      'role="link"', // it is an affordance, not the dead text it used to be
      'Open the source of this recipe', // …and it says so out loud
      'Image from the source of Chicken Adobo', // the og:image frame mounted
      'From the source', // labelled, so the poster's still is never mistaken
    ]); //                   for a photo of the thing the owner cooked
    // (The URL itself is never printed — the line names the platform and the
    // author, which is what a reader can use. That `source_url` is what gets
    // opened, and that only http(s) ever is, is pinned in db/recipes.test.mjs
    // §20 against `isOpenableSourceUrl`; react-native-web puts an Image's URI
    // in a generated stylesheet rather than in the markup, so the frame is
    // asserted by its label.)
    // The raw enum must never reach the reader again.
    refute('recipe-detail (source)', html, ['· instagram', 'instagram · renderchef']);
    // The recipe with NO provenance draws no source chrome at all — the line is
    // absent, not an empty stand-in.
    refute(
      'recipe-detail (no source)',
      render('recipe-detail (no source)', RecipeDetailScreen, {
        id: draft,
      }),
      ['From the source', 'Open the source of this recipe']
    );
  }

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
    // C6, AND THE REGRESSION IT FIXES: this is the well-logged day, the one
    // `remaining` mode is for, and before C6 it carried no bar anywhere on the
    // screen — the rule was drawn only under an EATEN reading, which is the
    // fallback. Four now: the kcal hero and all three macro cells.
    barsDrawn('nutrition hub (guarded)', html, 4, 0);
    // Every meal's macros are on its row, as three cells rather than a joined
    // string — the item count they replace is gone from the tab.
    expect('nutrition hub (guarded) meal rows', html, ['P 42g', 'C 68g', 'F 20g', 'P 46g']);
    refute('nutrition hub (guarded)', html, ['P 42g · C 68g', '1 item', '2 items']);
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
    // …and the bars survive the fallback: the number above them changed from a
    // remainder to an eaten figure, the thing they draw did not.
    barsDrawn('nutrition hub (fallback)', html, 4, 0);
  }

  console.log('5b. The bars at target, and a meal that carries BOTH a note and macros (C6)');
  {
    // Back to a day that can be counted down, so all three completion cues are
    // on screen at once: the unmeasured meal §5 added is removed (it has no
    // items to cascade), and a meal that takes protein past its target goes on.
    // That is the only state that turns a fill pine and draws the terminator.
    //
    // The new meal also carries a NOTE, which is the silent loss C6 fixes:
    // `meal.notes ?? macros` meant an AI-estimated meal — which always has the
    // model's note — showed no macros at all, so the meals most worth
    // inspecting were exactly the ones whose numbers were hidden.
    db.run('DELETE FROM meals WHERE date = ? AND name = ?', [today, 'Dinner out']);
    logMeal(db, {
      date: today,
      time: '20:10',
      name: 'Post-lift shake',
      kcal: 480,
      protein_g: 95,
      carbs_g: 40,
      fat_g: 9,
      notes: 'Two scoops; the milk was whole, not skim.',
    });

    const html = render('nutrition hub (at target)', NutritionScreen);
    // 42 + 46 + 95 = 183 of a 180 g protein target.
    barsDrawn('nutrition hub (at target)', html, 4, 1);
    expect('nutrition hub (at target)', html, [
      'Protein over', // the third cue, in words — the label already flips
      'Two scoops; the milk was whole, not skim.', // the note, still drawn
      'P 95g', // and the macros, on the same row, no longer displaced by it
      'C 40g',
      'F 9g',
    ]);
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

  console.log('7c. Micronutrients — the owner’s three: caffeine, fiber, sodium');
  {
    // Backlog A8. Two itemized meals on today, carrying the two micros the
    // estimator now returns plus the fiber column. The three free-form meals
    // already logged above contribute nothing — which is exactly the day the
    // screen's undercount caveat exists for, so it is asserted here too.
    logMealWithItems(db, {
      date: today,
      time: '15:10',
      name: 'Flat white',
      items: [
        {
          name: 'Flat white',
          amount: 240,
          kcal: 120,
          protein_g: 7,
          fiber_g: 0,
          micros: JSON.stringify({ caffeine_mg: 145, sodium_mg: 90 }),
        },
      ],
    });
    logMealWithItems(db, {
      date: today,
      time: '13:15',
      name: 'Lentil soup',
      items: [
        {
          name: 'Lentil soup',
          amount: 400,
          kcal: 320,
          protein_g: 18,
          fiber_g: 21,
          micros: JSON.stringify({ sodium_mg: 1150 }),
        },
      ],
    });

    const micros = render('nutrition-micros', NutritionMicrosScreen);
    expect('nutrition-micros', micros, [
      'Sodium',
      '1,240', // 90 + 1,150, summed across the day's items
      'Caffeine',
      '145',
      // 2 of 12: caffeine joined the vocabulary, so the denominator moved too.
      '2 of 12 recorded',
      'Fiber',
      // The owner asked for this caveat by name once already: a day holding any
      // food without micros undercounts, silently, unless it is said.
      'Only foods with recorded micronutrients contribute',
      // No fiber target on this profile yet — the figure stands with no
      // denominator rather than vanishing (00-design-spec.md §5).
      'no target set',
    ]);
    refute('nutrition-micros', micros, ['daily target']);

    // Give the day a fiber target and the same figure earns its denominator.
    // Written onto the existing row rather than appended: two target rows with
    // the same effective_date tie-break on created_at, and a render fixture
    // must not depend on which millisecond it landed in.
    db.run('UPDATE nutrition_targets SET fiber_g = ? WHERE effective_date = ?', [34, today]);
    const withTarget = render('nutrition-micros (fiber target)', NutritionMicrosScreen);
    expect('nutrition-micros (fiber target)', withTarget, ['Fiber', 'g of 34 g', 'daily target']);
    refute('nutrition-micros (fiber target)', withTarget, ['no target set']);
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
      // A drink logged in millilitres (0047), printed under the DEFAULT volume
      // preference, which is oz — 250 ml ÷ 29.5735 = 8.5. The stored number is
      // still 250; only the reading converts, exactly as water already does.
      '8.5 oz',
    ]);
    // …and the same row under ml. Two renders rather than one assertion about a
    // formatter, because the preference reaching THIS screen is the thing that
    // could break, and it is invisible in a unit test of fmtAmount.
    refute('barcode-scan', scan, ['250 ml']);
    setUnitPreference(db, 'volume', 'ml');
    expect('barcode-scan (ml)', render('barcode-scan (ml)', BarcodeScanScreen), ['250 ml']);
    setUnitPreference(db, 'volume', 'oz');
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
  console.log('7d. Create a food — the Describe-it path and the mark it leaves (C2)');
  {
    // a. NO KEY. The field is replaced by a sentence saying so and what still
    //    works; the form below is untouched, because typing the food in by hand
    //    is the path this screen already was. Never a live-looking box that
    //    answers nothing.
    const noKey = render('food-new (no key)', FoodNewScreen, { name: 'Overnight oats' });
    expect('food-new (no key)', noKey, [
      'Create a food',
      'Describe it',
      'Describing a food needs a model key',
      'everything below works without it',
      'Overnight oats', // the failed search still prefills the name
      'Solid · g', // …and the whole manual form is still there
      'Save food',
    ]);
    refute('food-new (no key)', noKey, ['Fill from description', 'Estimated by the model']);

    // b. WITH A KEY, the field and its control. No model call is made here —
    //    rendering does not describe anything — and the point of the count is
    //    the C2 guarantee: the path up to the Save tap writes nothing at all.
    const foodsBefore = db.get('SELECT count(*) AS n FROM foods').n;
    await apiKeyStore.setKey('render-test-key');
    const withKey = render('food-new (key set)', FoodNewScreen);
    expect('food-new (key set)', withKey, [
      'Describe it',
      'Fill from description',
      'Costco rotisserie chicken thigh, skin on', // the placeholder, in the owner's own words
    ]);
    refute('food-new (key set)', withKey, ['Describing a food needs a model key']);
    await apiKeyStore.clearKey();
    db.get('SELECT count(*) AS n FROM foods').n === foodsBefore
      ? ok('food-new wrote no catalog row on either render — nothing is saved without Save')
      : bad('food-new wrote a row on mount');

    // c. THE MARK, in the catalog. A described entry says `est` wherever it
    //    appears — typography, never a hue — so an inferred number is never
    //    read as one the owner typed. Favorited so it shows with no query, the
    //    search field's text being state this render cannot set.
    const described = createFood(db, {
      name: 'Render described soup',
      kcal_100g: 60,
      source: 'ai',
    });
    setFoodFavorite(db, described, true);
    const search = render('food-search (an ai entry)', FoodSearchScreen);
    expect('food-search (an ai entry)', search, [
      'Render described soup',
      '  est</span>', // the tag itself, not the letters in some other word
    ]);
    // The typed foods beside it carry no mark — the tag means something only if
    // it is not on everything.
    search !== null && (search.match(/ {2}est<\/span>/g) || []).length === 1
      ? ok('food-search (an ai entry): exactly one row is marked est')
      : bad('the est tag is on the wrong number of rows');
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
      'No training in the last 14 days, so every muscle reads fresh.',
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
      'No training in the last 14 days, so every muscle reads fresh.',
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

    // -----------------------------------------------------------------------
    // The Resume card (0045, owner 2026-09-14). The hub is where the app lands
    // after iOS killed it mid-session, so the offer to come back has to be on
    // the first frame — which is exactly what a server render can prove.
    refute('exercise hub (no draft)', worked, ['Session in progress', 'Resume']);

    saveWorkoutDraft(db, 'live', {
      version: DRAFT_VERSION,
      startedAt: Date.now() - 12 * 60_000,
      routineId: null,
      restEndsAt: null,
      blocks: [
        {
          key: 1,
          exerciseId: 'barbell-bench-press',
          name: 'Barbell Bench Press',
          loggingType: 'weight_reps',
          mechanic: 'compound',
          restSec: 180,
          prev: [],
          bestE1rm: null,
          linkedToNext: false,
          sets: [
            { key: 1, weight: '80', reps: '8', rpe: '', setType: 'normal', done: true, pr: false },
            { key: 2, weight: '80', reps: '8', rpe: '', setType: 'normal', done: true, pr: false },
            { key: 3, weight: '80', reps: '', rpe: '', setType: 'normal', done: false, pr: false },
          ],
        },
      ],
    });
    const resuming = render('exercise hub (draft waiting)', ExerciseScreen);
    expect('exercise hub (draft waiting)', resuming, [
      'Session in progress',
      'Barbell Bench Press',
      // What is in it, and how long it has been sitting there — a session
      // abandoned days ago is resumable, but the user has to be told which
      // session they are picking up.
      '2 sets logged',
      // The age is measured from the last WRITE, not from the session's start:
      // "how long has this been sitting here" is the question the card answers,
      // and it was just written. Clamped at zero, so a SQLite/`Date.now()` skew
      // can never print "in 0 minutes" (the Windows trap, CLAUDE.md house rules).
      'just now',
      'Resume',
    ]);

    // A draft with structure but nothing typed is NOT offered: those blocks are
    // reproducible by starting the saved workout again, and a Resume that
    // restores nothing typed is a Resume that wasted a tap.
    saveWorkoutDraft(db, 'live', {
      version: DRAFT_VERSION,
      startedAt: Date.now(),
      routineId: null,
      restEndsAt: null,
      blocks: [
        {
          key: 1,
          exerciseId: 'barbell-row',
          name: 'Barbell Row',
          loggingType: 'weight_reps',
          mechanic: 'compound',
          restSec: 180,
          prev: [],
          bestE1rm: null,
          linkedToNext: false,
          sets: [
            { key: 1, weight: '', reps: '', rpe: '', setType: 'normal', done: false, pr: false },
          ],
        },
      ],
    });
    refute('exercise hub (empty draft)', render('exercise hub (empty draft)', ExerciseScreen), [
      'Session in progress',
    ]);
    clearWorkoutDraft(db, 'live');

    // -----------------------------------------------------------------------
    // Ingested workouts (0054, backlog D3). Two rows the watch wrote: a walk,
    // which ARC infers a load from, and a strength session, which it refuses to
    // guess at and asks about instead. The hub has to draw BOTH answers on the
    // first frame, and neither may read as the other.
    const nowMs = Date.now();
    const hkSpan = (endsMinAgo, minutes) => {
      const end = new Date(nowMs - endsMinAgo * 60_000);
      return {
        startTime: new Date(end.getTime() - minutes * 60_000).toISOString(),
        endTime: end.toISOString(),
      };
    };
    upsertWearableRows(db, [
      {
        date: todayISODate(),
        metricType: 'workout',
        value: 45,
        unit: 'min',
        sourceDevice: 'garmin',
        sourceRawId: 'render-walk',
        ...hkSpan(60, 45),
        metadata: { activity: 'Walking', activity_type_raw: 52, kcal: 180 },
      },
      {
        date: todayISODate(),
        metricType: 'workout',
        value: 47,
        unit: 'min',
        sourceDevice: 'garmin',
        sourceRawId: 'render-lift',
        ...hkSpan(240, 47),
        metadata: { activity: 'Strength training', activity_type_raw: 50, kcal: 410 },
      },
    ]);
    const ingested = render('exercise hub (ingested workouts)', ExerciseScreen);
    expect('exercise hub (ingested workouts)', ingested, [
      // The blank — a question, with the span it will prefill and the one tap
      // that answers it.
      'From your watch',
      'Strength training from Apple Health',
      '47 min',
      'muscles unknown',
      'Log sets',
      // …and the inference, which must NOT wear the face of a logged set.
      'Part inferred from Apple Health workouts',
    ]);
    // The walk is inferred, never asked about: a question ARC can answer itself
    // is not a question.
    refute('exercise hub (ingested workouts)', ingested, ['Walking from Apple Health']);
    expect(
      'muscle-freshness (part inferred)',
      render('muscle-freshness (part inferred)', MuscleFreshnessScreen),
      ['Part inferred']
    );
    db.run(`DELETE FROM wearable_data WHERE metric_type = 'workout'`);
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
  console.log('12. The knowledge base (0038 + 0044 sections, docs/knowledge-subapp.md)');

  // Before the pack: the hub is honest that the reference has not loaded, and
  // BOTH section empties are AUTHORED rather than blank — and they say
  // DIFFERENT things, because they are different facts. An empty scientific run
  // sits above a shipped pack, so "nothing of your own yet" is a remark about
  // authorship; an empty personal run means ARC holds no page about the user at
  // all.
  const cold = render('knowledge hub (cold)', KnowledgeScreen);
  expect('knowledge hub (cold)', cold, [
    'Knowledge',
    'Import an article',
    'Personal',
    'ARC holds no page about you yet',
    'Write a personal note',
    'Scientific',
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
  // …and a scientific entry does NOT fill the personal run. The two sections
  // read from one table through one filter, so the failure this catches is a
  // dropped WHERE clause — which would look fine until the day a personal note
  // exists.
  expect('knowledge hub (with an entry)', withEntry, ['ARC holds no page about you yet']);

  const personalId = saveKnowledgeEntry(db, {
    title: 'Render entry: left knee, ACL 2019',
    topic: 'training',
    section: 'personal',
    body:
      'Reconstructed left ACL in 2019. The quad still measures roughly 15% down against the ' +
      'right under load, and deep loaded knee flexion under fatigue is where it complains.',
  });
  const withPersonal = render('knowledge hub (with a personal entry)', KnowledgeScreen);
  expect('knowledge hub (with a personal entry)', withPersonal, [
    'Render entry: left knee, ACL 2019',
    'Render entry: my own magnesium stance', // the other section still drawn
  ]);
  refute('knowledge hub (with a personal entry)', withPersonal, [
    'ARC holds no page about you yet',
  ]);

  // The reader names the section it came out of — a page about the user and a
  // page about the world are read differently.
  expect(
    'knowledge-entry (personal)',
    render('knowledge-entry (personal)', KnowledgeEntryScreen, {
      id: personalId,
      kind: 'entry',
    }),
    ['Personal', 'Render entry: left knee, ACL 2019', 'Edit', 'Archive']
  );

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
      'Section',
      'Personal',
      'Scientific',
      'Topic',
      'supplements', // the vocabulary chips
      'Save entry',
    ]
  );
  // The section switch is shown when EDITING too — that is the re-filing path,
  // and the line between "what I believe about sleep" and "what is true of my
  // sleep" is blurry enough that getting it wrong once must not be permanent.
  expect(
    'knowledge-entry-edit (editing)',
    render('knowledge-entry-edit (editing)', KnowledgeEntryEditScreen, { id: entryId }),
    ['Edit entry', 'Section', 'Save changes']
  );
  // Arriving from the hub's personal action preselects the section, so filing a
  // personal note is not two decisions.
  expect(
    'knowledge-entry-edit (new, personal)',
    render('knowledge-entry-edit (new, personal)', KnowledgeEntryEditScreen, {
      section: 'personal',
    }),
    ['A page about you']
  );

  expect('knowledge-import', render('knowledge-import', KnowledgeImportScreen), [
    'Import an article',
    'From a link',
    'Paste the text',
    // Honest no-key state under node — and the manual floor is still offered.
    'Reading an article needs a model key',
    'Write it yourself',
  ]);

  // --- C14: coach memory is a run on this hub, not a screen under Settings ---
  //
  // Owner: "I should be able to manually add stuff to coach memory that it
  // should know every turn." The store did not change (no migration); its
  // surface moved here, beside the entries it has to be told apart from.
  //
  // The empty state is AUTHORED, and it is a different fact from either entry
  // empty: "The Coach holds nothing yet" is a statement about what rides in the
  // prompt, not about what is written down.
  const coldMemory = render('knowledge hub (no memories)', KnowledgeScreen);
  expect('knowledge hub (no memories)', coldMemory, [
    'Coach memory',
    'The Coach holds nothing yet',
    'carried into every turn',
    'Remember something',
  ]);

  rememberFact(db, {
    content: 'Render memory: trains fasted before 9am',
    category: 'preference',
  });
  const withMemory = render('knowledge hub (with a memory)', KnowledgeScreen);
  expect('knowledge hub (with a memory)', withMemory, [
    'Render memory: trains fasted before 9am',
    'Preference', // the kind eyebrow, the entry rows' topic-eyebrow shape
  ]);
  refute('knowledge hub (with a memory)', withMemory, ['The Coach holds nothing yet']);
  // The cap is stated only when it BITES. Under 40 the sentence would be a
  // setting nobody asked about; over it, it is the only explanation for a Coach
  // that ignores a fact the owner can still read on this screen.
  refute('knowledge hub (with a memory)', withMemory, ['no longer riding along']);

  // The forgotten foot stays collapsed, so its rows are absent from the render
  // while its heading is present — the Archived foot's behaviour exactly.
  const forgottenId = rememberFact(db, {
    content: 'Render memory: a fact that stopped being true',
    category: 'context',
  });
  forgetMemory(db, forgottenId);
  const withForgotten = render('knowledge hub (with a forgotten memory)', KnowledgeScreen);
  expect('knowledge hub (with a forgotten memory)', withForgotten, ['Forgotten']);
  refute('knowledge hub (with a forgotten memory)', withForgotten, [
    'Render memory: a fact that stopped being true',
  ]);

  // Past the cap the sentence appears, and it is the ONLY place in the app that
  // explains a Coach ignoring a fact the owner can still read on screen. Built
  // and torn down inside this block so the 41 rows do not follow the hub into
  // any later render.
  const overflow = [];
  for (let i = 0; i < 41; i += 1) {
    overflow.push(rememberFact(db, { content: `Render memory filler ${i}`, category: 'context' }));
  }
  expect(
    'knowledge hub (over the prompt cap)',
    render('knowledge hub (over the prompt cap)', KnowledgeScreen),
    ['no longer riding along', 'most recent into every turn']
  );
  for (const id of overflow) db.run('DELETE FROM coach_memories WHERE id = ?', [id]);

  // The editor the hub pushes at, both ways in.
  expect('coach-memory (new)', render('coach-memory (new)', CoachMemoryScreen), [
    'Remember something',
    'The memory',
    'Kind',
    'Preference',
    'Constraint',
    // The LENGTH litmus, stated where the owner is choosing between the stores.
    'is a Personal entry instead',
    // Not "carries the 40 most recent": MEMORY_PROMPT_LIMIT is a JSX
    // interpolation, so react-dom splits that sentence across text nodes and an
    // assertion spanning the number would fail on the markup, not the copy.
    'most recent memories into every turn',
  ]);
  const editing = render('coach-memory (editing)', CoachMemoryScreen, { id: forgottenId });
  expect('coach-memory (editing)', editing, [
    'Edit memory',
    'Render memory: a fact that stopped being true',
    // A forgotten memory offers Restore, not Forget — the two are one control.
    'Restore',
    'Delete',
  ]);
  refute('coach-memory (editing)', editing, ['Remember this']);
  // A link to a memory that has since been deleted is authored, not blank.
  expect(
    'coach-memory (deleted id)',
    render('coach-memory (deleted id)', CoachMemoryScreen, { id: 'nope' }),
    ['That memory is no longer here']
  );
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

  // ---------------------------------------------------------------------
  // The Log tab's Water tile, now that there IS a record to learn from. The
  // fixture above logged 500 ml thirteen times and 750 / 250 once each, so the
  // remembered amount is 500 ml — and the tile has to say so in the unit the
  // user reads in, not in the unit it is stored in.
  setUnitPreference(db, 'volume', 'ml');
  const mlLog = render('log tab (ml, learned amount)', LogScreen);
  expect('log tab (ml, learned amount)', mlLog, [
    '+500 ml', // the learned amount, in metric literals — never a converted 473
    'Log water, 500 ml',
  ]);
  // Under a metric preference nothing on the tile may still read in ounces.
  refute('log tab (ml, learned amount)', mlLog, ['+8 oz', '+17 oz', 'Log water, 8 oz']);

  setUnitPreference(db, 'volume', 'oz');
  const ozLog = render('log tab (oz, learned amount)', LogScreen);
  // THE INVARIANT, rendered: the face and the accessibility label carry the SAME
  // number, and it is the number the tap will log. 500 ml read under an ounce
  // preference is 17 oz, and the tile offers 17 oz rather than pretending to
  // offer the stored 500 — a tile that printed one amount and logged another
  // would be a lie, and nothing else about it would matter.
  expect('log tab (oz, learned amount)', ozLog, ['+17 oz', 'Log water, 17 oz']);
  refute('log tab (oz, learned amount)', ozLog, ['+500 ml', 'Log water, 500 ml', '+8 oz']);
}

// ---------------------------------------------------------------------------
// The Protocols sub-app, populated (docs/project-status.md §1 › PROTOCOLS).
// The empty states are up in §0, before any fixture existed; these are the four
// screens with a real phased, cadenced protocol and a real execution record
// behind them.
// ---------------------------------------------------------------------------
{
  console.log('15. Protocols — the hub, the detail, the editor and the diff');

  // A titration with two phases and three cadences, anchored in the past so a
  // phase is genuinely live and the record has settled days behind it.
  const day = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return todayISODate(d);
  };
  const phasedId = createProtocolWithVersion(
    db,
    { name: 'Creatine loading', type: 'supplement_stack', startedOn: day(10) },
    {
      schema: 2,
      phases: [
        {
          id: 'load',
          title: 'Loading',
          duration_days: 7,
          items: [
            {
              id: 'c-load',
              title: 'Creatine',
              scheduled_time: '07:00',
              dose: '20 g',
              notes: null,
              cadence: { kind: 'daily' },
            },
          ],
        },
        {
          id: 'maint',
          title: 'Maintenance',
          duration_days: null,
          items: [
            {
              id: 'c-maint',
              title: 'Creatine',
              scheduled_time: '07:00',
              dose: '5 g',
              notes: null,
              cadence: { kind: 'daily' },
            },
            {
              id: 'lift',
              title: 'Lower body',
              scheduled_time: null,
              dose: null,
              notes: null,
              cadence: { kind: 'weekdays', days: [1, 3, 5] },
            },
          ],
        },
      ],
    },
    'Split into a loading week and maintenance'
  );

  const hub = render('protocols (populated)', ProtocolsScreen);
  expect('protocols (populated)', hub, [
    'Running',
    'Creatine loading',
    // The row carries LIVE STATE, not a file description: which phase, and how
    // often. On day 10 of a 7-day loading phase it is in Maintenance.
    'Maintenance of 2',
    'Morning stack', // the §10 fixture, still running
  ]);

  const detail = render('protocol-detail', ProtocolDetailScreen, { id: phasedId });
  expect('protocol-detail', detail, [
    'Creatine loading',
    'Supplement stack',
    'Maintenance of 2', // where it is up to, as the verdict
    '5 g', // the live phase's dose, not the loading one's
    'Mon · Wed · Fri', // the cadence, in words
    // The adherence plate, re-set 2026-09-14 (backlog A9). The label is the
    // noun for what is filed under it; the assistant-voiced version the owner
    // named as the archetype of the app's AI slop is refuted below.
    'Adherence',
    'The document',
    'Version history',
  ]);
  refute('protocol-detail', detail, ['How it is going', 'Nothing settled to judge yet']);
  // The loading dose belongs to a phase that is over. Printing it beside the
  // live one would hand the reader two doses of the same compound with nothing
  // saying which is current.
  refute('protocol-detail', detail, ['20 g']);

  // A protocol whose live version landed today has NO record — which is a
  // different fact from a record of nothing done, and neither is 0%.
  expect('protocol-detail (no record yet)', detail, ['landed today', 'Counting starts tomorrow.']);
  refute('protocol-detail (no record yet)', detail, ['0%']);

  // The EDIT path on a phased protocol: phase chrome appears, the start date
  // appears with it, and the save is labelled with the version it will write.
  const editPhased = render('protocol-edit (phased)', ProtocolEditScreen, { id: phasedId });
  expect('protocol-edit (phased)', editPhased, [
    'Edit Protocol',
    'Phase 1',
    'Phase 2',
    'Phase 1 starts',
    'Loading',
    'Maintenance',
    'Mon · Wed · Fri',
    'Save as',
    'Delete protocol',
  ]);

  // A second version, so the history has an adjacent pair to diff.
  addVersion(
    db,
    phasedId,
    {
      schema: 2,
      phases: [
        {
          id: 'load',
          title: 'Loading',
          duration_days: 7,
          items: [
            {
              id: 'c-load',
              title: 'Creatine',
              scheduled_time: '07:00',
              dose: '20 g',
              notes: null,
              cadence: { kind: 'daily' },
            },
          ],
        },
        {
          id: 'maint',
          title: 'Maintenance',
          duration_days: null,
          items: [
            {
              id: 'c-maint',
              title: 'Creatine',
              scheduled_time: '07:00',
              dose: '10 g',
              notes: null,
              cadence: { kind: 'daily' },
            },
          ],
        },
      ],
    },
    'Doubled maintenance, dropped the lift',
    'ai'
  );

  const versions = render('protocol-versions', ProtocolVersionsScreen, { id: phasedId });
  expect('protocol-versions', versions, [
    'Version History',
    'Creatine loading',
    'Current',
    'Coach', // authorship is stamped per version
    'Doubled maintenance, dropped the lift', // what the author SAID
    // …and what the save actually DID, under it. This is the payoff the
    // history never paid: `change_notes` was write-only, and there was no way
    // to see what a version changed or to go back to one.
    'dose 5 g → 10 g',
    'removed Lower body',
    'Restore', // …and the way back, on the superseded row only
  ]);
  // v1 is the start of the record, not a change, so it prints no diff.
  refute('protocol-versions', versions, ['no change to the items']);
}

// —————————————————————————————————————————————————————————————————————————
// The number-pad check, checked. `keypadsDismissable` runs inside `render` and
// says nothing when a screen has no number pad — which is also exactly what it
// would do if the markup shape changed under it and the regex stopped matching.
// So: assert the walk actually FOUND pads, and that the predicate can still
// tell a trapped one from a dismissable one.
{
  console.log('\n16. The number-pad check can fail');
  // A floor, not the count: most numeric fields in the app sit inside editors
  // that open on a TAP, and a server render never opens one. What the walk does
  // reach (water's Add, recipe-edit's four, protocol-edit's phase lengths) is
  // enough to prove the regex still matches something.
  keypadsSeen >= 5
    ? ok(`the walk inspected ${keypadsSeen} number pads`)
    : bad(`the number-pad check is vacuous — only ${keypadsSeen} pads seen`);

  const trapped = findKeypads('<input inputMode="decimal" value=""/>');
  trapped.all.length === 1 && trapped.stuck.length === 1
    ? ok('a pad with no enterKeyHint is reported as trapped')
    : bad('a pad with no enterKeyHint was NOT reported as trapped');

  const freed = findKeypads('<input inputMode="numeric" enterKeyHint="done" value=""/>');
  freed.all.length === 1 && freed.stuck.length === 0
    ? ok('a pad with enterKeyHint is reported as dismissable')
    : bad('a pad with enterKeyHint was reported as trapped');

  // A full keyboard already has a return key and must not be demanded one.
  findKeypads('<input type="text" value=""/>').all.length === 0
    ? ok('a full keyboard is not held to the number-pad rule')
    : bad('a full keyboard was held to the number-pad rule');
}

{
  console.log('Settings › Apple Health — the sync log the owner will actually open');

  // This screen had no render coverage at all, which is uncomfortable given
  // what it is FOR: it is the surface a user opens when Apple Health has
  // already gone wrong, and the one added on 2026-08-26 to explain a silent
  // failure. A screen that throws while explaining a failure explains nothing.

  setHealthSyncEnabled(db, true);
  const never = render('settings-health (no sync yet)', SettingsHealthScreen);
  expect('settings-health (no sync yet)', never, [
    'Apple Health',
    'Last sync',
    'No sync has run yet.', // authored, never blank
  ]);
  // Nothing may be reported that has not happened. An empty log must not print
  // counts, and must not name a step as having succeeded or failed.
  refute('settings-health (no sync yet)', never, ['rows changed', 'Published out']);

  // Hydration (2026-09-14). Three things have to be on this screen and all
  // three are assertions rather than intentions: the scope row with its
  // direction, the audit row with its honest verdict, and the sentence that
  // makes the no-dedupe rule the user's to act on. "Pick one door" is the whole
  // mitigation for double counting, so it cannot live only in a docblock.
  expect('settings-health (no sync yet)', never, [
    'Water (hydration)',
    'Water is read, never written.',
    'log a glass in one place or the other, not both',
    // The audit row. `unverified` is the honest verdict — nothing in the repo
    // establishes that a Garmin writes hydration to Apple Health.
    'Unverified',
  ]);

  setHealthSyncLog(db, {
    at: '2026-08-26T09:00:00.000Z',
    windowDays: 14,
    rowsWritten: 12,
    metrics: [
      {
        metric: 'hrv',
        label: 'hrv',
        returned: 40,
        rows: 14,
        exclusion: 'source',
        error: null,
        rejected: null,
      },
      {
        metric: 'weight_kg',
        label: 'Weight',
        returned: 0,
        rows: 0,
        exclusion: 'refused',
        error: 'predicate not supported',
        rejected: { arcTag: 0, arcBundle: 0, unattributed: 0, outOfBounds: 0, nonFinite: 0 },
      },
      {
        metric: 'body_fat_pct',
        label: 'Body fat',
        returned: 6,
        rows: 0,
        exclusion: 'metadata',
        error: null,
        rejected: { arcTag: 0, arcBundle: 0, unattributed: 6, outOfBounds: 0, nonFinite: 0 },
      },
    ],
    publish: {
      armed: true,
      stalled: false,
      attempted: 0,
      succeeded: 0,
      types: [],
    },
  });

  const logged = render('settings-health (logged)', SettingsHealthScreen);
  expect('settings-health (logged)', logged, [
    '14d window',
    'Weight',
    '0 → 0', // the shape of the whole answer: returned → kept
    'Apple Health refused both echo-suppression filters',
    'predicate not supported', // the native error, carried all the way to the screen
    'Skipped 6 with no readable source.', // the guard named, in words
    '40 → 14', // …and a healthy metric alongside it, so the zero means something
    '12 rows changed',
    'Armed —', // the deliberate zero, said out loud rather than left to look like a bug
  ]);
  // The armed pass attempted nothing, so no type may appear claiming it was
  // refused — a fabricated finding is worse than a missing one.
  refute('settings-health (logged)', logged, ['Waist circumference. 0 / 0']);
}

/**
 * 16. A2 — the back affordance, on every screen the recipe save path passes
 * through.
 *
 * The owner's *"after saving a recipe, sometimes the back button doesn't work"*
 * had two halves, and a headless render can see one of them. The half it sees:
 * the control EXISTS and is spoken as a back control on each of the four
 * screens a saved recipe is reached through. The half it cannot: whether the
 * stack it pops has anything under it — that is navigation state, and it is
 * pinned instead in db/recipe-import.test.mjs §10, which asserts the root
 * layout's anchor so a cold-start deep link is never the only route on the
 * stack. Together they cover the bug; neither does alone.
 *
 * `render()` is not re-used here because the point is the header, which every
 * one of these screens draws unconditionally — including the "this recipe is
 * gone" state, where a missing back control would strand the user completely.
 */
console.log('16. A2 — every screen in the recipe save path can be left again');
{
  const backAffordance = (name, html) => {
    if (html === null) return;
    // react-native-web renders StackHeader's Pressable as role="button" with
    // the spoken label; `parent` screens say "Back to <where>".
    const labels = [...html.matchAll(/aria-label="(Back(?: to [^"]*)?)"/g)].map((m) => m[1]);
    labels.length > 0
      ? ok(`${name}: the header's back control is present and spoken ("${labels[0]}")`)
      : bad(`${name}: no back affordance in the rendered header`);
  };

  const saved = createRecipe(db, {
    title: 'Saved from a share',
    source: 'import',
    source_url: 'https://www.instagram.com/reel/SAVED1/',
    source_platform: 'instagram',
    servings: 2,
    ingredients: [{ raw_text: '1 onion' }],
  });

  // The four screens: where a save lands, and the three that can perform one.
  backAffordance(
    'recipe-detail (after a save)',
    render('recipe-detail (after a save)', RecipeDetailScreen, { id: saved })
  );
  backAffordance(
    'recipe-detail (deleted under it)',
    render('recipe-detail (deleted under it)', RecipeDetailScreen, { id: 'gone' })
  );
  backAffordance('recipe-edit (new)', render('recipe-edit (back)', RecipeEditScreen));
  backAffordance(
    'recipe-edit (existing)',
    render('recipe-edit (back, existing)', RecipeEditScreen, { id: saved })
  );
  backAffordance('recipe-import', render('recipe-import (back)', RecipeImportScreen));
  backAffordance(
    'recipe-revise',
    render('recipe-revise (back)', RecipeReviseScreen, { id: saved })
  );
}

/**
 * 17. A3 — the amount fields select themselves on focus.
 *
 * Two halves, because neither is visible on its own.
 *
 * The BEHAVIOUR is asserted directly: `selectAllOnFocus` is a pure props
 * builder, so the handler it returns can be driven with a fake focus event and
 * asked what it did. That is the half that matters on device — iOS's New
 * Architecture reads `selectTextOnFocus` only inside the imperative `-focus`
 * command, so a TAP needs the `setSelection` call (the whole mechanism, with
 * the RN source it was read off, is in src/components/ui/select-on-focus.ts).
 *
 * The COVERAGE is asserted over source, not markup, and that is a real
 * limitation stated rather than hidden: react-native-web consumes
 * `selectTextOnFocus` in its own focus handler and emits nothing for it, and an
 * `onFocus` prop leaves no trace in HTML either — so unlike the number-pad rule
 * above, this one cannot be read off a render. The sweep keys on the spoken
 * label, which is what makes a field an AMOUNT field rather than a clock or a
 * name: every `decimal-pad` input whose label says "grams" — or, since 0047,
 * "millilitres" — must carry it.
 *
 * The label match spans NEWLINES, and that is the second thing this rule has
 * learned the hard way. When the unit became a choice the labels became
 * expressions, prettier wrapped them across three lines, and a `[^\n]*` pattern
 * silently stopped matching two of the seven fields — a coverage rule failing
 * OPEN. The count assertion below is what caught it, which is why it is there.
 */
console.log('17. A3 — every amount field in food logging highlights its value');
{
  const ev = (captured) => ({
    currentTarget: {
      setSelection: (start, end) => {
        captured.push([start, end]);
      },
    },
    target: null,
  });

  const props = selectAllOnFocus('250');
  props.selectTextOnFocus === true
    ? ok('the declarative half is set (web, Android, and an imperative focus())')
    : bad('selectTextOnFocus missing');
  let calls = [];
  props.onFocus(ev(calls));
  JSON.stringify(calls) === '[[0,3]]'
    ? ok('focusing a filled field selects the whole value (the iOS tap path)')
    : bad('setSelection on focus', JSON.stringify(calls));
  calls = [];
  selectAllOnFocus('').onFocus(ev(calls));
  calls.length === 0
    ? ok('an empty field selects nothing rather than spending a bridge command')
    : bad('empty field selected');
  // A host that predates the method must not crash the tap.
  let threw = null;
  try {
    selectAllOnFocus('12').onFocus({ currentTarget: {}, target: null });
  } catch (e) {
    threw = e;
  }
  threw === null
    ? ok('a host instance without setSelection degrades to the declarative half')
    : bad('onFocus threw', String(threw));

  // The sweep. Each file is a surface where a FOOD's amount gets changed.
  const SURFACES = [
    'app/barcode-scan.tsx',
    'app/food-search.tsx',
    'app/meal-detail.tsx',
    'app/meal-estimate.tsx',
    'app/meal-revise.tsx',
    'app/recipe-detail.tsx',
  ];
  let swept = 0;
  let missing = [];
  for (const file of SURFACES) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const chunk of source.split('<TextInput').slice(1)) {
      const element = chunk.slice(0, chunk.indexOf('/>'));
      const isAmount =
        /keyboardType="decimal-pad"/.test(element) &&
        /accessibilityLabel=[\s\S]*?(?:grams|millilitres)/i.test(element);
      if (!isAmount) continue;
      swept++;
      if (!element.includes('selectAllOnFocus(')) {
        missing.push(`${file}: ${(/accessibilityLabel=([^\n]*)/.exec(element) ?? [])[1]}`);
      }
    }
  }
  // A regex that stopped matching anything would pass vacuously, so the count
  // is asserted too — seven amount fields across the six surfaces.
  swept >= 7
    ? ok(`${swept} amount fields found across ${SURFACES.length} food-logging surfaces`)
    : bad(`the sweep matched only ${swept} amount fields — the pattern has gone stale`);
  missing.length === 0
    ? ok('every one of them highlights its value on focus')
    : bad(`${missing.length} amount field(s) without selectAllOnFocus`, missing.join(' · '));
}

/**
 * 18. C1 — the nutrition history's day view.
 *
 * Three claims, and the third is the one that could have shipped a lie:
 *   - a PAST day renders its own meals, reachable from nowhere before this;
 *   - an EMPTY day is authored, not a row of zeros;
 *   - a CLOSED day never counts down. The fixture is built so the difference is
 *     visible: the past day is fully logged against a target it does not reach,
 *     so without `recordFigure` the screen would print "820 kcal left" over a
 *     day that is over.
 */
console.log('18. C1 — nutrition history: a day picker, a past day, and an authored empty');
{
  const now = todayISODate();
  const threeBack = shiftISODate(now, -3);
  const twoBack = shiftISODate(now, -2);

  // Targets that governed the past day — DELIBERATELY different from today's
  // 2,400, so the assertion below proves the day is judged by its own era's
  // targets rather than by whatever is set now.
  setNutritionTargets(db, {
    effective_date: threeBack,
    kcal: 2000,
    protein_g: 150,
    carbs_g: 200,
    fat_g: 60,
  });
  logMeal(db, {
    date: threeBack,
    time: '07:50',
    name: 'Past breakfast',
    kcal: 620,
    protein_g: 42,
    carbs_g: 68,
    fat_g: 20,
  });
  logMeal(db, {
    date: threeBack,
    time: '19:20',
    name: 'Past dinner',
    kcal: 560,
    protein_g: 38,
    carbs_g: 44,
    fat_g: 24,
  });

  const past = render('nutrition-history (a past day)', NutritionHistoryScreen, {
    date: threeBack,
  });
  expect('nutrition-history (a past day)', past, [
    'Past breakfast',
    'Past dinner',
    'Meals',
    // Judged by the targets that governed THAT day (2,000), not today's 2,400.
    '1,180 of 2,000 kcal',
    // The picker's controls and its way home, which exists only off today.
    'Previous food log',
    'Next food log',
    'Back to today',
  ]);
  // THE CLOSED-DAY RULE. A remainder is a claim about a day you can still act
  // on; Tuesday is over. Both readings are refuted, because the macro cells
  // carry the mode in their own labels.
  refute('nutrition-history (a past day)', past, [
    'kcal left',
    'kcal over',
    'Protein left',
    'Protein over',
  ]);

  // An empty day inside the record: authored, and not a zero. The sentence is
  // composed through dayPhrase, so this also proves the screen and the phrase
  // helper agree (the helper's own wording is pinned in db/day-boundary.test.mjs).
  const empty = render('nutrition-history (an empty day)', NutritionHistoryScreen, {
    date: twoBack,
  });
  expect('nutrition-history (an empty day)', empty, [
    `Nothing logged ${dayPhrase(twoBack, now)}.`,
    'Back to today',
  ]);
  refute('nutrition-history (an empty day)', empty, ['kcal left', 'Meals']);

  // Today: the picker is home, so the return affordance has retired.
  const todayView = render('nutrition-history (today)', NutritionHistoryScreen, {});
  expect('nutrition-history (today)', todayView, ['Today', 'Over time', 'Daily average']);
  refute('nutrition-history (today)', todayView, ['Back to today']);

  // A `?date=` in the future cannot select a day that has not happened — the
  // param is clamped the same way the arrow is.
  const future = render('nutrition-history (a future param)', NutritionHistoryScreen, {
    date: shiftISODate(now, 30),
  });
  expect('nutrition-history (a future param)', future, ['Today']);
  refute('nutrition-history (a future param)', future, ['Back to today']);
}

/**
 * 19. C8 — the review marks an estimate, and cannot save one unconfirmed.
 *
 * The review is the third phase of an async ladder (fetch → model turn), so it
 * is unreachable from a server render of the whole screen. `ReviewDraft` is
 * exported for exactly this, and this is the only claim in C8 that a headless
 * unit test cannot make on its own: that the SCREEN leaves the field empty.
 */
console.log('19. C8 — the servings estimate is marked, and never pre-filled');
{
  /** The value actually sitting in the Servings field of a rendered review. */
  const servingsValue = (html) => {
    const tag = (html.match(/<input[^>]*aria-label="Servings"[^>]*>/) || [])[0] ?? '';
    return (/value="([^"]*)"/.exec(tag) || [])[1] ?? null;
  };

  const lines = [
    { raw_text: '800 g chicken thighs' },
    { raw_text: '500 g white rice' },
    { raw_text: '400 g broccoli' },
    { raw_text: '2 tbsp soy sauce' },
  ];
  const estimate = estimateServings('Chicken & Rice Bowl', lines);
  const baseDraft = {
    title: 'Chicken & Rice Bowl',
    servings: null,
    prep_min: null,
    cook_min: null,
    ingredients: lines,
    steps: ['Cook the rice.', 'Sear the chicken.'],
    source_url: null,
    source_platform: null,
    source_author: null,
    source_image_url: null,
    notes: null,
    deterministic: false,
    servings_estimate: estimate,
  };

  // (a) The source said nothing: the estimate is OFFERED, marked, and the field
  //     is empty — so the Save gate (which has always required a positive
  //     servings) makes an unconfirmed estimate unsaveable, not merely unsaved.
  const offered = render(
    'recipe-import review (estimated)',
    ReviewDraft,
    {},
    {
      draft: baseDraft,
      onSaved: () => {},
    }
  );
  expect('recipe-import review (estimated)', offered, [
    'ARC’s estimate',
    '≈ estimate',
    'About 3 servings.',
    '3 of 4 lines', // the coverage — the direction of the error, said out loud
    'main-course',
    'Use 3',
    'Use 3 servings', // the spoken label on the control that confirms it
  ]);
  servingsValue(offered) === ''
    ? ok('recipe-import review: the estimate is NOT in the field — it must be confirmed')
    : bad(
        'an unconfirmed estimate was pre-filled into the servings field',
        String(servingsValue(offered))
      );
  // The old sentence is the wrong one now: there IS something better than
  // "set it" to say when ARC can propose a number.
  refute('recipe-import review (estimated)', offered, ['The source didn’t say — set it.']);

  // (b) The caption stated a yield: it wins outright, the field carries it, and
  //     no estimate is drawn beside it to argue with the author.
  const statedDraft = { ...baseDraft, servings: 6 };
  const stated = render(
    'recipe-import review (stated yield)',
    ReviewDraft,
    {},
    {
      draft: statedDraft,
      onSaved: () => {},
    }
  );
  servingsValue(stated) === '6'
    ? ok('recipe-import review: a stated yield fills the field as it always did')
    : bad('a stated yield did not reach the field', String(servingsValue(stated)));
  refute('recipe-import review (stated yield)', stated, ['≈ estimate', 'ARC’s estimate', 'Use 3']);

  // (c) Nothing stated and nothing estimable: the screen asks, exactly as it
  //     did before C8.
  const bare = render(
    'recipe-import review (no estimate)',
    ReviewDraft,
    {},
    {
      draft: {
        ...baseDraft,
        ingredients: [{ raw_text: 'a handful of herbs' }],
        servings_estimate: null,
      },
      onSaved: () => {},
    }
  );
  expect('recipe-import review (no estimate)', bare, ['The source didn’t say — set it.']);
  refute('recipe-import review (no estimate)', bare, ['≈ estimate']);
}

// -------------------------------------------------------------------------
console.log('\n18. D4 — the timezone line reaches Home, and only on the day it happened');
{
  // LAST on purpose, and it cleans up after itself: a `timezone_changes` row is
  // read by the mission ledger (it excuses the day's skips) and by readiness's
  // baselines, so leaving one behind would quietly re-judge §10's and §14's
  // assertions from underneath them.
  const today = todayISODate();

  refute('home (no timezone change)', render('home', HomeScreen), ['Timezone changed']);

  db.run(
    `INSERT INTO timezone_changes
       (id, changed_at, from_offset_min, to_offset_min, from_local_date, to_local_date)
     VALUES ('render-tz', ?, -480, 60, ?, ?)`,
    [`${today}T20:00:00.000Z`, today, today]
  );
  const travelled = render('home (timezone changed today)', HomeScreen);
  expect('home (timezone changed today)', travelled, [
    // The fact, and the consequence that makes it worth one line on the one
    // screen that is meant to stay empty: the day is not 24 hours long.
    'Timezone changed (UTC−8 → UTC+1)',
    '15 hours long',
  ]);
  // It is a calendar fact, so it takes neither the accent nor a signal colour
  // (mode-control.tsx states that firewall in exactly this context).
  refute('home (timezone changed today)', travelled, ['You travelled', 'America/']);

  db.run(`DELETE FROM timezone_changes WHERE id = 'render-tz'`);
  refute('home (the row removed again)', render('home', HomeScreen), ['Timezone changed']);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
