/**
 * Recipe photos on disk — the other half of `recipes.photo_file_name` (0034).
 *
 * Owner request, 2026-08-12: *"have the option to add a photo to the recipe."*
 *
 * ## The one rule this module exists to enforce, unchanged from meals
 *
 * **A row and its file live and die together.** Split across two stores, the
 * two failure modes are asymmetric and both bad: a name whose file has gone
 * draws a broken frame, and a file whose name has gone is disk leaked forever.
 * So exactly one module touches both sides. Writes go file-then-column and undo
 * the file if the column write fails; replacing a photo removes the old file in
 * the same call; and {@link sweepRecipePhotos} reconciles BOTH directions on
 * every app open.
 *
 * ## What is deliberately DIFFERENT from meal photos
 *
 * **There is no retention window.** A meal photo is evidence for an estimate
 * made that day and is cleared after a week (MEAL_PHOTO_RETENTION_DAYS). A
 * recipe is a living document the owner will open for years — a cookbook that
 * deletes its own pictures is broken. So the sweep here has two passes, not
 * three: dangling names and orphan files. Nothing expires.
 *
 * **One photo per recipe**, a column rather than a child table (see the 0034
 * header), so setting a new one replaces the old rather than accumulating.
 */
import type { Database } from '@/lib/db/database';
import { allRecipePhotoNames, getRecipe, setRecipePhotoName } from '@/lib/db/repositories/recipes';
import { nativeStoreIn, photoFileName, type PhotoFileStore } from '@/lib/media/photo-file-store';

/** The photo directory, relative to the app's Documents directory. */
export const RECIPE_PHOTO_DIR = 'recipe-photos';

/** The recipe photo directory's store, or null without `expo-file-system`. */
export function nativeRecipePhotoStore(): PhotoFileStore | null {
  return nativeStoreIn(RECIPE_PHOTO_DIR);
}

/**
 * Write a photo to disk and attach it to a recipe, replacing any existing one.
 * Returns the stored file name, or null when nothing landed (no native module,
 * a failed write, a rejected column). Never throws.
 *
 * **File first, then column, and the new file is removed if the column write is
 * rejected.** The other order can leave a name pointing at nothing, which is
 * the failure this module is built to prevent; this order can at worst leak a
 * file, which the sweep's orphan pass reclaims on the next app open.
 *
 * The OLD file is removed only after the column has successfully moved to the
 * new one — so a failure at any point leaves the recipe showing the picture it
 * had, never a gap.
 */
export function setRecipePhoto(
  db: Database,
  recipeId: string,
  base64Jpeg: string,
  store: PhotoFileStore | null = nativeRecipePhotoStore()
): string | null {
  if (!store) return null;
  const previous = getRecipe(db, recipeId)?.photo_file_name ?? null;
  const fileName = photoFileName();
  if (!store.write(fileName, base64Jpeg)) return null;
  try {
    setRecipePhotoName(db, recipeId, fileName);
  } catch (error) {
    console.warn('[recipe-photo] column rejected; removing the file', error);
    store.remove(fileName);
    return null;
  }
  if (previous && previous !== fileName) store.remove(previous);
  return fileName;
}

/** Detach and delete a recipe's photo. Column first, then the file: an orphan
 *  file is reclaimed by the sweep, a dangling name draws a broken frame. */
export function clearRecipePhoto(
  db: Database,
  recipeId: string,
  store: PhotoFileStore | null = nativeRecipePhotoStore()
): void {
  const previous = getRecipe(db, recipeId)?.photo_file_name ?? null;
  setRecipePhotoName(db, recipeId, null);
  if (previous && store) store.remove(previous);
}

/**
 * A `file://` URI for a recipe's photo, or null — which is both "no photo" and
 * "the file is gone", because a broken frame is worse than no frame.
 *
 * Null also covers a name whose file has vanished. The sweep normally clears
 * those, but this read is what guarantees the screen never shows a broken image
 * even in the window before it runs.
 */
export function recipePhotoUri(
  db: Database,
  recipeId: string,
  store: PhotoFileStore | null = nativeRecipePhotoStore()
): string | null {
  if (!store) return null;
  const name = getRecipe(db, recipeId)?.photo_file_name ?? null;
  if (!name) return null;
  if (!store.exists(name)) return null;
  return store.uri(name);
}

/** What one sweep did — for the tests and the boot log, not for the UI. */
export type RecipePhotoSweep = {
  /** Recipes whose photo file had vanished — the column is cleared, so no
   *  recipe draws a broken frame. */
  dangling: number;
  /** Files no recipe claimed — removed, so nothing leaks disk silently. */
  orphans: number;
};

const NO_SWEEP: RecipePhotoSweep = { dangling: 0, orphans: 0 };

/**
 * Reconcile names and files. Two passes, in this order:
 *
 *   1. **Dangling names.** Any recipe whose file is missing (an OS purge, a
 *      restore that carried the database but not the media, a half-finished
 *      write). Clearing the column is what makes "a recipe with no photo draws
 *      nothing" true instead of "draws a broken frame".
 *   2. **Orphan files.** Anything in the directory no recipe claims — the
 *      residue of a deleted recipe, or of a write whose column was rejected.
 *
 * Total and never throws: it runs on app open, where an exception has no screen
 * to land on. Deliberately has no expiry pass — see the header.
 */
export function sweepRecipePhotos(db: Database, store: PhotoFileStore | null): RecipePhotoSweep {
  if (!store) return NO_SWEEP;
  const result: RecipePhotoSweep = { dangling: 0, orphans: 0 };
  try {
    const claimed = new Set<string>();
    for (const row of allRecipePhotoNames(db)) {
      if (store.exists(row.photo_file_name)) {
        claimed.add(row.photo_file_name);
        continue;
      }
      setRecipePhotoName(db, row.id, null);
      result.dangling++;
    }
    for (const name of store.list()) {
      if (claimed.has(name)) continue;
      if (store.remove(name)) result.orphans++;
    }
  } catch (error) {
    console.warn('[recipe-photo] sweep failed', error);
  }
  return result;
}

/** The app-open entry point: sweep with the real store, swallowing everything.
 *  Called from app/_layout.tsx beside the meal-photo sweep. */
export function runRecipePhotoSweep(db: Database): RecipePhotoSweep {
  try {
    return sweepRecipePhotos(db, nativeRecipePhotoStore());
  } catch (error) {
    console.warn('[recipe-photo] sweep unavailable', error);
    return NO_SWEEP;
  }
}
