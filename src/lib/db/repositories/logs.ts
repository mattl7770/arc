/**
 * The Log tab's data layer: ad-hoc captures in, today's running record out.
 *
 * Captures made through the Log tab (a free note, a keypad metric, a parsed
 * command) are "ad-hoc" — distinct from the planned/mission entries Home shows.
 * The two live in different places:
 *   - notes and generic metrics → `log_entries`, marked `value.adhoc = true` so
 *     `listMission` (Home) filters them out and this feed filters them *in*;
 *   - body metrics (weight/body-fat/waist) → `body_metrics` (canonical kg/cm);
 *   - other numeric metrics (water/HRV/RHR) → `wearable_data` (canonical ml/…),
 *     `source_device = 'manual'`, so a smart bottle or Apple Health can later
 *     add rows to the same metric_type without a migration;
 *   - screen time → the same table, minutes, but ONE row per day: it is routed
 *     through ./screen-time.ts, which replaces instead of appending. A day's
 *     total is not a capture at a moment, so it stays out of this feed.
 *
 * Everything crosses through the metric registry (src/lib/log/metrics.ts), so
 * units and persistence targets are defined once.
 */
import type { Database } from '../database';
import { clockFromISO, logicalDate, logicalDayUtcRange, todayISODate } from '../date';
import { newId } from '../id';
import { restoreRow, snapshotRows, type SnapshotRow } from '../row-snapshot';
import { getOrCreateDailyLog } from './mission';
import { latestScreenTime, recordScreenTime } from './screen-time';
import { deleteWaterEntry } from './water';
import type { BodyMetricRow, LogEntryRow, WearableDataRow } from '../types';
import {
  formatCanonical,
  formatMeasured,
  metricByBodyColumn,
  metricByKey,
  metricByWearableType,
  resolveDisplay,
  type MetricDescriptor,
  type MetricKey,
} from '@/lib/log/metrics';
import { weekdayDate } from '@/lib/protocols/format';
import { SCREEN_TIME_METRIC } from '@/lib/screen-time/entry';
import type { UnitPreferences } from '@/lib/user/types';
import type { LogFeedItem } from '@/types/log';

const nowISO = () => new Date().toISOString();

/**
 * A UTC ISO instant at LOCAL noon of a `YYYY-MM-DD` — how a backdated body
 * metric gets stamped onto its intended day. Noon (not midnight) keeps the
 * reading inside the local day for any UTC offset within ±12h, so a consumer
 * that reads it back through a LOCAL-day window (localDayUtcRange) always lands
 * it on `date`.
 *
 * It is NOT flip-proof for its own UTC-date portion: at an offset beyond +12h
 * (New Zealand DST +13, Chatham +13:45, Kiribati +14) local noon falls on the
 * PREVIOUS UTC date, and at exactly −12h on the NEXT. A consumer that buckets by
 * substr(measured_at,1,10) instead of a local window therefore attributes the
 * reading to the wrong calendar day at those extremes. Bucket backdated body
 * readings through a local window, not the raw UTC date. (See logMetric.)
 */
export function dayInstant(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d!, 12, 0, 0, 0).toISOString();
}

/** Save a free-text note (a log with no metric bucket, written for the Coach). */
export function logNote(db: Database, date: string, text: string): string {
  const log = getOrCreateDailyLog(db, date);
  const id = newId(db);
  db.run(
    `INSERT INTO log_entries
       (id, daily_log_id, type, title, status, completed_at, value, source)
     VALUES (?, ?, 'note', ?, 'completed', ?, ?, 'manual')`,
    [id, log.id, text, nowISO(), JSON.stringify({ adhoc: true })]
  );
  return id;
}

/**
 * Persist one keypad/parsed metric at its canonical value, routing to the table
 * the registry names. `date` is the local day (for the wearable `date` column);
 * body metrics stamp a UTC `measured_at`.
 */
