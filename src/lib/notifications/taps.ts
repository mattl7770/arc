/**
 * Routing a tapped notification — and HOLDING it until the app can show it
 * (round 3, items 59 and 75: *"bugs on opening from a notification
 * sometimes"*, *"opening app from notifications doesn't open sometimes"*).
 *
 * ## What went wrong
 *
 * The tap used to be routed the moment its response arrived. On a cold start
 * with the app lock on, the root layout renders ONLY the lock screen — no
 * Stack — so the `router.push` landed on expo-router's own internal `__root`
 * stack, the one navigator that does exist. expo-router computes the action
 * against the navigation state it has; with the app's Stack missing, the two
 * diverge at `__root`, and the action it dispatches is a PUSH of a second
 * `__root`: a second copy of the whole root layout, mounted over the first,
 * with its own app lock and its own Face ID prompt racing the first one's (and
 * every boot side effect run again). Depending on how that race went, the tap
 * landed late, landed on a lock screen that would not take Face ID, or did
 * nothing. The tap had also been marked handled and the launching response
 * cleared before any of this, so nothing tried again after Face ID.
 *
 * A warm tap worked, because the Stack stays mounted under the lock's cover.
 *
 * ## What happens now
 *
 * A tap is QUEUED, and delivered only when the gate the layout supplies is
 * open: the lock's cover is down AND the app's own navigator is in the
 * navigation state ({@link appNavigatorMounted}). The layout re-checks the
 * gate when the cover lifts and on every navigation state change, so a tap
 * that arrived during the Face ID prompt, or before the Stack had committed,
 * is delivered the moment both are true — and never before. Its side effects
 * (a nudge written into the thread, a check-in requested) wait with it, so
 * nothing about a tap runs for whoever is holding a locked phone.
 *
 * Each delivery is handled once ({@link tapKey}): a cold start hands the same
 * response to both the waiting-response read and the listener. The launching
 * response is cleared only once it has been DELIVERED, not when it arrives.
 * The queue and the seen set are module state, so a root layout that remounts
 * picks up whatever was waiting rather than dropping it.
 *
 * Everything here but the native source is pure, and db/notifications.test.mjs
 * drives it with a fake source and a fake gate.
 */
import {
  routeForNotification,
  tapKey,
  type NotificationResponse,
  type NotificationRoute,
} from './reminders';

/** Where taps come from — `expo-notifications`, or a test's fake. */
export type TapSource = {
  /** The tap that launched the app, if one did. */
  lastResponse(): Promise<NotificationResponse | null | undefined>;
  /** Forget the launching tap once it has been delivered. */
  clearLastResponse(): void;
  /** Taps while the app runs. Returns an unsubscribe. */
  onResponse(listener: (response: NotificationResponse) => void): () => void;
};

/** What the layout supplies: whether it can show a route now, and how. */
export type TapGate = {
  isReady(): boolean;
  deliver(route: NotificationRoute): void;
};

type WaitingTap = { key: string | null; route: NotificationRoute; launching: boolean };

/** The queue and the seen set. One per app; a fresh one per test. */
export type TapLedger = { seen: Set<string>; waiting: WaitingTap[] };

export function createTapLedger(): TapLedger {
  return { seen: new Set(), waiting: [] };
}

const appLedger = createTapLedger();

export type TapRouting = {
  /** Re-check the gate and deliver whatever is waiting, in arrival order. */
  flush(): void;
  /** Stop listening. Waiting taps stay in the ledger for the next registration. */
  stop(): void;
};

/**
 * Listen for taps and deliver each one, once, when the gate is open.
 * `source` null (no native module) still returns a working, empty router.
 */
export function routeNotificationTaps(
  source: TapSource | null,
  gate: TapGate,
  ledger: TapLedger = appLedger
): TapRouting {
  let live = true;

  const forgetLaunch = (): void => {
    try {
      source?.clearLastResponse();
    } catch {
      // Older builds lack it: the seen set is the lock.
    }
  };

  const flush = (): void => {
    if (!live || ledger.waiting.length === 0) return;
    let ready = false;
    try {
      ready = gate.isReady();
    } catch {
      ready = false;
    }
    if (!ready) return;
    while (live && ledger.waiting.length > 0) {
      const tap = ledger.waiting.shift() as WaitingTap;
      try {
        gate.deliver(tap.route);
      } catch (error) {
        // Delivered means attempted: retrying would repeat its side effects.
        console.warn('[notifications] a tap could not be routed', error);
      }
      if (tap.launching) forgetLaunch();
    }
  };

  const offer = (response: NotificationResponse | null | undefined, launching: boolean): void => {
    if (!live || !response) return;
    const key = tapKey(response);
    if (key !== null && ledger.seen.has(key)) {
      // The same delivery a second time — the cold start's double hand-off, or
      // a remounted layout re-reading the launching response.
      if (launching) {
        const waiting = ledger.waiting.find((tap) => tap.key === key);
        if (waiting) waiting.launching = true;
        else forgetLaunch();
      }
      return;
    }
    if (key !== null) ledger.seen.add(key);
    const route = routeForNotification(response.notification.request.content.data);
    if (!route) {
      if (launching) forgetLaunch();
      return;
    }
    ledger.waiting.push({ key, route, launching });
    flush();
  };

  if (!source) {
    return {
      flush,
      stop: () => {
        live = false;
      },
    };
  }

  let unsubscribe: () => void = () => {};
  try {
    unsubscribe = source.onResponse((response) => offer(response, false));
  } catch {
    // No listener: the launching tap below is still read.
  }
  try {
    void source.lastResponse().then(
      (response) => offer(response, true),
      () => {}
    );
  } catch {
    // Nothing waiting can be read; taps while running still arrive.
  }

  return {
    flush,
    stop: () => {
      live = false;
      unsubscribe();
    },
  };
}

