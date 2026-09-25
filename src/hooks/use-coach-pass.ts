import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { coachPassStore, type CheckinOutcome } from '@/lib/ai/pass-store';
import { apiKeyStore } from '@/lib/ai/api-key-store';
import { getDb } from '@/lib/db/client';
import { waitForHealthSyncIdle } from '@/lib/health/sync';

/**
 * The coach pass, split in two: ONE component runs it, any component may read
 * it. Fusing those into a single hook is what made the first version call the
 * model twice — the root mounted it to run the pass, Home mounted it to render
 * the note, and each mount ran its own.
 *
 * The state itself lives in src/lib/ai/pass-store.ts, which documents why.
 */

/**
 * The pass waits for the Health sync the same foreground started (0064 — the
 * two used to race, and the pass read the database before the night landed).
 * Bounded inside `waitForHealthSyncIdle`, so an unlinked or slow HealthKit
 * never holds the Coach back for more than a few seconds.
 */
const settleHealth = () => waitForHealthSyncIdle();

/**
 * Drive the pass. Mount at the ROOT and nowhere else.
 *
 * `unlocked` must be false whenever the app-lock gate is owed authentication.
 * The pass reads health data and sends it to the model API; behind a Face ID
 * prompt nobody has proven they are the user yet, so it waits.
 *
 * Four things wake it: mounting (app open); returning to the foreground —
 * after midnight, after 18:00, or once a Health sync lands a new signal, a
 * pass that wasn't due before becomes due; the API-key store emitting, because
 * `hydrate()` is async and on a cold start the key arrives AFTER first render;
 * and a tapped check-in queuing a request (0064).
 */
export function useCoachPassRunner(unlocked: boolean): void {
  const maybeRun = useCallback(() => {
    if (!unlocked) return;
    void coachPassStore.maybeRun(getDb(), { unlocked, settle: settleHealth });
  }, [unlocked]);

  useEffect(() => {
    maybeRun();
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') maybeRun();
    });
    // The key landing from the Keychain is itself a trigger — see above.
    const unsubscribe = apiKeyStore.subscribe(maybeRun);
    const unsubscribeRequests = coachPassStore.subscribeRequests(maybeRun);
    return () => {
      appState.remove();
      unsubscribe();
      unsubscribeRequests();
    };
  }, [maybeRun]);
}

/**
 * Read what the last pass said. Safe to call from anywhere; never runs a pass.
 * Returns null on the ordinary day where the Coach judged there was nothing
 * worth saying.
 */
export function useCoachPassMessage(): { message: string | null; dismiss: () => void } {
  const message = useSyncExternalStore(
    coachPassStore.subscribe,
    coachPassStore.getMessage,
    coachPassStore.getMessage
  );
  return { message, dismiss: useCallback(() => coachPassStore.dismiss(), []) };
}

/**
 * The Coach tab's view of the pass store: when the thread was last written to
 * from outside the chat, whether a tapped check-in is being answered, and what
 * became of the last one.
 */
export function useCoachPassThread(): {
  threadVersion: number;
  answering: boolean;
  checkin: CheckinOutcome | null;
  clearCheckin: () => void;
} {
  const threadVersion = useSyncExternalStore(
    coachPassStore.subscribe,
    coachPassStore.getThreadVersion,
    coachPassStore.getThreadVersion
  );
  const answering = useSyncExternalStore(
    coachPassStore.subscribe,
    coachPassStore.isAnswering,
    coachPassStore.isAnswering
  );
  const checkin = useSyncExternalStore(
    coachPassStore.subscribe,
    coachPassStore.getCheckinOutcome,
    coachPassStore.getCheckinOutcome
  );
  return {
    threadVersion,
    answering,
    checkin,
    clearCheckin: useCallback(() => coachPassStore.clearCheckinOutcome(), []),
  };
}
