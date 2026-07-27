import { useCallback, useState } from 'react';

import { getDb } from '@/lib/db/client';
import { getPreferences, setUnitPreference } from '@/lib/db/repositories/user';
import type { UnitPreferences } from '@/lib/user/types';

/**
 * Read/write the display-only unit preferences (weight, distance, volume,
 * length, temperature). Storage stays canonical SI — these toggles only change
 * how numbers render (src/lib/user/types.ts), never what's stored.
 *
 * op-sqlite is synchronous, so the first read runs in the `useState` initializer
 * (no loading state, matching src/hooks/use-data-overview.ts). `setUnit` persists
 * the single choice and updates local state so the caller re-renders immediately.
 * Consumed by Settings › Units (the segmented controls) and the keypad drill-in
 * (which reads `units` to resolve its DisplaySpec).
 */
export function useUnitPreferences(): {
  units: UnitPreferences;
  setUnit: <K extends keyof UnitPreferences>(key: K, value: UnitPreferences[K]) => void;
} {
  const [units, setUnits] = useState<UnitPreferences>(() => getPreferences(getDb()).units);

  const setUnit = useCallback(
    <K extends keyof UnitPreferences>(key: K, value: UnitPreferences[K]) => {
      const next = setUnitPreference(getDb(), key, value);
      setUnits(next.units);
    },
    []
  );

  return { units, setUnit };
}
