/**
 * Reading what the photo picker hands back — the wire shapes, parsed in pure
 * functions.
 *
 * ## Why this is a module and not four lines inside the screen
 *
 * `ImagePickerAsset.assetId` and `.exif` have **never been exercised in this
 * codebase**: the existing seam (src/lib/media/photo-library.ts) types only
 * `uri` and `base64`, because until now a picked photo was a model payload and
 * nothing else. Their real shapes are a device question, and the wearables
 * lesson is explicit about what to do with an unexercised wire shape — parse it
 * in an exported pure function with fixtures pinned to the installed package's
 * payloads, so the first device run corrects a fixture rather than crashing a
 * screen (`src/lib/health/mapping.ts`, the HealthKit Quantity-object trap).
 *
 * Every function here takes `unknown` and returns something total. A picker that
 * hands back a shape nobody predicted produces "no date in this photo", which is
 * a state the import review already draws.
 *
 * ## The date rule, which is this feature's central hazard
 *
 * An import may happen years after the shutter. So:
 *
 *   - EXIF `DateTimeOriginal` → the LOCAL day, into `taken_on`.
 *   - `taken_at` is only ever set when a real INSTANT can be formed — that is,
 *     when the EXIF also carries a UTC offset (`OffsetTimeOriginal`), or when
 *     the source was an epoch. EXIF's `YYYY:MM:DD HH:MM:SS` is local wall-clock
 *     with no zone; stamping a `Z` on it would file a number that is wrong by up
 *     to fourteen hours, and ARC's convention is that a `Timestamp` is UTC. No
 *     data, no number.
 *   - **Nothing here ever falls back to today.** A photo with no readable date
 *     comes back with `takenOn: null`, and the review screen makes the user
 *     supply one. A silently-stamped "today" on a photo taken last year corrupts
 *     the one axis the whole gallery is ordered on.
 */

import { isRealCalendarDate } from './format';

/** Where a photo's date came from — the review screen says so on the row. */
export type PhotoDateOrigin =
  /** EXIF DateTimeOriginal (or its documented siblings). */
  | 'exif'
  /** An epoch the picker supplied alongside the asset. */
  | 'asset'
  /** Nothing readable — the user must fill the field in. */
  | 'none';

export type PhotoDate = {
  /** Local `YYYY-MM-DD`, or null when nothing readable was found. */
  takenOn: string | null;
  /** A true UTC instant, or null. See the header: never a zoneless wall clock. */
  takenAt: string | null;
  origin: PhotoDateOrigin;
};

const NO_DATE: PhotoDate = { takenOn: null, takenAt: null, origin: 'none' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * The EXIF keys that carry a capture time, in the order they are trusted.
 *
 * `DateTimeOriginal` is the shutter. `DateTimeDigitized` is when it became a
 * file, which for a camera roll photo is the same instant and for a scan is not
 * — still far better than nothing. Bare `DateTime` is the last modification and
 * is the weakest of the three, so it is last.
 */
const EXIF_DATE_KEYS = ['DateTimeOriginal', 'DateTimeDigitized', 'DateTime'];

/** The offset keys, paired with the date keys above by position of trust. */
const EXIF_OFFSET_KEYS = ['OffsetTimeOriginal', 'OffsetTimeDigitized', 'OffsetTime'];

/**
 * iOS hands EXIF back either flat or nested under `{Exif}` / `{TIFF}` — the
 * CGImageProperties dictionary names, braces and all — depending on version and
 * on whether the asset came through PhotoKit or the file system. Look in all
 * three rather than betting on one.
 */
function exifDictionaries(exif: unknown): Record<string, unknown>[] {
  if (!isRecord(exif)) return [];
  const dicts = [exif];
  for (const key of ['{Exif}', '{TIFF}', 'Exif', 'TIFF']) {
    const nested = exif[key];
    if (isRecord(nested)) dicts.push(nested);
  }
  return dicts;
}

function firstString(dicts: Record<string, unknown>[], keys: string[]): string | null {
  for (const key of keys) {
    for (const dict of dicts) {
      const value = str(dict[key]);
      if (value) return value;
    }
  }
  return null;
}

/**
 * `2026:01:12 08:31:04` → `{ date: '2026-01-12', time: '08:31:04' }`.
 *
 * EXIF separates the date with colons, which is the detail that makes this worth
 * a parser rather than a `Date` constructor: `new Date('2026:01:12 08:31:04')`
 * is `Invalid Date` in Hermes and in V8 alike. Sub-second suffixes and a
 * trailing zone are tolerated and dropped — the zone rides in its own EXIF tag.
 *
 * An all-zero date (`0000:00:00 00:00:00`) is what a camera writes when it has
 * no clock set; it parses structurally and is rejected here, because it would
 * otherwise sail through as a real day in the year zero.
 */
export function parseExifDateTime(value: string): { date: string; time: string } | null {
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  if (year === '0000' || month === '00' || day === '00') return null;
  if (Number(month) > 12 || Number(day) > 31 || Number(hour) > 23) return null;
  if (Number(minute) > 59 || Number(second) > 60) return null;
  return { date: `${year}-${month}-${day}`, time: `${hour}:${minute}:${second}` };
}

/** `+01:00`, `-0800`, `Z` → a suffix `Date.parse` accepts, or null. */
export function normalizeExifOffset(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === 'Z' || trimmed === 'z') return 'Z';
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const [, sign, hours, minutes] = match;
  if (Number(hours) > 14 || Number(minutes) > 59) return null;
  return `${sign}${hours}:${minutes}`;
}

