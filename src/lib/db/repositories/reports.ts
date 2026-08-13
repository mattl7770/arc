/**
 * The reports ledger's data layer (0036) — docs/reports-subapp.md §5.
 *
 * A generated report is a RECORD, not a cache: "what did the doctor actually
 * see" has to stay answerable after the data behind it is corrected. So every
 * row carries `data_json`, the full serialized `ReportData` snapshot, and
 * history re-renders FROM IT rather than re-assembling — which is why
 * {@link getReportSnapshot} parses the blob and no read on this module ever
 * touches an assembler.
 *
 * `narrative_text` stays a column of its own, never a key inside `data_json`
 * (the migration header explains why at length): the deterministic snapshot
 * must not carry model prose, and {@link readNarrative} is the only way it
 * comes back out.
 *
 * Pure over the {@link Database} interface — never op-sqlite — so the same code
 * runs on device and against node:sqlite in db/reports.test.mjs.
 */
import type { Database } from '../database';
import { newId } from '../id';
import type { CoachRead, ReportData, ReportType } from '@/lib/reports/types';

export type ReportRow = {
  id: string;
  report_type: ReportType;
  period_start: string | null;
  period_end: string | null;
  generated_at: string;
  file_name: string;
  file_path: string;
  data_json: string;
  narrative_text: string | null;
  app_version: string | null;
  created_at: string;
  updated_at: string;
};

/** One row of the history list — everything but the two large text columns. */
export type ReportSummary = {
  id: string;
  reportType: ReportType;
  periodStart: string | null;
  periodEnd: string | null;
  generatedAt: string;
  fileName: string;
  /** True when the user attached a Coach's read. Cheap enough to select. */
  hasNarrative: boolean;
};

export type NewReport = {
  data: ReportData;
  /** The attributed model prose, or null — stored apart from `data`. */
  read: CoachRead | null;
  fileName: string;
  /** Documents-relative (`reports/<name>.html`). */
  filePath: string;
};

/**
 * Persist one generated report. Returns its id.
 *
 * The period columns come off the DATA rather than from a parameter, so a
 * caller cannot file a self-review under the wrong dates or hand a doctor pack
 * a period the schema's CHECK would then reject. `narrative_text` stores only
 * the model's own words — the attribution rubric and the model name are
 * re-derived on read, because they are ARC's copy, not the model's output, and
 * a rubric frozen into a row would go stale the day it is reworded.
 */
export function insertReport(db: Database, input: NewReport): string {
  const id = newId(db);
  const period = input.data.kind === 'self_review' ? input.data.period : null;
  db.run(
    `INSERT INTO reports
       (id, report_type, period_start, period_end, generated_at, file_name, file_path,
        data_json, narrative_text, app_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.data.kind,
      period?.start ?? null,
      period?.end ?? null,
      input.data.meta.generatedAt,
      input.fileName,
      input.filePath,
      JSON.stringify(input.data),
      input.read?.text ?? null,
      input.data.meta.appVersion,
    ]
  );
  return id;
}

/** Generated reports, newest first — the history list. Empty-safe. */
export function listReports(db: Database): ReportSummary[] {
  return db
    .all<{
      id: string;
      reportType: ReportType;
      periodStart: string | null;
      periodEnd: string | null;
      generatedAt: string;
      fileName: string;
      hasNarrative: number;
    }>(
      `SELECT id AS id, report_type AS reportType, period_start AS periodStart,
              period_end AS periodEnd, generated_at AS generatedAt, file_name AS fileName,
              (narrative_text IS NOT NULL) AS hasNarrative
       FROM reports
       ORDER BY generated_at DESC, created_at DESC, id DESC`
    )
    .map((row) => ({ ...row, hasNarrative: row.hasNarrative === 1 }));
}

export function getReport(db: Database, id: string): ReportRow | undefined {
  return db.get<ReportRow>('SELECT * FROM reports WHERE id = ?', [id]);
}

/**
 * Every top-level key each renderer dereferences without checking. A snapshot
 * missing one of these would not render half a document — it would throw
 * reading `.title` off `undefined`, inside a screen the user reached by
 * tapping a history row.
 */
const REQUIRED_SECTIONS: Record<ReportType, string[]> = {
  self_review: [
    'period',
    'adherence',
    'training',
    'nutrition',
    'recovery',
    'body',
    'symptoms',
    'experiments',
    'changed',
  ],
  doctor_pack: ['patient', 'regimen', 'labs', 'vitals', 'body', 'screenings', 'symptoms'],
};

/**
 * The stored snapshot, parsed and shape-checked — what a history row renders
 * from, never a re-assembly.
 *
 * `null` for an unknown id AND for a blob this build cannot render. The column
 * carries a `json_valid` CHECK so unparseable is close to impossible; the case
 * that actually matters is a blob written by a DIFFERENT version of ARC whose
 * `ReportData` had other sections — a downgrade, or a restored backup. The
 * check is therefore against the keys the renderers dereference, not merely
 * against `kind`, because the failure it prevents is a crash rather than a
 * cosmetic gap. Returning null lets `app/report-view.tsx` say plainly that this
 * report cannot be re-rendered here and that the file it produced is
 * unaffected — which is true, and is the whole reason the file is kept.
 */
export function getReportSnapshot(db: Database, id: string): ReportData | null {
  const row = getReport(db, id);
  if (!row) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.data_json);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const candidate = parsed as Record<string, unknown>;
  const kind = candidate.kind;
  if (kind !== 'self_review' && kind !== 'doctor_pack') return null;
  if (candidate.meta == null || typeof candidate.meta !== 'object') return null;
  for (const key of REQUIRED_SECTIONS[kind]) {
    if (candidate[key] == null || typeof candidate[key] !== 'object') return null;
  }
  return parsed as ReportData;
}

/**
 * The stored Coach's read, re-wrapped with the CURRENT attribution rubric.
 *
 * The rubric is ARC's own copy and is authored in one place
 * (`COACH_READ_ATTRIBUTION`); storing it per row would freeze a wording that a
 * later, clearer one should replace everywhere, including on documents already
 * generated. The model's words are what is durable; the frame around them is
 * the app's.
 */
export function readNarrative(row: ReportRow, attribution: string): CoachRead | null {
  if (row.narrative_text == null || row.narrative_text.trim() === '') return null;
  return { text: row.narrative_text, attribution, model: null };
}

/**
 * Delete a report row. The FILE is the caller's to remove — this module never
 * touches disk, which is what keeps it headless-testable. A file left behind is
 * a few kilobytes and is regenerable anyway; a row left behind would point at
 * nothing.
 */
export function deleteReport(db: Database, id: string): void {
  db.run('DELETE FROM reports WHERE id = ?', [id]);
}
