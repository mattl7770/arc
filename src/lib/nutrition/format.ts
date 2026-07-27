/**
 * Display formatting for the Nutrition screens. Hand-rolled (no Intl — Hermes
 * doesn't ship it) and pure, mirroring src/lib/exercise/format.ts. The
 * Data-tab keeps its own local formatters; these are the Nutrition family's.
 */
import type { MealItemWithServing } from './types';

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
 * "2 × 1 egg (100 g)" · "1 × 1 cup" · "150 g" — the honest portion label. A
 * serving count only reads with its serving's name, so an item whose catalog
 * food is gone (food_serving_name NULL) falls back to grams.
 */
export function portionLabel(
  item: Pick<MealItemWithServing, 'grams' | 'serving_qty' | 'food_serving_name'>
): string | null {
  if (item.serving_qty != null && item.food_serving_name != null) {
    const base = `${fmtQty(item.serving_qty)} × ${item.food_serving_name}`;
    return item.grams != null ? `${base} (${fmtQty(item.grams)} g)` : base;
  }
  if (item.grams != null) return `${fmtQty(item.grams)} g`;
  return null;
}
