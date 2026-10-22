import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useFocusEffect } from 'expo-router';

import { coachPassStore } from '@/lib/ai/pass-store';
import {
  approveProposal,
  declineProposal,
  draftsForDay,
  getBrief,
  getProposalsVersion,
  listProposals,
  subscribeProposals,
  type ProposalResolution,
  type StoredProposal,
} from '@/lib/ai/proposals';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { syncReminderNotifications } from '@/lib/notifications/reminders';

export type CoachProposals = {
  /** Every kept draft (a week of them), statuses as of the last read. */
  all: StoredProposal[];
  /** Today's: the pending ones first. What Home's Coach card draws. */
  today: StoredProposal[];
  /** Today's model-voiced brief, or null (Home falls back to the deterministic one). */
  brief: string[] | null;
  /** The draft whose tap is being answered right now, or null. */
  busyId: string | null;
  approve: (id: string) => void;
  decline: (id: string) => void;
};

/**
 * Coach proposals for Home and the Coach thread (src/lib/ai/proposals.ts). Both
 * read the same store, so a tap in one place is reflected in the other: every
 * write bumps the store's version, and the pass bumps it when it drafts.
 *
 * A draft expires by the clock as well as by the store, so the read is redone
 * on focus — a card left open past its `until` reads Expired on return, and a
 * tap on a card that expired while it was on screen is refused by
 * `approveProposal` itself rather than by this hook.
 *
 * `onResolved` runs after an approval that wrote something — Home re-reads its
 * mission, since a draft may have restructured today.
 */
export function useCoachProposals(onResolved?: () => void): CoachProposals {
  const version = useSyncExternalStore(
    subscribeProposals,
    getProposalsVersion,
    getProposalsVersion
  );
  const [tick, setTick] = useState(0);
  useFocusEffect(useCallback(() => setTick((n) => n + 1), []));
  const [busyId, setBusyId] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);

  const { all, brief } = useMemo(() => {
    void version;
    void tick;
    const now = new Date();
    return { all: listProposals(getDb(), now), brief: getBrief(getDb(), now) };
  }, [version, tick]);
  const today = useMemo(() => draftsForDay(all, todayISODate()), [all]);

  const settle = useCallback(
    (result: ProposalResolution) => {
      // The thread gained a row (a receipt, a decline or a refusal).
      coachPassStore.noteThreadWrite();
      if (result.status === 'approved') {
        // A draft may have set or ended a reminder; the OS schedule follows.
        void syncReminderNotifications(getDb());
        onResolved?.();
      }
    },
    [onResolved]
  );

  const approve = useCallback(
    (id: string) => {
      if (busyRef.current) return;
      busyRef.current = id;
      setBusyId(id);
      void approveProposal(getDb(), id)
        .then(settle)
        .catch(() => {})
        .finally(() => {
          busyRef.current = null;
          setBusyId(null);
        });
    },
    [settle]
  );

  const decline = useCallback(
    (id: string) => {
      if (busyRef.current) return;
      try {
        settle(declineProposal(getDb(), id));
      } catch {
        // A failed write leaves the draft pending; the card stays to be answered.
      }
    },
    [settle]
  );

  return { all, today, brief, busyId, approve, decline };
}
