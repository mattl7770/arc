/**
 * The symptom log's data layer: symptoms in, the day's symptoms out.
 *
 * Symptoms live in their own `symptoms` table (0004_symptoms.sql) with
 * structured severity / body-area fields. Manual entry writes here today; a
 * future voice/NL path (Phase 3, Coach) writes the same rows with its own
 * `source`. Depends only on the {@link Database} interface — never op-sqlite —
 * so the same code runs on device and against node:sqlite in db/symptoms.test.mjs.
 */
import type { Database } from '../database';
import { todayISODate } from '../date';
import { newId } from '../id';
import type { NewSymptom, SymptomRow } from '@/lib/symptoms/types';

/** Persist one symptom; returns its id. Absent severity/area/time store as NULL. */
export function logSymptom(db: Database, symptom: NewSymptom): string {
  const id = newId(db);
  db.run(
    `INSERT INTO symptoms (id, date, time, name, severity, body_area, notes, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')`,
    [
      id,
      symptom.date,
      symptom.time ?? null,
      symptom.name,
      symptom.severity ?? null,
      symptom.bodyArea ?? null,
      symptom.notes ?? null,
    ]
  );
  return id;
}

/**
 * The day's symptoms in occurrence order — by wall-clock time, untimed last,
 * ties by insertion. `date` is the local calendar day, passed in so the
 * headless tests are deterministic.
 */
export function listTodaySymptoms(db: Database, date: string): SymptomRow[] {
  return db.all<SymptomRow>(
    `SELECT * FROM symptoms WHERE date = ? ORDER BY (time IS NULL), time, created_at, id`,
    [date]
  );
}

/**
 * `count` local-calendar dates ending at (and including) `end`, oldest first —
 * the zero-fill scaffold for {@link symptomDailySeries}. Built from Date math
 * (not a SQL date range) so callers always get exactly `count` points
 * regardless of how sparse the data is; `end` is parsed as local Y/M/D
 * components, not `new Date(string)`, which some runtimes treat as UTC
 * midnight and would shift the day near timezone boundaries.
 */
function dateListEndingAt(end: string, count: number): string[] {
  const [y, m, d] = end.split('-').map(Number);
  const dates: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    dates.push(todayISODate(new Date(y!, m! - 1, d! - i)));
  }
  return dates;
}

export interface SymptomDayPoint {
  date: string;
  count: number;
  maxSeverity: number | null;
}

/**
 * Daily symptom count + peak severity for the last `days` calendar days,
 * oldest -> `today` inclusive, zero-filled (maxSeverity null) for days with
 * no symptoms — the Symptoms trend chart's data source. `today` is injectable
 * so the headless tests are deterministic.
 */
export function symptomDailySeries(
  db: Database,
  days: number = 14,
  today: string = todayISODate()
): SymptomDayPoint[] {
  const dates = dateListEndingAt(today, days);
  const rows = db.all<{ date: string; count: number; maxSeverity: number | null }>(
    `SELECT date, count(*) AS count, max(severity) AS maxSeverity
     FROM symptoms
     WHERE date >= ? AND date <= ?
     GROUP BY date`,
    [dates[0] ?? today, today]
  );
  const byDate = new Map(rows.map((r) => [r.date, r]));
  return dates.map((date) => {
    const row = byDate.get(date);
    return { date, count: row?.count ?? 0, maxSeverity: row?.maxSeverity ?? null };
  });
}
