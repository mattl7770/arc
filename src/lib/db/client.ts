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

import type { Database, Scalar } from './database';
import { migrate, type MigrationExecutor, pendingMigrations } from './migrate';
import { MIGRATIONS } from './migrations.generated';
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
        try {
          db.executeSync('ROLLBACK');
        } catch {
          // SQLite auto-rolls-back and re-enables autocommit on SQLITE_FULL /
          // IOERR / BUSY / NOMEM / INTERRUPT, so this ROLLBACK then throws
          // "cannot rollback - no transaction is active". Unguarded, that
          // nonsense pre-empts `throw error` and a real "disk is full" — or a
          // failing migration, since migrate.ts wraps each one in here — is
          // reported as a rollback problem. The original failure must win.
        }
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
    // SQLite defaults foreign_keys OFF; the schema relies on FK enforcement.
    raw.executeSync('PRAGMA foreign_keys = ON');
    // recursive_triggers is left at its default OFF — the updated_at triggers
    // depend on that (see 0001_init.sql). Never enable it.

    const db = wrap(raw);

    const from = db.getUserVersion();
    if (from > 0 && pendingMigrations(from, MIGRATIONS).length > 0) {
      backupBeforeMigrate(raw);
    }
    migrate(db, MIGRATIONS);
    seedReferenceData(db);

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
 */
function backupBeforeMigrate(raw: OpDb): void {
  try {
    const backupPath = `${raw.getDbPath()}.pre-migrate-${Date.now()}.bak`;
    raw.executeSync(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    console.log(`[db] pre-migration backup written: ${backupPath}`);
  } catch (error) {
    console.warn('[db] pre-migration backup failed; proceeding with migration', error);
  }
}
