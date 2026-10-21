/**
 * Opening the quick-log box from OUTSIDE the app — the Action Button's
 * "Log in ARC" App Intent, or an `arc://quick` link — and HOLDING the request
 * until the app can show it (item 63; ADR "Action Button via a native App
 * Intent", docs/decisions.md, 2026-10-21).
 *
 * ## The gate is the notification tap's gate
 *
 * A request is never routed on arrival. It waits behind the same gate as a
 * tapped notification (src/lib/notifications/taps.ts, whose header is the long
 * account of why): the lock's cover is down AND the root layout's own Stack is
 * in the navigation state. Routing on arrival is what mounted a second root
 * layout over the lock screen on a locked cold start. The layout supplies the
 * one gate to both queues and re-checks both when the cover lifts and on every
 * navigation state change, so an Action Button press on a locked phone opens
 * the box after Face ID — and never for whoever is holding the phone.
 *
 * ## Two doors, one request
 *
 * - **The App Intent** (modules/arc-intents). It cannot reach JavaScript
 *   directly: on a cold launch JavaScript does not exist yet when the intent
 *   runs. So it leaves a time stamp in UserDefaults and posts a notification;
 *   the ArcIntents module hands over the stamp ONCE (`takeQuickLogRequest`) and
 *   emits an event while JavaScript is listening. {@link QuickLaunchRouting.check}
 *   takes it on registration (the cold path), on the event (the warm path) and
 *   on every return to the foreground (a belt for an event that fired before the
 *   listener existed). A stamp older than {@link QUICK_REQUEST_FRESH_MS} is
 *   dropped: a request the app crashed before reading must not open the box on
 *   some unrelated launch tomorrow.
 * - **`arc://quick`**, through app/+native-intent.ts: the redirect enqueues and
 *   returns null, so expo-router navigates nowhere on its own.
 *
 * Both set the same flag, so two presses before Face ID — or the stamp and the
 * event racing on one press — open ONE box. Delivered means cleared.
 *
 * Everything here but the native source is pure; db/log.test.mjs §24 drives it
 * with a fake source and a fake gate.
 */

/** The quick-log screen (app/quick-log.tsx). */
export const QUICK_LOG_ROUTE = '/quick-log';

/** How old an intent's stamp may be and still open the box. */
export const QUICK_REQUEST_FRESH_MS = 2 * 60 * 1000;

/** The three strings the Swift side also spells — pinned by db/log.test.mjs §27. */
export const ARC_INTENTS_MODULE = 'ArcIntents';
export const QUICK_LOG_EVENT = 'onQuickLogRequested';

/**
 * Is this system path the quick-log link? `arc://quick`, `arc:///quick`,
 * `/quick`, with or without a trailing slash or a query — and never
 * `arc://quick-log`, `arc://quickly` or `arc://log/quick`.
 */
export function isQuickLink(path: string): boolean {
  const withoutScheme = path.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const bare = withoutScheme.replace(/^\/+/, '').split(/[?#]/)[0] ?? '';
  return bare.replace(/\/+$/, '').toLowerCase() === 'quick';
}

/** Is an intent's stamp recent enough to act on? A few seconds of clock skew pass. */
export function isFreshRequest(stampMs: number | null | undefined, nowMs: number): boolean {
  if (typeof stampMs !== 'number' || !Number.isFinite(stampMs)) return false;
  const age = nowMs - stampMs;
  return age >= -5000 && age <= QUICK_REQUEST_FRESH_MS;
}

/** Where intent requests come from — the ArcIntents module, or a test's fake. */
export type QuickLaunchSource = {
  /** The stamp the intent left, cleared as it is read; null when none waits. */
  take(): number | null;
  /** The intent ran while the app was alive. Returns an unsubscribe. */
  onRequest(listener: () => void): () => void;
};

/** What the layout supplies: whether it can show the box now, and how. */
export type QuickLaunchGate = {
  isReady(): boolean;
  deliver(): void;
};

/** The waiting flag, and the routers to wake when a link sets it. */
export type QuickLaunchLedger = { pending: boolean; wake: Set<() => void> };

export function createQuickLaunchLedger(): QuickLaunchLedger {
  return { pending: false, wake: new Set() };
}

const appLedger = createQuickLaunchLedger();

/**
 * The `arc://quick` door. Safe before any router is registered — a cold
 * start's initial link is read before the layout's effect runs — because the
 * flag waits in the ledger and registration flushes it.
 */
export function requestQuickLaunch(ledger: QuickLaunchLedger = appLedger): void {
  ledger.pending = true;
  for (const wake of [...ledger.wake]) wake();
}

export type QuickLaunchRouting = {
  /** Take any waiting intent request, then flush. */
  check(): void;
  /** Re-check the gate and deliver a waiting request, once. */
  flush(): void;
  /** Stop listening. A waiting request stays in the ledger for the next registration. */
  stop(): void;
};

export function routeQuickLaunches(
  source: QuickLaunchSource | null,
  gate: QuickLaunchGate,
  ledger: QuickLaunchLedger = appLedger,
  now: () => number = Date.now
): QuickLaunchRouting {
  let live = true;

  const flush = (): void => {
    if (!live || !ledger.pending) return;
    let ready = false;
    try {
      ready = gate.isReady();
    } catch {
      ready = false;
    }
    if (!ready) return;
    // Cleared BEFORE delivery: delivered means attempted, and a throw must not
    // leave the box to open again on the next state change.
    ledger.pending = false;
    try {
      gate.deliver();
    } catch (error) {
      console.warn('[quick-log] the quick-log box could not be opened', error);
    }
  };

  const check = (): void => {
    if (!live) return;
    let stamp: number | null = null;
    try {
      stamp = source?.take() ?? null;
    } catch {
      stamp = null;
    }
    if (isFreshRequest(stamp, now())) ledger.pending = true;
    flush();
  };

  ledger.wake.add(flush);
  let unsubscribe: () => void = () => {};
  try {
    unsubscribe = source?.onRequest(check) ?? (() => {});
  } catch {
    // No event: registration and the foreground re-check still take the stamp.
  }
  check();

  return {
    check,
    flush,
    stop: () => {
      live = false;
      ledger.wake.delete(flush);
      unsubscribe();
    },
  };
}

// --- Native side (guarded; no-ops without the module) ------------------------

type IntentsModule = {
  takeQuickLogRequest?(): number | null;
  addListener?(event: string, listener: () => void): { remove(): void };
};

function loadIntents(): IntentsModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const core = require('expo-modules-core') as {
      requireOptionalNativeModule?: (name: string) => IntentsModule | null;
    };
    const mod = core.requireOptionalNativeModule?.(ARC_INTENTS_MODULE) ?? null;
    return mod && typeof mod.takeQuickLogRequest === 'function' ? mod : null;
  } catch {
    return null;
  }
}

function nativeQuickLaunchSource(): QuickLaunchSource | null {
  const mod = loadIntents();
  if (!mod) return null;
  return {
    take: () => mod.takeQuickLogRequest?.() ?? null,
    onRequest: (listener) => {
      const subscription = mod.addListener?.(QUICK_LOG_EVENT, listener);
      return () => subscription?.remove();
    },
  };
}

/**
 * The app's registration (app/_layout.tsx): the native source, the app's one
 * ledger, and the layout's gate. Without the module (web, the headless suites,
 * a build predating it) it still routes `arc://quick`.
 */
export function registerQuickLaunchRouting(gate: QuickLaunchGate): QuickLaunchRouting {
  return routeQuickLaunches(nativeQuickLaunchSource(), gate);
}
