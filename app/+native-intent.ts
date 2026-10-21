import { isQuickLink, requestQuickLaunch } from '@/lib/log/quick-launch';

/**
 * Native-intent redirect (expo-router): a share delivered by expo-sharing's
 * experimental share-INTO-app extension wakes the app with an `expo-sharing`
 * deep link. Route it to the import screen, which consumes the payloads
 * (src/lib/recipes/incoming-share.ts). Every other system path passes through
 * untouched — except one.
 *
 * `arc://quick` (item 63, the quick-log box) is NOT navigated here. It is
 * queued behind the app lock (src/lib/log/quick-launch.ts) and null is
 * returned, which expo-router documents as "no redirection occurs and the app
 * stays on the current path" — routing it on arrival would land a cold, locked
 * start on expo-router's own `__root` stack (src/lib/notifications/taps.ts).
 *
 * Pinned in db/recipe-import.test.mjs and db/log.test.mjs.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string | null {
  if (isQuickLink(path)) {
    requestQuickLaunch();
    return null;
  }
  return path.includes('expo-sharing') ? '/recipe-import' : path;
}
