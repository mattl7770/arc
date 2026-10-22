/**
 * The calendar block for one Coach request — the switch, the read, the cache,
 * the format (2026-10-21, docs/decisions.md "Calendar context to the model").
 *
 * Called by coach-service.ts (every chat turn) and coach-pass.ts (every pass,
 * whatever its trigger, the weekly review included) before they build the
 * per-turn context; the string it returns rides turn-context.ts's per-turn
 * block — outside the 1-hour cached prefix — as its own section, so the cached
 * prefix and the chat ceilings (db/coach-eval.test.mjs §6) do not move.
 *
 * - **Off → nothing.** With the switch off (the default) this returns null
 *   before touching the native module, so no permission is checked and no
 *   prompt can appear.
 * - **Never at rest.** Events are read fresh from iOS and held in this module's
 *   memory for {@link CALENDAR_CACHE_MS} — long enough that a five-request
 *   tool loop, or a chat turn right after the morning pass, reads once rather
 *   than six times; short enough that a meeting added in the Calendar app shows
 *   up on the next question. The cache is keyed on the window, so a day
 *   rollover reads afresh. The read writes nothing to SQLite, a file or a log
 *   (Coach text that later mentions an event is stored like any reply).
 * - **Never throws, never holds a turn up.** The seam times out at
 *   2.5 s and every failure becomes one honest line or null.
 */
import { getDayStartsAt, logicalDayUtcRange } from '@/lib/db/date';
import type { Database } from '@/lib/db/database';
import { getCalendarContextOn } from '@/lib/db/repositories/calendar-setting';

import { readCalendarEvents, type CalendarRead } from './calendar';
import {
  calendarWindowDays,
  formatCalendarBlock,
  formatCalendarGap,
  type CalendarEventFact,
} from './format';

/** How long one read is reused. */
export const CALENDAR_CACHE_MS = 5 * 60_000;

let cache: { key: string; at: number; events: CalendarEventFact[] } | null = null;

/** Forget the cached read — the switch calls this both ways. */
export function clearCalendarCache(): void {
  cache = null;
}

export type CalendarBlockOptions = {
  /** Injected in tests; the native seam on device. */
  reader?: (start: Date, end: Date) => Promise<CalendarRead>;
  dayStartsAt?: string;
};

/**
 * The calendar section for a request made at `now`, or null when the owner has
 * the switch off (or anything at all goes wrong before a line can be written).
 */
export async function calendarBlockFor(
  db: Database,
  now: Date,
  options: CalendarBlockOptions = {}
): Promise<string | null> {
  try {
    if (!getCalendarContextOn(db)) return null;
    const dayStartsAt = options.dayStartsAt ?? getDayStartsAt();
    const { today, lastDay } = calendarWindowDays(now, dayStartsAt);
    const startUtc = logicalDayUtcRange(today, dayStartsAt).startUtc;
    const endUtc = logicalDayUtcRange(lastDay, dayStartsAt).endUtc;
    const key = `${startUtc}|${endUtc}`;
    const at = now.getTime();

    let events: CalendarEventFact[];
    if (cache && cache.key === key && at >= cache.at && at - cache.at < CALENDAR_CACHE_MS) {
      events = cache.events;
    } else {
      const read = await (options.reader ?? readCalendarEvents)(
        new Date(startUtc),
        new Date(endUtc)
      );
      if (!read.ok) {
        cache = null;
        return formatCalendarGap(read.reason);
      }
      events = read.events;
      cache = { key, at, events };
    }
    return formatCalendarBlock(events, now, dayStartsAt);
  } catch {
    return null;
  }
}
