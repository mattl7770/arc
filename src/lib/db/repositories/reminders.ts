/**
 * The reminders data layer (0009_reminders.sql): nudges in, what's due out.
 *
 * Storage + in-app surfacing. OS notification delivery (expo-notifications) is a
 * native dependency and lives in src/lib/notifications/reminders.ts, which
 * schedules from these rows. The one thing that crosses that line is the DAY of
 * a bare-time one-off: it is resolved here, once, at creation (see
 * {@link createReminder}) rather than re-derived on every resync, because a
 * one-off must fire exactly once. Depends only on the {@link Database} interface
 * — never op-sqlite — so the same code runs on device and against node:sqlite in
 * db/reminders.test.mjs.
 */
import type { Database } from '../database';
import { todayISODate } from '../date';
import { newId } from '../id';
import type { NewReminder, ReminderRow } from '@/lib/reminders/types';

/**
 * The LOCAL day a bare "remind me at 21:00" means: TODAY when that clock time is
 * still ahead, TOMORROW once it has passed. Null for a malformed time — the
 * INSERT's GLOB CHECK is the thing that should reject that, loudly.
 *
 * Exported because the Coach's confirmation card has to name the day BEFORE the
 * write happens (`setReminderTool.confirmSummary`), and it must be the same day
 * {@link createReminder} will store — so both call this one function against the
 * same turn clock rather than each deriving a day of their own.
 *
 * Built componentwise from `now`'s local Y/M/D and rendered back through
 * {@link todayISODate} — never `new Date('YYYY-MM-DD')`, which some runtimes
 * read as UTC midnight and would shift the day near a timezone boundary. Day
 * arithmetic goes through the Date constructor, so month/year rollover
 * (31 Aug → 1 Sep) is handled for free.
 */
export function resolveOneOffDay(time: string, now: Date): string | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  const todayAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (todayAt.getTime() > now.getTime()) return todayISODate(now);
  return todayISODate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
}

/**
 * Persist one reminder; returns its id.
 *
 * A ONE-OFF given a time but no date gets its day resolved HERE, once, and
 * stored in `date` — "remind me at 9am" said at 22:00 becomes a dated one-off
 * for tomorrow 09:00. That is deliberate and load-bearing: a one-off must fire
 * exactly once as an OS notification, and the only way to guarantee that is to
 * pin the moment at creation.
 *
 * What the pre-fix code did instead, precisely: `reminderTrigger` resolved an
 * undated one-off to TODAY at its clock time on every call, and returned null
 * once that moment had passed — so it went quiet for the rest of that day (it
 * was never rolled forward to tomorrow). But the next DAY, the first resync
 * re-resolved "today" against the new date, found a fresh future moment, and
 * scheduled it again. Nothing marks a one-off done but the user, so that
 * repeated every day, forever: per-new-day, not per-resync. Pinning the day
 * here ends it — once dated, the row lapses on its own the moment it passes
 * (see {@link reminderTrigger}).
 *
 * `now` is injectable so headless tests are deterministic; it is only consulted
 * for that one resolution.
 */
export function createReminder(
  db: Database,
  reminder: NewReminder,
  now: Date = new Date()
): string {
  const repeat = reminder.repeat ?? 'once';
  const time = reminder.time ?? null;
  const explicitDate = reminder.date ?? null;
  const date =
    explicitDate ?? (repeat === 'once' && time != null ? resolveOneOffDay(time, now) : null);
  const id = newId(db);
  db.run(
    `INSERT INTO reminders (id, title, time, date, repeat, created_by, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, reminder.title, time, date, repeat, reminder.createdBy ?? 'user', reminder.notes ?? null]
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
 * Whether an active reminder applies on the given local day — the IN-APP
 * surfacing rule (Coach reminders card, `get_today_snapshot.remindersDueToday`,
 * `list_reminders.dueToday`, `generateDailyBrief`). Daily always; weekly when
 * the weekday matches the anchor date's. Pure — shared by the surfacing UI and
 * tests.
 *
 * A ONE-OFF's date is a "NOT BEFORE" FLOOR here, not an exact match: it is due
 * on its day and on every day after it, until the user completes or dismisses
 * it. An undated (legacy) one-off is due any day, which is the same rule with
 * no floor. That asymmetry mattered: matching the date exactly meant pinning a
 * day — something the user never asked for, done to fix the notification bug —
 * silently deleted an unfinished nudge from every due-today surface the day
 * after, permanently, while the row sat there active. A nudge that is never
 * done should keep nagging; "calm, precise, slightly ruthless" is the product.
 *
 * This is deliberately NOT the notification rule. `reminderTrigger` still
 * lapses a passed one-off to null on every resync, so the floor here can never
 * resurrect the OS notification — the two paths are independent, and
 * db/reminders.test.mjs §6 pins exactly that pairing.
 *
 * Comparison is lexicographic on 'YYYY-MM-DD', which is chronological for that
 * zero-padded shape — no Date is constructed from a date string.
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
      return reminder.date == null || reminder.date <= date;
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
