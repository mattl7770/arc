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
 * "2 × 1 egg (100 g)" · "1 × 1 can (330 ml)" · "1 × 1 cup" · "150 g" — the
 * honest portion label. A serving count only reads with its serving's name, so
 * an item whose catalog food is gone (food_serving_name NULL) falls back to the
 * bare amount.
 */
export function portionLabel(
  item: Pick<MealItemWithServing, 'amount' | 'unit' | 'serving_qty' | 'food_serving_name'>,
  volume: VolumeUnit = 'ml'
): string | null {
  if (item.serving_qty != null && item.food_serving_name != null) {
    const base = `${fmtQty(item.serving_qty)} × ${item.food_serving_name}`;
    return item.amount != null ? `${base} (${fmtAmount(item.amount, item.unit, volume)})` : base;
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
