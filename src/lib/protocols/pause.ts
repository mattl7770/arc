/**
 * Pausing and resuming a protocol — ONE act, with one definition, used by the
 * protocol page's *Pause this protocol* / *Resume this protocol* row
 * (app/protocol-detail.tsx) and by the Coach's `edit_record` on the protocols
 * domain (src/lib/ai/domains/write-domains.ts).
 *
 * The owner's answer of 2026-09-25: pause is a row on the protocol's page with a
 * confirmation that says what leaves today — **no form and no Save**. So it is
 * not a field of the editor any more, and the two surfaces that can pause have
 * to agree about what pausing does. Three steps, always in this order:
 *
 *   1. `setActive` — the flag, and on a resume the phase clock's anchor if it
 *      was never set. An existing anchor is left alone: pausing a titration for
 *      a fortnight must not put the user back on week 1.
 *   2. re-derive today — a pause takes the protocol's untouched rows off
 *      today's mission and a resume puts them back; anything done, skipped or
 *      partial is preserved by the same diff every protocol write uses. Without
 *      this a pause took effect tomorrow, silently (the Phase 0 defect 2 fix).
 *   3. re-sync the OS reminders, so a paused protocol stops buzzing the phone
 *      and a resumed one starts again. On the Coach tab this is a second call
 *      beside the tab's own after-turn sync; the sync coalesces overlapping
 *      calls into one trailing pass, so the two cost one rebuild.
 */
import type { Database } from '@/lib/db/database';
import { todayISODate } from '@/lib/db/date';
import { rederiveMissionFromToday } from '@/lib/db/repositories/mission-generate';
import { setActive } from '@/lib/db/repositories/protocols';
import { syncReminderNotifications } from '@/lib/notifications/reminders';

export function setProtocolRunning(
  db: Database,
  id: string,
  running: boolean,
  today: string = todayISODate()
): void {
  setActive(db, id, running, today);
  rederiveMissionFromToday(db, today);
  void syncReminderNotifications(db);
}
