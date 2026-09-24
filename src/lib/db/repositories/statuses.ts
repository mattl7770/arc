/**
 * Day-statuses data layer (0061) — the fact the user states about themself.
 *
 * **A status is a fact. What to do about it is the Coach's call, every time.**
 * That sentence is the whole design (docs/spikes/coach-status-buttons-modes-
 * retirement.md §3.1), and it is why this file is so much smaller than the
 * day-modes repository it replaces: there is no registry behind it, nothing
 * branches on the label, and no function here reshapes a day. A row records
 * that the user said "I'm sick"; the mission, the plan and the tone are then
 * the model's business, through gated writes, in a turn the user is present
 * for.
 *
 * What is deterministic — and is therefore all this file does — is ACCOUNTING.
 * The ledger has to know which days are excused, and the readiness baselines
 * have to know which days get no vote on what normal looks like, on days the
 * Coach is never opened at all.
 *
 * ## The two predicates, and why they are not the same predicate
 *
 * {@link statusDaysIn} is every day covered by any status. {@link
 * excusingStatusDaysIn} is the subset whose row has `excuses = 1`. They answer
 * different questions and the owner answered those questions separately:
 *
 *   - **Excusal is per status** (his Q2(b)): the Coach decides, through a flag
 *     on `set_status`. A status the Coach judged to be context without
 *     absolution is still a status — it just does not forgive the skips.
 *   - **Baseline exclusion is uniform** (his Q3(a)): *"status days leave the
 *     30-day readiness baselines while the status is open"*, with no mention of
 *     excusal. That is the right shape independently, because the two ask
 *     different things of the day. Excusal asks *should this be held against
 *     him*; a baseline asks *is this day evidence of what his normal looks
 *     like*. A fortnight of work crunch the Coach decided not to excuse is
 *     still a fortnight that should not define a resting heart rate.
 *
 * Several statuses may be open at once — sick AND traveling is an ordinary
 * Tuesday — so neither predicate supersedes anything; both are unions.
 *
 * Pure over the {@link Database} interface, headless-tested in
 * db/statuses.test.mjs.
 */
import type { Database } from '../database';
import { localDaysList } from '../date';
import { newId } from '../id';

/** Who put the row there. Provenance as a column, 0034's rule. */
export type StatusSource = 'user' | 'coach';

export type DayStatusRow = {
  id: string;
  /** Trimmed and lower-cased on the way in; surfaces capitalise. */
  label: string;
  start_date: string;
  /** The last day this COVERS. Null = open until ended. */
  end_date: string | null;
  /**
   * Has it been CLOSED by hand — 0 or 1. A different question from `end_date`,
   * and the migration header argues why one column cannot answer both: a Night
   * out born bounded at today and a Sick just ended today have the same span
   * and must draw differently. Accounting never reads this; only the rail,
   * the status door and its sheet, and the Coach's state block do.
   */
  ended: number;
  /** 0 or 1 — SQLite's boolean, the owner's Q2(b). `=== 1` at every reader. */
  excuses: number;
  note: string | null;
  source: StatusSource;
  created_at: string;
  updated_at: string;
};

/**
 * The canonical form of a label: trimmed, collapsed and lower-cased.
 *
 * `"  Night   Out "` and `"night out"` are the same status, and the re-tap
 * guard in {@link startStatus} depends on that being true — otherwise a second
 * tap on an on-chip would open a second row beside the first.
 */
export function normalizeStatusLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The statuses RUNNING on `date` — newest started first. What the rail draws
 * as on-chips, what the status door names and its sheet's header states, and
 * what the Coach's state block prints.
 *
 * "Running" is `ended = 0` AND the span covers the day: a status closed this
 * morning still COVERS today (its skips stay excused, which is the point of
 * never deleting a row) but is no longer on, and its chip goes dark the instant
 * the × is tapped.
 */
export function openStatuses(db: Database, date: string): DayStatusRow[] {
  return db.all<DayStatusRow>(
    `SELECT * FROM day_statuses
      WHERE ended = 0 AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)
      ORDER BY start_date DESC, rowid DESC`,
    [date, date]
  );
}

/** The running row for this label on `date`, or null. Labels are normalized. */
export function openStatusNamed(db: Database, label: string, date: string): DayStatusRow | null {
  return (
    db.get<DayStatusRow>(
      `SELECT * FROM day_statuses
        WHERE label = ? AND ended = 0 AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)
        ORDER BY start_date DESC, rowid DESC
        LIMIT 1`,
      [normalizeStatusLabel(label), date, date]
    ) ?? null
  );
}

