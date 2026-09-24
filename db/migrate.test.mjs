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
  // Staged one below 0029, so 0029 runs — and so does everything above it.
  // Asserting "exactly one applied" pinned this to 0029 being the newest
  // migration in the repo forever, which it stopped being the moment the next
  // one landed. What matters is that the PURGE ran; the row-level assertions
  // below are what prove it deleted the right things.
  result.applied[0] === '0029_purge_seed_mission'
    ? ok(`0029_purge_seed_mission applied first (with ${result.applied.length - 1} above it)`)
    : bad('0029 did not run', JSON.stringify(result.applied));

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
  // LATEST, not PURGE_VERSION: a no-op purge must still leave the database at
  // the head of the migration list, or every later migration re-runs forever.
  db.prepare('PRAGMA user_version').get().user_version === LATEST
    ? ok(`user_version advanced to ${LATEST} anyway (forward-only)`)
    : bad('user_version after no-op', String(db.prepare('PRAGMA user_version').get().user_version));
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

// ===========================================================================
// 8. 0047 — `ml`, on a database that already has foods and items in it.
//
// The fixture is POPULATED BEFORE the migration runs, and that is the whole
// point. 0034's header records the trap: SQLite validates a CROSS-column CHECK
// on ADD COLUMN against existing rows, so a constraint can pass on an empty
// test fixture and reject the whole ALTER on the owner's actual phone. 0047
// also RENAMES three columns, one of which is referenced by a table-level CHECK
// on `foods` — another thing that is indistinguishable from working until it
// runs against real rows.
//
// So: stage at 0045 — everything through 0045, the state a device sat in before
// 0046 (exercise measures) and 0047 both landed on 2026-09-14 — write the rows a phone
// would have, migrate forward, and read the result back.
// ===========================================================================
console.log('8. 0047 renames the portion columns and backfills every row to `g`');
{
  const db = new DatabaseSync(':memory:');
  stageAt(db, 45);

  const before = db.prepare('PRAGMA user_version').get().user_version;
  before === 45
    ? ok('staged at 45 — the state a device sits in before this migration')
    : bad('stage version', String(before));

  // The rows a real device carries: a catalog food with a named serving, a meal
  // with an item that points at it, and a saved template item.
  db.exec(`
    INSERT INTO foods (id, name, name_norm, serving_name, serving_grams, kcal_100g)
      VALUES ('f-milk', 'Milk', 'milk', '1 cup', 244, 42);
    INSERT INTO meals (id, date, name) VALUES ('m-1', '2026-09-14', 'Breakfast');
    INSERT INTO meal_items (id, meal_id, food_id, name, grams, kcal)
      VALUES ('i-1', 'm-1', 'f-milk', 'Milk', 244, 102);
    INSERT INTO meal_templates (id, name, name_norm) VALUES ('t-1', 'Shake', 'shake');
    INSERT INTO meal_template_items (id, template_id, name, grams)
      VALUES ('ti-1', 't-1', 'Milk', 244);
  `);

  const result = migrate(executor(db), MIGRATIONS);
  result.applied.includes('0047_ml_unit')
    ? ok('0047 applied on a populated database (the ADD COLUMNs did not reject the rows)')
    : bad('0047 not applied', JSON.stringify(result.applied));

  const food = db.prepare("SELECT * FROM foods WHERE id = 'f-milk'").get();
  food.serving_amount === 244 && !('serving_grams' in food)
    ? ok('foods.serving_grams is now serving_amount, carrying its value')
    : bad('food rename', JSON.stringify(food));
  food.basis === 'g'
    ? ok('and the food backfills to `g` — nothing was ever ml, so that is history, not a guess')
    : bad('food basis', String(food.basis));

  const item = db.prepare("SELECT * FROM meal_items WHERE id = 'i-1'").get();
  item.amount === 244 && item.unit === 'g' && !('grams' in item)
    ? ok('meal_items.grams is now amount, at `g`, with the logged number intact')
    : bad('item rename', JSON.stringify(item));

  const tItem = db.prepare("SELECT * FROM meal_template_items WHERE id = 'ti-1'").get();
  tItem.amount === 244 && tItem.unit === 'g'
    ? ok('and so does a saved template item')
    : bad('template rename', JSON.stringify(tItem));

  // The table-level CHECK on `foods` referenced the old column name. SQLite
  // rewrites it on RENAME COLUMN — but only if it can parse it, so prove the
  // rewritten constraint still BITES rather than merely still existing.
  let paired = false;
  try {
    db.exec(
      "INSERT INTO foods (id, name, name_norm, serving_name) VALUES ('f-x', 'X', 'x', '1 cup')"
    );
  } catch {
    paired = true;
  }
  paired
    ? ok('the serving pair-or-none CHECK survived the rename and still rejects a half-pair')
    : bad('pair CHECK lost in rename');

  // The new vocabulary is closed. `oz` is the unit this design deliberately does
  // NOT have (it is a display preference, never a stored unit), so it is the
  // honest thing to try.
  let rejected = false;
  try {
    db.exec(
      "INSERT INTO meal_items (id, meal_id, name, amount, unit) VALUES ('i-x', 'm-1', 'X', 1, 'oz')"
    );
  } catch {
    rejected = true;
  }
  rejected
    ? ok('`oz` is refused — the stored vocabulary is exactly g and ml')
    : bad('oz accepted as a unit');

  db.exec(
    "INSERT INTO meal_items (id, meal_id, name, amount, unit) VALUES ('i-ml', 'm-1', 'Juice', 250, 'ml')"
  );
  db.prepare("SELECT unit FROM meal_items WHERE id = 'i-ml'").get().unit === 'ml'
    ? ok('and `ml` is accepted — the point of the whole migration')
    : bad('ml refused');

  db.close();
}

