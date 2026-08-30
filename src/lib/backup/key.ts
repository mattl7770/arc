/**
 * The 32-byte master key that seals every ARC backup snapshot — persisted to the
 * iOS Keychain.
 *
 * Shape follows src/lib/ai/api-key-store.ts: a guarded `require` of
 * `expo-secure-store`, an in-memory mirror so the read path is SYNCHRONOUS
 * ({@link getBackupKey} is called from inside seal/open, which are pure and must
 * not await), and a single-slot queue so writes land in call order.
 *
 * ## THE ONE KEYCHAIN ITEM THAT MUST *NOT* BE DEVICE-BOUND
 *
 * Read this before changing any write below. The Coach's API key is stored with
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` precisely so it can never ride a device
 * backup to another phone. **This key is the deliberate opposite.** It is stored
 * with the Keychain's DEFAULT accessibility (`kSecAttrAccessibleWhenUnlocked`,
 * which is NOT ThisDeviceOnly) — meaning we pass NO options at all to
 * `setItemAsync` — because the whole durability story depends on it MIGRATING
 * through an encrypted device backup:
 *
 *   phone dies → restore an encrypted iCloud/Finder backup onto a new phone →
 *   the backup carries (a) `Documents/backups/arc-current.arcb`, which is
 *   ciphertext, and (b) THIS key, which is what turns that ciphertext back into
 *   the health record. A ThisDeviceOnly key would be dropped by the restore and
 *   the snapshot would be permanently undecryptable — durability that isn't.
 *
 * Nothing personal is exposed by this: the key is only ever at rest inside
 * Apple's own encrypted Keychain blob, never in the DB, never in the bundle,
 * never sent anywhere. The recovery code (src/lib/backup/recovery-code.ts) is
 * the manual fallback for the case where the Keychain is lost anyway (a restore
 * from an UNencrypted backup, which does not carry Keychain items at all).
 *
 * ## Never mint a key that cannot be persisted
 *
 * {@link ensureBackupKey} returns `null` rather than inventing a session-only
 * key when the Keychain is unreachable. A snapshot sealed under a key that dies
 * with the process is strictly worse than no snapshot: it consumes space, reads
 * as protection in the UI, and can never be opened again.
 *
 * ## Never mint OVER ciphertext (the 2026-08-25 adversarial-review finding)
 *
 * Minting is additionally gated by the CALLER via `allowMint`: a fresh key may
 * only be created when there is no snapshot on disk. The disaster it prevents:
 * a phone restored from a backup that did not carry the Keychain arrives with
 * the ciphertext but no key; if the first automatic backup were allowed to mint,
 * it would seal the EMPTY database under a new key and, one rotation later,
 * destroy the only copy of the real health record — on exactly the
 * disaster-recovery path this feature exists for. With the gate, that state
 * reports `no-key`, backups pause, and the recovery code (or the restore) is
 * the way forward. The same reasoning covers a stored-but-unreadable Keychain
 * item ({@link hasUnreadableStoredKey}): it may still be someone's only key
 * material, so it is never overwritten by a mint.
 *
 * ## Adoption is session-first, persistence is earned
 *
 * A typed recovery code goes into the in-memory mirror ONLY
 * ({@link adoptRecoveryKey}); the Keychain is written by
 * {@link persistAdoptedKey} once the caller has PROVEN the key by decrypting a
 * snapshot with it. Persisting an unproven code would overwrite the one durable
 * copy of a key that may still open every existing snapshot — with a value whose
 * checksum only proves it is *a* key, not *this install's* key.
 *
 * GRACEFUL DEGRADATION: `expo-secure-store` is native, so it is absent in the
 * headless suites and the web logic-check preview. There, this module reports
 * `isBackupKeyPersistent() === false`, mints nothing, and the backup feature
 * honestly says it needs the device build.
 */

/** Keychain item name. Distinct from `arc.coach.api_key` in every respect. */
const KEYCHAIN_BACKUP_KEY = 'arc.backup.key';

/** XChaCha20-Poly1305 master key length. */
const KEY_BYTES = 32;

/**
 * The slice of expo-secure-store this module uses. Deliberately no delete: this
 * key is never revoked, because dropping it would orphan every snapshot ever
 * written — including the one already sitting in the user's iCloud backup.
 *
 * Note the `setItemAsync` signature carries NO options parameter, so no future
 * edit can quietly bind this item to the device. See the header.
 */
