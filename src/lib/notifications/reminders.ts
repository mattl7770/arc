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
 * app's scheduled notifications and reschedules from every source ARC has.
 * There are four now, and they all live in this one pass because the
 * cancel-all would wipe a second scheduler's work:
 *
 *   1. active `reminders` rows with a time (0009) — his own, or the Coach's
 *      on his say-so through `set_reminder`;
 *   2. the morning check-in, when he turned it on in Settings › Coach (0064);
 *   3. protocol items that asked for a nudge (C10, ./protocol-reminders.ts);
 *   4. the Coach's own nudges (0064, `coach_nudges`, ./nudge-plan.ts).
 *
 * Cancel-all-then-reschedule keeps the OS schedule an exact mirror of the DB
 * without tracking per-row identifiers. (This header said reminders were the
 * only thing ARC schedules until 2026-09-25; that stopped being true with C10.)
 * The rest timer (./rest-timer.ts) is the one notification outside this pass,
 * and a resync also wipes it — a documented, accepted cost.
 *
 * **iOS keeps only the 64 soonest pending notifications per app** and drops
 * the rest without a word. Nothing guarded the total before 0064. Now every
 * pass fits {@link NOTIFICATION_BUDGET}; see `runReminderSyncPass` for the
 * order in which the budget is spent.
 */
import type { Database } from '@/lib/db/database';
import { getDayStartsAt } from '@/lib/db/date';
import { getNudgeSettings, upcomingNudges } from '@/lib/db/repositories/coach-nudges';
import { listActiveReminders } from '@/lib/db/repositories/reminders';
import type { ReminderRow } from '@/lib/reminders/types';

import { protocolRemindersDue } from './protocol-reminders';

/**
 * How many notifications one sync will leave pending. iOS keeps 64 and drops
 * the rest silently; four are left for the rest timer, which schedules outside
 * this pass, and for whatever a future feature adds before anyone remembers
 * this number.
 */
export const NOTIFICATION_BUDGET = 60;

/** The morning check-in's own words: no health content, ever (plan §3(e)1). */
export const CHECKIN_TITLE = 'Morning check-in';

/** The title a Coach nudge carries above its line on the lock screen. */
export const NUDGE_TITLE = 'Coach';

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
type NotificationResponse = {
  notification: {
    request: { identifier?: string; content: { data?: Record<string, unknown> } };
  };
};
type Subscription = { remove(): void };

/**
 * What ARC puts in a notification. `interruptionLevel` is set on the Coach's
 * nudges only, to `'active'` — the ordinary level. The plan (§3(e)3): the
 * Coach's opinion must never break through his Focus, and while the binary
 * holds no Time Sensitive entitlement iOS enforces that anyway; stating it
 * keeps a future entitlement from quietly changing it.
 */
export type NotificationContent = {
  title: string;
  body?: string;
  sound?: string;
  interruptionLevel?: 'active';
  data?: Record<string, unknown>;
};

