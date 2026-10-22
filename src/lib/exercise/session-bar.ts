/**
 * The session bar's decisions (item 71) — pure, so db/exercise.test.mjs and the
 * render suite can pin them without a navigator.
 *
 * Owner, on the device: *"should be able to use the rest of the app while in an
 * exercise session."* Leaving the logger has kept the session since 2026-09-23
 * (drafts, 0045), Home has a Resume row and the Train hub a card — but neither
 * is on screen while he is in Eat or Labs, and neither says how long the rest
 * has left. So a slim bar sits above the tab bar (and at the foot of every
 * pushed screen) for as long as a session is open, and is one tap back to it.
 *
 * ## It reads the logger's state; it keeps none of its own
 *
 * There is one session and one rest, and both live in the `live` draft slot:
 * the logger writes `startedAt` and `restEndsAt` through on every change, as
 * absolute instants. The bar reads that row ({@link readOpenLiveSession}) and
 * computes what to show from those two instants and the clock
 * ({@link sessionBarView}) — the same arithmetic the logger does on its own
 * one-second tick, so the two cannot read differently at the same moment.
 * It schedules nothing and counts nothing down: there is no second timer, only
 * a second reader of the one target instant. The OS "Rest complete" alert stays
 * the logger's, adopted and cancelled through `restAlertId` exactly as before.
 *
 * Nothing writes the live slot except the focused logger, and the bar is never
 * shown on the logger — so while the bar is visible the row is still, and a
 * re-read on each announced write (`subscribeWorkoutDrafts`) is all it needs —
 * of the live slot only ({@link barHearsSlot}), and kept when it would draw
 * the same bar ({@link sameSessionBar}).
 */
import type { Database } from '@/lib/db/database';
import { getRoutine } from '@/lib/db/repositories/routines';
import { readWorkoutDraft } from '@/lib/db/repositories/workout-drafts';
import { parseLiveDraft, type LiveDraft } from '@/lib/exercise/draft';
import { formatClock } from '@/lib/exercise/format';

/** The live logger's route name — the one screen the bar is never drawn on. */
export const LIVE_LOGGER_ROUTE = 'workout-live';

/**
 * Where a tap on the bar goes when no live logger is on the stack: the live
 * logger, resuming the slot — the same href Home's Resume row and the Train
 * hub's card push. With one lower in the stack the tap goes BACK to it
 * (`restTapTarget`, as the "Rest complete" tap does), never a second logger.
 */
export const LIVE_LOGGER_RESUME = {
  pathname: '/workout-live',
  params: { resume: '1' },
} as const;

/** What the bar is drawn from: the open session, and what to call it. */
export type OpenLiveSession = {
  draft: LiveDraft;
  /** The saved workout's name when it was started from one, else "Workout" — the logger's own title. */
  name: string;
};

/**
 * The open live session, or null when there is none. The gate is
 * `parseLiveDraft` — the same one Home's row, the hub's card and the logger's
 * resume read through — so the bar cannot offer a session they would not.
 * A routine deleted since the session started still names nothing, so the bar
 * falls back to the logger's title rather than to an id.
 */
export function readOpenLiveSession(db: Database): OpenLiveSession | null {
  const draft = parseLiveDraft(readWorkoutDraft(db, 'live')?.value ?? null);
  if (!draft) return null;
  const routine = draft.routineId ? getRoutine(db, draft.routineId) : undefined;
  const name = routine?.name.trim() ? routine.name.trim() : 'Workout';
  return { draft, name };
}

/**
 * Would `next` draw the same bar as `prev`? The hosts keep the session they
 * have when it would (review, 2026-10-21): the logger writes the live slot on
 * every keystroke, and each mounted host — the tab bar's copy under the logger,
 * any pushed screen under it — re-read it and re-rendered with a fresh object
 * each time, for a bar that had not changed. Compared on what
 * {@link sessionBarView} reads and nothing else (the session, its name, its
 * start, its rest, whether it is a watch fill), so a kept object may carry an
 * older `draft.blocks`: nothing the bar draws reads them, and nothing may.
 */
