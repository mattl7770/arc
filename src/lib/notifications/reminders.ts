/**
 * OS local-notification scheduling for reminders — the "while-closed nudge".
 *
 * The reminders repository (0009) is pure storage + in-app surfacing; this is
 * the delivery half it always anticipated. Design mirrors api-key-store: the
 * trigger math is a PURE, headless-tested function ({@link reminderTrigger}),
 * and the only impure part — talking to `expo-notifications` — is required in a
 * try/catch and no-ops when the native module is absent (the current dev build
 * until the next EAS rebuild, and the web logic-check preview). So nothing here
 * crashes off-device, and `db/notifications.test.mjs` covers the scheduling
 * logic against real SQLite with no Expo loaded.
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
 * date, or a one-off whose moment has already passed. Pure — this is the whole
 * of the schedulability logic, and what the headless test exercises.
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

  // once: a specific dated moment, or (undated) the next occurrence today. Never
  // schedule a moment in the past — the OS would fire it immediately.
  let when: Date;
  if (reminder.date != null) {
    const parts = reminder.date.split('-').map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
    const [y, m, d] = parts as [number, number, number];
    when = new Date(y, m - 1, d, hm.hour, hm.minute, 0, 0);
  } else {
    when = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hm.hour, hm.minute, 0, 0);
  }
  if (when.getTime() <= now.getTime()) return null;
  return { type: 'date', date: when };
}

// --- Native side (guarded; no-ops without the module) ------------------------

type PermissionResult = { granted: boolean; canAskAgain: boolean };
type NotificationResponse = {
  notification: { request: { content: { data?: Record<string, unknown> } } };
};
type Subscription = { remove(): void };
type NotificationsModule = {
  getPermissionsAsync(): Promise<PermissionResult>;
  requestPermissionsAsync(): Promise<PermissionResult>;
  cancelAllScheduledNotificationsAsync(): Promise<void>;
  scheduleNotificationAsync(request: {
    content: { title: string; body?: string; sound?: string; data?: Record<string, unknown> };
    trigger: ReminderTrigger;
  }): Promise<string>;
  setNotificationHandler(handler: {
    handleNotification: () => Promise<{
      shouldShowBanner: boolean;
      shouldShowList: boolean;
      shouldPlaySound: boolean;
      shouldSetBadge: boolean;
    }>;
  }): void;
  addNotificationResponseReceivedListener(
    listener: (response: NotificationResponse) => void
  ): Subscription;
  getLastNotificationResponseAsync(): Promise<NotificationResponse | null>;
};

let notifications: NotificationsModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  notifications = require('expo-notifications') as NotificationsModule;
} catch {
  notifications = null;
}

/**
 * Whether OS notification delivery is live in this binary. Resolves once at
 * module load (the native module either shipped in the build or didn't), so
 * callers may treat it as constant for the app session — the system prompt
 * reads it so the Coach never lies about the app's own reach.
 */
export function notificationsAvailable(): boolean {
  return notifications !== null && typeof notifications.scheduleNotificationAsync === 'function';
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
 * Show a notification even when ARC is FOREGROUNDED.
 *
 * Without a handler iOS silently drops a notification that fires while the app
 * is open — so a 21:00 magnesium reminder simply never appeared if the user
 * happened to be looking at ARC. Called once at boot; a no-op off-build.
 */
export function configureNotificationPresentation(): void {
  const mod = notifications;
  if (!mod || typeof mod.setNotificationHandler !== 'function') return;
  try {
    mod.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        // No badge: an unread count on a personal log is invented urgency.
        shouldSetBadge: false,
      }),
    });
  } catch {
    // Presentation is a nicety; never let it break boot.
  }
}

/** What a tapped notification wants ARC to open. */
export type NotificationRoute = { kind: 'reminder'; id: string } | { kind: 'coach' };

/** Map a notification's data payload to where the tap should land. */
export function routeForNotification(
  data: Record<string, unknown> | undefined
): NotificationRoute | null {
  if (!data) return null;
  if (data.kind === 'checkin') return { kind: 'coach' };
  if (typeof data.reminderId === 'string') return { kind: 'reminder', id: data.reminderId };
  return null;
}

/**
 * Route notification taps. Handles both a tap that opened the app cold (the
 * response is waiting) and taps while it runs. Returns an unsubscribe.
 *
 * Before this, `data.reminderId` was attached to every scheduled notification
 * and read by nothing: tapping a reminder dumped the user on Home with no idea
 * why the phone had buzzed.
 */
export function registerNotificationRouting(
  onRoute: (route: NotificationRoute) => void
): () => void {
  const mod = notifications;
  if (!mod || typeof mod.addNotificationResponseReceivedListener !== 'function') return () => {};
  try {
    // A cold start FROM a tap: the response is already waiting.
    void mod.getLastNotificationResponseAsync?.().then((response) => {
      const route = routeForNotification(response?.notification.request.content.data);
      if (route) onRoute(route);
    });
    const subscription = mod.addNotificationResponseReceivedListener((response) => {
      const route = routeForNotification(response.notification.request.content.data);
      if (route) onRoute(route);
    });
    return () => subscription.remove();
  } catch {
    return () => {};
  }
}

/**
 * Make the OS notification schedule mirror the active reminders. Cancels every
 * app-scheduled notification, then (if there's anything timed to schedule and
 * permission is granted) reschedules from the DB. Best-effort: any failure is
 * swallowed — a missed OS nudge must never break the in-app reminder, which is
 * the source of truth. Permission is only requested when there's actually a
 * timed reminder to deliver, so a user with none is never prompted.
 */
export async function syncReminderNotifications(
  db: Database,
  now: Date = new Date()
): Promise<void> {
  const mod = notifications;
  if (!mod || typeof mod.scheduleNotificationAsync !== 'function') return;

  try {
    // Always clear first so a removed/cleared reminder can't linger on the OS.
    await mod.cancelAllScheduledNotificationsAsync();

    const timed = listActiveReminders(db)
      .map((reminder) => ({ reminder, trigger: reminderTrigger(reminder, now) }))
      .filter((entry): entry is { reminder: ReminderRow; trigger: ReminderTrigger } =>
        Boolean(entry.trigger)
      );
    if (timed.length === 0) return;

    if (!(await ensurePermission(mod))) return;

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
    }
  } catch {
    // Notifications are a best-effort layer over the in-app reminders — swallow.
  }
}