/** Every status the Coach has scheduled but that has not started yet. */
export function scheduledStatuses(db: Database, date: string): DayStatusRow[] {
  return db.all<DayStatusRow>(
    `SELECT * FROM day_statuses WHERE ended = 0 AND start_date > ? ORDER BY start_date, rowid`,
    [date]
  );
}

/**
 * Every row whose span intersects the inclusive window, oldest start first.
 *
 * The rows themselves, not their days — what a surface needs when it has to
 * NAME the reason ("4 traveling days", a `Status` run in a report's
 * what-changed table) rather than merely filter on the day.
 */
export function statusesIn(db: Database, from: string, to: string): DayStatusRow[] {
  return rowsIntersecting(db, from, to);
}

/**
 * A row's span clipped to the inclusive window — `null` when it does not reach
 * into it at all. An OPEN end clamps to `to`, the same reading
 * {@link statusDaysIn} applies.
 */
export function clampStatusSpan(
  row: DayStatusRow,
  from: string,
  to: string
): { start: string; end: string; days: number } | null {
  if (to < from) return null;
  const start = row.start_date > from ? row.start_date : from;
  const end = row.end_date === null || row.end_date > to ? to : row.end_date;
  if (end < start) return null;
  return { start, end, days: daysBetween(start, end).length };
}

function rowsIntersecting(db: Database, from: string, to: string): DayStatusRow[] {
  return db.all<DayStatusRow>(
    `SELECT * FROM day_statuses
      WHERE start_date <= ? AND (end_date IS NULL OR end_date >= ?)
      ORDER BY start_date, rowid`,
    [to, from]
  );
}

/** `from … to` as a list of days, or empty for an inverted range. */
function daysBetween(from: string, to: string): string[] {
  if (to < from) return [];
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  // Date.UTC on the parsed parts: a pure calendar difference with no DST hour
  // to round off, exactly as activeModesIn counted its span.
  const span =
    Math.round((Date.UTC(ty!, tm! - 1, td!) - Date.UTC(fy!, fm! - 1, fd!)) / 86_400_000) + 1;
  return span > 0 ? localDaysList(to, span) : [];
}

function daysCovered(rows: DayStatusRow[], from: string, to: string): Set<string> {
  const days = new Set<string>();
  if (rows.length === 0) return days;
  for (const date of daysBetween(from, to)) {
    for (const row of rows) {
      if (row.start_date <= date && (row.end_date === null || row.end_date >= date)) {
        days.add(date);
        break;
      }
    }
  }
  return days;
}

/**
 * Every day in `from … to` covered by ANY status — the readiness baselines'
 * source (his Q3(a)).
 *
 * Each row's span is clamped to the window, and an OPEN end is clamped to `to`:
 * a status with no end date covers the window right up to its far edge and no
 * further, which is what makes "how many days has this been excluded" a
 * question about days that have actually happened. Empty for an inverted range,
 * the shape `timezoneChangedDaysIn` and `awayDaysIn` both hold.
 */
export function statusDaysIn(db: Database, from: string, to: string): Set<string> {
  return daysCovered(rowsIntersecting(db, from, to), from, to);
}

/**
 * The subset of {@link statusDaysIn} whose skips are EXCUSED — the adherence
 * ledger's source (his Q2(b)).
 *
 * A day is excused if ANY status covering it excuses. Two statuses on one day
 * disagreeing is not a conflict to resolve: "I'm sick" forgives the day whether
 * or not a non-excusing "work crunch" is also open, because the sick row is
 * still true.
 */
export function excusingStatusDaysIn(db: Database, from: string, to: string): Set<string> {
  return daysCovered(
    rowsIntersecting(db, from, to).filter((row) => row.excuses === 1),
    from,
    to
  );
}

