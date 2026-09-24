/**
 * The name of a meal the barcode scanner built from several scans (owner,
 * device, 2026-09-23: *"meal name for scanning multiple foods"*) — when the
 * field is offered, and what leaving it writes. `app/barcode-scan.tsx` calls
 * both and decides nothing itself, so db/barcode.test.mjs §10 runs the screen's
 * own path rather than a replay of it.
 */
import type { Database } from '@/lib/db/database';
import { getMeal, updateMealName } from '@/lib/db/repositories/nutrition';
import { mealNameToSave } from './format';

/**
 * Whether the scanner shows its Meal name field: only once THIS session has
 * created the meal (`createdName` is its name then, null for a meal that
 * arrived by id — A4's rule, someone else's record) and put a second food
 * into it. One scan is still "the oat milk"; two are a meal.
 */
export function offersScanMealName(createdName: string | null, added: number): boolean {
  return createdName !== null && added >= 2;
}

/**
 * Write the typed name when it changes the meal's name AS THE DATABASE HOLDS
 * IT, through the meal screen's own `updateMealName`. Returns the name written,
 * or null when nothing was: an untouched, emptied or unchanged field
 * (`mealNameToSave`), or a meal no longer there.
 *
 * Comparing with the stored name, not the screen's copy of it, is what makes
 * the screen's several commit points — the field losing focus, Done, and the
 * unmount that follows Done — write a name once rather than once each.
 */
export function commitScanMealName(
  db: Database,
  mealId: string,
  draft: string | null
): string | null {
  const meal = getMeal(db, mealId);
  if (!meal) return null;
  const next = mealNameToSave(draft, meal.name);
  if (next === null) return null;
  updateMealName(db, mealId, next);
  return next;
}
