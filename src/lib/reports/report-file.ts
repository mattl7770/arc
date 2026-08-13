/**
 * A report on disk — the impure edge of the feature.
 *
 * Everything about writing and sharing lives in src/lib/files/share-file.ts
 * (the ledger export and reports now share); what is here is the two decisions
 * that belong to reports: WHERE the file goes, and WHAT its relative path is
 * once it is there.
 *
 * ## Why a `reports/` subdirectory when export writes flat
 *
 * An export is occasional — a handful of files over the life of the app. A
 * report is a habit: a self-review a week and a pack per visit puts sixty-odd
 * documents in the container root within a year, interleaved with the exports,
 * the lab PDFs and the photo directories. The subdirectory also gives
 * `reports.file_path` something to say that `reports.file_name` does not, which
 * is why the schema carries both.
 *
 * ## The path is RELATIVE, and the row is regenerable
 *
 * iOS re-issues the app container's UUID on every install and every update, so
 * an absolute `file:///var/mobile/Containers/…` written today dangles after the
 * next build — the trap 0033 documents at length. The database stores
 * `reports/<name>.html`; the directory is resolved at write time from
 * `Paths.document`. And unlike a photo, a missing report file costs nothing:
 * `data_json` holds the whole snapshot, so "Share again" re-renders and
 * re-creates it (spec §5).
 */
import { renderReportHtml, reportFileName } from './render-html';
import { writeAndShareFile, fileWritingAvailable, type FileOutcome } from '@/lib/files/share-file';
import type { CoachRead, ReportData } from './types';

export type { FileOutcome };
export { fileWritingAvailable };

/** The report directory, relative to the app's Documents directory. */
export const REPORTS_DIR = 'reports';

/** What the `reports.file_path` column stores. */
export function reportRelativePath(fileName: string): string {
  return `${REPORTS_DIR}/${fileName}`;
}

export type WrittenReport = {
  outcome: FileOutcome;
  fileName: string;
  /** Documents-relative — what goes in the row. */
  relativePath: string;
};

/**
 * Render `data` to HTML and write it, then offer the share sheet.
 *
 * The render runs inside the helper's try/catch (it is handed over as a thunk),
 * so a renderer throw surfaces as a `failed` outcome the screen can show rather
 * than as an unhandled rejection mid-tap.
 *
 * `read` is passed separately for the same reason `renderReportHtml` takes it
 * separately: the Coach's prose is never part of the deterministic snapshot,
 * and a doctor pack ignores it outright.
 */
export async function writeReportFile(
  data: ReportData,
  read: CoachRead | null = null
): Promise<WrittenReport> {
  const fileName = reportFileName(data.kind, data.meta.generatedAt);
  const outcome = await writeAndShareFile({
    fileName,
    directory: REPORTS_DIR,
    content: () => renderReportHtml(data, read),
    mimeType: 'text/html',
    uti: 'public.html',
    dialogTitle: data.kind === 'self_review' ? 'Share self-review' : 'Share doctor visit pack',
  });
  return { outcome, fileName, relativePath: reportRelativePath(fileName) };
}
