import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import { subscribeHealthSync } from '@/lib/health/sync';
import { deriveReadiness, type ReadinessView } from '@/lib/home/readiness';

/**
 * Home's readiness view model — real `wearable_data` through the pure
 * derivation (src/lib/home/readiness.ts), replacing mockDay's readiness/
 * pillars/metrics. Same read pattern as use-data-overview: synchronous first
 * read in the useState initializer, re-read on focus. Additionally re-reads
 * when a background Apple Health sync lands rows while Home is already
 * mounted (the boot sync is fire-and-forget, so focus alone would miss it).
 */
export function useReadiness(): ReadinessView {
  const [state, setState] = useState(() => deriveReadiness(getDb()));

  const reload = useCallback(() => {
    setState(deriveReadiness(getDb()));
  }, []);

  useFocusEffect(reload);
  useEffect(() => subscribeHealthSync(reload), [reload]);

  return state;
}
