/**
 * Article import for the knowledge base (docs/knowledge-subapp.md §5) — the
 * recipes ladder cut down to what articles actually need.
 *
 * Four beats, and every rung degrades to the next:
 *
 *   1. URL      fetch HTML → readable text + Article/og provenance
 *   2. any text ONE no-tools model turn, JSON contract, defensive parse
 *   3. paste    the same turn over pasted text — first-class UI, not an error
 *   —  floor    the manual editor, prefilled with whatever survived
 *
 * ## The one rule this file exists to enforce
 *
 * **The model produces DOCTRINE, not a book report, and NEVER an entry
 * synthesized from a title.** `found:false` when the text isn't substantive — a
 * paywall stub, a cookie interstitial, a headline plus teaser, a link farm. This
 * is the third application of the anti-fabrication rule the codebase already
 * enforces twice: the recipes ladder's Flavorish rule (`docs/recipes-grocery.md`)
 * and the labs pipeline's refusal to fuzzy-match a biomarker name. All three say
 * the same thing — when the source doesn't contain it, say so; a plausible
 * invention is worse than an honest gap, because the user cannot tell the
 * difference after the fact.
 *
 * ## Network posture
 *
 * The rung-1 fetch is sanctioned by the 2026-08-12 ADR (docs/decisions.md),
 * which extends the 2026-08-08 recipe-import exception to article URLs:
 * user-initiated, single-shot, at import time only, the URL the user explicitly
 * pasted, HTML text only, never media, never background. Failure degrades to
 * paste-the-text, which stays first-class UI.
 *
 * Every fetched byte is untrusted: parsed defensively (src/lib/html/readable.ts,
 * ./extract.ts), size-capped before it reaches a prompt, never executed.
 *
 * The model turn REUSES the Coach's client (`runCoachTurn`, Keychain key) exactly
 * like src/lib/recipes/import.ts and src/lib/nutrition/estimate.ts — one model
 * path in the app, never a second. Pure builders/parsers are exported for
 * db/knowledge-import.test.mjs; fetch is injected.
 */
import { apiKeyStore } from '@/lib/ai/api-key-store';
import { type FetchLike, runCoachTurn, type WireMessage } from '@/lib/ai/model-client';
import { pageTextForModel } from '@/lib/html/readable';
import { PACK_TOPICS } from '@/lib/db/repositories/knowledge';
import { attributionFrom, extractArticleMeta } from './extract';

// --- Draft: what every import path hands the review screen -------------------

/** A review-ready draft — nothing here has touched the database. */
export type KnowledgeDraft = {
  title: string;
  topic: string;
  body: string;
  source_url: string | null;
  source_author: string | null;
  /** Model-stated caveats, or the "pasted text" provenance note. */
  source_note: string | null;
};

// --- Errors: honest, typed, each routing the UI to a specific next rung -------

/** No model key configured. The UI points at Coach settings AND offers paste. */
export class KnowledgeImportUnavailableError extends Error {
  constructor() {
    super('Article import needs a model key — set one in the Coach settings.');
    this.name = 'KnowledgeImportUnavailableError';
  }
}

export type KnowledgeFetchFailure =
  /** No network, or the host refused the connection. */
  | 'offline'
  /** The page came back, but behind a login/JS wall with nothing readable. */
  | 'blocked'
  /** The URL 404s. */
  | 'not-found'
  /** Fetched fine, but there is no article text to work from. */
  | 'no-content';

/** A failed source fetch, typed so the UI can route to paste. */
export class KnowledgeFetchError extends Error {
  readonly reason: KnowledgeFetchFailure;
  constructor(reason: KnowledgeFetchFailure, message: string) {
    super(message);
    this.name = 'KnowledgeFetchError';
    this.reason = reason;
  }
}

/**
 * The model read the text and it holds no substantive content. The UI's answer
 * is always the same and always actionable: open the article, copy its text,
 * paste it here.
 */
export class NoKnowledgeFoundError extends Error {
  constructor(reason: string | null) {
    super(
      reason && reason.trim() !== ''
        ? reason
        : 'There’s nothing substantive to save here — open the article, copy its text, and paste it in.'
    );
    this.name = 'NoKnowledgeFoundError';
  }
}

/** Whether the AI half of import can run (the same key the Coach uses). */
export function isKnowledgeImportAvailable(): boolean {
  return apiKeyStore.has();
}

// --- Rung 1: the fetch --------------------------------------------------------

/** The plain-GET fetch shape the ladder needs (the Coach's FetchLike is
 * POST-shaped for the Messages API; these are simple page GETs). */
export type GetFetch = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; url?: string; text(): Promise<string> }>;

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Shortest text this ladder will hand a model. Below it the page is a stub, a
 * consent wall or a JS shell, and the honest move is paste — not a model turn
 * that can only guess.
 */
const MIN_ARTICLE_CHARS = 400;

/** Normalize a pasted/shared URL. A bare host gets https://. */
export function normalizeArticleUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed === '') throw new KnowledgeFetchError('not-found', 'No URL to import.');
  const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  if (!/^https?:\/\/[^/?#\s]+\.[^/?#\s]+/i.test(url)) {
    throw new KnowledgeFetchError('not-found', 'That doesn’t look like a URL.');
  }
  return url;
}

