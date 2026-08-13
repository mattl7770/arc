/**
 * Progress photos on disk — the other half of `progress_photos` (0036).
 *
 * The **third consumer** of the photo substrate that landed on 2026-08-12
 * (src/lib/media/photo-file-store.ts, extracted from meals when recipes became
 * its second). Nothing about the file mechanics is invented here: a directory
 * under the app's Documents folder, base names rather than paths, a store whose
 * every method is total, and reconciliation on app open. What lives here is the
 * part that is about PROGRESS photos.
 *
 * ## What is deliberately DIFFERENT from meal photos
 *
 * **There is no retention window, and that is the most important line in this
 * file.** A meal photo is evidence for one day's estimate and is cleared after
 * seven days (`MEAL_PHOTO_RETENTION_DAYS`). A progress photo is the record the
 * whole feature exists to keep — a gallery that deletes its own decade is not a
 * gallery. So the sweep here has two passes, not three: dangling names and
 * orphan files. Nothing expires.
 *
 * That is not merely un-implemented, it is unreachable: the meal sweep resolves
 * its store from `MEAL_PHOTO_DIR` and can only ever see files in
 * `meal-photos/`. db/progress-photos.test.mjs asserts the two constants differ
 * and that a meal sweep run against a populated progress directory removes
 * nothing, because "a different directory" is a fact worth a test.
 *
 * ## Two files per row, not one
 *
 * Every photo has a working copy; a photo flagged **important at pick time**
 * also has a full-resolution original. Both are claimed by the same row, so both
 * are read before a delete and both are collected by the sweep's claimed set —
 * an orphan pass that only knew about working copies would delete every original
 * on the next app open.
 */
import type { Database } from '@/lib/db/database';
import {
  allProgressPhotoFileNames,
  deleteProgressPhoto,
  insertProgressPhoto,
  progressPhotoFileNames,
} from '@/lib/db/repositories/progress-photos';
import { nativeStoreIn, photoFileName, type PhotoFileStore } from '@/lib/media/photo-file-store';
import type { NewProgressPhoto } from '@/lib/photos/types';

export type { PhotoFileStore };

/**
 * The photo directory, relative to the app's Documents directory.
 *
 * Documents, not `Library/` beside `arc.db` — the substrate's choice, and the
 * 2026-08-07 decision to keep `UIFileSharingEnabled` out of app.json is what
 * makes it private. Consistency with two shipped stores outranks this spec's
 * first-draft preference.
 */
export const PROGRESS_PHOTO_DIR = 'progress-photos';

/** The progress-photo directory's store, or null without `expo-file-system`. */
export function nativeProgressPhotoStore(): PhotoFileStore | null {
  return nativeStoreIn(PROGRESS_PHOTO_DIR);
}

/**
 * The working copy's size, in one place because it is a policy and not a tweak.
 *
 * **1600 px on the LONGEST edge, JPEG q0.7** — ~180–350 KB per photo, or roughly
 * 40–55 MB a year at three poses a week. That is the number the owner accepted
 * on 2026-08-12 when the "PhotoKit reference + thumbnail" letter was amended:
 * ~0.5 GB per decade, against the ~3 GB/decade food-photo budget the 2026-07-24
 * ADR already took. It buys a copy good enough to be the gallery cell, the
 * full-screen view, the fallback when the camera-roll original is gone, and the
 * source the 1024 px AI payload is made from.
 *
 * Anything smaller (the letter's 512 px thumbnail) degrades the WHOLE history to
 * thumbnails the first time this phone is restored onto another one.
 */
export const WORKING_COPY_EDGE = 1600;
export const WORKING_COPY_QUALITY = 0.7;

/**
 * The quality a full-resolution "important" copy is re-encoded at.
 *
 * Not 1.0: a q1.0 JPEG off a modern iPhone is 8–12 MB and visually
 * indistinguishable from q0.9 at half the size. It is still the original's full
 * PIXEL dimensions, which is the part that makes it worth keeping.
 */
export const ORIGINAL_COPY_QUALITY = 0.9;

/**
 * The bytes of one photo on its way to disk, as the import flow produced them.
 *
 * `original` is present only when the user flagged the photo important AT PICK
 * TIME — v1 cannot retro-fetch an original, because that needs
 * expo-media-library, which is not installed.
 */