export function logMetric(
  db: Database,
  date: string,
  metricKey: MetricKey,
  canonical: number
): void {
  const metric = metricByKey(metricKey);
  if (!metric) throw new Error(`logMetric: unknown metric "${metricKey}"`);
  const target = metric.target;

  if (target.kind === 'body') {
    // Column comes from the registry (a fixed union), not user input.
    // body_metrics has no `date` column — only a UTC `measured_at`. For TODAY we
    // stamp the real instant (preserves time-of-day + ordering); for a BACKDATE
    // (the Coach forwards one when the user reports a past event) we stamp local
    // noon of that day, so a LOCAL-day window read (localDayUtcRange) lands the
    // reading on the intended day for any timezone — not silently on today,
    // which would corrupt the daily series. A consumer that instead slices
    // substr(measured_at,1,10) only agrees within ±12h of UTC; beyond that local
    // noon flips to an adjacent UTC date (see dayInstant), so day-bucket readers
    // should go through a local window rather than the raw UTC date.
    const measuredAt = date === todayISODate() ? nowISO() : dayInstant(date);
    db.run(
      `INSERT INTO body_metrics (id, measured_at, ${target.column}, source) VALUES (?, ?, ?, 'manual')`,
      [newId(db), measuredAt, canonical]
    );
    return;
  }

  if (target.kind === 'wearable') {
    // Screen time is ONE number per day, so it replaces rather than appends —
    // every door that reaches logMetric gets that rule, not only the Log tab's
    // (src/lib/db/repositories/screen-time.ts). The Log tab calls
    // recordScreenTime itself, because it needs the id back for its Undo.
    if (metric.key === 'screen_time') {
      recordScreenTime(db, date, Math.round(canonical), 'typed');
      return;
    }
    db.run(
      `INSERT INTO wearable_data (id, date, metric_type, value, unit, source_device)
       VALUES (?, ?, ?, ?, ?, 'manual')`,
      [newId(db), date, target.metricType, canonical, target.canonicalUnit]
    );
    return;
  }

  // Generic: no dedicated table — a log_entries row of type 'metric'.
  const log = getOrCreateDailyLog(db, date);
  db.run(
    `INSERT INTO log_entries
       (id, daily_log_id, type, title, status, completed_at, value, source)
     VALUES (?, ?, 'metric', ?, 'completed', ?, ?, 'manual')`,
    [
      newId(db),
      log.id,
      formatCanonical(metric, canonical),
      nowISO(),
      JSON.stringify({ adhoc: true, metricKey, canonical }),
    ]
  );
}

/** The capture types the Log-tab Supplement/Therapy sheet writes. */
export type CaptureType = 'supplement' | 'therapy' | 'medication';

/** Display category for each ad-hoc `log_entries.type` shown in the feed. */
const CAPTURE_CATEGORY: Record<string, string> = {
  supplement: 'Supplements',
  medication: 'Medications',
  therapy: 'Therapies',
  meal: 'Nutrition',
  workout: 'Training',
  habit: 'Routine',
};

/**
 * Persist a Supplement / Therapy / Medication capture as an ad-hoc `log_entries`
 * row. `title` is the display line (e.g. "Creatine · 5 g", "Sauna · 20 min");
 * marked `adhoc` so it stays off Home's mission and in the Log feed.
 */
export function logCapture(
  db: Database,
  date: string,
  type: CaptureType,
  title: string,
  opts: { protocol?: boolean } = {}
): string {
  const log = getOrCreateDailyLog(db, date);
  const id = newId(db);
  db.run(
    `INSERT INTO log_entries
       (id, daily_log_id, type, title, status, completed_at, value, source)
     VALUES (?, ?, ?, ?, 'completed', ?, ?, 'manual')`,
    [
      id,
      log.id,
      type,
      title.trim(),
      nowISO(),
      JSON.stringify({ adhoc: true, ...(opts.protocol ? { protocol: true } : {}) }),
    ]
  );
  return id;
}

/** Generic-metric payload stashed in `log_entries.value`. */
type GenericMetricValue = { metricKey?: string; canonical?: number };

function parseValue(value: string | null): GenericMetricValue {
  if (!value) return {};
  try {
    return JSON.parse(value) as GenericMetricValue;
  } catch {
    return {};
  }
}

/**
 * Today's running record for the Log tab, newest first — a union of the three
 * capture tables. Only ad-hoc captures appear (the planned mission lives on
 * Home). The local `date` and the body-metrics UTC range are both derived from
 * the single `now` argument, so they can't disagree; `now` is injectable so the
 * headless tests are deterministic.
 */
export function listTodayEntries(
  db: Database,
  now: Date = new Date(),
  units?: UnitPreferences
): LogFeedItem[] {
  return listEntriesOn(db, todayISODate(now), units);
}

