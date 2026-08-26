/**
 * Day-modes data layer (0026) — READ-ONLY since the Modes feature was removed
 * (2026-08-25; ADR in docs/decisions.md, src/lib/modes/registry.ts header).
 *
 * Nothing writes `day_modes` anymore. The rows already on a device are a
 * historical record: the reports assembly re-resolves the active mode per PAST
 * day so a skip that landed under Sick/Travel/Social stays excused, and the
 * "What changed" ledger names mode runs. Migration 0043 appended one open-ended
 * `normal` row at the removal date, so — under the same newest-covering-row
 * resolution below — every date from removal on resolves Normal while every
 * date before it reads exactly as it was lived.
 *
 * The ACTIVE mode for a date is the most-recently-SET `day_modes` row whose
 * inclusive range covers it; no covering row means Normal. Pure over the
 * {@link Database} interface, headless-tested in db/modes.test.mjs.
 */
import type { Database } from '../database';
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
      // This is also what makes 0043's retirement row final: inserted last, it
      // out-ranks every earlier open-ended or future-scheduled mode.
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
