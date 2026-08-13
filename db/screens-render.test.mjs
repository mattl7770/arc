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
} from '../src/lib/db/repositories/nutrition.ts';
import {
  createRecipe,
  listIngredients,
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

import ExerciseScreen from '../app/exercise.tsx';
import MuscleFreshnessScreen from '../app/muscle-freshness.tsx';
import RecipesScreen from '../app/recipes.tsx';
import RecipeDetailScreen from '../app/recipe-detail.tsx';
import RecipeEditScreen from '../app/recipe-edit.tsx';
import RecipeImportScreen from '../app/recipe-import.tsx';
import GroceryScreen from '../app/grocery.tsx';
import NutritionScreen from '../app/nutrition.tsx';
import MealDetailScreen from '../app/meal-detail.tsx';

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
      'Log', // the one accent, in every state
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
    expect('nutrition hub (tab root)', tabRoot, ['Nutrition']);
    const pushed = render('nutrition hub (pushed)', NutritionScreen);
    expect('nutrition hub (pushed)', pushed, ['Nutrition']);
  }

  console.log('7. Edited shipped screens still render');
  expect(
    'meal-detail (+ Save as recipe)',
    render('meal-detail', MealDetailScreen, { id: mealId }),
    ['Render lunch', 'Save as template', 'Save as recipe']
  );

  console.log('8. Check-off state renders');
  const milk = db.get(`SELECT id FROM grocery_items WHERE name = 'Milk'`);
  checkGroceryItem(db, milk.id);
  expect('grocery (with cart)', render('grocery (with cart)', GroceryScreen), ['In cart']);

  // -------------------------------------------------------------------------
  // The body figure (reworked 2026-08-12 after the owner's "hard to tell what's
  // what"). What a server render CAN prove about a drawing is narrow but it is
  // exactly the part that was broken: the figure's ~90 positioned views cost
  // nothing to VoiceOver, so the whole burden of saying WHICH muscle is in
  // WHICH state falls on words — the key's rows and the section tally. Those
  // are text, so they are assertable here. The drawing itself stays an
  // on-device check (memory: verify on device, not web).
  console.log('9. Muscle freshness — the figure key states its case in words');
  {
    const empty = render('exercise hub (never trained)', ExerciseScreen);
    expect('exercise hub (never trained)', empty, [
      'Muscle freshness',
      '16 of 16 fresh',
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
    expect('exercise hub (after a session)', worked, [
      'Fatigued', // the WORD is the primary carrier: the two fills are 1.03:1
      'Chest', // ...and the muscle is NAMED, which the old figure never did
    ]);
    // The tally moved off 16/16, and the never-logged caveat retired with it.
    refute('exercise hub (after a session)', worked, [
      '16 of 16 fresh',
      'No sessions logged yet, so every muscle reads fresh.',
    ]);

    expect('muscle-freshness (pushed)', render('muscle-freshness', MuscleFreshnessScreen), [
      'Muscle freshness',
      'Per muscle',
      'Fatigued',
      'Chest',
    ]);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
