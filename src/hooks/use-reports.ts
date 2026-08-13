import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import {
  getReport,
  getReportSnapshot,
  listReports,
  readNarrative,
  type ReportSummary,
} from '@/lib/db/repositories/reports';
import { COACH_READ_ATTRIBUTION } from '@/lib/reports/coach-read';
import { formatDate, formatRange } from '@/lib/reports/period';
import type { CoachRead, ReportData } from '@/lib/reports/types';

/**
 * The Reports screens' view models.
 *
 * Synchronous first read in the `useState` initializer (op-sqlite is sync — no
 * async, no spinner, the house pattern), re-read on focus so returning from a
 * generated report shows it in the history immediately.
 *
 * ## Every display string is built HERE, not in the screen
 *
 * Same rule the report renderers keep, for the same reason: a row's subtitle is
 * a formatted date range, and formatting a date is exactly the kind of thing
 * that drifts when two screens each do it. The screens place `typeLabel` and
 * `subtitle`; they never see a raw ISO string.
 */

const TYPE_LABELS: Record<string, string> = {
  self_review: 'Self-review',
  doctor_pack: 'Doctor visit pack',
};

export type ReportHistoryRow = {
  id: string;
  typeLabel: string;
  /** "3 – 9 Aug 2026 · generated 12 Aug 2026" or "as of 12 Aug 2026". */
  subtitle: string;
  /** The generated date on its own — what the tally line names. */
  generatedOn: string;
  hasNarrative: boolean;
};

function toRow(summary: ReportSummary): ReportHistoryRow {
  const generatedOn = formatDate(summary.generatedAt.slice(0, 10));
  const subtitle =
    summary.periodStart && summary.periodEnd
      ? `${formatRange(summary.periodStart, summary.periodEnd)} · generated ${generatedOn}`
      : `as of ${generatedOn}`;
  return {
    id: summary.id,
    typeLabel: TYPE_LABELS[summary.reportType] ?? summary.reportType,
    subtitle,
    generatedOn,
    hasNarrative: summary.hasNarrative,
  };
}

export type ReportsHistory = {
  rows: ReportHistoryRow[];
  /**
   * "2 reports · last 12 Aug 2026" — the tally in the section label's mono note
   * slot, and the LIVE STATE the Data tab's row carries.
   *
   * That row body is the reason Reports earns a place on the Data tab where a
   * second export button would not: the tab's standing critique is that nothing
   * on it is a reading, and a persisted-report history is one. `undefined` when
   * there is nothing yet, so the row falls back to its plain label rather than
   * announcing a count of zero.
   */
  summaryLine: string | undefined;
  reload: () => void;
};

function readHistory(): ReportHistoryRow[] {
  return listReports(getDb()).map(toRow);
}

export function useReportsHistory(): ReportsHistory {
  const [rows, setRows] = useState<ReportHistoryRow[]>(readHistory);
  const reload = useCallback(() => setRows(readHistory()), []);
  useFocusEffect(reload);

  // `listReports` is ordered newest first, so row 0 IS the last generated.
  const last = rows[0];
  const summaryLine =
    last == null
      ? undefined
      : `${String(rows.length)} report${rows.length === 1 ? '' : 's'} · last ${last.generatedOn}`;

  return { rows, summaryLine, reload };
}

/**
 * A PERSISTED report, re-rendered from its stored snapshot.
 *
 * `data` comes from `data_json`, never from a fresh assembly — that is the
 * whole point of persisting it (migration 0036's header). A corrected lab value
 * landing tomorrow must not silently change what the report you handed over
 * last week says.
 */
export function useStoredReport(id: string | undefined): {
  data: ReportData | null;
  read: CoachRead | null;
  /** True when the id exists but its snapshot could not be re-rendered. */
  unreadable: boolean;
} {
  const [state] = useState(() => {
    if (!id) return { data: null, read: null, unreadable: false };
    const db = getDb();
    const row = getReport(db, id);
    if (!row) return { data: null, read: null, unreadable: false };
    const data = getReportSnapshot(db, id);
    return {
      data,
      read: readNarrative(row, COACH_READ_ATTRIBUTION),
      unreadable: data == null,
    };
  });
  return state;
}
