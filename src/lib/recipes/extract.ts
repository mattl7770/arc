/**
 * Pure extraction parsers for the recipe-import ladder (docs/recipes-grocery.md
 * §2c): schema.org Recipe JSON-LD (websites — deterministic, NO model call),
 * Instagram og:description / embed-captioned pages, TikTok oEmbed JSON, and
 * YouTube watch-page descriptions. All string-in → data-out, fetch-free, so
 * db/recipe-import.test.mjs pins them against fixture payloads (the
 * health-mapping discipline: wire shapes are parsed in exported pure functions).
 *
 * Every input here is UNTRUSTED third-party content: parsed defensively,
 * never executed, and the callers cap sizes before anything reaches a model
 * prompt.
 */

/** What deterministic extraction yields (JSON-LD path) — review-ready. */
export type ExtractedRecipe = {
  title: string;
  ingredients: string[];
  steps: string[];
  servings: number | null;
  prep_min: number | null;
  cook_min: number | null;
  author: string | null;
  image_url: string | null;
};

// --- Shared helpers -----------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
};

/** Decode the HTML entities that actually appear in og/meta content. */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&([a-zA-Z0-9]+);/g, (whole, name: string) => NAMED_ENTITIES[name] ?? whole);
}

/** `<meta property="og:description" content="…">` — attribute order tolerant. */
export function metaContent(html: string, property: string): string | null {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The value must be captured up to the SAME quote that opened it — a raw
  // apostrophe inside a double-quoted attribute is legal, common HTML, and a
  // mixed [^"']* class would truncate the caption at the first one.
  const attr = `(?:property|name)=["']${escaped}["']`;
  const value = `content=(?:"([^"]*)"|'([^']*)')`;
  const patterns = [
    new RegExp(`<meta[^>]*${attr}[^>]*${value}`, 'i'),
    new RegExp(`<meta[^>]*${value}[^>]*${attr}`, 'i'),
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) {
      const raw = m[1] ?? m[2];
      if (raw !== undefined) return decodeHtmlEntities(raw);
    }
  }
  return null;
}

/** ISO-8601 duration ("PT1H15M", "PT30M") → whole minutes, or null. */
export function isoDurationToMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(value.trim());
  if (
    !m ||
    (m[1] === undefined && m[2] === undefined && m[3] === undefined && m[4] === undefined)
  ) {
    return null;
  }
  const days = m[1] ? Number(m[1]) : 0;
  const hours = m[2] ? Number(m[2]) : 0;
  const minutes = m[3] ? Number(m[3]) : 0;
  const seconds = m[4] ? Number(m[4]) : 0;
  return days * 1440 + hours * 60 + minutes + Math.round(seconds / 60);
}

/** schema.org recipeYield is free text ("4 servings", "one 9-inch pie", 6,
 * ["8", "8 servings"]) — take the first positive number found, else null. */
export function parseYield(value: unknown): number | null {
  const candidates = Array.isArray(value) ? value : [value];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) return c;
    if (typeof c === 'string') {
      const m = /(\d+(?:\.\d+)?)/.exec(c);
      if (m) {
        const n = Number(m[1]);
        if (n > 0) return n;
      }
    }
  }
  return null;
}

