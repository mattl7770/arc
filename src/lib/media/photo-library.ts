/**
 * Picking a photo out of the iOS library, once, for both screens that need it:
 * the meal estimator (`app/meal-estimate.tsx` — owner request, 2026-08-11:
 * *"add functionality to upload a photo from my photo library for nutrition
 * tracking"*) and the recipe importer's screenshot rung
 * (`app/recipe-import.tsx`, docs/recipes-grocery.md §5 rung 7).
 *
 * **Guarded require, the healthkit.ts seam.** `expo-image-picker` is a native
 * module: it is in `package.json` and in `app.json`'s plugin list, and (having
 * been there before the owner's 2026-08-25 EAS rebuild) it is in the binary
 * now. The require stays wrapped anyway — a static import would make this
 * module unloadable on any build predating it (or on web/node), so the
 * require is wrapped, the shape is checked, and the absence is a `null` the
 * caller explains in words. Never a crash, never a silently dead button.
 *
 * **The downscale is not optional.** A modern iPhone screenshot base64s to
 * several megabytes; sending that to a vision model is slow, expensive, and
 * pointless — a 1024px LONG EDGE at quality 0.6 is more than a model needs to
 * read a plate or an ingredient list. `expo-image-manipulator` is already in the
 * build (the camera path uses it), so this costs no new dependency.
 *
 * **Long edge, not width.** This shipped bounding the *width*, and almost
 * everything a phone hands it is portrait — so 1024 was the SHORT edge and every
 * frame went out at ~3× the visual tokens it needed (a 9:16 screenshot: 1024×1820
 * ≈ 2,405 tokens against 576×1024 ≈ 777). Found by the D1 video spike,
 * docs/spikes/video-recipe-import.md §3b, which costed it. See
 * {@link longEdgeResize}.
 */

type PickerModule = {
  launchImageLibraryAsync: (opts: Record<string, unknown>) => Promise<{
    canceled: boolean;
    /**
     * `uri`/`base64` are the two fields this seam has always used. `assetId`
     * and `exif` were added for progress photos (2026-08-12) and are typed as
     * loosely as they are UNVERIFIED: neither has ever been exercised in this
     * codebase, and every read of them goes through the pure parsers in
     * src/lib/photos/import.ts rather than being destructured at a call site.
     * That is the wearables lesson applied — a wire shape nobody has seen on
     * device is parsed defensively, with fixtures, or it crashes a screen the
     * first time the real payload disagrees.
     */
    assets?: {
      uri?: string;
      base64?: string | null;
      assetId?: string | null;
      exif?: Record<string, unknown> | null;
      /** Epoch milliseconds, on the picker versions that expose it. UNVERIFIED
       *  like the two above; the parser treats its absence as normal. */
      creationTime?: number | null;
      width?: number;
      height?: number;
    }[];
  }>;
};

type ManipulatorModule = {
  manipulateAsync: (
    uri: string,
    /** One dimension only — the manipulator preserves the aspect from whichever
     *  is given, and giving both would stretch the image. */
    actions: { resize: { width?: number; height?: number } }[],
    options: { compress: number; format: string; base64: boolean }
  ) => Promise<{ base64?: string | null; width?: number; height?: number }>;
  SaveFormat: { JPEG: string };
};

/**
 * The one downscale, so every path speaks the same JPEG.
 *
 * **It bounds the LONGEST edge, not the width** — see {@link longEdgeResize}.
 * It used to bound the width, and on a portrait frame that is the SHORT edge:
 * a 9:16 screenshot went out at 1024×1820 and billed ~2,405 visual tokens where
 * 576×1024 bills ~777 for the same legibility class. Roughly 3× the vision bill
 * on every meal photo, every recipe screenshot and every progress-photo read.
 */
const RESIZE_EDGE = 1024;
const COMPRESS = 0.6;

/**
 * Which dimension to hand the manipulator so the LONGEST edge lands on `edge`.
 *
 * The manipulator resizes by one dimension and preserves the aspect from it
 * (passing both would stretch), so bounding the long edge is a choice *between*
 * width and height — and it needs the source's shape to make it. Claude bills an
 * image in 28×28 patches (`⌈w/28⌉ × ⌈h/28⌉`), so on a 9:16 frame the difference
 * between bounding the width and bounding the height is ~3× the tokens for the
 * same readable picture.
 *
 * Dimensions the caller did not have fall back to width — the conservative old
 * contract, never a guess at portrait. {@link downscaleJpeg} then corrects that
 * fallback from the manipulator's own report rather than living with it.
 */
