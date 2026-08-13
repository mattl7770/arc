/**
 * Types for the progress-photo gallery, mirroring
 * db/migrations/0035_progress_photos.sql — see docs/progress-photos-subapp.md.
 * Kept beside the feature (the nutrition/recipes-types pattern): hand-authored,
 * lockstep with the schema.
 */
import type { DateString, SqliteBool, Timestamp } from '@/lib/db/types';

/**
 * The four poses, a genuinely closed set (0035's CHECK). `other` plus the notes
 * field is what covers everything the four do not — deliberately, because
 * widening the CHECK later is a parent-table rebuild with a child to shuttle.
 */
export type PhotoPose = 'front' | 'side' | 'back' | 'other';

/** Where the pixels came from. `camera` is unreachable in v1 (library-pick
 *  only, owner call 2026-08-12) and exists so v2 needs no rebuild. */
export type PhotoSource = 'library' | 'camera';

/** A `progress_photos` row as SELECT returns it. */
export type ProgressPhotoRow = {
  id: string;
  /** The LOCAL day of the shutter, never of the import. */
  taken_on: DateString;
  /** The instant, when EXIF supplied one. No data, no number. */
  taken_at: Timestamp | null;
  pose: PhotoPose;
  source: PhotoSource;
  /** PhotoKit localIdentifier. Dormant provenance — written, never read for
   *  behaviour in v1; the dedupe index is what uses it. */
  asset_id: string | null;
  /** Bare file name of the 1600px working copy in the progress-photos store. */
  working_file_name: string;
  /** Bare file name of the full-resolution copy, when one was kept at pick time. */
  original_file_name: string | null;
  is_important: SqliteBool;
  notes: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/** What an insert supplies. Ids and timestamps come from the app / DB defaults. */
export type NewProgressPhoto = {
  taken_on: DateString;
  taken_at?: Timestamp | null;
  pose: PhotoPose;
  source?: PhotoSource;
  asset_id?: string | null;
  working_file_name: string;
  original_file_name?: string | null;
  is_important?: boolean;
  notes?: string | null;
};

/** The fields the detail screen may change after the fact. */
export type ProgressPhotoEdit = {
  taken_on?: DateString;
  pose?: PhotoPose;
  notes?: string | null;
  is_important?: boolean;
};

/** Which way a body area moved between two photos, in the model's words. */
export type ChangeDirection = 'leaner' | 'fuller' | 'unchanged' | 'unclear';

export type PhotoObservation = { area: string; note: string };
export type PhotoChange = { area: string; direction: ChangeDirection; note: string };

/** A `progress_photo_analyses` row as SELECT returns it. */
export type ProgressPhotoAnalysisRow = {
  id: string;
  /** The photo — for a pair reading, the EARLIER one. */
  photo_id: string;
  /** The later photo of a pair reading; NULL for a single-photo reading. */
  compare_photo_id: string | null;
  model: string;
  summary: string;
  /** JSON array of {@link PhotoObservation}. */
  observations: string | null;
  /** JSON array of {@link PhotoChange}; pair readings only. */
  changes: string | null;
  /** Mandatory by contract and NOT NULL in the schema — lighting/pose/angle are
   *  the failure mode of photo comparison, so a reading that names none is
   *  refused rather than saved. */
  caveats: string;
  confidence: 'high' | 'medium' | 'low' | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/**
 * A reading as the model produced it, before anything is written.
 *
 * The review gate sits between this and {@link ProgressPhotoAnalysisRow}: this
 * shape exists in memory only until the user taps Save.
 */
export type PhotoReading = {
  summary: string;
  observations: PhotoObservation[];
  /** Only ever populated for a pair reading. */
  changes: PhotoChange[];
  caveats: string;
  confidence: 'high' | 'medium' | 'low' | null;
};

/**
 * The nearest weigh-in to a photo's day, with the distance it was found at.
 *
 * **The distance is not decoration.** Printing "84.2 kg" beside a photo implies
 * the two were measured together; printing "84.2 kg · weighed 2 days later"
 * states exactly what is known and sidesteps the open UTC-vs-local bucketing
 * caveat entirely — no bucketing claim is made, because the weigh-in's own date
 * is what the distance is measured from.
 */
export type NearestWeighIn = {
  /** Canonical kilograms, as stored. Rendering honours UnitPreferences. */
  weight_kg: number;
  /** The weigh-in's own local day, as its instant carries it. */
  measured_on: DateString;
  /** Whole days from the photo's `taken_on`; negative is earlier, 0 same day. */
  delta_days: number;
};

/**
 * One month's worth of gallery cells, newest month first.
 *
 * Generic in the row because the gallery groups rows that have already been
 * paired with a resolved `file://` URI — grouping the bare rows and then joining
 * the URIs back on would be two passes that can disagree.
 */
export type PhotoMonth<T = ProgressPhotoRow> = {
  /** `YYYY-MM` — the group key, sortable as text. */
  key: string;
  /** "August 2026", built without Intl (Hermes ships without it). */
  label: string;
  photos: T[];
};