export type FetchedArticle = {
  text: string;
  url: string;
  title: string | null;
  author: string | null;
};

/**
 * Fetch one article URL and reduce it to readable text plus provenance.
 *
 * Single-shot: one GET, one 10-second abort, no redirect-chasing beyond what the
 * platform does, no second request for anything. There is no social-platform
 * rung here on purpose — Instagram/TikTok/YouTube are not article sources, so a
 * social URL falls to this generic fetch and degrades honestly to paste rather
 * than pretending a caption is doctrine.
 */
export async function fetchArticle(
  rawUrl: string,
  fetchImpl: GetFetch = fetch as unknown as GetFetch,
  signal?: AbortSignal
): Promise<FetchedArticle> {
  const url = normalizeArticleUrl(rawUrl);

  // An already-cancelled import must not fetch (addEventListener on an aborted
  // signal never fires). A user cancel is rethrown raw — never reported as
  // "offline", which would be a lie about what happened.
  if (signal?.aborted) throw new Error('cancelled');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener('abort', onOuterAbort);
  try {
    let response: Awaited<ReturnType<GetFetch>>;
    try {
      response = await fetchImpl(url, { signal: controller.signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new KnowledgeFetchError('offline', 'Couldn’t reach the site — check the connection.');
    }
    if (response.status === 404 || response.status === 410) {
      throw new KnowledgeFetchError('not-found', 'That page doesn’t exist (404).');
    }
    if (!response.ok) {
      throw new KnowledgeFetchError(
        'blocked',
        `The site refused the request (HTTP ${response.status}).`
      );
    }
    // The body read stays under the same timeout/cancel: headers arriving fast
    // over a stalled connection must not become an unabortable hang.
    let body: string;
    try {
      body = await response.text();
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new KnowledgeFetchError('offline', 'The connection dropped mid-download.');
    }

    const text = pageTextForModel(body);
    if (text.length < MIN_ARTICLE_CHARS) {
      throw new KnowledgeFetchError(
        'no-content',
        'The page had no readable article text — it may be paywalled or behind a consent wall.'
      );
    }
    const meta = extractArticleMeta(body);
    return { text, url: response.url || url, title: meta.title, author: attributionFrom(meta) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

// --- Rung 2: the one model turn ----------------------------------------------

/**
 * The extraction system prompt.
 *
 * Two load-bearing rules, both stated as prohibitions because that is the form a
 * model follows: (a) NOTHING NOT IN THE SOURCE, and (b) `found:false` rather
 * than an entry synthesized from a title. Everything else is voice — what
 * "doctrine, not a book report" means concretely, taken from the corpus's own
 * editorial header (src/lib/rag/corpus.ts): the corpus records what is COMMITTED
 * TO, not what is generally known.
 */
export const KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT = [
  'You compress an article into ONE reference entry for a personal longevity knowledge base.',
  'You are a compressor, NOT an author and NOT a summarizer.',
  '',
  'What the entry must be:',
  '- The claims this source COMMITS TO — specific claims, mechanisms, numbers, doses,',
  '  thresholds — stated so a coach could cite them later.',
  '- Contested or authorial positions ATTRIBUTED ("the author argues…", "Attia recommends…").',
  '- The source’s own hedging CARRIED. If it says the evidence is mixed, the entry says so.',
  '- Prose in paragraphs. Blank lines between paragraphs. No headings, no bullet lists,',
  '  no markdown.',
  '',
  'What it must NOT be:',
  '- A neutral summary of what the article is about, or a list of its section titles.',
  '- Padded with anything from your own knowledge. NOTHING that is not in the source text.',
  '  No invented numbers, no "as is well known", no context the source did not give.',
  '- Built from a title. If the text is a paywall stub, a cookie or consent interstitial,',
  '  a headline plus teaser, a navigation page or a link farm, return',
  '  {"found": false, "reason": "<one short sentence naming what the text lacks>"}.',
  '',
  `Pick "topic" from this vocabulary where one fits: ${PACK_TOPICS.join(', ')}.`,
  'If none fits, use a single new lowercase word.',
  '"caveats" names what you could NOT capture (e.g. "the dosage table was an image"), or null.',
  '',
  'Respond with ONLY a JSON object, no prose, matching:',
  '{"found": true, "title": string, "topic": string, "body": string,',
  ' "source_title": string|null, "source_author": string|null, "caveats": string|null}',
  'or {"found": false, "reason": string}.',
].join('\n');

/** Build the one-turn extraction request (the recipes/estimate.ts twin). */
export function buildKnowledgeExtractionRequest(input: { text: string; sourceNote?: string }): {
  system: string;
  messages: { role: 'user'; content: { type: 'text'; text: string }[] }[];
} {
  const preamble = input.sourceNote ? `Source: ${input.sourceNote}\n\n` : '';
  return {
    system: KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `${preamble}Compress this text into one knowledge entry:\n\n${input.text}`,
          },
        ],
      },
    ],
  };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** A topic the model returned, normalized to the shape the column expects. */
function topicFrom(value: unknown): string {
  const raw = str(value);
  if (!raw) return 'other';
  const word = raw.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim();
  return word === '' ? 'other' : word;
}

export type ParsedKnowledgeExtraction = {
  title: string;
  topic: string;
  body: string;
  source_title: string | null;
  source_author: string | null;
  caveats: string | null;
};

/**
 * Parse the model's extraction reply. Never trusts the shape: unknown fields
 * drop, `found:false` throws {@link NoKnowledgeFoundError} (the UI routes to
 * paste), and a "found" reply whose body is too thin to be doctrine is treated
 * as not-found — a two-line entry assembled from a headline is exactly the
 * fabrication `found:false` exists to catch, and a model that ignores the rule
 * must not get a second way to break it. Tolerant of ```json fences and stray
 * prose around the object.
 */
export function parseKnowledgeExtraction(replyText: string): ParsedKnowledgeExtraction {
  const start = replyText.indexOf('{');
  const end = replyText.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('Knowledge extraction reply contained no JSON object.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(replyText.slice(start, end + 1));
  } catch {
    throw new Error('Knowledge extraction reply was not valid JSON.');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Knowledge extraction reply was not a JSON object.');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.found === false) throw new NoKnowledgeFoundError(str(obj.reason));

  const body = str(obj.body);
  const title = str(obj.title);
  if (!body || body.length < 120) {
    throw new NoKnowledgeFoundError(
      'The source didn’t carry enough substance for an entry — paste the article text instead.'
    );
  }
  if (!title) {
    throw new NoKnowledgeFoundError('The reply carried no title.');
  }

  return {
    title,
    topic: topicFrom(obj.topic),
    body,
    source_title: str(obj.source_title),
    source_author: str(obj.source_author),
    caveats: str(obj.caveats),
  };
}

// --- The orchestrator ---------------------------------------------------------

/** expo/fetch streams response bodies in RN; guarded require so the headless
 * tests (which import this module's pure functions) load in node. */
function loadStreamingFetch(): FetchLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo/fetch') as { fetch?: unknown };
    return (mod.fetch ?? null) as FetchLike | null;
  } catch {
    return null;
  }
}

async function runExtractionTurn(
  input: { text: string; sourceNote?: string },
  signal?: AbortSignal
): Promise<ParsedKnowledgeExtraction> {
  const apiKey = apiKeyStore.get();
  const fetchImpl = loadStreamingFetch();
  if (!apiKey || !fetchImpl) throw new KnowledgeImportUnavailableError();
  const req = buildKnowledgeExtractionRequest(input);
  let text = '';
  const result = await runCoachTurn(
    { apiKey, model: apiKeyStore.getModel(), fetchImpl },
    { system: req.system, messages: req.messages as unknown as WireMessage[], tools: [] },
    {
      onToken: (chunk) => {
        text += chunk;
      },
      signal,
      executeTool: async () => ({ content: '' }),
    }
  );
  if (result.stopReason === 'refusal') {
    throw new Error('The model declined to read this source.');
  }
  return parseKnowledgeExtraction(text.length > 0 ? text : result.text);
}

export type KnowledgeImportInput = { kind: 'url'; url: string } | { kind: 'text'; text: string };

/**
 * The whole pipeline for one input → a review-ready {@link KnowledgeDraft}.
 *
 * Throws: {@link KnowledgeFetchError} (route to paste),
 * {@link NoKnowledgeFoundError} (nothing substantive — route to paste),
 * {@link KnowledgeImportUnavailableError} (no key — the manual editor is still
 * there). The caller NEVER saves this draft without the user's review: that is
 * beat three of the four-beat contract, and it is the reason a model turn is
 * allowed anywhere near the knowledge base at all.
 */
export async function importKnowledge(
  input: KnowledgeImportInput,
  opts: { fetchImpl?: GetFetch; signal?: AbortSignal } = {}
): Promise<KnowledgeDraft> {
  if (input.kind === 'url') {
    const article = await fetchArticle(input.url, opts.fetchImpl, opts.signal);
    const extracted = await runExtractionTurn(
      { text: article.text, sourceNote: `an article at ${article.url}` },
      opts.signal
    );
    return {
      title: extracted.title,
      topic: extracted.topic,
      body: extracted.body,
      source_url: article.url,
      // The page's own metadata wins over the model's reading of it: og/JSON-LD
      // is what the publisher asserted, the model's `source_author` is an
      // inference from body text.
      source_author: article.author ?? extracted.source_author,
      source_note: extracted.caveats,
    };
  }

  const extracted = await runExtractionTurn(
    { text: input.text, sourceNote: 'text the user pasted' },
    opts.signal
  );
  return {
    title: extracted.title,
    topic: extracted.topic,
    body: extracted.body,
    source_url: null,
    source_author: extracted.source_author,
    // Provenance still gets stated even with no URL: "where did this come from"
    // is the question the footer exists to answer, and "pasted text" is a real
    // answer where a blank is not.
    source_note: extracted.caveats
      ? `Pasted text. ${extracted.caveats}`
      : 'Pasted text — no source link.',
  };
}
