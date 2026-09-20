import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import { forwardCursor, todayISODate } from '@/lib/db/date';
import { listMission, setMissionStatus, toggleMission } from '@/lib/db/repositories/mission';
import { listProtocols } from '@/lib/db/repositories/protocols';
import { rederiveDaysAhead } from '@/lib/db/repositories/mission-generate';
import { arriveDay } from '@/lib/db/seed';
import { deriveMissionView, type MissionView } from '@/lib/home/derive-mission';
import {
  clearSnoozed,
  snoozeItem,
  snoozedItems,
  subscribeSnoozeChange,
  unsnoozeItem,
} from '@/lib/home/snooze-store';
import { syncReminderNotifications } from '@/lib/notifications/reminders';
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

type DayState = {
  items: MissionItem[];
  hasActiveProtocols: boolean;
};

/**
 * Generate (if needed) and read one day, in a single pass so the mission and
 * the "do you have protocols" answer can never disagree within a render.
 *
 * `arriveDay` is deliberately called with no fallback: the day is whatever the
 * user's active protocols and the day's mode produce, and nothing else. It is
 * idempotent, so running it on every read is safe. It wraps the seeding this
 * used to call directly and adds the one thing a day COMMITTED AHEAD needs on
 * the morning it becomes today — the re-derive that strips its `ahead` marks
 * and gives it the carry source a future day never had (src/lib/db/seed.ts).
 */
function readDay(day: string): DayState {
  const db = getDb();
  arriveDay(db, day);
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
  // Mirrored from the module store, not owned here — a pushed route has to be
  // able to un-snooze a row, and it cannot reach this component's state
  // (src/lib/home/snooze-store.ts). The store hands out a new set identity on
  // every real change, so this is a plain re-read.
  const [snoozed, setSnoozed] = useState<ReadonlySet<string>>(snoozedItems);

  const reload = useCallback(() => {
    setDay(readDay(dayRef.current));
  }, []);

  // On regaining focus or returning to the foreground, re-read — and if the
  // wall-clock day rolled over while mounted, switch to the new day.
  //
  // FORWARD ONLY. This used to compare `todayISODate()` to the cached day and
  // switch either way, which a westbound flight across the date line turns into
  // a day that runs BACKWARDS: the clock rolls back, today's answer is
  // yesterday, and the hook silently moves the mission — and the next completion
  // — onto a day the user already finished. `forwardCursor` is the guard
  // pass-schedule.ts and snapshot.ts each wrote by hand; this site never had it.
  // A day may still be SKIPPED (eastbound over the line really does miss one);
  // it just cannot rewind. Reading a past day stays free — that is what the
  // history screens are for — it is the implicit write target that must not move.
  const refresh = useCallback(() => {
    const day = forwardCursor(dayRef.current, todayISODate());
    const rolled = day !== dayRef.current;
    if (rolled) {
      dayRef.current = day;
      clearSnoozed();
    }
    setDay(readDay(day));
    // A new day has a new plan, so its items' reminders (C10) have new moments
    // to fire at. Only on the ROLLOVER: this runs on every focus of Home, and
    // the sync cancels the whole OS schedule before rebuilding it — doing that
    // thirty times a day would be churn for no new information. Boot covers the
    // first day (app/_layout.tsx); a status write covers the rest.
    if (rolled) void syncReminderNotifications(getDb());
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

  // The snoozed set is a module store, so *Unsnooze* on the pushed item sheet —
  // a screen Home never loses focus to and cannot see — reaches this list.
  useEffect(() => subscribeSnoozeChange(() => setSnoozed(snoozedItems())), []);

  // Ticking an item is what silences its reminder (C10): the scheduler lists
  // only PENDING rows, so re-running the sync after a status write drops the
  // notification for anything just settled — and puts it back if the user
  // un-ticks. Fire-and-forget, and a no-op in any build without the native
  // module.
  //
  // Both writes pass `dayRef.current`, not `todayISODate()`: that ref is the
  // forward-clamped day this hook is writing INTO (see `refresh` above), and
  // after a westbound flight the clock lags it. The day stamped on the
  // completion (`value.done_on`) has to be the same day the row is being
  // written under, or a mission ticked in the brief "yesterday" would look like
  // a backfill made a day early.
  //
  // `rederiveDaysAhead` runs after both, because a completion changes LATER
  // days: under `adjusting` it moves an every-N-days item's next occurrence,
  // and under a quota it spends one of the week's sessions. A database with
  // nothing committed ahead pays one `LIMIT 1` per tick and stops.
  const setStatus = useCallback(
    (id: string, status: MissionStatus) => {
      const db = getDb();
      setMissionStatus(db, id, status, dayRef.current);
      rederiveDaysAhead(db, dayRef.current);
      unsnoozeItem(id);
      reload();
      void syncReminderNotifications(db);
    },
    [reload]
  );

  const toggle = useCallback(
    (id: string) => {
      const db = getDb();
      toggleMission(db, id, dayRef.current);
      rederiveDaysAhead(db, dayRef.current);
      unsnoozeItem(id);
      reload();
      void syncReminderNotifications(db);
    },
    [reload]
  );

  const snooze = useCallback((id: string) => {
    snoozeItem(id);
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