export function longEdgeResize(
  width: number | null | undefined,
  height: number | null | undefined,
  edge: number
): { width: number } | { height: number } {
  if (width != null && height != null && height > width) return { height: edge };
  return { width: edge };
}

/**
 * Did a width-bounded pass leave the long edge over budget? True only for a
 * portrait result that is still taller than `edge` — i.e. exactly when the
 * dimension-less fallback in {@link longEdgeResize} guessed wrong.
 */
export function overLongEdge(
  width: number | null | undefined,
  height: number | null | undefined,
  edge: number
): boolean {
  return width != null && height != null && height > width && height > edge;
}

/**
 * A downscaled JPEG plus the dimensions it actually came out at.
 *
 * The dimensions are new with 0033. The image used to be a model payload and
 * nothing else, so its shape did not matter; it is now also stored and shown on
 * the meal, and the meal screen draws it at its own aspect rather than cropping
 * it to a guessed square. Null when the manipulator did not report them — no
 * data, no number, and the reader falls back to a fixed frame.
 */
export type DownscaledJpeg = { base64Jpeg: string; width: number | null; height: number | null };

/**
 * The downscaler, loaded the same lazy way as the picker.
 *
 * `expo-image-manipulator` is native too, and NOTHING native may be resolved at
 * import time here: this module is pulled in by screens that may never open the
 * library, and the headless render suite (`db/screens-render.test.mjs`) walks
 * their import graph for real. A static import turns a rendering test into a
 * missing-native-module crash — which is exactly what it did the first time.
 */
function loadManipulator(): ManipulatorModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-image-manipulator') as Partial<ManipulatorModule>;
    if (typeof mod.manipulateAsync !== 'function' || !mod.SaveFormat) return null;
    return mod as ManipulatorModule;
  } catch {
    return null;
  }
}

/** The module, or null on a binary that predates it. */
export function loadImagePicker(): PickerModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-image-picker') as Partial<PickerModule>;
    if (typeof mod.launchImageLibraryAsync !== 'function') return null;
    return mod as PickerModule;
  } catch {
    return null;
  }
}

/** Whether this binary can open the photo library at all. */
export function isPhotoLibraryAvailable(): boolean {
  return loadImagePicker() !== null;
}

/**
 * Re-encode any image URI to a downscaled JPEG — **the single downscale in the
 * app**, and the one place the 1024/0.6 numbers appear.
 *
 * Three paths reach it, and before 0033 two of them had their own copy of this
 * call: the library picker below, the iOS share sheet
 * (`src/lib/recipes/incoming-share.ts` — where a PNG or HEIC screenshot was
 * being read straight off disk and posted labelled `image/jpeg` at full
 * resolution), and the meal estimator's CAMERA button, which inlined its own
 * `manipulateAsync` in the screen. They are now one function, which is what
 * makes "the photo stored on the meal is byte-identical to the one the model
 * was shown" true of every entry point rather than of two out of three.
 *
 * Null when the manipulator is absent (never in this binary — it ships) or the
 * read fails; the caller falls back to whatever it already had.
 */
