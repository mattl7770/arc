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
import { getModeDefinition, type ModeItem, type ModeKey } from '@/lib/modes/registry';

import { getActiveMode } from './day-modes';
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
  /** Present on mode-injected items, absent on protocol items. */
  mode?: ModeKey;
};

/** Insert one generated mission entry; returns nothing, bumps the caller's count. */
function insertGenerated(
  db: Database,
  logId: string,
  args: {
    type: LogEntryType;
    protocolId: string | null;
    title: string;
    scheduledTime: string | null;
    extras: GeneratedExtras;
  }
): void {
  db.run(
    `INSERT INTO log_entries
       (id, daily_log_id, type, protocol_id, title, status, scheduled_time, value, source)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 'manual')`,
    [
      newId(db),
      logId,
      args.type,
      args.protocolId,
      args.title,
      args.scheduledTime,
      JSON.stringify(args.extras),
    ]
  );
}

/**
 * Generate `date`'s mission from the active protocols' live versions, ADAPTED to
 * the day's mode (docs/information-architecture.md §Modes). The active mode
 * DROPS generated items whose type it excludes (Sick pulls training) and ADDS
 * its own standard items (Sick adds rest / fluids / immune support). Returns the
 * number of entries created — **0** when the day already has planned entries
 * (the idempotency guard) OR when there is nothing to generate (no active
 * protocols AND the mode injects nothing). A mode set today reshapes only
 * TODAY's not-yet-generated mission and every future day; a day already
 * generated stays committed (like a protocol edit).
 */
export function generateMissionForDay(db: Database, date: string): number {
  const log = getOrCreateDailyLog(db, date);
  if (countMissionEntries(db, log.id) > 0) return 0;

  const mode = getActiveMode(db, date);
  const def = getModeDefinition(mode);
  const active = listProtocols(db).filter((p) => p.isActive && p.versionNumber !== null);
  if (active.length === 0 && def.addItems.length === 0) return 0;

  let count = 0;
  db.transaction(() => {
    for (const protocol of active) {
      const type = LOG_TYPE_BY_PROTOCOL[protocol.type];
      // Mode can pull a whole protocol type for the day (e.g. Sick drops workouts).
      if (def.dropTypes.includes(type)) continue;
      const items = parseProtocolContent(getCurrentVersion(db, protocol.id)?.content ?? null).items;
      for (const item of items) {
        const why = item.dose ?? item.notes ?? undefined;
        insertGenerated(db, log.id, {
          type,
          protocolId: protocol.id,
          title: item.title,
          scheduledTime: item.scheduled_time ?? null,
          extras: { protocol: protocol.name, ...(why ? { why } : {}), generated: true },
        });
        count++;
      }
    }
    // Mode-injected standard items, tagged with the mode so they're
    // distinguishable from protocol items and the mock seed.
    for (const item of def.addItems as ModeItem[]) {
      insertGenerated(db, log.id, {
        type: item.type,
        protocolId: null,
        title: item.title,
        scheduledTime: item.scheduledTime ?? null,
        extras: {
          protocol: def.label,
          ...(item.why ? { why: item.why } : {}),
          generated: true,
          mode: def.key,
        },
      });
      count++;
    }
  });
  return count;
}
