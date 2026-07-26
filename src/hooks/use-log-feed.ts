import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import { listTodayEntries } from '@/lib/db/repositories/logs';
import type { LogFeedItem } from '@/types/log';

export type LogFeed = {
  entries: LogFeedItem[];
  /** Re-read today's entries — call after an in-screen capture. */
  reload: () => void;
};

/**
 * The Log tab's "Logged today" feed, backed by the on-device database.
 *
 * op-sqlite is synchronous, so the first read runs in the `useState`
 * initializer (no loading state). `useFocusEffect` re-reads whenever the tab
 * regains focus — returning from the metric keypad or a capture sheet, or just
 * switching back — which also rolls the feed over to a new day if midnight
 * passed while the app was backgrounded.
 */
export function useLogFeed(): LogFeed {
  const [entries, setEntries] = useState<LogFeedItem[]>(() => listTodayEntries(getDb()));

  const reload = useCallback(() => {
    setEntries(listTodayEntries(getDb()));
  }, []);

  useFocusEffect(reload);

  return { entries, reload };
}
