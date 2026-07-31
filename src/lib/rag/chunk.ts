/**
 * Text chunking for RAG (docs/rag-embeddings.md §6). Pure and DB-free so the
 * offline knowledge-corpus build and the on-device memory ingestion share ONE
 * chunker, and it stays headless-testable (the embedder + sqlite-vec halves are
 * device-only; this half is not).
 *
 * Passages target ~300 tokens and hard-cap at ~400, approximated by characters
 * (~4 chars/token is a stable enough proxy for English — the exact token count
 * is the embedder's concern, and EmbeddingGemma's context window dwarfs a single
 * passage). Strategy, in order of preference so a passage never splits mid-idea
 * unless it must:
 *   1. split the source into paragraphs (blank-line separated);
 *   2. split each paragraph into sentences;
 *   3. greedily pack sentences into a passage until the next sentence would
 *      exceed the target — then start a new passage;
 *   4. a single sentence longer than the hard cap is split on character count
 *      (a last resort — only very long unbroken text hits this).
 *
 * Optional `overlapSentences` repeats the tail sentence(s) of each passage at
 * the head of the next, so a retrieved passage keeps a little prior context and
 * an idea spanning a boundary is still findable from either side.
 *
 * User-history "memory" is chunked by NATURAL unit at the ingestion call site (a
 * day summary, a note, a protocol-version change, one Coach insight) — each unit
 * is passed through here so an unusually long one still gets split, but a short
 * note stays a single chunk.
 */

export type Chunk = {
  /** 0-based position of this passage within its source. */
  index: number;
  /** The passage text, whitespace-normalized, ready to embed. */
  text: string;
};

export type ChunkOptions = {
  /** Soft target passage size in tokens (a new passage starts once exceeded). */
  targetTokens?: number;
  /** Hard cap; a single sentence past this is character-split. */
  maxTokens?: number;
  /** Sentences of the previous passage to repeat at the next passage's head. */
  overlapSentences?: number;
};

const CHARS_PER_TOKEN = 4;
export const DEFAULT_TARGET_TOKENS = 300;
export const DEFAULT_MAX_TOKENS = 400;

/** Rough token estimate for a string — chars/4, never negative. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Collapse runs of whitespace to single spaces and trim. */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Blank-line-separated paragraphs, each whitespace-normalized, empties dropped. */
function toParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n+/)
    .map(normalizeWhitespace)
    .filter((p) => p.length > 0);
}

/**
 * Split a (whitespace-normalized) paragraph into sentences. Breaks after `.`,
 * `!`, or `?` (optionally followed by a closing quote/bracket) when the next
 * char is a space — a deliberately simple rule: over-splitting is harmless here
 * (sentences are only repacked), and it avoids shipping an NLP dependency.
 */
function toSentences(paragraph: string): string[] {
  const parts = paragraph.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g);
  if (!parts) return paragraph.length > 0 ? [paragraph] : [];
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Hard-split an over-long single sentence on character count (last resort). */
function splitLongSentence(sentence: string, maxChars: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < sentence.length; i += maxChars) {
    out.push(sentence.slice(i, i + maxChars).trim());
  }
  return out.filter((s) => s.length > 0);
}

/**
 * Split `raw` into embedding-ready passages. Empty/whitespace-only input yields
 * no chunks (never a single empty chunk — an empty passage must never be
 * embedded or stored).
 */
export function chunkText(raw: string, options: ChunkOptions = {}): Chunk[] {
  const targetTokens = options.targetTokens ?? DEFAULT_TARGET_TOKENS;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlapSentences = Math.max(0, options.overlapSentences ?? 0);
  const targetChars = targetTokens * CHARS_PER_TOKEN;
  const maxChars = maxTokens * CHARS_PER_TOKEN;

  // Flatten to a sentence stream, hard-splitting any sentence past the cap so
  // the packer below only ever handles pieces that fit.
  const sentences: string[] = [];
  for (const paragraph of toParagraphs(raw)) {
    for (const sentence of toSentences(paragraph)) {
      if (sentence.length > maxChars) sentences.push(...splitLongSentence(sentence, maxChars));
      else sentences.push(sentence);
    }
  }

  const passages: string[][] = [];
  let current: string[] = [];
  let currentChars = 0;
  for (const sentence of sentences) {
    const addedChars = currentChars === 0 ? sentence.length : currentChars + 1 + sentence.length;
    // Start a new passage once the current one is non-empty and adding this
    // sentence would push it past the target — keeps passages near the target
    // without ever exceeding the cap (single sentences are already <= cap).
    if (current.length > 0 && addedChars > targetChars) {
      passages.push(current);
      current = overlapSentences > 0 ? current.slice(-overlapSentences) : [];
      currentChars = current.join(' ').length;
    }
    current.push(sentence);
    currentChars = current.join(' ').length;
  }
  if (current.length > 0) passages.push(current);

  return passages.map((sentenceList, index) => ({ index, text: sentenceList.join(' ') }));
}
