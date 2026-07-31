/**
 * The Biomarkers sub-app's data layer: the reference catalogue
 * (`biomarkers`, seeded by `seedReferenceData`) joined with each biomarker's
 * most recent `lab_results` value (0001_init.sql) — one row per biomarker,
 * whether or not it has ever been measured.
 *
 * Works against the {@link Database} interface only — never op-sqlite — so the
 * same code runs on device and against node:sqlite in
 * db/data-body-biomarkers.test.mjs.
 */
import type { Database } from '../database';

export interface BiomarkerRange {
  slug: string;
  name: string;
  category: string;
  unit: string;
  optimalLow: number | null;
  optimalHigh: number | null;
  higherIsBetter: 0 | 1 | null;
  latestValue: number | null;
  latestAt: string | null;
}

/**
 * One row per biomarker in the catalogue, each carrying its most recent
 * `lab_results` value (by `collected_at`) — null when the biomarker has never
 * been measured. Deterministic order: a fixed category priority, then name,
 * so the Biomarkers screen renders in a stable, longevity-relevant grouping
 * rather than insertion order.
 *
 * EVERY category needs its own priority, not an `ELSE` bucket: the Labs screen
 * folds *contiguous* runs into section headers, so two categories sharing a
 * rank interleave by name and the same header repeats down the page. That was
 * invisible while the catalog was 12 cardiovascular-to-hematology markers and
 * appeared the moment it grew to cover organ, immune, cancer and biological age.
 */
export function listBiomarkerRanges(db: Database): BiomarkerRange[] {
  return db.all<BiomarkerRange>(
    `SELECT
       b.slug AS slug,
       b.name AS name,
       b.category AS category,
       coalesce(b.unit, '') AS unit,
       b.optimal_range_low AS optimalLow,
       b.optimal_range_high AS optimalHigh,
       b.higher_is_better AS higherIsBetter,
       lr.value AS latestValue,
       lr.collected_at AS latestAt
     FROM biomarkers b
     LEFT JOIN lab_results lr ON lr.id = (
       SELECT id FROM lab_results
       WHERE biomarker_id = b.id
       ORDER BY collected_at DESC, created_at DESC, id DESC
       LIMIT 1
     )
     ORDER BY
       CASE b.category
         WHEN 'cardiovascular' THEN 0
         WHEN 'metabolic' THEN 1
         WHEN 'inflammation' THEN 2
         WHEN 'nutrient' THEN 3
         WHEN 'hematology' THEN 4
         WHEN 'hormone' THEN 5
         WHEN 'immune' THEN 6
         WHEN 'organ' THEN 7
         WHEN 'cancer' THEN 8
         WHEN 'toxin' THEN 9
         WHEN 'microbiome' THEN 10
         WHEN 'biological_age' THEN 11
         ELSE 12
       END,
       b.name`
  );
}
