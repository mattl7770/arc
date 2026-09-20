/**
 * Which protocol items want the phone to buzz, and exactly when (backlog C10).
 *
 * The reminders layer next door (./reminders.ts) delivers NUDGES the user or
 * the Coach typed. This one delivers the PLAN: an item in a protocol can opt
 * into a notification at its `scheduled_time`, per item, off by default, set in
 * the editor. Everything here is PURE over the {@link Database} interface — it
 * computes a list of moments and schedules nothing — so it is exercised against
 * real SQLite in db/reminders.test.mjs with no Expo loaded. The one impure
 * step, talking to `expo-notifications`, stays in ./reminders.ts, which owns the
 * whole OS schedule.
 *
 * ## Why this is folded into the reminders sync rather than scheduling its own
 *
 * `syncReminderNotifications` reconciles by CANCELLING EVERY app-scheduled
 * notification and rescheduling from the database. That model is right — it
 * keeps the OS an exact mirror of the DB with no per-row identifiers to track —
 * but it means a second scheduler would have its work wiped by the next Coach
 * turn. So there is one reconciliation pass over one union of sources, and this
 * module is a source, not a scheduler.
 *
 * ## The day boundary: a fire time is the OS CLOCK, not the logical day
 *
 * This is the same trap `resolveOneOffDay` documents in
 * src/lib/db/repositories/reminders.ts, arriving from the other direction. A
 * mission row belongs to a LOGICAL day (B3, src/lib/db/date.ts): under an 04:00
 * boundary the logical day D runs from calendar D 04:00 to calendar D+1 04:00.
 * An item at 21:00 is on calendar D; an item at **02:00** is on calendar
 * **D+1** — it is late at night on the day the user counts as D. Scheduling
 * both against calendar D would put the 02:00 nudge nineteen hours in the past,
 * where the OS either fires it immediately or drops it.
 *
 * {@link fireInstant} is the one place that conversion happens, and it is a
 * comparison of two `"HH:MM"` strings — which is chronological for that
 * zero-padded shape — so there is no arithmetic to get wrong.
 *
 * ## One notification per item, at its NEXT occurrence
 *
 * A future day's plan is computable without committing it: `planForDay` is a
 * pure read. So an item whose cadence next lands on Friday gets ONE dated
 * notification for Friday rather than nothing until Friday morning, and the
 * phone still nudges through a week in which ARC is never opened. Today is
 * included only while the row is still `pending` and its clock time is still
 * ahead — a ticked, skipped or removed item stops appearing at all, which is
 * the whole of "a completed item's reminder must not fire".
 *
 * ## A day COMMITTED ahead: the reads do not change, one subtraction does
 *
 * Since 2026-09-19 a day ahead can already exist as rows, with some of them
 * ticked (docs/spikes/mission-day-picker-and-future-checkoff.md). The loop
 * below still reads every future day through a plain `planForDay(db, day)`
 * with **no options**, deliberately, because those reads consult the CARRY
 * source — and the carry is what nudges a debt whose own time has already
 * passed today. An item at 07:00 missed on Monday with carry-over on: at 20:00
 * `add()` drops today's row as past, and only Tuesday's plan entry can supply
 * the nudge. Passing `{ today }` there would drop that notification outright,
 * and Tuesday's arrival can easily be after 07:00.
 *
 * What is subtracted instead is `settledPlannedItems`: on a day that HAS been
 * committed, the rows already acted on. A row ticked ahead therefore does not
 * buzz on its day, while a debt carried onto a committed-ahead tomorrow still
 * does — the carry is in the plan and its row does not exist yet, so nothing
 * subtracts it. An unseen pending row keeps its reminder, which is right: it is
 * still on the plan for that morning.
 */
import { shiftISODate, todayISODate, getDayStartsAt } from '@/lib/db/date';
import type { Database } from '@/lib/db/database';
import { planForDay } from '@/lib/db/repositories/mission-generate';
import { remindableEntries, settledPlannedItems } from '@/lib/db/repositories/mission';

/**
 * How far ahead an item's next occurrence is looked for. A week: far enough
 * that a Monday-only session set on Tuesday still gets its nudge, short enough
 * that the plan it is computed from has not had time to become fiction.
 */
export const PROTOCOL_REMINDER_HORIZON_DAYS = 7;

/**
 * Ceiling on how many protocol notifications one sync will schedule.
 *
 * iOS keeps at most **64** pending local notifications per app and silently
 * discards the rest, so an unbounded list would let a large stack evict the
 * user's own reminders. One per item and a hard cap keeps the two sources
 * sharing that budget predictably; the earliest moments win, which is the order
 * that matters.
 */