type SecureStoreModule = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
};

// Required in a try/catch so a missing native module (the headless suites, the
// web preview) never takes down the bundle — we degrade to "no backups", which
// every caller already handles.
let secureStore: SecureStoreModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  secureStore = require('expo-secure-store') as SecureStoreModule;
} catch {
  secureStore = null;
}

/**
 * Whether durable storage is actually reachable. Flipped false only by a
 * throwing READ in {@link hydrateBackupKey} (which is the authoritative "native
 * absent" signal) — never by a single failed write, which may be transient and
 * must not permanently disable persistence.
 */
let persistent = typeof secureStore?.setItemAsync === 'function';

/** The in-memory mirror — the synchronous source of truth for this session. */
let masterKey: Uint8Array | null = null;
let hydrated = false;
let hydration: Promise<void> | null = null;
/**
 * Set the moment a key is minted or adopted, so a slow boot-time hydrate that
 * resolves LATER can never clobber the key the restore flow just installed.
 */
let touched = false;
/**
 * True when hydrate found a NON-EMPTY Keychain item it could not parse. While
 * set, minting is refused: that value may be the only copy of a key that still
 * opens an existing snapshot, and a mint would overwrite the slot.
 */
let salvage = false;
/** Shared by concurrent {@link ensureBackupKey} callers so two taps mint one key. */
let minting: Promise<Uint8Array | null> | null = null;

// Single-slot serialization queue: each persist chains onto the previous one so
// writes land in CALL order (the api-key-store lesson — two unawaited writes on
// the native background dispatch have no guaranteed completion order).
let persistQueue: Promise<void> = Promise.resolve();

