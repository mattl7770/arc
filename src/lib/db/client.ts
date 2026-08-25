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

/** Adapt an op-sqlite handle to the Database + MigrationExecutor surfaces. */
function wrap(db: OpDb): Database & MigrationExecutor {
  const q = (sql: string, params?: Scalar[]) =>
    db.executeSync(sql, params as Parameters<OpDb['executeSync']>[1]);

  return {
    run: (sql, params) => {
      q(sql, params);
    },
    all: (sql, params) => q(sql, params).rows as never,
    get: (sql, params) => q(sql, params).rows[0] as never,
    // op-sqlite has no synchronous transaction wrapper; BEGIN/COMMIT/ROLLBACK
    // via executeSync is the documented equivalent (it's what db.transaction
    // runs internally).
    transaction: (fn) => {
      db.executeSync('BEGIN');
      try {
        fn();
        db.executeSync('COMMIT');
      } catch (error) {
        db.executeSync('ROLLBACK');
        throw error;
      }
    },
    exec: (sql) => {
      db.executeSync(sql);
    },
    getUserVersion: () =>
      Number(
        (db.executeSync('PRAGMA user_version').rows[0] as { user_version: number }).user_version
      ),
    setUserVersion: (version) => {
      db.executeSync(`PRAGMA user_version = ${version}`);
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
    raw.close();
    throw error;
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
