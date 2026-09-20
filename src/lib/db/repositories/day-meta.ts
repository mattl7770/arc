/**
 * What ARC knows about a DAY that is not a measurement of the user — currently
 * one fact: the device's timezone changed on it (backlog **D4**, migration
 * 0053, design in docs/spikes/timezone-days.md).
 *
 * The owner's three calls, settled 2026-09-14:
 *
 *   1. **Annotate, never re-attribute.** Every stored `date` keeps the local day
 *      it was logged in. A meal at 23:30 in London was eaten at 23:30 in London;
 *      rewriting it to 14:30 "at home" would invent a moment the user never
 *      lived through, and would disagree with the `time` column beside it. The
 *      one place ARC already re-attributes — the health sync re-bucketing a
 *      fortnight of samples under the new zone (spike §1c) — is the bug, not the
 *      model, and it stays out of scope here.
 *   2. **The day is EXCUSED** for its missed mission items, through the existing
 *      `excusesSkips` machinery — and **without setting a mode**. ARC cannot
 *      tell a flight from a Settings change, and Travel mode reshapes the plan
 *      and the Coach's tone, which is the user's decision to make.
 *   3. **The nutrition verdict goes quiet** on it ({@link isTimezoneChangedDay}
 *      is the predicate readiness.ts reads; C7 owns the verdict itself).
 *
 * The **second pass** (2026-09-19, migration 0060, docs/spikes/timezone-handling-
 * intelligent.md) changes none of that and adds the one thing D4 could not see:
 * the run of days BETWEEN two seams. A trip is derived from these same rows
 * ({@link allTrips}), its away days are barred from the readiness baselines, and
 * one fact per row — the arrival zone's seasonal pair — is now kept so the
 * derivation never has to ask where the phone is standing.
 *
 * Pure over the {@link Database} interface — headless-tested in
 * db/timezone.test.mjs. The classification brain is separate and value-only
 * (src/lib/timezone/classify.ts), and so is the trip derivation
 * (src/lib/timezone/trips.ts), so the suite never depends on the host's zone.
 */
import type { Database } from '../database';
import { shiftISODate, todayISODate } from '../date';
import { newId } from '../id';
import {
  classifyOffsetChange,
  dayLengthHours,
  formatDayLength,
  formatOffsetChange,
  isPlausibleOffset,
  offsetEastMinutes,
  zoneProbe,
} from '@/lib/timezone/classify';
import { deriveTrips, tripOn, type Trip } from '@/lib/timezone/trips';

import { getTimezoneCursor, setTimezoneCursor } from './user';

export type TimezoneChangeRow = {
  id: string;
  changed_at: string;
  from_offset_min: number;
  to_offset_min: number;
  from_local_date: string;
  to_local_date: string;
  /**
   * The ARRIVAL zone's January and July offsets (0060) — `zoneProbe`'s answer at
   * the instant of the write, kept instead of discarded. `null` on every row
   * 0053 wrote, and unrecoverable for those: the probe reads the device's
   * CURRENT zone, so it cannot be taken again later for a zone the phone has
   * left. A null pair means the trip derivation falls back to exact equality.
   */
  zone_jan_offset_min: number | null;
  zone_jul_offset_min: number | null;
};

/**
 * How many days after a change the Coach is still told about it — jet lag's
 * practical horizon is roughly a day per hour of shift, and past that the line
 * is noise on every turn forever. The fact stays in the record either way.
 */
export const TIMEZONE_COACH_HORIZON_DAYS = 5;