// --- Navigation state, read structurally -------------------------------------

/** The slice of a React Navigation state this module reads. */
export type NavStateLike = {
  index?: number;
  stale?: boolean;
  routes: readonly { name: string; params?: object; state?: NavStateLike }[];
};

/** The app's own Stack (app/_layout.tsx) inside expo-router's `__root`, or null. */
function appStack(rootState: NavStateLike | null | undefined): NavStateLike | null {
  if (!rootState || rootState.routes.length === 0) return null;
  const root = rootState.routes[rootState.index ?? rootState.routes.length - 1];
  const stack = root?.state;
  // A mounted navigator's state is always `stale: false`; a partial one (a deep
  // link's initial state, before the Stack renders) is not.
  return stack && stack.stale === false && stack.routes.length > 0 ? stack : null;
}

/**
 * Is the root layout's own Stack mounted? `navigationRef.isReady()` is not
 * this question: expo-router's internal `__root` stack makes it true while the
 * layout is still rendering only the lock screen, which is the whole of the
 * bug in the header.
 */
export function appNavigatorMounted(rootState: NavStateLike | null | undefined): boolean {
  return appStack(rootState) !== null;
}

/** Where a "Rest complete" tap goes. */
export type RestTapTarget =
  /** Already on the logger, or no session to show: stay. */
  | { kind: 'stay' }
  /**
   * The logger is on the stack under something else: go back to it, as it
   * was. `pops` is how many screens sit above THAT logger, so the caller pops
   * exactly to it (`router.dismiss(pops)`). Popping by name (`dismissTo`)
   * stops at the NEAREST `workout-live`, which can be a past session's editor
   * pushed over the live one, and it hands that editor the live one's params.
   */
  | { kind: 'return'; params: Record<string, unknown>; pops: number }
  /** A live session is stored but not on screen: resume it, as the hub does. */
  | { kind: 'resume' };

/**
 * Pure. The live logger is `workout-live` without a `workoutId` (with one it
 * is correcting a saved session, which has no rest timer). Returning to an
 * existing logger rather than pushing a second keeps one screen per session —
 * the draft slot has one owner.
 */
export function restTapTarget(
  rootState: NavStateLike | null | undefined,
  liveSessionStored: boolean
): RestTapTarget {
  const stack = appStack(rootState);
  if (stack) {
    const isLiveLogger = (route: { name: string; params?: object }): boolean =>
      route.name === 'workout-live' &&
      !(route.params && 'workoutId' in route.params && route.params.workoutId != null);
    const top = stack.index ?? stack.routes.length - 1;
    const focused = stack.routes[top];
    if (focused && isLiveLogger(focused)) return { kind: 'stay' };
    for (let i = top - 1; i >= 0; i--) {
      const route = stack.routes[i];
      if (route && isLiveLogger(route)) {
        return { kind: 'return', params: { ...(route.params ?? {}) }, pops: top - i };
      }
    }
  }
  return liveSessionStored ? { kind: 'resume' } : { kind: 'stay' };
}

// --- Native side (guarded; no-ops without the module) ------------------------

type NotificationsModule = {
  addNotificationResponseReceivedListener?(
    listener: (response: NotificationResponse) => void
  ): { remove(): void };
  getLastNotificationResponseAsync?(): Promise<NotificationResponse | null>;
  clearLastNotificationResponse?(): void;
};

let notifications: NotificationsModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  notifications = require('expo-notifications') as NotificationsModule;
} catch {
  notifications = null;
}

function nativeTapSource(): TapSource | null {
  const mod = notifications;
  if (!mod || typeof mod.addNotificationResponseReceivedListener !== 'function') return null;
  return {
    lastResponse: async () => (await mod.getLastNotificationResponseAsync?.()) ?? null,
    clearLastResponse: () => mod.clearLastNotificationResponse?.(),
    onResponse: (listener) => {
      const subscription = mod.addNotificationResponseReceivedListener?.(listener);
      return () => subscription?.remove();
    },
  };
}

/**
 * The app's registration (app/_layout.tsx): the native source, the app's one
 * ledger, and the layout's gate. A no-op router when the module is absent.
 */
export function registerNotificationRouting(gate: TapGate): TapRouting {
  return routeNotificationTaps(nativeTapSource(), gate);
}
