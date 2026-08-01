import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { applyMode, currentMode, subscribeModeChange } from '@/lib/modes/store';
import { getModeDefinition, type ModeDefinition, type ModeKey } from '@/lib/modes/registry';

export type ModeView = {
  mode: ModeKey;
  definition: ModeDefinition;
  /** False for Normal — the indicator only shows when a mode is actually on. */
  isActive: boolean;
  /** Set today's mode (re-derives the mission and notifies every listener). */
  setMode: (mode: ModeKey, opts?: { endDate?: string | null }) => void;
};

/**
 * Home's mode control state. Same shape as use-readiness: a synchronous first
 * read in the useState initializer (op-sqlite is sync), a re-read on focus, and
 * a subscription for in-place changes — the last one matters because the mode
 * is set from a modal presented OVER Home, so Home never loses focus and
 * useFocusEffect alone would leave the indicator stale.
 */
export function useMode(): ModeView {
  const [mode, setModeState] = useState<ModeKey>(() => currentMode());

  const reload = useCallback(() => {
    setModeState(currentMode());
  }, []);

  useFocusEffect(reload);
  useEffect(() => subscribeModeChange(reload), [reload]);

  const set = useCallback(
    (next: ModeKey, opts?: { endDate?: string | null }) => {
      // React error boundaries do NOT catch throws from event handlers, so an
      // unguarded DB failure here would take down the whole app from a tap on
      // Home. Fail quiet: the mode simply doesn't change.
      try {
        applyMode(next, opts ?? {});
      } catch (error) {
        console.warn('[modes] could not set mode', error);
      }
      reload();
    },
    [reload]
  );

  return {
    mode,
    definition: getModeDefinition(mode),
    isActive: mode !== 'normal',
    setMode: set,
  };
}
