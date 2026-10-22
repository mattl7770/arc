/**
 * The Garmin Personal API key — persisted to the iOS Keychain and nowhere else
 * (docs/decisions.md "Garmin via the official Personal API", 2026-10-21).
 *
 * The owner creates the key himself on Garmin Connect Web and pastes it into
 * Settings › Garmin. It is the second secret ARC holds, after the Coach's API
 * key, and it is held the same way (src/lib/ai/api-key-store.ts): the Keychain
 * via `expo-secure-store`, an in-memory mirror so a read is synchronous, writes
 * serialised in call order so a save followed by a Disconnect can never leave
 * the saved key at rest.
 *
 * ## Where it never goes
 *
 * Not SQLite (so not the ARCB1 backup, which is a sealed copy of the database
 * file), not the JSON export, not a log line, not an error message, not the
 * Coach's context. The only reader is `src/lib/garmin/client.ts`, which puts it
 * in one header on one request to Garmin's token endpoint.
 *
 * ## Why WHEN_UNLOCKED_THIS_DEVICE_ONLY
 *
 * The same accessibility as the Coach's key, and the opposite of the backup
 * key's (docs/backups-subapp.md):
 *
 *   - **THIS_DEVICE_ONLY** keeps the item out of iCloud and Finder device
 *     backups and stops it restoring onto another phone. The key reads the
 *     owner's whole Garmin history, so it must not travel with the device
 *     backup that carries the ARCB1 snapshot. The backup key HAS to travel,
 *     because a snapshot nobody can open is worthless; this one does not,
 *     because Garmin keeps the data and a new phone needs only a fresh paste.
 *   - **WHEN_UNLOCKED** because nothing reads it with the phone locked: ARC has
 *     no background fetch, and the sync runs only in the foreground, behind the
 *     app lock.
 *
 * GRACEFUL DEGRADATION: where the native module is absent (the headless suites,
 * the web logic-check preview) the store is memory-only and
 * {@link GarminKeyStore.isPersistent} says so, so Settings can be honest.
 */

/** The Keychain item name. Never a SQLite key, never a preference. */
export const GARMIN_KEYCHAIN_ITEM = 'arc.garmin.personal_api_key';

/** The slice of expo-secure-store this module uses. */
export type GarminSecureStore = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(
    key: string,
    value: string,
    options?: { keychainAccessible?: number }
  ): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
  WHEN_UNLOCKED_THIS_DEVICE_ONLY?: number;
};

export type GarminKeyStore = {
  /** The key, or null. NEVER log, render or store this value anywhere else. */
  get(): string | null;
  has(): boolean;
  isHydrated(): boolean;
  /** True when the key is Keychain-backed; false in the memory-only fallback. */
  isPersistent(): boolean;
  hydrate(): Promise<void>;
  /** Set (and persist) the key; blank clears it. Returns the stored form. */
  setKey(raw: string): string | null;
  /** Forget the key — mirror and Keychain. */
  clearKey(): void;
  subscribe(listener: () => void): () => void;
  /** Resolves once every queued Keychain write has settled. */
  flush(): Promise<void>;
};

/**
 * The stored form of a pasted key: trimmed, and without an `ApiKey ` prefix if
 * the owner copied the whole header value. Pure.
 */
export function normaliseGarminKey(raw: string): string | null {
  let key = raw.trim();
  if (/^apikey\s+/i.test(key)) key = key.replace(/^apikey\s+/i, '').trim();
  return key.length === 0 ? null : key;
}

export function createGarminKeyStore(secureStore: GarminSecureStore | null): GarminKeyStore {
  let key: string | null = null;
  let hydrated = false;
  let touched = false;
  let persistent = typeof secureStore?.setItemAsync === 'function';
  let queue: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A subscriber re-reads on the next event.
      }
    }
  };

  // Gated on the module's presence only — a Disconnect must always try to reach
  // the Keychain, and one failed write must not switch persistence off for good.
  const persist = (run: (store: GarminSecureStore) => Promise<void>) => {
    const store = secureStore;
    if (!store) return;
    queue = queue
      .then(() => run(store))
      .catch(() => {
        // The mirror stays authoritative for this session.
      });
  };

  const clearKey = () => {
    touched = true;
    key = null;
    emit();
    persist((store) => store.deleteItemAsync(GARMIN_KEYCHAIN_ITEM));
  };

  return {
    get: () => key,
    has: () => key !== null,
    isHydrated: () => hydrated,
    isPersistent: () => persistent,

    async hydrate() {
      if (hydrated) return;
      const store = secureStore;
      if (store && persistent) {
        try {
          const stored = await store.getItemAsync(GARMIN_KEYCHAIN_ITEM);
          // A paste or a Disconnect during the read wins over what was stored.
          if (!touched && stored) key = normaliseGarminKey(stored);
        } catch {
          persistent = false;
        }
      }
      hydrated = true;
      emit();
    },

    setKey(raw) {
      const next = normaliseGarminKey(raw);
      if (next === null) {
        clearKey();
        return null;
      }
      touched = true;
      key = next;
      emit();
      persist((store) =>
        store.setItemAsync(GARMIN_KEYCHAIN_ITEM, next, {
          keychainAccessible: store.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        })
      );
      return next;
    },

    clearKey,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    flush: () => queue,
  };
}

function loadSecureStore(): GarminSecureStore | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-secure-store') as GarminSecureStore;
  } catch {
    return null;
  }
}

/** The app's one Garmin key store. */
export const garminKeyStore: GarminKeyStore = createGarminKeyStore(loadSecureStore());
