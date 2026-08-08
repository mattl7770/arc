/**
 * OS local-notification scheduling for reminders — the "while-closed nudge".
 *
 * The reminders repository (0009) is pure storage + in-app surfacing; this is
 * the delivery half it always anticipated. Design mirrors api-key-store: the
 * trigger math is a PURE, headless-tested function ({@link reminderTrigger}),
 * and the only impure part — talking to `expo-notifications` — is required in a
 * try/catch and no-ops when the native module is absent (the web logic-check
 * preview, and any binary that wasn't built with the module compiled in). So
 * nothing here crashes off-device, and `db/notifications.test.mjs` covers the
 * scheduling logic against real SQLite with no Expo loaded.
 *
 * WHETHER A NOTIFICATION ACTUALLY GETS SCHEDULED IS A RUNTIME FACT, not a fact
 * any comment or prompt string can assert: it needs the native module present
 * in the running binary AND permission granted AND a trigger that isn't in the
 * past. So nothing static in this codebase should promise a while-closed alert.
 * Instead {@link syncReminderNotifications} REPORTS what it did
 * ({@link NotificationSyncResult}), and {@link syncAndReportForReminder} turns
 * that into a per-reminder verdict the Coach can relay honestly.
 *
 * Reconciliation model: {@link syncReminderNotifications} cancels ALL of the
 * app's scheduled notifications and reschedules from the current active
 * reminders. Reminders are the only thing ARC schedules, so cancel-all-then-
 * reschedule keeps the OS schedule an exact mirror of the DB without tracking
 * per-reminder identifiers. Daily/weekly triggers repeat natively, so a resync
 * is only needed when reminders CHANGE (Coach set/complete/dismiss) or at boot.
 */
import type { Database } from '@/lib/db/database';
import { listActiveReminders } from '@/lib/db/repositories/reminders';
import type { ReminderRow } from '@/lib/reminders/types';

/**
 * An `expo-notifications` schedulable trigger. The `type` strings are the values
 * of `SchedulableTriggerInputTypes` (DATE='date', DAILY='daily', WEEKLY='weekly')
 * — using the literals keeps this module free of the native enum so the logic
 * stays pure and testable. `weekday` is 1=Sunday … 7=Saturday (expo's convention).
 */
export type ReminderTrigger =
  | { type: 'date'; date: Date }
  | { type: 'daily'; hour: number; minute: number }
  | { type: 'weekly'; weekday: number; hour: number; minute: number };

