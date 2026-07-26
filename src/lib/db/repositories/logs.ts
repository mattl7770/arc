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
 *     add rows to the same metric_type without a migration.
 *
 * Everything crosses through the metric registry (src/lib/log/metrics.ts), so
 * units and persistence targets are defined once.
 */
import type { Database } from '../database';
import { localDayUtcRange, clockFromISO, todayISODate } from '../date';
import { newId } from '../id';
import { getOrCreateDailyLog } from './mission';
import type { BodyMetricRow, LogEntryRow, WearableDataRow } from '../types';
import {
  formatCanonical,
  metricByBodyColumn,
  metricByKey,
  metricByWearableType,
  type MetricKey,
} from '@/lib/log/metrics';
import type { LogFeedItem } from '@/types/log';

const nowISO = () => new Date().toISOString();

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
    db.run(
      `INSERT INTO body_metrics (id, measured_at, ${target.column}, source) VALUES (?, ?, ?, 'manual')`,
      [newId(db), nowISO(), canonical]
    );
    return;
  }

  if (target.kind === 'wearable') {
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
export function listTodayEntries(db: Database, now: Date = new Date()): LogFeedItem[] {
  const date = todayISODate(now);
  const { startUtc, endUtc } = localDayUtcRange(now);
  const rows: (LogFeedItem & { sortKey: string })[] = [];

  // 1) Ad-hoc log_entries — notes and generic metrics.
  const logRows = db.all<LogEntryRow>(
    `SELECT le.* FROM log_entries le
       JOIN daily_logs dl ON dl.id = le.daily_log_id
     WHERE dl.date = ? AND json_extract(le.value, '$.adhoc') = 1`,
    [date]
  );
  for (const r of logRows) {
    if (r.type === 'note') {
      rows.push({
        id: r.id,
        time: clockFromISO(r.created_at),
        title: r.title,
        category: 'Note',
        note: true,
        sortKey: r.created_at,
      });
    } else if (r.type === 'metric') {
      const extras = parseValue(r.value);
      const metric = extras.metricKey ? metricByKey(extras.metricKey) : undefined;
      const title =
        metric && typeof extras.canonical === 'number'
          ? formatCanonical(metric, extras.canonical)
          : r.title;
      rows.push({
        id: r.id,
        time: clockFromISO(r.created_at),
        title,
        category: metric?.label ?? 'Metric',
        sortKey: r.created_at,
      });
    } else {
      // Capture types (supplement / therapy / medication) — the title carries
      // the display line already.
      rows.push({
        id: r.id,
        time: clockFromISO(r.created_at),
        title: r.title,
        category: CAPTURE_CATEGORY[r.type] ?? 'Logged',
        sortKey: r.created_at,
      });
    }
  }

  // 2) Manual wearable metrics — water, HRV, RHR.
  const wearableRows = db.all<WearableDataRow>(
    `SELECT * FROM wearable_data WHERE date = ? AND source_device = 'manual'`,
    [date]
  );
  for (const r of wearableRows) {
    const metric = metricByWearableType(r.metric_type);
    const title = metric
      ? formatCanonical(metric, r.value)
      : `${r.value}${r.unit ? ` ${r.unit}` : ''}`;
    rows.push({
      id: r.id,
      time: clockFromISO(r.created_at),
      title,
      category: metric?.label ?? r.metric_type,
      sortKey: r.created_at,
    });
  }

  // 3) Manual body metrics — one row can carry more than one measurement.
  const bodyRows = db.all<BodyMetricRow>(
    `SELECT * FROM body_metrics
     WHERE source = 'manual' AND measured_at >= ? AND measured_at < ?`,
    [startUtc, endUtc]
  );
  const BODY_COLUMNS = ['weight_kg', 'body_fat_pct', 'waist_cm'] as const;
  for (const r of bodyRows) {
    for (const column of BODY_COLUMNS) {
      const value = r[column];
      if (value == null) continue;
      const metric = metricByBodyColumn(column);
      rows.push({
        id: `${r.id}:${column}`,
        time: clockFromISO(r.created_at),
        title: metric ? formatCanonical(metric, value) : String(value),
        category: metric?.label ?? column,
        sortKey: r.created_at,
      });
    }
  }

  // Newest first by insertion time.
  rows.sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0));
  return rows.map(({ sortKey: _sortKey, ...item }) => item);
}

/**
 * A short "recent" line for the keypad drill-in: today's total for water, else
 * the last stored reading. Empty-safe.
 */
export function recentSummary(db: Database, metricKey: MetricKey, date: string): string {
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
    return `${formatCanonical(metric, ml)} logged today`;
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
  return `Last ${formatCanonical(metric, last.value)}`;
}
