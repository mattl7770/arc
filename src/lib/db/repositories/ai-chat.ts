/**
 * The Coach conversation store (0008_ai_chat.sql): threads and their turns.
 *
 * Messages are append-only — a turn is written once, after it finishes, and
 * never edited. A turn that did NOT finish is therefore annotated by appending
 * a status marker ({@link markTurnStatus}), not by rewriting or deleting the
 * fragment. The conversation row's updated_at doubles as "last activity"
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

// --- Turn status: why a persisted turn is not a finished answer --------------

/**
 * Why a stored assistant turn is NOT a finished answer.
 *
 *   max_tokens     — the model hit its output cap (or the context window) and
 *                    the reply stops mid-sentence.
 *   tool_use_limit — the turn exhausted the tool round-trip bound. Dangerous:
 *                    approved writes already executed, but the Coach never got
 *                    to finish (or report) what it was doing.
 *   failed         — the turn threw after tool calls had already run.
 *   superseded     — the user retried; this fragment was abandoned mid-answer.
 */
export type TurnStatus = 'max_tokens' | 'tool_use_limit' | 'failed' | 'superseded';

const TURN_STATUSES: readonly TurnStatus[] = [
  'max_tokens',
  'tool_use_limit',
  'failed',
  'superseded',
];

/** Discriminator of a status-marker row's JSON content. */
const TURN_STATUS_MARKER = 'arc.turn_status';

export type TurnStatusMarker = { messageId: string; status: TurnStatus };

/**
 * Record that a turn did not finish — as a NEW row, never an edit.
 *
 * `ai_messages` is append-only by design (0008: no updated_at, no trigger), and
 * an assistant row carries the tool-call record of writes that really landed in
 * the owner's health data. So neither editing nor deleting the fragment is an
 * option: the marker is a `role='system'` row naming the message it annotates.
 * The UI folds it in ({@link listThread}) and never renders it; the model never
 * sees it (the wire history is built from the two conversational roles only).
 *
 * More than one marker for a message is legal — the last one appended wins, so
 * a `failed` turn later becomes `superseded` without rewriting history.
 *
 * (The natural home for this is a `status` column on ai_messages; that is a
 * migration, and this ships without one.)
 */
export function markTurnStatus(
  db: Database,
  conversationId: string,
  messageId: string,
  status: TurnStatus
): string {
  return appendMessage(
    db,
    conversationId,
    'system',
    JSON.stringify({ marker: TURN_STATUS_MARKER, messageId, status })
  );
}

/**
 * Read a row as a status marker, or null if it is anything else. Lenient like
 * {@link parseToolCalls}: corrupt or unknown content is not a marker, never a
 * throw — a garbled row must not take the whole thread down.
 */
export function parseTurnStatus(row: AiMessageRow): TurnStatusMarker | null {
  if (row.role !== 'system') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.content);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.marker !== TURN_STATUS_MARKER) return null;
  if (typeof record.messageId !== 'string' || record.messageId === '') return null;
  if (!TURN_STATUSES.includes(record.status as TurnStatus)) return null;
  return { messageId: record.messageId, status: record.status as TurnStatus };
}

/** One renderable turn plus the status appended for it (null = it finished). */
export type ThreadTurn = { message: AiMessageRow; status: TurnStatus | null };

/**
 * The thread as the UI shows it: the conversational turns (user/assistant),
 * oldest first, each carrying its status. Marker rows are consumed here, and
 * any other non-conversational row ('system', 'tool') is skipped — the screen
 * renders two roles.
 */
export function listThread(db: Database, conversationId: string): ThreadTurn[] {
  const rows = listMessages(db, conversationId);
  const statuses = new Map<string, TurnStatus>();
  const turns: AiMessageRow[] = [];
  for (const row of rows) {
    const marker = parseTurnStatus(row);
    if (marker) {
      statuses.set(marker.messageId, marker.status); // last marker wins
      continue;
    }
    if (row.role === 'user' || row.role === 'assistant') turns.push(row);
  }
  return turns.map((message) => ({ message, status: statuses.get(message.id) ?? null }));
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
