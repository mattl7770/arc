/**
 * The one module that touches op-sqlite. Everything else depends on the
 * {@link Database} interface, so the rest of the data layer is engine-agnostic
 * and testable against node:sqlite. Opening the DB here also runs migrations
 * and seeds reference data, so `getDb()` always returns a ready database.
 *
 * op-sqlite is a native module — this file only runs in a dev/production build,
 * not in Expo Go, the web bundle, or the headless tests.
 */
import { open } from '@op-engineering/op-sqlite';

import { excludeFromBackup } from '@/lib/files/backup-exclusion';
import type { Database, Scalar } from './database';
import { migrate, type MigrationExecutor, pendingMigrations } from './migrate';
import { MIGRATIONS } from './migrations.generated';
import { applyConnectionPragmas } from './pragmas';
import { seedReferenceData } from './seed';

const DB_NAME = 'arc.db';

type OpDb = ReturnType<typeof open>;

let cached: Database | null = null;
/**
 * The raw op-sqlite handle behind {@link cached}. Retained (the wrapper alone
 * used to be) because {@link replaceDatabaseFile} has to CLOSE the connection
 * before the file underneath it is swapped, and `getDbPath()` lives here too.
 */
let rawCached: OpDb | null = null;

/** Adapt an op-sqlite handle to the Database + MigrationExecutor surfaces. */
function wrap(db: OpDb): Database & MigrationExecutor {
  const q = (sql: string, params?: Scalar[]) => {
    // A wrapper that outlives its connection — every hook and screen mounted
    // before a restore holds one — would otherwise reach op-sqlite's freed
    // handle and die with an inscrutable "out of memory". Refuse with the one
    // sentence that names the actual fix instead.
    if (db !== rawCached) {
      throw new Error('ARC’s database was restored — close and reopen ARC to finish.');
    }
    return db.executeSync(sql, params as Parameters<OpDb['executeSync']>[1]);
  };

  return {
    run: (sql, params) => {
      q(sql, params);
    },
    all: (sql, params) => q(sql, params).rows as never,
    get: (sql, params) => q(sql, params).rows[0] as never,
    // op-sqlite has no synchronous transaction wrapper; BEGIN/COMMIT/ROLLBACK
    // via executeSync is the documented equivalent (it's what db.transaction
    // runs internally). Routed through `q` like everything else so the
    // stale-after-restore guard covers every entry point.
    transaction: (fn) => {
      q('BEGIN');
      try {
        fn();
        q('COMMIT');
      } catch (error) {
        q('ROLLBACK');
        throw error;
      }
    },
    exec: (sql) => {
      q(sql);
    },
    getUserVersion: () =>
      Number((q('PRAGMA user_version').rows[0] as { user_version: number }).user_version),
    setUserVersion: (version) => {
      q(`PRAGMA user_version = ${version}`);
    },
  };
}

/**
 * Open (once) and return the app database, migrated and seeded. Idempotent —
 * subsequent calls return the cached handle.
 */
export function getDb(): Database {
  if (cached) return cached;

  const raw = open({ name: DB_NAME });
  try {
    // The connection pragmas the schema depends on — FK enforcement ON,
    // recursive_triggers left at its default OFF. Shared with the headless
    // harnesses via one helper so a regression here is caught by a test rather
    // than only on a device (see ./pragmas).
    applyConnectionPragmas((sql) => {
      raw.executeSync(sql);
    });

    // Assigned BEFORE the wrapper is used: `wrap`'s stale-after-restore guard
    // compares against this, and the migrations below run through the wrapper.
    rawCached = raw;
    const db = wrap(raw);

    const from = db.getUserVersion();
    if (from > 0 && pendingMigrations(from, MIGRATIONS).length > 0) {
      backupBeforeMigrate(raw);
    }
    migrate(db, MIGRATIONS);
    seedReferenceData(db);

    // Keep the health database OUT of the iCloud/iTunes device backup: op-sqlite
    // stores arc.db under the app's Library directory, which iOS backs up by
    // default, and the whole personal health record must never sit at rest in the
    // cloud (CLAUDE.md §2). Best-effort native seam — a no-op until the ArcBackup
    // module ships (see @/lib/files/backup-exclusion). The -wal/-shm sidecars
    // carry recent, not-yet-checkpointed writes, so they are excluded too.
    const dbPath = raw.getDbPath();
    excludeFromBackup(dbPath);
    excludeFromBackup(`${dbPath}-wal`);
    excludeFromBackup(`${dbPath}-shm`);

    cached = db;
    return db;
  } catch (error) {
    // Don't leave a half-initialised handle open and uncached — a retry would
    // otherwise re-open the same DB. Close it so getDb() can start clean.
    rawCached = null;
    raw.close();
    throw error;
  }
}

