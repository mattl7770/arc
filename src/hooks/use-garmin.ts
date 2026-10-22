import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { getDb } from '@/lib/db/client';
import { garminKeyStore } from '@/lib/garmin/key-store';
import {
  garminLink,
  isGarminSyncRunning,
  readGarminState,
  subscribeGarminSync,
  syncGarminIfDue,
  type GarminLink,
  type GarminSyncState,
} from '@/lib/garmin/sync';

/**
 * Drive the Garmin sync. Mount at the ROOT and nowhere else (app/_layout.tsx),
 * gated on the app lock exactly like the Coach pass: a pass sends the key to
 * Garmin and writes health rows, and behind a Face ID prompt nobody has proven
 * they are the owner yet.
 *
 * Three things wake it: mounting (app open), a return to the foreground, and
 * the key store emitting — `hydrate()` is async, so on a cold start the key
 * lands AFTER first render, and a freshly pasted key should sync at once.
 * `syncGarminIfDue` does the throttling and is silent.
 */
export function useGarminSyncRunner(unlocked: boolean): void {
  const maybeRun = useCallback(() => {
    if (!unlocked) return;
    void syncGarminIfDue(getDb());
  }, [unlocked]);

  useEffect(() => {
    maybeRun();
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') maybeRun();
    });
    const unsubscribe = garminKeyStore.subscribe(maybeRun);
    return () => {
      appState.remove();
      unsubscribe();
    };
  }, [maybeRun]);
}

export type GarminView = {
  hasKey: boolean;
  link: GarminLink;
  running: boolean;
  state: GarminSyncState;
  /** Whether the key is in the Keychain (false: memory-only, this session). */
  persistent: boolean;
};

function read(): GarminView {
  const db = getDb();
  const hasKey = garminKeyStore.has();
  return {
    hasKey,
    link: garminLink(db, hasKey),
    running: isGarminSyncRunning(),
    state: readGarminState(db),
    persistent: garminKeyStore.isPersistent(),
  };
}

/** The link as screens see it: re-read on focus, on every pass event, and on a key change. */
export function useGarminView(): GarminView & { reload: () => void } {
  const [view, setView] = useState(read);
  const reload = useCallback(() => {
    try {
      setView(read());
    } catch {
      // The last good read stands until the next event.
    }
  }, []);
  useFocusEffect(reload);
  useEffect(() => subscribeGarminSync(reload), [reload]);
  useEffect(() => garminKeyStore.subscribe(reload), [reload]);
  return { ...view, reload };
}
