/**
 * Pure routing for share-sheet payloads → the recipe-import screen's input
 * (docs/recipes-grocery.md §8). Instagram/TikTok/Safari deliver the share as
 * text and/or a URL (never the media file); a screenshot share is an image
 * file URI. Priority: an explicit URL beats a URL found inside shared text,
 * beats bare text (prefills the paste rung), beats an image (the screenshot
 * rung). DB-free and side-effect-free so db/recipe-import.test.mjs pins it.
 */

/** The slice of expo-sharing's SharePayload this router reads. */
/**
 * One payload as expo-sharing hands it over.
 *
 * ⚠️ **THE FIELD NAME IS `shareType`, NOT `type`.** This shipped reading `type`,
 * and the test fixtures were written from the same wrong memory — so they agreed
 * with each other and with nothing iOS sends. The consequence was silent and
 * specific: with `type` undefined on every payload, a shared URL still worked
 * (it fell through to the text bucket and the URL was pulled out of the string),
 * while a shared IMAGE was treated as text and prefilled the paste box with a
 * `file:///` path. Verified against node_modules/expo-sharing/build/Sharing.types.d.ts,
 * where SharePayload is `{ value: string; shareType: ShareType; mimeType?: string }`.
 */
export type IncomingSharePayload = {
  /** URL string for 'url', message body for 'text', file URI for media. */
  value: string;
  /** expo-sharing 57 names this field `shareType`, NOT `type` — see the note
   *  in the docstring above. Optional here because the library documents a
   *  `text` default and a payload from a future version may omit it. */
  shareType?: string;
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

  const explicitUrl = usable.find((p) => p.shareType === 'url');
  if (explicitUrl) return { kind: 'url', url: explicitUrl.value.trim() };

  const texts = usable.filter((p) => p.shareType === 'text' || p.shareType === undefined);
  for (const t of texts) {
    const url = firstUrlIn(t.value);
    if (url) return { kind: 'url', url };
  }
  if (texts.length > 0) return { kind: 'text', text: texts[0]!.value };

  const image = usable.find((p) => p.shareType === 'image');
  if (image) return { kind: 'photo', uri: image.value };

  return null;
}
