import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import { isHealthSyncEnabled } from '@/lib/db/repositories/user';
import { isHealthKitSupported } from '@/lib/health/healthkit';
import { subscribeHealthSync } from '@/lib/health/sync';
import { deriveReadiness, type HealthLink, type ReadinessView } from '@/lib/home/readiness';

/**
 * Home's readiness view model — real `wearable_data` through the pure
 * derivation (src/lib/home/readiness.ts), replacing mockDay's readiness/
 * pillars/metrics. Same read pattern as use-data-overview: synchronous first
 * read in the useState initializer, re-read on focus. Additionally re-reads
 * when a background Apple Health sync lands rows while Home is already
 * mounted (the boot sync is fire-and-forget, so focus alone would miss it).
 *
 * This hook is where the LINK STATE is established — the impure half the pure
 * derivation refuses to look at itself. It is the difference between a pillar
 * that says "no signal yet" and one that says "nothing can arrive in this
 * build". It was always the latter until the owner's EAS rebuild (2026-08-25)
 * put the HealthKit module in the binary; `isHealthKitSupported()` is the only
 * authority on which it is, and is left to answer for itself on every read.
 */
function healthLink(db: ReturnType<typeof getDb>): HealthLink {
  if (!isHealthKitSupported()) return 'unsupported';
  return isHealthSyncEnabled(db) ? 'connected' : 'disconnected';
}

export function useReadiness(): ReadinessView {
  const [state, setState] = useState(() => {
    const db = getDb();
    return deriveReadiness(db, undefined, { link: healthLink(db) });
  });

  const reload = useCallback(() => {
    const db = getDb();
    setState(deriveReadiness(db, undefined, { link: healthLink(db) }));
  }, []);

  useFocusEffect(reload);
  useEffect(() => subscribeHealthSync(reload), [reload]);
  // No status-change subscription since 2026-09-23. It existed for the two
  // status fields Home's mono line printed; that line is now the status sheet's
  // header, which derives its own on the tap that opens it. Nothing Home still
  // draws from this view moves when a status starts or ends today — the day
  // joins the exclusion set, but a baseline only reads the days before the one
  // it grades.

  return state;
}
