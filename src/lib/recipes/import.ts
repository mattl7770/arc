/**
 * The recipe-import pipeline (docs/recipes-grocery.md §2c): share/paste a URL →
 * platform-aware caption/JSON-LD fetch → ONE no-tools model turn structures the
 * text → an editable review the user must confirm. NEVER auto-committed, and
 * NEVER fabricated: when the source doesn't contain the recipe the model says
 * so (`found:false` — the documented Flavorish anti-pattern, banned here the
 * way fuzzy biomarker matching is banned in labs).
 *
 * Network posture (the ADR in docs/decisions.md): the fetches here are the
 * third sanctioned non-AI exception — user-initiated, single-shot, at import
 * time only, caption/metadata text only, never media. Every fetch result is
 * untrusted input: parsed defensively (src/lib/recipes/extract.ts), size-capped
 * before it reaches a prompt, never executed. Failure degrades one rung down
 * the ladder and bottoms out at paste-the-caption — a state, not an error.
 *
 * The model turn REUSES the Coach's client (`runCoachTurn`, Keychain key,
 * expo/fetch streaming) exactly like src/lib/nutrition/estimate.ts — one model
 * path in the app, never a second. Pure builders/parsers are exported for
 * db/recipe-import.test.mjs; fetch is injected.
 */
import { apiKeyStore } from '@/lib/ai/api-key-store';
import { type FetchLike, runCoachTurn, type WireMessage } from '@/lib/ai/model-client';
import { isPrivateHost } from '@/lib/net/safe-url';
import {
  extractInstagramAuthor,
  extractInstagramCaption,
  extractInstagramEmbedCaption,
  extractJsonLdRecipe,
  extractOgImage,
  extractTikTokCaption,
  extractYouTubeDescription,
  pageTextForModel,
} from './extract';
import { parseIngredientLine } from './ingredients';
import type { NewRecipeIngredient, RecipePlatform } from './types';

// --- Draft: what every import path hands the review screen -------------------

/** A review-ready draft — nothing here has touched the database. */
export type RecipeDraft = {
  title: string;
  servings: number | null;
  prep_min: number | null;
  cook_min: number | null;
  ingredients: NewRecipeIngredient[];
  steps: string[];
  source_url: string | null;
  source_platform: RecipePlatform | null;
  source_author: string | null;
  source_image_url: string | null;
  /** Model-stated caveats worth showing in review. */
  notes: string | null;
  /** True when the draft came from deterministic JSON-LD (no model involved). */
  deterministic: boolean;
};

// --- Errors: the honest tri-state + unavailability ----------------------------

/** Thrown when no model key is configured (the UI points at Coach settings). */
export class RecipeImportUnavailableError extends Error {
  constructor() {
    super('Recipe import needs a model key — set one in the Coach settings.');
    this.name = 'RecipeImportUnavailableError';
  }
}

export type RecipeFetchFailure =
  /** No network (or the host refused the connection). */
  | 'offline'
  /** The page came back but without usable content (login wall / JS shell). */
  | 'blocked'
  /** The URL 404s or the platform said no such post. */
  | 'not-found'
  /** Fetched fine, but there's no caption/description text to work from. */
  | 'no-content'
  /** This source can never be fetched (Instagram Stories) — go to paste. */
  | 'unfetchable';

/** A failed source fetch, typed so the UI can route to the right rung. */
export class RecipeFetchError extends Error {
  readonly reason: RecipeFetchFailure;
  constructor(reason: RecipeFetchFailure, message: string) {
    super(message);
    this.name = 'RecipeFetchError';
    this.reason = reason;
  }
}

/** The model looked at the text/photo and it does not contain a recipe. */
export class NoRecipeFoundError extends Error {
  constructor(reason: string | null) {
    super(
      reason && reason.trim() !== ''
        ? reason
        : 'This source doesn’t contain the recipe itself — paste the recipe text or share a screenshot of it.'
    );
    this.name = 'NoRecipeFoundError';
  }
}

/** Whether the AI half of import can run (same key the Coach uses). The
 * deterministic JSON-LD rung works without it. */
export function isRecipeImportAvailable(): boolean {
  return apiKeyStore.has();
}

// --- URL normalization + platform detection -----------------------------------

