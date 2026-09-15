/**
 * The one place ARC decides **which day an instant belongs to**.
 *
 * ## The rule (B3, the configurable day boundary)
 *
 * A day does not have to start at midnight. The user sets `dayStartsAt` — a
 * local wall-clock `"HH:MM"`, default `"00:00"` — and every "today" in the app
 * is computed from it: an instant whose LOCAL clock reads earlier than the
 * boundary is attributed to the previous calendar day. With a 04:00 boundary a
 * 01:00 snack is yesterday's snack, which is what the owner means by a day.
 *
 * **Only the day attribution changes. Timestamps stay UTC instants.** Nothing
 * here rewrites a `created_at`; a `date` column simply gets a different value
 * for the same moment.
 *
 * ## Three functions, three jobs — do not confuse them
 *
 *  - {@link logicalDate} / {@link todayISODate} — an INSTANT → the day it counts
 *    as. Boundary-aware. This is what "today" means everywhere in ARC.
 *  - {@link formatLocalDate} — a `Date` → its plain local calendar day. NO
 *    boundary. For a `Date` you built out of calendar components, and for the
 *    places that must mirror an outside calendar (Apple Health — see the seam
 *    note in src/lib/health/sync.ts).
 *  - {@link shiftISODate} — `YYYY-MM-DD` ± n days. Pure calendar arithmetic over
 *    a day that has already been attributed; the boundary has nothing to say.
 *
 * Passing a constructed local-midnight `Date` to {@link todayISODate} would be a
 * bug under a 04:00 boundary (00:00 < 04:00, so it would answer with the day
 * before). That is why the plain formatter is its own exported function rather
 * than a flag on this one.
 *
 * ## DST
 *
 * All boundary maths runs on LOCAL wall-clock COMPONENTS, never by subtracting
 * milliseconds. Offsetting the instant by four hours and re-reading it gets
 * spring-forward wrong: 04:30 EDT on the US change day minus 4h lands at 23:30
 * EST the previous evening, so a 04:30 breakfast would be filed as yesterday.
 * Comparing `hours*60 + minutes` against the boundary cannot make that mistake —
 * a wall clock is a wall clock whether the day runs 23, 24 or 25 hours. Day
 * arithmetic goes through the `Date` constructor anchored at NOON (12:00 exists
 * in every zone; local midnight does not, in zones that shift at midnight), so
 * month ends, leap days and year rollover fall out for free.
 *
 * ## Timezone (the D4 seam)
 *
 * The boundary is a LOCAL-clock rule: it reads the device's wall clock and says
 * nothing about which zone that clock is in. `users.timezone` is stored but
 * deliberately not consulted here. D4 (automatic timezone handling) builds on
 * top of this rule — it will resolve `instant → wall clock in zone Z` and feed
 * that into the one comparison in {@link logicalDate}. Every call site in the
 * app already routes through these functions, so D4 is a change to this file
 * rather than to the app.
 *
 * ## The ambient boundary
 *
 * `dayStartsAt` is a user preference in the database, and `todayISODate()` is
 * called from ~170 places, most with no database handle in scope (pure
 * formatters, view helpers). So the preference is cached HERE: installed once by
 * {@link setDayStartsAt} when the database opens (src/lib/db/client.ts) and again
 * whenever the user changes it in Settings. Every function below still takes the
 * boundary as an explicit last argument, and that pure two-argument form is what
 * the tests exercise (db/day-boundary.test.mjs); the cached default is only how
 * the app avoids threading one preference through the entire call graph.
 */

/** The default: a day starts at calendar midnight, exactly as ARC always did. */
export const DEFAULT_DAY_STARTS_AT = '00:00';

/**
 * The installed boundary. Module-level and mutable on purpose — see the
 * "ambient boundary" note above. Starts at the default, so anything that runs
 * before the database opens (and every headless test) behaves as it always has.
 */
let installedDayStartsAt: string = DEFAULT_DAY_STARTS_AT;

/**
 * `"HH:MM"` → minutes past local midnight, or `null` when it is not a real
 * clock time. Strict: the schema's own time columns are `HH:MM` guarded by a
 * GLOB CHECK, and a boundary that quietly became `NaN` would file every entry
 * under the wrong day.
 */