export const PROTOCOL_REMINDER_MAX = 32;

/** One protocol item's next nudge. */
export type ProtocolReminder = {
  /**
   * Stable across days and across versions: protocol + item id. It is what the
   * notification payload carries and what the dedupe below keys on, so the same
   * item cannot be scheduled twice because two days in the horizon both want it.
   */
  key: string;
  protocolId: string;
  itemId: string;
  title: string;
  /** The item's rationale, if it has one — the notification body. */
  body: string | null;
  /** The LOGICAL day this occurrence belongs to. */
  day: string;
  /** The wall-clock moment the OS should fire at. */
  when: Date;
};

/** protocol + item, the identity a reminder keeps across days and versions. */
export const protocolReminderKey = (protocolId: string, itemId: string): string =>
  `${protocolId}:${itemId}`;

/**
 * The wall-clock instant an `HH:MM` on LOGICAL day `day` actually falls at.
 *
 * Under the default `"00:00"` boundary this is simply that calendar day at that
 * time. Under a later boundary, a clock time EARLIER than the boundary belongs
 * to the next calendar morning — see the header. Built componentwise (never
 * `new Date('YYYY-MM-DD')`, which some runtimes read as UTC midnight), so it
 * cannot shift a day under the device's timezone.
 */
export function fireInstant(day: string, time: string, dayStartsAt: string): Date | null {
  const hm = /^(\d{2}):(\d{2})$/.exec(time);
  if (!hm) return null;
  const hour = Number(hm[1]);
  const minute = Number(hm[2]);
  if (hour > 23 || minute > 59) return null;
  const calendarDay = time >= dayStartsAt ? day : shiftISODate(day, 1);
  const parts = calendarDay.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [y, m, d] = parts as [number, number, number];
  return new Date(y, m - 1, d, hour, minute, 0, 0);
}

/**
 * Every protocol item with a reminder turned on, at its next occurrence — one
 * per item, earliest first, never a moment in the past.
 *
 * Today comes from the COMMITTED rows (so a completion silences it); the days
 * after come from `planForDay`, which is a pure read and commits nothing. An
 * item appearing on both is taken at its earliest, which is today.
 *
 * `now` and `dayStartsAt` are injectable so the headless tests are
 * deterministic, exactly as `reminderTrigger` and `resolveOneOffDay` are.
 */
export function protocolRemindersDue(
  db: Database,
  now: Date = new Date(),
  dayStartsAt: string = getDayStartsAt()
): ProtocolReminder[] {
  const today = todayISODate(now, dayStartsAt);
  const byKey = new Map<string, ProtocolReminder>();

  const add = (
    day: string,
    protocolId: string,
    itemId: string,
    title: string,
    body: string | null,
    time: string
  ): void => {
    const key = protocolReminderKey(protocolId, itemId);
    if (byKey.has(key)) return; // days are visited in order: the first is the next
    const when = fireInstant(day, time, dayStartsAt);
    // Never schedule a moment that has passed — the OS fires it immediately,
    // which is how a 07:00 supplement reminder ends up buzzing at lunchtime.
    if (when === null || when.getTime() <= now.getTime()) return;
    byKey.set(key, { key, protocolId, itemId, title, body, day, when });
  };

  for (const row of remindableEntries(db, today)) {
    add(today, row.protocolId, row.itemId, row.title, row.why, row.scheduledTime);
  }

  for (let offset = 1; offset < PROTOCOL_REMINDER_HORIZON_DAYS; offset++) {
    const day = shiftISODate(today, offset);
    // NO `{ today }` here — see the header. The carry source is what makes a
    // debt whose time has already passed today reachable tomorrow.
    const plan = planForDay(db, day);
    if (plan.length === 0) continue;
    // One query per day, and only for a day that actually has a plan: on a day
    // the user committed ahead, whatever he already ticked or skipped there is
    // settled and must not buzz. Empty on every ordinary future day, which is
    // all of them until the Plan screen is used.
    const settled = new Set(
      settledPlannedItems(db, day).map((row) => protocolReminderKey(row.protocolId, row.itemId))
    );
    for (const entry of plan) {
      const item = entry.extras.item;
      if (entry.extras.remind !== true || entry.protocolId === null || item === undefined) continue;
      if (entry.scheduledTime === null) continue;
      if (settled.has(protocolReminderKey(entry.protocolId, item))) continue;
      add(day, entry.protocolId, item, entry.title, entry.extras.why ?? null, entry.scheduledTime);
    }
  }

  return [...byKey.values()]
    .sort((a, b) => a.when.getTime() - b.when.getTime())
    .slice(0, PROTOCOL_REMINDER_MAX);
}
