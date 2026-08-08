/**
 * The Coach conversation store (0008_ai_chat.sql, 0028_ai_message_turn_outcome.sql):
 * threads and their turns.
 *
 * Messages are append-only — a turn is written once, after it finishes, and
 * never edited. The conversation row's updated_at doubles as "last activity"
 * (appending a turn touches it), so "resume the latest thread" is one indexed
 * read. Depends only on the {@link Database} interface — never op-sqlite — so
 * the same code runs on device and against node:sqlite in db/ai-chat.test.mjs.
 *
 * Since 0028 every turn also records HOW it ended (`turn_outcome`). That column
 * is the difference between a transcript and an audit trail: a reply cut off at
 * max_tokens after the user approved a write must still, after a reload, be
 * readable as "the write landed, the reply did not finish" — not as an ordinary
 * complete answer. Retry never deletes the fragment it replaces; the superseded
 * mark is derived from row order instead (see {@link markSupersededTurns}), so
 * the table stays genuinely append-only and the live thread and a reloaded one
 * cannot disagree.
 */
import type { Database } from '../database';
import { newId } from '../id';
import type { AiTurnOutcome } from '../types';
import type {
  AiConversationRow,
  AiMessageRow,
  AiMessageRole,
  CoachStopReason,
  CoachToolCall,
} from '@/lib/ai/types';

/**
 * One `ai_messages` row as a SELECT returns it today — the 0008 shape plus the
 * 0028 outcome column. (`AiMessageRow` lives in src/lib/ai/types.ts by the
 * parallel-work convention; this intersection is where the two meet until the
 * integrator folds them together.)
 */
export type AiMessageRecord = AiMessageRow & { turn_outcome: AiTurnOutcome };

/**
 * A thread row ready to render: the stored turn plus whether a later retry
 * replaced it. `superseded` is derived, never stored — see the module note.
 */
export type AiThreadEntry = AiMessageRecord & { superseded: boolean };

/** Create a new (untitled) conversation; returns its id. */
export function createConversation(db: Database, title: string | null = null): string {
  const id = newId(db);
  db.run('INSERT INTO ai_conversations (id, title) VALUES (?, ?)', [id, title]);
  return id;
}

/** The most recently active conversation, or undefined on first run. */
export function latestConversation(db: Database): AiConversationRow | undefined {
  return db.get<AiConversationRow>(
    'SELECT * FROM ai_conversations ORDER BY updated_at DESC, id LIMIT 1'
  );
}

/**
 * The thread to resume on open: the latest conversation, created if none
 * exists yet. One thread for now — "new conversation" UX comes with history.
 */
export function getOrCreateActiveConversation(db: Database): AiConversationRow {
  const existing = latestConversation(db);
  if (existing) return existing;
  const id = createConversation(db);
  return db.get<AiConversationRow>('SELECT * FROM ai_conversations WHERE id = ?', [id])!;
}

/** Set a conversation's title (e.g. from its first user message). */
export function setConversationTitle(db: Database, id: string, title: string): void {
  db.run('UPDATE ai_conversations SET title = ? WHERE id = ?', [title, id]);
}

/**
 * Append one turn. `toolCalls` is the agentic record of the turn (assistant
 * turns that used tools); stored as JSON, NULL when there were none.
 * `turnOutcome` records how the turn ENDED (0028) — the caller must pass the
 * real outcome for an assistant turn; the 'complete' default exists for user
 * turns, which are whole by construction. Also touches the parent conversation
 * so updated_at tracks last activity. Returns the new message id.
 */
export function appendMessage(
  db: Database,
  conversationId: string,
  role: AiMessageRole,
  content: string,
  toolCalls: CoachToolCall[] | null = null,
  turnOutcome: AiTurnOutcome = 'complete'
): string {
  const id = newId(db);
  db.transaction(() => {
    db.run(
      'INSERT INTO ai_messages (id, conversation_id, role, content, tool_calls, turn_outcome) VALUES (?, ?, ?, ?, ?, ?)',
      [
        id,
        conversationId,
        role,
        content,
        toolCalls && toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
        turnOutcome,
      ]
    );
    // Touch the parent so "latest conversation" reflects activity, not creation.
    db.run('UPDATE ai_conversations SET updated_at = updated_at WHERE id = ?', [conversationId]);
  });
  return id;
}

/**
 * A conversation's turns, oldest first (the render order). Same-millisecond
 * timestamps tie-break on rowid — true insertion order — because a random
 * UUID id would shuffle a user turn and its reply written in the same tick.
 */
export function listMessages(db: Database, conversationId: string): AiMessageRecord[] {
  return db.all<AiMessageRecord>(
    'SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY created_at, rowid',
    [conversationId]
  );
}

/**
 * Mark the turns a retry replaced.
 *
 * Retry appends a fresh assistant turn instead of deleting the fragment that
 * failed, so a thread can hold two (or more) consecutive assistant rows
 * answering one user turn. All but the last of such a run are superseded. The
 * rule is positional and total: every assistant row directly followed by
 * another assistant row was replaced by it.
 *
 * Deriving rather than storing is what keeps the record and the screen in
 * agreement — there is no second copy of the truth to fall out of date, and
 * ai_messages never takes an UPDATE. Generic over anything role-shaped so the
 * stored rows and the chat view-models are marked by the ONE rule rather than
 * two copies of it. Input must be in thread order ({@link listMessages}).
 */
export function markSupersededTurns<T extends { role: string }>(
  rows: readonly T[]
): (T & { superseded: boolean })[] {
  return rows.map((row, index) => ({
    ...row,
    superseded: row.role === 'assistant' && rows[index + 1]?.role === 'assistant',
  }));
}

/** The thread as it should be rendered: stored turns, superseded ones marked. */
export function listThread(db: Database, conversationId: string): AiThreadEntry[] {
  return markSupersededTurns(listMessages(db, conversationId));
}

/**
 * The wire stop reason a Coach turn ended on → the stored outcome vocabulary.
 * Total over {@link CoachStopReason} so a new member is a compile error here
 * rather than a turn silently recorded as complete.
 */
export function outcomeForStopReason(stopReason: CoachStopReason): AiTurnOutcome {
  switch (stopReason) {
    case 'max_tokens':
      return 'truncated';
    case 'tool_use_limit':
      return 'tool_limit';
    case 'refusal':
      return 'refused';
    case 'end_turn':
      return 'complete';
  }
}

/** Parse a stored tool_calls JSON column back into records. Corrupt → empty. */
export function parseToolCalls(toolCalls: string | null): CoachToolCall[] {
  if (!toolCalls) return [];
  try {
    const parsed = JSON.parse(toolCalls) as unknown;
    return Array.isArray(parsed) ? (parsed as CoachToolCall[]) : [];
  } catch {
    return [];
  }
}

/**
 * The tool calls in a turn whose effects actually landed: approved (not
 * declined) and not an error. `isWrite` names which of them mutate the record —
 * the tool registry knows (`CoachTool.readOnly`), and passing it in keeps this
 * layer free of an import from the AI layer.
 *
 * This is what lets a cut-off turn tell the user the truth: the reply stopped,
 * but these writes are already in the database.
 */
export function landedWriteCalls(
  toolCalls: CoachToolCall[],
  isWrite: (name: string) => boolean
): CoachToolCall[] {
  return toolCalls.filter((call) => !call.declined && !call.isError && isWrite(call.name));
}
