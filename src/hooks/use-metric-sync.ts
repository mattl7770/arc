import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';

import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import {
  getHealthSyncLog,
  getHealthSyncState,
  recentSourceDevices,
} from '@/lib/db/repositories/wearables';
import { isHealthKitAvailable } from '@/lib/health/healthkit';
import {
  isHealthSyncRunning,
  subscribeHealthSync,
  subscribeHealthSyncRunning,
  SYNC_WINDOW_DAYS,
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
 *   - a pass LANDS — the cursor, the per-metric log and the sources move. The
 *     strip's numbers are re-read by useReadiness on the same event;
 *   - a tap's pass FAILS, so the cell can say so.
 */
function read(): MetricSyncContext {
  const db = getDb();
  const today = todayISODate();
  return {
    link: healthLink(db),
    available: isHealthKitAvailable(),
    running: isHealthSyncRunning(),
    lastSyncedAt: getHealthSyncState(db).lastSyncedAt,
    failedAt: blankSyncFailedAt(),
    log: getHealthSyncLog(db),
    sources: recentSourceDevices(db, today, SYNC_WINDOW_DAYS),
    today,
  };
}

export type MetricSyncControl = {
  context: MetricSyncContext;
  /** Ask for a pass that reads from now. Never throws. */
  sync: () => void;
  /** The door the Connect state leads through. */
  openSettings: () => void;
};

export function useMetricSync(): MetricSyncControl {
  const router = useRouter();
  const [context, setContext] = useState(read);

  // Guarded: this runs inside the sync module's listeners, and a read that
  // throws there would surface as a failed pass after the data had landed. The
  // last good read stands until the next event.
  const reload = useCallback(() => {
    try {
      setContext(read());
    } catch {
      // Kept as it was.
    }
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
