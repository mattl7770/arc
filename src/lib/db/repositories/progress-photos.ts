/**
 * The progress-photo gallery's data layer (0035_progress_photos.sql).
 * Spec: docs/progress-photos-subapp.md.
 *
 * Three disciplines, load-bearing:
 *
 *  - **The row holds a NAME, never a path.** Every path in this feature is
 *    resolved at read time by src/lib/media/progress-photo-store.ts. This module
 *    never builds one, and the schema's CHECK makes that enforceable rather than
 *    hoped for.
 *  - **`taken_on` is the shutter's day.** Nothing here ever defaults it to
 *    today. A row with no date is a row that was never inserted — the import
 *    flow makes the user supply one.
 *  - **Weight context is a read-time date join, never a stored FK**, and it
 *    always carries the distance it was found at ({@link nearestWeighIn}).
 *
 * Like every repository, this depends only on the {@link Database} interface —
 * never op-sqlite — so the same code runs on device and against node:sqlite in
 * db/progress-photos.test.mjs.
 */
import type { Database, Scalar } from '../database';
import { newId } from '../id';
import type {
  NearestWeighIn,
  NewProgressPhoto,
  PhotoMonth,
  PhotoPose,
  ProgressPhotoAnalysisRow,
  ProgressPhotoEdit,
  ProgressPhotoRow,
} from '@/lib/photos/types';

/**
 * How far from a photo's day a weigh-in may be and still be worth printing.
 *
 * Three days each way. A weigh-in a week from the shutter is not context for
 * that photo, it is a different week; three days is the widest window in which
 * "you were about this weight in this picture" is still a true sentence, and it
 * is the span a normal weigh-in cadence (most mornings) fills anyway.
 */
export const WEIGH_IN_WINDOW_DAYS = 3;

// --- Photos ------------------------------------------------------------------

/**
 * Insert one photo row. The caller has already written the file — that ordering
 * is the whole invariant of src/lib/media/progress-photo-store.ts, which is the
 * only module that should call this directly.
 *
 * Throws on a duplicate `asset_id` (the partial unique) and on any CHECK
 * violation, deliberately: the store removes the file it just wrote and the
 * import review reports it, rather than a half-imported batch landing silently.
 */
