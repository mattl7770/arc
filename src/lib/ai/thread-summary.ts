/**
 * The rolling thread summary (0030 `ai_conversations.summary`) — what the
 * Coach would otherwise forget as a long conversation scrolls past its context
 * window.
 *
 * DETERMINISTIC on purpose. A model-written précis would read better, but this
 * must work offline, cost nothing, and never hallucinate a fact into the one
 * place the model will later treat as established history. So it extracts what
 * can be extracted honestly: the user's own words (truncated, never
 * paraphrased) and the writes that actually happened, both already in the DB.
 *
 * Pure over the {@link Database} interface, headless-tested in
 * db/coach-memory.test.mjs.
 */
import type { Database } from '@/lib/db/database';
import {
  countMessages,
  getConversationSummary,
  listOldestMessages,
  listRecentMessages,
  parseToolCalls,
  setConversationSummary,
} from '@/lib/db/repositories/ai-chat';
import type { AiMessageRow } from '@/lib/ai/types';
import { TRUNCATION_MARKER } from './types';

/**
 * Turns kept in the model's window (mirrors coach-service's
 * MAX_HISTORY_MESSAGES). Anything older is only ever seen through the summary.
 */
export const SUMMARY_WINDOW = 30;

/** Only start summarising once a thread is meaningfully past the window. */
export const SUMMARY_TRIGGER = 40;

/** How many characters of one user turn to keep verbatim. */
const USER_SNIPPET = 120;

/** How many extracted lines the summary may hold. */
const MAX_SUMMARY_LINES = 12;

/**
 * How many aged messages are read from each END of the aged region.
 *
 * {@link headAndTail} renders the middle as a one-line gap marker no matter how
 * large it is, so loading it was pure cost — and unbounded cost: this runs
 * after every completed turn, so a 2,000-turn thread re-read 2,000 rows (and
 * JSON-parsed every tool record on them) to produce twelve lines. Reading a
 * fixed slab from each end yields the same summary at constant cost.
 */
const AGED_HEAD_SCAN = 24;
const AGED_TAIL_SCAN = 36;

/**
 * Keep the HEAD and the TAIL when there are too many lines.
 *
 * Keeping only the most recent would drop exactly what a summary exists to
 * preserve: what set the thread up ("my knee has been sore since March") is
 * the oldest thing in it, and it is gone from the window forever. Keeping only
 * the head would freeze the summary at the conversation's beginning. So: the
 * first few, an explicit gap marker, and the most recent.
 */
function headAndTail(lines: string[], extraOmitted = 0, max = MAX_SUMMARY_LINES): string[] {
  if (lines.length <= max) {
    if (extraOmitted <= 0 || lines.length === 0) return lines;
    // The scan itself skipped turns; say so rather than implying continuity.
    const head = Math.ceil(lines.length / 2);
    return [...lines.slice(0, head), `…${extraOmitted} more…`, ...lines.slice(head)];
  }
  const head = Math.ceil(max / 3);
  const tail = max - head;
  return [
    ...lines.slice(0, head),
    `…${lines.length - max + extraOmitted} more…`,
    ...lines.slice(lines.length - tail),
  ];
}

/** One user message, condensed to a single quotable line. */
function userLine(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length > USER_SNIPPET ? `${flat.slice(0, USER_SNIPPET)}…` : flat;
}

/**
 * Build the summary of every turn that has aged OUT of the window, from the
 * persisted thread. Returns null when the thread is still short enough that
 * the model sees all of it — there is nothing to remember on its behalf.
 */
export function buildRollingSummary(db: Database, conversationId: string): string | null {
  const total = countMessages(db, conversationId);
  if (total <= SUMMARY_WINDOW) return null;
  const agedCount = total - SUMMARY_WINDOW;

  // Read only the ends of the aged region — see AGED_HEAD_SCAN.
  let aged: AiMessageRow[];
  let skipped = 0;
  if (agedCount <= AGED_HEAD_SCAN + AGED_TAIL_SCAN) {
    aged = listOldestMessages(db, conversationId, agedCount);
  } else {
    const head = listOldestMessages(db, conversationId, AGED_HEAD_SCAN);
    // The aged TAIL is the newest aged turns: take the window plus a slab, then
    // drop the window itself (which the model still sees in full).
    const withWindow = listRecentMessages(db, conversationId, SUMMARY_WINDOW + AGED_TAIL_SCAN);
    const tail = withWindow.slice(0, Math.max(0, withWindow.length - SUMMARY_WINDOW));
    skipped = Math.max(0, agedCount - head.length - tail.length);
    aged = [...head, ...tail];
  }

  const relevant = aged.filter((m) => m.role === 'user' || m.role === 'assistant');
  const saidLines: string[] = [];
  const didLines: string[] = [];

  for (const row of relevant) {
    if (row.role === 'user') {
      const line = userLine(row.content);
      if (line.length > 0) saidLines.push(line);
      continue;
    }
    // Assistant turns contribute only what they actually DID — a write that
    // ran is a fact; the prose around it is not worth carrying.
    for (const call of parseToolCalls(row.tool_calls)) {
      if (call.name === TRUNCATION_MARKER || call.declined || call.isError) continue;
      const input = call.input as Record<string, unknown> | null;
      const label =
        input && typeof input === 'object' && !Array.isArray(input)
          ? ['title', 'name', 'content', 'mode', 'metric', 'protocol_slug']
              .map((k) => input[k])
              .find((v): v is string => typeof v === 'string' && v.trim().length > 0)
          : undefined;
      didLines.push(label ? `${call.name} "${label.trim().slice(0, 60)}"` : call.name);
    }
  }

  const parts: string[] = [];
  if (saidLines.length > 0) {
    // `skipped` is attributed to the user lines only, so the gap is stated once
    // rather than double-counted across both halves of the summary.
    parts.push(`They said: ${headAndTail(saidLines, skipped).join(' · ')}`);
  }
  if (didLines.length > 0) {
    // Dedupe repeated actions (logging weight 40 times is one habit, not 40 facts).
    parts.push(`Actions taken: ${headAndTail([...new Set(didLines)]).join(' · ')}`);
  }
  return parts.length > 0 ? parts.join('. ') : null;
}

/**
 * Refresh the stored summary if the thread has outgrown the window. Called
 * after a completed turn; cheap (one read of the thread, one UPDATE) and a
 * no-op for short threads.
 */
export function updateRollingSummary(db: Database, conversationId: string): void {
  if (countMessages(db, conversationId) < SUMMARY_TRIGGER) return;
  const summary = buildRollingSummary(db, conversationId);
  if (summary && summary !== getConversationSummary(db, conversationId)) {
    setConversationSummary(db, conversationId, summary);
  }
}
