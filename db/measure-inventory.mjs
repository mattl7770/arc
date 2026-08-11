/**
 * Measures the schema inventory of record (docs/project-status.md): tables,
 * migration files, head version, repositories — by RUNNING the migrations, not
 * by counting anything by hand. Run: node --import ./db/register-ts-hooks.mjs db/measure-inventory.mjs
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';

const raw = new DatabaseSync(':memory:');
raw.exec('PRAGMA foreign_keys = ON');

const db = {
  run: (sql, params = []) => {
    raw.prepare(sql).run(...params);
  },
  all: (sql, params = []) => raw.prepare(sql).all(...params),
  get: (sql, params = []) => raw.prepare(sql).get(...params),
  exec: (sql) => raw.exec(sql),
  transaction: (fn) => {
    raw.exec('BEGIN');
    try {
      const out = fn();
      raw.exec('COMMIT');
      return out;
    } catch (error) {
      raw.exec('ROLLBACK');
      throw error;
    }
  },
};

const result = migrate(
  {
    exec: db.exec,
    getUserVersion: () => raw.prepare('PRAGMA user_version').get().user_version,
    setUserVersion: (n) => raw.exec(`PRAGMA user_version = ${n}`),
    transaction: db.transaction,
  },
  MIGRATIONS
);
const tables = raw
  .prepare(
    "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  )
  .get();

const files = fs.readdirSync('db/migrations').filter((f) => f.endsWith('.sql'));
const repos = fs.readdirSync('src/lib/db/repositories').filter((f) => f.endsWith('.ts'));

console.log(
  JSON.stringify(
    {
      tables: tables.n,
      migrationFiles: files.length,
      head: files[files.length - 1].replace('.sql', ''),
      headVersion: result.to,
      applied: result.applied.length,
      repositories: repos.length,
    },
    null,
    2
  )
);
