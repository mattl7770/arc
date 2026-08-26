/**
 * Cadence arithmetic — when an item comes round, and how a cadence reads.
 *
 * Everything here is PURE and works in LOCAL calendar dates (`YYYY-MM-DD`
 * text), never in instants. That is deliberate and is the fix for a bug this
 * codebase has shipped twice: SQLite's `strftime('now')` reads a finer clock
 * than `Date.now()` on Windows, so any `now − then` in milliseconds can come out
 * negative and a test that passes alone fails in a full sweep. Calendar-date
 * subtraction has no such clock to disagree with.
 *
 * **Hermes ships no `Intl`**, so the weekday is hand-rolled from epoch days
 * rather than read off a formatter, and is pinned against known dates in
 * db/mission-generate.test.mjs.
 */
import type { Cadence } from './types';

/**
 * Days since the Unix epoch for a local calendar date. `Date.UTC` (unlike
 * `Intl`) exists in Hermes and is timezone-free, which is exactly what is
 * wanted: both operands of every subtraction below are calendar dates, so the
 * difference is a count of days and no zone can shift it.
 *
 * A malformed date yields NaN, which every caller below turns into "does not
 * apply" rather than into a wrong day.
 */
export function epochDay(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) return NaN;
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

/** `to − from` in whole calendar days. Negative when `to` precedes `from`. */
export function daysBetween(from: string, to: string): number {
  return epochDay(to) - epochDay(from);
}

/**
 * ISO weekday, 1 = Monday … 7 = Sunday.
 *
 * 1970-01-01 was a **Thursday** (ISO 4), so epoch day 0 must map to 4 — which
 * `((day + 3) mod 7) + 1` does, and the `+ 7` keeps the modulo positive for
 * dates before 1970 (a lab report from the 1960s is not a reason to return 0).
 */
export function isoWeekday(date: string): number {
  const day = epochDay(date);
  if (Number.isNaN(day)) return NaN;
  return ((((day + 3) % 7) + 7) % 7) + 1;
}

/**
 * The Monday that starts the calendar week containing `date`, as `YYYY-MM-DD`.
 * The same Monday-start convention as `localWeekRange` in src/lib/db/date.ts —
 * quotas and the Data tab must not disagree about where a week begins.
 */
export function weekStart(date: string): string {
  return addDays(date, -(isoWeekday(date) - 1));
}

/** `date` shifted by `n` calendar days, as `YYYY-MM-DD`. */
export function addDays(date: string, n: number): string {
  const shifted = new Date((epochDay(date) + n) * 86_400_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Whether a cadence puts its item on `date`, for everything the app can decide
 * WITHOUT reading the database.
 *
 * `quota` is the exception and returns null: a flexible quota depends on how
 * much of this week's quota is already met, which is a fact about
 * `log_entries`. The generator answers it — see `quotaLandsOn` there — and
 * this function stays pure so the editor and the diff can use it too.
 *
 * `dayInPhase` is 0 on the phase's first day. `every_n_days` counts from there,
 * not from the week or the month, so a phase that starts on a Wednesday puts an
 * every-3-days item on Wednesday, Saturday, Tuesday…
 */
export function cadenceLandsOn(
  cadence: Cadence,
  date: string,
  dayInPhase: number
): boolean | null {
  switch (cadence.kind) {
    case 'daily':
      return true;
    case 'weekdays': {
      const weekday = isoWeekday(date);
      return Number.isNaN(weekday) ? false : cadence.days.includes(weekday);
    }
    case 'every_n_days':
      return dayInPhase >= 0 && dayInPhase % cadence.n === 0;
    case 'quota':
      return null;
  }
}

/** ISO weekday → the short label the app writes everywhere. */
export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/**
 * A cadence in one short phrase — the hub's summary line, the diff's "changed
 * from … to …", and the round-trip target of {@link parseCadenceText}.
 *
 * Deliberately terse and ASCII-safe: it is also what the Coach's
 * `update_protocol` schema accepts, and a compact STRING there costs a fraction
 * of the tokens a four-branch object union would (docs/ai-coach.md §2c — both
 * prompt ceilings are near full).
 */
export function cadenceText(cadence: Cadence): string {
  switch (cadence.kind) {
    case 'daily':
      return 'daily';
    case 'weekdays':
      return cadence.days.length === 0
        ? 'never'
        : cadence.days.map((d) => WEEKDAY_LABELS[d - 1] ?? '?').join(',');
    case 'every_n_days':
      return `every ${cadence.n} days`;
    case 'quota':
      return `${cadence.per_week}/week`;
  }
}

/** Lowercase short weekday → ISO number, for {@link parseCadenceText}. */
const WEEKDAY_NUMBERS: Record<string, number> = {
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  sun: 7,
};

/**
 * The inverse of {@link cadenceText}, forgiving about spacing and case:
 * `"daily"` · `"mon,wed,fri"` · `"every 3 days"` (or `"every 3d"`) · `"3/week"`.
 *
 * Returns null on anything it does not recognise, so the ONE caller that
 * matters — the Coach's tool boundary — can reject a bad cadence with a message
 * the model can act on instead of persisting a broken protocol.
 */
export function parseCadenceText(text: string): Cadence | null {
  const s = text.trim().toLowerCase();
  if (s === '' || s === 'daily' || s === 'every day') return { kind: 'daily' };

  const everyN = /^every\s+(\d+)\s*(d|days?)$/.exec(s);
  if (everyN) {
    const n = Number(everyN[1]);
    if (n === 1) return { kind: 'daily' };
    return n >= 2 && n <= 365 ? { kind: 'every_n_days', n } : null;
  }

  const quota = /^(\d+)\s*(?:\/|\s+per\s+|\s+x\s+|\s+a\s+)\s*(?:week|wk|w)$/.exec(s);
  if (quota) {
    const per = Number(quota[1]);
    return per >= 1 && per <= 7 ? { kind: 'quota', per_week: per } : null;
  }

  const parts = s.split(/[\s,]+/).filter((p) => p !== '');
  if (parts.length > 0 && parts.every((p) => WEEKDAY_NUMBERS[p.slice(0, 3)] !== undefined)) {
    const days = [...new Set(parts.map((p) => WEEKDAY_NUMBERS[p.slice(0, 3)]!))].sort(
      (a, b) => a - b
    );
    return { kind: 'weekdays', days };
  }
  return null;
}
