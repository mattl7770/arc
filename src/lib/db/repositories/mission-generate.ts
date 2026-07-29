/**
 * The protocol → mission generator — the seam that turns ARC from a logger into
 * an operating system. The user's ACTIVE protocols' live versions ARE the plan;
 * this expands them into the day's `log_entries` (the mission Home renders and
 * the Coach reads via get_today_snapshot).
 *
 * Design:
 *  - Each protocol item (`{title, scheduled_time, dose, notes}`) becomes one
 *    log_entry, `type` mapped from the protocol's type, linked back to its
 *    source via `protocol_id` (ON DELETE SET NULL — deleting a protocol never
 *    destroys the day's execution history). The dose (or notes) rides the
 *    mission `why` line; the protocol name rides `protocol`.
 *  - Idempotent per day: it does nothing if the day already has planned entries,
 *    so it is safe to call on every open. A protocol edited *today* therefore
 *    reshapes only TOMORROW's mission — protocols are versioned like code, and
 *    today's plan is already committed the moment it was generated.
 *  - Only ACTIVE protocols with a live version contribute; a paused or
 *    version-less protocol is skipped.
 *
 * Pure over the {@link Database} interface (never op-sqlite), so it runs on
 * device and against node:sqlite in db/mission-generate.test.mjs.
 */
import type { Database } from '../database';
import { newId } from '../id';
import type { LogEntryType, ProtocolType } from '../types';
import { parseProtocolContent } from '@/lib/protocols/content';

import { countMissionEntries, getOrCreateDailyLog } from './mission';
import { getCurrentVersion, listProtocols } from './protocols';

/** How each protocol kind lands as a mission entry type (log_entries CHECK). */
const LOG_TYPE_BY_PROTOCOL: Record<ProtocolType, LogEntryType> = {
  daily_routine: 'habit',
  supplement_stack: 'supplement',
  meal_template: 'meal',
  training_block: 'workout',
  therapy_protocol: 'therapy',
  sleep_protocol: 'habit',
  other: 'habit',
};

/**
 * The value-json a generated entry carries. `generated: true` distinguishes it
 * from a mock `seed: true` row and from an ad-hoc Log-tab capture (`adhoc`);
 * `protocol` + `why` are read back by `toMissionItem` for the mission UI.
 */
type GeneratedExtras = {
  protocol: string;
  why?: string;
  generated: true;
};

/**
 * Generate `date`'s mission from the active protocols' live versions. Returns
 * the number of entries created — **0** when the day already has planned entries
 * (the idempotency guard) OR when there are no active protocols to expand.
 */
export function generateMissionForDay(db: Database, date: string): number {
  const log = getOrCreateDailyLog(db, date);
  if (countMissionEntries(db, log.id) > 0) return 0;

  const active = listProtocols(db).filter((p) => p.isActive && p.versionNumber !== null);
  if (active.length === 0) return 0;

  let count = 0;
  db.transaction(() => {
    for (const protocol of active) {
      const version = getCurrentVersion(db, protocol.id);
      const items = parseProtocolContent(version?.content ?? null).items;
      for (const item of items) {
        const why = item.dose ?? item.notes ?? undefined;
        const extras: GeneratedExtras = {
          protocol: protocol.name,
          ...(why ? { why } : {}),
          generated: true,
        };
        db.run(
          `INSERT INTO log_entries
             (id, daily_log_id, type, protocol_id, title, status, scheduled_time, value, source)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 'manual')`,
          [
            newId(db),
            log.id,
            LOG_TYPE_BY_PROTOCOL[protocol.type],
            protocol.id,
            item.title,
            item.scheduled_time ?? null,
            JSON.stringify(extras),
          ]
        );
        count++;
      }
    }
  });
  return count;
}
