/**
 * The labs sub-app's data layer over the 0001 tables (`lab_reports`,
 * `lab_results`, `biomarkers`) — one confirmed import lands here, and the Labs
 * screen reads its history back.
 *
 * The whole import is ONE transaction: the report row, any biomarkers the
 * report introduced, and every value. A partial import is worse than none —
 * half a panel silently becomes a trend line with a hole in it — so anything
 * that throws rolls the lot back (docs/labs-subapp.md §5).
 *
 * Works against the {@link Database} interface only — never op-sqlite — so the
 * same code runs on device and against node:sqlite in db/labs.test.mjs.
 */
import type { Database } from '../database';
import { newId } from '../id';
import type {
  LabImportInput,
  LabImportOutcome,
  LabImportResult,
  LabReportSummary,
} from '@/lib/labs/types';

/**
 * Resolve a slug to a biomarker id, creating the catalog entry when the report
 * introduced a marker ARC doesn't ship. Returns the id and whether it was
 * created, so the caller can report "12 new biomarkers added".
 *
 * INSERT OR IGNORE then SELECT, rather than SELECT-then-INSERT: the unique slug
 * is the arbiter, so two rows in one import that resolve to the same new slug
 * can't produce two catalog rows. An existing biomarker is never MODIFIED — its
 * unit and optimal range are ARC's curated reference data, and a lab's printed
 * range must not overwrite them.
 */
function ensureBiomarker(db: Database, result: LabImportResult): { id: string; created: boolean } {
  const existing = db.get<{ id: string }>('SELECT id FROM biomarkers WHERE slug = ?', [
    result.slug,
  ]);
  if (existing) return { id: existing.id, created: false };

  db.run(
    `INSERT OR IGNORE INTO biomarkers
       (id, slug, name, category, unit, standard_range_low, standard_range_high)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(db),
      result.slug,
      result.name,
      result.category,
      result.unit,
      result.standardLow,
      result.standardHigh,
    ]
  );
  const row = db.get<{ id: string }>('SELECT id FROM biomarkers WHERE slug = ?', [result.slug]);
  if (!row) throw new Error(`Could not create biomarker "${result.slug}".`);
  return { id: row.id, created: true };
}

/**
 * Commit one reviewed lab report. Every value is stored under the CANONICAL
 * unit of its biomarker — the mapping layer (src/lib/labs/map.ts) converts or
 * refuses before anything reaches here, so a value in this table always means
 * what its biomarker's `unit` says it means.
 *
 * `raw_extracted_json` keeps the model's verbatim reply beside the parsed rows,
 * which is what makes a future parser improvement replayable without asking the
 * user to re-import the PDF (the intent 0001 wrote the column for).
 *
 * Callers must pass a de-duplicated result list: `lab_results` has
 * UNIQUE (report_id, biomarker_id), so two rows resolving to one biomarker
 * would abort the whole import. {@link mapExtraction} marks those `duplicate`
 * and the review screen excludes them by default.
 */
export function importLabReport(db: Database, input: LabImportInput): LabImportOutcome {
  const reportId = newId(db);
  let inserted = 0;
  let createdBiomarkers = 0;

  db.transaction(() => {
    db.run(
      `INSERT INTO lab_reports
         (id, source, collected_at, file_path, raw_extracted_json, parsed_at, notes)
       VALUES (?, 'function_pdf', ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)`,
      [reportId, input.collectedOn, input.filePath, input.rawJson, input.notes]
    );

    for (const result of input.results) {
      const { id: biomarkerId, created } = ensureBiomarker(db, result);
      if (created) createdBiomarkers++;
      db.run(
        `INSERT INTO lab_results
           (id, biomarker_id, report_id, value, collected_at, lab_name, source)
         VALUES (?, ?, ?, ?, ?, ?, 'function_pdf')`,
        [newId(db), biomarkerId, reportId, result.value, input.collectedOn, input.labName]
      );
      inserted++;
    }
  });

  return { reportId, inserted, createdBiomarkers };
}

/** Imported reports, newest draw first — the Labs screen's history list. */
export function listLabReports(db: Database): LabReportSummary[] {
  return db.all<LabReportSummary>(
    `SELECT r.id AS id,
            r.collected_at AS collectedAt,
            r.source AS source,
            r.parsed_at AS parsedAt,
            (SELECT count(*) FROM lab_results WHERE report_id = r.id) AS resultCount,
            (SELECT lab_name FROM lab_results
              WHERE report_id = r.id AND lab_name IS NOT NULL LIMIT 1) AS labName
     FROM lab_reports r
     ORDER BY r.collected_at DESC, r.created_at DESC, r.id DESC`
  );
}

/**
 * Every draw date that already has a report, newest first.
 *
 * The import screen loads this ONCE when a parse lands and checks the (editable)
 * date against it in memory — re-importing the same PDF is the easy mistake, and
 * it would put two values on one day's trend point. Read as a set rather than
 * re-queried per keystroke: the screen must not touch mutable external state
 * during render (see app/lab-import.tsx).
 */
export function listLabReportDates(db: Database): string[] {
  return db
    .all<{ collectedAt: string }>(
      'SELECT DISTINCT collected_at AS collectedAt FROM lab_reports ORDER BY collected_at DESC'
    )
    .map((row) => row.collectedAt);
}

/**
 * Delete a report and the values parsed out of it (ON DELETE CASCADE, 0001).
 * Manually entered results (report_id NULL) are untouched — the whole point of
 * that nullable FK. Biomarkers the report introduced are NOT removed: they are
 * catalog reference data now, and lab_results→biomarkers is ON DELETE RESTRICT.
 */
export function deleteLabReport(db: Database, id: string): void {
  db.run('DELETE FROM lab_reports WHERE id = ?', [id]);
}

/** Every stored value for one biomarker slug, oldest first — the trend series. */
export function biomarkerSeries(
  db: Database,
  slug: string
): { value: number; collectedAt: string }[] {
  return db.all<{ value: number; collectedAt: string }>(
    `SELECT lr.value AS value, lr.collected_at AS collectedAt
     FROM lab_results lr
     JOIN biomarkers b ON b.id = lr.biomarker_id
     WHERE b.slug = ?
     ORDER BY lr.collected_at, lr.created_at, lr.id`,
    [slug]
  );
}