/**
 * Sample the device's offset; record a zone change if there is one.
 *
 * Returns the row it wrote, or `null` — which is the overwhelmingly common
 * answer and covers three different cases, all of them correct:
 *
 *   - the offset is unchanged (every observation but a handful a year);
 *   - this is the FIRST observation on this install, so the cursor is written
 *     and no row is: a change needs a before, and there isn't one;
 *   - the change was DST, which moves the cursor and marks nothing (0053's
 *     header argues why no row is better than a filtered one).
 *
 * ## Where this is called from, and where it must not be
 *
 * Two sites, both of them an app FOREGROUND: `getDb()` (the first database open
 * of a launch) and the `AppState 'change' → 'active'` listener in
 * `app/_layout.tsx`, beside the health sync and the backup for the same reason
 * — a phone that changed zone gets foregrounded within minutes of landing.
 *
 * **Not on every write.** Reading the offset is free; recording it is a database
 * write, and writes happen in loops (a 14-day health pass writes hundreds of
 * `wearable_data` rows). One observation per foreground is enough: a change
 * nobody was awake to see is caught the next time the app opens, and what gets
 * recorded is the change, not the observation.
 *
 * **And `todayISODate()` stays pure.** It is called from ~170 sites and is on
 * the render path of every screen; it must never acquire a side effect.
 *
 * Fails quiet on a junk offset rather than writing a row the 0053 CHECK would
 * reject: a plausibility guard here turns a hostile clock into one silent
 * no-op, where an exception would come out of the app's boot path.
 */
