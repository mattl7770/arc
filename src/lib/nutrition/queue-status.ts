/**
 * Where a queued estimate stands, read off its `pending_estimates` row — the
 * pure half of the re-billing fix (2026-10-21, Track 0 item 1).
 *
 * ## The bug this exists for
 *
 * Until 2026-10-21 a queued estimate that failed for a reason waiting cannot
 * fix — an unreadable reply, a refusal, a 400/401/429 — stayed in the queue and
 * was re-sent, and RE-BILLED, on every app open and every foreground, with no
 * cap. `attempts` only counted. db/nutrition-v2.test.mjs §25b counts the model
 * calls across several drains to prove it is gone.
 *
 * ## The rule now
 *
 * Every failure is classified (estimate-queue.ts `classifyQueueFailure`) into
 * one of three dispositions, and the row's two existing columns carry the
 * result — no migration:
 *
 *   - WAIT — nothing reached the model, so nothing was billed: no connection,
 *     no key, an abort. The row keeps its place and is tried again on the next
 *     drain, for free. `attempts` does not move.
 *   - RETRY — a transient failure that may have reached the model: a stream
 *     that died mid-reply, a 5xx, a 529 overloaded, a 429 rate limit (it lifts
 *     by itself; until the 2026-10-21 review it parked). `attempts` goes up by one
 *     and the row waits {@link QUEUE_BACKOFF_MS} by ELAPSED TIME (from
 *     `updated_at`, which the row's trigger stamps on every write) before it is
 *     sent again — so opening the app ten times in a minute sends it once.
 *     At {@link QUEUE_MAX_ATTEMPTS} it is parked.
 *   - PARK — a failure the same request will meet again: `attempts` is set to
 *     the cap at once, and the drain never sends it again by itself.
 *
 * So PARKED is one fact: `attempts >= QUEUE_MAX_ATTEMPTS`. Why is the code at
 * the front of `last_error` (`unreadable: MealEstimateParseError: …`), written
 * by the one writer, and read back here into a plain sentence.
 *
 * ## A parked row is never dropped
 *
 * It holds the user's photo or his words, and the meal he can see. It stays,
 * says why on its meal's screen, and offers **Try again** (attempts back to 0,
 * one more drain) and **Enter by hand** (the request goes, the photo moves onto
 * the meal, the meal stays for him to fill in). Deleting the meal still takes
 * the row with it, as it always did.
 */
import type { PendingEstimateRow } from './types';

/** Counted attempts before a transient failure is parked. */
export const QUEUE_MAX_ATTEMPTS = 5;

/**
 * How long a row waits after its Nth counted failure before it is sent again:
 * 2 minutes, 10 minutes, 1 hour, 6 hours. The fifth failure parks it, a little
 * over seven hours after the first — long enough to ride out an outage, short
 * enough that a broken request is not sent all week.
 */
export const QUEUE_BACKOFF_MS: readonly number[] = [
  2 * 60_000,
  10 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
];

/** Why the last attempt failed — the prefix of `last_error`. */
export const QUEUE_FAILURE_CODES = [
  // WAIT: nothing was sent.
  'offline',
  'no_key',
  'aborted',
  // RETRY: transient, counted, backed off.
  'interrupted',
  'server',
  'rate_limited',
  // PARK: the same request will fail the same way.
  'auth',
  'rejected',
  'unreadable',
  'refused',
  'apply_failed',
  'failed',
] as const;

export type QueueFailureCode = (typeof QUEUE_FAILURE_CODES)[number];

/** What a drain does with a row after a failure (see the header). */
export type QueueDisposition = 'wait' | 'retry' | 'park';

/** `last_error` as the one writer composes it: the code, then the detail. */
export function composeLastError(code: QueueFailureCode, detail: string): string {
  return `${code}: ${detail}`.slice(0, 400);
}

/** The code at the front of `last_error`, or null (never failed, or a row
 *  written before codes existed). */
