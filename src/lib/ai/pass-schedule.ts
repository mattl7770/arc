/**
 * WHEN the coach pass runs — the deterministic half of proactivity.
 *
 * This module decides only whether to wake the model, never what it should
 * conclude. Two triggers:
 *
 *   DAILY — once per calendar day, on first app open. Bounded by a stored
 *   date, so re-opening the app ten times costs one pass.
 *
 *   SIGNAL — an attention router: when a watch-tone insight appears that was
 *   NOT there at the last pass, the day deserves a second look without waiting
 *   for tomorrow. Keyed by the insight ids so the same standing signal (an
 *   HRV trend that persists for a week) fires once, not every launch.
 *
 * State lives in `users.preferences.coachPass` — the unit-preferences pattern,
 * so no migration. Pure over the {@link Database} interface apart from that
 * read/write; headless-tested in db/coach-pass.test.mjs.
 */
import type { Database } from '@/lib/db/database';
import { todayISODate } from '@/lib/db/date';
import { getOrCreateUser } from '@/lib/db/repositories/user';

import { computeInsights } from './insights';
import type { PassTrigger } from './coach-pass';

export type PassState = {
  /** YYYY-MM-DD of the last pass of any kind. */
  lastDate: string | null;
  /** Insight ids present at the last pass — the attention router's memory. */
  seenSignals: string[];
};

const EMPTY: PassState = { lastDate: null, seenSignals: [] };

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

export function getPassState(db: Database): PassState {
  const section = parsePreferences(getOrCreateUser(db).preferences)['coachPass'];
  if (!section || typeof section !== 'object' || Array.isArray(section)) return EMPTY;
  const record = section as Record<string, unknown>;
  return {
    lastDate: typeof record.lastDate === 'string' ? record.lastDate : null,
    seenSignals: Array.isArray(record.seenSignals)
      ? record.seenSignals.filter((s): s is string => typeof s === 'string')
      : [],
  };
}

export function setPassState(db: Database, state: PassState): void {
  const user = getOrCreateUser(db);
  const preferences = parsePreferences(user.preferences);
  preferences.coachPass = state;
  db.run('UPDATE users SET preferences = ? WHERE id = ?', [JSON.stringify(preferences), user.id]);
}

/** The signals worth waking the Coach for: anything it should act on. */
export function currentSignals(db: Database, now: Date): string[] {
  return computeInsights(db, now)
    .filter((insight) => insight.tone === 'watch')
    .map((insight) => insight.id)
    .sort();
}

/**
 * Should a pass run right now, and why? Null means no — the common case, and
 * the one that keeps this from becoming noise.
 *
 * A clock rolled BACKWARD (timezone travel, a manual clock change) must not
 * re-fire the day's pass: `lastDate` is compared for inequality only when it
 * is in the past, so a stored date "ahead" of today is left alone.
 */
export function duePass(db: Database, now: Date = new Date()): PassTrigger | null {
  const today = todayISODate(now);
  const state = getPassState(db);

  if (state.lastDate === null || state.lastDate < today) return { kind: 'daily' };

  // Same day (or a rolled-back clock): only a NEW signal justifies another pass.
  const seen = new Set(state.seenSignals);
  const fresh = currentSignals(db, now).filter((id) => !seen.has(id));
  if (fresh.length > 0) return { kind: 'signal', detail: fresh.join(', ') };
  return null;
}

/**
 * Record that a pass just ran. Always stores the CURRENT signal set, so a
 * signal that fired one pass never re-triggers the next — including when the
 * pass chose to say nothing (a signal the Coach judged unremarkable must not
 * ask again an hour later).
 */
export function markPassRan(db: Database, now: Date = new Date()): void {
  setPassState(db, { lastDate: todayISODate(now), seenSignals: currentSignals(db, now) });
}
