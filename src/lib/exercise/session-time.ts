/**
 * How long a session took — the live clock's start instant and a logged
 * session's minutes. Pure, so db/exercise.test.mjs pins it without a component.
 *
 * Owner, on the device, 2026-09-23: *"workout duration should be editable."*
 *
 * ## What is stored, and so what is edited
 *
 * A `workouts` row carries `duration_min` (a figure, 0003) and, for a session
 * the live logger timed, `started_at` (an instant, 0054). There is no end
 * column; the span pairing reads is `started_at + duration_min`. So:
 *
 *   - **A logged session edits the figure.** Nothing new is stored and nothing
 *     is derived twice. Its start is left where it was: correcting "that took 60
 *     minutes, not 20" moves the end, which is the fact that was wrong.
 *   - **A live session edits the START**, never the elapsed number. Both the
 *     duration and `started_at` that Finish writes are computed from that one
 *     instant, so moving it moves both together — "I forgot to press start ten
 *     minutes ago" is a statement about when the session began, and the clock
 *     on screen changes the moment it is made.
 *
 * Every reader of a duration reads the column at query time — the hub's
 * session line, the week's cardio minutes, the Coach's training summary and its
 * daily series, the pairing pass — so an edited figure is what all of them see
 * next. Nothing copies it. Readiness strain does not read it at all (it grades
 * logged SETS, src/lib/home/readiness.ts), and ARC computes no calorie figure
 * from it: kcal only ever comes from a paired watch record, joined, not copied.
 */

/**
 * The longest elapsed time still recorded as a session duration. Past it,
 * Finish stores no duration at all — a draft resumed days later would
 * otherwise record a multi-day "session". Moved here from app/workout-live.tsx
 * (2026-09-23), because the start adjustment below is bounded by it too: a start
 * the clamp would discard is not a start worth offering.
 */
export const MAX_SESSION_MIN = 6 * 60;

/** How far one press of the live logger's start adjustment moves the start. */
export const START_STEP_MIN = 5;

/**
 * The start instant moved by `deltaMin`, clamped to the range a session can
 * honestly have started in — not after `now`, not more than
 * {@link MAX_SESSION_MIN} before it. Returns `null` when the clamp leaves
 * nothing to move (already at that bound), so the control can be drawn off
 * instead of taking a press that does nothing.
 *
 * A start that is ALREADY past the bound (a draft resumed the next day) can
 * still move later, towards the range, but never further back.
 */
export function shiftSessionStart(startedAt: number, deltaMin: number, now: number): number | null {
  const earliest = now - MAX_SESSION_MIN * 60_000;
  let next = startedAt + deltaMin * 60_000;
  if (deltaMin < 0) {
    if (startedAt <= earliest) return null;
    next = Math.max(next, earliest);
  } else if (next > now) {
    next = now;
  }
  return next === startedAt ? null : next;
}

/** The result of reading the logged-session editor's minutes field. */
export type DurationField = { ok: true; minutes: number | null } | { ok: false };

/**
 * The editor's minutes field, read. Blank is a real answer — "no duration",
 * stored NULL, which every reader already treats as unknown. Otherwise whole
 * minutes from 1 to 999: the manual logger's own bound, and comfortably inside
 * the schema's `duration_min >= 0` CHECK. Zero is refused rather than stored,
 * because "0 min" is a lie about a session that happened; blank says it better.
 */
export function parseDurationField(text: string): DurationField {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, minutes: null };
  if (!/^\d{1,3}$/.test(trimmed)) return { ok: false };
  const minutes = Number(trimmed);
  return minutes >= 1 ? { ok: true, minutes } : { ok: false };
}