// ===========================================================================
// 9. 0059 — `piece_name`, on a database that already has meals in it.
//
// The column is nullable and takes no CHECK, so the ALTER cannot reject a
// populated table (0034's trap) — but "cannot" is worth proving rather than
// reasoning about, because that is exactly what 0034 records someone reasoning
// wrongly. The other half of this section is the NEGATIVE: the live serving
// join is untouched, so a catalog item logged at `2 × '1 egg'` still reads that
// way afterwards. `piece_name` is a SECOND vocabulary beside that one, not a
// replacement for it.
// ===========================================================================
console.log('9. 0059 adds the piece noun without touching a single existing row');
{
  const db = new DatabaseSync(':memory:');
  stageAt(db, 58);
  db.prepare('PRAGMA user_version').get().user_version === 58
    ? ok('staged at 58 — the state a device sits in before this migration')
    : bad('stage version');

  // The rows a real device carries: a catalog food with a named serving, an
  // item counting it, a composite header with its parts, and a plain item.
  db.exec(`
    INSERT INTO foods (id, name, name_norm, serving_name, serving_amount, kcal_100g)
      VALUES ('f-egg', 'Egg', 'egg', '1 egg', 50, 143);
    INSERT INTO meals (id, date, name) VALUES ('m-1', '2026-09-19', 'Dinner');
    INSERT INTO meal_items (id, meal_id, food_id, name, amount, unit, serving_qty, kcal)
      VALUES ('i-egg', 'm-1', 'f-egg', 'Egg', 100, 'g', 2, 143);
    INSERT INTO meal_items (id, meal_id, name, unit, is_composite)
      VALUES ('i-pizza', 'm-1', 'Pepperoni pizza', 'g', 1);
    INSERT INTO meal_items (id, meal_id, name, amount, unit, kcal, parent_item_id)
      VALUES ('i-crust', 'm-1', 'Pizza crust', 300, 'g', 800, 'i-pizza');
    INSERT INTO meal_items (id, meal_id, name, amount, unit, kcal)
      VALUES ('i-beer', 'm-1', 'Lager', 330, 'ml', 140);
  `);

  const result = migrate(executor(db), MIGRATIONS);
  result.applied.includes('0059_meal_item_piece_name')
    ? ok('0059 applied on a populated database (a nullable ADD COLUMN cannot reject rows)')
    : bad('0059 not applied', JSON.stringify(result.applied));
  // The stamp is the HEAD, not 0059's own number: this section stages at 58 and
  // then runs the whole remaining chain, so every migration authored after 0059
  // rides along and the runner stamps the last of them. Asserting the literal 59
  // would have been asserting "0059 is the head", which is a fact about the week
  // it was written and not about what this section is testing.
  db.prepare('PRAGMA user_version').get().user_version === LATEST
    ? ok(`and the runner stamps user_version = ${LATEST}`)
    : bad('user_version', String(db.prepare('PRAGMA user_version').get().user_version));

  const staged = db.prepare('SELECT id, piece_name FROM meal_items ORDER BY id').all();
  staged.length === 4 && staged.every((r) => r.piece_name === null)
    ? ok('piece_name is NULL on every row that already existed — no backfill, no guess')
    : bad('staged rows', JSON.stringify(staged));

  // A header takes the pair. This is the whole point of the column, and it is
  // 0058's invariant 2 one clause wider: a count is a fact about the WHOLE, and
  // nothing sums it.
  db.exec("UPDATE meal_items SET serving_qty = 8, piece_name = 'slice' WHERE id = 'i-pizza'");
  const header = db.prepare("SELECT * FROM meal_items WHERE id = 'i-pizza'").get();
  header.serving_qty === 8 && header.piece_name === 'slice' && header.kcal === null
    ? ok('a composite header carries a count and its noun, and still no number that sums')
    : bad('header pair', JSON.stringify(header));

  // THE NEGATIVE. The live join is what names a CATALOG item's count, and this
  // migration does not touch it: correcting a serving name still reaches rows
  // already logged, which is the behaviour the rejected snapshot would have
  // ended.
  const egg = db
    .prepare(
      `SELECT mi.serving_qty, mi.piece_name, f.serving_name AS food_serving_name
       FROM meal_items mi LEFT JOIN foods f ON f.id = mi.food_id WHERE mi.id = 'i-egg'`
    )
    .get();
  egg.serving_qty === 2 && egg.piece_name === null && egg.food_serving_name === '1 egg'
    ? ok('…while a catalog item still gets its noun from the live join, untouched')
    : bad('egg join', JSON.stringify(egg));

  db.close();
}

// ===========================================================================
// 10. 0060 — the arrival zone's seasonal pair, on a database that already
//     recorded zone changes under 0053.
//
// The two columns are nullable and take a NULL-tolerant CHECK, so the ALTER
// cannot reject a populated table — and the POSITIVE half matters more than
// that: a 0053 row must come out of the migration with a NULL pair rather than
// a plausible-looking default, because the probe it would be claiming was never
// taken. A default here would be a fabricated observation, and the trip
// derivation would close trips on it.
// ===========================================================================
console.log('10. 0060 adds the seasonal pair and leaves every 0053 row unable to answer');
{
  const db = new DatabaseSync(':memory:');
  stageAt(db, 59);
  db.prepare('PRAGMA user_version').get().user_version === 59
    ? ok('staged at 59 — the state a device sits in before this migration')
    : bad('stage version');

  // Two rows of the kind 0053 wrote: an outbound leg and the return.
  db.exec(`
    INSERT INTO timezone_changes
      (id, changed_at, from_offset_min, to_offset_min, from_local_date, to_local_date)
    VALUES
      ('tz-out', '2026-09-12T20:00:00.000Z', -480, 60, '2026-09-12', '2026-09-12'),
      ('tz-back', '2026-09-21T18:00:00.000Z', 60, -480, '2026-09-21', '2026-09-21');
  `);

  const result = migrate(executor(db), MIGRATIONS);
  result.applied.includes('0060_timezone_zone_pair')
    ? ok('0060 applied on a populated timezone_changes')
    : bad('0060 not applied', JSON.stringify(result.applied));

  const rows = db.prepare('SELECT * FROM timezone_changes ORDER BY id').all();
  rows.length === 2 &&
  rows.every((r) => r.zone_jan_offset_min === null && r.zone_jul_offset_min === null)
    ? ok('every pre-existing row carries a NULL pair — no backfill, no invented probe')
    : bad('pair backfilled', JSON.stringify(rows));
  rows.every((r) => r.from_offset_min !== null && r.to_offset_min !== null)
    ? ok('…and the 0053 columns are byte-identical beside them')
    : bad('0053 columns disturbed', JSON.stringify(rows));

  // The CHECK is NULL-tolerant by construction, so both a real pair and an
  // explicit NULL must land, and an impossible offset must not.
  db.exec(
    `INSERT INTO timezone_changes
       (id, changed_at, from_offset_min, to_offset_min, from_local_date, to_local_date,
        zone_jan_offset_min, zone_jul_offset_min)
     VALUES ('tz-pair', '2026-10-01T09:00:00.000Z', -480, 60, '2026-10-01', '2026-10-01', 0, 60)`
  );
  let refused = false;
  try {
    db.exec(
      `INSERT INTO timezone_changes
         (id, changed_at, from_offset_min, to_offset_min, from_local_date, to_local_date,
          zone_jan_offset_min, zone_jul_offset_min)
       VALUES ('tz-bad', '2026-10-02T09:00:00.000Z', -480, 60, '2026-10-02', '2026-10-02', 0, 900)`
    );
  } catch {
    refused = true;
  }
  const paired = db.prepare(`SELECT * FROM timezone_changes WHERE id = 'tz-pair'`).get();
  paired.zone_jan_offset_min === 0 && paired.zone_jul_offset_min === 60 && refused
    ? ok('a real pair lands, and ±841 is refused')
    : bad('pair CHECK', JSON.stringify({ paired, refused }));

  db.close();
}