export function observeTimezone(db: Database, now: Date = new Date()): TimezoneChangeRow | null {
  const current = offsetEastMinutes(now);
  if (!isPlausibleOffset(current)) return null;

  const previous = getTimezoneCursor(db);
  if (previous === current) return null;

  // The cursor moves for every observation that got this far — a DST change
  // included. Not moving it would re-classify the same change on every single
  // foreground for the rest of the season.
  setTimezoneCursor(db, current);
  if (previous === null || !isPlausibleOffset(previous)) return null;

  // The probe reads the device's CURRENT zone, which is the zone it is in after
  // the change — exactly the pair the DST test needs (classify.ts §2c), and
  // exactly the pair the trip's close-on-return test needs three weeks later.
  const probe = zoneProbe(now.getFullYear());
  const change = classifyOffsetChange({
    fromOffsetMin: previous,
    toOffsetMin: current,
    at: now,
    ...probe,
  });
  if (change.kind === 'dst') return null;

  const id = newId(db);
  // The probe is SPREAD into the classifier above and STORED here (0060). It is
  // the one fact about a change that cannot be recovered afterwards: the zone it
  // describes is the one the phone is standing in at this instant, and by the
  // time a reader asks whether a later row came home, the phone is somewhere
  // else. Writing it is what makes the trip's close read-time independent.
  // Guarded, so a hostile clock cannot fail the 0060 CHECK and take the insert
  // down with it — an unstorable probe is simply not stored, and the row then
  // behaves as a 0053 row does.
  const storable =
    isPlausibleOffset(probe.januaryOffsetMin) && isPlausibleOffset(probe.julyOffsetMin);
  db.run(
    `INSERT INTO timezone_changes
       (id, changed_at, from_offset_min, to_offset_min, from_local_date, to_local_date,
        zone_jan_offset_min, zone_jul_offset_min)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      now.toISOString(),
      previous,
      current,
      change.fromLocalDate,
      change.toLocalDate,
      storable ? probe.januaryOffsetMin : null,
      storable ? probe.julyOffsetMin : null,
    ]
  );
  return db.get<TimezoneChangeRow>('SELECT * FROM timezone_changes WHERE id = ?', [id]) ?? null;
}

/**
 * **The predicate.** Did the device's timezone change on this day?
 *
 * This is the seam C7 named for the nutrition verdict, and the same answer
 * readiness's baselines and the mission ledger read. A day is marked if it is
 * either side of a change's seam — the day the change left or the day it
 * arrived in (they are the same day unless the change crossed the boundary).
 */
export function isTimezoneChangedDay(db: Database, date: string): boolean {
  const row = db.get<{ one: number }>(
    `SELECT 1 AS one FROM timezone_changes
      WHERE from_local_date = ? OR to_local_date = ? LIMIT 1`,
    [date, date]
  );
  return row !== undefined;
}

/**
 * Every change that marks `date` — the row form of {@link isTimezoneChangedDay}.
 *
 * The Coach's landing signal is built from this and keys on the row `id`, which
 * is what makes it fire once per SEAM rather than once per marked day: a change
 * that crossed the day boundary marks two days and both of them see the same
 * row, so the pass that runs on the first silences the second.
 */
export function timezoneChangesOn(db: Database, date: string): TimezoneChangeRow[] {
  return db.all<TimezoneChangeRow>(
    `SELECT * FROM timezone_changes
      WHERE from_local_date = ? OR to_local_date = ?
      ORDER BY changed_at, rowid`,
    [date, date]
  );
}

/**
 * Every marked day in the inclusive window `from … to`, as a set.
 *
 * The bulk form of {@link isTimezoneChangedDay}, and the one every window
 * consumer should use: readiness asks about 31 days and the mission ledger about
 * 14, and asking per day would be 31 queries for an answer that is almost always
 * the empty set.
 */
export function timezoneChangedDaysIn(db: Database, from: string, to: string): Set<string> {
  const days = new Set<string>();
  if (to < from) return days;
  for (const row of db.all<{ from_local_date: string; to_local_date: string }>(
    `SELECT from_local_date, to_local_date FROM timezone_changes
      WHERE (from_local_date >= ? AND from_local_date <= ?)
         OR (to_local_date   >= ? AND to_local_date   <= ?)`,
    [from, to, from, to]
  )) {
    // A change that straddles the window edge marks only the day inside it.
    if (row.from_local_date >= from && row.from_local_date <= to) days.add(row.from_local_date);
    if (row.to_local_date >= from && row.to_local_date <= to) days.add(row.to_local_date);
  }
  return days;
}

/**
 * The one line a RECORD states on a marked day — `"Timezone changed (UTC−8 →
 * UTC+1)"`, keyed by day, for the inclusive window.
 *
 * Deliberately the bare fact, with no icon, no exclamation and no "you
 * travelled": a zone change is a fact about the CALENDAR, and the register it
 * belongs in is the one the record already speaks. `signal-*` is not available
 * to it — that palette marks biology, and mode-control.tsx states the firewall
 * in this exact context (*"'today is a travel day' is a fact about the calendar,
 * not about the body"*).
 *
 * Two changes on one day (possible, and vanishingly rare) are stated oldest
 * first, joined — rather than one silently winning.
 */
export function timezoneNotesIn(db: Database, from: string, to: string): Map<string, string> {
  const notes = new Map<string, string>();
  if (to < from) return notes;
  const rows = db.all<TimezoneChangeRow>(
    `SELECT * FROM timezone_changes
      WHERE (from_local_date >= ? AND from_local_date <= ?)
         OR (to_local_date   >= ? AND to_local_date   <= ?)
      ORDER BY changed_at, rowid`,
    [from, to, from, to]
  );
  const add = (date: string, row: TimezoneChangeRow): void => {
    if (date < from || date > to) return;
    const line = `Timezone changed (${formatOffsetChange(row.from_offset_min, row.to_offset_min)})`;
    const existing = notes.get(date);
    notes.set(date, existing === undefined ? line : `${existing} · ${line}`);
  };
  for (const row of rows) {
    add(row.from_local_date, row);
    if (row.to_local_date !== row.from_local_date) add(row.to_local_date, row);
  }
  return notes;
}

/**
 * **Home's line, and only on the day it happens.** `null` on every other day,
 * which is what makes this safe to render unconditionally.
 *
 * *"Timezone changed (UTC−8 → UTC+1). Today is 15 hours long."*
 *
 * Home is sacred — it answers one question (CLAUDE.md §5) — and this earns one
 * day of one line because a 15-hour day genuinely changes what *"do this next"*
 * means, and then it disappears. It spends no accent and no signal colour.
 *
 * The LENGTH clause is stated only when the change did not cross the day
 * boundary, i.e. when this day really is the `24 + Δ`-hour one. When the change
 * crossed, the two marked days split those hours between them and no single
 * number is true of either, so the line stops after the fact.
 */
export function timezoneHomeLine(db: Database, date: string = todayISODate()): string | null {
  const row = db.get<TimezoneChangeRow>(
    `SELECT * FROM timezone_changes
      WHERE from_local_date = ? OR to_local_date = ?
      ORDER BY changed_at, rowid LIMIT 1`,
    [date, date]
  );
  if (!row) return null;
  const fact = `Timezone changed (${formatOffsetChange(row.from_offset_min, row.to_offset_min)})`;
  if (row.from_local_date !== row.to_local_date) return `${fact}.`;
  const hours = dayLengthHours(row.from_offset_min, row.to_offset_min);
  return `${fact}. Today is ${formatDayLength(hours)} long.`;
}

// --- Trips: the run of days between two seams (0060) -------------------------

/**
 * Every trip visible in the record, oldest first.
 *
 * Reads **every** row, not a window's worth, and that is deliberate: a trip that
 * opened before a consumer's 30-day window still has to be seen, or the days
 * inside the window would read as home. At real cardinality — tens of rows a
 * year for a frequent traveller — an unbounded read is the cheap option anyway,
 * and {@link timezoneChangedDaysIn} stays windowed because its question genuinely
 * is per-window.
 *
 * The declared Traveling windows come from `day_modes` (0026) and are read as
 * WINDOWS rather than through the resolved per-day mode: what closes a trip is
 * the statement *"I am back on the 20th"*, which is a property of the row the
 * user wrote, not of whatever later row happens to win a given day. Open-ended
 * travel rows are excluded for the same reason — "I am travelling" is not a
 * return date.
 *
 * Pure derivation past this point: {@link deriveTrips} reads no clock and no
 * zone, so the same rows give the same trips in London and in the headless suite.
 */
export function allTrips(db: Database, today: string = todayISODate()): Trip[] {
  const rows = db.all<TimezoneChangeRow>(
    `SELECT * FROM timezone_changes ORDER BY changed_at, rowid`
  );
  const windows = db.all<{ start_date: string; end_date: string }>(
    `SELECT start_date, end_date FROM day_modes
      WHERE mode = 'travel' AND end_date IS NOT NULL
      ORDER BY start_date, rowid`
  );
  return deriveTrips({
    rows,
    travelWindows: windows.map((w) => ({ start: w.start_date, end: w.end_date })),
    today,
  });
}

/** The trips that put at least one away day inside the inclusive window. */
export function tripsIn(db: Database, from: string, to: string, today?: string): Trip[] {
  if (to < from) return [];
  return allTrips(db, today ?? to).filter((trip) =>
    trip.awayDays.some((day) => day >= from && day <= to)
  );
}

/**
 * The trip `today` is an away day of, or `null` — the question Home and the
 * Coach's state block ask.
 *
 * `null` on a SEAM day: the seam days bound a trip and are not inside it, which
 * is what keeps the Coach from printing two timezone lines on one turn.
 */
export function currentTrip(db: Database, today: string = todayISODate()): Trip | null {
  return tripOn(allTrips(db, today), today);
}

/**
 * The away days in the inclusive window — the set readiness's baselines bar.
 *
 * Distinct from {@link timezoneChangedDaysIn}, and the two are unioned rather
 * than merged: a seam day was not 24 hours long, an away day was a perfectly
 * ordinary 24 hours lived under someone else's sun, and they are barred from a
 * baseline for different reasons. The union lives behind one named helper
 * (src/lib/home/baseline-exclusions.ts) so that nothing downstream grows a
 * second predicate.
 */
export function awayDaysIn(db: Database, from: string, to: string, today?: string): Set<string> {
  const days = new Set<string>();
  if (to < from) return days;
  for (const trip of allTrips(db, today ?? to)) {
    for (const day of trip.awayDays) {
      if (day >= from && day <= to) days.add(day);
    }
  }
  return days;
}

/**
 * The most recent change whose arrival day is within
 * {@link TIMEZONE_COACH_HORIZON_DAYS} of `today` — what the Coach's state block
 * is built from, and `null` once the horizon passes.
 */
export function recentTimezoneChange(
  db: Database,
  today: string = todayISODate()
): TimezoneChangeRow | null {
  const since = shiftISODate(today, -TIMEZONE_COACH_HORIZON_DAYS);
  return (
    db.get<TimezoneChangeRow>(
      `SELECT * FROM timezone_changes
        WHERE to_local_date >= ? AND to_local_date <= ?
        ORDER BY to_local_date DESC, changed_at DESC, rowid DESC
        LIMIT 1`,
      [since, today]
    ) ?? null
  );
}
