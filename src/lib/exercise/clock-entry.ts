/**
 * Stopwatch entry for a set's duration — the digits a user types, the clock the
 * field draws, and the seconds that get stored. Pure and DB-free, so the rules
 * are pinned headlessly (db/exercise.test.mjs §12) rather than discovered in a
 * gym.
 *
 * Owner, on device, 2026-09-23: *"plank time should not require me to put in a
 * colon, should automatically fill right to left"*. The `mm:ss` field had been
 * the only input in the app on the full `numbers-and-punctuation` keyboard,
 * because no iOS number pad has a colon (docs/exercise-subapp.md §10.5). Now the
 * colon is DRAWN, never typed: the field takes a plain number pad and the digits
 * shift in from the right, like a microwave —
 *
 *   1 → 0:01 · 13 → 0:13 · 130 → 1:30 · 1305 → 13:05 · 13050 → 1:30:50
 *
 * — and Backspace shifts the last one back out.
 *
 * ## Three representations, one stored value
 *
 *   digits    "190"    the buffer: no colons, no leading zeros, ≤ 5 typed
 *   text      "1:90"   what the field holds and draws (and what a draft keeps)
 *   seconds    150     what `workout_sets.duration_sec` stores — unchanged
 *
 * The stored value is read exactly as before, by `parseClock` in
 * src/lib/exercise/format.ts: every text this module produces is an `m:ss` or
 * `h:mm:ss` string whose `parseClock` reading is the seconds its digits mean
 * (the suite checks every buffer up to five digits). So the loggers, the
 * over-limit guards, the draft contract and the schema are all untouched, and
 * `DRAFT_VERSION` does not move.
 *
 * ## Seconds past 59 are normalised on commit, not rejected
 *
 * `190` reads `1:90` while it is being typed and becomes `2:30` when editing
 * ends. It is not refused, because it is not wrong: it is a duration spelled
 * the way a microwave spells it, and 1:90 and 2:30 are the same 150 seconds.
 * Refusing the `0` would strand the user mid-number — they cannot know which
 * digit the field will turn away until it happens — and normalising AS THEY TYPE
 * would move digits under their thumb (`1`, `9`, `0` → `2:30`, and the next `5`
 * then lands on `23:05` instead of `19:05`). So the typed digits stay exactly as
 * typed until commit, and commit only ever re-spells a value; it never changes
 * one. Minutes past 59 carry into hours by the same rule (`60:00` → `1:00:00`).
 *
 * ## The maximum is five digits
 *
 * `duration_sec < 36000`, so the longest storable set is 9:59:59 — five digits,
 * one of them hours. A sixth digit is refused, because every six-digit buffer is
 * ten hours or more and the schema would reject all of them. What five digits
 * CAN still express past the limit (`9:99:99`, 38,439 s) is left exactly as
 * typed and flagged by the loggers' existing over-limit guards, the same as an
 * over-limit weight — never clamped to a number nobody typed.
 */
import { parseClock } from './format';

/** Digits the field takes: h:mm:ss with one hour digit — 9:59:59 is the last value `duration_sec` stores. */
export const CLOCK_ENTRY_MAX_DIGITS = 5;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * The clock a digit buffer draws, filled from the right: the last two digits are
 * seconds, the two before them minutes, anything before that hours.
 * Un-normalised on purpose — `190` draws `1:90` until commit. `''` draws `''`,
 * so an empty field shows its placeholder.
 */
export function digitsToClock(digits: string): string {
  if (digits === '') return '';
  const padded = digits.padStart(3, '0');
  const ss = padded.slice(-2);
  const rest = padded.slice(0, -2);
  if (rest.length <= 2) return `${Number(rest)}:${ss}`;
  return `${Number(rest.slice(0, -2))}:${rest.slice(-2)}:${ss}`;
}

