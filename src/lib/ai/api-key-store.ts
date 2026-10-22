/**
 * The Coach's API key + model preference — persisted to the iOS Keychain.
 *
 * The key is the ONE secret ARC holds. It lives in the device Keychain via
 * `expo-secure-store` (hardware-backed, per-app, never in the JS bundle or the
 * SQLite DB), with an in-memory mirror so the hot read path stays synchronous:
 * {@link get} is called inside the agentic tool loop and must not be async.
 *
 * Lifecycle: {@link hydrate} runs once at app boot (app/_layout.tsx), loading
 * the Keychain into the mirror; writes go through {@link setKey}/{@link clearKey},
 * which update the mirror synchronously (so the UI reacts at once) and persist
 * in the background. The model preference is not a secret but rides along here
 * so "which model, is a key set" is one store the Coach service reads.
 *
 * GRACEFUL DEGRADATION: the native module (expo-secure-store is a native dep)
 * is absent on the web logic-check preview, and would be absent on any build
 * predating it — it was already in the owner's package.json before the
 * 2026-08-25 EAS rebuild, so it is in the binary now. When it can't be
 * reached, the store silently falls back to memory-only — exactly the
 * previous session-only behavior — so nothing crashes; {@link isPersistent}
 * reports which mode is live so the UI can be honest about it.
 */
import { DEFAULT_MODEL, isCoachModel } from './model-client';

const KEYCHAIN_API_KEY = 'arc.coach.api_key';
const KEYCHAIN_MODEL = 'arc.coach.model';
/**
 * The web search switch (2026-10-21, docs/decisions.md "Provider-side web
 * search"): `'off'` when the owner turned it off, absent otherwise. ON is the
 * default by his own answer, so only the exception is stored, and a phone that
 * never touched the switch searches.
 */
const KEYCHAIN_WEB_SEARCH = 'arc.coach.web_search';

/** The one line shown when the API refuses the search tool on this key. */
export const WEB_SEARCH_UNAVAILABLE_LINE =
  "Web search isn't available on this API key — answering without it. Settings › Coach › Web search.";

/** The slice of expo-secure-store this module uses. */
type SecureStoreModule = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(
    key: string,
    value: string,
    options?: { keychainAccessible?: number }
  ): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
  /** Accessibility constant: bind the item to this device, never restored to another. */
  WHEN_UNLOCKED_THIS_DEVICE_ONLY?: number;
};

/**
 * Bind the secret to THIS device: `*_THIS_DEVICE_ONLY` keeps it out of encrypted
 * iTunes/Finder device backups, so the key never rides a backup to a new phone
 * (the user re-enters it there) — matching ARC's "nothing personal leaves the
 * device" stance. Undefined on an older module → the option is simply omitted.
 */
function deviceOnly(store: SecureStoreModule): { keychainAccessible?: number } {
  return { keychainAccessible: store.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
}

// Required in a try/catch so a missing native module (pre-rebuild) or the web
// shim throwing at load never takes down the bundle — we degrade to memory-only.
let secureStore: SecureStoreModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  secureStore = require('expo-secure-store') as SecureStoreModule;
} catch {
  secureStore = null;
}

/** Whether durable storage is actually reachable (set false on a runtime miss). */
let persistent = typeof secureStore?.setItemAsync === 'function';

type Listener = () => void;

let apiKey: string | null = null;
let model: string | null = null;
let webSearch = true;
// The session latch (2026-10-21): the API refused the search tool on this key
// and the same request without it went through (model-client.ts
// `searchToolRefused`). In memory ONLY — never the stored switch — so a relaunch,
// the owner flipping the switch after enabling search in the Console, or a new
// key or model (`resetWebSearchLatch`) tries again. `webSearchNoticePending` is
// the one quiet line owed to whichever screen shows a result next.
let webSearchUnavailable = false;
let webSearchNoticePending = false;

/**
 * Forget the latch and any line still owed. The refusal belonged to one key on
 * one model, so a new key, a cleared key, a model choice and the switch itself
 * each try search again (fix4: the latch outlived setKey/clearKey/setModel, so
 * a key that CAN search stayed without it until a relaunch).
 */
function resetWebSearchLatch(): void {
  webSearchUnavailable = false;
  webSearchNoticePending = false;
}
let hydrated = false;
// Set the moment the user acts (setKey/clearKey/setModel) so a slow boot-time
// hydrate() read that resolves LATER can never clobber what they just chose —
// including an explicit clear (which looks identical to "never set" without it).
let keyTouched = false;
let modelTouched = false;
let webSearchTouched = false;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

// Single-slot serialization queue: each persist chains onto the previous one so
// writes land in CALL order. Without it, setKey('A') then clearKey() fire two
// independent unawaited promises on expo-secure-store's background dispatch,
// whose completion order isn't guaranteed — the delete could resolve before the
// set's write, leaving 'A' at rest for the next boot's hydrate() to resurrect.
let persistQueue: Promise<void> = Promise.resolve();

/**
 * A background persist that must never reject into an unhandled rejection: the
 * mirror is already the source of truth for this session, so a Keychain write
 * failing (native missing) just drops persistence and flips {@link isPersistent}.
 */
