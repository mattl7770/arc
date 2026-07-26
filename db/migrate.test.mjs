/**
 * Headless test of the migration runner (src/lib/db/migrate.ts) against real
 * SQLite via node:sqlite — the same engine op-sqlite ships, so runner behaviour
 * verified here holds on device. Imports the TypeScript directly (Node strips
 * the types). Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';
import { migrate, pendingMigrations } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';

let pass = 0;
let fail = 0;
const ok = (n) => {
  pass++;
  console.log(`  ok   ${n}`);
};
const bad = (n, e) => {
  fail++;
  console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`);
};

/** A node:sqlite-backed MigrationExecutor, matching the op-sqlite one. */
function executor(db) {
  return {
    exec: (sql) => db.exec(sql),
    getUserVersion: () => db.prepare('PRAGMA user_version').get().user_version,
    setUserVersion: (n) => db.exec(`PRAGMA user_version = ${n}`),
    transaction: (fn) => {
      db.exec('BEGIN');
      try {
        fn();
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

// The final user_version is the HIGHEST version, not the count — version
// numbers may hold gaps while parallel slices are in flight (0003 shipped
// while 0002 was still on its branch), and the runner tolerates that.
const LATEST = Math.max(...MIGRATIONS.map((m) => m.version));

console.log('1. Fresh database applies all migrations');
{
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const r = migrate(executor(db), MIGRATIONS);
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const tableCount = db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table'").get().c;
  r.from === 0 && r.to === LATEST && r.applied.length === MIGRATIONS.length
    ? ok(`applied ${r.applied.length} migration(s): ${r.applied.join(', ')}`)
    : bad('applied all from 0', JSON.stringify(r));
  version === LATEST
    ? ok(`user_version = ${version}`)
    : bad('user_version bumped', String(version));
  tableCount >= 10
    ? ok(`schema created (${tableCount} tables)`)
    : bad('tables created', String(tableCount));
  db.close();
}

console.log('2. Re-running is a no-op (idempotent)');
{
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(executor(db), MIGRATIONS);
  const second = migrate(executor(db), MIGRATIONS);
  second.applied.length === 0 && second.from === LATEST && second.to === LATEST
    ? ok('second run applies nothing')
    : bad('idempotent re-run', JSON.stringify(second));
  db.close();
}

console.log('3. pendingMigrations selects only newer, in order, and validates');
{
  const set = [
    { version: 2, name: 'b', sql: '' },
    { version: 1, name: 'a', sql: '' },
    { version: 3, name: 'c', sql: '' },
  ];
  const pend = pendingMigrations(1, set).map((m) => m.name);
  JSON.stringify(pend) === JSON.stringify(['b', 'c'])
    ? ok('returns >current, sorted ascending')
    : bad('pending selection', JSON.stringify(pend));

  let threw = false;
  try {
    pendingMigrations(0, [
      { version: 1, name: 'x', sql: '' },
      { version: 1, name: 'y', sql: '' },
    ]);
  } catch {
    threw = true;
  }
  threw ? ok('duplicate version throws') : bad('duplicate version should throw');
}

console.log('4. A failing migration rolls back (version + schema unchanged)');
{
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const broken = [
    {
      version: 1,
      name: 'partial_then_boom',
      // Creates a table, then a duplicate CREATE fails mid-migration.
      sql: 'CREATE TABLE t (id text); CREATE TABLE t (id text);',
    },
  ];
  let threw = false;
  try {
    migrate(executor(db), broken);
  } catch {
    threw = true;
  }
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const tExists = db
    .prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='t'")
    .get().c;
  threw ? ok('migration error propagates') : bad('should have thrown');
  version === 0
    ? ok('user_version stays 0 after rollback')
    : bad('version rolled back', String(version));
  tExists === 0
    ? ok('partial table rolled back (no half-applied schema)')
    : bad('table survived rollback');
  db.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
