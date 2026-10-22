/**
 * The usage policy's storage and its one reader (2026-10-21; the pure half is
 * src/lib/ai/usage-policy.ts).
 *
 * The setting is `users.preferences.usagePolicy` — `{ level?, budgets? }`, no
 * migration — beside the spend ledger it is judged against, written by the
 * same synchronous read-modify-write every preference section uses, touching
 * only its own key. Nothing is stored until he chooses, which is how a fresh
 * install reads as "never chosen" and gets the default (Generous).
 *
 * {@link installUsagePolicy} runs at launch (app/_layout.tsx), beside
 * `installSpendLedger`, so every module's `activeUsagePolicy()` reads through
 * here. A read that fails is reported as UNREADABLE, never as "nothing stored":
 * the first means Lean, the second the default, and only one of them is safe to
 * guess.
 */
import type { Database } from '@/lib/db/database';
import { getOrCreateUser } from '@/lib/db/repositories/user';

import { spentTodayFrom } from './spend-store';
import {
  isUsageLevel,
  resolveUsage,
  setUsagePolicySource,
  type UsageLevel,
  type UsageResolution,
  type UsageSourceRead,
} from './usage-policy';

export const USAGE_POLICY_KEY = 'usagePolicy';

/** The preferences object, or null when the stored JSON cannot be read. */
function readPreferences(db: Database): Record<string, unknown> | null {
  const raw = getOrCreateUser(db).preferences;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The raw setting and today's spend, or unreadable. Never throws. */
export function readUsageSource(db: Database, now: Date = new Date()): UsageSourceRead {
  try {
    const preferences = readPreferences(db);
    if (!preferences) return { readable: false };
    return {
      readable: true,
      stored: preferences[USAGE_POLICY_KEY],
      spentTodayUsd: spentTodayFrom(db, now),
    };
  } catch {
    return { readable: false };
  }
}

/** What runs now, read straight from this database (the screen's read). */
export function usageResolutionFrom(db: Database, now: Date = new Date()): UsageResolution {
  return resolveUsage(readUsageSource(db, now));
}

function writeSetting(db: Database, patch: (current: Record<string, unknown>) => void): void {
  const user = getOrCreateUser(db);
  // A preferences blob that cannot be parsed is not overwritten from here:
  // every other section lives in it too.
  const preferences = readPreferences(db);
  if (!preferences) throw new Error('Preferences could not be read.');
  const existing = preferences[USAGE_POLICY_KEY];
  const current: Record<string, unknown> =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  patch(current);
  preferences[USAGE_POLICY_KEY] = current;
  db.run('UPDATE users SET preferences = ? WHERE id = ?', [JSON.stringify(preferences), user.id]);
}

/** Store the level he chose. It stays until he chooses another (no end date). */
export function saveUsageLevel(db: Database, level: UsageLevel): void {
  if (!isUsageLevel(level)) throw new Error(`Unknown usage level: ${String(level)}`);
  writeSetting(db, (current) => {
    current.level = level;
  });
}

/**
 * Store a level's soft daily budget: a positive USD figure, or null for "off".
 * Lean has no budget, so it is refused rather than stored and ignored.
 */
export function saveDailyBudget(db: Database, level: UsageLevel, usd: number | null): void {
  if (level === 'lean') throw new Error('Lean has no soft budget.');
  if (usd !== null && !(Number.isFinite(usd) && usd > 0)) {
    throw new Error('A soft budget is a positive amount, or off.');
  }
  writeSetting(db, (current) => {
    const budgets =
      current.budgets && typeof current.budgets === 'object' && !Array.isArray(current.budgets)
        ? { ...(current.budgets as Record<string, unknown>) }
        : {};
    budgets[level] = usd;
    current.budgets = budgets;
  });
}

/**
 * Point `activeUsagePolicy()` at this database. `getDb` is a function so the
 * database is looked up at read time, not install time. Returns a function that
 * removes the source again (only what this call installed).
 */
export function installUsagePolicy(
  getDb: () => Database,
  clock: () => Date = () => new Date()
): () => void {
  const read = (): UsageSourceRead => {
    let db: Database;
    try {
      db = getDb();
    } catch {
      return { readable: false };
    }
    return readUsageSource(db, clock());
  };
  setUsagePolicySource(read);
  return () => {
    const current = setUsagePolicySource(null);
    if (current !== read) setUsagePolicySource(current);
  };
}
