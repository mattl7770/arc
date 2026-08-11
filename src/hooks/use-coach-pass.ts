import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { coachPassStore } from '@/lib/ai/pass-store';
import { apiKeyStore } from '@/lib/ai/api-key-store';
import { getDb } from '@/lib/db/client';

/**
 * The coach pass, split in two: ONE component runs it, any component may read
 * it. Fusing those into a single hook is what made the first version call the
 * model twice — the root mounted it to run the pass, Home mounted it to render
 * the note, and each mount ran its own.
 *
 * The state itself lives in src/lib/ai/pass-store.ts, which documents why.
 */

/**
 * Drive the pass. Mount at the ROOT and nowhere else.
 *
 * `unlocked` must be false whenever the app-lock gate is owed authentication.
 * The pass reads health data and sends it to the model API; behind a Face ID
 * prompt nobody has proven they are the user yet, so it waits.
 *
 * Two things wake it: mounting (app open), and returning to the foreground —
 * after midnight, or once a Health sync lands a new signal, a pass that wasn't
 * due before becomes due. It also re-checks whenever the API-key store emits,
 * because `hydrate()` is async: on a cold start the key arrives AFTER first
 * render, and without this the daily pass would never fire at all.
 */
export function useCoachPassRunner(unlocked: boolean): void {
  const maybeRun = useCallback(() => {
    if (!unlocked) return;
    void coachPassStore.maybeRun(getDb(), { unlocked });
  }, [unlocked]);

  useEffect(() => {
    maybeRun();
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') maybeRun();
    });
    // The key landing from the Keychain is itself a trigger — see above.
    const unsubscribe = apiKeyStore.subscribe(maybeRun);
    return () => {
      appState.remove();
      unsubscribe();
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
