/**
 * Screen time — the pure half. What a typed or linked number means, which day
 * it belongs to, and how it prints. No database and no React Native, so the
 * headless suites import it directly (db/log.test.mjs §13–§17).
 *
 * The plan of record is docs/spikes/screen-time.md; what was built, and the
 * Shortcut setup, is docs/screen-time.md. The owner's answers (2026-09-25) set
 * the scope: the number is a Coach input and a line on the daily record; the
 * DAILY TOTAL only; he types it (no screenshot goes to the model); no Family
 * Controls. ARC never touches the Screen Time APIs, so the DPLA §3.3.3(P) limit
 * on sharing their data does not reach this number.
 *
 * ## One number per day, in whole minutes
 *
 * Stored as a `wearable_data` row — `metric_type 'screen_time_min'`,
 * `source_device 'manual'`, unit `min` — the same store `hrv 48` lands in, so
 * no migration. The repository keeps ONE row per day (a second entry replaces
 * the first); see src/lib/db/repositories/screen-time.ts.
 *
 * ## Which day a number belongs to
 *
 * Settings › Screen Time shows TODAY by default, and the number a person reads
 * off it in the morning is YESTERDAY's total, from the week view: today's is a
 * few minutes old and yesterday's is the one that is finished. So:
 *
 *   - **From the start of the day until noon, a typed number is filed to
 *     yesterday.** From noon on, to today.
 *   - "The start of the day" is the user's own boundary (Settings › Profile ›
 *     Day starts at, B3). Under a 04:00 start, 02:00 is still the previous
 *     day's late evening, so a number typed then is filed to that day ("today"
 *     in ARC's terms), not to the day before it.
 *   - Typing `today` or `yesterday` with the number overrides the rule, and the
 *     keypad offers both as chips with the default selected. Every receipt
 *     names the day it filed to, so the rule is never silent.
 *
 * Apple's day runs midnight to midnight. Under a non-midnight boundary the
 * number is still Apple's calendar-day total, filed under the ARC day with the
 * same date; the difference is the few hours either side of the boundary and
 * is stated in docs/screen-time.md rather than corrected for.
 */
import {
  dayStartMinutes,
  formatLocalDate,
  getDayStartsAt,
  shiftISODate,
  todayISODate,
} from '@/lib/db/date';
import { weekdayDate } from '@/lib/protocols/format';

/** The `wearable_data.metric_type` screen time is stored under. */
export const SCREEN_TIME_METRIC = 'screen_time_min';

/**
 * The upper bound, in minutes: one day. Apple's "Share Across Devices" can sum
 * a phone and an iPad past what one person lives in a day, and a total above
 * 24 hours is that or a typo; either way it is not stored.
 */
export const SCREEN_TIME_MAX_MINUTES = 24 * 60;

/** How far back a link may write. Older than this is a shortcut gone wrong. */
export const LINK_MAX_DAYS_BACK = 30;

/**
 * The link a Shortcut opens, with its two placeholders — printed exactly this
 * way in Settings › Screen time and docs/screen-time.md. The route is
 * app/log/screen-time.tsx; `arc` is app.json's scheme, and
 * app/+native-intent.ts passes the path through untouched.
 */
export const SCREEN_TIME_LINK_FORMAT = 'arc://log/screen-time?minutes=N&date=YYYY-MM-DD';

/** Minutes past local midnight at which a typed number stops meaning yesterday. */
const NOON = 12 * 60;

/**
 * A storable daily total: whole minutes, 1 to 1440.
 *
 * **Zero is refused.** A phone switched off all day is possible, but a zero
 * from an automation is far more likely a failed read, and a stored zero would
 * sit on the record as a fact. A day with no number is an unknown, which is
 * what an absent row already says.
 */
export function isScreenTimeMinutes(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= SCREEN_TIME_MAX_MINUTES;
}

/**
 * 200 → "3h 20m", 45 → "45m", 180 → "3h 0m". The shape the Coach's tools and
 * the wearables screen already print a night's sleep in (read-tools.ts
 * `formatDuration`, use-wearables.ts `fmtSleep`), hand-rolled because Hermes
 * has no Intl.
 */