// ===========================================================================
// 11. THE OWNER'S ACTUAL DEVICE STAMP: 44, WITH HIS DATA IN IT, TO HEAD.
//
// Every section above stages at a number chosen to sit one below the migration
// it is testing — 28, 45, 58, 59. **None of them is 44**, and 44 is the only
// number that exists on hardware: it is what the installed TestFlight build
// stamped, and nothing has been built since, so the first launch of the next
// build runs 0045 → head in one go over a database holding a year of the
// owner's life. That is the upgrade this project actually has to survive, and
// until this section existed nothing tested it.
//
// Two things make it different in kind from the sections above:
//
//  1. **It is populated across the whole schema**, not just the table under
//     test. 0034's header records the trap — SQLite validates a cross-column
//     CHECK on ADD COLUMN against existing rows — and the migrations between 44
//     and head include ADD COLUMNs with CHECKs, three column RENAMEs, several
//     backfill UPDATEs and one INSERT. Any of those can pass on an empty
//     fixture and reject, or quietly mangle, a real one.
//
//  2. **It asks SQLite whether the result is SOUND.** No section above ever
//     ran `PRAGMA foreign_key_check` or `PRAGMA integrity_check`, so nothing in
//     this file proved an upgrade leaves the database usable — only that the
//     rows it thought to look at were where it left them. A rename that
//     orphaned a child row, or an index left disagreeing with its table, would
//     have passed every assertion in this file.
//
// The comparison is column-by-column against a pre-upgrade snapshot, and the
// three legitimate side effects are asserted **as intended, not tolerated as
// loss**: `exercises.updated_at` and `workouts.updated_at` move because the
// 0046/0054/0056 backfills are UPDATEs and fire the AFTER UPDATE triggers, and
// `day_modes` gains exactly one row — 0061's `modes-retired`, which is the
// whole reason that migration writes a row at all (the owner's modes were
// stored open-ended and the picker is gone, so nothing else could ever end
// them). Anything else that moved is a defect. Since 0063, one more is
// intended and asserted per ROW: five seed foods gain `caffeine_mg` (and their
// `updated_at` stamp); the other foods are held byte-identical as before.
// ===========================================================================
console.log("11. A device at 44 — the owner's real stamp — upgrades to head with its data intact");
{
  const db = new DatabaseSync(':memory:');
  const staged = stageAt(db, 44);
  staged === 44
    ? ok('staged at 44 — the user_version the installed TestFlight build left behind')
    : bad('stage at 44', String(staged));

  // Raw SQL, never the repositories: the point is to test the migrations
  // against rows as SQLite holds them, not against a repository's idea of a
  // row — the same reason section 5's fixture is hand-written.
  const T = (n) => `2026-09-0${n}T08:00:00.000Z`;
  db.exec(`
    INSERT INTO users (id, email, full_name, date_of_birth, biological_sex, timezone, preferences, created_at, updated_at)
      VALUES ('u-1','matt@example.com','Matt','1985-04-12','male','America/Los_Angeles','{"dayStartsAt":"04:00"}','${T(1)}','${T(1)}');

    INSERT INTO protocols (id, slug, name, description, type, is_active, current_version_id, started_on, created_at, updated_at)
      VALUES ('p-1','morning-stack','Morning Stack','AM supplements','supplement_stack',1,NULL,'2026-08-01','${T(1)}','${T(1)}');
    -- BOTH content schemas, because parseProtocolContent must normalise v1
    -- forever and protocol_versions is immutable: a migration that touched
    -- either shape would be rewriting a version the user already approved.
    INSERT INTO protocol_versions (id, protocol_id, version_number, content, change_notes, created_by, created_at)
      VALUES ('pv-1','p-1',1,'{"schema":2,"phases":[{"name":"Base","durationDays":28,"items":[{"id":"it-1","title":"Creatine 5g","cadence":{"kind":"daily"}}]}]}','initial','user','${T(1)}');
    INSERT INTO protocol_versions (id, protocol_id, version_number, content, change_notes, created_by, created_at)
      VALUES ('pv-2','p-1',2,'{"items":[{"title":"legacy v1 item"}]}','v1 legacy shape kept immutable','user','${T(2)}');
    UPDATE protocols SET current_version_id = 'pv-1' WHERE id = 'p-1';

    INSERT INTO daily_logs (id, date, summary, overall_adherence_score, notes, created_at, updated_at)
      VALUES ('dl-1','2026-09-01','good day',88.5,NULL,'${T(1)}','${T(1)}'),
             ('dl-2','2026-09-02',NULL,NULL,'travel','${T(2)}','${T(2)}');

    INSERT INTO log_entries (id, daily_log_id, type, protocol_id, title, status, scheduled_time, completed_at, value, source, notes, created_at, updated_at)
      VALUES ('le-1','dl-1','supplement','p-1','Creatine 5g','completed','07:00','${T(1)}','{"dose":5}','manual',NULL,'${T(1)}','${T(1)}'),
             ('le-2','dl-1','workout',NULL,'Upper A','completed','17:30','${T(1)}',NULL,'manual',NULL,'${T(1)}','${T(1)}'),
             ('le-3','dl-2','habit','p-1','Sunlight 10m','pending','06:30',NULL,NULL,'manual',NULL,'${T(2)}','${T(2)}'),
             ('le-4','dl-2','note',NULL,'Slept badly','skipped',NULL,NULL,NULL,'manual','red-eye','${T(2)}','${T(2)}');

    INSERT INTO foods (id, name, name_norm, brand, serving_name, serving_grams, kcal_100g, protein_g_100g, carbs_g_100g, fat_g_100g, source, created_at, updated_at)
      VALUES ('f-1','Whole Milk','whole milk','Straus','1 cup',244,61,3.2,4.8,3.3,'user','${T(1)}','${T(1)}');

    INSERT INTO meals (id, date, time, name, kcal, protein_g, carbs_g, fat_g, source, notes, created_at, updated_at)
      VALUES ('m-1','2026-09-01','08:15','Breakfast',620,44,55,22,'manual',NULL,'${T(1)}','${T(1)}'),
             ('m-2','2026-09-02','13:00','Lunch',780,52,70,28,'manual',NULL,'${T(2)}','${T(2)}');

    INSERT INTO meal_items (id, meal_id, food_id, name, grams, serving_qty, kcal, protein_g, carbs_g, fat_g, fiber_g, confidence, micros, created_at, updated_at)
      VALUES ('mi-1','m-1','f-1','Whole Milk',244,1,149,7.8,11.7,8,0,'high','{"calcium_mg":276}','${T(1)}','${T(1)}'),
             ('mi-2','m-1',NULL,'Eggs, 3 large',150,NULL,215,19,1.1,14.3,0,'medium',NULL,'${T(1)}','${T(1)}'),
             ('mi-3','m-2',NULL,'Chicken breast',300,NULL,495,93,0,11,0,NULL,NULL,'${T(2)}','${T(2)}');

    INSERT INTO exercises (id, name, aliases, equipment, movement_pattern, mechanic, logging_type, unilateral, is_custom, archived, created_at, updated_at)
      VALUES ('ex-custom','Matt Row Variant',NULL,'dumbbell','pull_h','compound','weight_reps',1,1,0,'${T(1)}','${T(1)}');

    INSERT INTO workouts (id, date, name, kind, duration_min, notes, routine_id, created_at, updated_at)
      VALUES ('w-1','2026-09-01','Upper A','strength',62,NULL,NULL,'${T(1)}','${T(1)}'),
             ('w-2','2026-09-02','Zone 2','cardio',45,'treadmill',NULL,'${T(2)}','${T(2)}');

    INSERT INTO workout_sets (id, workout_id, exercise, exercise_id, set_index, reps, weight_kg, set_type, rpe, duration_sec, superset_group, created_at, updated_at)
      VALUES ('ws-1','w-1','Bench Press',NULL,0,8,80,'normal',8,NULL,NULL,'${T(1)}','${T(1)}'),
             ('ws-2','w-1','Bench Press',NULL,1,8,80,'normal',9,NULL,NULL,'${T(1)}','${T(1)}'),
             ('ws-3','w-1','Matt Row Variant','ex-custom',0,10,32.5,'normal',7,NULL,1,'${T(1)}','${T(1)}'),
             ('ws-4','w-2','Treadmill',NULL,0,NULL,NULL,'normal',NULL,2700,NULL,'${T(2)}','${T(2)}');

    INSERT INTO wearable_data (id, date, metric_type, value, unit, source_device, source_raw_id, start_time, end_time, metadata, created_at, updated_at)
      VALUES ('wd-1','2026-09-01','hrv',62,'ms','apple_watch',NULL,NULL,NULL,'{}','${T(1)}','${T(1)}'),
             ('wd-2','2026-09-01','rhr',48,'bpm','apple_watch',NULL,NULL,NULL,'{}','${T(1)}','${T(1)}'),
             ('wd-3','2026-09-01','steps',11342,'count','apple_health',NULL,NULL,NULL,'{}','${T(1)}','${T(1)}'),
             ('wd-4','2026-09-02','sleep_duration',411,'min','apple_watch',NULL,'2026-09-01T23:10:00.000Z','2026-09-02T06:01:00.000Z','{}','${T(2)}','${T(2)}'),
             ('wd-5','2026-09-02','steps',7781,'count','apple_health',NULL,NULL,NULL,'{}','${T(2)}','${T(2)}');

    INSERT INTO body_metrics (id, measured_at, weight_kg, body_fat_pct, muscle_mass_kg, bone_mass_kg, visceral_fat_rating, waist_cm, hip_cm, source, notes, created_at, updated_at)
      VALUES ('bm-1','2026-09-01T06:30:00.000Z',82.4,14.2,38.1,3.2,6,84,98,'manual',NULL,'${T(1)}','${T(1)}'),
             ('bm-2','2026-09-02T06:28:00.000Z',82.1,14.1,38.2,3.2,6,83.5,98,'manual',NULL,'${T(2)}','${T(2)}');

    -- An OPEN-ENDED day mode: the exact state 0061's header says the owner's
    -- build leaves behind, and the reason that migration writes a row at all.
    INSERT INTO day_modes (id, mode, start_date, end_date, label, note, created_at, updated_at)
      VALUES ('dm-1','travel','2026-08-20',NULL,'Tokyo','red-eye','${T(1)}','${T(1)}');
  `);

  const DATA_TABLES = [
    'users',
    'protocols',
    'protocol_versions',
    'daily_logs',
    'log_entries',
    'foods',
    'meals',
    'meal_items',
    'exercises',
    'workouts',
    'workout_sets',
    'wearable_data',
    'body_metrics',
    'day_modes',
  ];
  const colsOf = (t) =>
    db
      .prepare(`PRAGMA table_info(${t})`)
      .all()
      .map((c) => c.name);
  const before = {};
  const beforeCols = {};
  for (const t of DATA_TABLES) {
    beforeCols[t] = colsOf(t);
    before[t] = db.prepare(`SELECT ${beforeCols[t].join(',')} FROM ${t} ORDER BY id`).all();
  }
  // The 31 rows written by hand above. They are NOT the whole snapshot: the
  // migrations themselves seed the food and exercise catalogs, so `before`
  // also holds ~256 shipped rows — which is a bonus, not noise. The
  // byte-identity comparison below therefore covers the entire catalog as the
  // device carries it, and that is where 0046's `measures` and 0056's `source`
  // backfills actually do their work (the one custom exercise is the exception
  // they have to leave alone).
  const MINE = {
    users: ['u-1'],
    protocols: ['p-1'],
    protocol_versions: ['pv-1', 'pv-2'],
    daily_logs: ['dl-1', 'dl-2'],
    log_entries: ['le-1', 'le-2', 'le-3', 'le-4'],
    foods: ['f-1'],
    meals: ['m-1', 'm-2'],
    meal_items: ['mi-1', 'mi-2', 'mi-3'],
    exercises: ['ex-custom'],
    workouts: ['w-1', 'w-2'],
    workout_sets: ['ws-1', 'ws-2', 'ws-3', 'ws-4'],
    wearable_data: ['wd-1', 'wd-2', 'wd-3', 'wd-4', 'wd-5'],
    body_metrics: ['bm-1', 'bm-2'],
    day_modes: ['dm-1'],
  };
  const mineCount = Object.values(MINE).reduce((n, ids) => n + ids.length, 0);
  const total = DATA_TABLES.reduce((n, t) => n + before[t].length, 0);
  const absent = Object.entries(MINE).flatMap(([t, ids]) =>
    ids.filter((id) => !before[t].some((r) => r.id === id)).map((id) => `${t}.${id}`)
  );
  absent.length === 0
    ? ok(
        `fixture staged: ${mineCount} hand-written rows over the ${total - mineCount} the migrations seed — ${total} rows across ${DATA_TABLES.length} tables, all of them compared below`
      )
    : bad('fixture insert', absent.join(', '));

  // The applied set is DERIVED from pendingMigrations rather than written out,
  // for section 9's reason one step further on: the owner's device stays at 44
  // until he builds, so the number of migrations this upgrade carries grows
  // every time one lands. A literal would be a fact about the week it was
  // written. What is invariant is that the runner applies exactly the pending
  // set, ascending, and stops at the head.
  const expectedPending = pendingMigrations(44, MIGRATIONS).map((m) => m.name);
  const result = migrate(executor(db), MIGRATIONS);
  JSON.stringify(result.applied) === JSON.stringify(expectedPending)
    ? ok(
        `applied exactly the ${expectedPending.length} pending migrations, ascending: ${result.applied.join(', ')}`
      )
    : bad('applied set', JSON.stringify(result.applied));
  result.from === 44 ? ok('from = 44') : bad('from', String(result.from));
  const landed = db.prepare('PRAGMA user_version').get().user_version;
  landed === LATEST
    ? ok(`lands on user_version = ${landed} (head)`)
    : bad('final user_version', String(landed));

  // --- (a) the structure those migrations promise --------------------------
  const tableExists = (t) =>
    db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name=?").get(t).c === 1;
  const newTables = [
    'workout_drafts',
    'timezone_changes',
    'workout_ingest_links',
    'pending_estimates',
    'day_statuses',
  ];
  const missingTables = newTables.filter((t) => !tableExists(t));
  missingTables.length === 0
    ? ok(`the ${newTables.length} new tables exist: ${newTables.join(', ')}`)
    : bad('new tables missing', missingTables.join(', '));

  const EXPECT_COLS = {
    exercises: ['measures', 'source'],
    workout_sets: ['distance_m'],
    foods: ['serving_amount', 'basis'],
    meal_items: ['amount', 'unit', 'parent_item_id', 'is_composite', 'piece_name'],
    meal_template_items: ['amount', 'unit'],
    protocols: ['carry_over', 'checkoff_mode'],
    workouts: ['started_at', 'away'],
    timezone_changes: ['zone_jan_offset_min', 'zone_jul_offset_min'],
  };
  const missingCols = Object.entries(EXPECT_COLS).flatMap(([t, cols]) =>
    cols.filter((c) => !colsOf(t).includes(c)).map((c) => `${t}.${c}`)
  );
  missingCols.length === 0
    ? ok('every new column exists across the 8 altered tables')
    : bad('columns missing', missingCols.join(', '));
  const stillThere = Object.entries({
    foods: 'serving_grams',
    meal_items: 'grams',
    meal_template_items: 'grams',
  }).filter(([t, gone]) => colsOf(t).includes(gone));
  stillThere.length === 0
    ? ok('the three renamed-away columns are gone (foods/meal_items/meal_template_items)')
    : bad('rename incomplete', stillThere.map(([t, c]) => `${t}.${c}`).join(', '));
  const tablesNow = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name)
  );
  const droppedTables = DATA_TABLES.filter((t) => !tablesNow.has(t));
  droppedTables.length === 0
    ? ok('no table the device had was dropped')
    : bad('dropped tables', droppedTables.join(', '));

  // --- (b) every pre-existing row, column by column ------------------------
  const RENAMED = { foods: { serving_grams: 'serving_amount' }, meal_items: { grams: 'amount' } };
  // The ONLY columns allowed to move, and only on these tables: 0046 (measures)
  // and 0056 (source) UPDATE `exercises`, 0054 UPDATEs `workouts`, and each
  // fires that table's AFTER UPDATE trigger. Intended — and asserted as such
  // below rather than merely excused here.
  const TRIGGER_TOUCHED = { exercises: ['updated_at'], workouts: ['updated_at'] };
  // day_modes legitimately GAINS exactly one row: 0061's retirement reset.
  const EXPECT_NEW_ROWS = { day_modes: ['modes-retired'] };
  // 0063 is a catalog update: it adds `caffeine_mg` to FIVE seed foods, by id,
  // and the UPDATE fires the AFTER UPDATE trigger on those five. Allowed per ROW
  // rather than per table, so every other food — the other 182 seed rows and the
  // owner's own 'f-1' — is still held byte-identical; asserted in (d).
  const SEED_CAFFEINE = {
    'a1cef987-d928-48db-a726-e9b98b742263': 40,
    'bb7b36af-e57e-44fd-9062-37a158612e02': 37.4,
    'c458157a-1d0c-42b4-833c-d36cc8ef994c': 8,
    '8ec296da-6053-4ccd-8fbb-a94fedc0ef08': 80,
    '0cf7bd11-58bb-4105-a346-f095009e613e': 20,
  };
  const ROW_TOUCHED = {
    foods: { ids: Object.keys(SEED_CAFFEINE), cols: ['micros', 'updated_at'] },
  };

  for (const t of DATA_TABLES) {
    const map = RENAMED[t] || {};
    const select = beforeCols[t].map((c) => (map[c] ? `${map[c]} AS ${c}` : c)).join(',');
    const added = EXPECT_NEW_ROWS[t] || [];
    const rowsNow = db
      .prepare(`SELECT ${select} FROM ${t} ORDER BY id`)
      .all()
      .filter((r) => !added.includes(r.id));
    const prev = before[t];
    if (rowsNow.length !== prev.length) {
      bad(`${t} row count`, `${prev.length} -> ${rowsNow.length} (rows lost or duplicated)`);
      continue;
    }
    const allowed = TRIGGER_TOUCHED[t] || [];
    const rowAllowed = ROW_TOUCHED[t];
    const diffs = [];
    const touched = new Set();
    for (let i = 0; i < prev.length; i++) {
      for (const c of beforeCols[t]) {
        if (JSON.stringify(prev[i][c]) === JSON.stringify(rowsNow[i][c])) continue;
        if (allowed.includes(c)) {
          touched.add(c);
          continue;
        }
        if (rowAllowed && rowAllowed.ids.includes(prev[i].id) && rowAllowed.cols.includes(c)) {
          touched.add(`${c} on ${rowAllowed.ids.length} seed rows (0063)`);
          continue;
        }
        diffs.push(
          `${prev[i].id}.${c}: ${JSON.stringify(prev[i][c])} -> ${JSON.stringify(rowsNow[i][c])}`
        );
      }
    }
    const note = touched.size
      ? ` (only ${[...touched].join('/')} moved — AFTER UPDATE trigger)`
      : '';
    const gained = added.length ? ` + ${added.length} row the migration adds` : '';
    diffs.length === 0
      ? ok(`${t}: ${prev.length} row(s) survived, every value byte-identical${note}${gained}`)
      : bad(`${t}: ${diffs.length} value(s) changed UNEXPECTEDLY`, diffs.join(' | '));
  }

  // --- (c) the three side effects, asserted as INTENDED --------------------
  const bumped = Object.entries({ exercises: ['ex-custom'], workouts: ['w-1', 'w-2'] }).every(
    ([t, ids]) =>
      ids.every(
        (id) =>
          before[t].find((r) => r.id === id).updated_at !==
          db.prepare(`SELECT updated_at FROM ${t} WHERE id = ?`).get(id).updated_at
      )
  );
  bumped
    ? ok('exercises.updated_at and workouts.updated_at DID move — the 0046/0054/0056 backfills')
    : bad(
        'a backfill UPDATE did not fire',
        'expected the AFTER UPDATE trigger to stamp these rows'
      );
  const alsoMoved = [
    'log_entries',
    'meals',
    'meal_items',
    'body_metrics',
    'wearable_data',
    'protocols',
    'users',
  ].filter(
    (t) =>
      JSON.stringify(before[t].map((r) => r.updated_at)) !==
      JSON.stringify(
        db
          .prepare(`SELECT updated_at FROM ${t} ORDER BY id`)
          .all()
          .map((r) => r.updated_at)
      )
  );
  alsoMoved.length === 0
    ? ok('…and updated_at moved NOWHERE else — no migration above 44 rewrites those 7 tables')
    : bad('updated_at moved unexpectedly', alsoMoved.join(', '));

  // --- (d) the documented backfills ----------------------------------------
  const mi = db
    .prepare(
      'SELECT id, amount, unit, is_composite, piece_name, parent_item_id FROM meal_items ORDER BY id'
    )
    .all();
  mi.every((r) => r.unit === 'g')
    ? ok(`0047: meal_items.unit backfilled to 'g' on all ${mi.length} rows`)
    : bad('unit backfill', JSON.stringify(mi));
  mi.every((r) => r.is_composite === 0 && r.piece_name === null && r.parent_item_id === null)
    ? ok(
        '0058/0059: the new meal_item columns default clean — no composite invented, no noun guessed'
      )
    : bad('new meal_item defaults', JSON.stringify(mi));
  const f = db.prepare("SELECT serving_amount, basis FROM foods WHERE id = 'f-1'").get();
  f.serving_amount === 244 && f.basis === 'g'
    ? ok("0047: foods.serving_amount = 244 carried through the rename, basis backfilled to 'g'")
    : bad('food backfill', JSON.stringify(f));
  // 0063: each of the five gained exactly its caffeine and kept every key it had.
  const filledWrong = Object.entries(SEED_CAFFEINE).filter(([id, mg]) => {
    const was = before.foods.find((r) => r.id === id);
    const now = db.prepare('SELECT micros FROM foods WHERE id = ?').get(id);
    const expected = { ...(was.micros ? JSON.parse(was.micros) : {}), caffeine_mg: mg };
    return JSON.stringify(JSON.parse(now.micros)) !== JSON.stringify(expected);
  });
  filledWrong.length === 0
    ? ok('0063: the five seed foods gained their caffeine, every other micro key kept')
    : bad('0063 fill', filledWrong.map(([id]) => id).join(', '));
  const ex = db.prepare("SELECT measures, source FROM exercises WHERE id = 'ex-custom'").get();
  ex.measures === 'reps,load' && ex.source === null
    ? ok(
        "0046/0056: measures = 'reps,load' from logging_type; source stays NULL on a custom exercise"
      )
    : bad('exercise backfill', JSON.stringify(ex));
  const pr = db
    .prepare("SELECT carry_over, checkoff_mode, started_on FROM protocols WHERE id = 'p-1'")
    .get();
  pr.carry_over === 0 && pr.checkoff_mode === 'strict' && pr.started_on === '2026-08-01'
    ? ok("0050: carry_over = 0, checkoff_mode = 'strict'; 0043's started_on untouched")
    : bad('protocol backfill', JSON.stringify(pr));
  const wk = db
    .prepare('SELECT id, started_at, away, created_at, duration_min FROM workouts ORDER BY id')
    .all();
  wk.every((r) => r.away === 0)
    ? ok('0055: workouts.away = 0 on every pre-existing session')
    : bad('away default', JSON.stringify(wk));
  // 0054 derives the start instant from the end: created_at MINUS duration.
  const startedOk = wk.every(
    (r) =>
      r.started_at ===
      db
        .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?, ?) s")
        .get(r.created_at, `-${r.duration_min} minutes`).s
  );
  startedOk
    ? ok('0054: started_at = created_at − duration_min on every row that had a duration')
    : bad('started_at backfill', JSON.stringify(wk));
  const retired = db
    .prepare("SELECT mode, end_date FROM day_modes WHERE id = 'modes-retired'")
    .get();
  retired && retired.mode === 'normal' && retired.end_date === null
    ? ok("0061: the 'modes-retired' reset row was written, open-ended, as `normal`")
    : bad('modes-retired row', JSON.stringify(retired));
  const ownMode = db.prepare("SELECT * FROM day_modes WHERE id = 'dm-1'").get();
  ownMode && ownMode.end_date === null && ownMode.label === 'Tokyo'
    ? ok("…and the owner's open-ended 'travel' row is untouched beside it — history, not cleanup")
    : bad('owner mode row', JSON.stringify(ownMode));

  // --- (e) is the database SOUND? ------------------------------------------
  // The two questions no other section in this file asks.
  const fkc = db.prepare('PRAGMA foreign_key_check').all();
  fkc.length === 0
    ? ok('PRAGMA foreign_key_check: no violations — nothing orphaned by a rename or a rebuild')
    : bad('foreign_key_check', JSON.stringify(fkc));
  const ic = db.prepare('PRAGMA integrity_check').all();
  JSON.stringify(ic) === JSON.stringify([{ integrity_check: 'ok' }])
    ? ok('PRAGMA integrity_check: ok')
    : bad('integrity_check', JSON.stringify(ic));
  db.prepare('PRAGMA foreign_keys').get().foreign_keys === 1
    ? ok('foreign_keys is still ON afterwards (a table rebuild can silently drop it)')
    : bad('foreign_keys off after upgrade');

  // --- (f) the second launch -----------------------------------------------
  const second = migrate(executor(db), MIGRATIONS);
  second.applied.length === 0 && second.from === LATEST && second.to === LATEST
    ? ok('a second launch applies nothing')
    : bad('relaunch', JSON.stringify(second));
  const dmCount = db.prepare('SELECT count(*) c FROM day_modes').get().c;
  dmCount === 2
    ? ok("…and 0061 did not insert a second 'modes-retired' row")
    : bad('modes-retired duplicated', String(dmCount));

  db.close();
}

