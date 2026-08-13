/**
 * Period math for the self-review — pure string arithmetic over `YYYY-MM-DD`,
 * no database, no clock beyond the `now` handed in.
 *
 * ## Why the presets are CLOSED periods, and why that is an honesty device
 *
 * "Last week" is the previous *complete* Monday–Sunday, "Last month" the
 * previous calendar month. Neither includes today, which makes the rule the
 * rest of the app has to keep restating — *accumulating metrics exclude today,
 * because a day still being written is not a day* (insights.ts's `accNow`,
 * `wearableFloorLine`'s "only today's running totals") — go moot by
 * construction. The period closed before the report was asked for.
 *
 * A CUSTOM range is the one that can reach today, so it is the one that carries
 * {@link Period.includesToday} and an authored note. It is not forbidden: "how
 * did this month go so far" is a real question. It is only marked.
 *
 * Monday-start comes from {@link localWeekRange} rather than being re-derived —
 * the same definition the Exercise screen, the Data tab and the Coach share
 * (src/lib/db/date.ts), so "last week" means one thing in ARC.
 */
import { localWeekRange, todayISODate } from '@/lib/db/date';
import { daysBetweenISO, isoDatePlusDays } from '@/lib/ai/series';

import type { Period, PeriodKind } from './types';

/**
 * The custom-range ceiling (⚑ MATT #6, decided 2026-08-12: cap at ~1 year).
 *
 * 366 rather than 365 so a range that spans a leap day is not one day short of
 * "a year". The cap exists for the COMPARISON, not for performance: every
 * period is reported against the equal-length window before it, and a
 * three-year range measured against the three years before it is not a review,
 * it is an archaeology dig — the prior window stops resembling a baseline long
 * before the query gets slow.
 */
export const MAX_CUSTOM_RANGE_DAYS = 366;

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a well-formed `YYYY-MM-DD` that names a real calendar day. */
export function isValidISODate(date: string): boolean {
  if (!ISO_DATE.test(date)) return false;
  // Round-trip through UTC: '2026-02-30' parses but normalises to 2026-03-02,
  // so a date that survives the trip unchanged is a day that exists.
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === date;
}

/** "3 Aug 2026" — hand-rolled; Hermes ships no Intl (CLAUDE.md, insights.ts). */
export function formatDate(date: string): string {
  if (!ISO_DATE.test(date)) return date;
  const [y, m, d] = date.split('-');
  const month = MONTHS_SHORT[Number(m) - 1] ?? m;
  // Number() drops the leading zero: "03" → 3, which is how a date is spoken.
  return `${Number(d)} ${month} ${y}`;
}

/** "12 August 2026" — the long form, for a document's generated-on line. */
export function formatDateLong(date: string): string {
  if (!ISO_DATE.test(date)) return date;
  const [y, m, d] = date.split('-');
  const month = MONTHS_LONG[Number(m) - 1] ?? m;
  return `${Number(d)} ${month} ${y}`;
}

/**
 * "3 – 9 Aug 2026" — a span, with the repeated parts said once. A range inside
 * one month drops the first month and year; one inside a year drops the first
 * year; one that crosses a year spells both ends in full.
 */
export function formatRange(start: string, end: string): string {
  if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) return `${start} – ${end}`;
  if (start === end) return formatDate(start);
  const [sy, sm, sd] = start.split('-');
  const [ey, em] = end.split('-');
  if (sy === ey && sm === em) return `${Number(sd)} – ${formatDate(end)}`;
  if (sy === ey) {
    const month = MONTHS_SHORT[Number(sm) - 1] ?? sm;
    return `${Number(sd)} ${month} – ${formatDate(end)}`;
  }
  return `${formatDate(start)} – ${formatDate(end)}`;
}

/** Whole days in the inclusive span `[start, end]`. */
export function periodDays(start: string, end: string): number {
  return daysBetweenISO(start, end) + 1;
}

/** Every local calendar day in `[start, end]`, oldest first. */
export function daysInPeriod(start: string, end: string): string[] {
  const out: string[] = [];
  const total = periodDays(start, end);
  for (let i = 0; i < total; i++) out.push(isoDatePlusDays(start, i));
  return out;
}

/**
 * The equal-length window immediately before `start` — the comparison base for
 * every window-over-window figure in the report. A 7-day period compares
 * against the 7 days before it, so the two halves are the same size and
 * `compareWindows` is being asked a fair question.
 */
export function priorEqualWindow(start: string, end: string): { start: string; end: string } {
  const length = periodDays(start, end);
  return { start: isoDatePlusDays(start, -length), end: isoDatePlusDays(start, -1) };
}

/** Assemble the {@link Period} from bare bounds — the one place `prior` is derived. */
function buildPeriod(kind: PeriodKind, start: string, end: string, label: string, today: string): Period {
  const prior = priorEqualWindow(start, end);
  return {
    kind,
    start,
    end,
    label,
    rangeLabel: formatRange(start, end),
    days: periodDays(start, end),
    includesToday: end >= today,
    prior: { ...prior, rangeLabel: formatRange(prior.start, prior.end) },
  };
}

