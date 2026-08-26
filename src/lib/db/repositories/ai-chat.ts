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
 * The most recent N messages of a thread, oldest-first — the paginated read
 * the screen uses so a months-long conversation doesn't load entirely into
 * React state on every mount. `listMessages` remains the full read for export.
 */
export function listRecentMessages(
  db: Database,
  conversationId: string,
  limit = 100
): AiMessageRecord[] {
  const newestFirst = db.all<AiMessageRecord>(
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
): AiMessageRecord[] {
  return db.all<AiMessageRecord>(
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
 * as human lines ("update_protocol morning-stack").
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
  for (const key of ['title', 'name', 'content', 'metric', 'protocol_slug']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return ` "${value.trim().slice(0, 60)}"`;
    }
  }
  return '';
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

/**
 * The RECEIPT LINES for a turn's landed writes — what the thread prints under a
 * reply to say what actually changed.
 *
 * Each is the summary the user approved on the confirmation card, recorded past
 * the point of no return in coach-service.ts (`CoachToolCall.receipt`). Rows
 * written before receipts existed carry none, so the tool name stands in:
 * degraded, but never a blank where a change happened.
 *
 * `fallback` rather than a hardcoded humanizer because that vocabulary belongs
 * to the AI layer, and this module deliberately does not import from it — the
 * same reason `isWrite` is a parameter.
 */
export function landedWriteReceipts(
  toolCalls: CoachToolCall[],
  isWrite: (name: string) => boolean,
  fallback: (name: string) => string
): string[] {
  return landedWriteCalls(toolCalls, isWrite).map(
    (call) => call.receipt?.trim() || fallback(call.name)
  );
}
