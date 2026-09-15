/**
 * The file half of the offline estimate queue (0048) — a queued plate photo on
 * disk, waiting for a network.
 *
 * ## Why its own directory, and not `meal-photos/`
 *
 * `meal-photos/` is reconciled against the `meal_photos` table on every app
 * open, in BOTH directions: a row with no file is deleted, and **a file with no
 * row is deleted** (src/lib/media/meal-photo-store.ts). A queued photo has no
 * `meal_photos` row by construction — it is not a photo attached to a meal yet,
 * it is a model payload that has not been sent — so parking it there would have
 * it swept away on the next launch, which is exactly the launch the queue most
 * needs it. Two directories, two lifecycles.
 *
 * `pending-estimates/` gets its own reconcile pass ({@link sweepPendingEstimatePhotos}),
 * and it is deliberately ONE-DIRECTIONAL: a file with no row is an orphan and
 * goes, but a row whose file has vanished is LEFT ALONE. The row still carries
 * the typed description and the meal it belongs to, and the drainer degrades a
 * file-less photo request to a text one rather than deleting the user's meal
 * over a missing JPEG.
 *
 * The native seam is the shared {@link PhotoFileStore} (guarded
 * `expo-file-system` require, in-memory fake for the headless suites), so this
 * module owns no native import of its own.
 */
import type { Database } from '@/lib/db/database';
import {
  deletePendingEstimate,
  pendingEstimateFileNames,
} from '@/lib/db/repositories/pending-estimates';
import { nativeStoreIn, photoFileName, type PhotoFileStore } from '@/lib/media/photo-file-store';

export type { PhotoFileStore };

/** The queued-photo directory, relative to the app's Documents directory. */
export const PENDING_ESTIMATE_DIR = 'pending-estimates';

/** That directory's store, or null when `expo-file-system` is unreachable. */
export function nativePendingEstimateStore(): PhotoFileStore | null {
  return nativeStoreIn(PENDING_ESTIMATE_DIR);
}

/**
 * Park a downscaled JPEG for a queued estimate; returns its base name, or null
 * when nothing landed (no native module, a failed write).
 *
 * Null is not a failure the caller has to handle as one — the queue entry is
 * still written, carrying whatever the user typed, and the drainer sends that
 * as a description. A meal kept in words beats a meal thrown away.
 */
export function writePendingEstimatePhoto(
  base64Jpeg: string,
  store: PhotoFileStore | null = nativePendingEstimateStore()
): string | null {
  if (!store) return null;
  const fileName = photoFileName();
  return store.write(fileName, base64Jpeg) ? fileName : null;
}

/** The queued bytes back, or null when the file is gone or unreadable. */
export function readPendingEstimatePhoto(
  fileName: string | null,
  store: PhotoFileStore | null = nativePendingEstimateStore()
): string | null {
  if (!store || !fileName) return null;
  return store.readBase64(fileName);
}

/** Remove one queued file. Best-effort; the orphan pass covers a failure. */
export function removePendingEstimatePhoto(
  fileName: string | null,
  store: PhotoFileStore | null = nativePendingEstimateStore()
): void {
  if (!store || !fileName) return;
  store.remove(fileName);
}

export type PendingEstimateSweep = { orphanFilesRemoved: number };

/**
 * Reclaim queued files nothing claims any more — the meal was deleted, so the
 * row CASCADEd away and left the JPEG behind.
 *
 * One direction only, by design (see the header): a row whose file is missing
 * keeps its row.
 */
export function sweepPendingEstimatePhotos(
  db: Database,
  store: PhotoFileStore | null
): PendingEstimateSweep {
  if (!store) return { orphanFilesRemoved: 0 };
  const claimed = new Set(pendingEstimateFileNames(db));
  let orphanFilesRemoved = 0;
  for (const name of store.list()) {
    if (claimed.has(name)) continue;
    if (store.remove(name)) orphanFilesRemoved++;
  }
  return { orphanFilesRemoved };
}

/**
 * The app-open pass. Total and silent, like the meal-photo sweep beside it: it
 * swallows everything, including a database that has not reached 0048.
 */
export function runPendingEstimateSweep(db: Database): PendingEstimateSweep {
  try {
    return sweepPendingEstimatePhotos(db, nativePendingEstimateStore());
  } catch {
    return { orphanFilesRemoved: 0 };
  }
}

/** Drop a queue entry AND its file — the successful-drain teardown, in the one
 *  order that can only ever leak a file (which the sweep above reclaims). */
export function clearPendingEstimate(
  db: Database,
  pending: { id: string; file_name: string | null },
  store: PhotoFileStore | null = nativePendingEstimateStore()
): void {
  deletePendingEstimate(db, pending.id);
  removePendingEstimatePhoto(pending.file_name, store);
}
