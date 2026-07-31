/**
 * Retrieval (docs/rag-embeddings.md §6): embed the query on-device, KNN-search
 * the vector index across the knowledge + memory corpora, and join the hits
 * back to their chunk text + citation. The `search_knowledge` Coach tool and
 * Coach long-term memory both read through here.
 *
 * Degrades honestly: if the on-device embedder isn't wired yet (the current
 * state — see embedder.ts) or vec0 is absent, it returns `{ available: false }`
 * with a reason the Coach can relay ("knowledge base not available yet"), never
 * a fabricated passage.
 */
import type { Database } from '@/lib/db/database';

import { embedderStatus, embedQuery, type EmbedderStatus } from './embedder';
import type { Corpus, RetrievedPassage } from './types';
import {
  getKnowledgeChunks,
  getMemoryChunks,
  knnSearch,
  type VectorHit,
} from '@/lib/db/repositories/rag';
import type { KnowledgeChunkRow, MemoryChunkRow } from './types';

export type RetrievalResult =
  { available: true; passages: RetrievedPassage[] } | { available: false; reason: string };

const DEFAULT_K = 6;
/** Cosine distance ceiling — drop hits looser than this (0 = identical). */
const DEFAULT_MAX_DISTANCE = 0.75;

function reasonFor(status: EmbedderStatus): string {
  switch (status) {
    case 'model_not_installed':
      return 'The on-device knowledge base is not available yet (the embedding model ships with a future app update).';
    case 'error':
      return 'The on-device knowledge base hit an error and is unavailable right now.';
    case 'ready':
      return 'No matching passages were found.';
  }
}

function knowledgeCitation(row: KnowledgeChunkRow): string {
  return row.title ? `${row.title} (${row.source})` : row.source;
}

function memoryCitation(row: MemoryChunkRow): string {
  const when = row.ref_date ? `, ${row.ref_date}` : '';
  return `Your ${row.kind}${when}`;
}

/**
 * Top passages for `query` across the requested corpora, closest first, capped
 * at `k` and filtered by a distance ceiling. Query embedding happens once and
 * searches every corpus (they share one vector space).
 */
export async function retrievePassages(
  db: Database,
  query: string,
  opts: { corpora?: Corpus[]; k?: number; maxDistance?: number } = {}
): Promise<RetrievalResult> {
  const corpora = opts.corpora ?? ['knowledge', 'memory'];
  const k = opts.k ?? DEFAULT_K;
  const maxDistance = opts.maxDistance ?? DEFAULT_MAX_DISTANCE;

  const queryVec = await embedQuery(query);
  if (!queryVec) return { available: false, reason: reasonFor(embedderStatus()) };

  const passages: RetrievedPassage[] = [];
  for (const corpus of corpora) {
    const hits: VectorHit[] = knnSearch(db, { corpus, queryVec, k });
    if (hits.length === 0) continue;
    const ids = hits.map((h) => h.chunkId);
    const rows = corpus === 'knowledge' ? getKnowledgeChunks(db, ids) : getMemoryChunks(db, ids);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const hit of hits) {
      if (hit.distance > maxDistance) continue;
      const row = byId.get(hit.chunkId);
      if (!row) continue; // vector without content (shouldn't happen; skip safely)
      passages.push({
        chunkId: hit.chunkId,
        corpus,
        citation:
          corpus === 'knowledge'
            ? knowledgeCitation(row as KnowledgeChunkRow)
            : memoryCitation(row as MemoryChunkRow),
        text: row.body,
        distance: hit.distance,
      });
    }
  }

  passages.sort((a, b) => a.distance - b.distance);
  return { available: true, passages: passages.slice(0, k) };
}