export function insertProgressPhoto(db: Database, photo: NewProgressPhoto): string {
  const id = newId(db);
  db.run(
    `INSERT INTO progress_photos
       (id, taken_on, taken_at, pose, source, asset_id, working_file_name,
        original_file_name, is_important, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      photo.taken_on,
      photo.taken_at ?? null,
      photo.pose,
      photo.source ?? 'library',
      photo.asset_id ?? null,
      photo.working_file_name,
      photo.original_file_name ?? null,
      photo.is_important ? 1 : 0,
      photo.notes ?? null,
    ]
  );
  return id;
}

export function getProgressPhoto(db: Database, id: string): ProgressPhotoRow | undefined {
  return db.get<ProgressPhotoRow>('SELECT * FROM progress_photos WHERE id = ?', [id]);
}

/**
 * Every photo, newest shutter-day first, optionally filtered to one pose.
 *
 * The tiebreaker is `created_at DESC` rather than nothing: a backfill imports
 * three poses stamped the same day, and without a second key their order is
 * whatever the b-tree happens to yield — which changes between reads and makes
 * the gallery shuffle itself.
 */
export function listProgressPhotos(db: Database, pose?: PhotoPose): ProgressPhotoRow[] {
  const where = pose ? 'WHERE pose = ?' : '';
  const params: Scalar[] = pose ? [pose] : [];
  return db.all<ProgressPhotoRow>(
    `SELECT * FROM progress_photos ${where} ORDER BY taken_on DESC, created_at DESC`,
    params
  );
}

/** How many photos exist, for the gallery's tally and the Data-tab row. */
export function progressPhotoCount(db: Database): number {
  return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM progress_photos')?.n ?? 0;
}

/** How many distinct poses are represented among `rows` — the month plate's
 *  second figure, derived from exactly the rows it heads. */
export function poseCount(rows: { pose: PhotoPose }[]): number {
  return new Set(rows.map((row) => row.pose)).size;
}

/**
 * Apply the detail screen's edits. A no-op call writes nothing (and so does not
 * bump `updated_at`), which keeps "I opened the screen" from looking like "I
 * changed the record".
 */
export function updateProgressPhoto(db: Database, id: string, edit: ProgressPhotoEdit): void {
  const sets: string[] = [];
  const params: Scalar[] = [];
  if (edit.taken_on !== undefined) {
    sets.push('taken_on = ?');
    params.push(edit.taken_on);
  }
  if (edit.pose !== undefined) {
    sets.push('pose = ?');
    params.push(edit.pose);
  }
  if (edit.notes !== undefined) {
    sets.push('notes = ?');
    params.push(edit.notes);
  }
  if (edit.is_important !== undefined) {
    sets.push('is_important = ?');
    params.push(edit.is_important ? 1 : 0);
  }
  if (sets.length === 0) return;
  params.push(id);
  db.run(`UPDATE progress_photos SET ${sets.join(', ')} WHERE id = ?`, params);
}

/**
 * Delete the row. Analyses go with it on both FK paths (CASCADE), and the FILES
 * do not — deletion is routed through
 * src/lib/media/progress-photo-store.ts::deleteProgressPhotoWithFiles, which
 * reads the names first. A leaked file is reclaimed by the next app-open sweep;
 * a leaked ROW would render the authored "not on this phone" cell forever, which
 * is why the order is row-then-file and not the reverse.
 *
 * **Deleting here never touches the Photos-library original.**
 */
export function deleteProgressPhoto(db: Database, id: string): void {
  db.run('DELETE FROM progress_photos WHERE id = ?', [id]);
}

/** Both file names a photo owns, for the store's delete path. */
export function progressPhotoFileNames(db: Database, id: string): string[] {
  const row = getProgressPhoto(db, id);
  if (!row) return [];
  return row.original_file_name ? [row.working_file_name, row.original_file_name] : [row.working_file_name];
}

/** Every (id, names) pair, for the sweep's dangling and orphan passes. */
export function allProgressPhotoFileNames(
  db: Database
): { id: string; working_file_name: string; original_file_name: string | null }[] {
  return db.all('SELECT id, working_file_name, original_file_name FROM progress_photos');
}

/**
 * Which of these PhotoKit asset ids are already in the gallery.
 *
 * The import review calls this once per batch rather than once per asset: a
 * 30-photo backfill would otherwise be 30 round trips to answer one question.
 * An empty input returns an empty set without touching the database — SQLite
 * rejects `IN ()`.
 */
export function importedAssetIds(db: Database, assetIds: string[]): Set<string> {
  const wanted = assetIds.filter((id) => id !== '');
  if (wanted.length === 0) return new Set();
  const placeholders = wanted.map(() => '?').join(', ');
  const rows = db.all<{ asset_id: string }>(
    `SELECT asset_id FROM progress_photos WHERE asset_id IN (${placeholders})`,
    wanted
  );
  return new Set(rows.map((row) => row.asset_id));
}

// --- Month grouping ----------------------------------------------------------

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * Group already-ordered rows into months, newest month first.
 *
 * **Pure, and it takes the rows rather than the database** so the gallery groups
 * exactly what it is about to draw — a second query could disagree with the
 * first. Order is preserved from the input, so `listProgressPhotos`' sort is the
 * only place ordering is decided.
 *
 * The label is hand-built: Hermes ships without `Intl`, so
 * `toLocaleDateString` silently ignores its options object on device (the same
 * trap src/components/home/date-eyebrow.tsx documents).
 */
export function groupPhotosByMonth<T extends { taken_on: string }>(rows: T[]): PhotoMonth<T>[] {
  const months: PhotoMonth<T>[] = [];
  const byKey = new Map<string, PhotoMonth<T>>();
  for (const row of rows) {
    const key = row.taken_on.slice(0, 7);
    let month = byKey.get(key);
    if (!month) {
      const monthIndex = Number(key.slice(5, 7)) - 1;
      const name = MONTH_NAMES[monthIndex] ?? key.slice(5, 7);
      month = { key, label: `${name} ${key.slice(0, 4)}`, photos: [] };
      byKey.set(key, month);
      months.push(month);
    }
    month.photos.push(row);
  }
  return months;
}

// --- Weight context ----------------------------------------------------------

/**
 * The nearest weigh-in to a photo's day, within ±{@link WEIGH_IN_WINDOW_DAYS},
 * or null.
 *
 * `body_metrics.measured_at` is a UTC instant and `taken_on` is a local day, so
 * the two are not directly comparable — which is exactly why the result carries
 * `delta_days` and every caller prints it. The comparison is made between the
 * two DATES (`substr(measured_at, 1, 10)`), the distance is reported from that
 * same pair, and no bucketing claim is made anywhere. A caption that says
 * "weighed 2 days later" is true under either interpretation of the boundary;
 * one that just says "84.2 kg" is not.
 *
 * Ties (a weigh-in the same distance either side) resolve to the LATER instant:
 * with two equally close readings, the more recent one is the better guess at
 * the trend the photo sits on.
 */
export function nearestWeighIn(
  db: Database,
  takenOn: string,
  windowDays: number = WEIGH_IN_WINDOW_DAYS
): NearestWeighIn | null {
  const row = db.get<{ weight_kg: number; measured_on: string; delta_days: number }>(
    `SELECT weight_kg,
            substr(measured_at, 1, 10) AS measured_on,
            CAST(julianday(substr(measured_at, 1, 10)) - julianday(?) AS integer) AS delta_days
     FROM body_metrics
     WHERE weight_kg IS NOT NULL
       AND substr(measured_at, 1, 10) BETWEEN date(?, ?) AND date(?, ?)
     ORDER BY abs(julianday(substr(measured_at, 1, 10)) - julianday(?)) ASC, measured_at DESC
     LIMIT 1`,
    [
      takenOn,
      takenOn,
      `-${windowDays} days`,
      takenOn,
      `+${windowDays} days`,
      takenOn,
    ]
  );
  if (!row || row.weight_kg == null) return null;
  return { weight_kg: row.weight_kg, measured_on: row.measured_on, delta_days: row.delta_days };
}

// --- Analyses ----------------------------------------------------------------

export type NewProgressPhotoAnalysis = {
  photo_id: string;
  compare_photo_id?: string | null;
  model: string;
  summary: string;
  observations?: string | null;
  changes?: string | null;
  caveats: string;
  confidence?: 'high' | 'medium' | 'low' | null;
};

/** Persist a reading — called only from the review gate's Save, never from the
 *  model call itself. */
export function insertProgressPhotoAnalysis(
  db: Database,
  analysis: NewProgressPhotoAnalysis
): string {
  const id = newId(db);
  db.run(
    `INSERT INTO progress_photo_analyses
       (id, photo_id, compare_photo_id, model, summary, observations, changes, caveats, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      analysis.photo_id,
      analysis.compare_photo_id ?? null,
      analysis.model,
      analysis.summary,
      analysis.observations ?? null,
      analysis.changes ?? null,
      analysis.caveats,
      analysis.confidence ?? null,
    ]
  );
  return id;
}

