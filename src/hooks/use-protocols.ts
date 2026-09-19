import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import {
  adherenceForLiveVersion,
  type ProtocolAdherence,
} from '@/lib/db/repositories/protocol-adherence';
import { missionCountByProtocol } from '@/lib/db/repositories/mission';
import {
  nextOccurrence,
  projectDays,
  quotaDoneThisWeek,
  quotaKey,
} from '@/lib/db/repositories/mission-generate';
import { getCurrentVersion, getProtocol, listProtocols } from '@/lib/db/repositories/protocols';
import type { ProtocolRow, ProtocolVersionRow } from '@/lib/db/types';
import { addDays } from '@/lib/protocols/cadence';
import { parseProtocolContent } from '@/lib/protocols/content';
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
  /**
   * How many rows this protocol has on TODAY — the row's lead figure.
   *
   * It replaces `contentCadenceSummary`, which said **"mixed"** the moment two
   * items disagreed: a daily creatine beside a Mon/Wed/Fri lift read `mixed`,
   * and so did a protocol with one 3×/wk quota. That word told the reader
   * nothing they could act on, and nothing on the hub said what any protocol
   * put on today or when the next thing landed.
   */
  today: number;
  /**
   * The next day after tomorrow this protocol lands one of its non-quota items,
   * or null. Suppressed when it is tomorrow, because naming tomorrow is a
   * longer way of saying tomorrow; null for a quota (an allowance, not a day),
   * for a paused or ended protocol, and past the six-day horizon.
   */
  nextOn: string | null;
  /**
   * A single-quota protocol's allowance — `1 of 3 this week`. Null otherwise,
   * including for a protocol with SEVERAL quota items: there is no one honest
   * figure for two allowances, and inventing a combined one is the kind of
   * number the house rules exist to refuse.
   */
  allowance: { perWeek: number; done: number } | null;
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

/**
 * The hub's whole read, and the rule that keeps it cheap.
 *
 * **Three reads happen ONCE, before the loop, and each row is handed its
 * slice:** today's committed rows grouped by protocol, one six-day projection,
 * and one week-to-date quota count. Every one of them is a query (the
 * projection is six `planForDay` calls) and calling any of them inside the
 * per-protocol loop would multiply the whole cost by the number of protocols on
 * the device — which is exactly what the adherence read already does and the
 * reason it is the row's most expensive field.
 */
function readHub(): ProtocolHub {
  const db = getDb();
  const today = todayISODate();
  const tomorrow = addDays(today, 1);
  const counts = missionCountByProtocol(db, today);
  const projection = projectDays(db, tomorrow);
  const quotaDone = quotaDoneThisWeek(db, today);
  const hub: ProtocolHub = { running: [], ended: [], paused: [] };
  for (const item of listProtocols(db)) {
    const content = parseProtocolContent(getCurrentVersion(db, item.id)?.content);
    const phase = phaseOn(content, item.startedOn ?? today, today);
    const record = adherenceForLiveVersion(db, item.id, today);
    // Only the LIVE phase's items: what an earlier phase asked for is not what
    // this protocol is doing now.
    const items = phase.kind === 'running' ? phase.window.phase.items : [];
    const days = items
      .filter((entry) => entry.cadence.kind !== 'quota')
      .map((entry) => nextOccurrence(projection, item.id, entry.id))
      .filter((day): day is string => day !== null)
      .sort();
    const earliest = days[0];
    const onlyQuota = items.length === 1 && items[0]?.cadence.kind === 'quota' ? items[0] : null;
    const row: ProtocolHubRow = {
      item,
      content,
      phase,
      today: counts.get(item.id) ?? 0,
      nextOn: earliest !== undefined && earliest > tomorrow ? earliest : null,
      allowance:
        onlyQuota !== null && onlyQuota.cadence.kind === 'quota'
          ? {
              perWeek: onlyQuota.cadence.per_week,
              done: quotaDone.get(quotaKey(item.id, onlyQuota.id)) ?? 0,
            }
          : null,
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

/** One projected day's slice for one protocol — a date and the titles on it. */
export type ComingDay = { date: string; titles: string[] };

/** A protocol plus how well it is actually being run — the detail screen's read. */
export type ProtocolRecord = ProtocolDetail & {
  adherence: ProtocolAdherence & { versionNumber: number | null; since: string | null };
  /**
   * The next six days this protocol puts something on, from TOMORROW — the
   * detail's *Coming up*. Days it puts nothing on are absent rather than drawn
   * empty, and a QUOTA item never appears at all: it has an allowance, not a
   * day, and it reads that allowance on its own row in *Now*.
   *
   * Empty for a paused or ended protocol, which is why the section is not drawn
   * for either.
   */
  coming: ComingDay[];
  /** Each live-phase quota item's allowance this week, keyed by item id. */
  allowances: Map<string, { perWeek: number; done: number }>;
};

function readRecord(id: string | undefined): ProtocolRecord | null {
  const today = todayISODate();
  const detail = readDetail(id, today);
  if (!detail) return null;
  const db = getDb();
  // One projection and one quota count for the whole screen, read here and
  // sliced per row — never inside the item loop.
  const projection = projectDays(db, addDays(today, 1));
  const coming: ComingDay[] = [];
  for (const day of projection) {
    const titles = day.entries
      .filter((entry) => entry.protocolId === detail.protocol.id)
      .map((entry) => entry.title);
    if (titles.length > 0) coming.push({ date: day.date, titles });
  }
  const quotaDone = quotaDoneThisWeek(db, today);
  const allowances = new Map<string, { perWeek: number; done: number }>();
  const items = detail.phase.kind === 'running' ? detail.phase.window.phase.items : [];
  for (const item of items) {
    if (item.cadence.kind !== 'quota') continue;
    allowances.set(item.id, {
      perWeek: item.cadence.per_week,
      done: quotaDone.get(quotaKey(detail.protocol.id, item.id)) ?? 0,
    });
  }
  return {
    ...detail,
    adherence: adherenceForLiveVersion(db, detail.protocol.id, today),
    coming,
    allowances,
  };
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
