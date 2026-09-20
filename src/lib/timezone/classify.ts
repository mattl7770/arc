/**
 * The timezone brain (backlog **D4**, docs/spikes/timezone-days.md §2) — pure,
 * DB-free, clock-free, and **independent of the host's own timezone**.
 *
 * Everything here is a function of values that are passed in, which is the only
 * way the headless suite can assert on it: `src/lib/db/date.ts` already refuses
 * SQLite's `'localtime'` modifier because it *"would read the machine timezone
 * and make the headless tests non-deterministic"*, and a classifier that read
 * `new Date()` would put the same rot back one layer down. The one function
 * that does touch the runtime's zone, {@link offsetEastMinutes}, takes the
 * `Date` as an argument.
 *
 * ## The sign, which is the whole trap
 *
 * `Date.prototype.getTimezoneOffset()` returns minutes **WEST** of UTC — UTC−8
 * is `+480` and UTC+1 is `−60`, i.e. backwards from how anyone says it. ARC
 * stores and reasons in minutes **EAST**, so UTC+1 is `+60`, and the single
 * negation lives in {@link offsetEastMinutes}. Same species as the HealthKit
 * percent fraction, which is documented in both directions and pinned as a
 * round-trip assertion precisely so nobody "tidies" it later.
 *
 * ## What ARC can know, and what it cannot
 *
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` would give the IANA zone
 * id. Hermes has no `Intl` (readiness.ts hand-rolls thousands separators for
 * the same reason) and `expo-localization` is not a dependency. So **ARC can
 * know the offset and never the zone name**: the copy says *"UTC−8 → UTC+1"*
 * and never *"America/Los_Angeles → Europe/London"*. That is a constraint, and
 * it is also the honest line — the offset is what actually moved the day.
 *
 * It follows that ARC also cannot know a flight from a Settings change. The
 * copy therefore says *"Timezone changed"*, never *"You travelled"* — the same
 * honesty rule readiness.ts states at `strainNote` (*"Not 'a rest day': ARC
 * knows nothing was LOGGED, which is a different fact"*).
 */
import { logicalDateAtOffset } from '@/lib/db/date';

/** The real range of IANA offsets, UTC−12 … UTC+14 — the 0053 CHECK in JS. */
const OFFSET_MIN_LIMIT = 840;

/**
 * A `Date` → its zone's offset in minutes **EAST** of UTC (UTC+1 → `60`,
 * UTC−8 → `−480`). The negation of `getTimezoneOffset()`, and the only place in
 * ARC that negation happens.
 *
 * Takes the instant rather than reading the clock, both because the offset of a
 * zone depends on WHEN you ask (DST) and because a function that reads
 * `new Date()` cannot be tested without a fake clock.
 */
export function offsetEastMinutes(at: Date): number {
  return -at.getTimezoneOffset();
}

/**
 * The device's own zone's two offsets, sampled at 1 January and 1 July of
 * `year` — the dependency-free probe that keeps DST out of the record (§2c).
 *
 * These two values ARE the current zone's standard and DST offsets, in either
 * order (the southern hemisphere reverses them), which is why every consumer
 * treats them as an unordered pair.
 */
export function zoneProbe(year: number): { januaryOffsetMin: number; julyOffsetMin: number } {
  return {
    januaryOffsetMin: offsetEastMinutes(new Date(year, 0, 1)),
    julyOffsetMin: offsetEastMinutes(new Date(year, 6, 1)),
  };
}

export type OffsetChangeInput = {
  /** Minutes EAST of UTC before the change. */
  fromOffsetMin: number;
  /** Minutes EAST of UTC after it. */
  toOffsetMin: number;
  /** When the change was observed. */
  at: Date;
  /** The device's own zone's January offset — {@link zoneProbe}. */
  januaryOffsetMin: number;
  /** …and its July one. Order between the two never matters. */
  julyOffsetMin: number;
  /** The B3 day boundary; defaults to whatever date.ts has installed. */
  dayStartsAt?: string;
};

export type OffsetChange = {
  /** `travel` marks days; `dst` marks nothing and is not recorded (0053). */
  kind: 'travel' | 'dst';
  /** The logical day at `at` under the OLD offset. */
  fromLocalDate: string;
  /** …and under the NEW one. Equal unless the change crossed the boundary. */
  toLocalDate: string;
  /** The days this change annotates: empty for `dst`, one or two for `travel`. */
  markedDays: string[];
};

