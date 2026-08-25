/**
 * Turning a fetched HTML page into text a model can read — the page-generic half
 * of what used to live entirely in `src/lib/recipes/extract.ts`.
 *
 * ## Why this moved
 *
 * Nothing in here was ever recipe-specific: decoding entities, reading an
 * og/meta tag, stripping tags, and capping page text are what ANY import rung
 * needs. The knowledge base's article import (docs/knowledge-subapp.md §5) is
 * the second consumer, and forking a second copy of `pageTextForModel` is how
 * two extractors quietly start disagreeing about what "readable text" means —
 * the same failure the `DashedDivider` pitch drift recorded three times in one
 * hour (src/components/ui/block.tsx). So the generic half lives here once, and
 * `recipes/extract.ts` re-exports it so every existing call site and the recipe
 * test fixtures are untouched.
 *
 * Every input here is UNTRUSTED third-party content: parsed defensively with
 * plain string work, never executed, and size-capped by the caller before
 * anything reaches a model prompt. No DOM, no parser dependency — regexes over a
 * string, which is the right tool when the goal is "get the words out", not
 * "build a document tree".
 */

/**
 * The named entities that actually appear in the content these rungs read.
 *
 * Numeric entities are handled generically below; this map exists for the named
 * ones, and it is deliberately not the full HTML5 list (2,231 names) — that
 * would be a table shipped for the sake of `&zwnj;`.
 *
 * The TYPOGRAPHIC block was added 2026-08-12 with article import: publishers set
 * prose through a typographer, so `&mdash;`, `&rsquo;` and the smart quotes are
 * the most common entities on a real article page by a wide margin — far more
 * common than the vulgar fractions the recipe ladder needed. Left undecoded they
 * do not merely look wrong, they get STORED wrong: an imported entry would carry
 * literal `&mdash;` into the knowledge base and into anything the Coach later
 * cites from it. Caught by db/knowledge-import.test.mjs against a real-page
 * fixture.
 */
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
  // Typographic — what a publisher's prose is actually set with.
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  deg: '°',
  plusmn: '±',
  times: '×',
  micro: 'µ',
  copy: '©',
  reg: '®',
  trade: '™',
};

/** Decode the HTML entities that actually appear in og/meta content. */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      const code = parseInt(hex, 16);
      // String.fromCodePoint throws RangeError above U+10FFFF — a value that is
      // still finite, so Number.isFinite lets it through. A malformed entity on
      // an untrusted page must be dropped, never thrown, per this module's
      // defensive contract.
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = parseInt(dec, 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
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

/** Strip tags from an HTML fragment into readable text (<br> → newline). */
export function stripTags(fragment: string): string {
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

/**
 * Every `<script type="application/ld+json">` payload on a page, parsed. A
 * malformed block is skipped rather than hiding a valid one that follows —
 * publishers routinely ship several, and one broken analytics blob must not
 * cost the page its Article metadata.
 */
export function jsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      out.push(JSON.parse(m[1]!.trim()));
    } catch {
      continue;
    }
  }
  return out;
}

/** Does a JSON-LD node carry one of these @types? (string or array form) */
export function typeMatches(node: Record<string, unknown>, wanted: readonly string[]): boolean {
  const t = node['@type'];
  const list = typeof t === 'string' ? [t] : Array.isArray(t) ? t : [];
  return list.some(
    (x) => typeof x === 'string' && wanted.some((w) => x.toLowerCase() === w.toLowerCase())
  );
}

/** schema.org `author` is a string, an object with a name, or an array of either. */
export function authorName(value: unknown): string | null {
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
