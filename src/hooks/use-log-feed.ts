import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import { listTodayEntries } from '@/lib/db/repositories/logs';
import { getPreferences } from '@/lib/db/repositories/user';
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
function readFeed(): LogFeedItem[] {
  const db = getDb();
  // Render the feed in the user's chosen units (display-only; storage is canonical).
  return listTodayEntries(db, new Date(), getPreferences(db).units);
}

export function useLogFeed(): LogFeed {
  const [entries, setEntries] = useState<LogFeedItem[]>(readFeed);

  const reload = useCallback(() => {
    setEntries(readFeed());
  }, []);

  useFocusEffect(reload);

  return { entries, reload };
}