/**
 * The same feed for ANY logical day.
 *
 * Added 2026-09-19 for the Coach's `captures` domain: the log tools have always
 * backdated, and nothing could read a past day back. It is
 * {@link listTodayEntries}' body with the day named instead of derived — one
 * implementation, so the two can never disagree about what a day is, and the
 * body-metrics window comes from `logicalDayUtcRange` so the day boundary is
 * applied exactly once.
 */ export function listEntriesOn(
  db: Database,
  date: string,
  units?: UnitPreferences
): LogFeedItem[] {
  const { startUtc, endUtc } = logicalDayUtcRange(date);
  const rows: FeedRow[] = [];

  // 1) Ad-hoc log_entries — notes, generic metrics and the capture types.
  const logRows = db.all<LogEntryRow>(
    `SELECT le.* FROM log_entries le
       JOIN daily_logs dl ON dl.id = le.daily_log_id
     WHERE dl.date = ? AND json_extract(le.value, '$.adhoc') = 1`,
    [date]
  );
  for (const r of logRows) rows.push(entryItem(r, units));

  // 2) Manual wearable metrics — water, HRV, RHR.
  //
  // NOT screen time. It is a day's total, not a capture at a moment: typed at
  // 07:12 on the 25th it is filed under the 24th, and a feed row would say it
  // was logged at 07:12 on the 24th — a time that never happened on that day,
  // which the Coach's `captures` domain would then report as fact. It has its
  // own reads (the Log receipt, Data's row, the Coach's snapshot and series).
  const wearableRows = db.all<WearableDataRow>(
    `SELECT * FROM wearable_data
     WHERE date = ? AND source_device = 'manual' AND metric_type != ?`,
    [date, SCREEN_TIME_METRIC]
  );
  for (const r of wearableRows) rows.push(wearableItem(r, units));

  // 3) Manual body metrics — one row can carry more than one measurement.
  const bodyRows = db.all<BodyMetricRow>(
    `SELECT * FROM body_metrics
     WHERE source = 'manual' AND measured_at >= ? AND measured_at < ?`,
    [startUtc, endUtc]
  );
  for (const r of bodyRows) {
    for (const column of BODY_COLUMNS) {
      if (r[column] != null) rows.push(bodyItem(r, column, units));
    }
  }

  // 4) Symptoms — their own table (0004), keyed on the local `date` column.
  const symptomRows = db.all<SymptomFeedRow>(
    `SELECT id, date, name, severity, created_at FROM symptoms WHERE date = ?`,
    [date]
  );
  for (const r of symptomRows) rows.push(symptomItem(r));

  // Newest first by insertion time.
  rows.sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0));
  return rows.map(({ sortKey: _sortKey, ...item }) => item);
}

// --- One row of the feed, per source table ------------------------------------
//
// The feed's four branches, each a function, so the Log tab's list and the
// lookup of ONE capture by its feed id (`getCapture`, below) draw a row the same
// way — the Coach's card for a capture's deletion quotes exactly the line the
// Log tab shows.

type FeedRow = LogFeedItem & { sortKey: string };

/** The body columns the feed lists, each as a row of its own. */
const BODY_COLUMNS = ['weight_kg', 'body_fat_pct', 'waist_cm'] as const;
export type BodyColumn = (typeof BODY_COLUMNS)[number];

type SymptomFeedRow = {
  id: string;
  date: string;
  name: string;
  severity: number | null;
  created_at: string;
};

function entryItem(r: LogEntryRow, units?: UnitPreferences): FeedRow {
  const base = { id: r.id, time: clockFromISO(r.created_at), sortKey: r.created_at };
  if (r.type === 'note') return { ...base, title: r.title, category: 'Note', note: true };
  if (r.type === 'metric') {
    const extras = parseValue(r.value);
    const metric = extras.metricKey ? metricByKey(extras.metricKey) : undefined;
    const title =
      metric && typeof extras.canonical === 'number'
        ? formatForUnits(metric, extras.canonical, units)
        : r.title;
    return { ...base, title, category: metric?.label ?? 'Metric' };
  }
  // Capture types (supplement / therapy / medication) — the title carries the
  // display line already.
  return { ...base, title: r.title, category: CAPTURE_CATEGORY[r.type] ?? 'Logged' };
}

function wearableItem(r: WearableDataRow, units?: UnitPreferences): FeedRow {
  const metric = metricByWearableType(r.metric_type);
  return {
    id: r.id,
    time: clockFromISO(r.created_at),
    title: metric
      ? formatForUnits(metric, r.value, units)
      : `${r.value}${r.unit ? ` ${r.unit}` : ''}`,
    category: metric?.label ?? r.metric_type,
    sortKey: r.created_at,
  };
}

