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
import { localDaysList } from '../date';
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

/**
 * The active mode for EVERY day in the inclusive range `from … to`, as one
 * read — {@link getActiveMode} answered for a window instead of a day.
 *
 * A mode spans a range, so anything that judges a stretch of days (mission
 * adherence over a fortnight) needs the mode PER DAY, and calling
 * `getActiveMode` in a loop is one query per day of history. This resolves the
 * same rule — *the most-recently-SET covering row wins* — over all of them at
 * once, by replaying the candidate rows in the order they were set and letting
 * each later row overwrite the days it covers. That is `ORDER BY created_at
 * DESC, rowid DESC LIMIT 1` read forwards, and db/modes.test.mjs asserts the
 * two agree day-for-day rather than trusting the restatement.
 *
 * **Days that resolve to Normal are OMITTED**, not stored as `'normal'`: the
 * implicit default is the common case and a Map of it is noise. Read a missing
 * key as Normal, exactly as `getActiveModeRow` returning null means Normal.
 * Empty map for an inverted range.
 */
export function activeModesIn(db: Database, from: string, to: string): Map<string, ModeKey> {
  const modes = new Map<string, ModeKey>();
  if (to < from) return modes;

  // Rows whose window intersects [from, to] at all, oldest-SET first.
  const rows = db.all<DayModeRow>(
    `SELECT * FROM day_modes
     WHERE start_date <= ? AND (end_date IS NULL OR end_date >= ?)
     ORDER BY created_at, rowid`,
    [to, from]
  );
  if (rows.length === 0) return modes;

  // Day count via Date.UTC on the parsed parts: a pure calendar difference with
  // no DST hour to round off, which a local-midnight subtraction can produce.
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const span =
    Math.round((Date.UTC(ty!, tm! - 1, td!) - Date.UTC(fy!, fm! - 1, fd!)) / 86_400_000) + 1;
  if (span <= 0) return modes;
  const dates = localDaysList(to, span);

  for (const row of rows) {
    for (const date of dates) {
      if (row.start_date <= date && (row.end_date === null || row.end_date >= date)) {
        // Later-set rows land later in this loop and overwrite — including a
        // `normal` reset, which is how it ends an open-ended Sick without the
        // old row being edited.
        if (row.mode === 'normal') modes.delete(date);
        else modes.set(date, row.mode);
      }
    }
  }
  return modes;
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