function persistInBackground(run: (store: SecureStoreModule) => Promise<void>): void {
  const store = secureStore;
  // Gate on the module's PRESENCE only, never on the `persistent` flag. Two
  // reasons: (1) a revocation — clearKey's Keychain delete of the one secret —
  // must always attempt to reach the Keychain, or a stale/revoked key survives
  // at rest and resurrects on the next launch; (2) a single transient write
  // rejection must not permanently disable persistence. Whether the native
  // module is truly usable is decided authoritatively by hydrate() (a throwing
  // read = native absent), not by one failed write here.
  if (!store) return;
  // Chain onto the queue so ordering is preserved; a failed write is swallowed
  // (the mirror stays authoritative) but must not break the chain for the next.
  persistQueue = persistQueue.then(() => run(store)).catch(() => {
    // Swallow a per-op failure — the in-memory mirror stays authoritative for
    // the session, so the Coach keeps working even if this write didn't land.
  });
}

export const apiKeyStore = {
  /** The key, or null when not connected. NEVER log or render this value. */
  get(): string | null {
    return apiKey;
  },
  has(): boolean {
    return apiKey !== null;
  },
  /** The chosen model id, or the default when none is set / a stale id is stored. */
  getModel(): string {
    return model !== null && isCoachModel(model) ? model : DEFAULT_MODEL;
  },
  /**
   * Whether the model may run the provider's web search (Coach chat and the
   * food estimators). ON unless the owner switched it off in Settings › Coach.
   */
  isWebSearchOn(): boolean {
    return webSearch;
  },
  /**
   * Whether a request should carry the search tool now: the switch is on AND
   * the API has not refused the tool on this key this session. What every
   * caller that builds a request reads; Settings reads {@link isWebSearchOn}.
   */
  isWebSearchUsable(): boolean {
    return webSearch && !webSearchUnavailable;
  },
  /**
   * The API refused the search tool and the request went through without it:
   * stop sending it for the rest of the app session, and owe the owner one
   * line saying so. Idempotent — a second refusal (a turn already in flight)
   * owes nothing more.
   */
  markWebSearchUnavailable(): void {
    if (webSearchUnavailable) return;
    webSearchUnavailable = true;
    webSearchNoticePending = true;
    emit();
  },
  /**
   * The one quiet line, at most once per latch: returns it to the first screen
   * that asks after a refusal (a Coach reply, an estimate review), then null.
   * A background estimate never asks, so the line waits for a screen.
   */
  takeWebSearchNotice(): string | null {
    if (!webSearchNoticePending) return null;
    webSearchNoticePending = false;
    return WEB_SEARCH_UNAVAILABLE_LINE;
  },
  /** True when the key is Keychain-backed; false in memory-only fallback. */
  isPersistent(): boolean {
    return persistent;
  },
  /** True once {@link hydrate} has run — the UI can show a settled state. */
  isHydrated(): boolean {
    return hydrated;
  },

  /**
   * Load the persisted key + model into the mirror. Idempotent and safe to call
   * before the UI mounts; emits so subscribers re-render once values arrive. A
   * read failure degrades to memory-only rather than throwing.
   */
  async hydrate(): Promise<void> {
    if (hydrated) return;
    const store = secureStore;
    if (store && persistent) {
      try {
        const [storedKey, storedModel, storedWebSearch] = await Promise.all([
          store.getItemAsync(KEYCHAIN_API_KEY),
          store.getItemAsync(KEYCHAIN_MODEL),
          store.getItemAsync(KEYCHAIN_WEB_SEARCH),
        ]);
        // Never overwrite a value the user set or cleared during the read window.
        if (!keyTouched && storedKey && storedKey.trim().length > 0) apiKey = storedKey;
        if (!modelTouched && storedModel && isCoachModel(storedModel)) model = storedModel;
        if (!webSearchTouched) webSearch = storedWebSearch !== 'off';
      } catch {
        persistent = false;
      }
    }
    hydrated = true;
    emit();
  },

  /** Set (and persist) the key. Empty/blank clears it. */
  async setKey(key: string): Promise<void> {
    keyTouched = true;
    const trimmed = key.trim();
    if (trimmed.length === 0) return this.clearKey();
    apiKey = trimmed;
    resetWebSearchLatch();
    emit();
    persistInBackground((store) => store.setItemAsync(KEYCHAIN_API_KEY, trimmed, deviceOnly(store)));
  },

  /** Forget the key everywhere — mirror and Keychain. */
  async clearKey(): Promise<void> {
    keyTouched = true;
    apiKey = null;
    resetWebSearchLatch();
    emit();
    persistInBackground((store) => store.deleteItemAsync(KEYCHAIN_API_KEY));
  },

  /** Choose (and persist) the model. Unknown ids are ignored. */
  async setModel(next: string): Promise<void> {
    if (!isCoachModel(next)) return;
    modelTouched = true;
    model = next;
    resetWebSearchLatch();
    emit();
    persistInBackground((store) => store.setItemAsync(KEYCHAIN_MODEL, next, deviceOnly(store)));
  },

  /** Turn web search on or off (and persist it). Off is the only value stored. */
  async setWebSearch(on: boolean): Promise<void> {
    webSearchTouched = true;
    webSearch = on;
    // Touching the switch is the owner's answer to the line: try again.
    resetWebSearchLatch();
    emit();
    persistInBackground((store) =>
      on
        ? store.deleteItemAsync(KEYCHAIN_WEB_SEARCH)
        : store.setItemAsync(KEYCHAIN_WEB_SEARCH, 'off', deviceOnly(store))
    );
  },

  /** Change notifications for useSyncExternalStore. */
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
