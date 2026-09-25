/**
 * Types for reminders (0009_reminders.sql). Row type mirrors the table;
 * NewReminder is what callers (the reminder sheet later, the Coach's
 * set_reminder tool today) pass to createReminder — ids/timestamps come from
 * the repository / DB defaults. Lives beside the feature by the parallel-work
 * convention (see src/lib/exercise/types.ts).
 */

export type ReminderRepeat = 'once' | 'daily' | 'weekly';
export type ReminderStatus = 'active' | 'done' | 'dismissed';

/** One `reminders` row, as a SELECT returns it. */
export type ReminderRow = {
  id: string;
  title: string;
  time: string | null;
  date: string | null;
  repeat: ReminderRepeat;
  status: ReminderStatus;
  created_by: 'user' | 'ai';
  notes: string | null;
  /**
   * 1 for a CHECK-IN (0064) — "check in with me tonight about the knee". A tap
   * on its notification makes the Coach speak first; a plain reminder's tap
   * opens it with "Talk about this" instead. 0 for every other reminder.
   */
  checkin: number;
  created_at: string;
  updated_at: string;
};

export type NewReminder = {
  title: string;
  /** Wall-clock HH:MM to nudge at, or null for "sometime that day". */
  time?: string | null;
  /** One-off: the local day it applies to. Weekly: the anchor date. */
  date?: string | null;
  repeat?: ReminderRepeat;
  /** Who asked for it — 'ai' when the Coach self-initiates. */
  createdBy?: 'user' | 'ai';
  notes?: string | null;
  /** A check-in (0064): the Coach speaks first when its notification is tapped. */
  checkin?: boolean;
};