/**
 * Classify one observed offset change, and say which days it marks.
 *
 * ## Travel vs DST — the January/July probe
 *
 * Without `Intl` there is no zone id to compare, but there is an exact probe.
 * `{january, july}` are the device's CURRENT zone's own two offsets. If they
 * differ (the zone observes DST at all) **and both the old and the new offset
 * are members of that pair**, the change is that zone's own annual shift.
 * Otherwise the zone itself changed.
 *
 * Exact for every real case:
 *
 *   - `America/Los_Angeles` spring-forward: probe `{−480, −420}`, change
 *     `−480 → −420` — both in the pair → **dst**. The autumn mirror
 *     (`−420 → −480`) is the same set membership, so direction never matters.
 *   - `Australia/Sydney`: probe `{+660, +600}` (January is the DST one there),
 *     change `+660 → +600` → **dst**. The pair is UNORDERED, so the hemisphere
 *     never matters either.
 *   - LA → London: `−480 → +60`, and after the move the device probes
 *     `{0, +60}`; `−480` is not in it → **travel**.
 *   - A one-hour hop into a zone with no DST (`january === july`, so the pair
 *     degenerates to a single value) → **travel** for any change at all. This
 *     is the case a naïve "±60 minutes means DST" rule gets wrong, and it is
 *     why that rule is not what is written here.
 *
 * The two residual misclassifications are both harmless and both stated: a
 * flight between two zones that happen to be exactly the device's own
 * standard/DST pair annotates nothing, and a zone change landing in the same
 * instant as a home DST change annotates a day that was going to be odd anyway.
 *
 * ## Which day is marked (§2e)
 *
 * Both `fromLocalDate` and `toLocalDate`. The change belongs to the SEAM
 * between two days, and the seam is what a reader needs to see:
 *
 *   - equal (the common case, an afternoon landing) — one day is marked, and
 *     it is the day that is now `24 + Δ` hours long;
 *   - `to > from` (eastbound over the boundary) — the tail of the old day never
 *     happened, which is what explains a mission with unreachable evening items;
 *   - `to < from` (westbound over the boundary) — the date is lived TWICE, and
 *     the annotation is what keeps the second pass from reading as corruption.
 *
 * The day's LENGTH is not returned and is never stored: it is derivable from
 * the two offsets ({@link dayLengthHours}), and storing a derived number is how
 * two sources of truth start.
 */
export function classifyOffsetChange(input: OffsetChangeInput): OffsetChange {
  const { fromOffsetMin, toOffsetMin, at, januaryOffsetMin, julyOffsetMin, dayStartsAt } = input;
  const fromLocalDate = logicalDateAtOffset(at, fromOffsetMin, dayStartsAt);
  const toLocalDate = logicalDateAtOffset(at, toOffsetMin, dayStartsAt);

  const zoneShifts = januaryOffsetMin !== julyOffsetMin;
  const inPair = (offset: number): boolean =>
    offset === januaryOffsetMin || offset === julyOffsetMin;
  const isDst = zoneShifts && inPair(fromOffsetMin) && inPair(toOffsetMin);

  const markedDays = isDst
    ? []
    : fromLocalDate === toLocalDate
      ? [fromLocalDate]
      : [fromLocalDate, toLocalDate].sort();

  return { kind: isDst ? 'dst' : 'travel', fromLocalDate, toLocalDate, markedDays };
}

/** Is this a storable offset (the 0053 CHECK, asked before the insert)? */
export function isPlausibleOffset(minutes: number): boolean {
  return Number.isInteger(minutes) && Math.abs(minutes) <= OFFSET_MIN_LIMIT;
}

/**
 * Minutes east → `"UTC+1"`, `"UTC−8"`, `"UTC+5:30"`, `"UTC"`.
 *
 * Hand-rolled, and the minus is the typographic `−` (U+2212) the rest of the
 * app's numbers use (`fmtDelta` in readiness.ts). No `Intl`, no zone name —
 * see the header for why there can never be one.
 */
export function formatUtcOffset(minutes: number): string {
  if (minutes === 0) return 'UTC';
  const sign = minutes > 0 ? '+' : '−';
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  return rest === 0 ? `UTC${sign}${hours}` : `UTC${sign}${hours}:${String(rest).padStart(2, '0')}`;
}

/** `"UTC−8 → UTC+1"` — the change itself, as the record states it. */
export function formatOffsetChange(fromMinutes: number, toMinutes: number): string {
  return `${formatUtcOffset(fromMinutes)} → ${formatUtcOffset(toMinutes)}`;
}

/**
 * How far the clock moved and which way — `"9h east"`, `"5.5h west"`.
 *
 * The offsets are minutes EAST, so a RISING number is an eastbound move, which
 * is the same arithmetic {@link dayLengthHours} inverts and the same trap. The
 * Coach's state block is the only consumer; it exists here rather than there so
 * the direction is decided once, beside the sign convention it depends on.
 */
export function offsetShift(fromMinutes: number, toMinutes: number): string {
  const hours = (toMinutes - fromMinutes) / 60;
  const magnitude = Math.abs(hours);
  const size = Number.isInteger(magnitude) ? String(magnitude) : magnitude.toFixed(1);
  return `${size}h ${hours > 0 ? 'east' : 'west'}`;
}

/**
 * How long the day containing this change is, in hours.
 *
 * **Travelling EAST shortens the day and travelling WEST lengthens it**, which
 * is the opposite of what the arithmetic looks like at a glance — the offsets
 * are minutes east, so an eastbound trip *raises* the number and *subtracts*
 * hours from the day. Los Angeles → London (`−480 → +60`, nine hours east) is a
 * **15-hour** day; the return leg is a **33-hour** one. London → New York
 * (`+60 → −240`) is the 29-hour day the spike opens with.
 *
 * Never stored. It is derivable from the two offsets, and storing a derived
 * number is how two sources of truth start.
 */
export function dayLengthHours(fromMinutes: number, toMinutes: number): number {
  return 24 - (toMinutes - fromMinutes) / 60;
}

/** `15` → `"15 hours"`, `28.5` → `"28.5 hours"`. `toFixed`, not `Intl`. */
export function formatDayLength(hours: number): string {
  const text = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `${text} hours`;
}
