/**
 * Each food-log removal, done WITH its Undo — the one place a removal is paired
 * with the function that puts it back (owner, device, 2026-09-23: *"undo for
 * removing a food"*, *"some way to easily combine multiple food logs that are
 * the same meal"*).
 *
 * The screens call these and nothing lower: `app/meal-detail.tsx` for an item's
 * × and for Delete this meal, `app/nutrition.tsx` for Combine, and
 * `app/food-search.tsx` for a catalog food's Delete (2026-09-25), and every
 * path that logs a NEW meal for the join to a meal near it (2026-10-21, item
 * 58: Add food, the scanner, the estimate, manual entry). Keeping the
 * pairing here, rather than in the screens' handlers, is what lets the
 * headless suite drive the same path the tap drives (db/nutrition-v2.test.mjs
 * §61, db/foods.test.mjs) instead of rebuilding offers by hand: a removal whose
 * Undo was wired to the wrong restore, or to none, fails a test.
 *
 * Every write is still the repository's own (the parity rule,
 * docs/coach-domains.md): `takeMealItem` is `removeMealItem`, `takeMeal` is
 * `deleteMeal`, `takeFood` is `deleteFood` — the function the Coach's
 * `food_catalog` removal calls — each having read what it deletes first.
 */
import type { Database } from '@/lib/db/database';
import { restoreFood, takeFood, type TakenFood } from '@/lib/db/repositories/foods';
import { pendingEstimateMealIds } from '@/lib/db/repositories/pending-estimates';
import {
  combineMeals,
  getMeal,
  listTodayMeals,
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
import { mealToJoin } from './auto-join';
import { CombineRefused } from './combine';
import type { MealRow } from './types';
import { fmtInt } from './format';
import { offerUndo, removalWords } from './undo-store';

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
    // The same words as a draft row's × on the estimate review (review-undo.ts).
    ...removalWords(taken.name, taken.kcal),
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

/** Where a just-logged food went, when it joined a meal (item 58). */
export type JoinedMeal = {
  /** The meal the food now lives in — the combine's kept row. */
  keptId: string;
  /** The meal the food was logged as, which the Undo puts back. */
  createdId: string;
  /** That meal's name as logged, for the screen that made it. */
  createdName: string;
  /** The name the joined meal keeps: the existing meal's. */
  name: string;
  /** The joined meal's time. */
  time: string | null;
  combined: CombinedMeals;
};

/**
 * A meal just logged as a NEW meal — a food from Add food, a scan, an estimate,
 * a manual entry — joins the meal logged nearest it on the same day, within
 * 45 minutes (`AUTO_JOIN_MINUTES`, src/lib/nutrition/auto-join.ts; owner,
 * device round 3, item 58), and the join is offered back on that day's list: *Added to Lunch · 12:40 · Undo*.
 *
 * It is the round-8 combine, not a second mechanism: `combineMeals` merges the
 * two (keeping the EXISTING meal's name — the owner's call), and the Undo is
 * `uncombineMeals`, which puts the new meal back exactly as it was logged — its
 * id, its row, its items — and refuses when the joined meal has changed since.
 * Null, writing nothing, when no meal is near enough or the combine refuses
 * (a recipe on each) or fails: the food then stays its own meal, which is what
 * it was before this existed. It never throws.
 *
 * `dayStartsAt` is for the headless suite; the app passes nothing and gets the
 * installed boundary.
 */
export function joinNearbyMealWithUndo(
  db: Database,
  createdId: string,
  dayStartsAt?: string
): JoinedMeal | null {
  let created: MealRow | undefined;
  let combined: CombinedMeals;
  try {
    created = getMeal(db, createdId);
    if (!created) return null;
    const target = mealToJoin(listTodayMeals(db, created.date), created, {
      pending: pendingEstimateMealIds(db, created.date),
      dayStartsAt,
    });
    if (!target) return null;
    combined = combineMeals(db, [target.id, created.id], { name: target.name });
  } catch (error) {
    // Refused (a recipe on each), or a write that failed and rolled back in
    // its transaction: either way the food stays the meal it was logged as,
    // which is never worse than before this existed — so it never throws into
    // a save that has already succeeded.
    if (!(error instanceof CombineRefused)) console.warn('[undo] join failed', error);
    return null;
  }
  const time = typeof combined.result.meal.time === 'string' ? combined.result.meal.time : null;
  offerUndo({
    scope: { on: 'list', date: created.date },
    icon: 'git-merge-outline',
    said: `Added to ${combined.name}`,
    figure: time,
    spoken: `Undo adding ${created.name} to ${combined.name}`,
    refusal: `Could not split ${created.name} back out — ${combined.name} has changed since.`,
    undo: () => uncombineMeals(db, combined),
    // A join deletes no file — a photo moved with its meal, and moves back.
    settle: () => {},
  });
  return {
    keptId: combined.keptId,
    createdId: created.id,
    createdName: created.name,
    name: combined.name,
    time,
    combined,
  };
}

/**
 * Delete a catalog food — its Delete on Add food (owner, 2026-09-25: *"Add a
 * delete to the food's own screen, so you and the Coach can both do it."*) —
 * and offer it back on that screen. The row and every link to it come back
 * exactly (`restoreFood`); a food whose barcode was cached again meanwhile
 * cannot, and the row says so. Null when there was no such food.
 */
export function deleteFoodWithUndo(db: Database, foodId: string): TakenFood | null {
  const taken = takeFood(db, foodId);
  if (!taken) return null;
  const name = String(taken.food.name);
  offerUndo({
    scope: { on: 'catalog' },
    icon: 'restaurant-outline',
    said: `Deleted ${name} from the catalog`,
    figure: null,
    spoken: `Undo deleting ${name}`,
    refusal: `Could not put ${name} back in the catalog.`,
    undo: () => restoreFood(db, taken),
    // A food owns no files.
    settle: () => {},
  });
  return taken;
}
