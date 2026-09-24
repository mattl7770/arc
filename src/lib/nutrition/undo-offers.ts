/**
 * Each food-log removal, done WITH its Undo — the one place a removal is paired
 * with the function that puts it back (owner, device, 2026-09-23: *"undo for
 * removing a food"*, *"some way to easily combine multiple food logs that are
 * the same meal"*).
 *
 * The screens call these and nothing lower: `app/meal-detail.tsx` for an item's
 * × and for Delete this meal, `app/nutrition.tsx` for Combine. Keeping the
 * pairing here, rather than in three screens' handlers, is what lets the
 * headless suite drive the same path the tap drives (db/nutrition-v2.test.mjs
 * §61) instead of rebuilding offers by hand: a removal whose Undo was wired to
 * the wrong restore, or to none, fails a test.
 *
 * Every write is still the repository's own (the parity rule,
 * docs/coach-domains.md): `takeMealItem` is `removeMealItem`, `takeMeal` is
 * `deleteMeal`, each having read what it deletes first.
 */
import type { Database } from '@/lib/db/database';
import {
  combineMeals,
  restoreMealItems,
  takeMealItem,
  uncombineMeals,
  type CombinedMeals,
  type TakenMeal,
  type TakenMealItems,
} from '@/lib/db/repositories/nutrition';
import {
  restoreMealWithPhotos,
  settleMealRemoval,
  takeMealWithPhotos,
  type PhotoFileStore,
} from '@/lib/media/meal-photo-store';
import { fmtInt } from './format';
import { offerUndo } from './undo-store';

const kcalFigure = (kcal: unknown): string | null =>
  typeof kcal === 'number' ? `${fmtInt(kcal)} kcal` : null;

/**
 * Remove one item from a meal — its × on the meal screen — and offer to put it
 * back on that meal's screen. A header takes its parts and a last part its
 * header (`removeMealItem`); the Undo puts back every row taken. Null when
 * there was no such item, and then nothing is offered.
 */
export function removeItemWithUndo(db: Database, itemId: string): TakenMealItems | null {
  const taken = takeMealItem(db, itemId);
  if (!taken) return null;
  offerUndo({
    scope: { on: 'meal', mealId: taken.mealId },
    icon: 'restaurant-outline',
    said: `Removed ${taken.name}`,
    figure: kcalFigure(taken.kcal),
    spoken: `Undo removing ${taken.name}`,
    refusal: `Could not put ${taken.name} back — the meal has changed since.`,
    undo: () => restoreMealItems(db, taken),
    // Items own no files: closing the window has nothing left to finish.
    settle: () => {},
  });
  return taken;
}

/**
 * Delete a whole meal — Delete this meal — and offer it back on the list of
 * the day it was logged on. Its rows go now; its photo files are held until the
 * offer closes, and removed then (src/lib/media/meal-photo-store.ts).
 *
 * `stores` is for the headless suite, which has no file system: the photo and
 * queued-estimate directories the settle removes files from. The app passes
 * nothing and gets the native ones.
 */
export function deleteMealWithUndo(
  db: Database,
  mealId: string,
  stores?: { photos: PhotoFileStore | null; pending: PhotoFileStore | null }
): TakenMeal | null {
  const taken = takeMealWithPhotos(db, mealId);
  if (!taken) return null;
  const name = String(taken.meal.name);
  offerUndo({
    scope: { on: 'list', date: String(taken.meal.date) },
    icon: 'restaurant-outline',
    said: `Deleted ${name}`,
    figure: kcalFigure(taken.meal.kcal),
    spoken: `Undo deleting ${name}`,
    refusal: `Could not put ${name} back.`,
    undo: () => restoreMealWithPhotos(db, taken),
    settle: () =>
      stores ? settleMealRemoval(taken, stores.photos, stores.pending) : settleMealRemoval(taken),
  });
  return taken;
}

/**
 * Combine several of one day's meals into one, named `typedName` when one was
 * typed, and offer to split them again on that day's list. Throws
 * `CombineRefused` (src/lib/nutrition/combine.ts), writing nothing and offering
 * nothing, when the combine is refused.
 */
export function combineWithUndo(
  db: Database,
  mealIds: readonly string[],
  typedName: string | null
): CombinedMeals {
  const combined = combineMeals(db, mealIds, { name: typedName });
  offerUndo({
    scope: { on: 'list', date: String(combined.kept.date) },
    icon: 'git-merge-outline',
    said: `Combined ${combined.count} meals into ${combined.name}`,
    figure: null,
    spoken: `Undo combining ${combined.count} meals into ${combined.name}`,
    refusal: `Could not split ${combined.name} back into ${combined.count} meals — it has changed since they were combined.`,
    undo: () => uncombineMeals(db, combined),
    // A combine deletes no file — its photos moved, and move back.
    settle: () => {},
  });
  return combined;
}