function toHex(bytes: Uint8Array): string {
  let out = '';
  // Iterated rather than indexed: with `noUncheckedIndexedAccess` an index read
  // is `number | undefined`, and a key is not a place for a `?? 0`.
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Parse exactly 64 hex chars into 32 bytes; null on anything else. */
function fromHex(text: string): Uint8Array | null {
  const trimmed = text.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(trimmed)) return null;
  const out = new Uint8Array(KEY_BYTES);
  for (let i = 0; i < KEY_BYTES; i += 1) {
    const byte = Number.parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}

/**
 * Queue a Keychain write and AWAIT its outcome. Unlike api-key-store's
 * fire-and-forget persist, the backup key's callers need to know whether the key
 * actually landed at rest before they seal anything with it.
 */
async function persistKey(store: SecureStoreModule, hex: string): Promise<boolean> {
  const write = persistQueue.then(() => store.setItemAsync(KEYCHAIN_BACKUP_KEY, hex));
  // Keep the chain alive for the next caller even when this write rejects.
  persistQueue = write.catch(() => {});
  try {
    await write;
    return true;
  } catch {
    return false;
  }
}

async function runHydrate(): Promise<void> {
  const store = secureStore;
  if (store && persistent) {
    try {
      const stored = await store.getItemAsync(KEYCHAIN_BACKUP_KEY);
      // Never overwrite a key minted or adopted during the read window.
      if (!touched && stored) {
        const parsed = fromHex(stored);
        // A malformed item is left alone rather than deleted: it is the only
        // copy of something that may still open an existing snapshot, and the
        // user can always re-enter their recovery code. `salvage` is what stops
        // a later mint from silently writing over it.
        if (parsed) masterKey = parsed;
        else salvage = true;
      }
    } catch {
      // A throwing read means the native module is not really there.
      persistent = false;
    }
  }
  hydrated = true;
}

/**
 * Load the persisted key into the mirror. Idempotent, safe before the UI mounts,
 * and safe to call concurrently (callers share one read).
 */
export function hydrateBackupKey(): Promise<void> {
  if (hydrated) return Promise.resolve();
  if (!hydration) hydration = runHydrate();
  return hydration;
}

/**
 * The master key, or null when none exists yet. Synchronous by design — the
 * sealing path is pure. NEVER log or render this value directly; the recovery
 * code is the only sanctioned way to show it to the user.
 */
export function getBackupKey(): Uint8Array | null {
  return masterKey;
}

/** True when the key is Keychain-backed; false when the module is unreachable. */
export function isBackupKeyPersistent(): boolean {
  return persistent;
}

/**
 * True when the Keychain holds a value for this key that could not be parsed.
 * The UI answers it with the recovery code, never with a fresh mint.
 */
export function hasUnreadableStoredKey(): boolean {
  return salvage;
}

/**
 * The key — minting and persisting one on first use, but ONLY when the caller
 * says minting is safe (`allowMint`, which in practice means "the backups
 * directory is empty"; see the header's never-mint-over-ciphertext rule).
 *
 * `random` is injected (SQLite's `randomblob` in practice — Hermes has no
 * `crypto` global) so this module stays free of both entropy sources and the
 * database. Returns null when no key exists and none could be safely minted AND
 * persisted: see the header — an unopenable snapshot is worse than none.
 */
export function ensureBackupKey(
  random: (n: number) => Uint8Array,
  allowMint: boolean
): Promise<Uint8Array | null> {
  if (minting) return minting;
  const run = mintIfMissing(random, allowMint);
  minting = run;
  return run.finally(() => {
    minting = null;
  });
}

/**
 * 32 fresh bytes from the injected source, or null.
 *
 * A short read (or a throwing source) is a silent catastrophe — a key with
 * predictable tail bytes still seals and still opens, so nothing would ever
 * surface it — hence it is checked here and fails as a refusal to mint.
 */
function drawKey(random: (n: number) => Uint8Array): Uint8Array | null {
  try {
    const fresh = random(KEY_BYTES);
    if (!(fresh instanceof Uint8Array) || fresh.length !== KEY_BYTES) return null;
    // Copied: the source may hand back a view onto a buffer it reuses.
    return Uint8Array.from(fresh);
  } catch {
    return null;
  }
}

async function mintIfMissing(
  random: (n: number) => Uint8Array,
  allowMint: boolean
): Promise<Uint8Array | null> {
  await hydrateBackupKey();
  if (masterKey) return masterKey;

  // The two refusals that protect existing ciphertext: the caller has seen a
  // snapshot on disk (a mint would strand it), or the Keychain slot holds a
  // value we could not read (a mint would overwrite it). See the header.
  if (!allowMint || salvage) return null;

  const store = secureStore;
  // Refuse to mint what we cannot keep.
  if (!store || !persistent) return null;

  const key = drawKey(random);
  if (!key) return null;
  if (!(await persistKey(store, toHex(key)))) return null;

  // Re-checked AFTER the awaited write: a recovery code adopted during that
  // window owns the mirror, and clobbering it here would leave this session
  // sealing under a key that is at rest nowhere (the executed-and-confirmed
  // 2026-08-25 review finding). The adopted key's own persist is queued behind
  // ours on `persistQueue`, so the Keychain converges to the mirror.
  if (masterKey) return masterKey;

  // Only adopted once it is at rest.
  touched = true;
  masterKey = key;
  return key;
}

/**
 * Install a key the user typed back in as a recovery code — INTO THE MIRROR
 * ONLY. The immediate job is to let the caller retry the decrypt in this
 * session; the Keychain is deliberately untouched until the key has PROVEN
 * itself ({@link persistAdoptedKey}), because writing an unproven code over the
 * slot would destroy the one durable copy of a key that may still open every
 * existing snapshot. Returns false only when the key itself is not 32 bytes — a
 * caller handing over a mis-parsed recovery code.
 */
export function adoptRecoveryKey(key: Uint8Array): boolean {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) return false;

  // Copied so the mirror can never be mutated through the caller's buffer.
  touched = true;
  hydrated = true;
  masterKey = Uint8Array.from(key);
  return true;
}

/**
 * Put the mirror back the way {@link adoptRecoveryKey}'s caller found it — the
 * undo for an adopted code that failed to open anything. `previous` is whatever
 * `getBackupKey()` returned before the adopt, including null.
 */
export function restoreSessionKey(previous: Uint8Array | null): void {
  masterKey = previous === null ? null : Uint8Array.from(previous);
}

/**
 * Write the CURRENT mirror key to the Keychain — called only after a decrypt
 * has proven it. `'memory-only'` is the honest failure: the restore worked this
 * session, but the key will not survive a relaunch, so the UI must tell the
 * user to keep their recovery code.
 */
export async function persistAdoptedKey(): Promise<'persisted' | 'memory-only'> {
  const key = masterKey;
  const store = secureStore;
  if (!key || !store || !persistent) return 'memory-only';
  if (!(await persistKey(store, toHex(key)))) return 'memory-only';
  // The slot now holds a parseable value again; the salvage refusal is over.
  salvage = false;
  return 'persisted';
}
