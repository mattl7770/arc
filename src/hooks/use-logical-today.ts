import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';

import {
  dayParts,
  forwardCursor,
  nextDayRollover,
  todayISODate,
  type DayParts,
} from '@/lib/db/date';

/**
 * Slack added to the rollover timer, so it fires just PAST the boundary rather
 * than on it: a timer that wakes a few milliseconds early would re-read the day
 * that is ending and then wait a whole day for the next one.
 */
const ROLLOVER_SLACK_MS = 1_000;

/**
 * Today — the LOGICAL day — as printable parts, for a header that names it.
 *
 * The day is `todayISODate()`, the same one the mission, the log and every
 * write use, so under the "Day starts at" boundary the label at 00:30 still
 * names the day the user is living in rather than the calendar's next one.
 *
 * A bare `todayISODate()` in render would be right only as of the last
 * incidental render — a tab left idle across the boundary would keep the old
 * day — so this is state, refreshed when the day can actually change:
 *
 *  - at the next boundary ({@link nextDayRollover}), re-armed each time;
 *  - when the app returns to the foreground — which also covers a background
 *    span that swallowed the timer, and a timezone change, since the boundary
 *    moves with the zone;
 *  - when the screen regains focus — which is how a change to "Day starts at"
 *    in Settings reaches the header on the way back.
 *
 * Forward-only, like the mission's own cursor (src/hooks/use-today-mission.ts):
 * a westbound flight over the date line rolls the clock back, and the header
 * must not run backwards past the day the mission under it is still writing to.
 */
export function useLogicalToday(): DayParts {
  const [date, setDate] = useState(() => todayISODate());

  const refresh = useCallback(() => {
    setDate((prev) => forwardCursor(prev, todayISODate()));
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer !== undefined) clearTimeout(timer);
      const now = new Date();
      timer = setTimeout(
        () => {
          refresh();
          arm();
        },
        Math.max(0, nextDayRollover(now).getTime() - now.getTime()) + ROLLOVER_SLACK_MS
      );
    };
    arm();

    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      refresh();
      // Re-armed, not just re-read: the pending timer was computed in the zone
      // and under the boundary of when it was set.
      arm();
    });

    return () => {
      if (timer !== undefined) clearTimeout(timer);
      sub.remove();
    };
  }, [refresh]);

  useFocusEffect(refresh);

  return useMemo(() => dayParts(date), [date]);
}