/** The seconds a digit buffer means, un-normalised (`190` → 150); null when empty. */
export function digitsToSeconds(digits: string): number | null {
  if (digits === '') return null;
  const padded = digits.padStart(4, '0');
  const seconds = Number(padded.slice(-2));
  const minutes = Number(padded.slice(-4, -2));
  const hours = padded.length > 4 ? Number(padded.slice(0, -4)) : 0;
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * The normalised buffer for a number of seconds: `150` → `230`, `5450` →
 * `13050`. Zero (or anything that is not a real duration) is the empty buffer —
 * a leading zero is never a digit here.
 */
export function secondsToDigits(seconds: number): string {
  if (!Number.isFinite(seconds)) return '';
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}${pad2(m)}${pad2(s)}`;
  if (m > 0) return `${m}${pad2(s)}`;
  return s > 0 ? String(s) : '';
}

/**
 * A stored duration as the field's normal text — `m:ss` under the hour,
 * `h:mm:ss` from it: `90` → `1:30`, `5450` → `1:30:50`. What a stored set opens
 * as in the editor and what a commit settles on.
 *
 * Zero is `0:00`, not blank. `duration_sec >= 0` admits it and the old field
 * could store it, and a zero drawn as an empty field would be re-saved as NULL
 * by the editor's DELETE-and-reinsert — rewriting a set nobody touched.
 */
export function secondsToClock(seconds: number): string {
  if (!Number.isFinite(seconds)) return '';
  const digits = secondsToDigits(seconds);
  return digits === '' ? '0:00' : digitsToClock(digits);
}

/**
 * The buffer a text is in its own right, when it is one this module draws:
 * digits and colons only, spelled exactly as {@link digitsToClock} spells its
 * own digits. `1:30`, `0:05`, `1:90` and `10:40:39` are; `90`, `5:`, `45:0`
 * and `0:00` are not.
 */
function drawnDigits(text: string): string | null {
  if (!/^[0-9:]+$/.test(text)) return null;
  const digits = text.replace(/:/g, '').replace(/^0+/, '');
  return digits !== '' && digitsToClock(digits) === text ? digits : null;
}

/**
 * The buffer a field's text opens as, so a single Backspace edits its last
 * digit (`1:30` → `130`, and Backspace gives `0:13`).
 *
 * A text this module drew is its own digits, normalised or not. Anything else
 * was typed on the old punctuation keyboard and survives in a draft written by
 * an earlier build — and there a bare `90` meant ninety SECONDS (`parseClock`'s
 * "no colon means seconds"), not `0:90`. It is read the way it was typed,
 * through `parseClock`, so the field draws exactly the seconds that would be
 * saved: `90` opens as `1:30`, `5:` as `5:00`. Unreadable text is empty.
 */
export function clockToDigits(text: string): string {
  const drawn = drawnDigits(text);
  if (drawn !== null) return drawn;
  const seconds = parseClock(text);
  return seconds == null ? '' : secondsToDigits(seconds);
}

/**
 * What the field draws for the text it holds: the text itself when it is one
 * this module drew (so `1:90` stays `1:90` until commit), otherwise the normal
 * clock of the seconds it will save. A zero reads `0:00` — see
 * {@link secondsToClock} for why it is not blank.
 */
export function clockFieldShows(text: string): string {
  if (drawnDigits(text) !== null) return text;
  const seconds = parseClock(text);
  return seconds == null ? '' : secondsToClock(seconds);
}

/**
 * One keystroke on the number pad.
 *
 *   - a digit shifts in from the right; a leading zero is not a digit (it moves
 *     nothing on the clock and would spend one of the five places), and past
 *     {@link CLOCK_ENTRY_MAX_DIGITS} the digit is refused;
 *   - Backspace shifts the last digit out, and on an empty buffer does nothing;
 *   - any other key changes nothing.
 *
 * `replace` is the select-on-focus rule (A3): the field was focused holding a
 * value, so the FIRST digit starts a new number instead of joining the old one.
 * A first Backspace is not a replacement — it still shifts one digit out, which
 * is the correction a filled field is opened to make (`1:30` → `0:13`). Where
 * the two rules could collide, on the first key, they split by key: a digit
 * means "a new number", Backspace means "fix this one".
 *
 * `key` is what React Native's `onKeyPress` reports: a character, or
 * `Backspace`. A string of several digits is taken one digit at a time.
 */
export function pressClockKey(digits: string, key: string, replace = false): string {
  if (key === 'Backspace') return digits.slice(0, -1);
  if (!/^[0-9]+$/.test(key)) return digits;
  let next = replace ? '' : digits;
  for (const digit of key) {
    if (next === '' && digit === '0') continue;
    if (next.length >= CLOCK_ENTRY_MAX_DIGITS) break;
    next += digit;
  }
  return next;
}

/**
 * The text a field settles on when editing ends: the same seconds in normal
 * form — `1:90` → `2:30`, `60:00` → `1:00:00`, a legacy `90` → `1:30`.
 * Idempotent, empty stays empty, and it never changes the stored value: only
 * the spelling moves. Text `parseClock` cannot read commits to empty, which is
 * what the field was already drawing and what would already have been saved.
 */
export function commitClock(text: string): string {
  const seconds = parseClock(text);
  return seconds == null ? '' : secondsToClock(seconds);
}