/**
 * Every reading that mentions this photo, newest first — including the pair
 * readings where it is the LATER half.
 *
 * Both sides matter on the detail screen: a comparison of January to August is
 * as much a reading of the August photo as of the January one, and showing it
 * on only one of the two would make it findable from the wrong end.
 */
export function listPhotoAnalyses(db: Database, photoId: string): ProgressPhotoAnalysisRow[] {
  return db.all<ProgressPhotoAnalysisRow>(
    `SELECT * FROM progress_photo_analyses
     WHERE photo_id = ? OR compare_photo_id = ?
     ORDER BY created_at DESC`,
    [photoId, photoId]
  );
}

/** The saved readings of one specific pair, newest first. `earlierId` is the
 *  photo_id side by construction — the compare screen orders its two before
 *  calling, and the prompt states that order to the model. */
export function listPairAnalyses(
  db: Database,
  earlierId: string,
  laterId: string
): ProgressPhotoAnalysisRow[] {
  return db.all<ProgressPhotoAnalysisRow>(
    `SELECT * FROM progress_photo_analyses
     WHERE photo_id = ? AND compare_photo_id = ?
     ORDER BY created_at DESC`,
    [earlierId, laterId]
  );
}

export function deleteProgressPhotoAnalysis(db: Database, id: string): void {
  db.run('DELETE FROM progress_photo_analyses WHERE id = ?', [id]);
}