function bodyItem(r: BodyMetricRow, column: BodyColumn, units?: UnitPreferences): FeedRow {
  const value = r[column] as number;
  const metric = metricByBodyColumn(column);
  return {
    id: `${r.id}:${column}`,
    time: clockFromISO(r.created_at),
    title: metric ? formatForUnits(metric, value, units) : String(value),
    category: metric?.label ?? column,
    sortKey: r.created_at,
  };
}

function symptomItem(r: SymptomFeedRow): FeedRow {
  const sev = r.severity != null ? ` · ${r.severity}/10` : '';
  return {
    id: r.id,
    time: clockFromISO(r.created_at),
    title: `${r.name}${sev}`,
    category: 'Symptom',
    sortKey: r.created_at,
  };
}

// --- One capture: found, taken, put back (2026-09-25) --------------------------
//
// Owner, 2026-09-25: *"Add a delete with an Undo to each capture on the Log
// tab; the Coach then gets it too, behind the card."* Until then no screen and
// no repository function removed a capture, so by the parity rule the Coach
// could not either (docs/coach-domains.md §10a).
//
// **What a capture's side effects are, traced** — because the delete must take
// every one of them back, and the Undo must return every one:
//
//   - a NOTE, a GENERIC METRIC, a SUPPLEMENT / MEDICATION / THERAPY capture
//     (`log_entries`, `adhoc`): the row is the whole of it. An ad-hoc row is
//     outside every mission read (`PLANNED_ROW_SQL`), so it ticks no mission
//     item and counts toward no adherence; the capture sheet's "Part of a
//     protocol" switch is a flag on the row and nothing reads it; nothing
//     references `log_entries` (0029's header walks this). The day's
//     `daily_logs` row stays: it carries the day's own summary and notes.
//   - a SYMPTOM (`symptoms`): the row is the whole of it. Insights, the symptom
//     trend and the reports compute from the table when they are read; nothing
//     stores a status, a readiness figure or a score derived from one.
//   - WATER (`wearable_data`, manual): the row, and the sample it published to
//     Apple Health, tagged with this row's id — removed by that tag, the way
//     the water screen's Remove does (src/lib/health/publish.ts).
//   - HRV / RESTING HR typed by hand (`wearable_data`, manual): the row. They
//     are never published, and readiness reads them when it is computed.
//   - WEIGHT, BODY FAT, WAIST (`body_metrics`, manual): the row, and the sample
//     the publish walk sent — tagged with this row's id exactly like water's,
//     so it is removable by tag too (publish.ts `removeLogCapture`).
//
// The Health half needs the native seam and lives in publish.ts; what is here
// is the record half, which the headless suite drives against real SQLite.

/** Where one Log-tab row lives. */
export type CaptureKind = 'entry' | 'wearable' | 'body' | 'symptom';

/** One Log-tab row, found by the id the feed lists it under. */
export type CaptureRecord = LogFeedItem & {
  /** The logical day it is filed under — the day its Log tab lists it on. */
  date: string;
  kind: CaptureKind;
  /** The table row's own id: the feed id, less a body row's `:column`. */
  rowId: string;
  /** The body column this row of the feed is, or null. */
  column: BodyColumn | null;
  /** A manual wearable row's `metric_type` (`water_ml`, …), or null. */
  metricType: string | null;
  /** A measurement — a number in a unit — rather than a line of words. */
  measure: boolean;
};

/**
 * The capture the Log tab lists as `feedId`, drawn exactly as the feed draws it
 * — or undefined when there is none. Only what the feed shows is found: an
 * ad-hoc entry (never a mission row), a MANUAL wearable or body row (never one
 * a device wrote), a symptom.
 */
