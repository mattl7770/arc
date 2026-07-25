/**
 * Forward-only migration runner for ARC's on-device SQLite database.
 *
 * Pure logic behind a tiny {@link MigrationExecutor} interface, so the exact
 * same code runs against op-sqlite on device and against node:sqlite in tests
 * (see db/migrate.test.mjs) — the SQL is verified without a device build.
 *
 * The versioning contract mirrors SQLite's own `PRAGMA user_version`: a fresh
 * database reports 0; after applying migration N it reports N. Migrations are
 * applied in ascending version order, each wrapped in a transaction so a
 * failure leaves the database exactly where it was. Migrations never run twice
 * and are never rolled back once applied — to change the schema, add the next
 * numbered file, never edit a shipped one.
 */

/** One migration: a version number, a name, and the SQL that upgrades to it. */
export type Migration = {
  /** Strictly increasing, 1-based. Matches the NNNN prefix of the .sql file. */
  version: number;
  /** File stem, e.g. "0001_init" — for logging and the applied[] result. */
  name: string;
  /** The full DDL for this migration. */
  sql: string;
};

/**
 * The minimal database surface the runner needs. Implemented over op-sqlite in
 * the app (src/lib/db/client.ts) and over node:sqlite in the headless test.
 */
export type MigrationExecutor = {
  /** Run one or more SQL statements; no result is read. */
  exec: (sql: string) => void;
  /** Read the integer `PRAGMA user_version` (0 on a fresh database). */
  getUserVersion: () => number;
  /** Set `PRAGMA user_version = n`. */
  setUserVersion: (n: number) => void;
  /** Run `fn` inside a transaction; on throw, roll back and rethrow. */
  transaction: (fn: () => void) => void;
};

export type MigrateResult = {
  /** user_version before running. */
  from: number;
  /** user_version after running. */
  to: number;
  /** Names of migrations applied this run, in order. */
  applied: string[];
};

/**
 * Migrations from `all` that have not yet been applied at `currentVersion`,
 * in ascending order. Also the place the invariants are enforced, so a
 * malformed migration set fails loudly rather than corrupting the database.
 */
export function pendingMigrations(currentVersion: number, all: Migration[]): Migration[] {
  const sorted = [...all].sort((a, b) => a.version - b.version);
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i]!;
    if (!Number.isInteger(m.version) || m.version < 1) {
      throw new Error(
        `Migration "${m.name}" has an invalid version ${m.version} (must be an integer >= 1).`
      );
    }
    if (i > 0 && sorted[i - 1]!.version === m.version) {
      throw new Error(
        `Duplicate migration version ${m.version} ("${sorted[i - 1]!.name}" and "${m.name}").`
      );
    }
  }
  return sorted.filter((m) => m.version > currentVersion);
}

/**
 * Apply every pending migration in order, each in its own transaction, bumping
 * `user_version` inside the same transaction so the version can never drift
 * from the schema. Returns what ran. Idempotent: a second call with nothing
 * pending is a no-op.
 *
 * Note: the caller (the op-sqlite client) is responsible for the pre-migration
 * file backup — SQLite DDL is transactional so the in-transaction rollback here
 * handles logic errors, but a file copy is the belt-and-braces for the
 * irreplaceable-data case (see docs/architecture-migration.md, Phase 1).
 */
export function migrate(db: MigrationExecutor, all: Migration[]): MigrateResult {
  const from = db.getUserVersion();
  const pending = pendingMigrations(from, all);
  const applied: string[] = [];

  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      db.setUserVersion(m.version);
    });
    applied.push(m.name);
  }

  return { from, to: db.getUserVersion(), applied };
}
