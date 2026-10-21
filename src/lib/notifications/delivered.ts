/**
 * Notifications that have already FIRED and are sitting in Notification Centre
 * — the half of the OS state the scheduler never touched (owner, round 3:
 * *"auto clear notifications of things that are checked off, rest time, etc?"*).
 *
 * Cancelling a scheduled notification does nothing to one already delivered.
 * So before this, ticking the 07:00 creatine row left "Creatine" on the lock
 * screen all morning, and a "Rest complete" outlived the workout it was about.
 *
 * This file is the native seam only: what a delivered notification looks like
 * to ARC, and the two calls that read and remove them. It knows nothing about
 * the database. WHICH deliveries are settled is decided by the owner of each
 * kind — `settledDeliveries` in ./reminders.ts for everything the reminder
 * sync schedules, and ./rest-timer.ts for the rest alert — so each rule sits
 * next to the code that put the notification there.
 *
 * Like every notification module here, `expo-notifications` is required in a
 * try/catch: off-device, and in a binary without the module, every call is a
 * no-op and nothing throws.
 */

/** One delivered notification, as much of it as ARC reads. */
export type PresentedNotification = {
  /** The request identifier — what `dismissNotificationAsync` takes. */
  identifier: string;
  /**
   * When it was delivered. expo-notifications passes iOS's
   * `timeIntervalSince1970` through unchanged, which is SECONDS; Android
   * reports milliseconds. Read it through {@link deliveredInstant}.
   */
  date?: number;
  data?: Record<string, unknown>;
};

/** The two calls, as a seam the headless suites inject a recorder through. */
export type DeliveredDeps = {
  presented(): Promise<PresentedNotification[]>;
  dismiss(identifier: string): Promise<void>;
};

/**
 * When a delivery happened, as a Date, whichever unit the platform used.
 * Anything below 1e11 is seconds: as milliseconds it would be March 1973, and
 * as seconds 1e11 is the year 5138. Null for a missing or nonsense value.
 */
export function deliveredInstant(date: number | undefined): Date | null {
  if (typeof date !== 'number' || !Number.isFinite(date) || date <= 0) return null;
  return new Date(date < 1e11 ? date * 1000 : date);
}

/**
 * Dismiss every delivered notification `settled` picks; returns the
 * identifiers it removed. Best-effort and total: a failed read or dismissal
 * costs a notification left on the lock screen, never a thrown error, because
 * every caller is in the middle of something the user actually asked for.
 *
 * iOS dismisses by REQUEST identifier, and a repeating request (the daily
 * morning check-in) keeps one identifier across its firings, so removing
 * today's also removes an older one still sitting there. That one is older
 * than the delivery that settled it, so nothing is lost.
 */
export async function dismissDelivered(
  deps: DeliveredDeps | null | undefined,
  settled: (presented: PresentedNotification[]) => string[]
): Promise<string[]> {
  if (!deps) return [];
  let presented: PresentedNotification[];
  try {
    presented = await deps.presented();
  } catch {
    return [];
  }
  if (presented.length === 0) return [];
  let picked: string[];
  try {
    picked = [...new Set(settled(presented))];
  } catch (error) {
    console.warn('[notifications] could not decide what to clear', error);
    return [];
  }
  const done: string[] = [];
  for (const identifier of picked) {
    try {
      await deps.dismiss(identifier);
      done.push(identifier);
    } catch {
      // One that will not go stays; the rest still do.
    }
  }
  return done;
}

// --- Native side (guarded; no-ops without the module) ------------------------

type NativeNotification = {
  date?: number;
  request?: { identifier?: string; content?: { data?: Record<string, unknown> | null } };
};
type NotificationsModule = {
  getPresentedNotificationsAsync?(): Promise<NativeNotification[]>;
  dismissNotificationAsync?(identifier: string): Promise<void>;
};

let notifications: NotificationsModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  notifications = require('expo-notifications') as NotificationsModule;
} catch {
  notifications = null;
}

/** The real calls, or null when this binary cannot make them. */
export const NATIVE_DELIVERED_DEPS: DeliveredDeps | null = (() => {
  const mod = notifications;
  if (
    !mod ||
    typeof mod.getPresentedNotificationsAsync !== 'function' ||
    typeof mod.dismissNotificationAsync !== 'function'
  ) {
    return null;
  }
  return {
    presented: async () => {
      const list = (await mod.getPresentedNotificationsAsync?.()) ?? [];
      const out: PresentedNotification[] = [];
      for (const n of list) {
        const identifier = n.request?.identifier;
        if (typeof identifier !== 'string') continue;
        out.push({ identifier, date: n.date, data: n.request?.content?.data ?? undefined });
      }
      return out;
    },
    dismiss: async (identifier) => {
      await mod.dismissNotificationAsync?.(identifier);
    },
  };
})();