export type SourceKind = RecipePlatform | 'instagram-stories';

export type NormalizedSource = { url: string; platform: SourceKind };

function hostOf(url: string): string | null {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url.trim());
  return m ? m[1]!.toLowerCase().replace(/^www\./, '') : null;
}

/**
 * Normalize a shared/pasted URL and name its platform. Deterministic
 * transforms only: youtu.be/<id> and youtube.com/shorts/<id> → the watch URL
 * (the verified extraction target); Instagram Stories are detected and marked
 * unfetchable (login-walled, no permalink caption — the ladder skips straight
 * to paste/screenshot, a documented decision). TikTok short links keep their
 * host — the fetch resolves the redirect. A URL without a scheme gets https://.
 */
export function normalizeSourceUrl(rawUrl: string): NormalizedSource {
  let url = rawUrl.trim();
  if (url === '') throw new RecipeFetchError('not-found', 'No URL to import.');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const host = hostOf(url);
  if (!host) throw new RecipeFetchError('not-found', 'That doesn’t look like a URL.');
  if (isPrivateHost(host))
    throw new RecipeFetchError('blocked', 'That URL points to a private or local address ARC won’t fetch.');

  if (host === 'youtu.be') {
    const m = /^https?:\/\/[^/]+\/([A-Za-z0-9_-]{5,})/.exec(url);
    if (m) return { url: `https://www.youtube.com/watch?v=${m[1]}`, platform: 'youtube' };
  }
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    const shorts = /\/shorts\/([A-Za-z0-9_-]{5,})/.exec(url);
    if (shorts) {
      return { url: `https://www.youtube.com/watch?v=${shorts[1]}`, platform: 'youtube' };
    }
    return { url, platform: 'youtube' };
  }
  if (host === 'instagram.com') {
    if (/\/stories\//.test(url)) return { url, platform: 'instagram-stories' };
    return { url, platform: 'instagram' };
  }
  // Any *.tiktok.com host is TikTok — m.tiktok.com mobile links and future
  // subdomains must reach the oEmbed rung, not the generic website rung.
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    return { url, platform: 'tiktok' };
  }
  return { url, platform: 'website' };
}

// --- The fetch ladder ---------------------------------------------------------

/** What a source fetch yields: either a finished deterministic draft
 * (JSON-LD), or text for the model turn plus whatever metadata came along. */
export type FetchedSource =
  | { kind: 'jsonld'; draft: RecipeDraft }
  | {
      kind: 'text';
      text: string;
      platform: RecipePlatform;
      url: string;
      author: string | null;
      image_url: string | null;
    };

/** The plain-GET fetch shape the ladder needs (the Coach's FetchLike is
 * POST-shaped for the Messages API; these are simple page GETs). */
export type GetFetch = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; url?: string; text(): Promise<string> }>;

const FETCH_TIMEOUT_MS = 10_000;

async function fetchText(
  fetchImpl: GetFetch,
  url: string,
  signal?: AbortSignal
): Promise<{ body: string; finalUrl: string }> {
  // An already-cancelled import must not fetch (addEventListener on an aborted
  // signal never fires). A user cancel is rethrown raw — the caller's aborted
  // guard swallows it — never reported as "offline".
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
      throw new RecipeFetchError('offline', 'Couldn’t reach the site — check the connection.');
    }
    if (response.status === 404 || response.status === 410) {
      throw new RecipeFetchError('not-found', 'That post or page doesn’t exist (404).');
    }
    if (!response.ok) {
      throw new RecipeFetchError(
        'blocked',
        `The site refused the request (HTTP ${response.status}).`
      );
    }
    // The body read stays under the same timeout/cancel: headers arriving fast
    // over a stalled connection must not turn into an unabortable hang.
    let body: string;
    try {
      body = await response.text();
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new RecipeFetchError('offline', 'The connection dropped mid-download.');
    }
    const finalUrl = response.url || url;
    return { body, finalUrl };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

/** The /p|reel|tv/<code>/ shortcode, for the embed-captioned fallback. */
export function instagramShortcode(url: string): string | null {
  const m = /instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i.exec(url);
  return m ? m[1]! : null;
}