export function lastFailureCode(lastError: string | null): QueueFailureCode | null {
  if (!lastError) return null;
  const colon = lastError.indexOf(':');
  if (colon < 0) return null;
  const head = lastError.slice(0, colon);
  return (QUEUE_FAILURE_CODES as readonly string[]).includes(head)
    ? (head as QueueFailureCode)
    : null;
}

/** Has the drain stopped sending this row by itself? */
export function isParked(row: Pick<PendingEstimateRow, 'attempts'>): boolean {
  return row.attempts >= QUEUE_MAX_ATTEMPTS;
}

/**
 * Is the row due to be sent now? A fresh row (or one only ever WAITED) is due
 * at once; a counted failure waits out its backoff from `updated_at`; a parked
 * row is never due. An unreadable stamp counts as due rather than as stuck.
 */
export function isPendingEstimateDue(
  row: Pick<PendingEstimateRow, 'attempts' | 'updated_at'>,
  nowMs: number
): boolean {
  if (isParked(row)) return false;
  if (row.attempts <= 0) return true;
  const last = Date.parse(row.updated_at);
  if (!Number.isFinite(last)) return true;
  const wait = QUEUE_BACKOFF_MS[Math.min(row.attempts, QUEUE_BACKOFF_MS.length) - 1] ?? 0;
  return nowMs - last >= wait;
}

/** Where one queued estimate stands, for its meal's screen and its Eat-tab row. */
export type PendingEstimateStatus = {
  parked: boolean;
  code: QueueFailureCode | null;
  /** The meal row's one line on the Eat tab, under its name. */
  line: string;
  /** The meal screen's sentence: what happened, in plain words. */
  sentence: string;
};

/** Why a parked row stopped, as a sentence about the request, not an exception. */
function parkedSentence(code: QueueFailureCode | null): string {
  switch (code) {
    case 'auth':
      return 'Anthropic did not accept the API key, so the estimate was not made. Check the key in Settings › Coach.';
    case 'rate_limited':
      return `Anthropic turned the request away on a rate limit ${QUEUE_MAX_ATTEMPTS} times, so ARC stopped retrying.`;
    case 'rejected':
      return 'Anthropic rejected the request, so the estimate was not made.';
    case 'unreadable':
      return 'The model answered, but its answer could not be read as an estimate.';
    case 'refused':
      return 'The model declined to make this estimate.';
    case 'apply_failed':
      return 'The estimate came back but could not be saved to this meal.';
    case 'interrupted':
      return `The connection dropped mid-reply ${QUEUE_MAX_ATTEMPTS} times, so ARC stopped retrying.`;
    case 'server':
      return `Anthropic’s service failed ${QUEUE_MAX_ATTEMPTS} times in a row, so ARC stopped retrying.`;
    default:
      return 'The estimate could not be made.';
  }
}

/** Where a row stands. Pure; the screens draw it, they do not decide it. */
export function pendingEstimateStatus(
  row: Pick<PendingEstimateRow, 'attempts' | 'last_error'>
): PendingEstimateStatus {
  const code = lastFailureCode(row.last_error);
  if (isParked(row)) {
    return {
      parked: true,
      code,
      line: 'Estimate paused — tap to retry or enter it',
      sentence: `${parkedSentence(code)} It is kept here, with what you sent, and is not sent again by itself.`,
    };
  }
  if (code === 'no_key') {
    return {
      parked: false,
      code,
      line: 'Estimate pending — needs an API key',
      sentence: 'Waiting for an API key. Add one in Settings › Coach and the estimate is made.',
    };
  }
  if (code === 'interrupted' || code === 'server' || code === 'rate_limited') {
    return {
      parked: false,
      code,
      line: 'Estimate pending — will retry',
      sentence: 'The last try did not finish. ARC tries again shortly, a few times at most.',
    };
  }
  return {
    parked: false,
    code,
    line: 'Estimate pending — offline',
    sentence: 'Waiting for a connection. The estimate is made the next time ARC opens online.',
  };
}