export function getCapture(
  db: Database,
  feedId: string,
  units?: UnitPreferences
): CaptureRecord | undefined {
  const cut = feedId.lastIndexOf(':');
  if (cut > 0) {
    const rowId = feedId.slice(0, cut);
    const column = feedId.slice(cut + 1) as BodyColumn;
    if (!BODY_COLUMNS.includes(column)) return undefined;
    const r = db.get<BodyMetricRow>(
      `SELECT * FROM body_metrics WHERE id = ? AND source = 'manual'`,
      [rowId]
    );
    if (!r || r[column] == null) return undefined;
    const { sortKey: _s, ...item } = bodyItem(r, column, units);
    return {
      ...item,
      date: logicalDate(new Date(r.measured_at)),
      kind: 'body',
      rowId,
      column,
      metricType: null,
      measure: true,
    };
  }

  const entry = db.get<LogEntryRow & { log_date: string }>(
    `SELECT le.*, dl.date AS log_date FROM log_entries le
       JOIN daily_logs dl ON dl.id = le.daily_log_id
     WHERE le.id = ? AND json_extract(le.value, '$.adhoc') = 1`,
    [feedId]
  );
  if (entry) {
    const { sortKey: _s, ...item } = entryItem(entry, units);
    return {
      ...item,
      date: entry.log_date,
      kind: 'entry',
      rowId: feedId,
      column: null,
      metricType: null,
      measure: entry.type === 'metric',
    };
  }

  const wearable = db.get<WearableDataRow>(
    `SELECT * FROM wearable_data
      WHERE id = ? AND source_device = 'manual' AND source_raw_id IS NULL`,
    [feedId]
  );
  if (wearable) {
    const { sortKey: _s, ...item } = wearableItem(wearable, units);
    return {
      ...item,
      date: wearable.date,
      kind: 'wearable',
      rowId: feedId,
      column: null,
      metricType: wearable.metric_type,
      measure: true,
    };
  }

  const symptom = db.get<SymptomFeedRow>(
    `SELECT id, date, name, severity, created_at FROM symptoms WHERE id = ?`,
    [feedId]
  );
  if (symptom) {
    const { sortKey: _s, ...item } = symptomItem(symptom);
    return {
      ...item,
      date: symptom.date,
      kind: 'symptom',
      rowId: feedId,
      column: null,
      metricType: null,
      measure: false,
    };
  }
  return undefined;
}

const CAPTURE_TABLE = {
  entry: 'log_entries',
  wearable: 'wearable_data',
  body: 'body_metrics',
  symptom: 'symptoms',
} as const;

/** What a capture's removal took from the record — enough to put it back. */
export type TakenCapture = {
  capture: CaptureRecord;
  /** The row as it stood, every column and its `rowid`. */
  row: SnapshotRow;
  /**
   * True when a body row held OTHER measurements too, so only this column was
   * cleared and the row stayed. ARC's keypad writes one column per row, so a
   * manual row with two is not something ARC makes; it is handled rather than
   * assumed away.
   */
  columnOnly: boolean;
};

/**
 * Remove one capture from the record — having read it whole first — and return
 * what {@link restoreCapture} needs to put it back. Null when the feed lists no
 * such capture, and then nothing is removed.
 *
 * Water goes through `deleteWaterEntry`, the water screen's own repository
 * delete. The Apple Health half is NOT here: `removeLogCapture`
 * (src/lib/health/publish.ts) calls this and then removes the published
 * sample, and it is the one function the Log tab and the Coach both call.
 */
export function takeCapture(
  db: Database,
  feedId: string,
  units?: UnitPreferences
): TakenCapture | null {
  const capture = getCapture(db, feedId, units);
  if (!capture) return null;
  const table = CAPTURE_TABLE[capture.kind];
  const row = snapshotRows(db, table, 'id = ?', [capture.rowId])[0];
  if (!row) return null;

  if (capture.kind === 'body' && capture.column !== null) {
    const column = capture.column;
    const others = BODY_MEASURE_COLUMNS.some((c) => c !== column && row[c] != null);
    if (others) {
      db.run(`UPDATE body_metrics SET ${column} = NULL WHERE id = ?`, [capture.rowId]);
      return { capture, row, columnOnly: true };
    }
  }
  if (
    capture.kind === 'wearable' &&
    metricByWearableType(capture.metricType ?? '')?.key === 'water'
  ) {
    deleteWaterEntry(db, capture.rowId);
  } else {
    db.run(`DELETE FROM ${table} WHERE id = ?`, [capture.rowId]);
  }
  return { capture, row, columnOnly: false };
}

/**
 * Put back what {@link takeCapture} took: the row verbatim — the same id, the
 * same value, the same `created_at`, so it returns to its place in the day's
 * list and to its place in the publish walk — or, for a body row that kept its
 * other measurements, that one column.
 *
 * Throws, writing nothing, when it cannot come back as it was: the row is there
 * again, a cleared column was written since, or the day it hung under is gone.
 */
