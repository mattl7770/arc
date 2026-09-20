/**
 * **The run of days between two seams** — the one thing D4 could not see
 * (docs/spikes/timezone-handling-intelligent.md §3a, owner's Q1(a)).
 *
 * 0053 records one row per observed zone change and marks the SEAM days. On a
 * nine-day trip, out on the 12th and back on the 21st, the 13th–20th are
 * ordinary London days and nothing treats them differently from a Tuesday at
 * home. Correct for the mission and the nutrition verdict. Wrong for readiness:
 * for a month after the return the 30-day window holds eight jet-lagged days
 * with no marker, so the home baseline is dragged down and post-trip mornings
 * read `optimal` against a depressed mean. That is the silent one, and a TRIP
 * is what it takes to see it.
 *
 * ## Derived, never stored
 *
 * A trip is a READ-TIME VIEW over the `timezone_changes` rows and the declared
 * Traveling windows. A `trips` table was rejected for the reason 0053 rejected
 * its `kind` column: it would be a second source of truth, and the first thing
 * that happens to a second source of truth is that it disagrees.
 *
 * Everything here is pure over values that are passed in — the same shape as
 * classify.ts and for the same reason. **Nothing in this file reads the clock or
 * the device's zone**, and that is load-bearing rather than tidy: `zoneProbe`
 * answers for the zone the phone is standing in NOW, so a close rule that read
 * it would give a different answer for the same trip depending on where it was
 * asked from. The record screens read PAST windows. An answer that moves with
 * the reader is precisely the defect the trip exists to remove, which is why the
 * arrival zone's seasonal pair is OBSERVED at write time and stored on the row
 * (migration 0060) instead.
 */
import { daysBetween } from '@/lib/protocols/cadence';
import { shiftISODate } from '@/lib/db/date';

/**
 * How many days somewhere ARC will call a trip before it calls it home.
 *
 * This is a constant that decides which days count as normal, and the spike
 * holds it to the same standard it used to reject "exclude the first
 * min(shift hours, 5) days after each seam": that one encodes **how fast this
 * body adapts**, which is the model's domain and never a hardcoded rule. This
 * one encodes **where ARC says home is** when the rows alone cannot tell a long
 * stay from a move — a definition ARC must pick in order to compute anything at
 * all, in the family of `BASELINE_WINDOW_DAYS = 30` deciding what "recent"
 * means, not of the Coach's 5-day horizon, which only gates what the model is
 * told.
 *
 * Two failures a rows-only rule cannot otherwise escape, and this is what fixes
 * both:
 *
 *   - **The first row ARC ever writes can be INBOUND.** `observeTimezone` writes
 *     the cursor and no row on its first observation, so a build first launched
 *     abroad — or a database restored abroad — makes its first row a return leg,
 *     which opens a trip whose home is the FOREIGN offset and, without this
 *     rule, never closes.
 *   - **A relocation followed by a later trip.** The move opens a trip whose
 *     home is the old city, and every later trip is a leg of it, forever.
 *
 * Both self-heal on day 22, and the next trip opens against the new home.
 *
 * The cost is stated rather than hidden: for those 21 days home days are
 * excluded from the baselines and the Coach is told "away" at home, and a stay
 * longer than three weeks is called home from day 22, which is a guess. The
 * declared Traveling window is the immediate correction for both.
 *
 * A stillness-closed trip therefore has exactly this many away days, numbered
 * 1…21, and day 22 is the first day home.
 */
export const TRIP_SETTLE_DAYS = 21;

/**
 * One `timezone_changes` row, as the derivation needs it — 0053's columns plus
 * 0060's pair. The pair is `null` on every row written before that migration,
 * and `null` means *"this row cannot answer the seasonal question"*.
 */
export type TripSeamRow = {
  id: string;
  from_offset_min: number;
  to_offset_min: number;
  from_local_date: string;
  to_local_date: string;
  zone_jan_offset_min: number | null;
  zone_jul_offset_min: number | null;
};

/**
 * A declared Traveling window — a `day_modes` row with `mode = 'travel'` and an
 * `end_date`. An OPEN-ENDED window is deliberately not one of these: it says
 * "I am travelling", which is not the statement this file needs. Only *"I am
 * back on this date"* can close a trip.
 */
export type TravelWindow = { start: string; end: string };

/** Why a trip stopped. `null` while it is still open. */
export type TripClose = 'return' | 'declaration' | 'settled';

