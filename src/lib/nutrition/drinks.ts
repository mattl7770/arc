/**
 * Drinks — what Night out records when it asks "how many drinks?" (items 61
 * and 80, owner, 2026-10-21: *"social drinking status rework"*, *"social mode
 * rework"*).
 *
 * The owner's decision: Night out asks for a count, logs it as alcohol on the
 * day — grams and kcal — and tells the Coach and the next morning's readiness.
 * **Nothing deterministic changes a plan because of it**
 * (docs/information-architecture.md §Status: a status is a fact the user
 * states about themself; what to do about it is the Coach's call, every time).
 * So this file holds figures and words, and decides nothing.
 *
 * ## The record is an ordinary meal
 *
 * The drinks become one `meals` row on the day — "Night out · 4 drinks" — with
 * one item counted in pieces (0059: `serving_qty` 4, `piece_name` 'drink'),
 * measured in ml (0047: anything drunk), its macros the per-drink figures below
 * times the count, and its ethanol under `alcohol_g` in the item's micros JSON
 * (src/lib/nutrition/micros.ts argues why there). The kcal and carbs reach the
 * day's totals through the same sums every other meal does; meal-detail can
 * re-count it like `2 eggs`, and the alcohol scales with it. No new table, no
 * new column, no migration.
 *
 * ## The figures, and where they come from
 *
 * **A standard drink is 14 g of ethanol** — the US definition: NIAAA, *What Is
 * A Standard Drink?* ("roughly 14 grams of pure alcohol, which is found in 12
 * ounces of regular beer … 5 ounces of wine … 1.5 ounces of distilled
 * spirits"), the same 14 g the Dietary Guidelines for Americans 2020–2025 use.
 * Ethanol is 7 kcal/g (the Atwater general factor), so a standard drink carries
 * **≈ 98 kcal from the ethanol alone**, before any sugar in the glass.
 *
 * The stepper counts STANDARD drinks, so every drink records 14 g whatever its
 * kind: the count is the user's, in the unit the definition names, and
 * `drinks = grams / 14` stays exact in both directions. The KIND changes only
 * the rest of the glass — kcal and carbs — taken from USDA FoodData Central
 * (SR Legacy, public domain) for NIAAA's own serving of each:
 *
 *   Beer      12 fl oz (356 g)   NDB 14003  beer, regular, all:
 *                                43 kcal, 3.55 g carb, 0.46 g protein / 100 g
 *                                → 153 kcal, 12.6 g carb, 1.6 g protein
 *   Wine      5 fl oz (147 g)    NDB 14096  wine, table, red:
 *                                85 kcal, 2.61 g carb, 0.07 g protein / 100 g
 *                                → 125 kcal, 3.8 g carb, 0.1 g protein
 *   Spirits   1.5 fl oz (42 g)   NDB 14037  distilled, all (gin, rum, vodka,
 *                                whiskey), 80 proof: 231 kcal, 0 g carb / 100 g
 *                                → 97 kcal, 0 g carb
 *   Cocktail  derived — no FDC record stands for "a cocktail". One spirits
 *             serving above plus 4 fl oz (120 g) of a sugared mixer at the
 *             seed catalog's Cola row (0016, from FDC NDB 14400: 42 kcal,
 *             10.6 g carb / 100 g → 50 kcal, 12.7 g carb), i.e. a highball:
 *             → 147 kcal, 12.7 g carb. A cream or syrup cocktail runs higher;
 *             the item is editable on meal-detail like any other.
 *
 * Spirits read 97 kcal, a point under the 98 above, because SR Legacy
 * computes alcohol's energy at 6.93 kcal/g rather than the general 7 — the FDC
 * figure is kept as published rather than nudged to agree.
 *
 * Each FDC serving holds "roughly" 14 g of ethanol, not exactly (a 5 oz glass
 * of 12% wine is nearer 15 g), which is why the grams come from the definition
 * and not from each record — two sources for one number would disagree.
 *
 * Pure values — no React, no database, no clock — so db/statuses.test.mjs
 * asserts on it headlessly.
 */
import type { NewMealItem } from './types';

/** Grams of ethanol in one US standard drink (NIAAA). */
export const STANDARD_DRINK_G = 14;

/** kcal per gram of ethanol — the Atwater general factor. 14 × 7 = 98. */
export const ETHANOL_KCAL_PER_G = 7;

/** The stepper's bounds and its starting point (the owner's brief: 0 to ~20, default 2). */
export const DRINKS_MIN = 0;
export const DRINKS_MAX = 20;
export const DRINKS_DEFAULT = 2;

/** The noun the drinks item counts — 0059's `piece_name`. */
export const DRINK_PIECE = 'drink';

export type DrinkKind = 'beer' | 'wine' | 'spirits' | 'cocktail';

