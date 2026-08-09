/**
 * Pure routing for share-sheet payloads → the recipe-import screen's input
 * (docs/recipes-grocery.md §8). Instagram/TikTok/Safari deliver the share as
 * text and/or a URL (never the media file); a screenshot share is an image
 * file URI. Priority: an explicit URL beats a URL found inside shared text,
 * beats bare text (prefills the paste rung), beats an image (the screenshot
 * rung). DB-free and side-effect-free so db/recipe-import.test.mjs pins it.
 */

/** The slice of expo-sharing's SharePayload this router reads. */
export type IncomingSharePayload = {
  /** URL string for 'url', message body for 'text', file URI for media. */
  value: string;
  type?: string;
};

export type RecipeImportShare =
  { kind: 'url'; url: string } | { kind: 'text'; text: string } | { kind: 'photo'; uri: string };

/** The first http(s) URL inside a text blob ("check this out https://…"). */
export function firstUrlIn(text: string): string | null {
  const m = /https?:\/\/[^\s"'<>]+/i.exec(text);
  return m ? m[0] : null;
}

/**
 * Map raw shared payloads to ONE import input, or null when nothing usable
 * was shared. Never throws — malformed payloads are skipped.
 */
export function recipeImportShareFromPayloads(
  payloads: IncomingSharePayload[] | null | undefined
): RecipeImportShare | null {
  if (!Array.isArray(payloads)) return null;
  const usable = payloads.filter(
    (p): p is IncomingSharePayload =>
      p !== null && typeof p === 'object' && typeof p.value === 'string' && p.value.trim() !== ''
  );
  if (usable.length === 0) return null;

  const explicitUrl = usable.find((p) => p.type === 'url');
  if (explicitUrl) return { kind: 'url', url: explicitUrl.value.trim() };

  const texts = usable.filter((p) => p.type === 'text' || p.type === undefined);
  for (const t of texts) {
    const url = firstUrlIn(t.value);
    if (url) return { kind: 'url', url };
  }
  if (texts.length > 0) return { kind: 'text', text: texts[0]!.value };

  const image = usable.find((p) => p.type === 'image');
  if (image) return { kind: 'photo', uri: image.value };

  return null;
}