export function formatHm(minutes: number): string {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * A typed duration → whole minutes, or null when it is not one.
 *
 * Accepts `3h20`, `3h 20m`, `3 hours 20 minutes`, `3h`, `3.5h`, `3:20`, `200`,
 * `200m` and `200 min`. A bare number is MINUTES: `3` meaning three hours would
 * need the `h` it does not have. A minutes part over 59 (`3h75`) is refused
 * rather than carried, because it is a typo more often than a sum.
 *
 * Range is NOT checked here — `0` and `30h` parse — so a caller can tell "not a
 * duration" (a note) from "a duration out of range" (its own message).
 */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (t === '') return null;

  const clock = /^(\d{1,2}):([0-5]\d)$/.exec(t);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);

  const hm = /^(\d{1,2})\s*h(?:rs?|ours?)?(?:\s*(\d{1,2})\s*(?:m|mins?|minutes?)?)?$/.exec(t);
  if (hm) {
    const minutes = hm[2] === undefined ? 0 : Number(hm[2]);
    return minutes > 59 ? null : Number(hm[1]) * 60 + minutes;
  }

  const decimalHours = /^(\d{1,2}\.\d{1,2})\s*h(?:rs?|ours?)?$/.exec(t);
  if (decimalHours) return Math.round(Number(decimalHours[1]) * 60);

  const minutes = /^(\d{1,4})\s*(?:m|mins?|minutes?)?$/.exec(t);
  if (minutes) return Number(minutes[1]);

  return null;
}

// --- Which day ---------------------------------------------------------------

export type ScreenTimeDay = 'yesterday' | 'today';

/**
 * The day a number typed at `now` is filed to when the user names none. See
 * the header: between the day's start and noon it is yesterday, otherwise
 * today. Read off the local wall clock, never by subtracting hours, for the
 * DST reason src/lib/db/date.ts gives.
 */
export function defaultScreenTimeDay(
  now: Date,
  dayStartsAt: string = getDayStartsAt()
): ScreenTimeDay {
  const clock = now.getHours() * 60 + now.getMinutes();
  return clock >= dayStartMinutes(dayStartsAt) && clock < NOON ? 'yesterday' : 'today';
}

/** `yesterday` / `today` at `now` → the `YYYY-MM-DD` it names. */
export function screenTimeDate(
  day: ScreenTimeDay,
  now: Date,
  dayStartsAt: string = getDayStartsAt()
): string {
  const today = todayISODate(now, dayStartsAt);
  return day === 'yesterday' ? shiftISODate(today, -1) : today;
}

/**
 * How a receipt names the day a number went to: `yesterday, Thu 24 Sep`,
 * `today, Fri 25 Sep`, or just `Tue 22 Sep`. Both the word and the date for
 * the two days the noon rule chooses between, because the word is what a
 * person checks and the date is what the record stores.
 */
export function filedDayWords(date: string, today: string): string {
  const named = weekdayDate(date);
  if (date === today) return `today, ${named}`;
  if (date === shiftISODate(today, -1)) return `yesterday, ${named}`;
  return named;
}

/** The fields a receipt reads — a repository entry satisfies it. */
export type ReceiptSubject = {
  date: string;
  minutes: number;
  via: 'typed' | 'shortcuts';
  replaced: { minutes: number }[];
};

/**
 * The words of an Undo receipt: the sentence (serif), the figure (mono) and
 * what VoiceOver says for the button. It says where the number came from, the
 * day it went to, and — when it replaced one — what the day held before, so
 * a replace is never silent.
 *
 *   Screen time filed to yesterday, Thu 24 Sep · 3h 20m
 *   Shortcuts filed screen time to today, Fri 25 Sep · 3h 20m, was 3h 5m
 */
export function receiptWords(
  entry: ReceiptSubject,
  today: string
): { said: string; figure: string; spoken: string } {
  const day = filedDayWords(entry.date, today);
  const was = entry.replaced[entry.replaced.length - 1];
  return {
    said:
      entry.via === 'shortcuts'
        ? `Shortcuts filed screen time to ${day}`
        : `Screen time filed to ${day}`,
    figure: was
      ? `${formatHm(entry.minutes)}, was ${formatHm(was.minutes)}`
      : formatHm(entry.minutes),
    spoken: `Undo screen time ${formatHm(entry.minutes)} for ${weekdayDate(entry.date)}`,
  };
}

// --- The keypad --------------------------------------------------------------

/**
 * What the keypad's readout prints for a typed string: the figure and the unit
 * beside it. `200` reads `200 min`; once the `h` key is pressed the figure
 * carries its own units — `3h`, `3h 2m`, `3h 20m` — and the unit slot is
 * empty. Blank is the placeholder `0h 0m`, which is also how the screen shows
 * that the `h` key exists.
 */
