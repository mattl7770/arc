/**
 * Rest-timer OS alerts — the "notify me when rest is up, even with the app
 * closed" half of the workout logger's timer (docs/exercise-subapp.md §6).
 *
 * Mirrors src/lib/notifications/reminders.ts: the schedulable-request shape is a
 * PURE, headless-tested builder ({@link buildRestAlert}), and the only impure
 * part — talking to `expo-notifications` — is `require`d in a try/catch and
 * no-ops when the native module is absent (the current dev build until the next
 * EAS rebuild, and the web logic-check preview). So nothing here crashes
 * off-device.
 *
 * Unlike reminders (which cancel-all-then-reschedule), a rest alert is a single
 * one-shot the workout screen owns: schedule returns an id, and the screen
 * cancels THAT id when the set changes, the timer is bumped, or the workout
 * ends — so it never disturbs the reminder schedule. (The one crossover: a
 * reminder resync's cancel-all would also clear a pending rest alert; a boot or
 * Coach reminder-edit mid-rest is rare and only costs one missed buzz.)
 *
 * FLAG (native, deferred): expo-notifications is a native module. It's a
 * configured plugin, but delivery needs the next EAS dev rebuild — batched with
 * the Coach's while-closed reminders, which already depend on it.
 */

/** A one-shot time-interval trigger (SchedulableTriggerInputTypes.TIME_INTERVAL). */
export type RestTrigger = { type: 'timeInterval'; seconds: number; repeats: false };

export type RestAlertRequest = {
  content: { title: string; body: string; sound: string; data: Record<string, unknown> };
  trigger: RestTrigger;
};

/**
 * The scheduling request for a rest alert `seconds` out. Pure — clamps to at
 * least 1s (a 0s interval fires immediately / is rejected by the OS) and is what
 * the headless test exercises.
 */
export function buildRestAlert(seconds: number): RestAlertRequest {
  const safe = Math.max(1, Math.round(Number.isFinite(seconds) ? seconds : 0));
  return {
    content: {
      title: 'Rest complete',
      body: 'Time for your next set.',
      sound: 'default',
      data: { kind: 'rest-timer' },
    },
    trigger: { type: 'timeInterval', seconds: safe, repeats: false },
  };
}

// --- Native side (guarded; no-ops without the module) ------------------------

type PermissionResult = { granted: boolean; canAskAgain: boolean };
type NotificationsModule = {
  getPermissionsAsync(): Promise<PermissionResult>;
  requestPermissionsAsync(): Promise<PermissionResult>;
  scheduleNotificationAsync(request: RestAlertRequest): Promise<string>;
  cancelScheduledNotificationAsync(id: string): Promise<void>;
};

let notifications: NotificationsModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  notifications = require('expo-notifications') as NotificationsModule;
} catch {
  notifications = null;
}

async function ensurePermission(mod: NotificationsModule): Promise<boolean> {
  const current = await mod.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  const requested = await mod.requestPermissionsAsync();
  return requested.granted;
}

/**
 * Schedule a one-shot rest alert `seconds` out; returns its id (to cancel later)
 * or null when it couldn't be scheduled (no native module, no permission, or an
 * error). Best-effort — the in-app countdown is the source of truth, so a failed
 * OS alert is swallowed.
 */
export async function scheduleRestAlert(seconds: number): Promise<string | null> {
  const mod = notifications;
  if (!mod || typeof mod.scheduleNotificationAsync !== 'function') return null;
  try {
    if (!(await ensurePermission(mod))) return null;
    return await mod.scheduleNotificationAsync(buildRestAlert(seconds));
  } catch {
    return null;
  }
}

/** Cancel a previously scheduled rest alert. No-op on null / absent module. */
export async function cancelRestAlert(id: string | null): Promise<void> {
  const mod = notifications;
  if (!id || !mod || typeof mod.cancelScheduledNotificationAsync !== 'function') return;
  try {
    await mod.cancelScheduledNotificationAsync(id);
  } catch {
    // best-effort
  }
}
