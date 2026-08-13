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
  ) => Promise<{ base64?: string | null }>;
  SaveFormat: { JPEG: string };
};

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
 * Re-encode any image URI to a downscaled JPEG in base64.
 *
 * Exported because the SHARE path needs it too: a screenshot arriving through
 * the iOS share sheet was being read straight off disk and sent to the model
 * labelled `image/jpeg` whatever it actually was — a PNG or HEIC screenshot
 * mislabelled, at full resolution, with no cap. Same pass, same 1024px, same
 * quality, so both entry points speak the format they claim.
 *
 * Null when the manipulator is absent (this binary) or the read fails; the
 * caller then falls back to whatever it already had.
 */
export async function downscaleToJpegBase64(
  uri: string,
  opts: DownscaleOptions = {}
): Promise<string | null> {
  const manipulator = loadManipulator();
  if (!manipulator) return null;
  const { width = DEFAULT_WIDTH, quality = DEFAULT_QUALITY } = opts;
  try {
    const shrunk = await manipulator.manipulateAsync(uri, [{ resize: { width } }], {
      compress: quality,
      format: manipulator.SaveFormat.JPEG,
      base64: true,
    });
    return shrunk.base64 ?? null;
  } catch {
    return null;
  }
}

/**
 * How hard to shrink. The defaults are the plate/ingredient-list figure: 1024px
 * at 0.6 is more than a vision model needs to read a meal.
 *
 * It is a dial rather than a constant because the WORKOUT importer legitimately
 * needs more. It reads a screenshot of another app's set table — small type, and
 * a grid of numbers that has to survive the round trip — so it runs 1280 at 0.7.
 * It used to get that by shipping its own copy of the whole pick-and-shrink,
 * including `import * as ImagePicker from 'expo-image-picker'` at module scope,
 * which is what broke app startup (see the guarded-require note at the top of
 * this file). One seam with a dial beats two call sites where only one is
 * guarded.
 */
export type DownscaleOptions = { width?: number; quality?: number };

const DEFAULT_WIDTH = 1024;
const DEFAULT_QUALITY = 0.6;

export type PickedPhoto =
  | { kind: 'photo'; base64Jpeg: string }
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
      const shrunk = await downscaleToJpegBase64(asset.uri, opts);
      if (shrunk) return { kind: 'photo', base64Jpeg: shrunk };
    }
    if (asset.base64) return { kind: 'photo', base64Jpeg: asset.base64 };
    return { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}