export type StartStatusInput = {
  /** Free text; normalized here. `'normal'` is a command, never a row. */
  label: string;
  startDate: string;
  /** Inclusive last day; null/omitted = open until ended. */
  endDate?: string | null;
  note?: string | null;
  source: StatusSource;
  /**
   * Does this status excuse the day's skips?
   *
   * **Omitted means "leave it as the row has it"** on a re-tap, and `true` on a
   * genuinely new row. Those are not the same rule stated twice, and the
   * difference is the owner's, restated from the migration header:
   *
   *   - On a NEW row something has to be stored (the column is NOT NULL with no
   *     default, on purpose). It is `true`, because all five rail chips say
   *     *don't judge me by today*, because a wrong `true` is recoverable by the
   *     Coach on the very same turn, and because a wrong `false` silently
   *     counts a flu day as a run of misses.
   *   - On an EXISTING open row, an omitted flag must NEVER re-excuse a day the
   *     Coach has just un-excused. "Still sick" is a re-ask, not a re-decision.
   */
  excuses?: boolean;
};

/**
 * Open a status, or return the one already open under that label.
 *
 * **The re-tap guard** (the retired modes store had the same one, for the same
 * reason): tapping an on-chip is the RE-ASK gesture, and it must not append a
 * second row on every tap. An already-open row is returned untouched — except
 * for an explicitly-stated `excuses`, which is the Coach changing its mind and
 * is applied.
 */
export function startStatus(db: Database, input: StartStatusInput): DayStatusRow {
  const label = normalizeStatusLabel(input.label);
  const existing = openStatusNamed(db, label, input.startDate);
  if (existing) {
    if (input.excuses !== undefined && existing.excuses !== (input.excuses ? 1 : 0)) {
      db.run('UPDATE day_statuses SET excuses = ? WHERE id = ?', [
        input.excuses ? 1 : 0,
        existing.id,
      ]);
      return { ...existing, excuses: input.excuses ? 1 : 0 };
    }
    return existing;
  }

  const id = newId(db);
  db.run(
    `INSERT INTO day_statuses (id, label, start_date, end_date, excuses, note, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`, // `ended` defaults to 0 — every row is born running.
    [
      id,
      label,
      input.startDate,
      input.endDate ?? null,
      (input.excuses ?? true) ? 1 : 0,
      input.note ?? null,
      input.source,
    ]
  );
  return db.get<DayStatusRow>('SELECT * FROM day_statuses WHERE id = ?', [id])!;
}

/**
 * End one status on `date` — `ended = 1` **and** `end_date = date`, so the chip
 * goes dark at once and **today stays covered**.
 *
 * Nothing is ever deleted from a status. A Night out declared at 18:00 and
 * ended at 23:00 is not a mis-tap, and deleting the row would flip the
 * evening's skips back to misses after Home had already shown them excused. A
 * true mis-tap costs one excused day, which is the cheaper error — the prompt
 * the tap sent cannot be recalled anyway.
 *
 * Returns false when the id is not a RUNNING row covering `date`. That
 * deliberately includes a status the Coach scheduled for next week: it has not
 * begun, so there is nothing to end, and "cancel a scheduled status" is a
 * gesture this build does not have (the Coach re-states the window instead).
 */
export function endStatus(db: Database, id: string, date: string): boolean {
  const row = db.get<{ id: string }>(
    `SELECT id FROM day_statuses
      WHERE id = ? AND ended = 0 AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)`,
    [id, date, date]
  );
  if (!row) return false;
  db.run('UPDATE day_statuses SET ended = 1, end_date = ? WHERE id = ?', [date, id]);
  return true;
}

/**
 * `'normal'` — the command. Ends every status RUNNING on `date` and inserts
 * nothing; the CHECK on `label` refuses `'normal'` as a row precisely so this
 * is the only thing the word can mean. Returns how many it closed.
 *
 * A status the Coach SCHEDULED for a future day is deliberately left alone,
 * which is the opposite of what `set_mode`'s reset did. A `normal` mode row was
 * stored open-ended and newest-wins made it outrank everything created before
 * it, so it silently cancelled next week's trip and the card had to name the
 * casualties. Statuses do not supersede each other at all, so nothing forces
 * that here — and "I'm back to normal today" is not a statement about a flight
 * on Monday.
 */
export function endAllStatuses(db: Database, date: string): number {
  const open = openStatuses(db, date);
  for (const row of open) endStatus(db, row.id, date);
  return open.length;
}

/** 1-based day number of `date` within a status — "day 4" in the Coach's state block. */
export function statusDayNumber(row: DayStatusRow, date: string): number {
  const [sy, sm, sd] = row.start_date.split('-').map(Number);
  const [dy, dm, dd] = date.split('-').map(Number);
  const diff = Math.round((Date.UTC(dy!, dm! - 1, dd!) - Date.UTC(sy!, sm! - 1, sd!)) / 86_400_000);
  return diff + 1;
}