type NotificationsModule = {
  getPermissionsAsync(): Promise<PermissionResult>;
  requestPermissionsAsync(): Promise<PermissionResult>;
  cancelAllScheduledNotificationsAsync(): Promise<void>;
  scheduleNotificationAsync(request: {
    content: NotificationContent;
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
  /** Forget the launching tap once it is handled (optional: older builds lack it). */
  clearLastNotificationResponse?(): void;
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

/**
 * The four things a sync pass does to the OS, as a seam.
 *
 * Extracted for the same reason `publishBodyMetrics` takes `deps`: the pass's
 * INTERESTING behaviour — what it cancels, what it reschedules, and what a
 * re-anchor after a zone change actually yields — is logic, and logic that can
 * only be observed through a native module is logic nothing asserts. The
 * headless suite injects a recorder and reads the schedule back.
 */
export type ReminderSyncDeps = {
  /** Is `expo-notifications` in the RUNNING binary at all? */
  available(): boolean;
  cancelAll(): Promise<void>;
  ensurePermission(): Promise<boolean>;
  schedule(request: { content: NotificationContent; trigger: ReminderTrigger }): Promise<void>;
};

/** The real thing: a no-op on every count when the module is absent. */
export const NATIVE_REMINDER_DEPS: ReminderSyncDeps = {
  available: () => notificationsAvailable(),
  cancelAll: async () => {
    await notifications?.cancelAllScheduledNotificationsAsync();
  },
  ensurePermission: async () => (notifications ? ensurePermission(notifications) : false),
  schedule: async (request) => {
    await notifications?.scheduleNotificationAsync(request);
  },
};

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

/**
 * What a tapped notification wants ARC to open. Every Coach-side kind lands on
 * the Coach tab; what differs is what happens there (app/_layout.tsx):
 *
 *   reminder  that reminder highlighted, with "Talk about this". When it is a
 *             CHECK-IN (0064, owner's Q5) the Coach also speaks first.
 *   checkin   the morning check-in: the Coach speaks first unless the day's
 *             note already exists, in which case the thread shows it.
 *   nudge     the nudge's own line is added to the thread as the Coach's
 *             latest message, so his reply has context.
 */
export type NotificationRoute =
  | { kind: 'reminder'; id: string; checkin: boolean }
  | { kind: 'checkin' }
  | { kind: 'nudge'; id: string }
  /** A protocol item's own nudge (C10) — the tap belongs on the mission, where
   *  the item can actually be ticked, not on the protocol's reference screen. */
  | { kind: 'mission' };

/** Map a notification's data payload to where the tap should land. */
export function routeForNotification(
  data: Record<string, unknown> | undefined
): NotificationRoute | null {
  if (!data) return null;
  if (data.kind === 'nudge') {
    return typeof data.nudgeId === 'string' ? { kind: 'nudge', id: data.nudgeId } : null;
  }
  if (data.kind === 'checkin') return { kind: 'checkin' };
  if (typeof data.protocolItem === 'string') return { kind: 'mission' };
  if (typeof data.reminderId === 'string') {
    return { kind: 'reminder', id: data.reminderId, checkin: data.checkin === true };
  }
  return null;
}

/**
 * Route notification taps. Handles both a tap that opened the app cold (the
 * response is waiting) and taps while it runs. Returns an unsubscribe.
 *
 * Before this, `data.reminderId` was attached to every scheduled notification
 * and read by nothing: tapping a reminder dumped the user on Home with no idea
 * why the phone had buzzed.
 *
 * **Each tap is routed once (0064).** A cold start can hand the same response
 * to both the waiting-response read and the listener, and the waiting response
 * outlives a JS reload. That was a double navigation before; now a tap can
 * start a paid check-in pass, so a response is remembered by its request
 * identifier and the launching one is cleared once handled. The check-in and
 * nudge paths are idempotent underneath as well (pass-store.ts) — this is the
 * first of two locks, not the only one.
 */
export function registerNotificationRouting(
  onRoute: (route: NotificationRoute) => void
): () => void {
  const mod = notifications;
  if (!mod || typeof mod.addNotificationResponseReceivedListener !== 'function') return () => {};
  const handle = (response: NotificationResponse | null | undefined): void => {
    if (!response) return;
    const id = response.notification.request.identifier;
    if (id !== undefined) {
      if (routedResponses.has(id)) return;
      routedResponses.add(id);
    }
    const route = routeForNotification(response.notification.request.content.data);
    if (route) onRoute(route);
  };
  try {
    // A cold start FROM a tap: the response is already waiting.
    void mod.getLastNotificationResponseAsync?.().then((response) => {
      handle(response);
      try {
        mod.clearLastNotificationResponse?.();
      } catch {
        // Older builds: the identifier set above is the lock.
      }
    });
    const subscription = mod.addNotificationResponseReceivedListener(handle);
    return () => subscription.remove();
  } catch {
    return () => {};
  }
}

/** Request identifiers already routed in this JS session. */
const routedResponses = new Set<string>();

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
  /**
   * Protocol ITEM keys (`protocolId:itemId`) an OS notification was really
   * scheduled for. Separate from {@link scheduledIds} because the two are
   * different namespaces and `syncAndReportForReminder` answers about the
   * first — folding them together would let a protocol item's key satisfy a
   * question about a reminder.
   */
  scheduledProtocolItems: string[];
  /** `coach_nudges` ids an OS notification was really scheduled for (0064). */
  scheduledNudges: string[];
  /** The morning check-in was scheduled as a daily notification (0064). */
  checkinScheduled: boolean;
  /**
   * How many notifications the budget left out this sync — reminders, the
   * check-in, protocol items and nudges together. 0 on any ordinary phone. Not
   * an error: iOS would have dropped them itself, silently; this says so.
   */
  overBudget: number;
  /** A native call threw; scheduling was abandoned mid-way. */
  failed: boolean;
};

/**
 * The last sync's result, for a screen that has to say whether what it lists
 * will actually buzz (the Coach tab's Scheduled list). Null until a sync has
 * run in this session. Not a store: the list re-reads it when it re-reads the
 * rows, which is on focus and after every change it makes.
 */
let lastSync: NotificationSyncResult | null = null;

export function getLastNotificationSync(): NotificationSyncResult | null {
  return lastSync;
}

/**
 * Make the OS notification schedule mirror the database — the active reminders
 * AND the protocol items that asked for a nudge (C10, ./protocol-reminders.ts).
 *
 * Cancels every app-scheduled notification, then (if there is anything to
 * schedule and permission is granted) reschedules from both sources. That
 * cancel-all is why the two live in ONE pass: a second scheduler's work would
 * be wiped by the next Coach turn.
 *
 * It is also what makes the whole protocol-reminder LIFECYCLE fall out with no
 * bookkeeping of its own. Every caller that changes the plan re-runs this, and
 * each case is then simply "the source no longer lists it":
 *
 *   - an edit that turns the reminder off, retimes the item, or deletes it →
 *     the re-derive rewrites today's rows and `planForDay` stops naming it;
 *   - a completed / skipped / removed item → `remindableEntries` is
 *     `status = 'pending'` only;
 *   - a paused, ended or deleted protocol → it never reaches `planForDay`.
 *
 * Best-effort: any failure is swallowed — a missed OS nudge must never break
 * the in-app reminder, which is the source of truth — but it is REPORTED in the
 * returned result rather than disappearing. Permission is only requested when
 * there is actually something to deliver, so a user with neither is never
 * prompted.
 *
 * **Serialized, with a coalescing tail.** Because this opens by cancelling the
 * whole OS schedule, two overlapping passes either double every nudge or drop
 * them — a race that has existed since `use-today-mission.ts` and `coach.tsx`
 * both began calling it, and that the timezone re-anchor would have made
 * deterministic (an eastbound overnight landing is also a day rollover, so both
 * fire on the same AppState event). A call arriving mid-pass neither joins nor
 * starts a second; it queues ONE trailing run. See the body.
 *
 * **What a re-anchor after a zone change does, stated rather than hidden.** A
 * protocol nudge is an absolute instant, built componentwise in the zone the
 * phone was in when it was scheduled, so a 07:00 magnesium set in Los Angeles
 * fires at 16:00 in London until something rebuilds the schedule. Rebuilding it
 * at the foreground that observes the change has two asymmetric consequences,
 * both deliberate: WESTBOUND, an item still owed may buzz TWICE — the day is 32
 * hours long and the item is genuinely still owed. EASTBOUND, an item whose new
 * local time has already passed is DROPPED rather than moved, because
 * {@link reminderTrigger} and `protocolRemindersDue` both refuse a moment in the
 * past. The item stays on the mission; only the buzz goes. Re-scheduling it for
 * "now + 5 minutes" was rejected: that is ARC deciding to nudge for something
 * the user may well have taken on the plane.
 */
export function syncReminderNotifications(
  db: Database,
  now: Date = new Date(),
  deps: ReminderSyncDeps = NATIVE_REMINDER_DEPS
): Promise<NotificationSyncResult> {
  if (inFlight === null) return startReminderSyncPass(db, now, deps);

  // A call arriving MID-PASS does not join the running one — unlike
  // publishBodyMetrics, where joining is honest because the running pass did the
  // caller's work too. Here it would not: the pass in flight has ALREADY read
  // the reminders, so a change made a moment ago is not in the schedule it is
  // building, and a caller handed that result would be told its change landed
  // when it did not. It does not start a second pass either: this function opens
  // by cancelling the WHOLE OS schedule, so two overlapping passes either
  // double every nudge or drop them.
  //
  // So it coalesces: ONE trailing run after the current pass settles, carrying
  // the latest caller's arguments, and every waiting caller gets that run's
  // result. publish.ts's shape with a tail instead of a join.
  trailingDb = db;
  trailingNow = now;
  trailingDeps = deps;
  trailing ??= inFlight.then(() => {
    const nextDb = trailingDb as Database;
    const nextNow = trailingNow as Date;
    const nextDeps = trailingDeps as ReminderSyncDeps;
    trailing = null;
    trailingDb = null;
    trailingNow = null;
    trailingDeps = null;
    return startReminderSyncPass(nextDb, nextNow, nextDeps);
  });
  return trailing;
}

/** The single in-flight pass, and the one trailing run coalesced behind it. */
let inFlight: Promise<NotificationSyncResult> | null = null;
let trailing: Promise<NotificationSyncResult> | null = null;
let trailingDb: Database | null = null;
let trailingNow: Date | null = null;
let trailingDeps: ReminderSyncDeps | null = null;

function startReminderSyncPass(
  db: Database,
  now: Date,
  deps: ReminderSyncDeps
): Promise<NotificationSyncResult> {
  const pass = runReminderSyncPass(db, now, deps).finally(() => {
    if (inFlight === pass) inFlight = null;
  });
  inFlight = pass;
  return pass;
}

/**
 * One sync: cancel everything, then schedule the four sources inside
 * {@link NOTIFICATION_BUDGET}.
 *
 * **How the budget is spent.** iOS's own rule is "the 64 soonest win", and the
 * dated sources follow it; the two that are HIS come first because a
 * repeating trigger has no single "soonest" to sort by, and because he chose
 * those times:
 *
 *   1. his reminders, in the list's clock order;
 *   2. the morning check-in, if he turned it on;
 *   3. protocol items AND Coach nudges, merged and soonest first — a nudge for
 *      tomorrow morning outranks a protocol item six days out, which is the
 *      order iOS would have kept them in anyway.
 *
 * Whatever does not fit is counted in `overBudget`, never scheduled to be
 * dropped by iOS without a word. Protocol items are still capped at 32 on
 * their own (PROTOCOL_REMINDER_MAX) and nudges at two a day, so on any real
 * phone the budget binds only when he has dozens of reminders.
 *
 * Quiet hours apply to the Coach's nudges only. His reminders, the check-in
 * and protocol items are exempt — he chose those times (owner's Q2).
 */
async function runReminderSyncPass(
  db: Database,
  now: Date,
  deps: ReminderSyncDeps
): Promise<NotificationSyncResult> {
  const result: NotificationSyncResult = {
    moduleAvailable: deps.available(),
    permissionGranted: null,
    scheduledIds: [],
    scheduledProtocolItems: [],
    scheduledNudges: [],
    checkinScheduled: false,
    overBudget: 0,
    failed: false,
  };
  if (!result.moduleAvailable) {
    lastSync = result;
    return result;
  }

  try {
    // Always clear first so a removed/cleared reminder can't linger on the OS.
    await deps.cancelAll();

    const timed = listActiveReminders(db)
      .map((reminder) => ({ reminder, trigger: reminderTrigger(reminder, now) }))
      .filter((entry): entry is { reminder: ReminderRow; trigger: ReminderTrigger } =>
        Boolean(entry.trigger)
      );
    const checkinTime = getNudgeSettings(db).checkinTime;
    const checkinTrigger = checkinTime ? dailyTrigger(checkinTime) : null;
    const dated = [
      ...protocolRemindersDue(db, now).map((item) => ({ when: item.when, item, nudge: null })),
      ...upcomingNudges(db, now, getDayStartsAt()).map((nudge) => ({
        when: nudge.when,
        item: null,
        nudge,
      })),
    ].sort((a, b) => a.when.getTime() - b.when.getTime());
    if (timed.length === 0 && dated.length === 0 && checkinTrigger === null) {
      lastSync = result;
      return result;
    }

    // The budget, spent in the order the header gives.
    let room = NOTIFICATION_BUDGET;
    const ownReminders = timed.slice(0, room);
    room -= ownReminders.length;
    const checkin = checkinTrigger !== null && room > 0 ? checkinTrigger : null;
    if (checkin) room -= 1;
    const datedSlots = dated.slice(0, Math.max(0, room));
    result.overBudget =
      timed.length -
      ownReminders.length +
      (checkinTrigger !== null && checkin === null ? 1 : 0) +
      dated.length -
      datedSlots.length;

    result.permissionGranted = await deps.ensurePermission();
    if (!result.permissionGranted) {
      lastSync = result;
      return result;
    }

    for (const { reminder, trigger } of ownReminders) {
      await deps.schedule({
        content: {
          title: reminder.title,
          body: reminder.notes ?? undefined,
          sound: 'default',
          // `checkin` rides the payload so the TAP knows, without a read, that
          // the Coach should speak first (0064).
          data: { reminderId: reminder.id, ...(reminder.checkin === 1 ? { checkin: true } : {}) },
        },
        trigger,
      });
      result.scheduledIds.push(reminder.id);
    }

    if (checkin) {
      await deps.schedule({
        // The title only. A fixed daily notification cannot know the day it
        // lands on, so it carries no health content — the tap is where the
        // Coach reads the night and speaks.
        content: { title: CHECKIN_TITLE, sound: 'default', data: { kind: 'checkin' } },
        trigger: checkin,
      });
      result.checkinScheduled = true;
    }

    for (const slot of datedSlots) {
      if (slot.item) {
        const item = slot.item;
        await deps.schedule({
          content: {
            title: item.title,
            body: item.body ?? undefined,
            sound: 'default',
            data: { protocolItem: item.key, protocolId: item.protocolId },
          },
          // One dated moment, never a repeating trigger: a repeat would keep
          // firing on days the item was already done, and nothing about a
          // recurring OS trigger can be told that the plan changed.
          trigger: { type: 'date', date: item.when },
        });
        result.scheduledProtocolItems.push(item.key);
      } else if (slot.nudge) {
        const nudge = slot.nudge;
        await deps.schedule({
          content: {
            title: NUDGE_TITLE,
            body: nudge.body,
            sound: 'default',
            interruptionLevel: 'active',
            data: { kind: 'nudge', nudgeId: nudge.id },
          },
          // Built from the row's logical day and clock at THIS sync, under the
          // zone the phone is in now — so a trip re-anchors it, as it does a
          // protocol item, and an eastbound moment already past never arrives
          // here (`upcomingNudges` is strictly future).
          trigger: { type: 'date', date: nudge.when },
        });
        result.scheduledNudges.push(nudge.id);
      }
    }
  } catch {
    // Notifications are a best-effort layer over the in-app reminders — swallow,
    // but say so, so nothing downstream claims an alert that isn't there.
    result.failed = true;
  }
  lastSync = result;
  return result;
}

/** A validated `HH:MM` as a daily repeating trigger. */
function dailyTrigger(time: string): ReminderTrigger | null {
  const hm = parseHM(time);
  return hm ? { type: 'daily', hour: hm.hour, minute: hm.minute } : null;
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
    'Saved, but notification permission is not granted, so no phone alert will fire — it surfaces in the app only. Notifications for ARC can be turned on in iOS Settings.',
  'schedule-failed':
    'Saved, but scheduling the OS notification failed, so no phone alert will fire — it surfaces in the app only.',
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
