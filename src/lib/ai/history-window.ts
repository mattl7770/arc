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
 */
import type { ChatMessage } from '@/types/coach';

import type { WireMessage } from './model-client';
import { TRUNCATION_MARKER, type CoachToolCall } from './types';

/** Bound the request: the model doesn't need the whole thread forever. */
export const MAX_HISTORY_MESSAGES = 30;

/** Cap on one replayed tool digest, so history can't be swamped by one read. */
const TOOL_DIGEST_CHARS = 240;

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
  priorSummary?: string | null
): WireMessage[] {
  // Render FIRST, then drop what renders empty. A turn can legitimately have no
  // prose — the reply was cut off, or the model called a tool and stopped — and
  // filtering on `content` alone discarded the one record of what it read or
  // wrote. That is the opposite of this module's purpose: the digest is
  // precisely what keeps the numbers the Coach cited in view.
  //
  // trim(): with no prose the digest would otherwise arrive behind two blank
  // lines, and a content block that is only whitespace is rejected by the API.
  const messages: WireMessage[] = history
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({
      role: m.role,
      content:
        m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0
          ? `${m.content}${toolDigest(m.toolCalls)}`.trim()
          : m.content.trim(),
    }))
    .filter((m) => m.content.length > 0);

  // The API requires the first message to be a user turn — the window boundary
  // can land mid-pair, so shed any leading assistant turns.
  while (messages.length > 0 && messages[0]!.role !== 'user') messages.shift();

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