export type DrinkSpec = {
  kind: DrinkKind;
  /** The chip, and the item's name on meal-detail. */
  display: string;
  /** One serving, in ml — the item is measured in ml (0047: anything drunk). */
  ml: number;
  kcal: number;
  carbs_g: number;
  protein_g: number;
};

/** Per ONE standard drink. Sources in the file header. Fixed order — a control
 *  whose buttons move between taps is not a control. */
export const DRINK_KINDS: readonly DrinkSpec[] = [
  { kind: 'beer', display: 'Beer', ml: 355, kcal: 153, carbs_g: 12.6, protein_g: 1.6 },
  { kind: 'wine', display: 'Wine', ml: 148, kcal: 125, carbs_g: 3.8, protein_g: 0.1 },
  { kind: 'spirits', display: 'Spirits', ml: 44, kcal: 97, carbs_g: 0, protein_g: 0 },
  { kind: 'cocktail', display: 'Cocktail', ml: 164, kcal: 147, carbs_g: 12.7, protein_g: 0 },
];

/** What the stepper hands the store: how many standard drinks, of what. */
export type DrinksInput = { count: number; kind: DrinkKind };

export function drinkSpec(kind: DrinkKind): DrinkSpec {
  return DRINK_KINDS.find((spec) => spec.kind === kind) ?? DRINK_KINDS[0]!;
}

/** The kind an item was written as, read back from its name; null for anything else. */
export function drinkKindNamed(name: string): DrinkKind | null {
  return DRINK_KINDS.find((spec) => spec.display === name)?.kind ?? null;
}

/** A count the stepper can hold: a whole number inside its bounds. */
export function clampDrinks(count: number): number {
  if (!Number.isFinite(count)) return DRINKS_DEFAULT;
  return Math.min(DRINKS_MAX, Math.max(DRINKS_MIN, Math.round(count)));
}

/** "1 drink" / "4 drinks". */
export function drinksPhrase(count: number): string {
  const shown = Number.isInteger(count) ? String(count) : count.toFixed(1);
  return `${shown} drink${count === 1 ? '' : 's'}`;
}

/** The drinks meal's name — "Night out · 4 drinks". */
export function nightOutMealName(count: number): string {
  return `Night out · ${drinksPhrase(count)}`;
}

/** True for a name this file wrote, so a rename the user made is left alone. */
export function isNightOutMealName(name: string): boolean {
  return name === 'Night out' || /^Night out · \d+ drinks?$/.test(name);
}

/** The one item a count of drinks becomes. Count > 0; the caller decides 0. */
export function drinksItem(input: DrinksInput): NewMealItem {
  const spec = drinkSpec(input.kind);
  const n = clampDrinks(input.count);
  const round1 = (v: number) => Math.round(v * 10) / 10;
  return {
    name: spec.display,
    amount: spec.ml * n,
    unit: 'ml',
    serving_qty: n,
    piece_name: DRINK_PIECE,
    kcal: spec.kcal * n,
    protein_g: round1(spec.protein_g * n),
    carbs_g: round1(spec.carbs_g * n),
    fat_g: 0,
    micros: JSON.stringify({ alcohol_g: STANDARD_DRINK_G * n }),
  };
}

/** A day's alcohol, as the record holds it. */
export type DayAlcohol = { grams: number; drinks: number };

/** Grams → standard drinks, to one decimal (whole on every count the stepper wrote). */
export function drinksFromGrams(grams: number): number {
  return Math.round((grams / STANDARD_DRINK_G) * 10) / 10;
}

/**
 * The next morning's line, under the readiness pillars:
 * *"Alcohol last night — 4 standard drinks · 56 g"*. A fact in the register of
 * the pillar notes beside it — no verdict, no advice; the Recovery pillar is
 * graded exactly as it would be without it, and what the drinks mean for today
 * is the Coach's call.
 */
export function alcoholLastNightLine(fact: DayAlcohol | null): string | null {
  if (fact === null || fact.grams <= 0) return null;
  return `Alcohol last night — ${drinksPhrase(fact.drinks).replace('drink', 'standard drink')} · ${Math.round(fact.grams)} g`;
}

/**
 * The sentence Night out SENDS when it goes on — a fact, in his voice, and
 * nothing asked of the Coach beyond hearing it (the owner: *"NO automatic plan
 * changes"*). The other chips end in *"Check what's up and adjust
 * accordingly."*; this one does not, because a count of drinks is not a
 * request to rework the day. The Coach still reads it, with the day's drinks
 * in its state block, and whether anything changes is its call.
 */
export function nightOutPrompt(input: DrinksInput): string {
  const n = clampDrinks(input.count);
  if (n === 0) return 'Night out tonight — not drinking.';
  return `Night out tonight — ${drinksPhrase(n)} (${drinkSpec(input.kind).display.toLowerCase()}) so far.`;
}
