/**
 * Provenance extraction for article import (docs/knowledge-subapp.md §5, rung 1).
 *
 * Deliberately NARROW. There is no deterministic article→entry rung and there
 * never will be: a recipe's JSON-LD carries the ingredients and the steps, which
 * IS the recipe, but an article's Article/NewsArticle node carries a headline, a
 * byline and a date — never the doctrine. So this reads metadata only, to
 * PREFILL the review screen's provenance fields, and the model turn always
 * follows. Getting that boundary wrong would mean shipping an entry assembled
 * from a headline, which is exactly the fabrication the ladder's `found:false`
 * rule exists to prevent.
 *
 * The readable-text half is `pageTextForModel` in src/lib/html/readable.ts —
 * shared with the recipe ladder, not forked from it.
 *
 * All inputs are UNTRUSTED third-party HTML: string-in → data-out, fetch-free,
 * never executed, pinned against real-page-shaped fixtures in
 * db/knowledge-import.test.mjs.
 */
import { authorName, jsonLdBlocks, metaContent, typeMatches } from '@/lib/html/readable';

/** What a page tells us about itself, before the model reads a word of it. */
export type ArticleMeta = {
  /** The headline, for the review screen's title prefill. */
  title: string | null;
  /** Byline or publication — whichever the page actually states. */
  author: string | null;
  /** The publication's own name (og:site_name), when it differs from the byline. */
  site: string | null;
};

const ARTICLE_TYPES = ['Article', 'NewsArticle', 'BlogPosting', 'ScholarlyArticle'] as const;

/** Depth-first hunt for the first Article-ish node (bare, array, or @graph). */
function findArticleNode(payload: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 4 || payload === null || typeof payload !== 'object') return null;
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const hit = findArticleNode(entry, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const node = payload as Record<string, unknown>;
  if (typeMatches(node, ARTICLE_TYPES)) return node;
  if (Array.isArray(node['@graph'])) return findArticleNode(node['@graph'], depth + 1);
  return null;
}

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Read a page's article provenance: JSON-LD first (publishers who ship it ship
 * it accurately), then og/meta as the fallback every page has.
 *
 * Never throws and never returns a fabricated field — a page with no metadata
 * yields all-nulls, and the review screen simply shows blank provenance for the
 * user to fill or leave.
 */
export function extractArticleMeta(html: string): ArticleMeta {
  let title: string | null = null;
  let author: string | null = null;

  for (const payload of jsonLdBlocks(html)) {
    const node = findArticleNode(payload);
    if (!node) continue;
    title = clean(node.headline) ?? clean(node.name);
    author = authorName(node.author);
    if (title || author) break;
  }

  // og/meta fallback, field by field — a page can carry a good byline and no
  // JSON-LD headline, so this fills gaps rather than replacing the whole result.
  title ??= clean(metaContent(html, 'og:title')) ?? clean(titleTag(html));
  author ??=
    clean(metaContent(html, 'article:author')) ??
    clean(metaContent(html, 'author')) ??
    clean(metaContent(html, 'twitter:creator'));

  const site = clean(metaContent(html, 'og:site_name'));
  return { title, author, site };
}

/** `<title>…</title>`, the last-resort headline. */
function titleTag(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? m[1]! : null;
}

/**
 * Attribution for the entry's `source_author`: the byline when the page states
 * one, else the publication, else nothing. Never both concatenated — the review
 * screen shows one attribution line and the user can edit it.
 */
export function attributionFrom(meta: ArticleMeta): string | null {
  return meta.author ?? meta.site ?? null;
}
