import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';

import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { getHealthSyncLog, getHealthSyncState } from '@/lib/db/repositories/wearables';
import { isHealthKitAvailable } from '@/lib/health/healthkit';
import {
  isHealthSyncRunning,
  subscribeHealthSync,
  subscribeHealthSyncRunning,
} from '@/lib/health/sync';
import {
  blankSyncFailedAt,
  subscribeBlankSyncFailure,
  syncFromBlank,
  type MetricSyncContext,
} from '@/lib/home/metric-sync';

import { healthLink } from './use-readiness';

/**
 * The impure half of a blank metric's sync control (src/lib/home/metric-sync.ts
 * decides; this gathers). Same read pattern as useReadiness — synchronous first
 * read, re-read on focus — plus three subscriptions, each for a moment focus
 * cannot see because Home never loses it:
 *
 *   - a pass STARTS or SETTLES, from anywhere (the foreground hook included),
 *     so every blank cell says "Syncing" while one runs and cannot start a
 *     second;
 *   - a pass LANDS — the cursor and the per-metric log move. The strip's
 *     numbers are re-read by useReadiness on the same event;
 *   - a tap's pass FAILS, so the cell can say so.
 */
function read(): MetricSyncContext {
  const db = getDb();
  return {
    link: healthLink(db),
    available: isHealthKitAvailable(),
    running: isHealthSyncRunning(),
    lastSyncedAt: getHealthSyncState(db).lastSyncedAt,
    failedAt: blankSyncFailedAt(),
    log: getHealthSyncLog(db),
    today: todayISODate(),
  };
}

export type MetricSyncControl = {
  context: MetricSyncContext;
  /** Start a pass, or join the one already running. Never throws. */
  sync: () => void;
  /** The door the Connect state leads through. */
  openSettings: () => void;
};

export function useMetricSync(): MetricSyncControl {
  const router = useRouter();
  const [context, setContext] = useState(read);

  const reload = useCallback(() => {
    setContext(read());
  }, []);

  useFocusEffect(reload);
  useEffect(() => subscribeHealthSyncRunning(reload), [reload]);
  useEffect(() => subscribeHealthSync(reload), [reload]);
  useEffect(() => subscribeBlankSyncFailure(reload), [reload]);

  const sync = useCallback(() => {
    // `disabled` / `unavailable` come back as 'skipped' and fire no event, so
    // re-read once the pass settles: the switch or the device moved between
    // render and tap, and the cell should show that rather than a stale offer.
    void syncFromBlank(getDb()).then(reload);
  }, [reload]);

  const openSettings = useCallback(() => {
    router.push('/settings-health');
  }, [router]);

  return { context, sync, openSettings };
}
