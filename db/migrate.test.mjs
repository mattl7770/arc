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

// ===========================================================================
// 5. 0029 — the fabricated-mission purge, against a HOSTILE mixture.
//
// This is the only migration in the project that DELETES user data, so it gets
// the only fixture in the project built to try to make it delete the wrong
// thing. Every row below is inserted with raw SQL (never through the
// repositories) so the test cannot inherit a repository's own assumptions
// about what a row looks like, and every survivor is compared BYTE-IDENTICALLY
// (all columns, including created_at/updated_at) before and after.
// ===========================================================================
const PURGE_VERSION = 29;

/** Apply every migration up to and including `version`, leaving user_version there. */
function stageAt(db, version) {
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(
    executor(db),
    MIGRATIONS.filter((m) => m.version <= version)
  );
  return db.prepare('PRAGMA user_version').get().user_version;
}

/** Every column of every log_entries row, ordered — the byte-identity snapshot. */
const snapshotEntries = (db) => db.prepare('SELECT * FROM log_entries ORDER BY id').all();
const snapshotDailyLogs = (db) => db.prepare('SELECT * FROM daily_logs ORDER BY id').all();
const titlesOf = (rows) => rows.map((r) => r.title).sort();

/**
 * The hostile fixture. `[id, dailyLogId, type, status, value, protocolId, title]`.
 * The id prefix is the expectation: **`x-` MUST be deleted, `k-` MUST be kept**
 * ("x" for excised, "k" for kept). The assertions below derive both sets from
 * those prefixes, so adding a row here automatically extends the proof.
 */
