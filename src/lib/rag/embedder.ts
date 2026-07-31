/**
 * The on-device text embedder seam (docs/rag-embeddings.md §3, §7).
 *
 * ARC embeds BOTH the curated corpus and the user's private memory with ONE
 * model — EmbeddingGemma (768-dim, owner's pick) — because a query vector can
 * only search a corpus embedded by the same model (§2). Everything personal is
 * embedded on-device; nothing leaves the phone.
 *
 * SPLIT, so the testable half is tested and the un-runnable half degrades
 * honestly:
 *   - PURE preprocessing (this file's exported functions): the query/document
 *     prompt prefixes EmbeddingGemma requires, L2 normalization (its output is
 *     NOT pre-normalized — verified against the model card), and Matryoshka
 *     (MRL) truncation. Headless-tested in db/rag.test.mjs.
 *   - The MODEL BACKEND (`embedText`): tokenize → ONNX inference → pool → read
 *     `sentence_embedding`. This needs `onnxruntime-react-native`, the Gemma
 *     SentencePiece tokenizer, and a ~200–300 MB model asset downloaded on
 *     first run — none of which run in Node or off a dev build, and the
 *     tokenizer path itself needs an on-device runtime spike before it's wired
 *     (§3, §5). Until then this returns `null`, and the whole RAG layer reports
 *     an honest "knowledge base not available yet" rather than crashing —
 *     exactly like the HealthKit / notifications seams before their build.
 */

/** EmbeddingGemma's native embedding width. MRL lets us truncate to 512/256/128. */
export const EMBED_DIM = 768;

/**
 * EmbeddingGemma is prompt-conditioned: a search QUERY and a stored DOCUMENT
 * must use their own prefixes or retrieval quality collapses (model card). These
 * are the exact task strings — do not change them.
 */
export function queryPrompt(text: string): string {
  return `task: search result | query: ${text}`;
}
export function documentPrompt(text: string): string {
  return `title: none | text: ${text}`;
}

/** L2-normalize a vector; a zero vector is returned unchanged (no divide-by-0). */
export function l2normalize(vec: readonly number[]): number[] {
  let sumSq = 0;
  for (const x of vec) sumSq += x * x;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return [...vec];
  return vec.map((x) => x / norm);
}

/**
 * Matryoshka truncation: keep the first `dim` components, then RE-normalize
 * (MRL makes the leading dims independently meaningful, so a slice + renormalize
 * is the correct and only truncation — no projection matrix). `dim >= length`
 * just normalizes. Storage dimension must be fixed before embedding the corpus.
 */
export function truncateEmbedding(vec: readonly number[], dim: number): number[] {
  return l2normalize(dim >= vec.length ? vec : vec.slice(0, dim));
}

/** Why the embedder can't produce a vector, for an honest tool result. */
export type EmbedderStatus =
  | 'ready'
  | 'model_not_installed' // the ONNX model / tokenizer / native runtime isn't wired yet
  | 'error';

/**
 * The on-device model backend. Returns a normalized `EMBED_DIM`-vector, or
 * `null` when the embedder isn't available (the current state — see the file
 * header: the model asset + Gemma tokenizer land in the device phase). `mode`
 * selects the required prompt prefix.
 *
 * When wired (device phase), the body is: apply the prompt prefix, tokenize to
 * int64 input_ids/attention_mask, `session.run({input_ids, attention_mask})`,
 * read the `sentence_embedding` Float32Array, then `l2normalize` (and
 * `truncateEmbedding` if a smaller dim was locked). The interface is stable so
 * that wiring is additive.
 */
export async function embedText(
  text: string,
  mode: 'query' | 'document'
): Promise<number[] | null> {
  // Prompt is applied here (not by callers) so the query/document distinction
  // can never be gotten wrong at a call site. Referenced so the prefix helpers
  // stay part of the seam's contract even while the backend is stubbed.
  void (mode === 'query' ? queryPrompt(text) : documentPrompt(text));
  // Model backend not wired yet — see the file header. Honest null, never a
  // fake vector (a fabricated embedding would silently poison retrieval).
  return null;
}

/** Whether on-device embedding is available right now. */
export function embedderStatus(): EmbedderStatus {
  return 'model_not_installed';
}

/** Embed a search query (applies the query prompt). Null when unavailable. */
export function embedQuery(text: string): Promise<number[] | null> {
  return embedText(text, 'query');
}

/** Embed a passage for storage (applies the document prompt). Null when unavailable. */
export function embedDocument(text: string): Promise<number[] | null> {
  return embedText(text, 'document');
}