/**
 * Run the fetch half of the ladder for a URL (rungs 1–5). Throws
 * {@link RecipeFetchError} with the honest tri-state+ reasons; the UI maps each
 * reason to the next rung. `fetchImpl` defaults to the global fetch (these are
 * plain GETs — no streaming needed) and is injected in tests.
 */
export async function fetchRecipeSource(
  rawUrl: string,
  fetchImpl: GetFetch = fetch as unknown as GetFetch,
  signal?: AbortSignal
): Promise<FetchedSource> {
  const { url, platform } = normalizeSourceUrl(rawUrl);

  if (platform === 'instagram-stories') {
    throw new RecipeFetchError(
      'unfetchable',
      'Stories can’t be read from a link — paste the recipe text or share a screenshot.'
    );
  }

  if (platform === 'website') {
    const { body } = await fetchText(fetchImpl, url, signal);
    const jsonld = extractJsonLdRecipe(body);
    if (jsonld) {
      return {
        kind: 'jsonld',
        draft: {
          title: jsonld.title,
          servings: jsonld.servings,
          prep_min: jsonld.prep_min,
          cook_min: jsonld.cook_min,
          ingredients: jsonld.ingredients.map((raw) => ({ raw_text: raw })),
          steps: jsonld.steps,
          source_url: url,
          source_platform: 'website',
          source_author: jsonld.author,
          source_image_url: jsonld.image_url,
          notes: null,
          deterministic: true,
        },
      };
    }
    const text = pageTextForModel(body);
    if (text.length < 80) {
      throw new RecipeFetchError('no-content', 'The page had no readable recipe content.');
    }
    return {
      kind: 'text',
      text,
      platform: 'website',
      url,
      author: null,
      image_url: extractOgImage(body),
    };
  }

  if (platform === 'instagram') {
    const { body } = await fetchText(fetchImpl, url, signal);
    const caption = extractInstagramCaption(body);
    if (caption) {
      return {
        kind: 'text',
        text: caption,
        platform: 'instagram',
        url,
        author: extractInstagramAuthor(body),
        image_url: extractOgImage(body),
      };
    }
    // og tags absent (shell) → the server-rendered embed variant.
    const code = instagramShortcode(url);
    if (code) {
      const embed = await fetchText(
        fetchImpl,
        `https://www.instagram.com/p/${code}/embed/captioned/`,
        signal
      );
      const embedCaption = extractInstagramEmbedCaption(embed.body);
      if (embedCaption) {
        return {
          kind: 'text',
          text: embedCaption,
          platform: 'instagram',
          url,
          author: null,
          image_url: null,
        };
      }
    }
    throw new RecipeFetchError(
      'blocked',
      'Instagram didn’t hand over the caption — paste it instead (tap the caption → copy).'
    );
  }

  if (platform === 'tiktok') {
    // oEmbed needs the canonical /@user/video/<id> URL. Anything else —
    // vm./vt. short links, tiktok.com/t/<code>, m.tiktok.com/v/<id>.html —
    // resolves via its redirect first.
    let canonical = url;
    if (!/\/video\/\d/.test(url)) {
      const resolved = await fetchText(fetchImpl, url, signal);
      canonical = resolved.finalUrl;
    }
    const oembed = await fetchText(
      fetchImpl,
      `https://www.tiktok.com/oembed?url=${encodeURIComponent(canonical)}`,
      signal
    );
    const extracted = extractTikTokCaption(oembed.body);
    if (!extracted) {
      throw new RecipeFetchError('no-content', 'TikTok returned no caption for that video.');
    }
    return {
      kind: 'text',
      text: extracted.caption,
      platform: 'tiktok',
      url: canonical,
      author: extracted.author,
      image_url: extracted.image_url,
    };
  }

  // YouTube (watch URL after normalization).
  const { body } = await fetchText(fetchImpl, url, signal);
  const description = extractYouTubeDescription(body);
  if (!description) {
    throw new RecipeFetchError('no-content', 'The video page carried no description.');
  }
  return {
    kind: 'text',
    text: description,
    platform: 'youtube',
    url,
    author: null,
    image_url: null,
  };
}

// --- The model turn (rungs 6–7) -----------------------------------------------

export type ExtractionInput =
  | { kind: 'text'; text: string; sourceNote?: string }
  | { kind: 'photo'; base64Jpeg: string; mediaType: 'image/jpeg' };

