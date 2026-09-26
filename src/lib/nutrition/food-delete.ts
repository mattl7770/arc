/**
 * What deleting a catalog food does, in words — pure and DB-free, so the line
 * Add food shows before the delete and the Coach's card for the same act say
 * one thing and cannot disagree (owner, 2026-09-25: *"Add a delete to the
 * food's own screen, so you and the Coach can both do it."*).
 *
 * The fact it states is a foreign-key fact: every reference to `foods (id)` is
 * `ON DELETE SET NULL` (meal items 0014, template items 0018, recipe lines 0031,
 * grocery lines 0032), and every one of those rows carries its own snapshot of
 * the figures. So nothing that logged the food changes a number. It only stops
 * linking to the catalog entry.
 *
 * One thing on screen does change, and the line says so rather than letting
 * "keep their own numbers" imply nothing moves: a meal item counted in the
 * food's serving ("2 × 1 egg (100 g)") reads its serving name through a live
 * join, so after the delete it shows the amount alone ("100 g"). See
 * `FoodUsage.counted`.
 */
import type { FoodUsage } from '@/lib/db/repositories/foods';

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** "a", "a and b", "a, b and c". */
function spoken(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * "used by 3 meals and 1 template, which keep their own numbers" — or, for
 * one, "…, which keeps its own numbers" — or null when nothing used it. When a
 * logged item counted the food's serving, it adds what that item will show:
 * "…; 2 items counted in its serving will show their amount without the
 * count". The Coach's card appends this after the food's figures.
 */
export function foodKeptPhrase(usage: FoodUsage): string | null {
  const counts = [
    [usage.meals, 'meal'],
    [usage.templates, 'template'],
    [usage.recipes, 'recipe'],
  ] as const;
  const used = counts.filter(([n]) => n > 0);
  if (used.length === 0) return null;
  const one = used.length === 1 && used[0]![0] === 1;
  const kept = `used by ${spoken(used.map(([n, noun]) => plural(n, noun)))}, ${
    one ? 'which keeps its own numbers' : 'which keep their own numbers'
  }`;
  const counted = usage.counted;
  if (!(counted > 0)) return kept;
  return `${kept}; ${plural(counted, 'item')} counted in its serving will show ${
    counted === 1 ? 'its' : 'their'
  } amount without the count`;
}

/**
 * The consequence line under an armed Delete on Add food: what goes, and what
 * stays. "Deletes “Oats” from the catalog. It is used by 3 meals, which keep
 * their own numbers."
 */
export function foodDeleteConsequence(name: string, usage: FoodUsage): string {
  const kept = foodKeptPhrase(usage);
  return `Deletes “${name}” from the catalog. ${
    kept === null ? 'No meal, template or recipe uses it.' : `It is ${kept}.`
  }`;
}
