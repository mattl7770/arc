import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import {
  adherenceForLiveVersion,
  type ProtocolAdherence,
} from '@/lib/db/repositories/protocol-adherence';
import { getCurrentVersion, getProtocol, listProtocols } from '@/lib/db/repositories/protocols';
import type { ProtocolRow, ProtocolVersionRow } from '@/lib/db/types';
import { parseProtocolContent } from '@/lib/protocols/content';
import { contentCadenceSummary } from '@/lib/protocols/format';
import { phaseOn, type PhaseState } from '@/lib/protocols/phase';
import type { ProtocolContent, ProtocolListItem } from '@/lib/protocols/types';

export type Protocols = {
  protocols: ProtocolListItem[];
  /** Re-read the list — call after an in-screen save/delete. */
  reload: () => void;
};

/**
 * The Protocols list, backed by the on-device database.
 *
 * Same shape as use-log-feed: op-sqlite is synchronous, so the first read runs
 * in the `useState` initializer (no loading state), and `useFocusEffect`
 * re-reads whenever the screen regains focus — e.g. returning from the editor
 * after a save.
 */
export function useProtocols(): Protocols {
  const [protocols, setProtocols] = useState<ProtocolListItem[]>(() => listProtocols(getDb()));

  const reload = useCallback(() => {
    setProtocols(listProtocols(getDb()));
  }, []);

  useFocusEffect(reload);

  return { protocols, reload };
}

/** One hub row: the protocol, where it is up to, and whether it is being run. */
export type ProtocolHubRow = {
  item: ProtocolListItem;
  content: ProtocolContent;
  phase: PhaseState;
  /** "daily", "3×/wk", "mixed" — null when the live version has no items. */
  cadence: string | null;
  /** completed ÷ planned since the live version landed; null with no record. */
  rate: number | null;
  /** Planned rows behind that rate — 0 means "nothing settled yet", not 0%. */
  planned: number;
};

/**
 * The hub's three lists.
 *
 * **Ended is separated from running deliberately.** A protocol whose last
 * bounded phase has run out is still `is_active = 1` in the database and
 * generates nothing — listed among the running ones it would read as working
 * and silently do nothing, which is the failure the split exists to prevent.
 */
export type ProtocolHub = {
  running: ProtocolHubRow[];
  ended: ProtocolHubRow[];
  paused: ProtocolHubRow[];
};

function readHub(): ProtocolHub {
  const db = getDb();
  const today = todayISODate();
  const hub: ProtocolHub = { running: [], ended: [], paused: [] };
  for (const item of listProtocols(db)) {
    const content = parseProtocolContent(getCurrentVersion(db, item.id)?.content);
    const phase = phaseOn(content, item.startedOn ?? today, today);
    const record = adherenceForLiveVersion(db, item.id, today);
    const row: ProtocolHubRow = {
      item,
      content,
      phase,
      cadence: contentCadenceSummary(content),
      rate: record.rate,
      planned: record.planned,
    };
    if (!item.isActive) hub.paused.push(row);
    else if (phase.kind === 'ended') hub.ended.push(row);
    else hub.running.push(row);
  }
  return hub;
}

/** Every protocol, split into running / ended / paused — the hub's whole read. */
export function useProtocolHub(): ProtocolHub {
  const [hub, setHub] = useState<ProtocolHub>(() => readHub());

  const reload = useCallback(() => {
    setHub(readHub());
  }, []);

  useFocusEffect(reload);

  return hub;
}

export type ProtocolDetail = {
  protocol: ProtocolRow;
  /** The live version row, or null while the protocol has no version yet. */
  version: ProtocolVersionRow | null;
  /** The live version's parsed content (one empty phase when version is null). */
  content: ProtocolContent;
  /**
   * Which phase is live TODAY, or that the protocol has ended / not begun.
   * Read here rather than in each screen so the hub, the detail screen and the
   * editor cannot disagree about where a protocol is up to.
   */
  phase: PhaseState;
};

function readDetail(id: string | undefined, today: string): ProtocolDetail | null {
  if (!id) return null;
  const db = getDb();
  const protocol = getProtocol(db, id);
  if (!protocol) return null;
  const version = getCurrentVersion(db, id) ?? null;
  const content = parseProtocolContent(version?.content);
  return {
    protocol,
    version,
    content,
    // A protocol with no anchor is read as starting today — the same reading
    // the generator makes permanent on its next run (0043).
    phase: phaseOn(content, protocol.started_on ?? today, today),
  };
}

/**
 * One protocol + its live version for the editor. `id` undefined (the create
 * path) or unknown reads as null. Same initializer + focus-refresh pattern;
 * the editor seeds its form fields from the first read only, so the refresh
 * never clobbers in-progress edits.
 */
export function useProtocol(id: string | undefined): ProtocolDetail | null {
  const today = todayISODate();
  const [detail, setDetail] = useState<ProtocolDetail | null>(() => readDetail(id, today));

  const reload = useCallback(() => {
    setDetail(readDetail(id, todayISODate()));
  }, [id]);

  useFocusEffect(reload);

  return detail;
}

/** A protocol plus how well it is actually being run — the detail screen's read. */
export type ProtocolRecord = ProtocolDetail & {
  adherence: ProtocolAdherence & { versionNumber: number | null; since: string | null };
};

function readRecord(id: string | undefined): ProtocolRecord | null {
  const today = todayISODate();
  const detail = readDetail(id, today);
  if (!detail) return null;
  return { ...detail, adherence: adherenceForLiveVersion(getDb(), detail.protocol.id, today) };
}

/**
 * One protocol, its live phase, and its execution record since the live version
 * landed — everything app/protocol-detail.tsx draws, read in one place so the
 * screen holds no query of its own.
 */
export function useProtocolRecord(id: string | undefined): ProtocolRecord | null {
  const [record, setRecord] = useState<ProtocolRecord | null>(() => readRecord(id));

  const reload = useCallback(() => {
    setRecord(readRecord(id));
  }, [id]);

  useFocusEffect(reload);

  return record;
}
