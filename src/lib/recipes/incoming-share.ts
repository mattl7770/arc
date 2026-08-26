/**
 * The share-sheet receive seam (docs/recipes-grocery.md §8): expo-sharing's
 * experimental share-INTO-app payload APIs, behind the guarded-require pattern
 * (healthkit.ts / pick-pdf.ts). On a binary without the share-extension target
 * — every build until the next EAS one — the module functions are absent and
 * everything here no-ops to null, so the paste-URL path stays the entry.
 *
 * Delivery model: iOS opens/foregrounds the app via an `expo-sharing` deep
 * link (app/+native-intent.ts redirects it to /recipe-import); the payloads
 * themselves are read here and CLEARED once consumed, so a share is imported
 * exactly once.
 */
import { downscaleToJpegBase64 } from '@/lib/media/photo-library';
import { recipeImportShareFromPayloads, type RecipeImportShare } from './share-payload';

type SharingApi = {
  getSharedPayloads(): { value: string; shareType?: string }[];
  clearSharedPayloads(): void;
};

function loadSharing(): SharingApi | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-sharing') as Partial<SharingApi>;
    if (
      typeof mod.getSharedPayloads !== 'function' ||
      typeof mod.clearSharedPayloads !== 'function'
    ) {
      return null;
    }
    return mod as SharingApi;
  } catch {
    return null;
  }
}

/** Whether this binary can receive share-sheet payloads at all. */
export function isIncomingShareAvailable(): boolean {
  return loadSharing() !== null;
}

/** A just-consumed share is replayable briefly: React can run a screen's state
 * initializers more than once for one mount (StrictMode / compiler re-render),
 * and the payload store was already cleared by the first call. */
const REPLAY_MS = 3000;
let lastConsumed: { share: RecipeImportShare; at: number } | null = null;

/**
 * Read-and-clear whatever was shared into the app, mapped to an import input.
 * Null when nothing was shared or the module isn't in this binary. Never
 * throws — a share must never crash the import screen.
 */
export function consumeIncomingShare(): RecipeImportShare | null {
  const sharing = loadSharing();
  if (!sharing) return null;
  try {
    const payloads = sharing.getSharedPayloads();
    const share = recipeImportShareFromPayloads(payloads);
    if (share) {
      sharing.clearSharedPayloads();
      lastConsumed = { share, at: Date.now() };
      return share;
    }
    // The replay is a ONE-SHOT: it exists only to survive React re-invoking a
    // screen's state initializer for a single mount (microseconds apart), so it
    // is cleared the instant it is handed back. Otherwise a genuine second visit
    // to the import screen within the window would re-import the share just
    // handled.
    if (lastConsumed && Date.now() - lastConsumed.at < REPLAY_MS) {
      const replay = lastConsumed.share;
      lastConsumed = null;
      return replay;
    }
    return null;
  } catch {
    return null;
  }
}

/** The slice of expo-file-system's File this module reads a screenshot with. */
type FileCtor = new (uri: string) => { base64(): Promise<string> };

/**
 * Read a shared image as base64 for the vision rung.
 *
 * **Downscale and RE-ENCODE first.** The extraction request labels its payload
 * `image/jpeg` unconditionally, and iOS shares screenshots as PNG or HEIC — so
 * reading the file straight off disk sent a mislabelled image, at full
 * resolution, with no size cap, to a vision model. The share path now runs the
 * same pass the library picker does (`downscaleToJpegBase64`, 1024px, q0.6), so
 * what is claimed and what is sent are the same format.
 *
 * The raw read stays as the FALLBACK for a binary without the manipulator —
 * mislabelled but present beats a dead rung, and the paste path is one tap away
 * either way. Null when nothing could be read at all.
 */
export async function readSharedImageBase64(uri: string): Promise<string | null> {
  const jpeg = await downscaleToJpegBase64(uri);
  if (jpeg !== null) return jpeg;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-file-system') as { File?: unknown };
    const File = mod.File as FileCtor | undefined;
    if (typeof File !== 'function') return null;
    return await new File(uri).base64();
  } catch {
    return null;
  }
}