export function restoreCapture(db: Database, taken: TakenCapture): void {
  const { capture, row } = taken;
  if (taken.columnOnly && capture.column !== null) {
    const column = capture.column;
    const now = db.get<Record<string, number | null>>(
      `SELECT ${column} AS value FROM body_metrics WHERE id = ?`,
      [capture.rowId]
    );
    if (!now || now.value != null) {
      throw new Error('restoreCapture: that reading has changed since, so it stays as it is.');
    }
    db.run(`UPDATE body_metrics SET ${column} = ? WHERE id = ?`, [
      row[column] ?? null,
      capture.rowId,
    ]);
    return;
  }
  restoreRow(db, CAPTURE_TABLE[capture.kind], row);
}

/** Every measurement column of `body_metrics` — what "the row holds more" asks. */
const BODY_MEASURE_COLUMNS = [
  'weight_kg',
  'body_fat_pct',
  'muscle_mass_kg',
  'bone_mass_kg',
  'visceral_fat_rating',
  'waist_cm',
  'hip_cm',
] as const;

/**
 * Render a canonical value for the keypad's "recent" line, honouring the user's
 * unit preference when supplied. `units` is optional and backward-compatible:
 * omitting it (the headless tests do) keeps the metric's fixed display unit via
 * `formatCanonical`, so existing output is unchanged; passing it resolves a
 * preference-aware DisplaySpec so "logged today" / "Last …" read in the chosen
 * unit (lb↔kg, oz↔ml, in↔cm).
 */
function formatForUnits(
  metric: MetricDescriptor,
  canonical: number,
  units?: UnitPreferences
): string {
  // A duration has no unit preference: "3h 20m" under every setting.
  if (metric.duration) return formatCanonical(metric, canonical);
  return units
    ? formatMeasured(resolveDisplay(metric, units), canonical)
    : formatCanonical(metric, canonical);
}

/**
 * A short "recent" line for the keypad drill-in: today's total for water, else
 * the last stored reading. Empty-safe. `units` (optional) renders the numbers in
 * the user's chosen unit; when omitted the metric's fixed display unit is used.
 */
export function recentSummary(
  db: Database,
  metricKey: MetricKey,
  date: string,
  units?: UnitPreferences
): string {
  const metric = metricByKey(metricKey);
  if (!metric) return '';

  if (metricKey === 'water') {
    // Total intake for the day across ALL sources (manual + a future smart
    // bottle / Apple Health) — deliberately broader than the Log feed, which
    // lists only manual captures. "How much have I had today" wants the total.
    const row = db.get<{ total: number | null }>(
      `SELECT sum(value) total FROM wearable_data WHERE metric_type = 'water_ml' AND date = ?`,
      [date]
    );
    const ml = row?.total ?? 0;
    if (!ml) return 'No water logged yet today';
    return `${formatForUnits(metric, ml, units)} logged today`;
  }

  if (metricKey === 'screen_time') {
    // The latest DAY, not the latest row written: screen time is usually typed
    // the morning after, so "last written" and "last day" differ, and the day
    // is what the number is about. And no "usually auto from Apple Health" —
    // Health carries no screen time (docs/spikes/screen-time.md §3).
    const latest = latestScreenTime(db, date);
    if (!latest) return 'No screen time logged yet';
    return `Last ${formatForUnits(metric, latest.minutes)} · ${weekdayDate(latest.date)}`;
  }

  const target = metric.target;
  let last: { value: number; at: string } | undefined;

  if (target.kind === 'body') {
    last = db.get<{ value: number; at: string }>(
      `SELECT ${target.column} value, measured_at at FROM body_metrics
       WHERE ${target.column} IS NOT NULL ORDER BY measured_at DESC LIMIT 1`
    );
  } else if (target.kind === 'wearable') {
    last = db.get<{ value: number; at: string }>(
      `SELECT value, created_at at FROM wearable_data
       WHERE metric_type = ? ORDER BY created_at DESC LIMIT 1`,
      [target.metricType]
    );
  } else {
    const row = db.get<{ value: string | null; at: string }>(
      `SELECT value, created_at at FROM log_entries
       WHERE type = 'metric' AND json_extract(value, '$.metricKey') = ?
       ORDER BY created_at DESC LIMIT 1`,
      [metricKey]
    );
    if (row) {
      const canonical = parseValue(row.value).canonical;
      if (typeof canonical === 'number') last = { value: canonical, at: row.at };
    }
  }

  if (!last) {
    const auto = target.kind === 'wearable' ? ' — usually auto from Apple Health' : '';
    return `No readings yet${auto}`;
  }
  return `Last ${formatForUnits(metric, last.value, units)}`;
}