/**
 * The previous COMPLETE Monday–Sunday week. On a Wednesday this is the week
 * that ended last Sunday, never the three days of the current one.
 */
export function lastCompleteWeek(now: Date = new Date()): Period {
  const thisWeek = localWeekRange(now);
  const start = isoDatePlusDays(thisWeek.start, -7);
  const end = isoDatePlusDays(thisWeek.start, -1);
  return buildPeriod('last_week', start, end, 'Last week', todayISODate(now));
}

/**
 * The previous calendar month, first day to last. Built from local Y/M
 * components and JS's day-0 trick (day 0 of month N+1 is the last day of month
 * N), so month lengths and leap years come from the calendar rather than from
 * a table here.
 */
export function lastCalendarMonth(now: Date = new Date()): Period {
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-based; the month BEFORE this one is month - 1
  const first = new Date(year, month - 1, 1);
  const last = new Date(year, month, 0);
  const start = todayISODate(first);
  const end = todayISODate(last);
  const label = `${MONTHS_LONG[first.getMonth()] ?? ''} ${first.getFullYear()}`;
  return buildPeriod('last_month', start, end, label, todayISODate(now));
}

export type CustomRangeResult =
  | { ok: true; period: Period }
  /** `message` is user-facing copy: a fact and its consequence, never a scold. */
  | { ok: false; message: string };

/**
 * Validate and build a custom range. Every rejection names the actual numbers,
 * so the picker can print the reason rather than just refusing.
 *
 * A range ending TODAY is allowed and marked ({@link Period.includesToday}); a
 * range ending in the FUTURE is not — there is no data there, and a report
 * whose window extends past the last day that could possibly have a row would
 * dilute every average it prints by the empty days.
 */
export function validateCustomRange(
  start: string,
  end: string,
  now: Date = new Date()
): CustomRangeResult {
  if (!isValidISODate(start) || !isValidISODate(end)) {
    return { ok: false, message: 'Both dates must be real calendar days (YYYY-MM-DD).' };
  }
  if (start > end) {
    return { ok: false, message: 'The start date falls after the end date.' };
  }
  const today = todayISODate(now);
  if (end > today) {
    return {
      ok: false,
      message: `The range ends ${formatDate(end)}, which has not happened yet. A report can only read days that exist.`,
    };
  }
  const days = periodDays(start, end);
  if (days > MAX_CUSTOM_RANGE_DAYS) {
    return {
      ok: false,
      message:
        `That is ${days} days. A range is capped at ${MAX_CUSTOM_RANGE_DAYS} so the ` +
        'comparison against the window before it still means something.',
    };
  }
  return { ok: true, period: buildPeriod('custom', start, end, 'Custom range', today) };
}

/**
 * Rebuild a {@link Period} from the bounds a route carried.
 *
 * The generate screen picks a period and pushes `/report-view` with three
 * strings; this turns them back into the same object, so nothing has to
 * serialize a `Period` through a URL or park a draft in a module-level store
 * that survives a reload with stale contents. Returns null on anything
 * malformed — a hand-typed deep link is untrusted input like any other.
 *
 * The LABEL is re-derived rather than carried, because it is a function of the
 * bounds: a label passed as a fourth parameter is a fourth thing that can
 * disagree with the dates printed beside it.
 */
export function periodFromBounds(
  kind: PeriodKind,
  start: string,
  end: string,
  now: Date = new Date()
): Period | null {
  if (!isValidISODate(start) || !isValidISODate(end) || start > end) return null;
  const label =
    kind === 'last_week'
      ? 'Last week'
      : kind === 'last_month'
        ? `${MONTHS_LONG[Number(start.split('-')[1]) - 1] ?? ''} ${start.split('-')[0]}`
        : 'Custom range';
  return buildPeriod(kind, start, end, label.trim(), todayISODate(now));
}

/**
 * The authored note a period that reaches today must carry — stated once here
 * so both renderers print the same sentence and neither decides when it
 * applies. Null for the presets, which close before today by construction.
 */
export function todayNote(period: Period): string | null {
  if (!period.includesToday) return null;
  return (
    'This range includes today. Today is still being written, so everything ' +
    'that accumulates through a day excludes it: the adherence ledger, training ' +
    'minutes, steps, energy, and food logged. Single readings taken today ' +
    '(weight, HRV, resting heart rate) are whole facts and are counted.'
  );
}

/**
 * The last day an ACCUMULATING total may read for this period: the end of the
 * period, or yesterday when the period reaches today. One definition, so every
 * accumulating series in the assembly clips the same way.
 */
export function accumulatingEnd(period: Period, now: Date = new Date()): string {
  const today = todayISODate(now);
  return period.end >= today ? isoDatePlusDays(today, -1) : period.end;
}
