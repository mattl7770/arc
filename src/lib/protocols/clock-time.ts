/**
 * The `HH:MM` value a protocol item carries, and the two conversions the iOS
 * time wheel needs on either side of it.
 *
 * **Why this file exists.** A protocol item's `scheduled_time` is zero-padded
 * `HH:MM` text and nothing else. `normalizeItem` refuses any other shape at the
 * storage boundary (src/lib/protocols/content.ts); the generator copies it onto
 * `log_entries.scheduled_time`, whose CHECK is a `[0-9][0-9]:[0-9][0-9]` GLOB
 * (`db/migrations/0001_init.sql:237-239`); and the reminder scheduler compares
 * two of them as strings, which is chronological only because the shape is
 * padded (`fireInstant`, src/lib/notifications/protocol-reminders.ts). A native
 * picker speaks `Date`. So the string stays the currency and the `Date` exists
 * only for the length of one render: it is built here, handed to the wheel,
 * and the wheel's answer is converted straight back. Nothing else in ARC ever
 * sees it.
 *
 * Pure, and deliberately free of `react-native` — that is what lets
 * `db/protocols.test.mjs` pin the write contract headlessly, on a suite that
 * never loads a component.
 *
 * `normalizeTime` moved here from `src/components/protocols/form-controls.tsx`
 * on 2026-09-21 for the same reason: it is the parser both halves of the
 * contract share, and a parser that lives in a component file cannot be tested
 * without one.
 */

/** "8:05" / "08:05" -> "08:05"; null if it isn't a real clock time. */
export function normalizeTime(text: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${m[2]}`;
}

/** An item with no time at all — it sorts to the end of the day, and never nudges. */
export const NO_TIME = '';

/**
 * The wheel's minute granularity, in one place because **two** things read it:
 * the picker's `minuteInterval` prop and {@link dateToTime}'s snap. Spelled
 * once, they cannot disagree; spelled twice, the wheel would offer a value the
 * conversion then moved.
 *
 * Five: the step the iOS Calendar app's own event-time wheel uses, and that is
 * the wheel the owner named.
 */
export const MINUTE_STEP = 5;

/**
 * Where the wheel sits when the item has **no** time.
 *
 * A `UIDatePicker` always shows something; it has no empty state. So the
 * question is only which lie is smallest. Parking on *now* is the worst one —
 * it reads as a suggestion that this item happens at this moment. A fixed
 * anchor suggests nothing, and this is the anchor the six chips led with from
 * C9 until this control replaced them.
 *
 * It is a PARK, not a value: nothing is written until the wheel is actually
 * moved, and until then the caption beside it says *Any time* in words.
 */
export const PARKED_TIME = '07:00';

/**
 * The day the wheel's `Date` is pinned to.
 *
 * `mode="time"` draws hours and minutes and never the date, so the date is pure
 * scaffolding — but it must be a CONSTANT, for two reasons. A `new Date()` base
 * would hand the picker a fresh object on every render, which churns a native
 * view for nothing; and it would make {@link timeToDate} impure, which is the
 * one property that lets the conversion be tested at all.
 *
 * 2000-01-01 specifically: the `Date(y, m, d, h, min)` constructor resolves
 * LOCAL time, and on a day that carries a DST transition some local times do
 * not exist — asking for 02:30 on a spring-forward morning gets you 03:30, and
 * the round trip would silently move the item by an hour. 1 January 2000 has
 * no transition in any zone: all 1,440 of that day's minutes were checked to
 * exist and round-trip in each of the 418 zones the runtime ships
 * (2026-09-23), and `db/protocols.test.mjs` §14 re-runs the round trip in
 * seven of them, DST and half-hour zones included, on every test run.
 */
const ANCHOR_YEAR = 2000;

/**
 * `HH:MM` -> the `Date` the wheel should open on. A blank or unparseable value
 * parks at {@link PARKED_TIME}; it is not an error, it is an item with no time.
 *
 * The minute is passed through EXACTLY as stored, never snapped. A value off
 * the {@link MINUTE_STEP} grid comes from somewhere other than the wheel — the
 * typed field C9 shipped, or a version the Coach wrote — and iOS can only draw
 * the minutes it offers, so it shows such a value at a neighbouring stop on its
 * own. Snapping here instead would rewrite the stored time the moment the
 * editor opened: an edit the owner did not make, to a value he never saw. The
 * caption above the wheel keeps printing the stored truth until he moves it.
 */
export function timeToDate(time: string): Date {
  const parsed = normalizeTime(time) ?? PARKED_TIME;
  return new Date(ANCHOR_YEAR, 0, 1, Number(parsed.slice(0, 2)), Number(parsed.slice(3, 5)), 0, 0);
}

/**
 * The wheel's `Date` -> the `HH:MM` that gets stored, snapped to `step`.
 *
 * **null means "this is not a clock time"**, and the caller must write nothing.
 * The alternative shapes were both lies: `'NaN:NaN'` reaches the database, and
 * falling back to a default silently retimes the item. An invalid `Date` cannot
 * come out of the picker, so this is a guard, not a path — but it is the guard
 * that keeps a bad value from ever reaching `scheduled_time`.
 *
 * The snap ROUNDS and wraps at midnight, so 23:58 -> 00:00 rather than 24:00.
 * iOS with `minuteInterval` set never emits an off-grid minute, so this too is
 * belt-and-braces — and it is the half of the contract a test can hold, which
 * is why it is spelled out rather than assumed.
 */
export function dateToTime(at: Date, step: number = MINUTE_STEP): string | null {
  const total = at.getHours() * 60 + at.getMinutes();
  if (!Number.isFinite(total)) return null;
  const grid = Number.isFinite(step) && step >= 1 ? Math.floor(step) : 1;
  const snapped = (Math.round(total / grid) * grid) % (24 * 60);
  const hh = String(Math.floor(snapped / 60)).padStart(2, '0');
  const mm = String(snapped % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}
