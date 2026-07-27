import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import {
  completeReminder,
  dismissReminder,
  listActiveReminders,
} from '@/lib/db/repositories/reminders';
import type { ReminderRow } from '@/lib/reminders/types';

export type Reminders = {
  reminders: ReminderRow[];
  /** Re-read — call after anything (a Coach tool) may have written one. */
  reload: () => void;
  complete: (id: string) => void;
  dismiss: (id: string) => void;
};

/**
 * Active reminders, backed by the on-device database (0009) — the in-app
 * surfacing seam for reminders the user or the Coach created. Same shape as
 * use-log-feed: synchronous first read in the initializer, re-read on focus,
 * and an explicit reload for same-screen writes (the Coach's set_reminder).
 */
export function useReminders(): Reminders {
  const [reminders, setReminders] = useState<ReminderRow[]>(() => listActiveReminders(getDb()));

  const reload = useCallback(() => {
    setReminders(listActiveReminders(getDb()));
  }, []);

  useFocusEffect(reload);

  const complete = useCallback(
    (id: string) => {
      completeReminder(getDb(), id);
      reload();
    },
    [reload]
  );

  const dismiss = useCallback(
    (id: string) => {
      dismissReminder(getDb(), id);
      reload();
    },
    [reload]
  );

  return { reminders, reload, complete, dismiss };
}
