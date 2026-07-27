/**
 * The reminders data layer (0006_reminders.sql): nudges in, what's due out.
 *
 * This is storage + in-app surfacing only. OS notification delivery
 * (expo-notifications) is a native dependency and deliberately not here — when
 * it lands it schedules from these rows. Depends only on the {@link Database}
 * interface — never op-sqlite — so the same code runs on device and against
 * node:sqlite in db/reminders.test.mjs.
 */
import type { Database } from '../database';
import { newId } from '../id';
import type { NewReminder, ReminderRow } from '@/lib/reminders/types';

/** Persist one reminder; returns its id. */
export function createReminder(db: Database, reminder: NewReminder): string {
  const id = newId(db);
  db.run(
    `INSERT INTO reminders (id, title, time, date, repeat, created_by, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      reminder.title,
      reminder.time ?? null,
      reminder.date ?? null,
      reminder.repeat ?? 'once',
      reminder.createdBy ?? 'user',
      reminder.notes ?? null,
    ]
  );
  return id;
}

/**
 * Every active reminder, timed ones in clock order, untimed last, ties by
 * insertion — the Coach screen's list and the list_reminders tool both read
 * this. Filtering to "due today" is a display concern layered on top
 * (see {@link isDueOn}); the full active set is what the model should see.
 */
export function listActiveReminders(db: Database): ReminderRow[] {
  return db.all<ReminderRow>(
    `SELECT * FROM reminders WHERE status = 'active'
     ORDER BY (time IS NULL), time, created_at, id`
  );
}

/**
 * Whether an active reminder applies on the given local day. One-offs apply on
 * their date (or any day when undated); daily always; weekly when the weekday
 * matches the anchor date's. Pure — shared by the surfacing UI and tests.
 */
export function isDueOn(reminder: ReminderRow, date: string): boolean {
  if (reminder.status !== 'active') return false;
  switch (reminder.repeat) {
    case 'daily':
      return true;
    case 'weekly':
      // Compare weekdays via UTC to keep 'YYYY-MM-DD' parsing timezone-proof.
      return (
        reminder.date != null &&
        new Date(`${reminder.date}T00:00:00Z`).getUTCDay() ===
          new Date(`${date}T00:00:00Z`).getUTCDay()
      );
    default:
      return reminder.date == null || reminder.date === date;
  }
}

/** Mark a one-off reminder acted on. */
export function completeReminder(db: Database, id: string): void {
  db.run(`UPDATE reminders SET status = 'done' WHERE id = ?`, [id]);
}

/** Turn a reminder off (the way a recurring one ends). */
export function dismissReminder(db: Database, id: string): void {
  db.run(`UPDATE reminders SET status = 'dismissed' WHERE id = ?`, [id]);
}