/**
 * Put the plaintext bytes of a decrypted snapshot in place of the live database
 * (the restore half of src/lib/backup/snapshot.ts).
 *
 * This is the ONE place that may overwrite `arc.db`, and it lives here because
 * this is the only module holding the open connection: the file cannot be
 * swapped while a handle is reading it, and only this file knows where it is.
 *
 * Three things it deliberately does not do. It does not try to reopen — the
 * cached handles are simply dropped, and the UI tells the user to close and
 * reopen ARC, because a relaunch is the only way to be certain nothing else in
 * the process is still holding a page of the old database. It does not care
 * which schema era the snapshot came from: the next `getDb()` runs the pending
 * migrations forward over it, which is exactly the runner's job (the
 * NEWER-than-this-build case is refused upstream in restoreFromSnapshot). And
 * it is never clever on failure — on any throw it returns 'failed' and stops.
 *
 * The ORDER is the safety property (2026-08-25 review): the replacement is
 * written IN FULL to a scratch path first, so every failure before the final
 * move leaves the live database untouched. Only once the scratch is proven on
 * disk are the connection closed, the `-wal`/`-shm` sidecars removed (a WAL
 * describing the OLD database must never be replayed over the restored one),
 * and the scratch moved over `arc.db`. The exclusion flag is re-applied at the
 * end because the move creates a new inode: without it the restored plaintext
 * health record would ride the next iCloud backup during the very window the
 * user is told to background the app and relaunch.
 */
export function replaceDatabaseFile(bytes: Uint8Array): 'replaced' | 'failed' {
  type FileHandle = {
    exists: boolean;
    create(options?: { intermediates?: boolean; overwrite?: boolean }): void;
    write(content: Uint8Array): void;
    moveSync(destination: unknown, options?: { overwrite?: boolean }): void;
    delete(): void;
  };

  // An empty snapshot is never a legitimate database; refuse before anything
  // on disk is touched.
  if (bytes.length === 0) return 'failed';

  // Guarded even though this file is already native-only (op-sqlite is a
  // static import above): the same total posture as `pruneOldBackups`, so a
  // missing file-system module is a refusal rather than a throw mid-restore.
  let FileCtor: (new (uri: string) => FileHandle) | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('expo-file-system') as Partial<{ File: new (uri: string) => FileHandle }>;
    FileCtor = typeof fs.File === 'function' ? fs.File : undefined;
  } catch {
    FileCtor = undefined;
  }
  if (!FileCtor) return 'failed';

  // op-sqlite hands back a bare filesystem path; expo-file-system takes a
  // `file:///` URI. Both halves of the app container path are ASCII, so no
  // percent-encoding is involved.
  const uriFor = (path: string): string => (path.startsWith('file://') ? path : `file://${path}`);

  // Phase 1 — everything here leaves the live database fully intact.
  let dbPath: string;
  let scratch: FileHandle;
  try {
    // Resolve the path without disturbing the open connection; a throwaway
    // handle is opened (and closed at once) only when nothing is cached yet.
    if (rawCached) {
      dbPath = rawCached.getDbPath();
    } else {
      const probe = open({ name: DB_NAME });
      dbPath = probe.getDbPath();
      probe.close();
    }

    scratch = new FileCtor(uriFor(`${dbPath}.restoring`));
    if (scratch.exists) scratch.delete();
    scratch.create({ intermediates: true, overwrite: true });
    scratch.write(bytes);
    if (!scratch.exists) return 'failed';
  } catch (error) {
    console.warn('[db] restore failed before touching the database; nothing changed', error);
    return 'failed';
  }

  // Phase 2 — the swap. The only dangerous instant is the move itself, and the
  // replacement is already whole on the same volume.
  try {
    rawCached?.close();
    rawCached = null;
    cached = null;

    for (const suffix of ['-wal', '-shm']) {
      const sidecar = new FileCtor(uriFor(`${dbPath}${suffix}`));
      if (sidecar.exists) sidecar.delete();
    }

    scratch.moveSync(new FileCtor(uriFor(dbPath)), { overwrite: true });

    // The move minted a new inode, which does not inherit the old file's
    // backup-exclusion xattr — re-apply it now rather than waiting for the next
    // getDb() (see the getDb() comment; CLAUDE.md §2).
    excludeFromBackup(dbPath);

    return new FileCtor(uriFor(dbPath)).exists ? 'replaced' : 'failed';
  } catch (error) {
    console.warn('[db] restore failed mid-swap; the next open will use whatever is on disk', error);
    try {
      if (scratch.exists) scratch.delete();
    } catch {
      // Best-effort; a stray scratch file is recoverable, a throw here is not.
    }
    return 'failed';
  }
}

