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

import { createFood } from '../src/lib/db/repositories/foods.ts';
import { logMealWithItems } from '../src/lib/db/repositories/nutrition.ts';
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
function render(name, Component, params = {}) {
  __setParams(params);
  try {
    return renderToString(React.createElement(Component));
  } catch (e) {
    bad(`${name} rendered`, e instanceof Error ? e.message : String(e));
    return null;
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
  // Complete recipe: per-serving numbers + steps + resolved sub-lines.
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
      'Unlink',
    ]
  );
  // Incomplete recipe: the honesty gate's copy + the Link affordance.
  expect(
    'recipe-detail (incomplete)',
    render('recipe-detail (incomplete)', RecipeDetailScreen, { id: draft }),
    ['Mystery stew', 'Nutrition not computed', 'Link']
  );
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

  console.log('3. Edited shipped screens still render');
  expect('nutrition hub', render('nutrition hub', NutritionScreen), [
    'Kitchen',
    'Recipes',
    'Grocery list',
    '2 recipes',
    '3 to buy',
  ]);
  expect(
    'meal-detail (+ Save as recipe)',
    render('meal-detail', MealDetailScreen, { id: mealId }),
    ['Render lunch', 'Save as template', 'Save as recipe']
  );

  console.log('4. Check-off state renders');
  const milk = db.get(`SELECT id FROM grocery_items WHERE name = 'Milk'`);
  checkGroceryItem(db, milk.id);
  expect('grocery (with cart)', render('grocery (with cart)', GroceryScreen), ['In cart · 1']);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
