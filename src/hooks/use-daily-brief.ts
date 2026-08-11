import { useCallback, useState } from 'react';

import { useFocusEffect } from 'expo-router';

import { generateDailyBrief } from '@/lib/ai/insights';
import { getDb } from '@/lib/db/client';

/**
 * The deterministic daily brief (`src/lib/ai/insights.ts` → generateDailyBrief)
 * as reactive state — real numbers from the on-device data, no model call, so it
 * is honest even with no API key set. op-sqlite is synchronous, so the first
 * read runs in the `useState` initializer (no loading state); `useFocusEffect`
 * re-reads on return so a log, weigh-in, or reminder added elsewhere updates the
 * Home brief the next time Home is focused. Home is the only surface that draws
 * this brief — the Coach screen's copy of it was removed, so there is no second
 * consumer to keep in agreement.
 */
export function useDailyBrief(): string {
  const [brief, setBrief] = useState(() => generateDailyBrief(getDb()));
  useFocusEffect(
    useCallback(() => {
      setBrief(generateDailyBrief(getDb()));
    }, [])
  );
  return brief;
}
