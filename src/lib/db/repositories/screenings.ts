/**
 * The Screenings slice's data layer: standing preventive items and one-off
 * appointments (db/migrations/0007_screenings.sql).
 *
 * A screening is the obligation ("colonoscopy every 10 years"); an appointment
 * is the calendar event that (optionally) satisfies one. next_due is *stored*,
 * not derived on read: the repository computes it from last_completed +
 * interval_months on every write unless the caller passes an explicit date (a
 * doctor's told-you date wins over arithmetic). Home's "what's due" surfacing
 * consumes {@link dueScreenings}; this is deliberately separate from the
 * Coach's generic reminders (0006) — the Coach may later create a reminder
 * FROM a due screening, but the stores never mix.
 *
 * Works against the {@link Database} interface only — never op-sqlite — so the
 * exact same code runs on device and in the headless tests
 * (db/screenings.test.mjs).
 */
import type { Database } from '../database';
import { todayISODate } from '../date';
import { newId } from '../id';
import type {
  AppointmentInput,
  AppointmentRow,
  AppointmentStatus,
  DueScreening,
  ScreeningInput,
  ScreeningRow,
  UpcomingAppointment,
} from '@/lib/screenings/types';

// --- Date arithmetic (calendar months / days on YYYY-MM-DD strings) ----------

/**
 * `date` plus `months` calendar months, clamped to the target month's last day
 * (Jan 31 + 1 mo = Feb 28/29, not Mar 3 — JS Date alone would roll over).
 * Local Y/M/D components, never `new Date(string)`, which some runtimes treat
 * as UTC midnight and would shift the day near timezone boundaries.
 */
export function addMonthsClamped(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const targetMonth = m! - 1 + months;
  // Day 0 of the following month = the target month's last day.
  const lastDay = new Date(y!, targetMonth + 1, 0).getDate();
  return todayISODate(new Date(y!, targetMonth, Math.min(d!, lastDay)));
}

/** `date` plus `days` calendar days — the due-soon horizon arithmetic. */
export function addDaysISO(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return todayISODate(new Date(y!, m! - 1, d! + days));
}

/**
 * The next_due a write should store: an explicit override wins; otherwise
 * derive last_completed + interval_months; otherwise NULL (untracked).
 * Exported so the form can preview the derived date before saving.
 */
export function resolveNextDue(input: ScreeningInput): string | null {
  if (input.nextDue) return input.nextDue;
  if (input.lastCompleted && input.intervalMonths) {
    return addMonthsClamped(input.lastCompleted, input.intervalMonths);
  }
  return null;
}

// --- Screenings ---------------------------------------------------------------

/** Persist one screening (next_due per {@link resolveNextDue}); returns its id. */
export function addScreening(db: Database, input: ScreeningInput): string {
  const id = newId(db);
  db.run(
    `INSERT INTO screenings (id, name, category, interval_months, last_completed, next_due, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name,
      input.category,
      input.intervalMonths ?? null,
      input.lastCompleted ?? null,
      resolveNextDue(input),
      input.notes ?? null,
    ]
  );
  return id;
}

/** Full update of a screening's user-editable fields, re-resolving next_due. */
export function updateScreening(db: Database, id: string, input: ScreeningInput): void {
  db.run(
    `UPDATE screenings
     SET name = ?, category = ?, interval_months = ?, last_completed = ?, next_due = ?, notes = ?
     WHERE id = ?`,
    [
      input.name,
      input.category,
      input.intervalMonths ?? null,
      input.lastCompleted ?? null,
      resolveNextDue(input),
      input.notes ?? null,
      id,
    ]
  );
}

/**
 * Stamp a screening done on `completedOn` and roll its cadence: next_due
 * becomes completedOn + interval_months, or NULL for a one-off (nothing left
 * to track until the user schedules it again).
 */
export function markScreeningDone(
  db: Database,
  id: string,
  completedOn: string = todayISODate()
): void {
  const row = db.get<{ interval_months: number | null }>(
    'SELECT interval_months FROM screenings WHERE id = ?',
    [id]
  );
  if (!row) return;
  const nextDue = row.interval_months ? addMonthsClamped(completedOn, row.interval_months) : null;
  db.run('UPDATE screenings SET last_completed = ?, next_due = ? WHERE id = ?', [
    completedOn,
    nextDue,
    id,
  ]);
}

/** Delete a screening. Linked appointments survive (screening_id SET NULL). */
export function deleteScreening(db: Database, id: string): void {
  db.run('DELETE FROM screenings WHERE id = ?', [id]);
}

export function getScreening(db: Database, id: string): ScreeningRow | undefined {
  return db.get<ScreeningRow>('SELECT * FROM screenings WHERE id = ?', [id]);
}

/**
 * Every screening, soonest obligation first: dated rows by next_due then name,
 * untracked (next_due NULL) rows last, alphabetical. Empty-safe.
 */
export function listScreenings(db: Database): ScreeningRow[] {
  return db.all<ScreeningRow>(
    `SELECT * FROM screenings ORDER BY (next_due IS NULL), next_due, name COLLATE NOCASE`
  );
}

/**
 * Screenings needing attention as of `today`: overdue (next_due before today)
 * and due (next_due within `horizonDays` of today, inclusive), soonest first.
 * The seam Home's "what's due" card will read — colonoscopy in 3 weeks, skin
 * check overdue. `today` is injectable so the headless tests are deterministic.
 * Empty-safe: a fresh database (or one with only untracked rows) returns [].
 */
export function dueScreenings(
  db: Database,
  today: string = todayISODate(),
  horizonDays: number = 30
): DueScreening[] {
  const horizonEnd = addDaysISO(today, horizonDays);
  const rows = db.all<ScreeningRow>(
    `SELECT * FROM screenings
     WHERE next_due IS NOT NULL AND next_due <= ?
     ORDER BY next_due, name COLLATE NOCASE`,
    [horizonEnd]
  );
  return rows.map((row) => ({
    ...row,
    dueStatus: row.next_due! < today ? 'overdue' : 'due',
  }));
}

// --- Appointments -------------------------------------------------------------

/** Persist one appointment (status starts 'scheduled'); returns its id. */
export function addAppointment(db: Database, input: AppointmentInput): string {
  const id = newId(db);
  db.run(
    `INSERT INTO appointments (id, title, provider, scheduled_at, location, screening_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.title,
      input.provider ?? null,
      input.scheduledAt,
      input.location ?? null,
      input.screeningId ?? null,
      input.notes ?? null,
    ]
  );
  return id;
}

