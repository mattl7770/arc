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
    // SQLite defaults foreign_keys OFF; the schema relies on FK enforcement.
    raw.executeSync('PRAGMA foreign_keys = ON');
    // recursive_triggers is left at its default OFF — the updated_at triggers
    // depend on that (see 0001_init.sql). Never enable it.

    const db = wrap(raw);

    const from = db.getUserVersion();
    if (from > 0 && pendingMigrations(from, MIGRATIONS).length > 0) {
      backupBeforeMigrate(raw.getDbPath());
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
 * Pre-migration safety net (2026-07-24 audit finding). Not reached at Phase 1b:
 * the only migration is 0001 on a fresh (user_version 0) database, so there is
 * nothing to lose. It goes live when 0002 first ships against a populated DB —
 * wire it then to copy the file at `dbPath` (via expo-file-system, which lands
 * with the Phase 4 backup infra) before migrating. The call site exists now so
 * that wiring is a one-function change, not a restructure.
 */
function backupBeforeMigrate(dbPath: string): void {
  const message =
    `[db] pending migration against existing data at ${dbPath}: pre-migration ` +
    `backup is not implemented yet — wire the file copy (expo-file-system) before ` +
    `shipping the next migration.`;
  // Fail loud in development: this fires the moment migration 0002 is added
  // against a populated DB, which is exactly when the backup must be wired. In
  // production, warn rather than brick the app on boot.
  if (__DEV__) throw new Error(message);
  console.warn(message);
}
