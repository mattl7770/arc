import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { listMission, setMissionStatus, toggleMission } from '@/lib/db/repositories/mission';
import { ensureTodaySeeded } from '@/lib/db/seed';
import { deriveMissionView, type MissionView } from '@/lib/home/derive-mission';
import { mockDay } from '@/lib/home/mock-day';
import type { MissionStatus } from '@/types/home';

export type TodayMission = MissionView & {
  setStatus: (id: string, status: MissionStatus) => void;
  toggle: (id: string) => void;
  snooze: (id: string) => void;
};

const EMPTY_SNOOZED: ReadonlySet<string> = new Set();

/** Remove `id` from a snoozed set, returning the same set if it wasn't there. */
function withoutId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!set.has(id)) return set;
  const next = new Set(set);
  next.delete(id);
  return next;
}

/**
 * Today's Mission, backed by the on-device database.
 *
 * Status lives in the DB (persists across launches); snooze is ephemeral
 * session state. The initial load runs in the `useState` initializer — op-sqlite
 * is synchronous, so there's no async/loading state, and open + seed + read are
 * each idempotent, so a StrictMode double-invoke is harmless.
 *
 * The current day is a ref, not state: it's read by the DB helpers and only
 * changes when the app returns to the foreground on a later calendar day. That
 * foreground handler also reloads, so completing a task at 00:05 (or resuming
 * the next morning) writes to and shows the correct day rather than whichever
 * day the app happened to mount on. Status writes are write-through: mutate the
 * DB, then reload. `mock-day` is the first-run seed, not the runtime source.
 */
export function useTodayMission(): TodayMission {
  // A plain const for the initializer (reading a ref during render is
  // disallowed); the ref carries the day forward for the event handlers.
  const initialDay = todayISODate();
  const dayRef = useRef(initialDay);
  const [items, setItems] = useState(() => {
    const db = getDb();
    ensureTodaySeeded(db, initialDay, mockDay.mission);
    return listMission(db, initialDay);
  });
  const [snoozed, setSnoozed] = useState(EMPTY_SNOOZED);

  const reload = useCallback(() => {
    setItems(listMission(getDb(), dayRef.current));
  }, []);

  // On returning to the foreground, refresh from the DB — and if the wall-clock
  // day has rolled over while mounted, seed and switch to the new day.
  const refresh = useCallback(() => {
    const now = todayISODate();
    const dayChanged = now !== dayRef.current;
    dayRef.current = now;
    const db = getDb();
    if (dayChanged) {
      ensureTodaySeeded(db, now, mockDay.mission);
      setSnoozed(EMPTY_SNOOZED);
    }
    setItems(listMission(db, now));
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const setStatus = useCallback(
    (id: string, status: MissionStatus) => {
      setMissionStatus(getDb(), id, status);
      setSnoozed((prev) => withoutId(prev, id));
      reload();
    },
    [reload]
  );

  const toggle = useCallback(
    (id: string) => {
      toggleMission(getDb(), id);
      setSnoozed((prev) => withoutId(prev, id));
      reload();
    },
    [reload]
  );

  const snooze = useCallback((id: string) => {
    setSnoozed((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  const view = useMemo(() => deriveMissionView(items, snoozed), [items, snoozed]);

  return { ...view, setStatus, toggle, snooze };
}
