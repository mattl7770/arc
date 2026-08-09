/**
 * Quantity display merging for the grocery list's consolidated view — pure and
 * DB-free. Same-unit quantities sum ("2" + "3" → "5"; "1 cup" + "2 cup" →
 * "3 cup"); anything else is listed side by side ("4 cup + 100 g") — NEVER
 * cross-converted (density data nobody has; docs/recipes-grocery.md §2b).
 * Consolidation is a view: the member items stay intact underneath.
 */
import { formatQty, parseIngredientLine } from '@/lib/recipes/ingredients';

/**
 * Merge free-text quantity strings for display. Null/empty entries are
 * skipped; all-empty → null (the line shows no quantity at all).
 *
 * Members that are JUST a quantity (+ known unit) are summed per unit; members
 * with trailing words ("2 large", "1 dozen") or unparseable text are appended
 * verbatim, EVERY occurrence — never deduplicated, because dropping a repeated
 * "1 dozen" silently understates what to buy. So ['2 cup','2 cup','100 g'] →
 * "4 cup + 100 g" and ['1 dozen','1 dozen'] → "1 dozen + 1 dozen".
 */
export function mergeQtyTexts(texts: (string | null | undefined)[]): string | null {
  const present = texts.filter((t): t is string => typeof t === 'string' && t.trim() !== '');
  if (present.length === 0) return null;
  if (present.length === 1) return present[0]!;

  // unit (null = unitless) → summed quantity, in first-seen order.
  const sums = new Map<string | null, number>();
  const verbatim: string[] = [];
  for (const text of present) {
    const parsed = parseIngredientLine(text);
    // Summable only when the text is JUST a quantity (+ unit) — "2 large" has
    // a trailing word that summing would silently lose.
    if (parsed.qty === null || parsed.name !== null) {
      verbatim.push(text);
      continue;
    }
    sums.set(parsed.unit, (sums.get(parsed.unit) ?? 0) + parsed.qty);
  }
  const parts = [...sums.entries()].map(([unit, qty]) =>
    unit ? `${formatQty(qty)} ${unit}` : formatQty(qty)
  );
  return [...parts, ...verbatim].join(' + ');
}
