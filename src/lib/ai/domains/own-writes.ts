/**
 * What THIS conversation's Coach wrote — the only rows `delete_record` may
 * remove from a domain that is a record of a day.
 *
 * ## Why this exists at all
 *
 * The owner's Q2 answer (2026-09-19) is: *edit any logged row behind the
 * before → after card; delete only a row this conversation's Coach wrote, as
 * undo.* The second half needs an answer to "did you write this?", and the
 * honest one is already on disk: every write tool returns the new row's id in
 * its result, `coach-service.ts` records that result verbatim in
 * `CoachToolCall.result`, and `ai-chat.ts` persists the whole array in
 * `ai_messages.tool_calls`. So the undo set DERIVES, with no migration and no
 * new column.
 *
 * ## Why it is scoped to the thread rather than to "the Coach, ever"
 *
 * "The Coach wrote it" would be a licence over every row it ever logged,
 * forever, which is not undo — it is history. A thread is the span in which
 * "no, delete that" means something, and it is the span the user can see: the
 * receipt is a few lines up.
 *
 * ## What it deliberately does not do
 *
 * It reads only calls that LANDED — not declined, not errored — because a
 * declined write wrote nothing and an errored one has no row to undo. And it
 * collects ids from the tool RESULT rather than the input: the input is what
 * the model asked for, the result is what the repository actually made.
 */
import type { Database } from '@/lib/db/database';
import { listRecentMessages, parseToolCalls } from '@/lib/db/repositories/ai-chat';

/** How far back in one thread the undo set reaches. The thread's own page size. */
const UNDO_WINDOW_MESSAGES = 100;

/**
 * Every row id this conversation's Coach created, from the tool results it
 * recorded. Empty when there is no conversation (a headless call, a test that
 * did not set one), which is the fail-closed answer: with no evidence that the
 * Coach wrote a row, it may not remove it.
 */
export function idsWrittenInConversation(
  db: Database,
  conversationId: string | undefined
): Set<string> {
  const ids = new Set<string>();
  if (!conversationId) return ids;
  for (const message of listRecentMessages(db, conversationId, UNDO_WINDOW_MESSAGES)) {
    for (const call of parseToolCalls(message.tool_calls)) {
      if (call.declined || call.isError) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(call.result);
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const id = (parsed as { id?: unknown }).id;
      if (typeof id === 'string' && id.length > 0) ids.add(id);
    }
  }
  return ids;
}
