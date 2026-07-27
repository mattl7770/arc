import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import { localDayUtcRange, todayISODate } from '@/lib/db/date';
import {
  addDaysISO,
  listScreenings,
  pastScheduledAppointments,
  upcomingAppointments,
} from '@/lib/db/repositories/screenings';
import type { ScreeningRow, UpcomingAppointment } from '@/lib/screenings/types';

/**
 * The Screenings screen's view model, backed by the on-device database.
 *
 * Same shape as use-log-feed / use-data-overview: op-sqlite is synchronous, so
 * the first read runs in the `useState` initializer (no loading state), and
 * `useFocusEffect` re-reads whenever the screen regains focus — returning from
 * an add/edit form, or just switching back — which also rolls the due grouping
 * over if midnight passed while the app was backgrounded.
 *
 * Grouping uses the same boundaries as the repository's dueScreenings (today +
 * a 30-day horizon), so what this screen calls "overdue"/"due soon" is exactly
 * what Home's "what's due" card will surface.
 */

/** How far ahead "due soon" looks — mirrors dueScreenings' default horizon. */
const HORIZON_DAYS = 30;

export interface ScreeningGroups {
  /** next_due before today. */
  overdue: ScreeningRow[];
  /** next_due within the 30-day horizon (today inclusive). */
  dueSoon: ScreeningRow[];
  /** next_due beyond the horizon. */
  scheduled: ScreeningRow[];
  /** No next_due at all — nothing to surface until one is set. */
  untracked: ScreeningRow[];
}

export interface ScreeningsState {
  /** Local calendar day the grouping was computed against. */
  today: string;
  groups: ScreeningGroups;
  /** True when no screenings exist at all — drives the first-run invite. */
  emptyLedger: boolean;
  /** Still-scheduled appointments from the start of the local day, soonest first. */
  appointments: UpcomingAppointment[];
  /**
   * Still-'scheduled' bookings whose day already passed — awaiting an outcome
   * (mark completed / cancel). Kept visible so a linked screening can still be
   * stamped done after the visit; most recent first.
   */
  pastAppointments: UpcomingAppointment[];
}

export type Screenings = ScreeningsState & {
  /** Re-read everything — call after an in-screen mutation. */
  reload: () => void;
};

function read(): ScreeningsState {
  const db = getDb();
  const today = todayISODate();
  const horizonEnd = addDaysISO(today, HORIZON_DAYS);

  const all = listScreenings(db);
  const groups: ScreeningGroups = { overdue: [], dueSoon: [], scheduled: [], untracked: [] };
  for (const s of all) {
    if (s.next_due == null) groups.untracked.push(s);
    else if (s.next_due < today) groups.overdue.push(s);
    else if (s.next_due <= horizonEnd) groups.dueSoon.push(s);
    else groups.scheduled.push(s);
  }

  // Split on the start of the local day, not the current instant: a 9 AM
  // appointment stays on today's calendar all day rather than vanishing at
  // 9:01, and anything older lands in "awaiting outcome" instead of vanishing.
  const { startUtc } = localDayUtcRange();
  const appointments = upcomingAppointments(db, startUtc);
  const pastAppointments = pastScheduledAppointments(db, startUtc);

  return { today, groups, emptyLedger: all.length === 0, appointments, pastAppointments };
}

export function useScreenings(): Screenings {
  const [state, setState] = useState(read);

  const reload = useCallback(() => {
    setState(read());
  }, []);

  useFocusEffect(reload);

  return { ...state, reload };
}
