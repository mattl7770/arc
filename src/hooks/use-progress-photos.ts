import { useCallback, useMemo, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import {
  getProgressPhoto,
  groupPhotosByMonth,
  listPhotoAnalyses,
  listProgressPhotos,
  nearestWeighIn,
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

const POSE_ORDER: PhotoPose[] = ['front', 'side', 'back', 'other'];

function withUris(rows: ProgressPhotoRow[], store: PhotoFileStore | null): GalleryPhoto[] {
  return rows.map((row) => ({ ...row, uri: progressPhotoUri(row.working_file_name, store) }));
}

/**
 * The gallery's view model. Synchronous first read in the `useState`
 * initializer (op-sqlite is sync — no async, no spinner, the house pattern),
 * re-read on focus so an import or a delete is visible the moment you come back.
 *
 * The pose filter is applied in SQL rather than in JS so the index earns its
 * keep, and `total` is read unfiltered so the header can say "3 of 24" honestly.
 */
export function useProgressGallery(pose: PhotoPose | null): ProgressGallery {
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useFocusEffect(reload);

  return useMemo(() => {
    // `tick` is the dependency that makes this re-read; it is deliberately not
    // used in the body. Reading the store handle here too keeps a binary that
    // gains expo-file-system mid-session from being stuck with a null store.
    void tick;
    const db = getDb();
    const store = nativeProgressPhotoStore();
    const all = listProgressPhotos(db);
    const filtered = pose ? all.filter((row) => row.pose === pose) : all;
    const photos = withUris(filtered, store);
    const present = new Set(all.map((row) => row.pose));
    return {
      photos,
      months: groupPhotosByMonth(photos),
      total: all.length,
      posesPresent: POSE_ORDER.filter((p) => present.has(p)),
      reload,
    };
  }, [pose, tick, reload]);
}

export type PhotoDetail = {
  photo: GalleryPhoto | null;
  /** The full-resolution copy's URI, when one was kept at pick time. */
  originalUri: string | null;
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
  return useMemo(() => weightFormatter(), []);
}

function weightFormatter(): (kg: number) => string {
  const metric = metricByKey('weight');
  if (!metric) return (kg: number) => `${kg.toFixed(1)} kg`;
  const spec = resolveDisplay(metric, getPreferences(getDb()).units);
  return (kg: number) => formatMeasured(spec, kg);
}

/** One photo, everything the detail screen draws about it. */
export function useProgressPhoto(id: string | undefined): PhotoDetail {
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useFocusEffect(reload);
  const formatWeight = useWeightFormatter();

  return useMemo(() => {
    void tick;
    if (!id) {
      return {
        photo: null,
        originalUri: null,
        weighIn: null,
        weighInCaption: weighInCaption(null, formatWeight),
        analyses: [],
        reload,
      };
    }
    const db = getDb();
    const store = nativeProgressPhotoStore();
    const row = getProgressPhoto(db, id);
    if (!row) {
      return {
        photo: null,
        originalUri: null,
        weighIn: null,
        weighInCaption: weighInCaption(null, formatWeight),
        analyses: [],
        reload,
      };
    }
    const weighIn = nearestWeighIn(db, row.taken_on);
    return {
      photo: { ...row, uri: progressPhotoUri(row.working_file_name, store) },
      originalUri: progressPhotoUri(row.original_file_name, store),
      weighIn,
      weighInCaption: weighInCaption(weighIn, formatWeight),
      analyses: listPhotoAnalyses(db, id),
      reload,
    };
  }, [id, tick, reload, formatWeight]);
}