export type Trip = {
  /** The id of the row that opened it — stable, and what a signal can key on. */
  openedBy: string;
  /** Minutes east of UTC the trip is measured against: the opening row's `from`. */
  homeOffsetMin: number;
  /** The offset in force at the latest seam — where the body is now. */
  offsetMin: number;
  /** The day the trip left on: the opening row's ARRIVAL day. Not an away day. */
  startedOn: string;
  /** The latest seam inside the trip — the opening row's, or a leg's. */
  latestSeamOn: string;
  /**
   * The first day that is NOT in the trip, or `null` while it is open. A
   * half-open interval, so `startedOn < away < closedOn` is the whole rule.
   */
  closedOn: string | null;
  closedBy: TripClose | null;
  /**
   * The days strictly inside the trip, oldest first. Empty for a trip that
   * opened and closed on consecutive days — which is a true statement about a
   * day trip, not a degenerate case.
   *
   * For an OPEN trip this runs to `today` and no further: ARC does not claim
   * days that have not happened.
   */
  awayDays: string[];
};

/** Is this row's arrival a return to `homeOffsetMin`? */
function arrivesHome(row: TripSeamRow, homeOffsetMin: number): boolean {
  // The plain case, and the only one a pre-0060 row can answer.
  if (row.to_offset_min === homeOffsetMin) return true;

  const jan = row.zone_jan_offset_min;
  const jul = row.zone_jul_offset_min;
  // No pair (a 0053 row), or an arrival zone that does not shift at all: exact
  // equality is the whole test, which is 0053's own behaviour.
  if (jan === null || jul === null || jan === jul) return false;

  // The arrival zone observes DST and counts the home offset among its two
  // seasonal offsets — a trip that left Los Angeles in PST and returned in PDT
  // HAS come home, and an exact test would hold it open for another three weeks.
  // The pair is UNORDERED: the southern hemisphere puts DST in January, so
  // neither of the two is "the standard one".
  return homeOffsetMin === jan || homeOffsetMin === jul;
}

/** The day a change ARRIVES on — the later of its two marked days. */
function arrivalDay(row: TripSeamRow): string {
  return row.to_local_date > row.from_local_date ? row.to_local_date : row.from_local_date;
}

/** The day a change LEAVES on — the earlier of its two marked days. */
function departureDay(row: TripSeamRow): string {
  return row.from_local_date < row.to_local_date ? row.from_local_date : row.to_local_date;
}

/** Every day strictly between two bounds, `after` exclusive and `before` exclusive. */
function daysStrictlyBetween(after: string, before: string): string[] {
  const days: string[] = [];
  for (let day = shiftISODate(after, 1); day < before; day = shiftISODate(day, 1)) {
    days.push(day);
  }
  return days;
}

type OpenTrip = {
  openedBy: string;
  homeOffsetMin: number;
  offsetMin: number;
  startedOn: string;
  latestSeamOn: string;
};

/**
 * The earliest declared *"I am back"* that could close a trip which started on
 * `startedOn` — the day AFTER the window's `end`, because the window's last day
 * is still a day away.
 *
 * A window that ended before the trip began belongs to an earlier trip and is
 * ignored; that is the whole overlap test, since an open trip has no end to
 * compare against.
 */
function declaredCloseFor(startedOn: string, windows: TravelWindow[]): string | null {
  let earliest: string | null = null;
  for (const window of windows) {
    if (window.end < startedOn) continue;
    const close = shiftISODate(window.end, 1);
    if (earliest === null || close < earliest) earliest = close;
  }
  return earliest;
}

/** The day a trip stops being a trip by stillness alone. */
function settledCloseFor(latestSeamOn: string): string {
  // Away days are numbered 1…TRIP_SETTLE_DAYS from the latest seam, so the trip
  // closes on the day after the last of them — day 22 is the first day home.
  return shiftISODate(latestSeamOn, TRIP_SETTLE_DAYS + 1);
}

