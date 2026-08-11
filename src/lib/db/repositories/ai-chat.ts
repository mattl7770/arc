/**
 * The Coach conversation store (0008_ai_chat.sql): threads and their turns.
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

/**
 * The most recent N messages of a thread, oldest-first — the paginated read
 * the screen uses so a months-long conversation doesn't load entirely into
 * React state on every mount. `listMessages` remains the full read for export.
 */
export function listRecentMessages(
  db: Database,
  conversationId: string,
  limit = 100
): AiMessageRow[] {
  const newestFirst = db.all<AiMessageRow>(
    'SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    [conversationId, limit]
  );
  return newestFirst.reverse();
}

/**
 * The OLDEST N messages of a thread, oldest-first — the mirror of
 * {@link listRecentMessages}. The rolling summary needs the start of a
 * conversation (what set it up) without reading the whole of it.
 */
export function listOldestMessages(
  db: Database,
  conversationId: string,
  limit: number
): AiMessageRow[] {
  return db.all<AiMessageRow>(
    'SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY created_at, rowid LIMIT ?',
    [conversationId, limit]
  );
}

/** Count of turns in a thread — how the caller knows it has aged past the window. */
export function countMessages(db: Database, conversationId: string): number {
  return (
    db.get<{ c: number }>('SELECT count(*) c FROM ai_messages WHERE conversation_id = ?', [
      conversationId,
    ])?.c ?? 0
  );
}

/** The stored rolling summary of turns that have aged out of the window. */
export function getConversationSummary(db: Database, conversationId: string): string | null {
  return (
    db.get<{ summary: string | null }>('SELECT summary FROM ai_conversations WHERE id = ?', [
      conversationId,
    ])?.summary ?? null
  );
}

export function setConversationSummary(
  db: Database,
  conversationId: string,
  summary: string
): void {
  db.run('UPDATE ai_conversations SET summary = ? WHERE id = ?', [summary, conversationId]);
}

/**
 * How far back a decline still counts as "recent". Long enough to stop the
 * Coach re-proposing the same thing next week, short enough that a no from two
 * months ago doesn't silently veto the subject forever.
 */
export const DECLINE_HORIZON_DAYS = 30;

/**
 * What the user has recently DECLINED at the confirmation gate, newest first,
 * as human lines ("set_mode deload").
 *
 * Without this, a decline lives exactly one turn: the "user declined" string
 * goes back to the model mid-turn and is then stripped with the rest of the
 * tool history, so the same suggestion returns forever. Feeding it into the
 * turn-context block is the cheapest possible form of learning from feedback,
 * and it rides entirely on rows already being written.
 */
export function recentDeclines(
  db: Database,
  options: { limit?: number; withinDays?: number; now?: Date } = {}
): string[] {
  const limit = options.limit ?? 5;
  const withinDays = options.withinDays ?? DECLINE_HORIZON_DAYS;
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - withinDays * 86_400_000).toISOString();

  // Only threads' assistant turns carry tool records; scan the recent ones.
  //
  // The time bound is the point: without it, "Recently declined" was a lie the
  // context block told every turn. A refusal from March is not current
  // preference — people change their minds, and a coach that treats one no as
  // permanent stops being able to raise the thing again when it matters.
  const rows = db.all<{ tool_calls: string | null; created_at: string }>(
    `SELECT tool_calls, created_at FROM ai_messages
     WHERE tool_calls IS NOT NULL AND created_at >= ?
     ORDER BY created_at DESC, rowid DESC LIMIT 40`,
    [since]
  );
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const call of parseToolCalls(row.tool_calls)) {
      if (!call.declined) continue;
      const line = `${call.name}${describeDeclinedInput(call.input)} — ${row.created_at.slice(0, 10)}`;
      const key = `${call.name}${describeDeclinedInput(call.input)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** A short, safe rendering of a declined call's input for the prompt. */
function describeDeclinedInput(input: unknown): string {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return '';
  const record = input as Record<string, unknown>;
  // Prefer the fields that identify WHAT was proposed, not every argument.
  for (const key of ['title', 'name', 'content', 'mode', 'metric', 'protocol_slug']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return ` "${value.trim().slice(0, 60)}"`;
    }
  }
  return '';
}
