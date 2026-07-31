import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { getDb } from '@/lib/db/client';
import { getPreferences } from '@/lib/db/repositories/user';
import {
  APP_LOCK_RELOCK_MS,
  authenticateForAppLock,
  isAppLockSupported,
} from '@/lib/security/app-lock';

/**
 * The app-lock gate's state machine — consumed once, by app/_layout.tsx.
 *
 * Cold start: the enabled/supported check runs synchronously in the state
 * initializer (op-sqlite is sync, matching use-unit-preferences.ts), so the
 * very first render already knows whether to gate — no unlocked flash. While
 * `coldStart && locked`, the layout mounts the lock screen INSTEAD of the
 * Stack: no screen renders, no content exists to reveal.
 *
 * Leaving the foreground: `covered` mounts the opaque lock surface the moment
 * the app enters the background (cover on exit, decide on entry), so the iOS
 * app-switcher snapshot shows the lock — not health data — and returning never
 * flashes content while the JS 'active' handler catches up. Deliberately NOT
 * done on 'inactive': the export share sheet and the Face ID prompt itself
 * hold the app 'inactive', and covering then would bury those sheets. The
 * cost is that a quick app-switcher peek (inactive, never backgrounded) shows
 * live content — accepted for a single-user device.
 *
 * Returning: away >= {@link APP_LOCK_RELOCK_MS} — or a NEGATIVE elapsed time,
 * so winding the clock back can't dodge the timer — escalates the cover to
 * `locked` (auth required); a shorter hop just lifts the cover. The preference
 * is re-read from the DB on each transition, so a toggle flipped in Settings
 * takes effect without any cross-component wiring.
 *
 * A failed or cancelled prompt keeps `locked` true — the only paths out are a
 * successful auth or the two documented fail-open outcomes (module absent /
 * no device credentials, see src/lib/security/app-lock.ts).
 */
export function useAppLock(): {
  /** Auth required. Implies the lock surface is shown. */
  locked: boolean;
  /** Lock surface shown (backgrounded with the lock enabled, or locked). */
  covered: boolean;
  /** True until the first unlock — the layout gates by early return. */
  coldStart: boolean;
  unlocking: boolean;
  retry: () => void;
} {
  const [state, setState] = useState(() => {
    const lockedAtBoot = isLockEnabled();
    return { locked: lockedAtBoot, covered: lockedAtBoot, everUnlocked: !lockedAtBoot };
  });
  const [unlocking, setUnlocking] = useState(false);
  // Ref, not state: the AppState listener must see the in-flight flag
  // synchronously (our own Face ID sheet flaps the app state).
  const authBusy = useRef(false);
  const backgroundedAt = useRef<number | null>(null);

  const attemptUnlock = useCallback(async () => {
    if (authBusy.current) return;
    authBusy.current = true;
    setUnlocking(true);
    try {
      const outcome = await authenticateForAppLock();
      // 'failed' (incl. cancel) keeps the lock; everything else opens — see the
      // fail-open rules in src/lib/security/app-lock.ts.
      if (outcome !== 'failed') {
        setState({ locked: false, covered: false, everUnlocked: true });
      }
    } finally {
      authBusy.current = false;
      setUnlocking(false);
    }
  }, []);

  // Prompt whenever the lock engages: once at cold start (locked is true from
  // the initializer) and again on each re-lock. Re-locks are only set in the
  // 'active' branch below, so the prompt never fires while backgrounded. After
  // a failed prompt the state doesn't change, so this never loops — the retry
  // button takes over.
  useEffect(() => {
    if (state.locked) void attemptUnlock();
  }, [state.locked, attemptUnlock]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      // The auth prompt itself drives app-state flaps; while it is up, nothing
      // here should count as leaving the app. (If the user truly backgrounds
      // mid-prompt, the prompt fails and `locked` stays true — still covered.)
      if (authBusy.current) return;
      if (next === 'background') {
        backgroundedAt.current = Date.now();
        // Cover NOW so the app-switcher snapshot is the lock surface.
        if (isLockEnabled()) {
          setState((prev) => (prev.covered ? prev : { ...prev, covered: true }));
        }
      } else if (next === 'active') {
        const away = backgroundedAt.current;
        backgroundedAt.current = null;
        if (away === null) return;
        const elapsed = Date.now() - away;
        // Negative elapsed = the wall clock moved backwards while away; treat
        // it as expired, or setting the clock back would skip the lock.
        if ((elapsed < 0 || elapsed >= APP_LOCK_RELOCK_MS) && isLockEnabled()) {
          setState((prev) => ({ ...prev, locked: true, covered: true }));
        } else {
          // Short hop: lift the cover — unless auth is still owed from before.
          setState((prev) => (prev.locked ? prev : { ...prev, covered: false }));
        }
      }
    });
    return () => sub.remove();
  }, []);

  const retry = useCallback(() => {
    void attemptUnlock();
  }, [attemptUnlock]);

  return {
    locked: state.locked,
    covered: state.covered,
    coldStart: !state.everUnlocked,
    unlocking,
    retry,
  };
}

/** Fresh read of "should the gate be armed right now?" — module AND preference. */
function isLockEnabled(): boolean {
  if (!isAppLockSupported()) return false;
  try {
    return getPreferences(getDb()).appLock.enabled;
  } catch {
    // No readable DB means no readable content anywhere (every screen reads
    // it) — there is nothing for the gate to protect, so don't brick the shell.
    return false;
  }
}
