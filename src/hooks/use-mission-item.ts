/**
 * One mission row, and everything the pushed item sheet asks about it.
 *
 * The row itself has carried all of this since the generator was written — the
 * day it stands on, the protocol that named it, the item's own id — and the
 * view-model simply threw it away, which is why a row on Home was a dead end
 * (docs/spikes/protocol-interface-rethink.md §1.2). This hook is the read that
 * turns those four fields into the sheet's content.
 *
 * Everything is read ONCE per focus: one projection over the next six days, one
 * quota count, one protocol read. Never per row and never inside a loop — the
 * projection is six `planForDay` calls and a screen that ran it per item would
 * multiply that by the stack.
 */
import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { getMissionItem } from '@/lib/db/repositories/mission';
import {
  nextOccurrence,
  projectDays,
  quotaDoneThisWeek,
  quotaKey,
} from '@/lib/db/repositories/mission-generate';
import { getCurrentVersion, getProtocol } from '@/lib/db/repositories/protocols';
import type { ProtocolRow } from '@/lib/db/types';
import { isSnoozed, subscribeSnoozeChange } from '@/lib/home/snooze-store';
import { addDays } from '@/lib/protocols/cadence';
import { parseProtocolContent } from '@/lib/protocols/content';
import { phaseOn, type PhaseState } from '@/lib/protocols/phase';
import type { ProtocolItem } from '@/lib/protocols/types';
import type { MissionItem } from '@/types/home';

/** A quota's honest reading: an allowance and how much of it is spent. */
export type QuotaAllowance = { perWeek: number; done: number };

export type MissionItemView = {
  item: MissionItem;
  /** Deferred from the hero this session. Not persisted, and never was. */
  snoozed: boolean;
  /**
   * The protocol behind the row, when there still is one. Null for a mode item,
   * an experiment's intervention, and for a row whose protocol was deleted —
   * `log_entries.protocol_id` is ON DELETE SET NULL, so the row survives with
   * nothing left to open.
   */
  protocol: ProtocolRow | null;
  /** Where that protocol is up to today, for the sheet's head line. */
  phase: PhaseState | null;
  /**
   * The item as the LIVE version defines it. Null when the row's protocol is
   * gone, or when the item has since been edited out of the live version — a
   * real state, and the sheet says so rather than drawing a cadence it would
   * have to invent.
   */
  definition: ProtocolItem | null;
  /**
   * The next day this item lands, after tomorrow. Null for a quota, for a
   * paused or ended protocol, and for an occurrence past the six-day horizon.
   * Also null when it lands TOMORROW: a day the reader can name without help
   * does not need naming.
   */
  nextOn: string | null;
  /** Set for a quota item instead of {@link nextOn} — the two are exclusive. */
  allowance: QuotaAllowance | null;
  /** Re-read after a write made on this screen. */
  reload: () => void;
};

function read(id: string | undefined): MissionItemView | null {
  if (!id) return null;
  const db = getDb();
  const item = getMissionItem(db, id);
  if (!item) return null;

  const base = {
    item,
    snoozed: isSnoozed(item.id),
    protocol: null,
    phase: null,
    definition: null,
    nextOn: null,
    allowance: null,
    reload: () => {},
  } satisfies MissionItemView;

  if (!item.protocolId || !item.itemId) return base;
  const protocol = getProtocol(db, item.protocolId);
  if (!protocol) return base;

  const today = todayISODate();
  const content = parseProtocolContent(getCurrentVersion(db, protocol.id)?.content ?? null);
  const phase = phaseOn(content, protocol.started_on ?? today, today);
  // The LIVE phase's items, not every phase's: an item that belonged to phase 1
  // is not what this protocol asks for now, and drawing its cadence here would
  // describe a document the protocol has moved past.
  const definition =
    phase.kind === 'running'
      ? (phase.window.phase.items.find((candidate) => candidate.id === item.itemId) ?? null)
      : null;

  if (definition?.cadence.kind === 'quota') {
    return {
      ...base,
      protocol,
      phase,
      definition,
      allowance: {
        perWeek: definition.cadence.per_week,
        done: quotaDoneThisWeek(db, today).get(quotaKey(protocol.id, definition.id)) ?? 0,
      },
    };
  }

  // Strictly forward from TOMORROW, and the first day is suppressed: "next
  // Tue" on a Monday is a longer way of saying tomorrow, and a sheet that
  // names it is spending a line on something the reader already knows.
  const tomorrow = addDays(today, 1);
  const found =
    definition === null ? null : nextOccurrence(projectDays(db, tomorrow), protocol.id, definition.id);
  return {
    ...base,
    protocol,
    phase,
    definition,
    nextOn: found !== null && found > tomorrow ? found : null,
  };
}

/**
 * One row's sheet. Re-reads on focus (so returning from the item editor shows
 * the new cadence) and on any snooze change, since *Unsnooze* is one of the
 * verbs this screen draws and the set lives in a module store.
 */
export function useMissionItem(id: string | undefined): MissionItemView | null {
  const [view, setView] = useState<MissionItemView | null>(() => read(id));

  const reload = useCallback(() => {
    setView(read(id));
  }, [id]);

  useFocusEffect(reload);
  // *Unsnooze* is one of this screen's verbs and the snoozed set lives in a
  // module store, so the sheet subscribes rather than re-reading on focus it
  // never loses.
  useEffect(() => subscribeSnoozeChange(reload), [reload]);

  return view === null ? null : { ...view, reload };
}
