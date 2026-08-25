/**
 * '@/lib/db/client' stub for the headless screen-render suite: the same
 * Database interface the app's op-sqlite client provides, backed by
 * node:sqlite with the REAL migrations applied — so the screens' synchronous
 * useState-initializer reads run against the true schema.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../../src/lib/db/migrations.generated.ts';
import { applyConnectionPragmas } from '../../src/lib/db/pragmas.ts';

let cached = null;

function makeDb(raw) {
  return {
    run: (sql, params = []) => {
      raw.prepare(sql).run(...params);
    },
    all: (sql, params = []) => raw.prepare(sql).all(...params),
    get: (sql, params = []) => raw.prepare(sql).get(...params),
    transaction: (fn) => {
      raw.exec('BEGIN');
      try {
        fn();
        raw.exec('COMMIT');
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

export function getDb() {
  if (cached) return cached;
  const raw = new DatabaseSync(':memory:');
  applyConnectionPragmas((sql) => raw.exec(sql));
  const db = makeDb(raw);
  migrate(
    {
      exec: (sql) => raw.exec(sql),
      getUserVersion: () => raw.prepare('PRAGMA user_version').get().user_version,
      setUserVersion: (n) => raw.exec(`PRAGMA user_version = ${n}`),
      transaction: db.transaction,
    },
    MIGRATIONS
  );
  cached = db;
  return db;
}
