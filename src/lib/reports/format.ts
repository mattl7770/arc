/**
 * The report's ONLY formatting layer.
 *
 * Every string a reader sees is produced here or in the assemblers that call
 * it — never in a renderer (see the header of ./types.ts, "fields in, marks
 * out"). Two consequences worth stating:
 *
 *   1. **Nothing here reaches for `Intl`.** Hermes ships without it, so
 *      `toLocaleString` silently ignores its options object on device — the
 *      same trap `insights.ts` and `date-eyebrow.tsx` already document. Dates,
 *      thousands separators and durations are all hand-rolled.
 *   2. **Every entry point is total.** A non-finite number, a null, a NaN out
 *      of a division by zero — each returns the em-dash rather than the string
 *      "NaN". db/reports.test.mjs asserts no rendered report ever contains
 *      `NaN`, `undefined` or `[object`, and this is where that is actually
 *      enforced; the tripwire only catches the day it stops being true.
 */

/** The one absence mark. A figure with no data is this, never 0 and never ''. */
export const EM_DASH = '—';

/** U+2212 MINUS SIGN — a hyphen is a word-break, not a sign, in a printed table. */
const MINUS = '−';

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Fixed-decimal, absence-safe. `num(null)` and `num(NaN)` are both the em-dash. */
export function num(value: number | null | undefined, decimals = 0): string {
  if (!finite(value)) return EM_DASH;
  // `-0` prints as "-0" through toFixed; the reading is "zero".
  const safe = value === 0 ? 0 : value;
  return safe.toFixed(decimals);
}

/** Signed, for deltas: "+4.0", "−2.5", "0.0". */
export function signed(value: number | null | undefined, decimals = 1): string {
  if (!finite(value)) return EM_DASH;
  if (value === 0) return (0).toFixed(decimals);
  const magnitude = Math.abs(value).toFixed(decimals);
  return value > 0 ? `+${magnitude}` : `${MINUS}${magnitude}`;
}

/** "12.4%" — magnitude only; the direction word belongs to an authored verdict. */
export function pct(value: number | null | undefined, decimals = 1): string {
  if (!finite(value)) return EM_DASH;
  return `${Math.abs(value).toFixed(decimals)}%`;
}

/** 431 → "7h 11m", 45 → "45m". Hand-rolled — see the header. */
export function minutes(value: number | null | undefined): string {
  if (!finite(value)) return EM_DASH;
  const total = Math.max(0, Math.round(value));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** "12,480" — thousands separators without Intl. */
export function count(value: number | null | undefined): string {
  if (!finite(value)) return EM_DASH;
  const rounded = Math.round(value);
  const negative = rounded < 0;
  const digits = String(Math.abs(rounded));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return negative ? `${MINUS}${out}` : out;
}

/** "18 days" / "1 day" — the plural rule, in one place. */
export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

/**
 * "a, b and c" — an Oxford-less list for prose. Empty reads as the em-dash so a
 * caller that forgot to guard prints an absence rather than nothing at all.
 */
export function joinList(items: string[]): string {
  if (items.length === 0) return EM_DASH;
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]!}`;
}

/**
 * The first `limit` items named, the rest counted — never silently truncated.
 * A report that shows six of nineteen dates and says nothing about the other
 * thirteen is the "no silent caps" rule broken on paper.
 */
export function namedThenCounted(items: string[], limit: number): string {
  if (items.length === 0) return EM_DASH;
  if (items.length <= limit) return items.join(', ');
  const rest = items.length - limit;
  return `${items.slice(0, limit).join(', ')} +${count(rest)} more`;
}

/**
 * A low–high interval as one cell: "0.8 – 1.2", "< 1.2", "> 40", or the em-dash
 * when the catalog holds neither bound. One-sided ranges are common in
 * bloodwork (ApoB has no lower bound worth printing) and rendering them as
 * "— – 1.2" would read as a data error rather than as a ceiling.
 */
export function range(
  low: number | null | undefined,
  high: number | null | undefined,
  decimals = 1
): string {
  const hasLow = finite(low);
  const hasHigh = finite(high);
  if (!hasLow && !hasHigh) return EM_DASH;
  if (hasLow && !hasHigh) return `> ${trimZeros(low.toFixed(decimals))}`;
  if (!hasLow && hasHigh) return `< ${trimZeros(high!.toFixed(decimals))}`;
  return `${trimZeros(low!.toFixed(decimals))} – ${trimZeros(high!.toFixed(decimals))}`;
}

/**
 * "1.50" → "1.5", "40.0" → "40". Reference ranges span four orders of magnitude
 * across a lab panel (0.4 ng/mL to 200 mg/dL), so a fixed decimal count is
 * wrong at one end or the other; trimming the padding is right at both.
 */
function trimZeros(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/\.?0+$/, '');
}

/**
 * A value's position against a low–high interval, as a plain boolean. `null`
 * (rather than `false`) when the interval does not exist, so "we did not check"
 * never renders as "inside the range".
 */
export function outsideRange(
  value: number | null | undefined,
  low: number | null | undefined,
  high: number | null | undefined
): boolean | null {
  if (!finite(value)) return null;
  const hasLow = finite(low);
  const hasHigh = finite(high);
  if (!hasLow && !hasHigh) return null;
  if (hasLow && value < low) return true;
  if (hasHigh && value > high!) return true;
  return false;
}

/** Arithmetic mean, or null over an empty list — never 0. */
export function average(values: number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) {
    if (!finite(v)) return null;
    sum += v;
  }
  return sum / values.length;
}