/** Parse a validated "HH:MM" into components (the DB already shape-checked it). */
function parseHM(time: string): { hour: number; minute: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** The local weekday (1=Sun…7=Sat) of a "YYYY-MM-DD" day, parsed componentwise
 * so it never shifts under the device timezone. */
function weekdayOf(date: string): number | null {
  const parts = date.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [y, m, d] = parts as [number, number, number];
  return new Date(y, m - 1, d).getDay() + 1;
}

/**
 * The OS trigger for one reminder, or null when it can't be scheduled as a
 * clock notification: an untimed reminder (in-app only), a weekly with no anchor
 * date, a one-off whose moment has already passed, or an UNDATED one-off. Pure —
 * this is the whole of the schedulability logic, and what the headless test
 * exercises.
 *
 * WHY AN UNDATED ONE-OFF RESOLVES TO NOTHING HERE. "Remind me at 9am" names a
 * clock time and no day, so it means the next 9am — but that day is resolved
 * ONCE, at creation (`createReminder` stamps `date`), not on every call to this
 * function. This function runs on every resync: at app boot and after every
 * Coach turn. The pre-fix code resolved the day HERE instead, to TODAY at the
 * reminder's clock time, and returned null once that moment had passed — so it
 * fell silent for the rest of that day (it never rolled the reminder forward to
 * tomorrow). The damage came a day later: the next day's first resync
 * re-resolved "today" against the new date, found a fresh future moment, and
 * scheduled it again — and since nothing marks a one-off done but the user, it
 * fired EVERY DAY, forever. Per-new-day, not per-resync.
 *
 * So a row that reaches here still undated is legacy data (created before the
 * resolution landed) or one whose moment is spent: it stays in-app only, which
 * is where `isDueOn` keeps surfacing it. Deliberately no migration for the
 * legacy rows — inventing a firing day for them at some arbitrary boot would
 * re-guess exactly the day this change stopped guessing.
 *
 * This path is INDEPENDENT of in-app surfacing on purpose. `isDueOn` treats a
 * one-off's date as a "not before" floor, so an unfinished nudge keeps showing
 * up in the app after its day; a trigger here still lapses to null the moment it
 * passes, so nothing it does can ever put the OS notification back.
 */
export function reminderTrigger(reminder: ReminderRow, now: Date): ReminderTrigger | null {
  if (reminder.status !== 'active' || reminder.time == null) return null;
  const hm = parseHM(reminder.time);
  if (!hm) return null;

  if (reminder.repeat === 'daily') {
    return { type: 'daily', hour: hm.hour, minute: hm.minute };
  }

  if (reminder.repeat === 'weekly') {
    if (reminder.date == null) return null;
    const weekday = weekdayOf(reminder.date);
    return weekday == null ? null : { type: 'weekly', weekday, hour: hm.hour, minute: hm.minute };
  }

  // once: one specific dated moment. Undated means the day was never resolved
  // (legacy) or is already spent — either way there is no moment to schedule.
  // Resolving the day here (to today, as this used to) is what let a one-off be
  // re-scheduled afresh each new day. Never schedule a moment in the past
  // either: the OS would fire it immediately.
  if (reminder.date == null) return null;
  const parts = reminder.date.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [y, m, d] = parts as [number, number, number];
  const when = new Date(y, m - 1, d, hm.hour, hm.minute, 0, 0);
  if (when.getTime() <= now.getTime()) return null;
  return { type: 'date', date: when };
}

// --- Native side (guarded; no-ops without the module) ------------------------

type PermissionResult = { granted: boolean; canAskAgain: boolean };
type NotificationsModule = {
  getPermissionsAsync(): Promise<PermissionResult>;
  requestPermissionsAsync(): Promise<PermissionResult>;
  cancelAllScheduledNotificationsAsync(): Promise<void>;
  scheduleNotificationAsync(request: {
    content: { title: string; body?: string; sound?: string; data?: Record<string, unknown> };
    trigger: ReminderTrigger;
  }): Promise<string>;
};

let notifications: NotificationsModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  notifications = require('expo-notifications') as NotificationsModule;
} catch {
  notifications = null;
}

/** Ask for notification permission once; returns whether it's granted. */
async function ensurePermission(mod: NotificationsModule): Promise<boolean> {
  const current = await mod.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  const requested = await mod.requestPermissionsAsync();
  return requested.granted;
}

/**
 * What one sync actually managed to do. Returned rather than logged because the
 * Coach has to tell the user the truth about whether a phone alert will fire,
 * and none of the three preconditions (module compiled in, permission granted,
 * trigger in the future) can be known statically.
 */
export type NotificationSyncResult = {
  /** Was `expo-notifications` present in the RUNNING binary? */
  moduleAvailable: boolean;
  /** Granted / denied, or null when permission was never asked (no module, or
   * nothing timed to schedule — a user with no timed reminders is never prompted). */
  permissionGranted: boolean | null;
  /** Ids an OS notification was really scheduled for, this sync. */
  scheduledIds: string[];
  /** A native call threw; scheduling was abandoned mid-way. */
  failed: boolean;
};

/**
 * Make the OS notification schedule mirror the active reminders. Cancels every
 * app-scheduled notification, then (if there's anything timed to schedule and
 * permission is granted) reschedules from the DB. Best-effort: any failure is
 * swallowed — a missed OS nudge must never break the in-app reminder, which is
 * the source of truth — but it is REPORTED in the returned result rather than
 * disappearing. Permission is only requested when there's actually a timed
 * reminder to deliver, so a user with none is never prompted.
 */
