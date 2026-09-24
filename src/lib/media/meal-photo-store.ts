/**
 * Meal photos on disk — the other half of `meal_photos` (0033).
 *
 * Owner request, 2026-08-12: *"when capturing a meal with a photo, that photo
 * should be attached to the meal to see. We can clear these after a few days to
 * save space."* Until now app/meal-estimate.tsx downscaled the shot, posted it
 * to the model and threw it away.
 *
 * ## The one rule this module exists to enforce
 *
 * **A row and its file live and die together.** Split across two stores, the
 * two failure modes are asymmetric and both bad:
 *
 *   - a row whose file has gone draws a broken frame on the meal, which is
 *     worse than no photo at all;
 *   - a file whose row has gone is invisible and permanent — disk leaked
 *     forever by a feature whose entire purpose is to save it.
 *
 * So exactly one module touches both sides. Writes go file-then-row and undo
 * the file if the row fails; deletes go row-then-file and are covered by the
 * sweep if the file survives. And {@link sweepMealPhotos} reconciles BOTH
 * directions on every app open, so the two can never disagree for longer than
 * one launch — the sweep is the invariant, not an optimisation on top of it.
 *
 * ## Native modules, guarded
 *
 * The file half lives behind {@link PhotoFileStore}
 * (src/lib/media/photo-file-store.ts), which owns the guarded `expo-file-system`
 * require and the in-memory-fake seam the headless suites drive the sweep
 * against. It was extracted there on 2026-08-12 when recipes gained a photo of
 * their own (0034) and needed the same store over a different directory. What
 * stayed here is everything that is about MEALS — chiefly the retention policy,
 * which recipes deliberately do not share.
 *
 * ## Retention
 *
 * {@link MEAL_PHOTO_RETENTION_DAYS}. See the constant for the number and why.
 */
import type { Database } from '@/lib/db/database';
import {
  allMealPhotos,
  deleteMealPhoto,
  expiredMealPhotos,
  insertMealPhoto,
  latestMealPhoto,
  restoreMeal,
  takeMeal,
  takenPendingFileNames,
  takenPhotoFileNames,
  type TakenMeal,
} from '@/lib/db/repositories/nutrition';
import { heldFiles, holdFiles, releaseFiles } from '@/lib/media/held-files';
import {
  nativePendingEstimateStore,
  removePendingEstimatePhoto,
} from '@/lib/media/pending-estimate-store';
import { nativeStoreIn, photoFileName, type PhotoFileStore } from '@/lib/media/photo-file-store';
import type { MealPhotoSource } from '@/lib/nutrition/types';

export type { PhotoFileStore };

/**
 * How long a meal photo is kept, in days.
 *
 * The owner said "a few days". **Seven**, for three reasons and against the
 * obvious alternatives:
 *
 *   - A week is the unit this app already reasons in — the mission is a day,
 *     the training block is a week, and "did I actually eat that on Tuesday?"
 *     is a question asked on Sunday, not on Tuesday. Three or four days would
 *     expire a Monday plate before the first weekend anyone reviews it.
 *   - It is a real bound on disk. The stored image is the same downscaled
 *     1024px q0.6 JPEG that went to the model — call it 150–250 KB — so even a
 *     photographed-every-meal week is single-digit megabytes, not the hundreds
 *     the request was worried about. Fourteen days would double that for a
 *     window nobody looks back across; the Eat tab's own history reads numbers,
 *     not pictures.
 *   - It is the shortest window that survives being away from the phone for a
 *     weekend, which is exactly when a meal gets logged and reviewed later.
 *
 * A named constant rather than a literal because it is a policy, and the next
 * person to change it should change it in one place and read this paragraph
 * first.
 */
export const MEAL_PHOTO_RETENTION_DAYS = 7;

/** The photo directory, relative to the app's Documents directory. */
export const MEAL_PHOTO_DIR = 'meal-photos';

/**
 * The meal photo directory's store, or null when `expo-file-system` is not
 * reachable. A thin binding of {@link nativeStoreIn} to {@link MEAL_PHOTO_DIR}
 * — the generic half lives in src/lib/media/photo-file-store.ts.
 */
export function nativePhotoStore(): PhotoFileStore | null {
  return nativeStoreIn(MEAL_PHOTO_DIR);
}

/** A downscaled JPEG on its way to disk — the shape both capture paths produce
 *  (src/lib/media/photo-library.ts). */
export type CapturedPhoto = {
  base64Jpeg: string;
  width: number | null;
  height: number | null;
  source: MealPhotoSource;
};

/**
 * Write a photo to disk and attach it to a meal. Returns the photo id, or null
 * when nothing was stored — a missing native module, a failed write, a rejected
 * row. Never throws: attaching a picture must not be able to fail a meal that
 * has already been saved.
 *
 * **File first, then row, and the file is removed if the row is rejected.** The
 * other order can leave a row pointing at nothing, which is the failure this
 * module is built to prevent; this order can at worst leak a file, which the
 * sweep's orphan pass reclaims on the next app open.
 */
