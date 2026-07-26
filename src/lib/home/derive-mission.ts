import type { MissionItem } from '@/types/home';

/**
 * The pure derivation behind Today's Mission — extracted from the old
 * `useMission` so it can be unit-tested without React or a database, and reused
 * by the DB-backed `useTodayMission` hook.
 *
 * The mission is one chronological list (owner call, 2026-07-24): the order you
 * read it in is the order you act in, so the hero ("do this next") and the list
 * can never imply different next actions.
 *
 * `snoozedIds` is ephemeral UI state (not a persisted status) — snoozing an
 * item just makes it yield the hero slot for this session.
 */
export type MissionView = {
  /** Every item, annotated with `snoozed`, sorted by scheduled time. */
  items: MissionItem[];
  /**
   * The run of already-settled items at the top of the day, before the first
   * thing still to do. The list collapses these so it opens at *now*. Items
   * settled out of order stay in `rest` — hiding them would misstate where you
   * are in the day.
   */
  leadingSettled: MissionItem[];
  /** From the first unsettled item onward — always rendered. */
  rest: MissionItem[];
  /** The single highest-priority thing to do now (the hero). Null when done. */
  next: MissionItem | null;
  completed: number;
  /** Acted on in any way: completed or skipped. Drives "imperfect day" credit. */
  settled: number;
  total: number;
};

/** Minutes past midnight; undefined times sort last rather than first. */
function minutesOf(item: MissionItem): number {
  const parts = item.scheduledTime?.split(':');
  const hours = Number(parts?.[0]);
  const minutes = Number(parts?.[1]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return Number.MAX_SAFE_INTEGER;
  return hours * 60 + minutes;
}

const isSettled = (item: MissionItem) => item.status === 'completed' || item.status === 'skipped';

export function deriveMissionView(
  items: MissionItem[],
  snoozedIds: ReadonlySet<string>
): MissionView {
  // Annotate with the ephemeral snoozed flag for rendering, then sort. Array
  // #sort is stable, so same-time items keep their incoming order.
  const sorted = items
    .map((item) => ({ ...item, snoozed: snoozedIds.has(item.id) }))
    .sort((a, b) => minutesOf(a) - minutesOf(b));

  const firstOpen = sorted.findIndex((item) => !isSettled(item));
  const splitAt = firstOpen === -1 ? sorted.length : firstOpen;
  const pending = sorted.filter((item) => item.status === 'pending');

  return {
    items: sorted,
    leadingSettled: sorted.slice(0, splitAt),
    rest: sorted.slice(splitAt),
    // Snoozed items yield the hero slot, but if everything left is snoozed they
    // come back rather than leaving the screen with nothing to say.
    next: pending.find((item) => !item.snoozed) ?? pending[0] ?? null,
    completed: sorted.filter((item) => item.status === 'completed').length,
    settled: sorted.filter(isSettled).length,
    total: sorted.length,
  };
}