export async function downscaleJpeg(
  uri: string,
  opts: DownscaleOptions = {}
): Promise<DownscaledJpeg | null> {
  const manipulator = loadManipulator();
  if (!manipulator) return null;
  const { quality = COMPRESS } = opts;
  const encode = { compress: quality, format: manipulator.SaveFormat.JPEG, base64: true };
  const edge = opts.maxEdge ?? RESIZE_EDGE;
  // An explicitly named dimension is honoured exactly and never second-guessed:
  // it is the contract the workout importer and the progress-photo working copy
  // are written against, and both have already decided which edge they mean.
  const explicit =
    opts.width != null
      ? { width: opts.width }
      : opts.height != null
        ? { height: opts.height }
        : null;
  const knewShape = opts.source?.width != null && opts.source?.height != null;
  const resize = explicit ?? longEdgeResize(opts.source?.width, opts.source?.height, edge);
  try {
    const shrunk = await manipulator.manipulateAsync(uri, [{ resize }], encode);
    if (!shrunk.base64) return null;
    // The dimension-less fallback bounded the WIDTH, so a portrait source came
    // out over budget on its long edge. Redo it from the ORIGINAL (re-shrinking
    // the shrunk copy would compound the JPEG loss), bounded by height this
    // time. One extra native pass, only on the guess that was wrong, and only
    // for the callers that genuinely cannot know their source's shape — a
    // screenshot off the share sheet, a stored progress photo. Everything that
    // picks through `pickPhotoBase64` or the camera hands its dimensions over
    // and never reaches here.
    if (explicit === null && !knewShape && overLongEdge(shrunk.width, shrunk.height, edge)) {
      const redone = await manipulator.manipulateAsync(uri, [{ resize: { height: edge } }], encode);
      if (redone.base64) {
        return {
          base64Jpeg: redone.base64,
          width: redone.width ?? null,
          height: redone.height ?? null,
        };
      }
    }
    return {
      base64Jpeg: shrunk.base64,
      width: shrunk.width ?? null,
      height: shrunk.height ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * How hard to shrink. The defaults above (long edge 1024 at 0.6) are the plate
 * and ingredient-list figure — more than a vision model needs to read a meal —
 * and they remain the only numbers most callers ever see.
 *
 * It is a dial rather than a constant because the WORKOUT importer legitimately
 * needs more: it reads a screenshot of another app's set table, where the type
 * is small and a grid of numbers has to survive the round trip, so it runs 1280
 * at 0.7. It used to get that by shipping its own copy of the whole
 * pick-and-shrink — including `import * as ImagePicker from 'expo-image-picker'`
 * at module scope, which is what broke app startup. One seam with a dial beats
 * two call sites where only one is guarded.
 */
export type DownscaleOptions = {
  /**
   * Bound the WIDTH, whichever edge that is. The explicit contract, and it wins
   * over {@link maxEdge}: the two callers that pass it have already decided
   * which edge they mean. The workout importer keeps it deliberately — on a
   * portrait set table the width is what carries the numbers, and a misread
   * weight is a corrupted workout record, which is worth more than the tokens.
   */
  width?: number;
  /**
   * Bound the HEIGHT. Explicit like {@link width} and ignored when `width` is
   * also given: the manipulator preserves the aspect from one dimension, and
   * passing both would stretch the image.
   */
  height?: number;
  /**
   * Bound the LONGEST edge at this many pixels — **the default shape**, and the
   * one that costs what it should (see {@link longEdgeResize}). Pass `source`
   * with it wherever the caller was handed the dimensions; without them the
   * seam bounds the width and then corrects itself from the manipulator's
   * report, which is right but costs a second pass.
   */
  maxEdge?: number;
  /**
   * The source's pixel dimensions, when the caller has them — the picker and the
   * camera both report them. Purely an optimisation and a certainty: with them
   * the long edge is chosen in one pass, without them it is corrected in two.
   */
  source?: { width?: number | null; height?: number | null };
  quality?: number;
};

/** {@link downscaleJpeg} for the share path, which only ever wanted the bytes.
 *  Kept as its own export so that caller reads as what it is. */
export async function downscaleToJpegBase64(
  uri: string,
  opts: DownscaleOptions = {}
): Promise<string | null> {
  return (await downscaleJpeg(uri, opts))?.base64Jpeg ?? null;
}

/**
 * One asset as the picker handed it over, before anything has been decoded.
 *
 * Deliberately raw: the fields whose shapes are unverified (`assetId`, `exif`)
 * ride out of here as-is and are read only by the pure parsers in
 * src/lib/photos/import.ts. Nothing between the picker and those parsers makes
 * an assumption about them.
 */
export type PickedLibraryAsset = {
  uri: string;
  assetId: string | null;
  exif: Record<string, unknown> | null;
  /**
   * Epoch milliseconds, when the picker supplies one — the fallback date source
   * for a photo with no EXIF (a screenshot, a re-saved or AirDropped copy).
   *
   * It must be carried through explicitly: this object is built field by field,
   * so anything not named here is dropped, and dropping it silently made
   * `assetPhotoDate`'s documented second source unreachable in production while
   * its unit test kept passing against a hand-built object. Found by adversarial
   * review, 2026-08-12.
   */
  creationTime: number | null;
  width: number | null;
  height: number | null;
};

export type PickedLibraryAssets =
  | { kind: 'assets'; assets: PickedLibraryAsset[] }
  | { kind: 'canceled' }
  | { kind: 'unavailable' }
  | { kind: 'failed' };

/**
 * Open the library for a MULTI-select and hand back the raw assets — no
 * decoding, no downscale, no base64.
 *
 * Progress photos backfill years at a time, so the batch is the first-run flow
 * rather than an afterthought; and the caller needs each asset's URI to survive
 * past the pick so it can make a working copy AND, for a flagged photo, a
 * full-resolution copy from the same source. Asking the picker for base64 here
 * would decode thirty full-size images into memory to throw twenty-nine of them
 * away.
 *
 * `quality: 1` matters: a lower quality makes the picker hand back a
 * re-compressed cache copy, and the full-resolution "important" copy would then
 * be a copy of a copy.
 *
 * Never throws — every failure is a variant the caller renders in words.
 */
export async function pickPhotoLibraryAssets(
  opts: { limit?: number } = {}
): Promise<PickedLibraryAssets> {
  const picker = loadImagePicker();
  if (!picker) return { kind: 'unavailable' };
  try {
    const result = await picker.launchImageLibraryAsync({
      mediaTypes: 'images',
      quality: 1,
      base64: false,
      exif: true,
      allowsMultipleSelection: true,
      orderedSelection: true,
      selectionLimit: opts.limit ?? 30,
    });
    if (result.canceled) return { kind: 'canceled' };
    const assets: PickedLibraryAsset[] = [];
    for (const asset of result.assets ?? []) {
      if (!asset?.uri) continue;
      assets.push({
        uri: asset.uri,
        assetId: typeof asset.assetId === 'string' ? asset.assetId : null,
        exif: asset.exif ?? null,
        creationTime: typeof asset.creationTime === 'number' ? asset.creationTime : null,
        width: typeof asset.width === 'number' ? asset.width : null,
        height: typeof asset.height === 'number' ? asset.height : null,
      });
    }
    if (assets.length === 0) return { kind: 'canceled' };
    return { kind: 'assets', assets };
  } catch {
    return { kind: 'failed' };
  }
}

/**
 * Re-encode an image URI as a JPEG at its NATIVE size — the same manipulator
 * pass as {@link downscaleJpeg} with the resize step omitted.
 *
 * Exists for exactly one caller: the full-resolution copy a progress photo keeps
 * when it is flagged important at pick time. Everything else in the app wants
 * the downscale, and should keep using it.
 *
 * The re-encode is not a no-op even at quality 1 — a HEIC off the camera roll
 * becomes a JPEG, which is what the store and every reader expect.
 */
export async function encodeJpeg(uri: string, quality = 0.9): Promise<string | null> {
  const manipulator = loadManipulator();
  if (!manipulator) return null;
  try {
    const encoded = await manipulator.manipulateAsync(uri, [], {
      compress: quality,
      format: manipulator.SaveFormat.JPEG,
      base64: true,
    });
    return encoded.base64 ?? null;
  } catch {
    return null;
  }
}

export type PickedPhoto =
  | ({ kind: 'photo' } & DownscaledJpeg)
  /** The user backed out of the picker — not an error, and not a message. */
  | { kind: 'canceled' }
  /** No picker in this binary; the caller says so and offers its fallback. */
  | { kind: 'unavailable' }
  | { kind: 'failed' };

/**
 * Open the library, take one image, and return it as a downscaled JPEG in
 * base64 — the shape both vision paths already speak. Never throws: every
 * failure is a variant the caller can render.
 */
export async function pickPhotoBase64(opts: DownscaleOptions = {}): Promise<PickedPhoto> {
  const picker = loadImagePicker();
  if (!picker) return { kind: 'unavailable' };
  try {
    const result = await picker.launchImageLibraryAsync({
      mediaTypes: 'images',
      quality: 1,
      // base64 straight from the picker is the FALLBACK path — used when the
      // manipulator is absent or the asset has no uri. The downscale below is
      // what normally produces it, and it is what keeps the payload small.
      base64: true,
    });
    if (result.canceled) return { kind: 'canceled' };
    const asset = result.assets?.[0];
    if (!asset) return { kind: 'canceled' };
    if (asset.uri) {
      // The picker reports the asset's pixel dimensions, so the long edge is
      // known here and the downscale never has to guess-then-correct. Callers
      // that pass their own `source` keep it.
      const shrunk = await downscaleJpeg(asset.uri, {
        source: { width: asset.width ?? null, height: asset.height ?? null },
        ...opts,
      });
      if (shrunk) return { kind: 'photo', ...shrunk };
    }
    // The fallback carries no dimensions, so a meal photo stored from it draws
    // in the fixed frame rather than at a fabricated aspect.
    if (asset.base64) {
      return { kind: 'photo', base64Jpeg: asset.base64, width: null, height: null };
    }
    return { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}