function boundaryMinutes(dayStartsAt: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(dayStartsAt);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Any stored or typed value → a usable `"HH:MM"`, falling back to the default.
 * A corrupt preferences blob reads as midnight rather than throwing at the top
 * of every screen.
 */
export function normalizeDayStartsAt(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_DAY_STARTS_AT;
  return boundaryMinutes(value) === null ? DEFAULT_DAY_STARTS_AT : value;
}

/** Install the user's boundary for every later call that passes none. */
export function setDayStartsAt(value: unknown): void {
  installedDayStartsAt = normalizeDayStartsAt(value);
}

/** The currently installed boundary (`"HH:MM"`). */
export function getDayStartsAt(): string {
  return installedDayStartsAt;
}

/**
 * The boundary as **minutes past local midnight** — 0 for `"00:00"`, 240 for
 * `"04:00"`. A junk value reads as midnight, exactly as every other reader in
 * this file treats it.
 *
 * Exported so that anything measuring *how far into the day* an instant is —
 * the nutrition pace curve in src/lib/home/readiness.ts — parses the boundary
 * with the same function that files a row under a day, rather than re-splitting
 * the string on its own.
 */
export function dayStartMinutes(dayStartsAt: string = installedDayStartsAt): number {
  return boundaryMinutes(dayStartsAt) ?? 0;
}

/**
 * A `Date` → its LOCAL calendar day as `YYYY-MM-DD`. Plain formatting: no
 * boundary is applied, so this is the right function for a `Date` built out of
 * calendar components and the wrong one for "what day is it now".
 */
export function formatLocalDate(at: Date): string {
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The LOGICAL day an instant belongs to, as `YYYY-MM-DD` — the answer to
 * "which day does this count as" everywhere in ARC.
 *
 * With the default `"00:00"` this is the local calendar day and nothing about
 * ARC's behaviour changes. With `"04:00"`, local 03:59 is yesterday and local
 * 04:01 is today.
 *
 * **Existing rows are never rewritten when the boundary moves.** A stored `date`
 * is the day that entry was filed under when it happened; re-attributing history
 * would silently move meals between days and re-judge closed missions. The
 * Settings control says so in as many words.
 */
export function logicalDate(instant: Date, dayStartsAt: string = installedDayStartsAt): string {
  const boundary = boundaryMinutes(dayStartsAt) ?? 0;
  const clock = instant.getHours() * 60 + instant.getMinutes();
  if (clock >= boundary) return formatLocalDate(instant);
  // Before the boundary: the previous calendar day. Noon-anchored so the
  // constructed Date exists in every zone (see the DST note in the header).
  return formatLocalDate(
    new Date(instant.getFullYear(), instant.getMonth(), instant.getDate() - 1, 12, 0, 0, 0)
  );
}

/**
 * "Today" — the logical day `now` falls in, and the spelling every call site in
 * the app already uses, which is how the boundary reached all of them without a
 * 170-file diff.
 *
 * Identical to {@link logicalDate} today. Both names are kept because they ask
 * different questions: this one is "what day is it", which is the question a
 * screen has; `logicalDate` is "what day does this instant count as", which is
 * the question a stored row has.
 */
export function todayISODate(
  now: Date = new Date(),
  dayStartsAt: string = installedDayStartsAt
): string {
  return logicalDate(now, dayStartsAt);
}

/**
 * `YYYY-MM-DD` shifted by `delta` days on the local calendar. Pure arithmetic
 * over a day that has already been attributed — the boundary has no say.
 * Componentwise (never `new Date('YYYY-MM-DD')`, which some runtimes read as UTC
 * midnight and would shift the day west of Greenwich) and noon-anchored, so
 * month ends, leap days and DST all fall out of the `Date` constructor.
 */
export function shiftISODate(date: string, delta: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return formatLocalDate(new Date(y, m - 1, d + delta, 12, 0, 0, 0));
}

/**
 * The UTC instant range `[startUtc, endUtc)` covering the LOGICAL day `now`
 * falls in — from the boundary on that day to the boundary on the next. Tables
 * keyed by a `date` column (daily_logs, wearable_data) filter on that column
 * directly; `body_metrics` only stores a UTC `measured_at`, so it is filtered
 * against these bounds instead of relying on SQLite's `'localtime'` modifier
 * (which would read the machine timezone and make the headless tests
 * non-deterministic).
 *
 * Both ends are built from local wall-clock components, so on a DST-change day
 * the window is correctly 23 or 25 hours long rather than a fixed 86,400,000 ms.
 */
export function localDayUtcRange(
  now: Date = new Date(),
  dayStartsAt: string = installedDayStartsAt
): { startUtc: string; endUtc: string } {
  const boundary = boundaryMinutes(dayStartsAt) ?? 0;
  const hours = Math.floor(boundary / 60);
  const minutes = boundary % 60;
  const [y, m, d] = logicalDate(now, dayStartsAt).split('-').map(Number) as [
    number,
    number,
    number,
  ];
  const start = new Date(y, m - 1, d, hours, minutes, 0, 0);
  const end = new Date(y, m - 1, d + 1, hours, minutes, 0, 0);
  return { startUtc: start.toISOString(), endUtc: end.toISOString() };
}

/**
 * The Monday-start LOCAL calendar week containing the LOGICAL today, as
 * inclusive `YYYY-MM-DD` bounds — the single definition of "this week" across
 * the app. Consumed by the Exercise screen, the Data tab (via weekSummary) and
 * the Coach (get_training_summary) so all three agree; built on the logical day
 * so a 01:00 Monday session lands in the week the user counts it in.
 */
export function localWeekRange(
  now: Date = new Date(),
  dayStartsAt: string = installedDayStartsAt
): { start: string; end: string } {
  const today = logicalDate(now, dayStartsAt);
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const sinceMonday = (new Date(y, m - 1, d, 12, 0, 0, 0).getDay() + 6) % 7; // getDay: 0 = Sunday
  return { start: shiftISODate(today, -sinceMonday), end: shiftISODate(today, 6 - sinceMonday) };
}

/**
 * The last `count` LOCAL calendar days ending at `end` (inclusive), oldest →
 * newest, as an explicit `YYYY-MM-DD` list — so a rolling-N series always yields
 * exactly `count` points regardless of data sparsity. `end` is a day that has
 * already been attributed, so this is calendar arithmetic and takes no boundary.
 * The single definition of a rolling-N-day window (nutrition/symptoms trends,
 * Coach series).
 */
export function localDaysList(end: string, count: number): string[] {
  const dates: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    dates.push(shiftISODate(end, -i));
  }
  return dates;
}

/**
 * The forward-most of a stored cursor and what the clock says now — the app's
 * **one** guard against a device clock that has moved BACKWARDS.
 *
 * ## Why this exists
 *
 * A westbound flight across the date line rolls the local clock back, and
 * {@link todayISODate} answers with **yesterday**. Every subsystem that carries
 * a "last seen day" then has a choice, and three of them made it independently:
 *
 *  - `src/lib/ai/pass-schedule.ts` kept the later of stored and today, so a
 *    signal pass after westbound travel could not rewind the daily-pass cursor
 *    and fire the day's pass a second time;
 *  - `src/lib/backup/snapshot.ts` treated a non-positive age as due, so a stamp
 *    sitting in the future could not read as "not due" for as long as the skew
 *    lasted;
 *  - `src/hooks/use-today-mission.ts` made the **same** comparison with **no**
 *    guard, so the day the user is looking at could flicker backwards and work
 *    done in the brief "tomorrow" went out of view.
 *
 * Two hand-patches and one hole is the argument for one function. It lives here
 * because this file is already the single home of "what day is it", and the D4
 * timezone work builds its monotonic-write rule on exactly this comparison
 * (docs/spikes/timezone-days.md §4).
 *
 * ## The rule
 *
 * The cursor may **skip** a date — eastbound over the date line genuinely
 * misses one — but it never goes backwards. The cost is deliberate and worth
 * naming: a clock set wrongly far ahead and then corrected leaves the cursor
 * parked on the wrong day until the calendar catches up. That is the trade
 * `pass-schedule.ts` already accepted, and losing a day of history to a clock
 * that lied is worse than waiting for it.
 *
 * ## Shape
 *
 * Generic over `string` and `number` because the two things ARC cursors are a
 * `YYYY-MM-DD` (which sorts chronologically as text — the whole reason the
 * schema stores dates that way) and an epoch-millisecond stamp. Comparing
 * `forwardCursor(marker, now) !== now` is the idiom for *"the clock has moved
 * backwards since `marker` was written"*.
 */
export function forwardCursor<T extends string | number>(stored: T | null | undefined, now: T): T {
  return stored != null && stored > now ? stored : now;
}

/** Local wall-clock "HH:MM" for an ISO-8601 UTC instant — the Log feed's time column. */
export function clockFromISO(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
