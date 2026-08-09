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
import { recipeImportShareFromPayloads, type RecipeImportShare } from './share-payload';

type SharingApi = {
  getSharedPayloads(): { value: string; type?: string }[];
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
    if (lastConsumed && Date.now() - lastConsumed.at < REPLAY_MS) return lastConsumed.share;
    return null;
  } catch {
    return null;
  }
}

/** The slice of expo-file-system's File this module reads a screenshot with. */
type FileCtor = new (uri: string) => { base64(): Promise<string> };

/**
 * Read a shared image file as base64 for the vision rung — expo-file-system's
 * File API (already in the build; the lab-PDF picker's pattern). Null when the
 * module is absent or the read fails; the caller falls back to paste.
 */
export async function readSharedImageBase64(uri: string): Promise<string | null> {
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