export function keypadReadout(value: string): { figure: string; unit: string } {
  if (value === '') return { figure: '0h 0m', unit: '' };
  const at = value.indexOf('h');
  if (at < 0) return { figure: value, unit: 'min' };
  const hours = value.slice(0, at);
  const minutes = value.slice(at + 1);
  return { figure: minutes === '' ? `${hours}h` : `${hours}h ${minutes}m`, unit: '' };
}

/**
 * The next keypad string after a key, or the same string when the key would
 * make it something the readout cannot show: `h` once, and only after a digit;
 * at most two digits of minutes after it; at most four digits of bare minutes.
 * `del` removes the last character, `h` included.
 */
export function keypadPress(value: string, key: string): string {
  if (key === 'del') return value.slice(0, -1);
  const at = value.indexOf('h');
  if (key === 'h') return at >= 0 || value === '' || value.length > 2 ? value : value + 'h';
  if (!/^\d$/.test(key)) return value;
  if (at < 0) {
    if (value === '0') return key;
    return value.length >= 4 ? value : value + key;
  }
  return value.length - at - 1 >= 2 ? value : value + key;
}

// --- The deep link -----------------------------------------------------------

/** What `arc://log/screen-time?minutes=N&date=YYYY-MM-DD` carried. */
export type ScreenTimeLinkParams = {
  minutes?: string | string[];
  date?: string | string[];
};

export type ScreenTimeLink =
  { ok: true; minutes: number; date: string } | { ok: false; reason: string };

/** expo-router hands a repeated param over as an array; take the first. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** A value quoted back to the user, cut short so a mangled link cannot flood the screen. */
function quoted(value: string): string {
  return `“${value.length > 24 ? value.slice(0, 24) + '…' : value}”`;
}

/**
 * Validate a link's params. Strict, because the write it leads to is silent:
 * a Personal Automation can run while he sleeps and no card waits for a tap.
 *
 *   - `minutes` is a whole number from 1 to 1440, digits only. `200.0` is
 *     refused, which is why the setup note rounds before it builds the URL.
 *   - `date` is `YYYY-MM-DD`, a real calendar day, not after today and not more
 *     than {@link LINK_MAX_DAYS_BACK} days back. Both params are required: a
 *     link with no date would have to guess the day, and a silent write is the
 *     last place to guess.
 *
 * "Not after today" is measured against the CALENDAR day, not ARC's logical
 * one, because the number is Apple's calendar-day total: under a 04:00
 * boundary at 00:30, Apple's "today" is already the next date and a link for it
 * is not from the future.
 */
export function parseScreenTimeLink(
  params: ScreenTimeLinkParams,
  now: Date = new Date()
): ScreenTimeLink {
  const minutesRaw = first(params.minutes)?.trim();
  const dateRaw = first(params.date)?.trim();

  if (!minutesRaw) return { ok: false, reason: 'The link carries no minutes.' };
  if (!/^\d{1,6}$/.test(minutesRaw)) {
    return {
      ok: false,
      reason: `minutes must be a whole number; the link says ${quoted(minutesRaw)}.`,
    };
  }
  const minutes = Number(minutesRaw);
  if (minutes === 0) {
    return {
      ok: false,
      reason:
        'minutes is 0. A zero from an automation is more likely a failed read than a day without the phone.',
    };
  }
  if (minutes > SCREEN_TIME_MAX_MINUTES) {
    return {
      ok: false,
      reason: `minutes must be at most ${SCREEN_TIME_MAX_MINUTES} (24 hours); the link says ${minutes}.`,
    };
  }

  if (!dateRaw) return { ok: false, reason: 'The link carries no date.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
    return { ok: false, reason: `date must be YYYY-MM-DD; the link says ${quoted(dateRaw)}.` };
  }
  const [y, m, d] = dateRaw.split('-').map(Number) as [number, number, number];
  // Noon-anchored round trip: 2026-02-30 comes back as 2026-03-02.
  if (formatLocalDate(new Date(y, m - 1, d, 12, 0, 0, 0)) !== dateRaw) {
    return { ok: false, reason: `${dateRaw} is not a real date.` };
  }
  if (dateRaw > formatLocalDate(now)) {
    return { ok: false, reason: `${dateRaw} is in the future.` };
  }
  if (dateRaw < shiftISODate(todayISODate(now), -LINK_MAX_DAYS_BACK)) {
    return { ok: false, reason: `${dateRaw} is more than ${LINK_MAX_DAYS_BACK} days back.` };
  }

  return { ok: true, minutes, date: dateRaw };
}