export type CapturedProgressPhoto = {
  /** The 1600px working copy. Always present: it is what every surface draws. */
  workingBase64Jpeg: string;
  /** The full-resolution copy, when one was kept. */
  originalBase64Jpeg?: string | null;
} & Omit<NewProgressPhoto, 'working_file_name' | 'original_file_name'>;

/**
 * Write one photo's files and insert its row.
 *
 * **Files first, then the row, and every file written is removed if the row is
 * rejected.** The other order can leave a name pointing at nothing, which is the
 * failure this module exists to prevent; this order can at worst leak a file,
 * which the sweep's orphan pass reclaims on the next app open.
 *
 * Unlike the meal store's equivalent this one THROWS on a rejected row rather
 * than swallowing it. A meal photo is a garnish on a meal that is already saved,
 * so failing quietly costs a picture; here the photo IS the record, and a
 * silently-dropped import in a 30-photo backfill is a gallery with holes the
 * user will not notice for months. The caller ({@link importProgressPhotos})
 * turns the throw into a rolled-back batch.
 */
export function storeProgressPhoto(
  db: Database,
  photo: CapturedProgressPhoto,
  store: PhotoFileStore
): { id: string; fileNames: string[] } {
  const written: string[] = [];
  const workingName = photoFileName();
  if (!store.write(workingName, photo.workingBase64Jpeg)) {
    throw new Error('Could not write the photo to disk.');
  }
  written.push(workingName);

  let originalName: string | null = null;
  if (photo.originalBase64Jpeg) {
    const name = photoFileName();
    if (!store.write(name, photo.originalBase64Jpeg)) {
      // The working copy is already on disk; take it back out rather than
      // storing a row that half-kept its promise.
      store.remove(workingName);
      throw new Error('Could not write the full-size copy to disk.');
    }
    written.push(name);
    originalName = name;
  }

  try {
    const id = insertProgressPhoto(db, {
      taken_on: photo.taken_on,
      taken_at: photo.taken_at ?? null,
      pose: photo.pose,
      source: photo.source ?? 'library',
      asset_id: photo.asset_id ?? null,
      working_file_name: workingName,
      original_file_name: originalName,
      is_important: photo.is_important,
      notes: photo.notes ?? null,
    });
    return { id, fileNames: written };
  } catch (error) {
    for (const name of written) store.remove(name);
    throw error;
  }
}

/**
 * Import a batch as ONE unit: every row lands or none does, and every file
 * written by a batch that fails is taken back off disk.
 *
 * The transaction covers the rows; the file cleanup is explicit because the file
 * system has no transaction to enlist in. That asymmetry is the reason this
 * function exists instead of a loop at the call site — the rollback path is the
 * part that is easy to get wrong, and it belongs next to the writes.
 */
export function importProgressPhotos(
  db: Database,
  photos: CapturedProgressPhoto[],
  store: PhotoFileStore | null = nativeProgressPhotoStore()
): string[] {
  if (!store) throw new Error('Photo storage is not available in this build.');
  const ids: string[] = [];
  const written: string[] = [];
  try {
    db.transaction(() => {
      // Reset inside the transaction body: db.transaction may legitimately be
      // implemented as a retrying wrapper, and a second pass must not inherit
      // the first pass's ids.
      ids.length = 0;
      for (const photo of photos) {
        const stored = storeProgressPhoto(db, photo, store);
        ids.push(stored.id);
        written.push(...stored.fileNames);
      }
    });
  } catch (error) {
    for (const name of written) store.remove(name);
    throw error;
  }
  // Success, and one more sweep of our own: remove any file we wrote that no
  // committed row claims. Unreachable with today's plain BEGIN/COMMIT wrapper —
  // but `ids` is already reset per attempt on the hypothesis that
  // `db.transaction` might one day retry, and under that hypothesis the FIRST
  // attempt's files are exactly what this collects. Cheap, and it keeps the two
  // defences consistent instead of guarding the rows and forgetting the bytes.
  const kept = new Set(ids.flatMap((id) => progressPhotoFileNames(db, id)));
  for (const name of written) {
    if (!kept.has(name)) store.remove(name);
  }
  return ids;
}

/**
 * A `file://` URI for a stored name, or null — which covers both "no file" and
 * "the file is gone", because a broken frame is worse than an authored empty.
 *
 * The `exists` check is what guarantees the gallery never draws a broken image
 * even in the window before the sweep runs.
 */
export function progressPhotoUri(
  name: string | null,
  store: PhotoFileStore | null = nativeProgressPhotoStore()
): string | null {
  if (!store || !name) return null;
  if (!store.exists(name)) return null;
  return store.uri(name);
}

