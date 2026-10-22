import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';

import { coachPassStore } from '@/lib/ai/pass-store';
import { getDb } from '@/lib/db/client';
import { readDayPlan, recordPlanEvent, settleDayPlan } from '@/lib/db/repositories/day-plan';
import { readOpenLiveSession } from '@/lib/exercise/session-bar';
import { subscribeGarminSync } from '@/lib/garmin/sync';
import { subscribeHealthSync } from '@/lib/health/sync';
import {
  ACTION_SPEC,
  coachRows,
  destinationHref,
  homeTop,
  msUntilNextExpiry,
  shownKeys,
  toCoachItemView,
  type CoachItemView,
  type HomeTop,
} from '@/lib/home/day-plan';
import type { MissionView } from '@/lib/home/derive-mission';

export type DayPlanView = {
  /** What the hero shows: a Coach item, a pinned row, the time-ordered row, or nothing. */
  top: HomeTop;
  /** The hero's Coach item, ready to draw — null unless `top` is one. */
  heroItem: CoachItemView | null;
  /** The Coach's reason for a PINNED hero row — null otherwise. */
  pinReason: string | null;
  /** The row the checklist marks "you are here", or null when the hero is a Coach item. */
  activeRowId: string | null;
  /** Coach items for the checklist, in the Coach's order. */
  rows: CoachItemView[];
  open: (key: string) => void;
  dismiss: (key: string) => void;
};

/**
 * The Coach's plan for the top of Home (smart day, 0067), read beside the
 * mission. Without a live plan — no key, offline, no pass yet today, every item
 * cleared or expired — `top` is `{ kind: 'mission', row: view.next }` and
 * nothing else is drawn: Home is exactly what it was before this existed.
 *
 * READS in render (op-sqlite is synchronous, the mission hook's pattern) and
 * WRITES in an effect: the `shown` event for what is on screen, and the
 * transitions the read found (an `until` passed → `expired`; yesterday's plan
 * settled against yesterday → `done` / `expired`). A weight that arrived today
 * reads `done` but is recorded only when the plan closes (EvaluatedItem). Both
 * writes are idempotent, so a re-render records nothing twice.
 *
 * Re-read on focus and foreground (data arrives on pushed screens), when an
 * Apple Health or Garmin sync lands (a scale's weight, water — the way
 * use-readiness listens), whenever the mission moves, whenever the pass store
 * emits — the pass that just wrote a plan — and when the earliest live item's
 * `until` passes while Home stays open.
 *
 * The mission itself needs no sync listener: neither sync writes a mission row.
 */
export function useDayPlan(view: MissionView): DayPlanView {
  const router = useRouter();
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((n) => n + 1), []);

  useFocusEffect(bump);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') bump();
    });
    const unsubscribe = coachPassStore.subscribe(bump);
    const unsubscribeHealth = subscribeHealthSync(bump);
    const unsubscribeGarmin = subscribeGarminSync(bump);
    return () => {
      subscription.remove();
      unsubscribe();
      unsubscribeHealth();
      unsubscribeGarmin();
    };
  }, [bump]);

  const read = useMemo(() => {
    try {
      const db = getDb();
      return { ...readDayPlan(db, new Date()), liveOpen: readOpenLiveSession(db) !== null };
    } catch {
      return { plan: null, items: [], liveOpen: false };
    }
    // `version` and `view.items` are the re-read triggers, not inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, view.items]);

  // One timer, to the earliest live item's UNTIL: past it the re-read finds the
  // item expired (and the effect below records it) while Home stays open.
  useEffect(() => {
    const delay = msUntilNextExpiry(read.items, new Date());
    if (delay === null) return;
    const timer = setTimeout(bump, delay);
    return () => clearTimeout(timer);
  }, [read.items, bump]);

  // Cheap and pure, so computed every render; the effect below keys on WHICH
  // items are on screen, not on the objects.
  const top = homeTop(view, read.items);
  const rows = useMemo(
    () => coachRows(read.items).map((item) => toCoachItemView(item, read.liveOpen)),
    [read.items, read.liveOpen]
  );
  const heroItem = top?.kind === 'coach' ? toCoachItemView(top.item, read.liveOpen) : null;
  // The checklist (and so its Coach rows and pinned rows) is drawn only on a day
  // with rows; a live pin's row is open, so it is always in `rest`.
  const onScreen = [
    ...shownKeys(read.items, top, view.total > 0 ? new Set(view.rest.map((row) => row.id)) : null),
  ].join('\n');

  // What is on screen is `shown`; what the read found is settled.
  useEffect(() => {
    const plan = read.plan;
    if (!plan) return;
    try {
      const db = getDb();
      const now = new Date();
      settleDayPlan(db, now);
      const keys = new Set(onScreen.split('\n'));
      for (const item of plan.items) {
        if (keys.has(item.key)) recordPlanEvent(db, plan, item, 'shown', now);
      }
    } catch {
      // History is best effort; Home is what matters.
    }
  }, [read, onScreen]);

  const open = useCallback(
    (key: string) => {
      const plan = read.plan;
      const item = plan?.items.find((candidate) => candidate.key === key);
      if (!plan || !item || item.kind !== 'do') return;
      const db = getDb();
      let live = false;
      try {
        const now = new Date();
        recordPlanEvent(db, plan, item, 'started', now);
        if (item.action && ACTION_SPEC[item.action].clearsOnTap) {
          recordPlanEvent(db, plan, item, 'done', now);
        }
        live = readOpenLiveSession(db) !== null;
      } catch {
        // The door still opens.
      }
      router.push(destinationHref(item, live) as Href);
      bump();
    },
    [read.plan, router, bump]
  );

  const dismiss = useCallback(
    (key: string) => {
      const plan = read.plan;
      const item = plan?.items.find((candidate) => candidate.key === key);
      if (!plan || !item) return;
      try {
        recordPlanEvent(getDb(), plan, item, 'dismissed', new Date());
      } catch {
        // Nothing recorded; the next read shows it again, which is honest.
      }
      bump();
    },
    [read.plan, bump]
  );

  return {
    top,
    heroItem,
    pinReason: top?.kind === 'pin' ? top.item.reason : null,
    activeRowId: top?.kind === 'pin' || top?.kind === 'mission' ? top.row.id : null,
    rows,
    open,
    dismiss,
  };
}
