/**
 * **What has to happen, in order, on the foreground that sees a zone change.**
 *
 * `observeTimezone` writes the row. Two other things in the app are wrong until
 * something reacts to it, and neither of them was reacting:
 *
 *   1. **The OS notification schedule is anchored to the old zone.** Protocol
 *      nudges and one-off reminders are absolute instants — a `Date` built
 *      componentwise in whatever zone the phone was in at scheduling time — so a
 *      07:00 magnesium set in Los Angeles fires at 16:00 in London. Daily and
 *      weekly reminders float natively and are fine. The divergence lasts until
 *      the next reconciliation, which happens at boot, on a day rollover, after
 *      a status write and after a Coach turn: in other words at some
 *      unpredictable later moment. The choice is therefore not "local time or
 *      home time" — it is "local time now" or "local time whenever something
 *      unrelated next fires", and the first is the only one that can be
 *      explained. Owner's Q3(a).
 *   2. **The health pass windows its 14 days under the CURRENT zone**, so the
 *      row has to exist before it runs or the first post-landing sync buckets
 *      under an offset with no row behind it.
 *
 * ## Where this runs, and why it is its own subscription
 *
 * `app/_layout.tsx` has no timezone listener: the observer rode the BACKUP's
 * subscription, which also runs `autoBackupIfDue` and the estimate drain. This
 * does not swap into that — it registers its OWN `AppState` listener, ABOVE
 * `registerForegroundHealthSync`, and the backup listener keeps the backup and
 * the drain. Listener order is how the row comes to exist before the health
 * pass computes its windows (§3e's trap) and before the Coach pass reads
 * `duePass`.
 *
 * That ordering is **soft, and deliberately so**: the landing signal is read
 * from the ROW, not from this call's return value, so a resume that somehow read
 * first fires the landing turn on the NEXT foreground rather than never. An
 * ordering, not a structure.
 *
 * ## Cost
 *
 * Nothing, on every foreground but the handful a year that return a row:
 * `observeTimezone` is one preference read, and everything below is gated on it
 * having written something.
 */
import type { Database } from '@/lib/db/database';
import { observeTimezone, type TimezoneChangeRow } from '@/lib/db/repositories/day-meta';
import { syncReminderNotifications } from '@/lib/notifications/reminders';

export type ForegroundDeps = {
  /** Rebuild the OS schedule from the database. Coalesced inside. */
  syncReminders(db: Database, now: Date): Promise<unknown>;
};

const NATIVE_DEPS: ForegroundDeps = {
  syncReminders: (db, now) => syncReminderNotifications(db, now),
};

/**
 * Observe the zone, and re-anchor what the zone moved. Returns the row that was
 * written, or `null` — which is the answer on all but a handful of foregrounds a
 * year.
 *
 * The re-sync is fired and not awaited by the caller: an `AppState` handler that
 * waits on the OS notification scheduler is a resume that stalls on something
 * best-effort. Failures inside the pass are already swallowed and reported in
 * its result.
 */
export function onForeground(
  db: Database,
  now: Date = new Date(),
  deps: ForegroundDeps = NATIVE_DEPS
): TimezoneChangeRow | null {
  const row = observeTimezone(db, now);
  if (row === null) return null;
  void deps.syncReminders(db, now);
  return row;
}
