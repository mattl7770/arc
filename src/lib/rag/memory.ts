/**
 * Coach long-term memory ingestion (docs/rag-embeddings.md §6). Turns a unit of
 * the user's own history (a day summary, a note, a past insight, a
 * protocol-version change, a conversation turn) into embedded, searchable
 * memory chunks — the "deeply familiar with the user" half of the Coach.
 *
 * Content is stored ALWAYS (regular tables, works everywhere); the vector is
 * stored only where the on-device embedder is available, so a memory ingested
 * before the embedder ships persists its text with `embedded: 0` vectors.
 *
 * NOTHING IS LOST BY WAITING to auto-fire this from the app's write paths: the
 * source rows (daily_logs, log_entries, ai_messages, protocol_versions) persist
 * independently, so when the embedder lands, history can be ingested
 * retroactively from those tables. That is why ingestion is not yet wired into
 * the write paths — doing it before retrieval can be validated end-to-end would
 * add a failure surface to core writes for no reachable benefit.
 *
 * Re-ingesting the same origin replaces its prior chunks (content + vectors).
 */
import type { Database } from '@/lib/db/database';

import { chunkText, estimateTokens } from './chunk';
import { embedDocument } from './embedder';
import type { MemoryKind } from './types';
import {
  deleteMemoryChunks,
  deleteVectors,
  insertMemoryChunk,
  memoryChunkIdsForOrigin,
  upsertVector,
} from '@/lib/db/repositories/rag';

export type MemoryInput = {
  kind: MemoryKind;
  text: string;
  /** Provenance so re-ingestion can replace prior chunks (optional). */
  originTable?: string;
  originId?: string;
  /** The local day this memory pertains to, for recency (optional). */
  refDate?: string;
};

export type IngestResult = {
  /** Content chunks written. */
  chunkIds: string[];
  /** How many of those also got a vector (0 until the embedder ships). */
  embedded: number;
};

/**
 * Ingest one source unit into memory. Replaces any prior chunks for the same
 * (originTable, originId) first, so re-summarizing a day doesn't duplicate it.
 */
export async function ingestMemory(db: Database, input: MemoryInput): Promise<IngestResult> {
  const chunks = chunkText(input.text);
  // Empty / whitespace-only source → a NO-OP, computed BEFORE the delete-prior
  // step: an empty re-ingest must never silently wipe an origin's existing
  // memory (clearing is a separate, explicit operation).
  if (chunks.length === 0) return { chunkIds: [], embedded: 0 };

  if (input.originTable && input.originId) {
    const prior = memoryChunkIdsForOrigin(db, input.originTable, input.originId);
    if (prior.length > 0) {
      deleteVectors(db, prior);
      deleteMemoryChunks(db, prior);
    }
  }

  const chunkIds: string[] = [];
  let embedded = 0;
  for (const chunk of chunks) {
    const id = insertMemoryChunk(db, {
      kind: input.kind,
      originTable: input.originTable ?? null,
      originId: input.originId ?? null,
      refDate: input.refDate ?? null,
      body: chunk.text,
      tokenEstimate: estimateTokens(chunk.text),
    });
    chunkIds.push(id);
    const vec = await embedDocument(chunk.text);
    if (vec) {
      upsertVector(db, { chunkId: id, corpus: 'memory', source: input.kind, embedding: vec });
      embedded += 1;
    }
  }
  return { chunkIds, embedded };
}
