/**
 * Shared RAG types (docs/rag-embeddings.md). DB-free so both the repository and
 * the pure chunker/embedder-preprocessing can import them and stay
 * headless-testable.
 */

/** Which vector space a chunk lives in — the vec0 `corpus` partition key. */
export type Corpus = 'knowledge' | 'memory';

/** What a memory chunk was derived from (memory_chunks.kind). */
export type MemoryKind =
  'day' | 'note' | 'insight' | 'protocol_version' | 'conversation' | 'symptom' | 'other';

/** A curated-knowledge chunk row (0025 knowledge_chunks). */
export type KnowledgeChunkRow = {
  id: string;
  source: string;
  pack_version: string | null;
  title: string | null;
  topic: string | null;
  body: string;
  chunk_index: number;
  token_estimate: number | null;
  created_at: string;
  updated_at: string;
};

/** A personal-memory chunk row (0025 memory_chunks). */
export type MemoryChunkRow = {
  id: string;
  kind: MemoryKind;
  origin_table: string | null;
  origin_id: string | null;
  ref_date: string | null;
  body: string;
  token_estimate: number | null;
  created_at: string;
  updated_at: string;
};

/** One passage returned from a retrieval, with its citation and similarity. */
export type RetrievedPassage = {
  chunkId: string;
  corpus: Corpus;
  /** Human-facing citation: a knowledge title/source, or a memory date/kind. */
  citation: string;
  text: string;
  /** Cosine distance from the query (0 = identical); lower is closer. */
  distance: number;
};