export function sameSessionBar(
  prev: OpenLiveSession | null,
  next: OpenLiveSession | null
): boolean {
  if (prev === null || next === null) return prev === next;
  return (
    prev.name === next.name &&
    prev.draft.sessionId === next.draft.sessionId &&
    prev.draft.startedAt === next.draft.startedAt &&
    prev.draft.restEndsAt === next.draft.restEndsAt &&
    prev.draft.ingestId === next.draft.ingestId
  );
}

/** Does a write to this draft slot concern the bar? Only the live slot does. */
export function barHearsSlot(key: string): boolean {
  return key === 'live';
}

/**
 * Whole seconds of rest left at `now`, or null when no rest is set. The
 * logger's own expression (`app/workout-live.tsx`, `restRemaining`), character
 * for character — the render suite pins that the two still match, because a
 * bar that rounded differently would read 0:01 beside a logger reading 0:00.
 */
export function restRemainingSec(restEndsAt: number | null, now: number): number | null {
  return restEndsAt == null ? null : Math.max(0, Math.round((restEndsAt - now) / 1000));
}

/** The rest half of the bar: counting, finished, or nothing to say. */
export type SessionBarRest = { kind: 'running'; clock: string } | { kind: 'done' } | null;

export type SessionBarView = {
  name: string;
  /** `m:ss` since the session started, or null for a watch-session fill (it already happened). */
  elapsed: string | null;
  rest: SessionBarRest;
  /** What VoiceOver reads for the whole bar, which is one button. */
  accessibilityLabel: string;
};

/**
 * What the bar shows at `now`.
 *
 *   - **Elapsed** is counted from `startedAt`, as the logger's clock line is —
 *     a resumed or killed-and-relaunched session reads its real age. A session
 *     filling in a watch session (`ingestId`) has no running clock in the
 *     logger either (it shows the day and the watch's minutes), so it shows none
 *     here.
 *   - **Rest** counts down to `restEndsAt` and, once it is reached, reads
 *     **done** — and stays done. A rest that ran out is over (the draft's own
 *     words), and "time for the next set" stays true until a set is logged,
 *     which can only happen in the logger, which starts or clears the next rest.
 */
export function sessionBarView(session: OpenLiveSession, now: number): SessionBarView {
  const { draft, name } = session;
  const elapsed = draft.ingestId == null ? formatClock((now - draft.startedAt) / 1000) : null;
  const left = restRemainingSec(draft.restEndsAt, now);
  const rest: SessionBarRest =
    left == null
      ? null
      : left > 0
        ? { kind: 'running', clock: formatClock(left) }
        : { kind: 'done' };
  const spoken = [`${name} in progress`];
  if (elapsed) spoken.push(`${elapsed} elapsed`);
  if (rest?.kind === 'running') spoken.push(`rest ${rest.clock} left`);
  if (rest?.kind === 'done') spoken.push('rest done');
  return {
    name,
    elapsed,
    rest,
    accessibilityLabel: `${spoken.join(', ')}. Return to the workout`,
  };
}

/**
 * Does a PUSHED screen draw the bar at its foot? Only a screen in a stack, and
 * never the live logger itself.
 *
 * A screen inside the tab navigator draws nothing: there the bar belongs to the
 * tab bar (`app/(tabs)/_layout.tsx`), which already sits under every tab root,
 * and a second copy in the screen would stack two. An unknown navigator (a
 * render with no navigation state) draws nothing either — the safe error is a
 * missing shortcut, not a doubled one.
 */
export function sessionBarOnScreen(
  navigatorType: string | undefined,
  routeName: string | undefined
): boolean {
  return navigatorType === 'stack' && routeName !== LIVE_LOGGER_ROUTE;
}
