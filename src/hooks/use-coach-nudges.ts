import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import { getDayStartsAt, todayISODate } from '@/lib/db/date';
import {
  cancelNudge,
  upcomingNudges,
  type UpcomingNudge,
} from '@/lib/db/repositories/coach-nudges';
import { getLastNotificationSync, syncReminderNotifications } from '@/lib/notifications/reminders';

export type CoachNudges = {
  /** What will buzz, soonest first — exactly what the OS resync schedules. */
  nudges: UpcomingNudge[];
  /** The logical day, for "today" / "tomorrow". */
  today: string;
  /** The last sync found notification permission refused. */
  blocked: boolean;
  reload: () => void;
  cancel: (id: string) => void;
};

function read(): { nudges: UpcomingNudge[]; today: string; blocked: boolean } {
  const now = new Date();
  return {
    nudges: upcomingNudges(getDb(), now, getDayStartsAt()),
    today: todayISODate(now),
    blocked: getLastNotificationSync()?.permissionGranted === false,
  };
}

/**
 * The Coach's planned notifications for the Coach tab (0064). Same shape as
 * use-reminders: a synchronous first read, a re-read on focus, and an explicit
 * reload for writes the tab did not make itself (a pass that planned one while
 * the tab was mounted). Cancel writes the row and resyncs the OS at once, so
 * a cancelled nudge is off the phone before the finger lifts.
 */
export function useCoachNudges(): CoachNudges {
  const [state, setState] = useState(read);

  const reload = useCallback(() => setState(read()), []);
  useFocusEffect(reload);

  const cancel = useCallback(
    (id: string) => {
      cancelNudge(getDb(), id);
      reload();
      void syncReminderNotifications(getDb()).then(reload);
    },
    [reload]
  );

  return { ...state, reload, cancel };
}
