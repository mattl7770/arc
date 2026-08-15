import type { ComponentType, Ref } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

/**
 * The camera, behind a guarded seam — `expo-camera` resolved once, at first use,
 * never at module scope of a route file.
 *
 * **Why this file exists at all.** `app/meal-estimate.tsx` and
 * `app/barcode-scan.tsx` both carried `import { CameraView, useCameraPermissions }
 * from 'expo-camera'` at module scope. Expo Router eagerly requires every file
 * under `app/` to build its route manifest, so an unguarded native import in one
 * screen nobody has opened is a hard error at app **LAUNCH** — the exact failure
 * that shipped twice (`expo-image-picker`, `expo-keep-awake`; see
 * docs/project-status.md › Device / builds). `expo-camera` happens to be in the
 * binary currently on the phone, so those two imports had not fired yet; they
 * were the next one to, on the first build that dropped the module or on any
 * dev-client that predates it.
 *
 * It has a second, immediate payoff: the headless render suite
 * (`db/screens-render.test.mjs`) walks a screen's import graph for real, so a
 * statically-imported native module made both camera screens **untestable** —
 * which is why neither was on the render walk. With the require guarded, they
 * render their absent branch under Node and go on the walk like every other
 * screen.
 *
 * Reference implementation for this pattern: `src/lib/media/photo-library.ts`.
 * The module's shape is declared HERE rather than imported from `expo-camera`,
 * for the same reason it is there: a type import from a native package is free
 * at runtime, but declaring the surface we actually use documents it and keeps
 * the shape-check below honest about what "loaded" means.
 */

/** One code seen in frame. `data` is the payload; `type` is e.g. `ean13`. */
export type ScannedBarcode = { type: string; data: string };

/** The imperative half of `CameraView` — the only method ARC calls. */
export type CameraHandle = {
  takePictureAsync: (options?: {
    quality?: number;
  }) => Promise<{ uri?: string | null } | null | undefined>;
};

/**
 * The props ARC passes. `onBarcodeScanned` is what turns barcode detection ON:
 * expo-camera derives its native `barcodeScannerEnabled` from the presence of
 * this callback (`ensureNativeProps`), and the scanner is an
 * `AVCaptureMetadataOutput` added ALONGSIDE the photo output on one session —
 * which is why one surface can both read a package and photograph a plate.
 */
export type ArcCameraProps = {
  ref?: Ref<CameraHandle | null>;
  style?: StyleProp<ViewStyle>;
  facing?: 'back' | 'front';
  barcodeScannerSettings?: { barcodeTypes: string[] };
  onBarcodeScanned?: (result: ScannedBarcode) => void;
};

type CameraPermission = { granted: boolean; canAskAgain: boolean; status: string };

type CameraModule = {
  CameraView: ComponentType<ArcCameraProps>;
  useCameraPermissions: () => [
    CameraPermission | null,
    () => Promise<CameraPermission | null>,
    ...unknown[],
  ];
};

function loadCamera(): CameraModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-camera') as Partial<CameraModule>;
    if (!mod.CameraView || typeof mod.useCameraPermissions !== 'function') return null;
    return mod as CameraModule;
  } catch {
    return null;
  }
}

/**
 * Resolved once per process. The module cannot appear or disappear while the app
 * runs, so every consumer below reads a constant — which is what makes the hook
 * export a stable identity and keeps the rules-of-hooks invariant intact.
 */
const cameraModule = loadCamera();

/**
 * The live camera component, or `null` on a binary without the module.
 *
 * Null is a **branch the caller must draw in words**, never a crash and never a
 * silently dead button: both call sites say the shot needs the next app build
 * and name the path that still works (describe the meal / enter it by hand).
 */
export const ArcCameraView: ComponentType<ArcCameraProps> | null = cameraModule?.CameraView ?? null;

/** Whether this binary can open the camera at all. */
export function isCameraAvailable(): boolean {
  return cameraModule !== null;
}

/** The stable absent value — one object, so a re-render never sees a new tuple. */
const NO_CAMERA_PERMISSION: [null, () => Promise<null>] = [null, async () => null];

function useCameraPermissionAbsent(): [null, () => Promise<null>] {
  return NO_CAMERA_PERMISSION;
}

/**
 * `expo-camera`'s permission hook, or a hook that reports "no permission, and
 * asking does nothing" when the module is absent.
 *
 * A caller MUST distinguish the two: with the module missing, `permission` stays
 * null forever, and a screen that reads null as "still loading" prints
 * *"Preparing the camera…"* until the end of time. Check
 * {@link isCameraAvailable} first — the absence is a sentence, not a spinner.
 */
export const useCameraPermission: () => [
  CameraPermission | null,
  () => Promise<CameraPermission | null>,
  ...unknown[],
] = cameraModule?.useCameraPermissions ?? useCameraPermissionAbsent;

/**
 * The code types ARC scans — retail barcodes plus `code128`, which is what
 * supplement tubs and gym-food packaging tend to carry. One list, so the
 * dedicated scanner and the merged photo surface cannot drift into recognising
 * different packages.
 */
export const FOOD_BARCODE_TYPES = ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128'];
