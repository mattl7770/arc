/**
 * Headless test of the whole-database export serializer
 * (src/lib/export/serializer.ts) against real SQLite via node:sqlite.
 * Mirrors db/user.test.mjs; op-sqlite and Expo are never loaded.
 * Run: node --import ./db/register-ts-hooks.mjs db/export.test.mjs
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { updateProfile } from '../src/lib/db/repositories/user.ts';
import {
  buildExport,
  exportFileName,
  listExportTables,
  readAllRows,
  schemaVersion,
  serializeExport,
} from '../src/lib/export/serializer.ts';

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

function freshDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
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
  return { raw, db };
}

const AT = '2026-07-29T14:33:08.123Z';

console.log('1. listExportTables covers the whole schema, nothing internal');
{
  const { db, raw } = freshDb();
  const tables = listExportTables(db);
  const expected = raw
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
    )
    .all()
    .map((r) => r.name);
  JSON.stringify(tables) === JSON.stringify(expected)
    ? ok(`matches sqlite_master exactly (${tables.length} tables)`)
    : bad('table list', JSON.stringify({ tables, expected }));
  ['users', 'biomarkers', 'meals', 'workouts', 'reminders', 'foods', 'programs'].every((t) =>
    tables.includes(t)
  )
    ? ok('spot-check: core tables from several migrations present')
    : bad('spot-check', JSON.stringify(tables));
  tables.some((t) => t.startsWith('sqlite_'))
    ? bad('sqlite internals leaked')
    : ok('no sqlite_* internals');
  JSON.stringify(tables) === JSON.stringify([...tables].sort())
    ? ok('alphabetical, so exports diff cleanly')
    : bad('ordering', JSON.stringify(tables));
}

console.log('2. buildExport: every table present, rows round-trip exactly');
{
  const { db } = freshDb();
  updateProfile(db, { fullName: 'Matt', biologicalSex: 'male' });
  db.run(
    'INSERT INTO body_metrics (id, measured_at, weight_kg, body_fat_pct) VALUES (?, ?, ?, ?)',
    ['bm-1', '2026-07-29T07:00:00.000Z', 81.6, 14.2]
  );
  const doc = buildExport(db, { exportedAt: AT, appVersion: '0.1.0' });
  const tables = listExportTables(db);
  tables.every((t) => Array.isArray(doc.tables[t]))
    ? ok('every listed table is an array in the document')
    : bad('missing tables', JSON.stringify(Object.keys(doc.tables)));
  const user = doc.tables.users[0];
  user.full_name === 'Matt' && user.biological_sex === 'male'
    ? ok('user profile values survive')
    : bad('user row', JSON.stringify(user));
  const bm = doc.tables.body_metrics[0];
  bm.id === 'bm-1' &&
  bm.weight_kg === 81.6 &&
  bm.body_fat_pct === 14.2 &&
  bm.muscle_mass_kg === null
    ? ok('numbers stay numbers, absent columns stay null (not "")')
    : bad('body_metrics row', JSON.stringify(bm));
  doc.format === 'arc-export' && doc.formatVersion === 1 && doc.appVersion === '0.1.0'
    ? ok('envelope: format, formatVersion, appVersion')
    : bad('envelope', JSON.stringify({ f: doc.format, v: doc.formatVersion, a: doc.appVersion }));
  doc.exportedAt === AT ? ok('exportedAt is caller-supplied') : bad('exportedAt', doc.exportedAt);
}

console.log('3. schemaVersion mirrors PRAGMA user_version');
{
  const { db, raw } = freshDb();
  const pragma = raw.prepare('PRAGMA user_version').get().user_version;
  const doc = buildExport(db, { exportedAt: AT });
  doc.schemaVersion === pragma && pragma > 0
    ? ok(`schemaVersion ${doc.schemaVersion} = user_version ${pragma}`)
    : bad('schemaVersion', `${doc.schemaVersion} vs ${pragma}`);
  schemaVersion(db) === pragma ? ok('helper agrees') : bad('helper', schemaVersion(db));
}

console.log('4. rows export in insertion (rowid) order — deterministic dumps');
{
  const { db } = freshDb();
  for (const [id, at] of [
    ['bm-c', '2026-07-03'],
    ['bm-a', '2026-07-01'],
    ['bm-b', '2026-07-02'],
  ]) {
    db.run('INSERT INTO body_metrics (id, measured_at) VALUES (?, ?)', [id, at]);
  }
  const rows = readAllRows(db, 'body_metrics');
  JSON.stringify(rows.map((r) => r.id)) === JSON.stringify(['bm-c', 'bm-a', 'bm-b'])
    ? ok('insertion order, not key order')
    : bad('row order', JSON.stringify(rows.map((r) => r.id)));
  const a = serializeExport(buildExport(db, { exportedAt: AT }));
  const b = serializeExport(buildExport(db, { exportedAt: AT }));
  a === b ? ok('same DB + same moment → byte-identical JSON') : bad('determinism');
}

console.log('5. a WITHOUT ROWID table still exports (fallback path)');
{
  const { db, raw } = freshDb();
  raw.exec('CREATE TABLE no_rowid (k text PRIMARY KEY NOT NULL, v text) WITHOUT ROWID;');
  raw.exec("INSERT INTO no_rowid (k, v) VALUES ('a', '1'), ('b', '2');");
  const doc = buildExport(db, { exportedAt: AT });
  Array.isArray(doc.tables.no_rowid) && doc.tables.no_rowid.length === 2
    ? ok('table included via the no-ORDER-BY fallback')
    : bad('without-rowid', JSON.stringify(doc.tables.no_rowid));
}

console.log('6. serializeExport round-trips through JSON.parse losslessly');
{
  const { db } = freshDb();
  updateProfile(db, { fullName: 'Röund “Trip” \\ ok' });
  const doc = buildExport(db, { exportedAt: AT, appVersion: null });
  const revived = JSON.parse(serializeExport(doc));
  JSON.stringify(revived) === JSON.stringify(doc)
    ? ok('parse(serialize(doc)) deep-equals doc (incl. unicode/quotes)')
    : bad('round trip');
}

console.log('7. exportFileName is filesystem-safe and derived from the moment');
{
  exportFileName(AT) === 'arc-export-20260729-143308.json'
    ? ok('arc-export-20260729-143308.json')
    : bad('name', exportFileName(AT));
  exportFileName('garbage') === 'arc-export.json'
    ? ok('unparsable moment falls back to a plain name')
    : bad('fallback', exportFileName('garbage'));
  /^[A-Za-z0-9.-]+$/.test(exportFileName(AT))
    ? ok('no path separators, colons, or spaces')
    : bad('unsafe chars', exportFileName(AT));
}

console.log('8. tripwire: the migrated schema stays scalar-only (no BLOBs, no virtual tables)');
{
  // The serializer only round-trips text/integer/real/null. If a migration
  // ever adds a BLOB column or a sqlite-vec virtual table, this must fail so
  // the exporter is taught about it BEFORE a device export silently breaks.
  const { db, raw } = freshDb();
  const blobCols = [];
  for (const table of listExportTables(db)) {
    for (const col of raw.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all()) {
      if (String(col.type).toUpperCase().includes('BLOB')) blobCols.push(`${table}.${col.name}`);
    }
  }
  blobCols.length === 0
    ? ok('no BLOB-affinity columns in any migrated table')
    : bad('BLOB columns exist — teach the exporter first', JSON.stringify(blobCols));
  const virtuals = raw
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'"
    )
    .all();
  virtuals.length === 0
    ? ok('no virtual tables (vec0 etc.) — they would ride into the export')
    : bad('virtual tables exist — decide how they export', JSON.stringify(virtuals));
}

console.log('9. a non-scalar value fails the export LOUDLY, never silently corrupts');
{
  const { db, raw } = freshDb();
  raw.exec('CREATE TABLE scratch_blob (id text PRIMARY KEY NOT NULL, payload blob);');
  raw
    .prepare('INSERT INTO scratch_blob (id, payload) VALUES (?, ?)')
    .run('s-1', new Uint8Array([1, 2, 3]));
  let threw = null;
  try {
    buildExport(db, { exportedAt: AT });
  } catch (e) {
    threw = e;
  }
  threw
    ? ok('buildExport throws instead of writing a lying file')
    : bad('blob passed through silently');
  threw && /scratch_blob\.payload/.test(String(threw?.message))
    ? ok('error names the offending table.column')
    : bad('error lacks context', String(threw?.message));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
