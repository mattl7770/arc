import { useCallback, useMemo, useState } from 'react';

import type { MissionItem, MissionSection, MissionStatus } from '@/types/home';

export type MissionState = {
  sections: MissionSection[];
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

/** Applies `fn` to the item with `id`, leaving every other item untouched. */
function mapItem(
  sections: MissionSection[],
  id: string,
  fn: (item: MissionItem) => MissionItem
): MissionSection[] {
  return sections.map((section) => ({
    ...section,
    items: section.items.map((item) => (item.id === id ? fn(item) : item)),
  }));
}

/**
 * Local state for Today's Mission.
 *
 * Deliberately in-memory: this screen is still on mock data, and persisting to
 * `log_entries` is the next step, not this one.
 */
export function useMission(initial: MissionSection[]): MissionState {
  const [sections, setSections] = useState(initial);

  const setStatus = useCallback((id: string, status: MissionStatus) => {
    setSections((prev) => mapItem(prev, id, (item) => ({ ...item, status, snoozed: false })));
  }, []);

  const toggle = useCallback((id: string) => {
    setSections((prev) =>
      mapItem(prev, id, (item) => ({
        ...item,
        status: item.status === 'completed' ? 'pending' : 'completed',
        snoozed: false,
      }))
    );
  }, []);

  const snooze = useCallback((id: string) => {
    setSections((prev) => mapItem(prev, id, (item) => ({ ...item, snoozed: true })));
  }, []);

  return useMemo(() => {
    const items = sections.flatMap((section) => section.items);
    const pending = items.filter((item) => item.status === 'pending');

    return {
      sections,
      // Snoozed items yield the hero slot, but if everything left is snoozed
      // they come back rather than leaving the screen with nothing to say.
      next: pending.find((item) => !item.snoozed) ?? pending[0] ?? null,
      completed: items.filter((item) => item.status === 'completed').length,
      settled: items.filter((item) => item.status !== 'pending').length,
      total: items.length,
      toggle,
      setStatus,
      snooze,
    };
  }, [sections, toggle, setStatus, snooze]);
}
