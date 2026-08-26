/**
 * The encrypted-snapshot orchestration: make one, keep one generation back, put
 * one back (docs/backups-subapp.md).
 *
 * The shape of the feature in three sentences. A backup is `VACUUM INTO` to a
 * throwaway file in the cache directory — SQLite's own consistent single-file
 * copy, the same primitive `client.ts` already uses before a migration — sealed
 * with XChaCha20-Poly1305 by {@link sealBackup}, and written into
 * `Documents/backups/`. That directory is DELIBERATELY left inside the iCloud /
 * Finder device backup: the cloud carries ciphertext and nothing else, which is
 * what lets ARC have durability at all without re-admitting the plaintext health
 * record to a server (CLAUDE.md §2, and the 2026-08-25 ADR). Restore is the same
 * pipe backwards — decrypt, check the file really is a SQLite database, hand the
 * bytes to the one seam in `client.ts` that can swap the file underneath us.
 *
 * ## Why everything takes a `deps.store`
 *
 * The file half is native (`expo-file-system`) and the key half is native
 * (`expo-secure-store`), so neither exists in the headless suites — but the
 * ORDERING here (rotate before write, delete the temp copy whichever way the
 * seal went, never overwrite the last good snapshot with a failed one) is
 * exactly the part that is untestable on a device and worth testing. So the
 * store is injected, defaulting to the real one, the same trade
 * `src/lib/health/sync.ts` and the photo stores already make.
 *
 * Every entry point is total in the ways that matter: a missing module, a
 * missing key or a failed write is a typed outcome the UI can print honestly,
 * never a throw and never a silent success.
 */
import type { Database } from '@/lib/db/database';
import { MIGRATIONS } from '@/lib/db/migrations.generated';
import { isBackupEnabled } from '@/lib/db/repositories/user';

import { nativeBackupStore, type BackupFileStore, type SnapshotInfo } from './backup-file-store';
import { BackupFormatError, openBackup, sealBackupAsync } from './format';
import { ensureBackupKey, getBackupKey, hydrateBackupKey } from './key';

/** The newest snapshot. Overwritten every backup. */
export const CURRENT_SNAPSHOT = 'arc-current.arcb';
/**
 * The one generation of history. Two files, not N: a snapshot is a full copy of
 * the database, the device backup carries whatever is on disk, and one
 * predecessor is enough to survive "the last backup captured a corrupt DB".
 */
export const PREVIOUS_SNAPSHOT = 'arc-previous.arcb';

/** Automatic backups run at most this often (roughly daily, on foreground). */
export const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Injected collaborators; anything omitted resolves to the real native seam. */
export type SnapshotDeps = { store?: BackupFileStore | null };

export type BackupOutcome =
  | { status: 'done'; bytes: number; at: string }
  /**
   * No key, and minting one was refused — either the Keychain is unreachable, or
   * a snapshot already exists that a fresh key could never open (the
   * never-mint-over-ciphertext rule; see key.ts). Backups pause until the user
   * restores or enters their recovery code.
   */
  | { status: 'no-key' }
  | { status: 'unavailable' }
  | { status: 'failed'; message: string };

export type RestoreOutcome =
  | { status: 'restored' }
  | { status: 'no-snapshot' }
  /** The file-system module is missing — distinct from "the file is not there". */
  | { status: 'unavailable' }
  | { status: 'no-key' }
  | { status: 'bad-key' }
  /** Sealed by a NEWER ARC than this build — restoring it would strand the schema. */
  | { status: 'newer-schema' }
  | { status: 'failed'; message: string };

/**
 * `undefined` means "use the real store"; an explicit `null` means "there is no
 * store", which is how a test asserts the degraded path without a native module.
 */
function resolveStore(deps: SnapshotDeps): BackupFileStore | null {
  const store = deps.store === undefined ? nativeBackupStore() : deps.store;
  if (!store) return null;
  try {
    return store.available() ? store : null;
  } catch {
    return null;
  }
}

