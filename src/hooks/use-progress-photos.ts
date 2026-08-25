import { useCallback, useMemo, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import {
  distinctPoses,
  getProgressPhoto,
  groupPhotosByMonth,
  listPhotoAnalyses,
  listProgressPhotos,
  nearestWeighIn,
  progressPhotoCount,
} from '@/lib/db/repositories/progress-photos';
import { getPreferences } from '@/lib/db/repositories/user';
import { formatMeasured, metricByKey, resolveDisplay } from '@/lib/log/metrics';
import {
  nativeProgressPhotoStore,
  progressPhotoUri,
  type PhotoFileStore,
} from '@/lib/media/progress-photo-store';
import { weighInCaption } from '@/lib/photos/format';
import type {
  NearestWeighIn,
  PhotoMonth,
  PhotoPose,
  ProgressPhotoAnalysisRow,
  ProgressPhotoRow,
} from '@/lib/photos/types';

/**
 * A row paired with the `file://` URI its working copy resolves to **right
 * now** — null when the file is not on this phone.
 *
 * The pairing happens once, next to the read, rather than per cell during
 * render: `store.exists` is a synchronous file-system stat, and doing one per
 * cell on every scroll frame is how a gallery starts stuttering.
 */
export type GalleryPhoto = ProgressPhotoRow & { uri: string | null };

export type ProgressGallery = {
  /** Every photo, newest shutter-day first, after the pose filter. */
  photos: GalleryPhoto[];
  /** The same photos grouped into months, newest month first. */
  months: PhotoMonth<GalleryPhoto>[];
  /** The whole gallery's size, ignoring the filter — the header's true tally. */
  total: number;
  /** Which poses exist at all, so the filter row offers only real choices. */
  posesPresent: PhotoPose[];
  reload: () => void;
};

function withUris(rows: ProgressPhotoRow[], store: PhotoFileStore | null): GalleryPhoto[] {
  return rows.map((row) => ({ ...row, uri: progressPhotoUri(row.working_file_name, store) }));
}

function readGallery(pose: PhotoPose | null): Omit<ProgressGallery, 'reload'> {
  const db = getDb();
  // Resolved per read, not per mount: a binary that gains expo-file-system
  // mid-session should not be stuck with the null store it booted with.
  const store = nativeProgressPhotoStore();
  const photos = withUris(listProgressPhotos(db, pose ?? undefined), store);
  return {
    photos,
    months: groupPhotosByMonth(photos),
    // Unfiltered, and its own COUNT rather than a second full read — the header
    // says "3 of 24" and the 24 must come from outside the filtered list.
    total: progressPhotoCount(db),
    posesPresent: distinctPoses(db),
  };
}

/**
 * The gallery's view model. Synchronous first read in the `useState`
 * initializer (op-sqlite is sync — no async, no spinner), re-read on focus so an
 * import or a delete is visible the moment you come back.
 *
 * **`useState(read)` + `setState(read())`, not a tick counter in a `useMemo`.**
 * This is the pattern every other data hook in the app uses (`use-experiments`,
 * `use-exercise`, and a dozen more), and it is the pattern here for a concrete
 * reason: `reactCompiler` is on (app.json), the compiler re-derives a `useMemo`'s
 * dependencies from the code rather than trusting the written array, and a
 * counter that is read only as `void tick` is precisely the shape dead-code
 * elimination removes — after which `reload()` would bump state, re-render, and
 * hand back the cached value forever. Found by adversarial review, 2026-08-12.
 *
 * The pose filter is applied in SQL, so `progress_photos_pose_taken_idx` serves
 * a query that exists. `reload` depends on `pose`, so changing the filter
 * re-subscribes `useFocusEffect` and re-reads — one mechanism, not two.
 */
export function useProgressGallery(pose: PhotoPose | null): ProgressGallery {
  const [state, setState] = useState(() => readGallery(pose));
  const reload = useCallback(() => setState(readGallery(pose)), [pose]);
  useFocusEffect(reload);
  return { ...state, reload };
}

export type PhotoDetail = {
  photo: GalleryPhoto | null;
  /**
   * The full-resolution copy's URI — non-null **only when that file is actually
   * on this phone**, since it comes through `progressPhotoUri`'s `exists` check.
   * This, not `original_file_name`, is what the screen must test before claiming
   * a full-size original is kept: after a restore that carried the database and
   * not the media, the name survives and the file does not.
   */
  originalUri: string | null;
  /** The other photo of each saved pair reading, by id — so a comparison can
   *  name what it was compared against. */
  counterparts: Record<string, ProgressPhotoRow>;
  weighIn: NearestWeighIn | null;
  /** The weigh-in rendered in the user's units, distance clause and all. */
  weighInCaption: string;
  analyses: ProgressPhotoAnalysisRow[];
  reload: () => void;
};

/**
 * Format a canonical weight the way every other surface in the app does —
 * through the metric descriptor and the user's unit preference, never with a
 * hard-coded "kg".
 */
export function useWeightFormatter(): (kg: number) => string {
  // Built by a module-level factory rather than inline: a `useMemo` whose
  // callback both branches AND returns a function is one the React Compiler
  // refuses to preserve, and the lint rule that catches that is an error here.
  //
  // Keyed on the current unit preference, not `[]`: an empty-deps formatter is
  // built once per mount and never recomputes, so switching kg→lb in Settings
  // and popping back to a still-mounted detail rendered the caption in the old
  // unit until remount. The preference change flows through the dep, which also
  // re-keys `reload` and re-reads. Found by adversarial review.
  const units = getPreferences(getDb()).units;
  return useMemo(() => weightFormatter(), [units]);
}

function weightFormatter(): (kg: number) => string {
  const metric = metricByKey('weight');
  if (!metric) return (kg: number) => `${kg.toFixed(1)} kg`;
  const spec = resolveDisplay(metric, getPreferences(getDb()).units);
  return (kg: number) => formatMeasured(spec, kg);
}

function readPhoto(
  id: string | undefined,
  formatWeight: (kg: number) => string
): Omit<PhotoDetail, 'reload'> {
  const empty = {
    photo: null,
    originalUri: null,
    counterparts: {},
    weighIn: null,
    weighInCaption: weighInCaption(null, formatWeight),
    analyses: [],
  };
  if (!id) return empty;
  const db = getDb();
  const store = nativeProgressPhotoStore();
  const row = getProgressPhoto(db, id);
  if (!row) return empty;
  const weighIn = nearestWeighIn(db, row.taken_on);
  const analyses = listPhotoAnalyses(db, id);
  // The OTHER photo of every pair reading, by id. A comparison shown on the
  // January photo says "leaner through the waist" about August; without the
  // counterpart's date the arrow points nowhere the reader can see.
  const counterparts: Record<string, ProgressPhotoRow> = {};
  for (const analysis of analyses) {
    const otherId = analysis.photo_id === id ? analysis.compare_photo_id : analysis.photo_id;
    if (!otherId || counterparts[otherId]) continue;
    const other = getProgressPhoto(db, otherId);
    if (other) counterparts[otherId] = other;
  }
  return {
    photo: { ...row, uri: progressPhotoUri(row.working_file_name, store) },
    originalUri: progressPhotoUri(row.original_file_name, store),
    counterparts,
    weighIn,
    weighInCaption: weighInCaption(weighIn, formatWeight),
    analyses,
  };
}

/** One photo, everything the detail screen draws about it. Same
 *  `useState(read)` + `setState(read())` shape as the gallery, for the same
 *  React-Compiler reason — see {@link useProgressGallery}. */
export function useProgressPhoto(id: string | undefined): PhotoDetail {
  const formatWeight = useWeightFormatter();
  const [state, setState] = useState(() => readPhoto(id, formatWeight));
  const reload = useCallback(() => setState(readPhoto(id, formatWeight)), [id, formatWeight]);
  useFocusEffect(reload);
  return { ...state, reload };
}