/**
 * Delete a photo and every file it owns.
 *
 * Row first (CASCADE takes its analyses), then the files. A file-delete failure
 * never orphans a row: an orphaned FILE is harmless and the sweep reclaims it,
 * while an orphaned ROW renders the authored "not on this phone" cell forever.
 *
 * **This never touches the Photos-library original.** ARC deletes its own copy.
 */
export function deleteProgressPhotoWithFiles(
  db: Database,
  id: string,
  store: PhotoFileStore | null = nativeProgressPhotoStore()
): void {
  let names: string[] = [];
  try {
    names = progressPhotoFileNames(db, id);
  } catch (error) {
    // A database that predates 0036 has no such table. The delete is still the
    // right outcome; files it cannot name are the sweep's problem.
    console.warn('[progress-photo] could not read file names', error);
  }
  deleteProgressPhoto(db, id);
  if (!store) return;
  for (const name of names) store.remove(name);
}

/** What one sweep did — for the tests and the boot log, not for the UI. */
export type ProgressPhotoSweep = {
  /** Rows whose WORKING copy had vanished. Counted, never deleted — see below. */
  dangling: number;
  /** Files no row claimed — removed, so nothing leaks disk silently. */
  orphans: number;
};

const NO_SWEEP: ProgressPhotoSweep = { dangling: 0, orphans: 0 };

/**
 * Reconcile rows and files. Two passes, deliberately NO expiry pass.
 *
 * ## The dangling pass counts; it does not delete
 *
 * This is the one place this store diverges from both of its siblings, and the
 * divergence is the point. When a meal or recipe photo's file vanishes, the row
 * is dropped: the photo was an attachment to a record that still exists without
 * it. Here the row IS the record — its date, its pose, its notes, and any AI
 * readings saved against it. Deleting it because a JPEG went missing would
 * destroy the history the feature exists to keep, and it would do so at exactly
 * the worst moment: a restore to a new phone that carried the database but not
 * the media directory would silently erase the entire gallery on first launch.
 *
 * So a row whose file is gone survives and renders the authored "Image not on
 * this phone" cell. The count is returned for the boot log; nothing acts on it.
 *
 * The orphan pass still runs, because a file no row claims is dead weight with
 * no such argument in its favour — and its claimed set includes BOTH names per
 * row, or every full-resolution original would be reclaimed on the next launch.
 *
 * Total and never throws: it runs on app open, where an exception has no screen
 * to land on.
 */
export function sweepProgressPhotos(
  db: Database,
  store: PhotoFileStore | null
): ProgressPhotoSweep {
  if (!store) return NO_SWEEP;
  const result: ProgressPhotoSweep = { dangling: 0, orphans: 0 };
  try {
    const claimed = new Set<string>();
    for (const row of allProgressPhotoFileNames(db)) {
      // EVERY name a row holds is claimed, unconditionally. `exists` is used
      // ONLY to count the gap, never to decide what may be deleted.
      //
      // This is not defensive style, it is a correctness fix. The claimed set
      // and the delete set come from two independent file-system probes —
      // `exists()` per name and `list()` over the directory — and both swallow
      // their exceptions and return a falsy answer (photo-file-store.ts). The
      // moment they disagree in the direction "exists said no, list said yes",
      // the pass below deletes a file a row still points at. For a meal photo
      // that costs a thumbnail; here it destroys a photograph ARC cannot
      // re-fetch, which is the whole premise of the storage design. Found by
      // adversarial review, 2026-08-12.
      claimed.add(row.working_file_name);
      if (row.original_file_name) claimed.add(row.original_file_name);
      if (!store.exists(row.working_file_name)) result.dangling++;
    }
    for (const name of store.list()) {
      if (claimed.has(name)) continue;
      if (store.remove(name)) result.orphans++;
    }
  } catch (error) {
    console.warn('[progress-photo] sweep failed', error);
  }
  return result;
}

/** The app-open entry point: sweep with the real store, swallowing everything.
 *  Called from app/_layout.tsx beside the meal and recipe photo sweeps. */
export function runProgressPhotoSweep(db: Database): ProgressPhotoSweep {
  try {
    return sweepProgressPhotos(db, nativeProgressPhotoStore());
  } catch (error) {
    console.warn('[progress-photo] sweep unavailable', error);
    return NO_SWEEP;
  }
}