/**
 * `n` random bytes from SQLite's `randomblob`.
 *
 * The same reasoning as `src/lib/db/id.ts`, and it matters more here because
 * this is KEY material: Hermes has no `crypto` global and Expo's runtime does
 * not install one, so `crypto.getRandomValues` is not available and noble's own
 * `randomBytes` (which needs it) cannot be used. SQLite's PRNG is ChaCha20
 * seeded from OS entropy at first use — a CSPRNG, drawn from the same
 * `/dev/urandom` a native call would reach. It is one indirection away from the
 * kernel rather than zero, which is the owner's stated "not bulletproof, but
 * honestly good" bar (2026-08-25 ADR). `Math.random` would be, and is never used
 * anywhere on this path.
 */
export function dbRandomBytes(db: Database, n: number): Uint8Array {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`dbRandomBytes: n must be a positive integer (got ${String(n)})`);
  }
  const row = db.get<{ hex: string }>('SELECT lower(hex(randomblob(?))) AS hex', [n]);
  const hex = row?.hex;
  // Fail loud rather than return short/zero bytes: silently weak key material is
  // the one failure mode this whole feature cannot tolerate.
  if (typeof hex !== 'string' || hex.length !== n * 2) {
    throw new Error('dbRandomBytes: randomblob returned no usable bytes');
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('dbRandomBytes: randomblob returned non-hex');
    out[i] = byte;
  }
  return out;
}

