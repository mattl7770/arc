/**
 * WHEN the coach pass runs — the deterministic half of proactivity.
 *
 * This module decides only whether to wake the model, never what it should
 * conclude. Two triggers:
 *
 *   DAILY — once per calendar day, on first app open. Bounded by a stored
 *   date, so re-opening the app ten times costs one pass.
 *
 *   SIGNAL — an attention router: when something appears that was NOT there at
 *   the last pass, the day deserves a second look without waiting for tomorrow.
 *   Keyed by id so the same standing signal (an HRV trend that persists for a
 *   week) fires once, not every launch. Two sources feed it: watch-tone
 *   insights, and a zone change observed today (0060) — see
 *   {@link currentSignals} for why a landing is one and why nothing about it
 *   reaches the brief.
 *
 * State lives in `users.preferences.coachPass` — the unit-preferences pattern,
 * so no migration. Pure over the {@link Database} interface apart from that
 * read/write; headless-tested in db/coach-pass.test.mjs.
 */
import type { Database } from '@/lib/db/database';
import { forwardCursor, todayISODate } from '@/lib/db/date';
import { timezoneChangesOn } from '@/lib/db/repositories/day-meta';
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

/**
 * The signals worth waking the Coach for: anything it should act on.
 *
 * ## Two sources, and why a landing is the second one
 *
 * The first is the watch-tone insights — the attention router this module was
 * written for. The second (0060, owner's Q5(a)) is a **zone change observed
 * today**: a landing is a moment where the day's plan, the reminders and the
 * body's clock have all just moved, and it is neither the daily pass nor a new
 * insight, so nothing would have woken the model for it.
 *
 * What the Coach does with it is entirely the model's call — it is handed the
 * fact through the state block like any other turn and may well decide there is
 * nothing worth saying. **Nothing enters `computeInsights`**, so Home's brief is
 * byte-identical on a seam day, the uncached `Signals:` line does not move, and
 * `get_insights` returns what it returned before. A `timezone-changed` insight
 * with a `kind` the brief excludes was considered and rejected: the precedent
 * exists, but it widens `InsightKind` for something that is not an insight and
 * still lands in a read tool. This is a second source in a function that already
 * returns a sorted list of ids.
 *
 * **Keyed on the ROW ID, not the date**, and that is what makes it fire once per
 * seam rather than once per marked day. A change that crossed the day boundary
 * marks TWO days and both of them see the same id; `markPassRan` stores it on
 * the first, so the second does not re-fire. Once per seam by construction, with
 * no bookkeeping of its own.
 *
 * Reading the row — not the observer's return value — is also what makes the
 * ordering in `app/_layout.tsx` soft: if a resume ever read this before
 * `onForeground` wrote, the landing turn fires on the next foreground instead of
 * never.
 */
export function currentSignals(db: Database, now: Date): string[] {
  const today = todayISODate(now);
  const landings = timezoneChangesOn(db, today).map((row) => `timezone-changed:${row.id}`);
  return [
    ...computeInsights(db, now)
      .filter((insight) => insight.tone === 'watch')
      .map((insight) => insight.id),
    ...landings,
  ].sort();
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
  // lastDate only ever advances, never regresses. duePass leaves a stored date
  // "ahead" of today alone so a rolled-back clock cannot re-fire the daily pass;
  // writing today unconditionally here would defeat that — a signal pass that
  // ran after westbound date-line travel would overwrite the future date with an
  // earlier one, and the daily pass would fire a second time once the clock
  // caught back up. `forwardCursor` is that guard, and it is now the app's only
  // copy of it (src/lib/db/date.ts). seenSignals is always the current set: a
  // signal weighed and set aside must not re-trigger regardless of which date
  // wins.
  const today = todayISODate(now);
  const lastDate = forwardCursor(getPassState(db).lastDate, today);
  setPassState(db, { lastDate, seenSignals: currentSignals(db, now) });
}