export function attachMealPhoto(
  db: Database,
  mealId: string,
  photo: CapturedPhoto,
  store: PhotoFileStore | null = nativePhotoStore()
): string | null {
  if (!store) return null;
  const fileName = photoFileName();
  if (!store.write(fileName, photo.base64Jpeg)) return null;
  try {
    return insertMealPhoto(db, {
      meal_id: mealId,
      file_name: fileName,
      width: photo.width,
      height: photo.height,
      source: photo.source,
    });
  } catch (error) {
    console.warn('[meal-photo] row rejected; removing the file', error);
    store.remove(fileName);
    return null;
  }
}

/** What the meal screen needs to draw a photo. */
export type MealPhotoView = {
  uri: string;
  /** True pixel dimensions, so the frame is the photo's own aspect and nothing
   *  is cropped. Null when the source could not report them. */
  width: number | null;
  height: number | null;
  /** Whole days until the retention sweep clears it; 0 means "on next open". */
  clearsInDays: number;
};

/**
 * The meal's photo, ready to render — or null, which is the common case and
 * draws NOTHING on the meal screen (00-design-spec.md §5: no control that does
 * nothing, and a meal with no photo must not draw an empty frame).
 *
 * Null also covers a row whose file has gone. The sweep normally clears those,
 * but this read is what guarantees the screen never shows a broken image even
 * in the window before it runs.
 */
export function mealPhotoView(
  db: Database,
  mealId: string,
  now: Date = new Date(),
  store: PhotoFileStore | null = nativePhotoStore()
): MealPhotoView | null {
  if (!store) return null;
  const row = latestMealPhoto(db, mealId);
  if (!row) return null;
  if (!store.exists(row.file_name)) return null;
  const uri = store.uri(row.file_name);
  if (!uri) return null;
  return {
    uri,
    width: row.width,
    height: row.height,
    clearsInDays: daysUntilExpiry(row.created_at, now),
  };
}

/**
 * Whole days left before a photo taken at `createdAt` expires, clamped into
 * `[0, MEAL_PHOTO_RETENTION_DAYS]`.
 *
 * Rounded UP so the caption never promises less time than the sweep will
 * actually give: a photo with 0.4 days left reads "clears in 1 day" and is
 * still there tomorrow morning, where "clears in 0 days" beside a visible
 * picture reads as a bug.
 *
 * **Both clamps are load-bearing, and the upper one was found by a flaky test
 * rather than reasoned out.** `created_at` is stamped by SQLite's
 * `strftime('…','now')`, which reads a finer-grained clock than `Date.now()`
 * exposes on Windows (and on any platform whose timer granularity is coarser
 * than a millisecond). So a row written microseconds ago can parse a few
 * milliseconds AHEAD of the JS clock, `elapsed` comes out negative, and a photo
 * taken this instant reads "clears in 8 days" — not merely wrong but
 * impossible, since the window is seven. Elapsed time is never negative;
 * saying so here is cheaper than every caller remembering it.
 */
function daysUntilExpiry(createdAt: string, now: Date): number {
  const taken = Date.parse(createdAt);
  if (!Number.isFinite(taken)) return 0;
  const elapsedDays = Math.max(0, (now.getTime() - taken) / 86_400_000);
  const left = Math.ceil(MEAL_PHOTO_RETENTION_DAYS - elapsedDays);
  return Math.min(MEAL_PHOTO_RETENTION_DAYS, Math.max(0, left));
}

/**
 * Delete a meal and every file it owns, at once — the Coach's delete
 * (src/lib/ai/domains/read-domains.ts), which has its own confirmation card and
 * no Undo.
 *
 * `meals` CASCADEs to `meal_photos` (0033), which takes the rows and leaves the
 * bytes — so the names are read BEFORE the delete. It is literally
 * {@link takeMealWithPhotos} followed by {@link settleMealRemoval}: the same
 * removal the meal screen makes, with the Undo window closed on the spot, so
 * the two paths cannot drift apart (the parity rule, docs/coach-domains.md).
 */
export function deleteMealWithPhotos(
  db: Database,
  mealId: string,
  store: PhotoFileStore | null = nativePhotoStore()
): void {
  const taken = takeMealWithPhotos(db, mealId);
  if (taken) settleMealRemoval(taken, store);
}

/**
 * Delete a meal with the Undo window OPEN (owner, device, 2026-09-23: *"undo
 * for removing a food"*): its rows go now, through `takeMeal` →
 * `deleteMeal`, and its files stay — held, so no sweep mistakes them for
 * orphans — until {@link settleMealRemoval} or {@link restoreMealWithPhotos}
 * closes the window.
 *
 * **The rows go first, the files last, and that order is the crash story.** A
 * process killed inside the window loses the Undo and its holds; the rows are
 * already gone, so the next launch's sweep finds files no row claims and
 * removes them (db/nutrition-v2.test.mjs §57). The opposite order — files
 * first — is the one that could leave a surviving row drawing a broken frame.
 */
export function takeMealWithPhotos(db: Database, mealId: string): TakenMeal | null {
  const taken = takeMeal(db, mealId);
  if (taken) holdFiles([...takenPhotoFileNames(taken), ...takenPendingFileNames(taken)]);
  return taken;
}