/** `PRAGMA user_version` — recorded in the header so a restore knows its era. */
function readUserVersion(db: Database): number {
  const row = db.get<{ user_version: number }>('PRAGMA user_version');
  const value = Number(row?.user_version ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/** The stat of one snapshot by name, or null when it is not on disk. */
function statSnapshot(store: BackupFileStore, name: string): SnapshotInfo | null {
  try {
    return store.list().find((entry) => entry.name === name) ?? null;
  } catch {
    return null;
  }
}

/**
 * Age out the current snapshot into the previous slot before a new one is
 * written. True when the generation history is intact afterwards.
 *
 * Deliberately a COPY and not a delete-then-move: the atomic write of
 * {@link CURRENT_SNAPSHOT} that follows replaces it in one step, so leaving the
 * old file in place means every instant of this operation has a readable current
 * snapshot on disk. The copy runs natively (`store.copy`) rather than through a
 * JS read-and-rewrite — a snapshot can be tens of MB, and this runs on the boot
 * path. A failed copy ABORTS the backup upstream: overwriting the current
 * snapshot after the previous generation failed to rotate would collapse two
 * generations into one and still report success.
 */
function rotateSnapshots(store: BackupFileStore): boolean {
  const current = statSnapshot(store, CURRENT_SNAPSHOT);
  if (!current) return true; // nothing to age out — first backup
  return store.copy(CURRENT_SNAPSHOT, PREVIOUS_SNAPSHOT);
}

/** The message of an unknown thrown value, for the `failed` outcomes. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One guard for EVERY backup pass, manual or automatic. Boot and the AppState
 * foreground listener fire within milliseconds of each other on a cold start,
 * and a Settings "Back up now" can land while either runs; two concurrent
 * passes would collide on the same `.tmp` scratch name and race each other's
 * rotation. Module-level and checked inside {@link createBackup} itself so no
 * caller can forget it.
 */
let backupInFlight = false;

/**
 * Take one encrypted snapshot now. The explicit, user-pressed path (Settings ›
 * Backups › Back up now) and the body of the automatic one.
 *
 * Deliberately NOT gated on the "Automatic backups" preference — that toggle is
 * a SCHEDULE control and lives in {@link autoBackupIfDue}. A hand-pressed
 * button is intent that outranks a schedule; gating it here silently left the
 * account with zero durability while the button looked live (2026-08-25 review).
 *
 * Order is load-bearing: the seams are checked BEFORE any file is touched, so
 * the degraded answers cost nothing; the mint is only allowed when no snapshot
 * exists (never-mint-over-ciphertext, key.ts); a failed rotation ABORTS with
 * both generations intact; and the temp `VACUUM` copy — a full plaintext
 * database in the cache directory — is deleted on every exit from the moment it
 * exists.
 */
export async function createBackup(db: Database, deps: SnapshotDeps = {}): Promise<BackupOutcome> {
  if (backupInFlight) return { status: 'failed', message: 'a backup is already running' };
  backupInFlight = true;
  try {
    return await createBackupLocked(db, deps);
  } finally {
    backupInFlight = false;
  }
}

async function createBackupLocked(db: Database, deps: SnapshotDeps): Promise<BackupOutcome> {
  const store = resolveStore(deps);
  if (!store) return { status: 'unavailable' };

  // Minting happens here rather than at boot so a user who never backs up never
  // has a key — and it is only ALLOWED when the backups directory holds no
  // ciphertext. A restored phone that arrives with the snapshot but without the
  // Keychain must pause at `no-key` rather than seal the empty database under a
  // fresh key and rotate the real record toward destruction.
  const existing = store.list();
  const key = await ensureBackupKey((n) => dbRandomBytes(db, n), existing.length === 0);
  if (!key) return { status: 'no-key' };

  let temp: { path: string; uri: string } | null = null;
  try {
    temp = store.tempVacuumTarget();
    if (!temp) return { status: 'unavailable' };

    // `VACUUM INTO` is SQLite's own transactionally-consistent single-file copy —
    // no half-written page, no reader/writer coordination of ours. The path is
    // interpolated with doubled quotes rather than bound, matching
    // `client.ts`'s pre-migration backup (VACUUM is not an ordinary statement).
    db.run(`VACUUM INTO '${temp.path.replace(/'/g, "''")}'`);

    const plain = store.readBytesAtUri(temp.uri);
    if (!plain || plain.length === 0) {
      return { status: 'failed', message: 'the database copy could not be read back' };
    }

    const createdAt = new Date().toISOString();
    // The async seal yields to the event loop between chunks: this runs on the
    // boot/foreground path, and a multi-MB synchronous encrypt would hold the JS
    // thread through the app's first frames.
    const sealed = await sealBackupAsync(key, plain, {
      createdAt,
      userVersion: readUserVersion(db),
      random: (n) => dbRandomBytes(db, n),
    });

    if (!rotateSnapshots(store)) {
      // Both generations are still on disk exactly as they were; only the new
      // snapshot is lost, and the next pass will try again.
      return { status: 'failed', message: 'the previous snapshot could not be rotated' };
    }
    if (!store.writeBytesAtomic(CURRENT_SNAPSHOT, sealed)) {
      return { status: 'failed', message: 'the snapshot could not be written' };
    }
    return { status: 'done', bytes: sealed.length, at: createdAt };
  } catch (error) {
    return { status: 'failed', message: describe(error) };
  } finally {
    // The plaintext temp copy never outlives this call, success or failure. It
    // is the one moment an unencrypted whole-database file exists outside the
    // app's own DB path, and the cache directory is not excluded from anything.
    if (temp) store.removeAtUri(temp.uri);
  }
}

/** Stat of the newest snapshot, for the Settings status line. */
export function lastBackupInfo(deps: SnapshotDeps = {}): SnapshotInfo | null {
  const store = resolveStore(deps);
  if (!store) return null;
  return statSnapshot(store, CURRENT_SNAPSHOT);
}

/** Whether an automatic pass is due — pure, so the throttle is testable. */
export function isBackupDue(info: SnapshotInfo | null, now: number = Date.now()): boolean {
  if (!info) return true;
  // A clock that has moved backwards (timezone travel, a manual set) would
  // otherwise read as "not due" for as long as the skew lasts. Treat any
  // non-positive age as due — an extra backup is cheap, a missed month is not.
  const age = now - info.modifiedAt;
  return !Number.isFinite(age) || age <= 0 || age >= AUTO_BACKUP_INTERVAL_MS;
}

/**
 * The boot/foreground hook (app/_layout.tsx): throttled, best-effort, silent.
 *
 * Silence is the point. A backup the user did not ask for must never interrupt
 * them — Settings › Backups shows the honest last-backup time, and a failure
 * simply means the next foreground tries again. This is also the ONE place the
 * "Automatic backups" preference is honoured: it is a schedule control, and the
 * manual path deliberately ignores it (see {@link createBackup}). Re-entrancy
 * (boot racing the first foreground event) is handled inside createBackup's own
 * in-flight guard — the loser returns a 'failed · already running' outcome this
 * hook silently discards.
 */
export async function autoBackupIfDue(db: Database, deps: SnapshotDeps = {}): Promise<void> {
  try {
    if (!isBackupEnabled(db)) return;
    const store = resolveStore(deps);
    if (!store) return;
    if (!isBackupDue(statSnapshot(store, CURRENT_SNAPSHOT))) return;
    await createBackup(db, { store });
  } catch (error) {
    console.warn('[backup] automatic backup failed', error);
  }
}

/**
 * The `client.ts` seam, behind a guarded require.
 *
 * A static import would pull op-sqlite into this module's graph, and this module
 * is imported by the headless suites (and, transitively, by route files that
 * Expo Router eagerly loads to build its manifest). The same reasoning as
 * `photo-file-store.ts`'s lazy `expo-file-system` require — the relative
 * specifier keeps it independent of how the `@/` alias is resolved.
 */
function loadDbClient(): { replaceDatabaseFile(bytes: Uint8Array): 'replaced' | 'failed' } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../db/client') as Partial<{
      replaceDatabaseFile(bytes: Uint8Array): 'replaced' | 'failed';
    }>;
    return typeof mod.replaceDatabaseFile === 'function'
      ? (mod as { replaceDatabaseFile(bytes: Uint8Array): 'replaced' | 'failed' })
      : null;
  } catch {
    return null;
  }
}