/**
 * The extraction system prompt. The load-bearing rule is ANTI-FABRICATION:
 * `found:false` when the input doesn't contain the recipe — never a plausible
 * recipe synthesized from a dish name and hashtags.
 */
export const RECIPE_EXTRACTION_SYSTEM_PROMPT = [
  'You extract a cooking recipe from text (a social-media caption, a video description, or',
  'page text) or from an image (a screenshot of a recipe, a cookbook page), for a personal',
  'recipe book. You are an extractor, NOT an author.',
  '',
  'Rules:',
  '- Extract ONLY what the source actually states. NEVER invent, complete, or embellish a',
  '  recipe from a dish name, hashtags, or your own knowledge of similar dishes.',
  '- If the source does not contain the actual recipe (e.g. "recipe on my blog", "link in',
  '  bio", a bare dish name, an unrelated text), return {"found": false, "reason": "<one',
  '  short sentence saying what the source lacks>"}.',
  '- Preserve the author’s wording in each ingredient’s "raw" line (trim list bullets).',
  '- Parse each ingredient’s quantity into qty (number), unit (string), name (string) where',
  '  stated; use null where the source gives no amount — never invent quantities.',
  '- Steps are the source’s instructions in order, one string per step, lightly cleaned.',
  '- servings / prep_min / cook_min only when the source states them; else null.',
  '',
  'Respond with ONLY a JSON object, no prose, matching:',
  '{"found": true, "title": string, "servings": number|null, "prep_min": number|null,',
  ' "cook_min": number|null, "ingredients": [{"raw": string, "qty": number|null,',
  ' "unit": string|null, "name": string|null}], "steps": [string], "notes": string|null}',
  'or {"found": false, "reason": string}.',
].join('\n');

type VisionBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg'; data: string } };

/** Build the one-turn extraction request (the estimate.ts twin). */
export function buildRecipeExtractionRequest(input: ExtractionInput): {
  system: string;
  messages: { role: 'user'; content: VisionBlock[] }[];
} {
  const content: VisionBlock[] = [];
  if (input.kind === 'photo') {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: input.mediaType, data: input.base64Jpeg },
    });
    content.push({ type: 'text', text: 'Extract the recipe from this image.' });
  } else {
    content.push({
      type: 'text',
      text: `${input.sourceNote ? `Source: ${input.sourceNote}\n\n` : ''}Extract the recipe from this text:\n\n${input.text}`,
    });
  }
  return { system: RECIPE_EXTRACTION_SYSTEM_PROMPT, messages: [{ role: 'user', content }] };
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * The brace-balanced object that begins at `from`, or null. Tracks string
 * literals and escapes so a brace INSIDE a JSON string doesn't close the object
 * early — a `lastIndexOf('}')` slice cannot, and would span the wrong braces
 * when prose either side of the object contains any.
 */
function balancedObjectFrom(text: string, from: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return null;
}

/**
 * The first embedded JSON object that actually parses, or undefined. Walks each
 * `{` in turn — a preamble like `the {found:...} format:` gives a balanced but
 * unparseable slice, so we skip it and try the next `{`, landing on the real
 * object. JSON.parse never yields undefined, so undefined is an unambiguous
 * "nothing parsed" signal.
 */
function parseEmbeddedJsonObject(replyText: string): unknown {
  for (let i = replyText.indexOf('{'); i !== -1; i = replyText.indexOf('{', i + 1)) {
    const candidate = balancedObjectFrom(replyText, i);
    if (candidate === null) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // This `{` opened prose, not the object — try the next one.
    }
  }
  return undefined;
}

/**
 * Parse the model's extraction reply. Never trusts the shape: unknown fields
 * drop, a `found:false` throws {@link NoRecipeFoundError} (the UI routes to
 * the paste/screenshot rungs), and a "found" reply with no usable ingredients
 * AND no steps is treated as not-found — an empty recipe is a fabrication with
 * extra steps. Tolerant of ```json fences / stray prose around the object, even
 * when that prose itself contains braces.
 */
