/**
 * Picking a photo out of the iOS library, once, for both screens that need it:
 * the meal estimator (`app/meal-estimate.tsx` — owner request, 2026-08-11:
 * *"add functionality to upload a photo from my photo library for nutrition
 * tracking"*) and the recipe importer's screenshot rung
 * (`app/recipe-import.tsx`, docs/recipes-grocery.md §5 rung 7).
 *
 * **Guarded require, the healthkit.ts seam.** `expo-image-picker` is a native
 * module: it is in `package.json` and in `app.json`'s plugin list, but it does
 * not exist in the binary until the next EAS build. A static import would make
 * this module unloadable on the current app — so the require is wrapped, the
 * shape is checked, and the absence is a `null` the caller explains in words.
 * Never a crash, never a silently dead button.
 *
 * **The downscale is not optional.** A modern iPhone screenshot base64s to
 * several megabytes; sending that to a vision model is slow, expensive, and
 * pointless — 1024px wide at quality 0.6 is more than a model needs to read a
 * plate or an ingredient list. `expo-image-manipulator` is already in the build
 * (the camera path uses it), so this costs no new dependency.
 */

type PickerModule = {
  launchImageLibraryAsync: (opts: Record<string, unknown>) => Promise<{
    canceled: boolean;
    assets?: { uri?: string; base64?: string | null }[];
  }>;
};

type ManipulatorModule = {
  manipulateAsync: (
    uri: string,
    actions: { resize: { width: number } }[],
    options: { compress: number; format: string; base64: boolean }
  ) => Promise<{ base64?: string | null; width?: number; height?: number }>;
  SaveFormat: { JPEG: string };
};

/** The one downscale, so every path speaks the same JPEG. */
const RESIZE_WIDTH = 1024;
const COMPRESS = 0.6;

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
export async function downscaleJpeg(uri: string): Promise<DownscaledJpeg | null> {
  const manipulator = loadManipulator();
  if (!manipulator) return null;
  try {
    const shrunk = await manipulator.manipulateAsync(uri, [{ resize: { width: RESIZE_WIDTH } }], {
      compress: COMPRESS,
      format: manipulator.SaveFormat.JPEG,
      base64: true,
    });
    if (!shrunk.base64) return null;
    return {
      base64Jpeg: shrunk.base64,
      width: shrunk.width ?? null,
      height: shrunk.height ?? null,
    };
  } catch {
    return null;
  }
}

/** {@link downscaleJpeg} for the share path, which only ever wanted the bytes.
 *  Kept as its own export so that caller reads as what it is. */
export async function downscaleToJpegBase64(uri: string): Promise<string | null> {
  return (await downscaleJpeg(uri))?.base64Jpeg ?? null;
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
export async function pickPhotoBase64(): Promise<PickedPhoto> {
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
      const shrunk = await downscaleJpeg(asset.uri);
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