/** Full update of an appointment's user-editable fields (status is set apart). */
export function updateAppointment(db: Database, id: string, input: AppointmentInput): void {
  db.run(
    `UPDATE appointments
     SET title = ?, provider = ?, scheduled_at = ?, location = ?, screening_id = ?, notes = ?
     WHERE id = ?`,
    [
      input.title,
      input.provider ?? null,
      input.scheduledAt,
      input.location ?? null,
      input.screeningId ?? null,
      input.notes ?? null,
      id,
    ]
  );
}

/** Plain status setter — used for cancelling (no side effects). */
export function setAppointmentStatus(db: Database, id: string, status: AppointmentStatus): void {
  db.run('UPDATE appointments SET status = ? WHERE id = ?', [status, id]);
}

/**
 * Mark an appointment completed and, when it's linked to a screening, stamp
 * that screening done in the same transaction — attending the booked
 * colonoscopy *is* completing the screening, and its cadence rolls forward
 * from the visit. `completedOn` defaults to the visit's own local calendar
 * day (from scheduled_at), not the day of the tap: marking it done a week
 * later must not shift the medical history or drift next_due late per cycle.
 */
export function completeAppointment(db: Database, id: string, completedOn?: string): void {
  db.transaction(() => {
    const row = db.get<{ screening_id: string | null; scheduled_at: string }>(
      'SELECT screening_id, scheduled_at FROM appointments WHERE id = ?',
      [id]
    );
    if (!row) return;
    db.run(`UPDATE appointments SET status = 'completed' WHERE id = ?`, [id]);
    if (row.screening_id) {
      markScreeningDone(
        db,
        row.screening_id,
        completedOn ?? todayISODate(new Date(row.scheduled_at))
      );
    }
  });
}

export function deleteAppointment(db: Database, id: string): void {
  db.run('DELETE FROM appointments WHERE id = ?', [id]);
}

export function getAppointment(db: Database, id: string): AppointmentRow | undefined {
  return db.get<AppointmentRow>('SELECT * FROM appointments WHERE id = ?', [id]);
}

/**
 * Still-scheduled appointments at or after the ISO instant `from`, soonest
 * first, each carrying its linked screening's name (NULL when unlinked or the
 * screening was deleted). Completed and cancelled bookings drop out — the
 * calendar shows what's coming, not what happened. Empty-safe.
 */
export function upcomingAppointments(db: Database, from: string): UpcomingAppointment[] {
  return db.all<UpcomingAppointment>(
    `SELECT a.*, s.name AS screening_name
     FROM appointments a
     LEFT JOIN screenings s ON s.id = a.screening_id
     WHERE a.status = 'scheduled' AND a.scheduled_at >= ?
     ORDER BY a.scheduled_at, a.title COLLATE NOCASE`,
    [from]
  );
}

/**
 * Still-'scheduled' appointments strictly before `before` — bookings whose day
 * passed without being marked completed or cancelled. Without this read they'd
 * be unreachable forever (the calendar shows upcoming only), and a linked
 * screening could never be stamped done after the fact. Most recent first,
 * same joined shape as {@link upcomingAppointments}. Empty-safe.
 */
export function pastScheduledAppointments(db: Database, before: string): UpcomingAppointment[] {
  return db.all<UpcomingAppointment>(
    `SELECT a.*, s.name AS screening_name
     FROM appointments a
     LEFT JOIN screenings s ON s.id = a.screening_id
     WHERE a.status = 'scheduled' AND a.scheduled_at < ?
     ORDER BY a.scheduled_at DESC, a.title COLLATE NOCASE`,
    [before]
  );
}