/** Milliseconds since the epoch → a UTC instant, or null for anything that is
 *  not a plausible photograph date (1970 to ~2100). */
function instantFromEpochMs(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0 || ms > 4_102_444_800_000) return null;
  const date = new Date(ms);
  const iso = date.toISOString();
  return Number.isNaN(date.getTime()) ? null : iso;
}

/**
 * The capture date of one picked asset — the single function the import flow
 * calls, and the one place the fallback order is decided.
 *
 * Order: EXIF (a real photographic fact) → an epoch the picker supplied
 * (`creationTime`, which some picker versions expose) → nothing.
 */
export function assetPhotoDate(asset: unknown): PhotoDate {
  if (!isRecord(asset)) return NO_DATE;

  const dicts = exifDictionaries(asset.exif);
  for (let index = 0; index < EXIF_DATE_KEYS.length; index++) {
    const raw = firstString(dicts, [EXIF_DATE_KEYS[index]!]);
    if (!raw) continue;
    const parsed = parseExifDateTime(raw);
    if (!parsed) continue;
    // A structurally-valid EXIF date is not yet a real one. Corrupt firmware and
    // scanners emit impossible days (`2026:04:31`, `2026:02:30`) and absurd
    // years (`9999:12:31`, `1901:05:05`) that pass the shape check above. Reject
    // both here — an impossible day would fail the 0036 CHECK after the working
    // copy was already on disk, and an absurd-but-real year sorts to a permanent
    // extreme of the gallery's one axis and matches no weigh-in. Same
    // plausibility window as the epoch path (`instantFromEpochMs`), plus the
    // sibling calendar round-trip. A rejected date falls through to the
    // epoch/none fallback rather than being trusted as an EXIF fact.
    const exifYear = Number(parsed.date.slice(0, 4));
    if (exifYear < 1900 || exifYear > 2100 || !isRealCalendarDate(parsed.date)) continue;
    // The offset is read from the key PAIRED with the date key that won, not
    // from whichever offset tag happens to exist. A scan carrying
    // DateTimeDigitized (its digitisation clock) alongside a surviving
    // OffsetTimeOriginal (the shutter's zone) would otherwise combine two
    // different moments into one wrong instant.
    const rawOffset = firstString(dicts, [EXIF_OFFSET_KEYS[index]!]);
    const offset = rawOffset ? normalizeExifOffset(rawOffset) : null;
    let takenAt: string | null = null;
    if (offset) {
      const ms = Date.parse(`${parsed.date}T${parsed.time}${offset}`);
      takenAt = Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    }
    return { takenOn: parsed.date, takenAt, origin: 'exif' };
  }

  // Some picker versions carry a creation epoch beside the asset. It is a true
  // instant, so both fields can be filled from it — but the LOCAL day is the one
  // the gallery orders on, so it comes off a local Date, not off the ISO string.
  //
  // This path is only reachable because `PickedLibraryAsset` carries the field
  // through explicitly (src/lib/media/photo-library.ts). It did not, once, and
  // this branch was dead in production while its test passed against a
  // hand-built object — the shape of bug worth remembering: a pure function's
  // test proves nothing about whether the caller supplies the input.
  const epoch = typeof asset.creationTime === 'number' ? asset.creationTime : null;
  if (epoch !== null) {
    const instant = instantFromEpochMs(epoch);
    if (instant) {
      const local = new Date(epoch);
      const takenOn = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`;
      return { takenOn, takenAt: instant, origin: 'asset' };
    }
  }

  return NO_DATE;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * The asset's PhotoKit localIdentifier, or null.
 *
 * Dormant provenance (no installed module can re-fetch by it) with exactly one
 * live job: the dedupe index. A picker that returns none is a picker whose
 * duplicates cannot be caught — a named limit, not a bug.
 */
export function assetLocalId(asset: unknown): string | null {
  if (!isRecord(asset)) return null;
  return str(asset.assetId);
}

/**
 * The working copy is bounded by its **longest edge**, and for a standing body
 * photo that is the height — so this decides which dimension to hand the
 * downscaler.
 *
 * Not a detail: resizing a 3:4 portrait by WIDTH to 1600 yields a 1600×2133
 * image, which is 1.8× the pixels the ~180–350 KB budget was costed at. Over a
 * decade of three-a-week photos that is the difference between ~0.5 GB and
 * nearly a gigabyte, for no visible gain.
 *
 * Dimensions the picker did not report fall back to width, which is the
 * conservative default the rest of the app already uses.
 */
export function workingCopyResize(
  width: number | null,
  height: number | null,
  edge: number
): { width: number } | { height: number } {
  if (width != null && height != null && height > width) return { height: edge };
  return { width: edge };
}

/**
 * The pose the next photo in a batch should default to.
 *
 * A batch is usually one session: front, side, back. Carrying the PREVIOUS
 * photo's pose forward means a three-photo session is three taps to tag instead
 * of three-plus-three, and it is never a silent guess — every row shows its chip
 * row with the choice already made and one tap from being changed.
 *
 * **Deliberately not an AI guess.** A wrong silent pose corrupts the same-pose
 * compare filter, which is this feature's core query.
 */
export function defaultPoseFor<T extends { pose: string }>(previous: T | undefined): string {
  return previous?.pose ?? 'front';
}