/**
 * The Undo: the meal's rows back, verbatim (`restoreMeal`), onto files that
 * were never removed — then the hold is released, because rows claim the
 * files again. Throws, holding still, if the rows cannot go back; the caller
 * then settles, which removes the files the rows will never claim.
 */
export function restoreMealWithPhotos(db: Database, taken: TakenMeal): void {
  restoreMeal(db, taken);
  releaseFiles([...takenPhotoFileNames(taken), ...takenPendingFileNames(taken)]);
}

/**
 * The window closed without an Undo: remove the files the removal left, and
 * release them. The queued-estimate photo goes too — the pending directory's
 * own sweep would reclaim it on the next launch anyway (0057), but there is no
 * reason to carry it that long.
 */
export function settleMealRemoval(
  taken: TakenMeal,
  store: PhotoFileStore | null = nativePhotoStore(),
  pendingStore: PhotoFileStore | null = nativePendingEstimateStore()
): void {
  const photos = takenPhotoFileNames(taken);
  const pending = takenPendingFileNames(taken);
  releaseFiles([...photos, ...pending]);
  if (store) for (const name of photos) store.remove(name);
  for (const name of pending) removePendingEstimatePhoto(name, pendingStore);
}

/** What one sweep did — returned for the tests and the boot log, not for the UI. */
export type MealPhotoSweep = {
  /** Photos past the retention window: file removed, row removed. */
  expired: number;
  /** Rows whose file had vanished — dropped, so no meal draws a broken frame. */
  dangling: number;
  /** Files no row claimed — removed, so nothing leaks disk silently. */
  orphans: number;
};

const NO_SWEEP: MealPhotoSweep = { expired: 0, dangling: 0, orphans: 0 };

/**
 * Reconcile rows and files, and clear anything past the retention window.
 *
 * Three passes, in this order and for these reasons:
 *
 *   1. **Expire.** Rows older than the window: file first, then row. A crash
 *      between the two leaves a row with no file, which pass 2 already exists
 *      to clean up — where the reverse order would leave an orphan file that
 *      pass 3 would then have to catch on a *later* run, since pass 3 has
 *      already read its list by then.
 *   2. **Dangling rows.** Any surviving row whose file is missing (an OS purge,
 *      a restore from a backup that carried the database but not the media, a
 *      half-finished write). Dropping the row is what makes "a meal with no
 *      photo draws nothing" true instead of "draws a broken frame".
 *   3. **Orphan files.** Anything in the directory no row claims — the residue
 *      of a CASCADEd meal delete, or of a write whose row was rejected.
 *
 * Passes 2 and 3 are what make the invariant hold under crash, restore and
 * partial failure, rather than only under the happy path.
 *
 * Total and never throws — it runs on app open, where an exception has no
 * screen to land on. `now` is injectable so the headless test can age a photo
 * past the window without waiting a week.
 *
 * **`held` is not an orphan (2026-09-23).** A meal deleted with its Undo open
 * has no rows and still has its files ({@link takeMealWithPhotos}); pass 3
 * skips them. It runs once per launch today, before any Undo can exist, so
 * this matters only if the sweep ever runs mid-session — and then it is what
 * keeps an Undo from restoring rows onto files the sweep had just removed. A
 * fresh launch holds nothing, which is why a killed window's files still go.
 */
export function sweepMealPhotos(
  db: Database,
  store: PhotoFileStore | null,
  now: Date = new Date(),
  held: ReadonlySet<string> = heldFiles()
): MealPhotoSweep {
  if (!store) return NO_SWEEP;
  const cutoff = new Date(now.getTime() - MEAL_PHOTO_RETENTION_DAYS * 86_400_000).toISOString();
  const result: MealPhotoSweep = { expired: 0, dangling: 0, orphans: 0 };

  try {
    for (const row of expiredMealPhotos(db, cutoff)) {
      store.remove(row.file_name);
      deleteMealPhoto(db, row.id);
      result.expired++;
    }

    const claimed = new Set<string>();
    for (const row of allMealPhotos(db)) {
      if (store.exists(row.file_name)) {
        claimed.add(row.file_name);
        continue;
      }
      deleteMealPhoto(db, row.id);
      result.dangling++;
    }

    for (const name of store.list()) {
      if (claimed.has(name) || held.has(name)) continue;
      if (store.remove(name)) result.orphans++;
    }
  } catch (error) {
    console.warn('[meal-photo] sweep failed', error);
  }

  return result;
}

/**
 * The app-open entry point: sweep with the real store, swallowing everything.
 *
 * Called from app/_layout.tsx's boot effect, beside the reminder and health
 * syncs — the established home for fire-and-forget maintenance. Once per app
 * open is the right cadence for a disk-space policy: a session left in the
 * foreground for days defers its sweep to the next launch, which costs a few
 * hundred kilobytes and buys not having a timer running against the file system
 * for the life of the process.
 */
export function runMealPhotoSweep(db: Database): MealPhotoSweep {
  try {
    return sweepMealPhotos(db, nativePhotoStore());
  } catch (error) {
    console.warn('[meal-photo] sweep unavailable', error);
    return NO_SWEEP;
  }
}
