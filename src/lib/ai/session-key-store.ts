/**
 * The API key's TEMPORARY home: process memory, nothing else.
 *
 * The user pastes a key into the Coach screen's clearly-labelled session
 * panel; it lives in this module variable until the app process ends (or they
 * disconnect) and is NEVER persisted — not to the database, not to
 * AsyncStorage, not to disk. This exists so the real agent is demonstrable
 * before the Settings screen ships; the durable home is the iOS Keychain via
 * expo-secure-store (a native dependency → EAS rebuild → deliberately out of
 * this slice, flagged in docs/ai-coach.md).
 *
 * Swapping in the Keychain later is confined to this file: `get` becomes a
 * SecureStore read (and gains async plumbing at the one call site in
 * coach-service.ts); the subscribe surface stays for the UI.
 */

type Listener = () => void;

let apiKey: string | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

export const sessionKeyStore = {
  /** The key, or null when not connected. Never log or render this value. */
  get(): string | null {
    return apiKey;
  },
  has(): boolean {
    return apiKey !== null;
  },
  set(key: string): void {
    const trimmed = key.trim();
    apiKey = trimmed.length > 0 ? trimmed : null;
    emit();
  },
  clear(): void {
    apiKey = null;
    emit();
  },
  /** Change notifications for useSyncExternalStore. */
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
