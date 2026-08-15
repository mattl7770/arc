/**
 * Assembling the conversation history the model actually sees.
 *
 * PURE — no expo, no database, no model client — so the same code runs on
 * device and in db/coach-memory.test.mjs. (coach-service.ts imports
 * `expo/fetch` at module load and can never be loaded headlessly, which is
 * why this lives beside it rather than inside it.)
 *
 * Two things happen here that the naive "map role+content" did not do:
 *
 *   1. Each assistant turn carries a DIGEST of what its tools returned. The
 *      model's prior messages are replayed as prose, so without this it cannot
 *      see the numbers it cited two turns ago — it either burns round-trips
 *      re-reading them or paraphrases its own paraphrase and drifts from the
 *      data. Replaying real tool_use/tool_result blocks would be faithful but
 *      unbounded; a truncated digest keeps the facts in view at fixed cost.
 *
 *   2. The rolling summary of turns that have aged out of the window is
 *      prepended, so a months-long thread degrades into a précis instead of
 *      silently losing its first half.
 *
 *   3. Turns carry a DAY STAMP at each calendar boundary, so the model can tell
 *      how old the conversation it is reading actually is. See the block
 *      comment in {@link buildWireHistory} — this was the cause of the Coach
 *      re-raising stale suggestions, and it is two lines of arithmetic.
 */
import type { ChatMessage } from '@/types/coach';

import type { WireMessage } from './model-client';
import { TRUNCATION_MARKER, type CoachToolCall } from './types';

/** Bound the request: the model doesn't need the whole thread forever. */
export const MAX_HISTORY_MESSAGES = 30;

/** Cap on one replayed tool digest, so history can't be swamped by one read. */
const TOOL_DIGEST_CHARS = 240;

/**
 * The LOCAL calendar day of an instant, as a day index since the epoch.
 *
 * Local, not UTC: a turn at 23:40 belongs to the day the owner's wall clock
 * said, the same rule `todayISODate` applies everywhere else. Computed inline
 * rather than imported so this module keeps the purity its header claims (no
 * database, no expo) — and Hermes has no `Intl` to lean on anyway.
 */
function localDayIndex(ms: number): number {
  const at = new Date(ms);
  return Math.floor((ms - at.getTimezoneOffset() * 60_000) / 86_400_000);
}

/**
 * "today" / "yesterday" / "4 days ago" — the age of a turn, hand-rolled.
 *
 * CLAMPED AT ZERO, and that is not defensive padding. `created_at` is stamped
 * by SQLite's `strftime('now')`, which reads a finer clock than `Date.now()` on
 * Windows, so a turn written moments ago can measure as fractionally in the
 * FUTURE. Without the clamp the newest turn in the thread would occasionally be
 * labelled "-1 days ago", which is worse than no label at all.
 */
function ageLabel(daysAgo: number): string {
  const days = Math.max(0, daysAgo);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/**
 * Render a past turn's tool record as a compact digest. Declines are marked so
 * the model can see what the user refused; the truncation sentinel (a
 * persistence detail, not a tool) never reaches the model.
 */
export function toolDigest(calls: CoachToolCall[]): string {
  const parts = calls
    .filter((call) => call.name !== TRUNCATION_MARKER)
    .map((call) => {
      if (call.declined) return `${call.name}: declined by user`;
      if (call.isError) return `${call.name}: error`;
      const result = (call.result ?? '').replace(/\s+/g, ' ').trim();
      return `${call.name} → ${
        result.length > TOOL_DIGEST_CHARS ? `${result.slice(0, TOOL_DIGEST_CHARS)}…` : result
      }`;
    });
  return parts.length === 0 ? '' : `\n\n[tools this turn: ${parts.join(' | ')}]`;
}

/**
 * The wire history for one turn: the last {@link MAX_HISTORY_MESSAGES}
 * messages, each assistant turn carrying its tool digest, optionally preceded
 * by the rolling summary of everything older.
 */
export function buildWireHistory(
  history: ChatMessage[],
  priorSummary?: string | null,
  now: Date = new Date()
): WireMessage[] {
  // Render FIRST, then drop what renders empty. A turn can legitimately have no
  // prose — the reply was cut off, or the model called a tool and stopped — and
  // filtering on `content` alone discarded the one record of what it read or
  // wrote. That is the opposite of this module's purpose: the digest is
  // precisely what keeps the numbers the Coach cited in view.
  //
  // trim(): with no prose the digest would otherwise arrive behind two blank
  // lines, and a content block that is only whitespace is rejected by the API.
  const today = localDayIndex(now.getTime());
  const dated = history
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({
      role: m.role,
      content:
        m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0
          ? `${m.content}${toolDigest(m.toolCalls)}`.trim()
          : m.content.trim(),
      // NaN for an unparseable stamp (loadThread does Date.parse on the stored
      // text). Kept as null so such a turn inherits its neighbour's day rather
      // than inventing a boundary.
      daysAgo: Number.isFinite(m.createdAt) ? today - localDayIndex(m.createdAt) : null,
    }))
    .filter((m) => m.content.length > 0);

  // The API requires the first message to be a user turn — the window boundary
  // can land mid-pair, so shed any leading assistant turns. Done BEFORE the day
  // stamps below so the first stamp always survives onto a turn that ships.
  while (dated.length > 0 && dated[0]!.role !== 'user') dated.shift();

  // --- DAY BOUNDARIES: the fix for "it needs to move past things when time has
  // passed" (owner, 2026-08-14).
  //
  // The thread the model receives was a plain list of role+content, with no
  // timestamp anywhere on it. The "Current state" block gives it today's date,
  // but every prior turn arrived undated — so a conversation spanning four days
  // read as one unbroken present, and a dinner discussed on Monday was still
  // live business on Thursday. That is the whole of the owner's second report:
  // the Coach re-raised a two-day-old suggestion because nothing in its input
  // said two days had passed. It was not ignoring the age of the thing; it
  // could not see it.
  //
  // Stamped ON CHANGE ONLY, plus the first turn. A same-day thread costs one
  // "[today]" (~4 tokens); a week-long one costs a handful. Marking every turn
  // would be several times the price for information that only changes at the
  // boundary. Ages are relative, not absolute dates, because the judgment the
  // model has to make is about elapsed time, and "3 days ago" states that
  // directly while "2026-08-11" makes it do arithmetic against another block.
  let previousDay: number | null = null;
  const messages: WireMessage[] = dated.map(({ role, content, daysAgo }) => {
    if (daysAgo === null || daysAgo === previousDay) return { role, content };
    previousDay = daysAgo;
    return { role, content: `[${ageLabel(daysAgo)}]\n${content}` };
  });

  // Everything older than the window is gone unless it was summarised. Fold it
  // into the first user turn rather than adding a synthetic message, so the
  // alternating user/assistant shape the API wants is preserved.
  const summary = priorSummary?.trim();
  if (summary && messages.length > 0 && messages[0]!.role === 'user') {
    messages[0] = {
      role: 'user',
      content: `[Earlier in this conversation: ${summary}]\n\n${messages[0]!.content}`,
    };
  }
  return messages;
}
