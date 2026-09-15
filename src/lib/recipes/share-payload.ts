/**
 * Pure routing for share-sheet payloads → the recipe-import screen's input
 * (docs/recipes-grocery.md §8). Instagram/TikTok/Safari deliver the share as
 * text and/or a URL (never the media file); a screenshot share is an image
 * file URI. Priority: an explicit URL beats a URL found inside shared text,
 * beats bare text (prefills the paste rung), beats an image (the screenshot
 * rung). DB-free and side-effect-free so db/recipe-import.test.mjs pins it.
 *
 * **A video is routed too, and routed to a sentence.** ARC cannot derive a
 * recipe from a movie — see {@link VIDEO_SHARE_MESSAGE} — but a payload it
 * cannot use must still ARRIVE, because the alternative (what shipped) was a
 * `null` the screen rendered as "nothing usable was shared".
 *
 * ⚠️ **The branch is dormant in this binary, on purpose.** `app.json`'s
 * `expo-sharing` activation rule is Text · 1 WebURL · 1 Image and carries no
 * `supportsMovieWithMaxCount`, so iOS does not offer ARC as a destination for a
 * movie at all today. The plugin DOES support that key
 * (node_modules/expo-sharing/plugin/src/ios/createInfoPlistFile.ts maps it to
 * `NSExtensionActivationSupportsMovieWithMaxCount`), so widening the rule is one
 * line — but the extension's Info.plist is generated at prebuild, which makes it
 * a rebuild-scoped change and NOT this fix's to make. The routing lands first so
 * that whenever the rule is widened, the honest message is already there.
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
  | { kind: 'url'; url: string }
  | { kind: 'text'; text: string }
  | { kind: 'photo'; uri: string }
  /**
   * A movie. ARC cannot derive a recipe from one (see {@link VIDEO_SHARE_MESSAGE}),
   * so this variant carries no work — it exists so the screen can SAY so. The
   * `uri` rides along unused: a variant that threw its own input away would be
   * the same silence in a different shape.
   */
  | { kind: 'video'; uri: string };

/**
 * What the import screen says when a video arrives.
 *
 * Authored, because the honest answer is specific. The pixels are reachable but
 * the FRAMES are not: deriving a recipe from a movie needs a native decoder
 * (`expo-video` / `expo-video-thumbnails`), which is a dependency plus an EAS
 * build, and the spike stopped at the spec for exactly that reason
 * (docs/spikes/video-recipe-import.md §2). Both working paths are named, because
 * the user holding a reel has both of them one tap away.
 *
 * It does not promise the feature later. The spike's §3c is the reason: what the
 * owner watched another app do was transcribe the AUDIO, and that is structurally
 * out of reach here — so "soon" would be a promise of the wrong thing.
 */
export const VIDEO_SHARE_MESSAGE =
  'ARC can’t read a recipe out of a video — pulling frames from one needs a decoder that isn’t in this build. Paste the caption, or share a screenshot of the ingredient list instead.';

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

  // LAST, deliberately: a reel shared with its caption or its link already
  // matched a rung that WORKS, and this one does not. It fires only when a movie
  // is the whole of what was shared — and then it is the difference between the
  // screen saying why and the screen saying "nothing usable was shared", which
  // is what it said before (a silent null, found by the video spike).
  const video = usable.find((p) => p.shareType === 'video');
  if (video) return { kind: 'video', uri: video.value };

  return null;
}
