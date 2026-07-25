import { useCallback, useMemo, useState } from 'react';

import type { MissionItem, MissionStatus } from '@/types/home';

export type MissionState = {
  /** Every item, sorted by scheduled time. Untimed items sort to the end. */
  items: MissionItem[];
  /**
   * The run of already-settled items at the top of the day, before the first
   * thing still to do. The list collapses these so it opens at *now*.
   * Items settled out of order stay in place — hiding them would be a lie
   * about where you are in the day.
   */
  leadingSettled: MissionItem[];
  /** From the first unsettled item onward — always rendered. */
  rest: MissionItem[];
  /**
   * The single highest-priority thing to do right now — what the hero card
   * shows. Derived rather than stored, so completing it advances the screen
   * on its own. Null when nothing is left.
   */
  next: MissionItem | null;
  completed: number;
  /** Acted on in any way: completed or skipped. Drives "imperfect day" credit. */
  settled: number;
  total: number;
  toggle: (id: string) => void;
  setStatus: (id: string, status: MissionStatus) => void;
  snooze: (id: string) => void;
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

/**
 * Local state for Today's Mission.
 *
 * The mission is one chronological list (owner call, 2026-07-24) — the order
 * you read it in is the order you act in, so the hero and the list can never
 * imply different next actions.
 *
 * Deliberately in-memory: this screen is still on mock data, and persisting to
 * `log_entries` is the next step, not this one.
 */
export function useMission(initial: MissionItem[]): MissionState {
  const [items, setItems] = useState(initial);

  const mapItem = useCallback((id: string, fn: (item: MissionItem) => MissionItem) => {
    setItems((prev) => prev.map((item) => (item.id === id ? fn(item) : item)));
  }, []);

  const setStatus = useCallback(
    (id: string, status: MissionStatus) => {
      mapItem(id, (item) => ({ ...item, status, snoozed: false }));
    },
    [mapItem]
  );

  const toggle = useCallback(
    (id: string) => {
      mapItem(id, (item) => ({
        ...item,
        status: item.status === 'completed' ? 'pending' : 'completed',
        snoozed: false,
      }));
    },
    [mapItem]
  );

  const snooze = useCallback(
    (id: string) => {
      mapItem(id, (item) => ({ ...item, snoozed: true }));
    },
    [mapItem]
  );

  return useMemo(() => {
    // Array#sort is stable, so same-time items keep their authored order.
    const sorted = [...items].sort((a, b) => minutesOf(a) - minutesOf(b));

    const firstOpen = sorted.findIndex((item) => !isSettled(item));
    const splitAt = firstOpen === -1 ? sorted.length : firstOpen;
    const pending = sorted.filter((item) => item.status === 'pending');

    return {
      items: sorted,
      leadingSettled: sorted.slice(0, splitAt),
      rest: sorted.slice(splitAt),
      // Snoozed items yield the hero slot, but if everything left is snoozed
      // they come back rather than leaving the screen with nothing to say.
      next: pending.find((item) => !item.snoozed) ?? pending[0] ?? null,
      completed: sorted.filter((item) => item.status === 'completed').length,
      settled: sorted.filter(isSettled).length,
      total: sorted.length,
      toggle,
      setStatus,
      snooze,
    };
  }, [items, toggle, setStatus, snooze]);
}
