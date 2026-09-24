/**
 * Display formatting for the Nutrition screens. Hand-rolled (no Intl — Hermes
 * doesn't ship it) and pure, mirroring src/lib/exercise/format.ts. The
 * Data-tab keeps its own local formatters; these are the Nutrition family's.
 */
import { ML_PER_OZ } from '@/lib/log/metrics';
import type { VolumeUnit } from '@/lib/user/types';

import type { AmountUnit, MealItemWithServing } from './types';

/** 1840 → "1,840" — the one thousands comma, without leaning on Intl. */
export function fmtInt(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 1.5 → "1.5", 2 → "2" — quantities without trailing noise. */
export function fmtQty(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * A micronutrient amount: 0 decimals get the thousands comma (Sodium 1,850),
 * 1-decimal nutrients render fixed (Iron 12.4). Pure, Intl-free.
 */
export function fmtMicro(value: number, decimals: number): string {
  return decimals > 0 ? value.toFixed(decimals) : fmtInt(value);
}

/** "P 42g · C 30g · F 18g" from whatever macros a row actually recorded. */
export function macroLine(row: {
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
}): string | null {
  const parts: string[] = [];
  if (row.protein_g != null) parts.push(`P ${Math.round(row.protein_g)}g`);
  if (row.carbs_g != null) parts.push(`C ${Math.round(row.carbs_g)}g`);
  if (row.fat_g != null) parts.push(`F ${Math.round(row.fat_g)}g`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** One macro column on a meal row: the metric it belongs to, and what to print
 *  for it — or null when that macro was never recorded. */
export type MacroCell = {
  key: 'protein_g' | 'carbs_g' | 'fat_g';
  text: string | null;
};

/**
 * The same three macros {@link macroLine} joins, kept APART so the Eat tab can
 * lay them out as fixed columns down the day (C6). The cells are always three
 * and always in this order — a missing macro is a null cell, never a dropped
 * one, because a column that shifts left when a value is absent is not a column.
 *
 * `null` is "not recorded" and is drawn as nothing at all; a `0` is "measured
 * none" and prints as `0g`. They are different claims, and the schema keeps them
 * apart, so this does too.
 */
export function macroCells(row: {
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
}): MacroCell[] {
  return [
    { key: 'protein_g', text: row.protein_g == null ? null : `P ${Math.round(row.protein_g)}g` },
    { key: 'carbs_g', text: row.carbs_g == null ? null : `C ${Math.round(row.carbs_g)}g` },
    { key: 'fat_g', text: row.fat_g == null ? null : `F ${Math.round(row.fat_g)}g` },
  ];
}

/**
 * "250 ml" · "8.5 oz" · "150 g" — one amount printed in the unit it was logged
 * in (0047), with the Settings › Units volume preference applied to millilitres
 * exactly as it already is to water.
 *
 * **Grams are never touched by the preference.** The oz↔ml toggle is a VOLUME
 * preference; a gram amount has no second unit in this app and passing one
 * through here leaves it alone. And the conversion is display-only, at the last
 * possible moment — the stored number stays ml, which is what makes flipping the
 * toggle back lossless (src/lib/user/types.ts).
 *
 * `volume` defaults to `'ml'`, i.e. no conversion, so the pure/headless callers
 * (and anything that has no preference in hand) print the stored number.
 */
export function fmtAmount(amount: number, unit: AmountUnit, volume: VolumeUnit = 'ml'): string {
  if (unit === 'ml' && volume === 'oz') return `${fmtQty(amount / ML_PER_OZ)} oz`;
  return `${fmtQty(amount)} ${unit}`;
}

/**
 * "2 × 1 egg" · "2 × 3 slices" — a count of a catalog food's SERVING and the
 * serving's own phrase (0059), and the revision request's header tail
 * (`— 8 × slice, 3 parts`), which is the model's to read, not the owner's.
 *
 * The `×` is right for a serving: `'3 slices'` is a serving PHRASE, so two of
 * them is `2 × 3 slices`, six slices. It is wrong for a composite's count of
 * its own pieces, which the owner reads as a quantity — `3 × slice` read as
 * "three times slice" on the device (2026-09-23) — and that reads through
 * {@link piecesLabel} instead.
 */
export function countLabel(qty: number, noun: string): string {
  return `${fmtQty(qty)} × ${noun}`;
}

/** The food nouns whose plural none of {@link pluralNoun}'s rules reach. */
const IRREGULAR_PLURALS: Record<string, string> = {
  half: 'halves',
  leaf: 'leaves',
  loaf: 'loaves',
  potato: 'potatoes',
  tomato: 'tomatoes',
};

/**
 * "slice" → "slices" · "patty" → "patties" · "sandwich" → "sandwiches" ·
 * "piece of sushi" → "pieces of sushi" — the plural of ONE piece's noun.
 *
 * Deliberately small. The noun is stored in the singular (0059) — the model is
 * asked for the singular and the noun editor edits it — so four rules and five
 * named words cover the pieces people count: slices, wings, rolls, patties,
 * sandwiches, halves, potatoes. A noun that already ends in a single `s` is left
 * alone: it is either plural already (`fries`, `nachos`, or a noun typed as
 * `slices`) or a word no rule this size pluralises, and `3 slicess` is worse than
 * `3 fries`.
 */
export function pluralNoun(noun: string): string {
  // A compound with "of" pluralises its HEAD: pieces of sushi, not piece of sushis.
  const of = noun.indexOf(' of ');
  if (of > 0) return `${pluralNoun(noun.slice(0, of))}${noun.slice(of)}`;
  // Otherwise the last word takes it: chicken wing → chicken wings.
  const cut = noun.lastIndexOf(' ') + 1;
  const head = noun.slice(0, cut);
  const word = noun.slice(cut);
  const lower = word.toLowerCase();
  if (lower === '') return noun;
  const irregular = IRREGULAR_PLURALS[lower];
  // Keep a capital the noun was given: Half → Halves.
  if (irregular) return `${head}${word[0]}${irregular.slice(1)}`;
  if (/(ss|sh|ch|x|z)$/.test(lower)) return `${head}${word}es`;
  if (lower.endsWith('s')) return noun;
  if (/[^aeiou]y$/.test(lower)) return `${head}${word.slice(0, -1)}ies`;
  return `${head}${word}s`;
}

/**
 * The noun as it agrees with a count — singular only when the count PRINTS as
 * `1`, so `0.95` (which prints `1`) reads `1 slice`, and a count not yet known
 * reads plural: `of [ ] pieces`.
 */
export function pieceNounFor(count: number | null, noun: string): string {
  return count != null && fmtQty(count) === '1' ? noun : pluralNoun(noun);
}

/**
 * "3 slices" · "1 slice" · "2.7 slices" — a composite's count of its own pieces,
 * as a person says it (0059; re-cut on the owner's device note of 2026-09-23).
 *
 * **This is the dish's amount once it is counted.** The owner, on the phone:
 * *"grams are still being used as the unit of measurement, when it should've
 * changed to slices."* Every surface that prints a counted dish's amount prints
 * THIS, in the place its grams used to lead — the review sheet's header row, the
 * logged row's sub-line (through {@link portionLabel}), the Adjust screen's
 * "As logged" plate — and the grams, where they still earn a place, follow as a
 * secondary figure. One formatter, so the three cannot drift.
 *
 * `3 slices`, not `3 of 8 slices`: the eight is the photographed dish, which the
 * record never stores (the spike's rejected denominator — no migration), so a
 * label that needed it would read one way on the review and another after Save.
 * The review's own control still says `of [8]`, beside the number it qualifies.
 *
 * `fmtQty` rounds to one decimal, so a third of eight slices prints the honest
 * `2.7 slices` rather than a `3` the parts do not add up to.
 */
export function piecesLabel(count: number, noun: string): string {
  return `${fmtQty(count)} ${pieceNounFor(count, noun)}`;
}

/**
 * "2 × 1 egg (100 g)" · "3 slices (270 g)" · "1 × 1 can (330 ml)" · "150 g" —
 * the honest portion label. A count only reads with the name of what it counts,
 * so an item whose catalog food is gone (food_serving_name NULL) falls back to
 * the bare amount.
 *
 * **Two sources for that name, and they never mix** (0059). A composite HEADER
 * names its own piece in `piece_name` — it has no `food_id`, so the live serving
 * join can never reach it — and reads as a count of pieces, `3 slices`
 * ({@link piecesLabel}). A catalog item keeps naming the FOOD's serving through
 * that join, so correcting a serving name still reaches rows already logged, and
 * reads as servings, `2 × 1 egg` ({@link countLabel}). `piece_name` wins where
 * both somehow exist, because a row that has one is a header and a header's
 * `food_serving_name` is NULL by construction.
 *
 * The count LEADS and the amount follows in brackets: once a dish is counted its
 * unit is the piece, and the grams are the secondary figure.
 *
 * A counted header whose parts are in MIXED UNITS has no honest amount to print
 * (0058 invariant 5), and this prints the bare `3 slices` for it — which is then
 * the only whole-dish figure the row has.
 */
export function portionLabel(
  item: Pick<MealItemWithServing, 'amount' | 'unit' | 'serving_qty' | 'food_serving_name'> & {
    piece_name?: string | null;
  },
  volume: VolumeUnit = 'ml'
): string | null {
  const count =
    item.serving_qty == null
      ? null
      : item.piece_name != null
        ? piecesLabel(item.serving_qty, item.piece_name)
        : item.food_serving_name != null
          ? countLabel(item.serving_qty, item.food_serving_name)
          : null;
  if (count != null) {
    return item.amount != null ? `${count} (${fmtAmount(item.amount, item.unit, volume)})` : count;
  }
  if (item.amount != null) return fmtAmount(item.amount, item.unit, volume);
  return null;
}

/**
 * What to call the meal a scanned product creates (backlog A4).
 *
 * The owner's complaint: a barcode scan landed as *"Snack"*. That name came
 * from the clock — `daypartName(now)` in app/barcode-scan.tsx — and it was the
 * one thing on the record that the scan itself could have answered better than
 * anything else in the app. A barcode resolves to a product with a name and
 * usually a brand; the day part is a guess about the same meal that the
 * timestamp already carries, printed twice.
 *
 * `meals.name` is free `text` and `NOT NULL` (0002), so this must always return
 * something: it falls back to the day part when the product name is blank,
 * which is the pre-2026-09 behaviour and still better than an empty string the
 * schema would refuse.
 *
 * `name · brand`, in that order, because the name is what is being eaten and
 * the brand qualifies it — the same anatomy the scanner's own rows and the
 * portion plate already use, so the meal is titled the way it was chosen. The
 * brand is dropped when it merely repeats the name ("Oatly · Oatly").
 *
 * **Names the FIRST product only.** A second scan added to the same meal does
 * not rewrite the title: a meal called after the thing that started it is a
 * record; one that renames itself under the user is not. Renaming by hand stays
 * the way to change it (app/meal-detail.tsx → `updateMealName`), and that path
 * is untouched by this.
 */
export function mealNameForProduct(
  food: { name: string; brand?: string | null },
  fallback: string
): string {
  const name = food.name.trim();
  if (name === '') return fallback;
  const brand = (food.brand ?? '').trim();
  if (brand === '' || brand.toLowerCase() === name.toLowerCase()) return name;
  return `${name} · ${brand}`;
}

/**
 * The name to WRITE when a multi-scan meal's name field is left (owner, device,
 * 2026-09-23: *"meal name for scanning multiple foods"*) — or null, which means
 * write nothing.
 *
 * Null for an untouched field (`draft === null`), for one emptied (a meal keeps
 * its name; `updateMealName` refuses "" anyway), and for one that reads what the
 * meal is already called. So Done on a field nobody touched is a no-op, and the
 * default — the first product's name, {@link mealNameForProduct} — stands
 * without a write.
 */
export function mealNameToSave(draft: string | null, current: string): string | null {
  if (draft === null) return null;
  const trimmed = draft.trim();
  if (trimmed === '' || trimmed === current) return null;
  return trimmed;
}
