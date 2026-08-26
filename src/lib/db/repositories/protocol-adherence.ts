/**
 * Does the user actually RUN this protocol?
 *
 * `log_entries.protocol_id` has been written on every generated row since the
 * generator shipped, and deliberately preserved through a protocol delete — and
 * until now nothing read it back per protocol. So the app could plan a day but
 * never answer the one question that makes a protocol answerable: *"you have
 * been on v3 for six weeks at 78% — is this the protocol you think it is?"*
 *
 * This is that join. It lives in its own module rather than in mission.ts
 * because mission.ts owns the whole-day record (`missionDailySeries`,
 * `missionBySource`) and those are being reworked in parallel; the two must not
 * be edited into each other's way. It consumes mission.ts's SHARED PREDICATES
 * verbatim, so "a planned row" means exactly what it means everywhere else.
 *
 * ⚠️ MERGE NOTE: the mission record is gaining mode-awareness — a day under a
 * mode that drops a whole type EXCUSES those items rather than counting them
 * missed. This module does not yet know about that, so a protocol's rate can
 * read a point or two harsher than the mission record's over a Sick week. The
 * fix is to consume the same excusal the sweep adds, not to grow a second one
 * here.
 */
import type { Database } from '../database';
import { addDays, daysBetween } from '@/lib/protocols/cadence';

import { NOT_REMOVED_SQL, PLANNED_ROW_SQL } from './mission';

/** One repeated item's record under a protocol, across the window. */
export type ProtocolItemRecord = {
  /**
   * The `ProtocolItem.id`, when the row carries one. Rows generated before item
   * stamping (content schema 1) carry none and group by title instead — which
   * is the honest fallback, not a fabricated identity.
   */
  itemId: string | null;
  title: string;
  /** Days in the window this item stood on the plan. */
  planned: number;
  completed: number;
  skipped: number;
  /** Marked partial — real progress, so neither a completion nor a miss. */
  partial: number;
};

export type ProtocolAdherence = {
  /** The INCLUSIVE window measured, or nulls when there was none to measure. */
  from: string | null;
  to: string | null;
  /** Calendar days in that window. 0 when there is no window. */
  days: number;
  planned: number;
  completed: number;
  skipped: number;
  partial: number;
  /**
   * completed ÷ planned, or **null when nothing was ever planned**. A rate over
   * a window that asked nothing of you is undefined, and "0%" for a fortnight
   * nobody was asked to do anything is the lie §5 exists to prevent.
   */
  rate: number | null;
  /** Worst-missed first, then the larger sample, then alphabetical. */
  items: ProtocolItemRecord[];
};

const EMPTY: ProtocolAdherence = {
  from: null,
  to: null,
  days: 0,
  planned: 0,
  completed: 0,
  skipped: 0,
  partial: 0,
  rate: null,
  items: [],
};

/**
 * One protocol's execution over the INCLUSIVE range `from … to`.
 *
 * **Give it settled days only** — the caller passes a range ending BEFORE
 * today, because a pending item at 09:00 is not a miss, it is a morning. Every
 * status here is read as final, and that is only true of a day that is over.
 * `to < from` returns the empty record, which is the honest answer for a
 * protocol whose live version landed today.
 *
 * Grouped by (item id, title) rather than by title alone: an item RENAMED
 * mid-window is one item, and grouping on its text would split its record in
 * two at the moment it was renamed.
 */
export function protocolAdherence(
  db: Database,
  protocolId: string,
  from: string,
  to: string
): ProtocolAdherence {
  if (to < from) return EMPTY;
  const rows = db.all<{
    itemId: string | null;
    title: string;
    planned: number;
    completed: number;
    skipped: number;
    partialCount: number;
  }>(
    `SELECT json_extract(e.value, '$.item') AS itemId,
            e.title AS title,
            count(*) AS planned,
            sum(CASE WHEN e.status = 'completed' THEN 1 ELSE 0 END) AS completed,
            sum(CASE WHEN e.status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
            -- Aliased away from a bare \`partial\`: SQL-standard MATCH PARTIAL
            -- makes the word a parser hazard not worth taking for an alias.
            sum(CASE WHEN e.status = 'partial' THEN 1 ELSE 0 END) AS partialCount
       FROM log_entries e
       JOIN daily_logs d ON d.id = e.daily_log_id
      WHERE e.protocol_id = ?
        AND d.date >= ? AND d.date <= ?
        AND ${PLANNED_ROW_SQL}
        AND ${NOT_REMOVED_SQL}
      GROUP BY json_extract(e.value, '$.item'), e.title`,
    [protocolId, from, to]
  );

  const items: ProtocolItemRecord[] = rows.map((r) => ({
    itemId: r.itemId,
    title: r.title,
    planned: r.planned,
    completed: r.completed,
    skipped: r.skipped,
    partial: r.partialCount,
  }));
  items.sort((a, b) => {
    const missed = b.planned - b.completed - (a.planned - a.completed);
    if (missed !== 0) return missed;
    const size = b.planned - a.planned;
    if (size !== 0) return size;
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
  });

  const total = items.reduce(
    (acc, item) => ({
      planned: acc.planned + item.planned,
      completed: acc.completed + item.completed,
      skipped: acc.skipped + item.skipped,
      partial: acc.partial + item.partial,
    }),
    { planned: 0, completed: 0, skipped: 0, partial: 0 }
  );

  return {
    from,
    to,
    days: dayCount(from, to),
    ...total,
    rate: total.planned === 0 ? null : total.completed / total.planned,
    items,
  };
}

/**
 * Inclusive calendar-day count. Pure date arithmetic, never `Date.now()` minus
 * a stored timestamp: SQLite's `strftime('now')` reads a finer clock than JS
 * does on Windows, and a `now − then` in milliseconds has twice shipped as a
 * negative duration here.
 */
function dayCount(from: string, to: string): number {
  return Math.max(0, daysBetween(from, to) + 1);
}

/** The live version's number and the day it landed — "v3 · since 12 Jul". */
export function liveVersionStart(
  db: Database,
  protocolId: string
): { versionNumber: number; since: string } | null {
  const row = db.get<{ version_number: number; created_at: string }>(
    `SELECT v.version_number, v.created_at
       FROM protocols p JOIN protocol_versions v ON v.id = p.current_version_id
      WHERE p.id = ?`,
    [protocolId]
  );
  if (!row) return null;
  return { versionNumber: row.version_number, since: row.created_at.slice(0, 10) };
}

/**
 * The protocol's record SINCE ITS LIVE VERSION LANDED, up to yesterday.
 *
 * Bounded at the live version deliberately: adherence to a protocol you have
 * since changed is a fact about a different protocol, and averaging the two
 * together is how "78%" stops meaning anything. Returns the empty record when
 * there is no version, or when the version landed today and nothing has settled.
 */
export function adherenceForLiveVersion(
  db: Database,
  protocolId: string,
  today: string
): ProtocolAdherence & { versionNumber: number | null; since: string | null } {
  const live = liveVersionStart(db, protocolId);
  if (!live) return { ...EMPTY, versionNumber: null, since: null };
  const record = protocolAdherence(db, protocolId, live.since, addDays(today, -1));
  return { ...record, versionNumber: live.versionNumber, since: live.since };
}