/** ASCII "SQLite format 3\0" — the first 16 bytes of every SQLite database. */
const SQLITE_MAGIC = 'SQLite format 3\0';

/**
 * Whether the decrypted bytes really are a database.
 *
 * Poly1305 already proves the bytes are the ones that were sealed with this key,
 * so this is not an integrity check — it is a check that we sealed the RIGHT
 * THING. It is the last gate before overwriting the live database, and it costs
 * sixteen comparisons.
 */
function looksLikeSqlite(plain: Uint8Array): boolean {
  if (plain.length < SQLITE_MAGIC.length) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i++) {
    if (plain[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Decrypt a snapshot and put it back in place of the live database.
 *
 * On `'restored'` the caller must tell the user to close and reopen ARC: the
 * file underneath every open handle has just changed, and no amount of
 * re-opening from inside a running process is worth trusting over a relaunch.
 * The reopened app runs migrations forward over whatever era the snapshot came
 * from, which is exactly what the migration runner is for.
 */
export async function restoreFromSnapshot(
  name: string = CURRENT_SNAPSHOT,
  deps: SnapshotDeps = {}
): Promise<RestoreOutcome> {
  const store = resolveStore(deps);
  // 'unavailable', never 'no-snapshot': a missing native module must not be
  // reported to the user as a factual claim that their backup does not exist.
  if (!store) return { status: 'unavailable' };

  const sealed = store.readBytes(name);
  if (!sealed || sealed.length === 0) return { status: 'no-snapshot' };

  // Hydrated here rather than trusted to the screen's mount effect: this is the
  // only entry point that reads the mirror without going through
  // `ensureBackupKey`, and a tap that beats the boot-time Keychain read would
  // otherwise report a false `no-key` and steer the user into the recovery-code
  // flow on a phone whose key is sitting right there.
  await hydrateBackupKey();

  // Read the mirror, never mint: a restore that quietly created a fresh key
  // would report `bad-key` on a snapshot that was perfectly fine.
  const key = getBackupKey();
  if (!key) return { status: 'no-key' };

  let plain: Uint8Array;
  let sealedUserVersion: number;
  try {
    const opened = openBackup(key, sealed);
    plain = opened.plain;
    sealedUserVersion = opened.header.userVersion;
  } catch (error) {
    // `wrong-key-or-corrupt` is the one failure the user can act on — it is what
    // a keychain that did not survive a device migration looks like, and the UI
    // answers it by offering the recovery code.
    if (error instanceof BackupFormatError && error.reason === 'wrong-key-or-corrupt') {
      return { status: 'bad-key' };
    }
    return { status: 'failed', message: describe(error) };
  }

  // The migration runner is forward-only: a snapshot whose recorded era is
  // AHEAD of this build would land silently, no migrations would run, and the
  // app would then read a schema it does not know — scattered SQL errors
  // instead of one clear refusal. The header records userVersion for exactly
  // this comparison.
  const head = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
  if (sealedUserVersion > head) return { status: 'newer-schema' };

  if (!looksLikeSqlite(plain)) {
    return { status: 'failed', message: 'the decrypted snapshot is not a SQLite database' };
  }

  const client = loadDbClient();
  if (!client) return { status: 'failed', message: 'the database module is unavailable' };
  if (client.replaceDatabaseFile(plain) !== 'replaced') {
    return { status: 'failed', message: 'the database file could not be replaced' };
  }
  return { status: 'restored' };
}