// ===========================================================================
// 12. 0063 — caffeine on the seed foods that carry it, on a device at 62.
//
// Two databases. A PRISTINE catalog proves the fill is exactly the five rows
// named, by id, with exactly their values, and nothing else in `foods` moves.
// A HOSTILE one proves a row the user changed is left as he left it: a caffeine
// he typed (a 0 included) is never overwritten, a key he added survives beside
// the new one, a renamed or re-based row is his food now, a deleted row is no
// error, a user food that happens to be called 'Cola' is not a seed row, and a
// latte already logged keeps the snapshot it was logged with. An EDITED one
// (review finding) proves a row the Coach re-priced, branded or re-fatted is
// his food even with its name kept, while a star or a write-back of unchanged
// figures is not an edit.
// ===========================================================================
console.log('12. 0063 fills caffeine on five seed foods, and leaves every changed row alone');
{
  const FILL = {
    'a1cef987-d928-48db-a726-e9b98b742263': ['Coffee, black', 40],
    'bb7b36af-e57e-44fd-9062-37a158612e02': ['Latte, whole milk', 37.4],
    'c458157a-1d0c-42b4-833c-d36cc8ef994c': ['Cola', 8],
    '8ec296da-6053-4ccd-8fbb-a94fedc0ef08': ['Dark chocolate, 70-85%', 80],
    '0cf7bd11-58bb-4105-a346-f095009e613e': ['Milk chocolate', 20],
  };
  const caffeineOf = (db, id) => {
    const row = db.prepare('SELECT micros FROM foods WHERE id = ?').get(id);
    return row?.micros ? JSON.parse(row.micros).caffeine_mg : undefined;
  };

  // --- PRISTINE ------------------------------------------------------------
  const db = new DatabaseSync(':memory:');
  stageAt(db, 62) === 62
    ? ok('staged at 62 — main’s head before this migration, the seed present')
    : bad('stage at 62');
  const seeded = db.prepare("SELECT count(*) c FROM foods WHERE source = 'seed'").get().c;
  const withCaffeine = db
    .prepare("SELECT count(*) c FROM foods WHERE json_extract(micros, '$.caffeine_mg') IS NOT NULL")
    .get().c;
  seeded >= 180 && withCaffeine === 0
    ? ok(`the ${seeded}-row seed is there, and records caffeine on none of them`)
    : bad('seed before', `${seeded} seed rows, ${withCaffeine} with caffeine`);
  const beforeFoods = db.prepare('SELECT * FROM foods ORDER BY id').all();

  const result = migrate(executor(db), MIGRATIONS);
  result.applied.includes('0063_seed_caffeine') &&
  db.prepare('PRAGMA user_version').get().user_version === LATEST
    ? ok(`0063 applied, user_version = ${LATEST}`)
    : bad('0063 not applied', JSON.stringify(result.applied));

  const nowFoods = db.prepare('SELECT * FROM foods ORDER BY id').all();
  const moved = nowFoods.filter((row, i) => JSON.stringify(row) !== JSON.stringify(beforeFoods[i]));
  const movedIds = moved.map((r) => r.id).sort();
  JSON.stringify(movedIds) === JSON.stringify(Object.keys(FILL).sort())
    ? ok('exactly the five named rows changed — no other food moved')
    : bad('rows changed', movedIds.join(', '));
  const wrongValue = Object.entries(FILL).filter(([id, [name, mg]]) => {
    const row = nowFoods.find((r) => r.id === id);
    return row.name !== name || caffeineOf(db, id) !== mg;
  });
  wrongValue.length === 0
    ? ok('each carries its USDA figure: coffee 40, latte 37.4, cola 8, dark 80, milk chocolate 20')
    : bad('values', wrongValue.map(([id]) => id).join(', '));
  const columnsMoved = new Set();
  for (const row of moved) {
    const was = beforeFoods.find((r) => r.id === row.id);
    for (const c of Object.keys(row)) {
      if (JSON.stringify(row[c]) !== JSON.stringify(was[c])) columnsMoved.add(c);
    }
  }
  // `updated_at` moves too unless the fill lands in the very millisecond the
  // seed did, so it is allowed rather than required.
  columnsMoved.has('micros') && [...columnsMoved].every((c) => c === 'micros' || c === 'updated_at')
    ? ok('on those five only `micros` moved, and `updated_at` with it (the 0014 trigger)')
    : bad('columns moved', [...columnsMoved].join(', '));
  const latte = JSON.parse(nowFoods.find((r) => r.id.startsWith('bb7b36af')).micros);
  latte.calcium_mg === 80 && latte.caffeine_mg === 37.4
    ? ok('the latte keeps the calcium 0016 gave it, beside the new key')
    : bad('latte micros', JSON.stringify(latte));
  // Name-substring would have caught these; the id match does not.
  const lookalikes = ['chocolate chip cookie', 'kombucha', 'trail mix'].filter(
    (name) =>
      db
        .prepare("SELECT json_extract(micros, '$.caffeine_mg') AS c FROM foods WHERE name_norm = ?")
        .get(name)?.c != null
  );
  lookalikes.length === 0
    ? ok('the cookie, the kombucha and the trail mix stay unrecorded — absent beats guessed')
    : bad('lookalikes filled', lookalikes.join(', '));
  migrate(executor(db), MIGRATIONS).applied.length === 0
    ? ok('a second launch applies nothing')
    : bad('relaunch applied something');
  db.close();

  // --- HOSTILE -------------------------------------------------------------
  const h = new DatabaseSync(':memory:');
  stageAt(h, 62);
  h.exec(`
    -- The coffee: he added its sodium. The key survives beside the caffeine.
    UPDATE foods SET micros = '{"sodium_mg":5}' WHERE id = 'a1cef987-d928-48db-a726-e9b98b742263';
    -- The latte: he recorded it as decaf, 0 mg. A typed 0 is a figure.
    UPDATE foods SET micros = '{"calcium_mg":80,"caffeine_mg":0}' WHERE id = 'bb7b36af-e57e-44fd-9062-37a158612e02';
    -- The cola: renamed. It is his food now.
    UPDATE foods SET name = 'Cola zero', name_norm = 'cola zero' WHERE id = 'c458157a-1d0c-42b4-833c-d36cc8ef994c';
    -- The dark chocolate: switched to millilitres (0047). Per 100 g is not per 100 ml.
    UPDATE foods SET basis = 'ml' WHERE id = '8ec296da-6053-4ccd-8fbb-a94fedc0ef08';
    -- The milk chocolate: deleted.
    DELETE FROM foods WHERE id = '0cf7bd11-58bb-4105-a346-f095009e613e';
    -- A user food that merely shares a seed name.
    INSERT INTO foods (id, name, name_norm, kcal_100g, source)
      VALUES ('f-my-cola', 'Cola', 'cola', 40, 'user');
    -- A latte logged before the migration: its snapshot is the record.
    INSERT INTO meals (id, date, name) VALUES ('m-am', '2026-09-20', 'Morning');
    INSERT INTO meal_items (id, meal_id, food_id, name, amount, unit, kcal, micros)
      VALUES ('mi-latte', 'm-am', 'bb7b36af-e57e-44fd-9062-37a158612e02', 'Latte, whole milk', 340, 'g', 150, '{"calcium_mg":272}');
  `);
  const hostileBefore = h.prepare('SELECT * FROM foods ORDER BY id').all();
  const itemBefore = h.prepare("SELECT * FROM meal_items WHERE id = 'mi-latte'").get();
  let threw = null;
  try {
    migrate(executor(h), MIGRATIONS);
  } catch (e) {
    threw = e;
  }
  threw === null && h.prepare('PRAGMA user_version').get().user_version === LATEST
    ? ok('0063 applies over a catalog the user has edited and pruned')
    : bad('0063 on the hostile catalog', String(threw));

  const coffee = JSON.parse(
    h.prepare("SELECT micros FROM foods WHERE id = 'a1cef987-d928-48db-a726-e9b98b742263'").get()
      .micros
  );
  coffee.sodium_mg === 5 && coffee.caffeine_mg === 40
    ? ok('the coffee gains its caffeine and keeps the sodium he added')
    : bad('coffee', JSON.stringify(coffee));
  const hostileNow = h.prepare('SELECT * FROM foods ORDER BY id').all();
  const untouched = hostileNow.filter((row) => row.id !== 'a1cef987-d928-48db-a726-e9b98b742263');
  const drift = untouched.filter(
    (row) => JSON.stringify(row) !== JSON.stringify(hostileBefore.find((r) => r.id === row.id))
  );
  drift.length === 0 && hostileNow.length === hostileBefore.length
    ? ok('the decaf latte keeps his 0, the renamed cola and the ml chocolate are untouched')
    : bad('rows the user changed were written', drift.map((r) => r.id).join(', '));
  caffeineOf(h, 'bb7b36af-e57e-44fd-9062-37a158612e02') === 0 &&
  caffeineOf(h, 'c458157a-1d0c-42b4-833c-d36cc8ef994c') === undefined &&
  caffeineOf(h, '8ec296da-6053-4ccd-8fbb-a94fedc0ef08') === undefined &&
  caffeineOf(h, 'f-my-cola') === undefined
    ? ok('…read back: latte 0, renamed cola none, ml chocolate none, his own Cola none')
    : bad('hostile values');
  h.prepare("SELECT count(*) c FROM foods WHERE id = '0cf7bd11-58bb-4105-a346-f095009e613e'").get()
    .c === 0
    ? ok('the deleted milk chocolate stays deleted — an UPDATE by id matches nothing')
    : bad('deleted row came back');
  JSON.stringify(h.prepare("SELECT * FROM meal_items WHERE id = 'mi-latte'").get()) ===
  JSON.stringify(itemBefore)
    ? ok('a latte logged before 0063 keeps its snapshot — history is not rewritten')
    : bad('logged latte rewritten');
  h.close();

  // --- EDITED THROUGH THE COACH (review finding) ----------------------------
  // No screen edits a catalog food; the Coach's `edit_record` over
  // `food_catalog` rewrites name, brand, the four per-100 macros and basis, and
  // stars. A row whose NAME survived an edit can still be a different food.
  const e = new DatabaseSync(':memory:');
  stageAt(e, 62);
  e.exec(`
    -- The latte re-priced as his café's single-shot oat latte, name kept.
    UPDATE foods SET kcal_100g = 38, protein_g_100g = 1.1, carbs_g_100g = 5.2, fat_g_100g = 1.6
      WHERE id = 'bb7b36af-e57e-44fd-9062-37a158612e02';
    -- The coffee given his café's name as its brand.
    UPDATE foods SET brand = 'Blue Bottle' WHERE id = 'a1cef987-d928-48db-a726-e9b98b742263';
    -- The milk chocolate: one macro nudged, everything else as seeded.
    UPDATE foods SET fat_g_100g = 30 WHERE id = '0cf7bd11-58bb-4105-a346-f095009e613e';
    -- The dark chocolate: starred. That stamps updated_at and changes no figure.
    UPDATE foods SET is_favorite = 1 WHERE id = '8ec296da-6053-4ccd-8fbb-a94fedc0ef08';
    -- The cola: an edit that wrote back exactly what it read (read-modify-write
    -- with nothing asked of it). Every figure is still 0016's.
    UPDATE foods SET name = 'Cola', name_norm = 'cola', brand = NULL, kcal_100g = 42,
      protein_g_100g = 0, carbs_g_100g = 10.6, fat_g_100g = 0, basis = 'g'
      WHERE id = 'c458157a-1d0c-42b4-833c-d36cc8ef994c';
  `);
  const editedBefore = e.prepare('SELECT * FROM foods ORDER BY id').all();
  migrate(executor(e), MIGRATIONS);
  e.prepare('PRAGMA user_version').get().user_version === LATEST
    ? ok('0063 applies over a catalog the Coach has edited')
    : bad('0063 on the edited catalog');
  const editedNow = e.prepare('SELECT * FROM foods ORDER BY id').all();
  const editedMoved = editedNow
    .filter((row, i) => JSON.stringify(row) !== JSON.stringify(editedBefore[i]))
    .map((row) => row.id)
    .sort();
  JSON.stringify(editedMoved) ===
  JSON.stringify(
    ['8ec296da-6053-4ccd-8fbb-a94fedc0ef08', 'c458157a-1d0c-42b4-833c-d36cc8ef994c'].sort()
  )
    ? ok('only the starred chocolate and the written-back cola were filled')
    : bad('edited rows filled', editedMoved.join(', '));
  caffeineOf(e, 'bb7b36af-e57e-44fd-9062-37a158612e02') === undefined &&
  caffeineOf(e, 'a1cef987-d928-48db-a726-e9b98b742263') === undefined &&
  caffeineOf(e, '0cf7bd11-58bb-4105-a346-f095009e613e') === undefined
    ? ok('a re-priced latte, a branded coffee and a re-fatted milk chocolate get no seed figure')
    : bad('edited rows got caffeine');
  caffeineOf(e, '8ec296da-6053-4ccd-8fbb-a94fedc0ef08') === 80 &&
  caffeineOf(e, 'c458157a-1d0c-42b4-833c-d36cc8ef994c') === 8
    ? ok('a star is not an edit (80 mg), and neither is a figure written back unchanged (8 mg)')
    : bad('starred / written-back rows');
  e.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
