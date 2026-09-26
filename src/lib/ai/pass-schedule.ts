/**
 * WHEN the coach pass runs — the deterministic half of proactivity.
 *
 * This module decides only whether to wake the model, never what it should
 * conclude. Three triggers:
 *
 *   DAILY — once per calendar day, on first app open. Bounded by a stored
 *   date, so re-opening the app ten times costs one pass.
 *
 *   EVENING — the first open after {@link EVENING_FROM} (0064, owner's Q4), when
 *   Coach nudges are on. The last look before tomorrow, so the pass that can
 *   plan tomorrow's notifications. It is also the day's look when it is the
 *   day's first open, so an evening-only day costs one pass, not two.
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
import { forwardCursor, getDayStartsAt, todayISODate } from '@/lib/db/date';
import { getNudgeSettings } from '@/lib/db/repositories/coach-nudges';
import { timezoneChangesOn } from '@/lib/db/repositories/day-meta';
import { getOrCreateUser } from '@/lib/db/repositories/user';
import { clockOf } from '@/lib/notifications/nudge-plan';

import { computeInsights } from './insights';
import type { PassTrigger } from './coach-pass';

export type PassState = {
  /** YYYY-MM-DD of the last pass of any kind. */
  lastDate: string | null;
  /** Insight ids present at the last pass — the attention router's memory. */
  seenSignals: string[];
  /** The logical day of the last EVENING pass (0064). */
  lastEvening: string | null;
  /**
   * The logical day a pass last SPOKE (a silent one leaves it). The morning
   * check-in reads it: a tap after the day's note was written shows that note
   * rather than paying for a second one.
   */
  lastSpoke: string | null;
  /**
   * Check-ins already answered today, as `<key>@<day>` — `morning@2026-09-26`,
   * `reminder:<id>@2026-09-26`. A tap replayed by a relaunch, or tapped twice,
   * is answered once. Only today's are kept.
   */
  checkins: string[];
};

const EMPTY: PassState = {
  lastDate: null,
  seenSignals: [],
  lastEvening: null,
  lastSpoke: null,
  checkins: [],
};

/** The evening pass is the first open at or after this wall-clock time. */
export const EVENING_FROM = '18:00';

/**
 * Is it the evening of the logical day? At or after {@link EVENING_FROM}, or in
 * the small hours before a late day boundary — 01:00 under an 04:00 boundary
 * is still the evening of the day it belongs to. Under the default midnight
 * boundary that second case never arises.
 */
export function isEveningAt(now: Date, dayStartsAt: string = getDayStartsAt()): boolean {
  const clock = clockOf(now);
  if (clock >= EVENING_FROM) return true;
  return dayStartsAt !== '00:00' && clock < dayStartsAt;
}

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
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];
  return {
    lastDate: typeof record.lastDate === 'string' ? record.lastDate : null,
    seenSignals: strings(record.seenSignals),
    lastEvening: typeof record.lastEvening === 'string' ? record.lastEvening : null,
    lastSpoke: typeof record.lastSpoke === 'string' ? record.lastSpoke : null,
    checkins: strings(record.checkins),
  };
}

export function setPassState(db: Database, state: Partial<PassState>): void {
  const user = getOrCreateUser(db);
  const preferences = parsePreferences(user.preferences);
  preferences.coachPass = { ...EMPTY, ...state };
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

  // The evening look comes first: on a day whose FIRST open is after 18:00 it
  // is also the day's look (markPassRan stamps both), so one pass, not two.
  // Only while nudges are on — planning tomorrow's is what it is for, and the
  // owner's Q4 bought it for that. Same rolled-back-clock rule as lastDate.
  if (
    getNudgeSettings(db).enabled &&
    isEveningAt(now) &&
    (state.lastEvening === null || state.lastEvening < today)
  ) {
    return { kind: 'checkin', part: 'evening' };
  }

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
export function markPassRan(
  db: Database,
  now: Date = new Date(),
  what: { evening?: boolean; spoke?: boolean } = {}
): void {
  // lastDate only ever advances, never regresses. duePass leaves a stored date
  // "ahead" of today alone so a rolled-back clock cannot re-fire the daily pass;
  // writing today unconditionally here would defeat that — a signal pass that
  // ran after westbound date-line travel would overwrite the future date with an
  // earlier one, and the daily pass would fire a second time once the clock
  // caught back up. `forwardCursor` is that guard, and it is now the app's only
  // copy of it (src/lib/db/date.ts). seenSignals is always the current set: a
  // signal weighed and set aside must not re-trigger regardless of which date
  // wins.
  //
  // The evening pass stamps lastEvening with the same forward-only cursor, and
  // a pass that spoke stamps lastSpoke (the morning check-in reads it).
  const today = todayISODate(now);
  const state = getPassState(db);
  setPassState(db, {
    ...state,
    lastDate: forwardCursor(state.lastDate, today),
    seenSignals: currentSignals(db, now),
    lastEvening: what.evening ? forwardCursor(state.lastEvening, today) : state.lastEvening,
    lastSpoke: what.spoke ? forwardCursor(state.lastSpoke, today) : state.lastSpoke,
  });
}

/** The key a check-in is answered under — see {@link PassState.checkins}. */
export function checkinKey(kind: 'morning' | { reminderId: string }, today: string): string {
  return kind === 'morning' ? `morning@${today}` : `reminder:${kind.reminderId}@${today}`;
}

/** Has this check-in already been answered today? */
export function checkinAnswered(db: Database, key: string): boolean {
  return getPassState(db).checkins.includes(key);
}

/** Record a check-in as answered, dropping any key from an earlier day. */
export function recordCheckin(db: Database, key: string, now: Date = new Date()): void {
  const today = todayISODate(now);
  const state = getPassState(db);
  const kept = state.checkins.filter((k) => k.endsWith(`@${today}`) && k !== key);
  setPassState(db, { ...state, checkins: [...kept, key] });
}
