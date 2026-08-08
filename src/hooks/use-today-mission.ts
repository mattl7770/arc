import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { listMission, setMissionStatus, toggleMission } from '@/lib/db/repositories/mission';
import { listProtocols } from '@/lib/db/repositories/protocols';
import { ensureTodaySeeded } from '@/lib/db/seed';
import { deriveMissionView, type MissionView } from '@/lib/home/derive-mission';
import { subscribeModeChange } from '@/lib/modes/store';
import type { MissionItem, MissionStatus } from '@/types/home';

export type TodayMission = MissionView & {
  /**
   * Whether the user has at least one active protocol with a live version —
   * i.e. whether an empty mission means "you haven't built anything yet" or
   * "what you built put nothing on today". Home needs the distinction to say
   * something true in its empty state.
   */
  hasActiveProtocols: boolean;
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

type DayState = {
  items: MissionItem[];
  hasActiveProtocols: boolean;
};

/**
 * Generate (if needed) and read one day, in a single pass so the mission and
 * the "do you have protocols" answer can never disagree within a render.
 *
 * `ensureTodaySeeded` is deliberately called with no fallback: the day is
 * whatever the user's active protocols and the day's mode produce, and nothing
 * else. It is idempotent, so running it on every read is safe.
 */
function readDay(day: string): DayState {
  const db = getDb();
  ensureTodaySeeded(db, day);
  return {
    items: listMission(db, day),
    hasActiveProtocols: listProtocols(db).some((p) => p.isActive && p.versionNumber !== null),
  };
}

/**
 * Today's Mission, backed by the on-device database.
 *
 * Status lives in the DB (persists across launches); snooze is ephemeral
 * session state. The initial load runs in the `useState` initializer — op-sqlite
 * is synchronous, so there's no async/loading state, and generate + read are
 * each idempotent, so a StrictMode double-invoke is harmless.
 *
 * The current day is a ref, not state: it's read by the DB helpers and only
 * changes when the app returns to the foreground on a later calendar day. That
 * foreground handler also reloads, so completing a task at 00:05 (or resuming
 * the next morning) writes to and shows the correct day rather than whichever
 * day the app happened to mount on. Status writes are write-through: mutate the
 * DB, then reload.
 *
 * **The day is generated from the user's real protocols only.** There is no
 * demo mission and no seed data — see `src/lib/db/seed.ts` for what was removed
 * and why. With no protocols, `total` is 0 and Home shows its first-run state.
 */
export function useTodayMission(): TodayMission {
  // A plain const for the initializer (reading a ref during render is
  // disallowed); the ref carries the day forward for the event handlers.
  const initialDay = todayISODate();
  const dayRef = useRef(initialDay);
  const [day, setDay] = useState<DayState>(() => readDay(initialDay));
  const [snoozed, setSnoozed] = useState(EMPTY_SNOOZED);

  const reload = useCallback(() => {
    setDay(readDay(dayRef.current));
  }, []);

  // On regaining focus or returning to the foreground, re-read — and if the
  // wall-clock day rolled over while mounted, switch to the new day.
  const refresh = useCallback(() => {
    const now = todayISODate();
    if (now !== dayRef.current) {
      dayRef.current = now;
      setSnoozed(EMPTY_SNOOZED);
    }
    setDay(readDay(now));
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  // Focus, not just foreground: creating the first protocol happens on a pushed
  // screen, and the day must fill in the moment the user lands back on Home.
  // `ensureTodaySeeded` no-ops once the day has planned entries, so this stays
  // cheap and never re-shapes a day already committed.
  useFocusEffect(refresh);

  // Setting a mode re-derives today's rows (mission-generate.rederiveMissionForDay),
  // so the list must re-read. Focus alone can't cover it: the mode is set from a
  // modal presented OVER Home, so Home never loses (or regains) focus.
  useEffect(() => subscribeModeChange(reload), [reload]);

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

  const view = useMemo(() => deriveMissionView(day.items, snoozed), [day.items, snoozed]);

  return {
    ...view,
    hasActiveProtocols: day.hasActiveProtocols,
    setStatus,
    toggle,
    snooze,
  };
}
