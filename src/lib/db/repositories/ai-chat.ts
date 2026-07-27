/**
 * The Coach conversation store (0005_ai_chat.sql): threads and their turns.
 *
 * Messages are append-only — a turn is written once, after it finishes, and
 * never edited. The conversation row's updated_at doubles as "last activity"
 * (appending a turn touches it), so "resume the latest thread" is one indexed
 * read. Depends only on the {@link Database} interface — never op-sqlite — so
 * the same code runs on device and against node:sqlite in db/ai-chat.test.mjs.
 */
import type { Database } from '../database';
import { newId } from '../id';
import type { AiConversationRow, AiMessageRow, AiMessageRole, CoachToolCall } from '@/lib/ai/types';

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
 * turns that used tools); stored as JSON, NULL when there were none. Also
 * touches the parent conversation so updated_at tracks last activity. Returns
 * the new message id.
 */
export function appendMessage(
  db: Database,
  conversationId: string,
  role: AiMessageRole,
  content: string,
  toolCalls: CoachToolCall[] | null = null
): string {
  const id = newId(db);
  db.transaction(() => {
    db.run(
      'INSERT INTO ai_messages (id, conversation_id, role, content, tool_calls) VALUES (?, ?, ?, ?, ?)',
      [
        id,
        conversationId,
        role,
        content,
        toolCalls && toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
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
export function listMessages(db: Database, conversationId: string): AiMessageRow[] {
  return db.all<AiMessageRow>(
    'SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY created_at, rowid',
    [conversationId]
  );
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
