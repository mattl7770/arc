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
 * `expo-file-system` ships inside the current binary (it is a dependency of the
 * `expo` package itself, which is why the labs PDF picker was built on it) —
 * but it is still native, and this module is imported by app/_layout.tsx, a
 * route file. Expo Router eagerly loads every route to build its manifest, so a
 * module-scope throw here would break app STARTUP rather than one screen. Hence
 * the require lives in a function, in a try/catch, and its absence is a `null`
 * store that every caller already handles: no photo is written, no photo is
 * shown, and nothing crashes. That is also what lets the headless suites import
 * this file and drive the sweep against a fake store.
 *
 * ## Retention
 *
 * {@link MEAL_PHOTO_RETENTION_DAYS}. See the constant for the number and why.
 */
import type { Database } from '@/lib/db/database';
import {
  allMealPhotos,
  deleteMeal,
  deleteMealPhoto,
  expiredMealPhotos,
  insertMealPhoto,
  latestMealPhoto,
  mealPhotoFileNames,
} from '@/lib/db/repositories/nutrition';
import type { MealPhotoSource } from '@/lib/nutrition/types';

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
 * The file side, behind an interface.
 *
 * Not indirection for its own sake: the retention sweep is the part of this
 * feature most likely to be wrong (three passes, two stores, an ordering that
 * matters) and the part least testable on a device. Behind this seam it runs
 * against an in-memory fake in db/nutrition-v2.test.mjs with the REAL database
 * underneath, which is the same trade `MigrationExecutor` and {@link Database}
 * already make in this codebase.
 *
 * Every method is best-effort and total: no method throws, because a failure to
 * touch one file must never take down an app-open sweep.
 */
export type PhotoFileStore = {
  /** Base names currently in the photo directory ([] when it does not exist). */
  list(): string[];
  exists(name: string): boolean;
  /** True when the file is gone afterwards — including when it was already. */
  remove(name: string): boolean;
  /** Write a base64 JPEG under `name`; false if nothing landed. */
  write(name: string, base64Jpeg: string): boolean;
  /** A `file://` URI an `<Image>` can load, or null. */
  uri(name: string): string | null;
};

/** The slice of expo-file-system's File/Directory API this module uses. */
type FileHandle = {
  uri: string;
  exists: boolean;
  create(options?: { intermediates?: boolean; overwrite?: boolean }): void;
  write(content: string, options?: { encoding?: 'utf8' | 'base64' }): void;
  delete(): void;
};
type DirectoryHandle = {
  uri: string;
  exists: boolean;
  name: string;
  create(options?: { intermediates?: boolean; idempotent?: boolean }): void;
  list(): { name: string }[];
};
type FileSystemModule = {
  Paths: { document: unknown };
  File: new (...parts: unknown[]) => FileHandle;
  Directory: new (...parts: unknown[]) => DirectoryHandle;
};

/**
 * The module, or null on a runtime without it (the web logic-check preview, the
 * headless suites). Resolved lazily and never at import time — see the header.
 */
function loadFileSystem(): FileSystemModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-file-system') as Partial<FileSystemModule>;
    if (typeof mod.File !== 'function' || typeof mod.Directory !== 'function' || !mod.Paths) {
      return null;
    }
    return mod as FileSystemModule;
  } catch {
    return null;
  }
}

/**
 * The real store, or null when `expo-file-system` is not reachable.
 *
 * The directory is created on demand rather than at boot: a user who never
 * photographs a meal never gets an empty folder in their backup, and a create
 * that races itself is idempotent.
 */
export function nativePhotoStore(): PhotoFileStore | null {
  const fs = loadFileSystem();
  if (!fs) return null;

  const dir = (): DirectoryHandle => new fs.Directory(fs.Paths.document, MEAL_PHOTO_DIR);
  const file = (name: string): FileHandle => new fs.File(fs.Paths.document, MEAL_PHOTO_DIR, name);

  return {
    list() {
      try {
        const d = dir();
        if (!d.exists) return [];
        // Entries are File | Directory; ours only ever holds .jpg files, and
        // filtering on that keeps a stray subdirectory out of the orphan pass
        // (which would try to delete it as a file and fail every launch).
        return d
          .list()
          .map((entry) => entry.name)
          .filter((name) => typeof name === 'string' && name.endsWith('.jpg'));
      } catch {
        return [];
      }
    },
    exists(name) {
      try {
        return file(name).exists;
      } catch {
        return false;
      }
    },
    remove(name) {
      try {
        const f = file(name);
        if (!f.exists) return true;
        f.delete();
        return true;
      } catch {
        return false;
      }
    },
    write(name, base64Jpeg) {
      try {
        const d = dir();
        if (!d.exists) d.create({ intermediates: true, idempotent: true });
        const f = file(name);
        if (!f.exists) f.create({ intermediates: true });
        // `encoding: 'base64'` writes the DECODED bytes; without it the base64
        // text itself lands on disk and every reader gets a corrupt JPEG.
        f.write(base64Jpeg, { encoding: 'base64' });
        return f.exists;
      } catch {
        return false;
      }
    },
    uri(name) {
      try {
        return file(name).uri;
      } catch {
        return null;
      }
    },
  };
}

/**
 * A name for a new photo file.
 *
 * Deliberately NOT `newId(db)`: that one is minted by SQLite's `randomblob`
 * (src/lib/db/id.ts — Hermes has no `crypto` global) and it is the ROW's id,
 * which `insertMealPhoto` generates for itself. This only has to be a
 * collision-free base name, and 0033's UNIQUE on `file_name` is what makes that
 * enforceable rather than hoped for: a collision fails the insert, the write is
 * undone, and nothing is silently overwritten.
 */
function photoFileName(): string {
  const rand = () => Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${rand()}${rand()}.jpg`;
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
 * Delete a meal and every file it owns.
 *
 * `meals` CASCADEs to `meal_photos` (0033), which takes the rows and leaves the
 * bytes — so the names are read BEFORE the delete. This is the function the
 * meal screen calls instead of `deleteMeal` directly; a caller that forgets
 * leaks the file until the sweep's orphan pass reclaims it, which is a
 * self-healing mistake rather than a permanent one.
 */
export function deleteMealWithPhotos(
  db: Database,
  mealId: string,
  store: PhotoFileStore | null = nativePhotoStore()
): void {
  let names: string[] = [];
  try {
    names = mealPhotoFileNames(db, mealId);
  } catch (error) {
    // A database that predates 0033 has no such table. The meal must still
    // delete; the photos it cannot have are not a reason to keep it.
    console.warn('[meal-photo] could not read photo names', error);
  }
  deleteMeal(db, mealId);
  if (!store) return;
  for (const name of names) store.remove(name);
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
 */
export function sweepMealPhotos(
  db: Database,
  store: PhotoFileStore | null,
  now: Date = new Date()
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
      if (claimed.has(name)) continue;
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