export async function syncReminderNotifications(
  db: Database,
  now: Date = new Date()
): Promise<NotificationSyncResult> {
  const mod = notifications;
  const result: NotificationSyncResult = {
    moduleAvailable: Boolean(mod) && typeof mod?.scheduleNotificationAsync === 'function',
    permissionGranted: null,
    scheduledIds: [],
    failed: false,
  };
  if (!mod || !result.moduleAvailable) return result;

  try {
    // Always clear first so a removed/cleared reminder can't linger on the OS.
    await mod.cancelAllScheduledNotificationsAsync();

    const timed = listActiveReminders(db)
      .map((reminder) => ({ reminder, trigger: reminderTrigger(reminder, now) }))
      .filter((entry): entry is { reminder: ReminderRow; trigger: ReminderTrigger } =>
        Boolean(entry.trigger)
      );
    if (timed.length === 0) return result;

    result.permissionGranted = await ensurePermission(mod);
    if (!result.permissionGranted) return result;

    for (const { reminder, trigger } of timed) {
      await mod.scheduleNotificationAsync({
        content: {
          title: reminder.title,
          body: reminder.notes ?? undefined,
          sound: 'default',
          data: { reminderId: reminder.id },
        },
        trigger,
      });
      result.scheduledIds.push(reminder.id);
    }
  } catch {
    // Notifications are a best-effort layer over the in-app reminders — swallow,
    // but say so, so nothing downstream claims an alert that isn't there.
    result.failed = true;
  }
  return result;
}

// --- Per-reminder honesty ----------------------------------------------------

/** Why a reminder is, or isn't, going to buzz the phone. */
export type ReminderDeliveryReason =
  | 'scheduled'
  | 'no-time'
  | 'no-anchor-date'
  | 'moment-passed'
  | 'module-unavailable'
  | 'permission-not-granted'
  | 'schedule-failed'
  | 'not-active';

export type ReminderDelivery = {
  /** True only when an OS notification was really created for this reminder. */
  scheduled: boolean;
  reason: ReminderDeliveryReason;
  /** One plain sentence, safe to relay to the user as-is. */
  note: string;
};

const DELIVERY_NOTE: Record<ReminderDeliveryReason, string> = {
  scheduled:
    'Saved, and an OS notification is scheduled for it — it will fire at that time even if the app is closed.',
  'no-time':
    'Saved with no time, so there is nothing to schedule against: it surfaces in the app only, with no phone alert.',
  'no-anchor-date':
    'Saved, but a weekly reminder needs an anchor date to schedule against, so no phone alert was scheduled — it surfaces in the app only.',
  // Covers both an explicitly back-dated one-off and a legacy row whose day was
  // never resolved — in either case there is no future moment left to schedule.
  'moment-passed':
    'Saved, but that moment is already past, so no phone alert was scheduled — it surfaces in the app only.',
  'module-unavailable':
    'Saved, but this build cannot schedule OS notifications, so no phone alert will fire — it surfaces in the app only.',
  'permission-not-granted':
    'Saved, but notification permission is not granted, so no phone alert will fire — it surfaces in the app only. The user can enable notifications for ARC in iOS Settings.',
  'schedule-failed':
    'Saved, but scheduling the OS notification failed, so do not promise a phone alert — it surfaces in the app.',
  'not-active':
    'Saved, but it is not an active reminder, so nothing was scheduled and it will not surface.',
};

/**
 * Re-mirror the OS schedule, then report what actually happened FOR ONE
 * reminder. This is what set_reminder hands back to the model: a dynamic,
 * observed verdict instead of a static promise. Reasons are checked in the
 * order they bite — a reminder with no time was never schedulable regardless of
 * module or permission, so that reason is the honest one to give.
 */
export async function syncAndReportForReminder(
  db: Database,
  reminderId: string,
  now: Date = new Date()
): Promise<ReminderDelivery> {
  const result = await syncReminderNotifications(db, now);
  const say = (scheduled: boolean, reason: ReminderDeliveryReason): ReminderDelivery => ({
    scheduled,
    reason,
    note: DELIVERY_NOTE[reason],
  });

  if (result.scheduledIds.includes(reminderId)) return say(true, 'scheduled');

  const row = listActiveReminders(db).find((r) => r.id === reminderId);
  if (!row) return say(false, 'not-active');

  if (reminderTrigger(row, now) == null) {
    if (row.time == null) return say(false, 'no-time');
    if (row.repeat === 'weekly' && row.date == null) return say(false, 'no-anchor-date');
    return say(false, 'moment-passed');
  }
  if (!result.moduleAvailable) return say(false, 'module-unavailable');
  if (result.permissionGranted === false) return say(false, 'permission-not-granted');
  return say(false, 'schedule-failed');
}
