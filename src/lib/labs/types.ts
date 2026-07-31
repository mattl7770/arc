/**
 * Types for the labs sub-app: the shapes that carry a Function Health PDF from
 * the model's reply, through catalog mapping, into `lab_reports` / `lab_results`
 * (docs/labs-subapp.md).
 *
 * Slice-local by the same convention the Coach and nutrition slices follow —
 * `src/lib/db/types.ts` mirrors table ROWS; these are the pipeline's own shapes.
 */
import type { BiomarkerCategory, DateString } from '@/lib/db/types';

// --- Stage 1: what the model extracted (validated, never trusted raw) --------

/**
 * A censored result's direction: the lab reported "<5" or ">150" rather than a
 * measurement. The bound is stored as the value (standard practice for a result
 * outside the assay's range), and this is what keeps the review screen honest
 * about it rather than showing a bare "5".
 */
export type ResultQualifier = '<' | '>';

/** One biomarker line as printed on the report, after shape validation. */
export type ExtractedResult = {
  /** The marker name exactly as printed — the mapper's input, kept for review. */
  name: string;
  value: number;
  /** Set when the printed result was "<value" / ">value". */
  qualifier: ResultQualifier | null;
  /** Unit as printed. Null when the report omits one (ratios, indexes). */
  unit: string | null;
  /** The lab's own reference range, when printed. Seeds a new catalog entry. */
  refLow: number | null;
  refHigh: number | null;
  /** The model's category suggestion, already validated against the enum. */
  category: BiomarkerCategory | null;
};

/**
 * A result the lab reported as WORDS, not a number — "Negative", "Yellow",
 * "Not Detected". A comprehensive panel's urinalysis section is ~20 of these,
 * around a sixth of the whole report.
 *
 * They are extracted but NOT imported: `lab_results.value` is `real NOT NULL`,
 * so there is nowhere to put "Negative" without a schema change. They survive
 * verbatim in `lab_reports.raw_extracted_json`, so nothing is lost and a future
 * migration can replay them — and the review screen says plainly how many were
 * set aside, rather than letting them vanish (docs/labs-subapp.md §7).
 */
export type QualitativeResult = {
  name: string;
  text: string;
};

/** A whole parsed report. `collectedOn` is null when no draw date was found. */
export type LabExtraction = {
  collectedOn: DateString | null;
  /** The performing lab ("Quest Diagnostics"), when printed. */
  labName: string | null;
  results: ExtractedResult[];
  /** Word-valued rows, surfaced in review but not importable. */
  qualitative: QualitativeResult[];
  /** Model-stated caveats worth showing in review ("page 4 was unreadable"). */
  notes: string | null;
};

// --- Stage 2: mapped against the on-device catalog ---------------------------

/**
 * Why a mapped row is what it is. Drives both the review UI and the default
 * include/exclude — only `unit_conflict` and `duplicate` default to excluded.
 */
export type MappedStatus =
  /** Matched a catalog biomarker; the unit already agrees. */
  | 'matched'
  /** Matched, and the value was converted into the catalog's unit. */
  | 'converted'
  /** No catalog match — importing adds a new biomarker to the catalog. */
  | 'new'
  /** Matched, but the units differ and no conversion is known. NOT importable. */
  | 'unit_conflict'
  /** An earlier row in this same report already claimed this biomarker. */
  | 'duplicate';

/** One extracted result resolved against the catalog, ready for review. */
export type MappedResult = {
  /** Stable per-report key for React lists — the row's index and printed name. */
  key: string;
  /** The name as printed on the report (what the user recognizes). */
  printedName: string;
  /** The catalog's name when matched, else the printed name. */
  displayName: string;
  /** The catalog biomarker's id, or null when this row would create one. */
  biomarkerId: string | null;
  slug: string;
  category: BiomarkerCategory;
  /** The value in the CANONICAL unit — what gets stored. */
  value: number;
  /** Canonical unit (the catalog's when matched, the printed one when new). */
  unit: string | null;
  /** The value/unit exactly as printed, for the review line and unit conflicts. */
  reportedValue: number;
  reportedUnit: string | null;
  /** Carried through so review renders "< 5", not a bare "5". */
  qualifier: ResultQualifier | null;
  status: MappedStatus;
  /** The lab's printed range — stored on a newly created biomarker only. */
  refLow: number | null;
  refHigh: number | null;
  /** The catalog's longevity range, when matched — the review's verdict column. */
  optimalLow: number | null;
  optimalHigh: number | null;
};

// --- Stage 3: what the repository writes -------------------------------------

/** One result the user confirmed, addressed by slug rather than by id: a `new`
 * row has no id yet, and the repository creates its biomarker in the same
 * transaction that inserts the value. */
export type LabImportResult = {
  slug: string;
  /** Only used when the slug is absent from the catalog. */
  name: string;
  category: BiomarkerCategory;
  unit: string | null;
  value: number;
  standardLow: number | null;
  standardHigh: number | null;
};

export type LabImportInput = {
  collectedOn: DateString;
  labName: string | null;
  /** Local/iCloud reference to the original PDF — the source of truth. */
  filePath: string | null;
  /** The model's verbatim reply, so a better parser can be replayed later. */
  rawJson: string | null;
  notes: string | null;
  results: LabImportResult[];
};

export type LabImportOutcome = {
  reportId: string;
  /** How many `lab_results` rows landed. */
  inserted: number;
  /** How many biomarkers the import added to the catalog. */
  createdBiomarkers: number;
};

/** One row of the imported-reports list on the Labs screen. */
export type LabReportSummary = {
  id: string;
  collectedAt: DateString;
  labName: string | null;
  source: string;
  resultCount: number;
  parsedAt: string | null;
};