/** Strip tags from an HTML fragment into readable text (<br> → newline). */
function stripTags(fragment: string): string {
  return decodeHtmlEntities(
    fragment
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- schema.org Recipe JSON-LD (rung 1 — deterministic, no AI) ---------------

function typeMatches(node: Record<string, unknown>, wanted: string): boolean {
  const t = node['@type'];
  if (typeof t === 'string') return t.toLowerCase() === wanted.toLowerCase();
  if (Array.isArray(t))
    return t.some((x) => typeof x === 'string' && x.toLowerCase() === wanted.toLowerCase());
  return false;
}

/** Depth-first hunt for the first @type: Recipe node in a parsed ld+json
 * payload (handles bare objects, arrays, and @graph wrappers). */
function findRecipeNode(payload: unknown, depth: number = 0): Record<string, unknown> | null {
  if (depth > 4 || payload === null || typeof payload !== 'object') return null;
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const hit = findRecipeNode(entry, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const node = payload as Record<string, unknown>;
  if (typeMatches(node, 'Recipe')) return node;
  if (Array.isArray(node['@graph'])) return findRecipeNode(node['@graph'], depth + 1);
  return null;
}

function instructionText(entry: unknown): string[] {
  if (typeof entry === 'string') {
    const t = stripTags(entry);
    return t === '' ? [] : [t];
  }
  if (entry === null || typeof entry !== 'object') return [];
  const node = entry as Record<string, unknown>;
  // HowToSection: recurse into its itemListElement (section names dropped —
  // steps read better flat; the review screen is editable anyway).
  if (Array.isArray(node.itemListElement)) {
    return node.itemListElement.flatMap(instructionText);
  }
  if (typeof node.text === 'string') {
    const t = stripTags(node.text);
    return t === '' ? [] : [t];
  }
  if (typeof node.name === 'string') {
    const t = stripTags(node.name);
    return t === '' ? [] : [t];
  }
  return [];
}

function authorName(value: unknown): string | null {
  const candidates = Array.isArray(value) ? value : [value];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c.trim();
    if (c !== null && typeof c === 'object') {
      const name = (c as Record<string, unknown>).name;
      if (typeof name === 'string' && name.trim() !== '') return name.trim();
    }
  }
  return null;
}

function imageUrl(value: unknown): string | null {
  const candidates = Array.isArray(value) ? value : [value];
  for (const c of candidates) {
    if (typeof c === 'string' && /^https?:\/\//.test(c)) return c;
    if (c !== null && typeof c === 'object') {
      const url = (c as Record<string, unknown>).url;
      if (typeof url === 'string' && /^https?:\/\//.test(url)) return url;
    }
  }
  return null;
}

/**
 * Extract a schema.org Recipe from page HTML via its ld+json blocks. Returns
 * null when no parseable Recipe node exists (→ the ladder falls through to the
 * model). Malformed JSON in one block never hides a valid Recipe in another.
 */
export function extractJsonLdRecipe(html: string): ExtractedRecipe | null {
  const blocks: string[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]!);

  for (const block of blocks) {
    let payload: unknown;
    try {
      payload = JSON.parse(block.trim());
    } catch {
      continue;
    }
    const node = findRecipeNode(payload);
    if (!node) continue;

    const title =
      typeof node.name === 'string' && node.name.trim() !== ''
        ? decodeHtmlEntities(node.name.trim())
        : null;
    const rawIngredients = Array.isArray(node.recipeIngredient)
      ? node.recipeIngredient
      : Array.isArray(node.ingredients) // legacy schema.org spelling
        ? node.ingredients
        : [];
    const ingredients = rawIngredients
      .filter((i): i is string => typeof i === 'string')
      .map((i) => stripTags(i))
      .filter((i) => i !== '');
    const instructions = node.recipeInstructions;
    const steps = (Array.isArray(instructions) ? instructions : [instructions]).flatMap(
      instructionText
    );
    if (!title || ingredients.length === 0) continue;

    return {
      title,
      ingredients,
      steps,
      servings: parseYield(node.recipeYield),
      prep_min: isoDurationToMinutes(node.prepTime),
      cook_min: isoDurationToMinutes(node.cookTime),
      author: authorName(node.author),
      image_url: imageUrl(node.image),
    };
  }
  return null;
}

// --- Instagram (rung 3) -------------------------------------------------------

/**
 * The caption from an Instagram post/reel page's og tags. The og:description
 * shape is `<likes>, <comments> - <user> on <date>: "<caption>"` — the quoted
 * caption is extracted when that pattern holds, else the whole decoded content
 * is returned (never less than what the page gave us). Null when the page is
 * the desktop-UA JS shell with no og tags (→ try the embed variant, then the
 * paste fallback).
 */
export function extractInstagramCaption(html: string): string | null {
  const og = metaContent(html, 'og:description');
  if (!og || og.trim() === '') return null;
  const quoted = /:\s*"([\s\S]+)"\s*$/.exec(og);
  const caption = quoted ? quoted[1]! : og;
  const trimmed = caption.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The caption from an /embed/captioned/ page — the server-rendered fallback
 * when og:description is absent or truncated. Reads the Caption block, strips
 * markup. Null when the shell came back instead.
 */
export function extractInstagramEmbedCaption(html: string): string | null {
  const start = html.search(/class=["']Caption["']/);
  if (start === -1) return null;
  const window = html.slice(start, start + 20000);
  const afterTag = window.slice(window.indexOf('>') + 1);
  const endMarkers = [/class=["']CaptionComments["']/, /<\/section>/i, /<\/body>/i];
  let end = afterTag.length;
  for (const marker of endMarkers) {
    const idx = afterTag.search(marker);
    if (idx !== -1 && idx < end) end = idx;
  }
  const text = stripTags(afterTag.slice(0, end));
  return text === '' ? null : text;
}

/** og:image (the thumbnail we store but do not render yet — Phase 4). */
export function extractOgImage(html: string): string | null {
  const url = metaContent(html, 'og:image');
  return url && /^https?:\/\//.test(url) ? url : null;
}

/** og:title's leading "<Display Name> on Instagram: …" → the author. */
export function extractInstagramAuthor(html: string): string | null {
  const title = metaContent(html, 'og:title');
  if (!title) return null;
  const m = /^(.+?)\s+on Instagram/i.exec(title);
  return m ? m[1]!.trim() : null;
}

// --- TikTok (rung 4) ----------------------------------------------------------

export type TikTokOembed = { caption: string; author: string | null; image_url: string | null };

/** TikTok's auth-free oEmbed JSON — `title` IS the caption (verified
 * 2026-08-08). Null when the payload isn't the expected shape. */
export function extractTikTokCaption(oembedJson: string): TikTokOembed | null {
  let raw: unknown;
  try {
    raw = JSON.parse(oembedJson);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const caption = typeof obj.title === 'string' ? obj.title.trim() : '';
  if (caption === '') return null;
  return {
    caption,
    author: typeof obj.author_name === 'string' ? obj.author_name : null,
    image_url:
      typeof obj.thumbnail_url === 'string' && /^https?:\/\//.test(obj.thumbnail_url)
        ? obj.thumbnail_url
        : null,
  };
}

// --- YouTube (rung 5) ---------------------------------------------------------

/**
 * The full description from an anonymous watch-page's ytInitialPlayerResponse
 * ("shortDescription" — despite the name, it is the complete description).
 * Null when the page doesn't carry it.
 */
export function extractYouTubeDescription(html: string): string | null {
  const m = /"shortDescription":"((?:[^"\\]|\\.)*)"/.exec(html);
  if (!m) return null;
  try {
    const decoded = JSON.parse(`"${m[1]}"`) as string;
    const trimmed = decoded.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}

// --- Generic page text (rung 2 → the model) -----------------------------------

/**
 * Strip a page down to readable text for the model turn: scripts/styles/nav
 * furniture out, tags off, whitespace collapsed, size-capped (tool results are
 * re-sent every model round-trip — a 600 KB page must never reach a prompt).
 */
export function pageTextForModel(html: string, cap: number = 20000): string {
  const withoutBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(?:nav|header|footer|aside)[\s\S]*?<\/(?:nav|header|footer|aside)>/gi, ' ');
  const text = stripTags(withoutBlocks)
    .replace(/\s{2,}/g, ' ')
    .trim();
  return text.length > cap ? text.slice(0, cap) : text;
}
