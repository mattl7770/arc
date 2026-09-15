/**
 * Coach memory (0030) — the small, curated set of durable facts about the user
 * that survives every context window.
 *
 * This is the "deeply familiar with the user" half of CLAUDE.md §6, and it is
 * deliberately NOT a vector store: a handful of one-line facts, readable and
 * writable by the owner in Data › Knowledge base (C14 moved that surface off
 * Settings — docs/knowledge-subapp.md §2c), injected verbatim into every turn's
 * context block (src/lib/ai/turn-context.ts). Bulk semantic recall over
 * history is the RAG layer's job (0025); this is what must work with no
 * embedder, no model, and no network.
 *
 * Depends only on the {@link Database} interface — never op-sqlite — so the
 * same code runs on device and against node:sqlite in db/coach-memory.test.mjs.
 */
import { queryTerms } from '@/lib/ai/history-search';

import type { Database } from '../database';
import { newId } from '../id';
import type { Timestamp } from '../types';

/** What kind of durable fact a memory holds (0030 CHECK vocabulary). */
export type MemoryCategory = 'preference' | 'constraint' | 'context' | 'goal';

/** Who put it there: the Coach (approved at the gate) or the user directly. */
export type MemorySource = 'coach' | 'user';

export type CoachMemoryRow = {
  id: string;
  content: string;
  category: MemoryCategory;
  source: MemorySource;
  archived_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type NewMemory = {
  content: string;
  category?: MemoryCategory;
  source?: MemorySource;
};

/**
 * How many active memories the prompt will ever carry. A memory store that
 * grows without bound quietly becomes a context-window tax on every single
 * turn; past this the oldest fall out of the prompt (they stay in the table
 * and in Settings, so nothing is lost — they just stop being free).
 */
export const MEMORY_PROMPT_LIMIT = 40;

/** Normalize + validate a memory's text. Throws on empty (the DB CHECK agrees). */
function normalizeContent(content: string): string {
  const trimmed = content.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) throw new Error('A memory needs some content.');
  return trimmed;
}

/**
 * Remember a fact. Returns the new row's id, or the EXISTING id when the same
 * content is already remembered (case-insensitively) — re-remembering is a
 * no-op rather than a duplicate, so a model that repeats itself across turns
 * can't silently fill the prompt with the same line.
 */
export function rememberFact(db: Database, input: NewMemory): string {
  const content = normalizeContent(input.content);
  const existing = db.get<{ id: string }>(
    `SELECT id FROM coach_memories
     WHERE archived_at IS NULL AND lower(content) = lower(?)`,
    [content]
  );
  if (existing) return existing.id;

  const id = newId(db);
  db.run(`INSERT INTO coach_memories (id, content, category, source) VALUES (?, ?, ?, ?)`, [
    id,
    content,
    input.category ?? 'context',
    input.source ?? 'coach',
  ]);
  return id;
}

/** Active memories, newest first (the prompt-injection + Settings order). */
export function listMemories(db: Database, limit = MEMORY_PROMPT_LIMIT): CoachMemoryRow[] {
  return db.all<CoachMemoryRow>(
    `SELECT * FROM coach_memories WHERE archived_at IS NULL
     ORDER BY created_at DESC, id LIMIT ?`,
    [limit]
  );
}

/**
 * How many active memories exist, regardless of the prompt limit.
 *
 * The limit has to be visible to be honest. The hub lists up to 200 memories,
 * so past 40 the user could read a fact on screen, watch the Coach act as
 * though it had never been told, and have no way to discover why. Callers pair
 * this with {@link listMemories} and SAY when the two disagree.
 */
export function countActiveMemories(db: Database): number {
  return (
    db.get<{ c: number }>('SELECT count(*) c FROM coach_memories WHERE archived_at IS NULL')?.c ?? 0
  );
}

/** Every memory including archived ones (the hub's "Forgotten" foot). */
export function listAllMemories(db: Database, limit = 200): CoachMemoryRow[] {
  return db.all<CoachMemoryRow>(
    `SELECT * FROM coach_memories ORDER BY archived_at IS NOT NULL, created_at DESC, id LIMIT ?`,
    [limit]
  );
}

