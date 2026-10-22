/**
 * The spend ledger's storage and its one writer (2026-10-21; the pure half is
 * src/lib/ai/spend-ledger.ts).
 *
 * The model client reports every billed round trip to ONE sink
 * (model-client.ts `setModelUsageSink`); {@link installSpendLedger} makes that
 * sink this module's {@link recordModelCall}, at launch (app/_layout.tsx). So
 * there is no call site to remember: a feature that calls the model is
 * recorded because it called the model.
 *
 * The ledger is `users.preferences.spendLedger` — the same read-modify-write
 * every preference section uses (pass-schedule.ts, coach-nudges.ts), done in
 * one synchronous step so no other writer can interleave, and touching only
 * its own key.
 *
 * **A ledger failure never fails a model call.** {@link recordModelCall}
 * catches everything; the model client also swallows anything a sink throws.
 * The call has already been billed either way; losing its answer as well
 * would make a bookkeeping fault into a user-visible one.
 */
import type { Database } from '@/lib/db/database';
import { todayISODate } from '@/lib/db/date';
import { getOrCreateUser } from '@/lib/db/repositories/user';

import { type ModelCallRecord, setModelUsageSink } from './model-client';
import {
  EMPTY_LEDGER,
  LEDGER_KEY,
  parseLedger,
  recordInLedger,
  type SpendLedger,
  spentToday,
} from './spend-ledger';

function parsePreferences(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The stored ledger; empty when there is none or it cannot be read. */
export function readSpendLedger(db: Database): SpendLedger {
  try {
    return parseLedger(parsePreferences(getOrCreateUser(db).preferences)[LEDGER_KEY]);
  } catch {
    return EMPTY_LEDGER;
  }
}

/**
 * Add one billed call to the ledger, filed under the logical day of `now`.
 * Never throws (see the header); returns whether the write landed, for tests.
 */
export function recordModelCall(
  db: Database,
  record: ModelCallRecord,
  now: Date = new Date()
): boolean {
  try {
    const user = getOrCreateUser(db);
    const preferences = parsePreferences(user.preferences);
    const next = recordInLedger(parseLedger(preferences[LEDGER_KEY]), record, todayISODate(now));
    preferences[LEDGER_KEY] = next;
    db.run('UPDATE users SET preferences = ? WHERE id = ?', [JSON.stringify(preferences), user.id]);
    return true;
  } catch (error) {
    console.warn('[spend] could not record a model call', error);
    return false;
  }
}

/** Estimated USD spent today — the usage policy's read (spend-ledger.ts `spentToday`). */
export function spentTodayFrom(db: Database, now: Date = new Date()): number {
  return spentToday(readSpendLedger(db), todayISODate(now));
}

/**
 * Point the model client's usage sink at the ledger. `getDb` is a function so
 * the database is looked up at record time, not install time. Idempotent;
 * returns a function that removes the sink again.
 */
export function installSpendLedger(getDb: () => Database): () => void {
  const sink = (record: ModelCallRecord) => {
    let db: Database;
    try {
      db = getDb();
    } catch {
      return;
    }
    recordModelCall(db, record);
  };
  setModelUsageSink(sink);
  return () => {
    // Only remove what this call installed.
    const current = setModelUsageSink(null);
    if (current !== sink) setModelUsageSink(current);
  };
}