/**
 * Snapshot the database before a migration touches existing data, so a bad
 * migration is recoverable (2026-07-24 audit finding; live as of the 0002+
 * migrations shipping against a populated DB). Uses SQLite's `VACUUM INTO` — a
 * consistent single-file copy, no extra native dependency. On any failure it
 * warns and proceeds rather than blocking boot: a pre-release, single-user,
 * re-seedable app must never brick on a backup hiccup. Phase 4 (encrypted
 * iCloud backup) supersedes this with a managed snapshot + retention.
 *
 * Two privacy/hygiene guards (2026-08-23): prior `.bak` copies are pruned first
 * so full-DB snapshots do not accumulate for the life of the install, and the
 * new copy is marked excluded-from-backup so this rescue file — itself the whole
 * health record — never rides the iCloud device backup.
 */
function backupBeforeMigrate(raw: OpDb): void {
  const dbPath = raw.getDbPath();
  try {
    pruneOldBackups(dbPath);
    const backupPath = `${dbPath}.pre-migrate-${Date.now()}.bak`;
    raw.executeSync(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    excludeFromBackup(backupPath);
    console.log(`[db] pre-migration backup written: ${backupPath}`);
  } catch (error) {
    console.warn('[db] pre-migration backup failed; proceeding with migration', error);
  }
}

/**
 * Delete prior `.pre-migrate-*.bak` copies next to the DB so they do not pile up
 * (each is a full copy of the database). Best-effort via expo-file-system, which
 * is native — absent in the headless suites and the web preview, where this is a
 * silent no-op. A leftover backup is a disk-space matter, never a correctness
 * one, so any failure here is swallowed rather than allowed to touch boot.
 */
function pruneOldBackups(dbPath: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('expo-file-system') as {
      Directory: new (path: string) => { list(): { name: string; delete(): void }[] };
    };
    const cut = Math.max(dbPath.lastIndexOf('/'), dbPath.lastIndexOf('\\'));
    if (cut < 0) return;
    const dirPath = dbPath.slice(0, cut);
    const dbName = dbPath.slice(cut + 1);
    for (const entry of new fs.Directory(dirPath).list()) {
      if (entry.name.startsWith(`${dbName}.pre-migrate-`) && entry.name.endsWith('.bak')) {
        try {
          entry.delete();
        } catch {
          // keep this one; a single stubborn file is not worth failing over
        }
      }
    }
  } catch {
    // expo-file-system unreachable or the path did not resolve — leave the .bak
    // files in place; the exclusion above still keeps them out of the cloud.
  }
}