export function getMemory(db: Database, id: string): CoachMemoryRow | undefined {
  return db.get<CoachMemoryRow>('SELECT * FROM coach_memories WHERE id = ?', [id]);
}

/**
 * Forget a fact — a SOFT delete, so the user can see what was forgotten and
 * when. Returns false when the id is unknown or already archived (the caller
 * reports honestly rather than claiming a phantom success).
 */
export function forgetMemory(db: Database, id: string): boolean {
  const row = db.get<{ id: string }>(
    'SELECT id FROM coach_memories WHERE id = ? AND archived_at IS NULL',
    [id]
  );
  if (!row) return false;
  db.run(
    `UPDATE coach_memories SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    [id]
  );
  return true;
}

/** Restore an archived memory (an undo for a forget the user regrets). */
export function restoreMemory(db: Database, id: string): boolean {
  const row = db.get<{ id: string }>(
    'SELECT id FROM coach_memories WHERE id = ? AND archived_at IS NOT NULL',
    [id]
  );
  if (!row) return false;
  db.run('UPDATE coach_memories SET archived_at = NULL WHERE id = ?', [id]);
  return true;
}

/**
 * Edit a memory in place — the OWNER's act, from the editor the Knowledge hub
 * opens (C14). Returns false when the id is unknown.
 *
 * Deliberately NOT a Coach tool. A memory is one whitespace-collapsed sentence,
 * so a model correcting one is `forget` then `remember`: two gates on the store
 * that rides in every prompt, which is the safer shape and costs no schema
 * tokens against db/coach-eval.test.mjs §6. A person typing a fix is a different
 * act and wants one field, not a retraction.
 *
 * Re-uses {@link normalizeContent}, so an edit cannot introduce a shape the
 * insert path would have refused.
 */
export function updateMemory(
  db: Database,
  id: string,
  patch: { content?: string; category?: MemoryCategory }
): boolean {
  const existing = getMemory(db, id);
  if (!existing) return false;
  const content = patch.content === undefined ? existing.content : normalizeContent(patch.content);
  db.run('UPDATE coach_memories SET content = ?, category = ? WHERE id = ?', [
    content,
    patch.category ?? existing.category,
    id,
  ]);
  return true;
}

/** Permanently delete (the trash action — no soft-delete tombstone). */
export function deleteMemory(db: Database, id: string): void {
  db.run('DELETE FROM coach_memories WHERE id = ?', [id]);
}

/**
 * The Knowledge hub's memory run: every active memory, newest first, filtered
 * and re-ranked by an empty-able keyword query (C14).
 *
 * Shares `queryTerms` with the entry and pack filters beside it on that screen,
 * so "matches" means the same thing in all three runs — a row scores by how
 * many DISTINCT terms it contains, exactly as `listKnowledgeEntries` does. An
 * empty query returns the whole active list, which is what the hub draws.
 *
 * Distinct from {@link findMemories}, which is the Coach's single-fragment
 * dedupe check, and from {@link listMemories}, which is the prompt's capped
 * window and must keep its own contract.
 */
export function searchMemories(db: Database, query = '', limit = 200): CoachMemoryRow[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return listMemories(db, limit);
  const rows = db.all<CoachMemoryRow>(
    `SELECT * FROM coach_memories
     WHERE archived_at IS NULL AND (${terms.map(() => 'lower(content) LIKE ?').join(' OR ')})
     ORDER BY created_at DESC, id`,
    terms.map((t) => `%${t}%`)
  );
  return rows
    .map((row) => ({ row, score: terms.filter((t) => row.content.toLowerCase().includes(t)).length }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.row);
}

/**
 * Find active memories whose text matches a fragment — how the Coach checks
 * whether it already knows something before proposing to remember it again.
 */
export function findMemories(db: Database, fragment: string, limit = 10): CoachMemoryRow[] {
  const needle = fragment.trim();
  if (needle.length === 0) return [];
  return db.all<CoachMemoryRow>(
    `SELECT * FROM coach_memories
     WHERE archived_at IS NULL AND content LIKE '%' || ? || '%'
     ORDER BY created_at DESC LIMIT ?`,
    [needle, limit]
  );
}