function seedFixture(db) {
  db.exec(`
    INSERT INTO protocols (id, slug, name, type) VALUES
      ('p-morning', 'morning-stack', 'Morning Stack', 'supplement_stack');
    INSERT INTO daily_logs (id, date, summary, notes, overall_adherence_score) VALUES
      ('dl-1', '2026-07-01', 'felt strong',  'slept 8h',  91.5),
      ('dl-2', '2026-07-02', NULL,           NULL,        NULL),
      ('dl-3', '2026-07-03', 'travel day',   'ate out',   40.0),
      ('dl-4', '2026-07-04', 'rest',         'no entries', 100.0),
      ('dl-5', '2026-07-05', NULL,           NULL,        NULL);
  `);

  const rows = [
    // ---- FABRICATED: seed:true in every status, across several days --------
    [
      'x-seed-pending',
      'dl-1',
      'supplement',
      'pending',
      '{"category":"Supplements","why":"NAD+ support","estimatedMinutes":2,"protocol":"Longevity Core","seed":true}',
      null,
      'NMN 500mg',
    ],
    [
      'x-seed-completed',
      'dl-1',
      'supplement',
      'completed',
      '{"category":"Supplements","protocol":"Longevity Core","seed":true}',
      null,
      'Creatine 5g',
    ],
    [
      'x-seed-partial',
      'dl-2',
      'workout',
      'partial',
      '{"category":"Training","seed":true}',
      null,
      'Zone 2 · 45 min',
    ],
    [
      'x-seed-skipped',
      'dl-2',
      'meal',
      'skipped',
      '{"category":"Nutrition","seed":true}',
      null,
      'Protein breakfast',
    ],
    [
      'x-seed-habit',
      'dl-3',
      'habit',
      'pending',
      '{"category":"Morning","why":"circadian anchor","estimatedMinutes":10,"protocol":"Morning Protocol","seed":true}',
      null,
      'Sunlight 10 min',
    ],
    // dl-5 holds ONLY this row: the day must survive the purge while emptied.
    [
      'x-seed-lonely',
      'dl-5',
      'therapy',
      'completed',
      '{"category":"Therapies","seed":true}',
      null,
      'Sauna 20 min',
    ],

    // ---- REAL: ad-hoc Log-tab captures (value.adhoc) -----------------------
    [
      'k-adhoc-note',
      'dl-1',
      'note',
      'completed',
      '{"adhoc":true}',
      null,
      'Right knee ached on the stairs',
    ],
    [
      'k-adhoc-metric',
      'dl-1',
      'metric',
      'completed',
      '{"adhoc":true,"metricKey":"water","canonical":500}',
      null,
      '500 ml',
    ],
    [
      'k-adhoc-capture',
      'dl-2',
      'supplement',
      'completed',
      '{"adhoc":true,"protocol":true}',
      null,
      'Magnesium · 400 mg',
    ],

    // ---- REAL: protocol-generated plan rows --------------------------------
    [
      'k-gen-protocol',
      'dl-1',
      'supplement',
      'pending',
      '{"protocol":"Morning Stack","why":"1 g","generated":true}',
      'p-morning',
      'Omega-3',
    ],
    [
      'k-gen-mode',
      'dl-3',
      'habit',
      'pending',
      '{"protocol":"Sick","why":"rest","generated":true,"mode":"sick"}',
      null,
      'Rest and fluids',
    ],

    // ---- REAL: manually-typed / hand-added entries -------------------------
    ['k-manual-null', 'dl-2', 'habit', 'pending', null, null, 'Call the clinic'],
    ['k-manual-empty', 'dl-2', 'habit', 'completed', '{}', null, 'Journal 5 min'],

    // ---- REAL: the word "seed" living in USER TEXT, not in the marker ------
    ['k-text-seed', 'dl-3', 'note', 'completed', null, null, 'Bought chia seed pudding, felt good'],
    [
      'k-text-seed-json',
      'dl-3',
      'note',
      'completed',
      '{"adhoc":true}',
      null,
      'note to self: seed:true is how the fake rows were tagged',
    ],

    // ---- REAL: `seed` present but at a DIFFERENT JSON path -----------------
    [
      'k-nested-seed',
      'dl-3',
      'habit',
      'pending',
      '{"meta":{"seed":true}}',
      null,
      'Nested seed key',
    ],

    // ---- REAL: value is valid JSON but not an object -----------------------
    ['k-json-array', 'dl-4', 'metric', 'completed', '[1,2,3]', null, 'JSON array value'],
    [
      'k-json-array-seed',
      'dl-4',
      'metric',
      'completed',
      '["seed"]',
      null,
      'JSON array containing seed',
    ],
    ['k-json-string', 'dl-4', 'note', 'completed', '"just a string"', null, 'JSON string value'],
    ['k-json-string-seed', 'dl-4', 'note', 'completed', '"seed"', null, 'JSON string that IS seed'],
    ['k-json-number', 'dl-4', 'metric', 'completed', '123', null, 'JSON number value'],
    ['k-json-null', 'dl-4', 'note', 'completed', 'null', null, 'JSON null literal value'],

    // ---- REAL: falsy / wrongly-typed seed values ---------------------------
    ['k-seed-false', 'dl-4', 'habit', 'pending', '{"seed":false}', null, 'seed is JSON false'],
    ['k-seed-zero', 'dl-4', 'habit', 'pending', '{"seed":0}', null, 'seed is integer 0'],
    [
      'k-seed-str-false',
      'dl-4',
      'habit',
      'pending',
      '{"seed":"false"}',
      null,
      'seed is the string false',
    ],
    [
      'k-seed-str-true',
      'dl-4',
      'habit',
      'pending',
      '{"seed":"true"}',
      null,
      'seed is the STRING true',
    ],
    // The tightening json_type buys us: integer 1 is NOT the marker any writer
    // emits, and `json_extract(...) = 1` would have deleted this row.
    ['k-seed-one', 'dl-4', 'habit', 'pending', '{"seed":1}', null, 'seed is integer 1'],

    // ---- REAL: seed:true but disqualified by a second, independent term ----
    [
      'k-seed-adhoc',
      'dl-5',
      'note',
      'completed',
      '{"seed":true,"adhoc":true}',
      null,
      'seed AND adhoc — adhoc wins',
    ],
    [
      'k-seed-generated',
      'dl-5',
      'habit',
      'pending',
      '{"seed":true,"generated":true}',
      null,
      'seed AND generated — generated wins',
    ],
    [
      'k-seed-protocol-id',
      'dl-5',
      'supplement',
      'pending',
      '{"seed":true}',
      'p-morning',
      'seed BUT linked to a real protocol',
    ],
  ];

  const ins = db.prepare(
    `INSERT INTO log_entries (id, daily_log_id, type, status, value, protocol_id, title)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const r of rows) ins.run(...r);
  return rows;
}

console.log('5. 0029 purges ONLY the fabricated seed mission rows');
{
  const db = new DatabaseSync(':memory:');
  const staged = stageAt(db, PURGE_VERSION - 1);
  staged === PURGE_VERSION - 1
    ? ok(`staged at user_version ${staged} (0029 pending)`)
    : bad('stage at 28', String(staged));

  const fixture = seedFixture(db);
  const before = snapshotEntries(db);
  const dailyBefore = snapshotDailyLogs(db);
  const expectedDead = fixture.filter((r) => r[0].startsWith('x-')).map((r) => r[0]);
  const expectedAlive = fixture.filter((r) => r[0].startsWith('k-')).map((r) => r[0]);

  before.length === fixture.length
    ? ok(
        `fixture staged: ${before.length} log_entries (${expectedDead.length} fabricated, ${expectedAlive.length} real)`
      )
    : bad('fixture insert', `${before.length} of ${fixture.length}`);

  const result = migrate(executor(db), MIGRATIONS);
  // Floor convention: 0029 applies FIRST from a v28 stage; later migrations
  // (0030+) legitimately follow it, so only the head of the list is pinned.
  result.applied[0] === '0029_purge_seed_mission'
    ? ok(`0029_purge_seed_mission applied first (${result.applied.length} total from v28)`)
    : bad('applied 0029 first', JSON.stringify(result.applied));

  const after = snapshotEntries(db);
  const aliveIds = after.map((r) => r.id);

  // (a) every fabricated row is gone
  const survivedDead = expectedDead.filter((id) => aliveIds.includes(id));
  survivedDead.length === 0
    ? ok(
        `all ${expectedDead.length} fabricated rows deleted (every status: pending/completed/partial/skipped)`
      )
    : bad('fabricated rows survived', survivedDead.join(', '));

  // (b) every real row is still here
  const killedAlive = expectedAlive.filter((id) => !aliveIds.includes(id));
  killedAlive.length === 0
    ? ok(`all ${expectedAlive.length} real rows survived`)
    : bad('REAL ROWS DESTROYED', killedAlive.join(', '));

  // (c) survivors are byte-identical — no column mutated, no trigger fired
  const beforeAlive = before.filter((r) => expectedAlive.includes(r.id));
  JSON.stringify(beforeAlive) === JSON.stringify(after)
    ? ok('survivors byte-identical (all columns, incl. created_at/updated_at)')
    : bad('survivor rows mutated', JSON.stringify(after));

  // (d) the specific traps, named individually so a failure says which one
  const alive = (id) => aliveIds.includes(id);
  alive('k-seed-one')
    ? ok("integer `seed: 1` survives — json_type('true') is not json_extract = 1")
    : bad('json_extract coercion deleted {"seed":1}');
  alive('k-seed-adhoc') && alive('k-seed-generated') && alive('k-seed-protocol-id')
    ? ok('seed:true rows disqualified by adhoc / generated / protocol_id all survive')
    : bad('a disqualifying term failed to protect its row');
  alive('k-nested-seed')
    ? ok('a nested `seed` at $.meta.seed is not the marker')
    : bad('nested seed key deleted');
  alive('k-text-seed') && alive('k-text-seed-json')
    ? ok('user notes whose TEXT contains "seed" survive')
    : bad('a user note was deleted for its wording');
  alive('k-json-array') &&
  alive('k-json-array-seed') &&
  alive('k-json-string') &&
  alive('k-json-string-seed') &&
  alive('k-json-number') &&
  alive('k-json-null')
    ? ok('non-object JSON values (array/string/number/null) survive, no error raised')
    : bad('a non-object JSON value row was deleted');
  alive('k-manual-null') && alive('k-manual-empty')
    ? ok('value = NULL and value = {} survive')
    : bad('null/empty value row deleted');
  alive('k-seed-false') &&
  alive('k-seed-zero') &&
  alive('k-seed-str-false') &&
  alive('k-seed-str-true')
    ? ok('seed false / 0 / "false" / "true" all survive')
    : bad('a falsy or string-typed seed was treated as the marker');
  alive('k-adhoc-note') && alive('k-adhoc-metric') && alive('k-adhoc-capture')
    ? ok('ad-hoc Log-tab captures survive (PLANNED_ROW_SQL reproduced correctly)')
    : bad('an ad-hoc capture was deleted');
  alive('k-gen-protocol') && alive('k-gen-mode')
    ? ok('protocol-generated and mode-injected plan rows survive')
    : bad('a generated plan row was deleted');

  // (e) daily_logs are never touched — including the day left empty
  const dailyAfter = snapshotDailyLogs(db);
  JSON.stringify(dailyBefore) === JSON.stringify(dailyAfter)
    ? ok(
        `all ${dailyAfter.length} daily_logs preserved byte-identically (summary/notes/adherence intact)`
      )
    : bad('daily_logs mutated', JSON.stringify(dailyAfter));
  const dl5Count = db
    .prepare("SELECT count(*) c FROM log_entries WHERE daily_log_id = 'dl-5'")
    .get().c;
  const dl5Alive = db.prepare("SELECT count(*) c FROM daily_logs WHERE id = 'dl-5'").get().c;
  // dl-5 held one fabricated row plus three disqualified seed rows.
  dl5Alive === 1
    ? ok('a daily_log emptied of fabricated rows is NOT deleted')
    : bad('dl-5 deleted');
  dl5Count === 3
    ? ok('dl-5 kept its 3 disqualified rows')
    : bad('dl-5 entry count', String(dl5Count));

  // (f) the protocol row is untouched (no cascade out of log_entries)
  const protoAlive = db.prepare("SELECT count(*) c FROM protocols WHERE id = 'p-morning'").get().c;
  protoAlive === 1 ? ok('protocols row untouched (no cascade)') : bad('protocol deleted');

  db.close();
}

console.log('6. 0029 is a no-op on a database with no seed rows');
{
  const db = new DatabaseSync(':memory:');
  stageAt(db, PURGE_VERSION - 1);
  db.exec(`
    INSERT INTO daily_logs (id, date, summary) VALUES ('n-1', '2026-07-10', 'clean day');
    INSERT INTO log_entries (id, daily_log_id, type, status, value, title) VALUES
      ('n-a', 'n-1', 'note',  'completed', '{"adhoc":true}', 'a real note'),
      ('n-b', 'n-1', 'habit', 'pending',   '{"generated":true,"protocol":"Morning"}', 'a real plan row'),
      ('n-c', 'n-1', 'habit', 'completed', NULL, 'a hand-added row');
  `);
  const before = snapshotEntries(db);
  const dailyBefore = snapshotDailyLogs(db);

  migrate(executor(db), MIGRATIONS);

  const after = snapshotEntries(db);
  JSON.stringify(before) === JSON.stringify(after)
    ? ok(
        `no-op: all ${after.length} rows byte-identical (${titlesOf(after).length} titles unchanged)`
      )
    : bad('no-op run changed rows', JSON.stringify(after));
  JSON.stringify(dailyBefore) === JSON.stringify(snapshotDailyLogs(db))
    ? ok('no-op: daily_logs unchanged')
    : bad('no-op run changed daily_logs');
  db.prepare('PRAGMA user_version').get().user_version >= PURGE_VERSION
    ? ok(`user_version advanced to >= ${PURGE_VERSION} anyway (forward-only; floor)`)
    : bad('user_version after no-op');
  db.close();
}

console.log('7. 0029 never runs twice (a re-purge cannot touch new rows)');
{
  const db = new DatabaseSync(':memory:');
  stageAt(db, PURGE_VERSION - 1);
  db.exec(`INSERT INTO daily_logs (id, date) VALUES ('r-1', '2026-07-11');`);
  db.exec(
    `INSERT INTO log_entries (id, daily_log_id, type, status, value, title)
     VALUES ('r-old', 'r-1', 'habit', 'pending', '{"seed":true}', 'fabricated');`
  );
  migrate(executor(db), MIGRATIONS);
  const purged = db.prepare("SELECT count(*) c FROM log_entries WHERE id = 'r-old'").get().c;
  purged === 0 ? ok('first run purges the fabricated row') : bad('first run did not purge');

  // A test fixture may legitimately plant seed rows AFTER the migration has run
  // (ensureTodaySeeded's fallbackMission still supports the marking). Re-running
  // the runner must not reach back and delete them.
  db.exec(
    `INSERT INTO log_entries (id, daily_log_id, type, status, value, title)
     VALUES ('r-new', 'r-1', 'habit', 'pending', '{"seed":true}', 'planted after 0029');`
  );
  const second = migrate(executor(db), MIGRATIONS);
  const kept = db.prepare("SELECT count(*) c FROM log_entries WHERE id = 'r-new'").get().c;
  second.applied.length === 0 && kept === 1
    ? ok('second run applies nothing; a post-migration seed row is left alone')
    : bad('0029 re-ran', `applied=${JSON.stringify(second.applied)} kept=${kept}`);
  db.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