export function parseRecipeExtraction(replyText: string): {
  title: string;
  servings: number | null;
  prep_min: number | null;
  cook_min: number | null;
  ingredients: NewRecipeIngredient[];
  steps: string[];
  notes: string | null;
} {
  if (replyText.indexOf('{') === -1) {
    throw new Error('Recipe extraction reply contained no JSON object.');
  }
  const raw = parseEmbeddedJsonObject(replyText);
  if (raw === undefined) {
    throw new Error('Recipe extraction reply was not valid JSON.');
  }
  if (raw === null || typeof raw !== 'object') {
    throw new Error('Recipe extraction reply was not a JSON object.');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.found === false) throw new NoRecipeFoundError(str(obj.reason));

  const rawIngredients = Array.isArray(obj.ingredients) ? obj.ingredients : [];
  const ingredients: NewRecipeIngredient[] = [];
  for (const entry of rawIngredients) {
    if (typeof entry === 'string') {
      // Tolerate a bare-string ingredient list; the overlay parses locally.
      const raw_text = entry.trim();
      if (raw_text !== '') ingredients.push({ raw_text, ...parseIngredientLine(raw_text) });
      continue;
    }
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const raw_text = str(e.raw);
    if (!raw_text) continue;
    const parsed = parseIngredientLine(raw_text);
    ingredients.push({
      raw_text,
      qty: num(e.qty) ?? parsed.qty,
      unit: str(e.unit) ?? parsed.unit,
      name: str(e.name) ?? parsed.name,
    });
  }
  const steps = (Array.isArray(obj.steps) ? obj.steps : [])
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s !== '');

  if (ingredients.length === 0 && steps.length === 0) {
    throw new NoRecipeFoundError('The reply contained no ingredients or steps.');
  }

  return {
    title: str(obj.title) ?? 'Imported recipe',
    servings: num(obj.servings),
    prep_min: num(obj.prep_min),
    cook_min: num(obj.cook_min),
    ingredients,
    steps,
    notes: str(obj.notes),
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
  input: ExtractionInput,
  signal?: AbortSignal
): Promise<ReturnType<typeof parseRecipeExtraction>> {
  const apiKey = apiKeyStore.get();
  const fetchImpl = loadStreamingFetch();
  if (!apiKey || !fetchImpl) throw new RecipeImportUnavailableError();
  const req = buildRecipeExtractionRequest(input);
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
  return parseRecipeExtraction(text.length > 0 ? text : result.text);
}

export type ImportInput =
  | { kind: 'url'; url: string }
  | { kind: 'text'; text: string }
  | { kind: 'photo'; base64Jpeg: string };

/**
 * The whole pipeline for one input → a review-ready {@link RecipeDraft}.
 * JSON-LD pages return WITHOUT any model call; everything else runs the one
 * extraction turn. Throws: {@link RecipeFetchError} (route to the next rung),
 * {@link NoRecipeFoundError} (source has no recipe — paste/screenshot),
 * {@link RecipeImportUnavailableError} (no key). The caller NEVER saves this
 * draft without the user's review.
 */
export async function importRecipe(
  input: ImportInput,
  opts: { fetchImpl?: GetFetch; signal?: AbortSignal } = {}
): Promise<RecipeDraft> {
  if (input.kind === 'url') {
    const source = await fetchRecipeSource(input.url, opts.fetchImpl, opts.signal);
    if (source.kind === 'jsonld') return source.draft;
    const extracted = await runExtractionTurn(
      { kind: 'text', text: source.text, sourceNote: `a ${source.platform} post` },
      opts.signal
    );
    return {
      ...extracted,
      source_url: source.url,
      source_platform: source.platform,
      source_author: source.author,
      source_image_url: source.image_url,
      deterministic: false,
    };
  }
  if (input.kind === 'text') {
    const extracted = await runExtractionTurn({ kind: 'text', text: input.text }, opts.signal);
    return {
      ...extracted,
      source_url: null,
      source_platform: null,
      source_author: null,
      source_image_url: null,
      deterministic: false,
    };
  }
  const extracted = await runExtractionTurn(
    { kind: 'photo', base64Jpeg: input.base64Jpeg, mediaType: 'image/jpeg' },
    opts.signal
  );
  return {
    ...extracted,
    source_url: null,
    source_platform: null,
    source_author: null,
    source_image_url: null,
    deterministic: false,
  };
}
