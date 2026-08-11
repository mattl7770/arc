/**
 * Native-intent redirect (expo-router): a share delivered by expo-sharing's
 * experimental share-INTO-app extension wakes the app with an `expo-sharing`
 * deep link. Route it to the import screen, which consumes the payloads
 * (src/lib/recipes/incoming-share.ts). Every other system path passes through
 * untouched. Pure — pinned in db/recipe-import.test.mjs.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return path.includes('expo-sharing') ? '/recipe-import' : path;
}