/**
 * Derive every trip visible in these rows.
 *
 * ## The walk
 *
 * Rows are walked UNBOUNDED, oldest first — every row ARC has, not a window's
 * worth. A trip that opened before a consumer's 30-day window still has to be
 * seen, or the days inside the window would read as home.
 *
 * > A trip **opens** at any change while no trip is open; its home offset `H` is
 * > that row's `from_offset_min`. Every later row is a **leg**. It **closes** at
 * > the earliest of three things: a row that {@link arrivesHome}; the day after
 * > a declared Traveling window's end; or {@link TRIP_SETTLE_DAYS} days of
 * > stillness after its latest seam.
 *
 * **The row that opens a trip is never tested as its close**, and that is the
 * load-bearing line in this function rather than an implementation detail.
 * Home Phoenix (UTC−7 all year) → Los Angeles in winter is a real outbound leg
 * whose arrival zone's pair is `{−480, −420}` and which therefore *contains* the
 * home offset: tested as a close, it would shut the trip on its own outbound
 * flight and no day of it would ever be away. The walk opens on that row and
 * begins testing at the next one.
 *
 * Where a declaration and a return row disagree, **the earlier close wins** — a
 * return row is a fact, and a later `until` simply ran over. A declaration can
 * only ever CLOSE a trip and never open one: a Traveling window with no row
 * behind it (Los Angeles → Seattle, or a trip ARC never observed because the app
 * was not opened abroad) produces no away days at all, because "away" here means
 * the body is under another offset, which is what readiness's exclusion is about.
 *
 * `H` re-seating after a settled trip needs no code: the next row's
 * `from_offset_min` IS the settled offset, because nothing changed in between.
 */
export function deriveTrips(input: {
  /** Every row, ordered by `changed_at, rowid`. */
  rows: TripSeamRow[];
  /** Declared Traveling windows that have an end. */
  travelWindows: TravelWindow[];
  /** Today, so an open trip does not claim days that have not happened. */
  today: string;
}): Trip[] {
  const { rows, travelWindows, today } = input;
  const trips: Trip[] = [];
  let open: OpenTrip | null = null;

  const finish = (trip: OpenTrip, closedOn: string | null, closedBy: TripClose | null): void => {
    const last = closedOn === null ? shiftISODate(today, 1) : closedOn;
    trips.push({
      openedBy: trip.openedBy,
      homeOffsetMin: trip.homeOffsetMin,
      offsetMin: trip.offsetMin,
      startedOn: trip.startedOn,
      latestSeamOn: trip.latestSeamOn,
      closedOn,
      closedBy,
      awayDays: daysStrictlyBetween(trip.startedOn, last),
    });
  };

  /** The date an open trip stops on its own, with no further row. Never null. */
  const quietClose = (trip: OpenTrip): { on: string; by: TripClose } => {
    const declared = declaredCloseFor(trip.startedOn, travelWindows);
    const settled = settledCloseFor(trip.latestSeamOn);
    return declared !== null && declared < settled
      ? { on: declared, by: 'declaration' }
      : { on: settled, by: 'settled' };
  };

  for (const row of rows) {
    if (open !== null) {
      // A trip can have stopped BEFORE this row — three weeks of stillness, or a
      // window the user closed — in which case this row opens a new one.
      const quiet = quietClose(open);
      if (quiet.on <= departureDay(row)) {
        finish(open, quiet.on, quiet.by);
        open = null;
      }
    }

    if (open === null) {
      open = {
        openedBy: row.id,
        homeOffsetMin: row.from_offset_min,
        offsetMin: row.to_offset_min,
        startedOn: arrivalDay(row),
        latestSeamOn: arrivalDay(row),
      };
      continue;
    }

    if (arrivesHome(row, open.homeOffsetMin)) {
      finish(open, departureDay(row), 'return');
      open = null;
      continue;
    }

    // A leg. The body moved again without coming home, so the settle clock
    // restarts and the trip's current offset follows.
    open.offsetMin = row.to_offset_min;
    open.latestSeamOn = arrivalDay(row);
  }

  if (open !== null) {
    const quiet = quietClose(open);
    if (quiet.on <= today) finish(open, quiet.on, quiet.by);
    else finish(open, null, null);
  }

  return trips;
}

/** The trip `date` is an away day of, or `null` — the per-day question. */
export function tripOn(trips: Trip[], date: string): Trip | null {
  for (const trip of trips) {
    if (date > trip.startedOn && (trip.closedOn === null || date < trip.closedOn)) return trip;
  }
  return null;
}

/**
 * Which away day of the trip this is — 1 on the first morning abroad.
 *
 * Counted from the trip's START, not from its latest seam: what the number
 * means to a reader is *"how long have I been away"*, and a connecting flight on
 * day three does not reset that. The settle rule counts from the latest seam
 * instead, and deliberately so — three more weeks somewhere new is a new claim
 * about where home is.
 */
export function awayDayNumber(trip: Trip, date: string): number {
  return daysBetween(trip.startedOn, date);
}
