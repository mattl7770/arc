/**
 * Day-modes data layer (0026) — read/write the active mode for a day.
 *
 * The ACTIVE mode for a date is the most-recently-SET `day_modes` row whose
 * inclusive range covers it; no covering row means Normal. A `normal` row is a
 * valid explicit reset (it just becomes the most-recent covering row, ending an
 * earlier open-ended Sick/Travel without editing the old row). Pure over the
 * {@link Database} interface, headless-tested in db/modes.test.mjs.
 */
import type { Database } from '../database';
import { newId } from '../id';
import type { ModeKey } from '@/lib/modes/registry';

export type DayModeRow = {
  id: string;
  mode: ModeKey;
  start_date: string;
  end_date: string | null;
  label: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
};

/** The active mode row covering `date` (latest set wins), or null for Normal. */
export function getActiveModeRow(db: Database, date: string): DayModeRow | null {
  return (
    db.get<DayModeRow>(
      // rowid DESC is the reliable "most recently set wins" tiebreak — two modes
      // set in the same millisecond share created_at, and the id is a random
      // UUID (not insertion-ordered), so rowid (monotonic insert order) decides.
      `SELECT * FROM day_modes
       WHERE start_date <= ? AND (end_date IS NULL OR end_date >= ?)
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
      [date, date]
    ) ?? null
  );
}

/** The active mode key for `date` — 'normal' when nothing covers it. */
export function getActiveMode(db: Database, date: string): ModeKey {
  return getActiveModeRow(db, date)?.mode ?? 'normal';
}

export type SetModeInput = {
  mode: ModeKey;
  /** First day it applies (local YYYY-MM-DD). */
  startDate: string;
  /** Last day (inclusive); null/omitted = open-ended until reset. */
  endDate?: string | null;
  label?: string | null;
  note?: string | null;
};

/** Declare a mode over a day/range/open-ended window; returns the row id. */
export function setMode(db: Database, input: SetModeInput): string {
  const id = newId(db);
  db.run(
    `INSERT INTO day_modes (id, mode, start_date, end_date, label, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.mode,
      input.startDate,
      input.endDate ?? null,
      input.label ?? null,
      input.note ?? null,
    ]
  );
  return id;
}

/**
 * The non-normal modes an open-ended reset starting `date` would supersede.
 *
 * A `normal` row is stored open-ended, and "most recently SET wins" means it
 * out-ranks every mode row created before it — including ones scheduled for
 * days that have not arrived yet. So "back to normal today" also silently
 * cancels the Travel mode booked for next week. That may well be what the user
 * means, but they have to be told: this is what lets the confirmation card
 * name the casualties instead of hiding them.
 *
 * Rows whose window closed before `date` are untouched and not returned.
 */
export function modesSupersededFrom(db: Database, date: string): DayModeRow[] {
  return db.all<DayModeRow>(
    `SELECT * FROM day_modes
     WHERE mode != 'normal' AND (end_date IS NULL OR end_date >= ?)
     ORDER BY start_date, rowid`,
    [date]
  );
}

/**
 * Reset a day back to Normal from `date` onward — stored as a `normal` row
 * (the most-recent covering row wins), so an earlier open-ended mode stops
 * applying without mutating its history. Returns the new row id.
 */
export function clearMode(db: Database, date: string): string {
  return setMode(db, { mode: 'normal', startDate: date });
}
