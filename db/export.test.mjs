/**
 * Headless test of the whole-database export serializer
 * (src/lib/export/serializer.ts) against real SQLite via node:sqlite.
 * Mirrors db/user.test.mjs; op-sqlite and Expo are never loaded.
 * Run: node --import ./db/register-ts-hooks.mjs db/export.test.mjs
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { updateProfile } from '../src/lib/db/repositories/user.ts';
import {
  buildExport,
  exportFileName,
  listExportTables,
  partitionTables,
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

console.log('8. tripwire: the migrated schema stays scalar-only, and declares no virtual table');
{
  // The serializer only round-trips text/integer/real/null. If a migration ever
  // adds a BLOB column, this must fail so the exporter is taught about it
  // BEFORE a device export silently breaks.
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
  // The MIGRATED schema has no virtual table on purpose: 0025 omits the vec0
  // DDL because node:sqlite has no such module, and rag.ts creates vec_chunks
  // lazily on device instead. So this assertion can never catch the real
  // hazard — sections 10 and 11 below simulate the on-device condition.
  const virtuals = raw
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'"
    )
    .all();
  virtuals.length === 0
    ? ok('migrations declare no virtual table (vec_chunks is created on device)')
    : bad('a migration now declares a virtual table', JSON.stringify(virtuals));
  const { omitted } = partitionTables(db);
  omitted.length === 0
    ? ok('omittedTables is empty on a plain migrated DB — no false positives')
    : bad('real tables were classified as virtual/shadow', JSON.stringify(omitted));
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

console.log('10. a REAL virtual table + its shadow tables are skipped (fts5 stands in for vec0)');
{
  // node:sqlite has no vec0, so the tripwire in section 8 can never fire — which
  // is precisely why the bug was invisible. FTS5 IS compiled into node:sqlite and
  // is structurally identical for our purposes: one `CREATE VIRTUAL TABLE`
  // row in sqlite_master plus real `<vtab>_<suffix>` shadow tables whose
  // sqlite_master.sql is a plain CREATE TABLE and whose columns hold BLOBs
  // (fts5's %_data.block / %_docsize.sz ≈ vec0's %_vector_chunks00.vectors).
  // Named `vec_chunks` — the exact name rag.ts creates — so the shadow names
  // match the real on-device prefixes.
  const { db, raw } = freshDb();
  let fts5 = true;
  try {
    raw.exec('CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING fts5(chunk_id, corpus)');
    raw.exec("INSERT INTO vec_chunks(chunk_id, corpus) VALUES ('c-1', 'knowledge')");
  } catch (e) {
    fts5 = false;
    bad('fts5 unavailable — cannot exercise the real virtual-table path', String(e?.message));
  }
  if (fts5) {
    // Sanity: the naive enumeration really would have exported BLOBs.
    const naive = raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
      )
      .all()
      .map((r) => r.name);
    const blobBearing = naive.filter((t) =>
      raw
        .prepare(`SELECT * FROM "${t.replaceAll('"', '""')}"`)
        .all()
        .some((row) => Object.values(row).some((v) => v instanceof Uint8Array))
    );
    blobBearing.length > 0
      ? ok(`without the fix these would have been exported as BLOBs: ${blobBearing.join(', ')}`)
      : bad('shadow tables hold no BLOBs — this test proves nothing');

    const tables = listExportTables(db);
    tables.includes('vec_chunks')
      ? bad('the vec0 virtual table itself rode into the export')
      : ok('virtual table vec_chunks excluded (CREATE VIRTUAL TABLE signal)');
    const leakedShadows = tables.filter((t) => t.startsWith('vec_chunks_'));
    leakedShadows.length === 0
      ? ok('every vec_chunks_* shadow table excluded (SQLite shadow-name rule)')
      : bad('shadow tables leaked', JSON.stringify(leakedShadows));
    ['users', 'biomarkers', 'knowledge_chunks', 'memory_chunks'].every((t) => tables.includes(t))
      ? ok('real tables — including the RAG chunk TEXT — still exported')
      : bad('real tables were dropped', JSON.stringify(tables));

    let doc = null;
    let threw = null;
    try {
      doc = buildExport(db, { exportedAt: AT });
    } catch (e) {
      threw = e;
    }
    threw
      ? bad('export still throws with a virtual table present', String(threw?.message))
      : ok('buildExport succeeds — export survives the day RAG runs on device');
    doc && doc.tables.vec_chunks === undefined && doc.tables.vec_chunks_data === undefined
      ? ok('no vec_chunks* key anywhere in the document')
      : bad('vector tables in document', JSON.stringify(Object.keys(doc?.tables ?? {})));
    const expectedOmitted = naive.filter((t) => t.startsWith('vec_chunks')).sort();
    doc && JSON.stringify(doc.omittedTables) === JSON.stringify(expectedOmitted)
      ? ok(`omittedTables names exactly what was skipped (${expectedOmitted.length} tables)`)
      : bad(
          'omittedTables wrong',
          JSON.stringify({ got: doc?.omittedTables, want: expectedOmitted })
        );

    // (b) The safety assertion must still be reachable for REAL tables — the fix
    // narrows what is enumerated, it does NOT weaken assertScalar.
    raw.exec('CREATE TABLE scratch_blob (id text PRIMARY KEY NOT NULL, payload blob);');
    raw
      .prepare('INSERT INTO scratch_blob (id, payload) VALUES (?, ?)')
      .run('s-1', new Uint8Array([9, 9, 9]));
    let stillThrows = null;
    try {
      buildExport(db, { exportedAt: AT });
    } catch (e) {
      stillThrows = e;
    }
    stillThrows && /scratch_blob\.payload/.test(String(stillThrows?.message))
      ? ok('a real BLOB-bearing table STILL fails loud, virtual table or not')
      : bad('safety assertion was weakened', String(stillThrows?.message ?? 'no throw'));
  }
}

console.log('11. exact sqlite-vec shadow names, on an engine with no pragma_table_list');
{
  // Layer 3 (`pragma_table_list`) is a cross-check, not the foundation: it needs
  // SQLite >= 3.37 AND the module to implement xShadowName. Here it is made to
  // throw, so ONLY the two sqlite_master signals are in play — and the rows are
  // the real vec0 shadow names sqlite-vec materialises under `vec_chunks`
  // (rag.ts: CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(...)).
  const { db } = freshDb();
  const VEC_ROWS = [
    {
      name: 'vec_chunks',
      sql: 'CREATE VIRTUAL TABLE vec_chunks USING vec0(chunk_id TEXT PRIMARY KEY, corpus TEXT PARTITION KEY, source TEXT, embedding FLOAT[768] DISTANCE_METRIC=cosine, chunk_size=512)',
    },
    { name: 'vec_chunks_chunks', sql: "CREATE TABLE 'vec_chunks_chunks'(chunk_id INTEGER" },
    { name: 'vec_chunks_rowids', sql: "CREATE TABLE 'vec_chunks_rowids'(rowid INTEGER" },
    {
      name: 'vec_chunks_vector_chunks00',
      sql: "CREATE TABLE 'vec_chunks_vector_chunks00'(rowid PRIMARY KEY, vectors BLOB NOT NULL)",
    },
    { name: 'vec_chunks_info', sql: "CREATE TABLE 'vec_chunks_info'(key TEXT PRIMARY KEY" },
    { name: 'vec_chunks_auxiliary', sql: "CREATE TABLE 'vec_chunks_auxiliary'(rowid INTEGER" },
  ];
  let pragmaAsked = false;
  const readAttempts = [];
  const fake = {
    ...db,
    all: (sql, params = []) => {
      if (sql.includes('pragma_table_list')) {
        pragmaAsked = true;
        throw new Error('no such table: pragma_table_list');
      }
      if (sql.includes('sqlite_master')) {
        return [...db.all(sql, params), ...VEC_ROWS].sort((a, b) => (a.name < b.name ? -1 : 1));
      }
      const target = /FROM "([^"]+)"/.exec(sql)?.[1];
      if (target && (target === 'vec_chunks' || target.startsWith('vec_chunks_'))) {
        readAttempts.push(target);
        // What a real read would hand back: packed float vectors.
        return [{ chunk_id: 'c-1', vectors: new Uint8Array([1, 2, 3, 4]) }];
      }
      return db.all(sql, params);
    },
  };

  const { exported, omitted } = partitionTables(fake);
  pragmaAsked ? ok('pragma_table_list was tried and its absence tolerated') : bad('pragma skipped');
  JSON.stringify(omitted) === JSON.stringify(VEC_ROWS.map((r) => r.name).sort())
    ? ok(`all 6 vec0 tables classified as omitted: ${omitted.join(', ')}`)
    : bad('vec0 classification', JSON.stringify(omitted));
  exported.some((t) => t.startsWith('vec_chunks'))
    ? bad('a vec0 table survived into the export list', JSON.stringify(exported))
    : ok('exported list is free of vec0 tables');
  exported.includes('knowledge_chunks') && exported.includes('memory_chunks')
    ? ok('similarly-named real RAG tables kept (prefix rule is not a substring match)')
    : bad('real chunk tables dropped', JSON.stringify(exported));

  let threw = null;
  let doc = null;
  try {
    doc = buildExport(fake, { exportedAt: AT });
  } catch (e) {
    threw = e;
  }
  threw
    ? bad('export threw on the vec0-shaped schema', String(threw?.message))
    : ok('buildExport completes against a vec0-shaped sqlite_master');
  readAttempts.length === 0
    ? ok('the exporter never even SELECTed from a vector/shadow table')
    : bad('vector tables were read', JSON.stringify(readAttempts));
  doc && JSON.stringify(doc.omittedTables) === JSON.stringify(omitted)
    ? ok('the document records the omission for whoever reads the file')
    : bad('omittedTables missing from document', JSON.stringify(doc?.omittedTables));
}

console.log('12. GUARD: no REAL table may collide with the vec0 shadow-name rule');
{
  // serializer.ts omits any table named `<vtab>_<suffix>` — SQLite's own shadow
  // naming rule, and correct for sqlite-vec as it exists today. But it is a
  // NAME rule: it cannot tell a shadow table apart from an ordinary table that
  // merely shares the prefix. The day a migration adds, say,
  // `vec_chunks_manual_notes`, that table is dropped from the backup with no
  // error and no omittedTables entry a human would question — the export just
  // quietly gets smaller, and the loss is only discovered at restore.
  //
  // So the invariant is enforced HERE, on the real migration chain, rather than
  // left to reviewer memory: no migrated table name may start with the vector
  // table's name + '_'. If this fails, either rename the new table or teach
  // serializer.ts a real shadow test (pragma_table_list type='shadow', which is
  // authoritative but needs SQLite >= 3.37 AND xShadowName from the module).
  const { db, raw } = freshDb();

  // Aim the guard using rag.ts's own literal, so renaming the vector table
  // can't leave this suite quietly checking a prefix nothing uses any more.
  const ragSrc = readFileSync(
    new URL('../src/lib/db/repositories/rag.ts', import.meta.url),
    'utf8'
  );
  const vecTable = /const VEC_TABLE = '([^']+)'/.exec(ragSrc)?.[1] ?? null;
  vecTable === 'vec_chunks'
    ? ok(`vector table is still '${vecTable}' in rag.ts — guard aimed correctly`)
    : bad('rag.ts renamed the vector table; re-aim this guard', String(vecTable));
  const prefix = `${vecTable ?? 'vec_chunks'}_`;

  // The predicate below is serializer.ts's shadow rule, restated.
  const isCapturedAsShadow = (name) => name.length > prefix.length && name.startsWith(prefix);

  const migrated = raw
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
    )
    .all()
    .map((r) => r.name);
  const captured = migrated.filter(isCapturedAsShadow);
  captured.length === 0
    ? ok(`no migrated table starts with '${prefix}' (${migrated.length} tables checked)`)
    : bad(
        `REAL tables would be silently dropped from the backup as vec0 shadows: ${captured.join(', ')}`
      );

  // Non-vacuity: prove the predicate actually bites, so a green line above
  // means "checked and clean", never "checked nothing".
  const hypothetical = `${prefix}manual_notes`;
  [...migrated, hypothetical].filter(isCapturedAsShadow).join(',') === hypothetical
    ? ok(`guard is live: a future '${hypothetical}' table would fail this suite`)
    : bad('guard is vacuous — the predicate matches nothing');

  // And the loss is real, not theoretical: once the vec0 table exists on device,
  // the exporter genuinely drops such a table. (fts5 stands in for vec0, as in
  // section 10 — node:sqlite has no vec0 module.)
  let fts5 = true;
  try {
    raw.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${vecTable} USING fts5(chunk_id, corpus)`);
  } catch (e) {
    fts5 = false;
    bad('fts5 unavailable — cannot demonstrate the real drop', String(e?.message));
  }
  if (fts5) {
    raw.exec(`CREATE TABLE "${hypothetical}" (id text PRIMARY KEY NOT NULL, body text NOT NULL);`);
    raw.prepare(`INSERT INTO "${hypothetical}" (id, body) VALUES (?, ?)`).run('n-1', 'a real note');
    const tables = listExportTables(db);
    tables.includes(hypothetical)
      ? bad('demonstration failed — the prefix rule did not capture it after all')
      : ok(`demonstrated: '${hypothetical}' IS dropped from the export — why this guard exists`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
