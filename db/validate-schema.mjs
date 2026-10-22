/**
 * Validate a migration against real SQLite, headless — no device, no Docker.
 *
 * Uses Node's built-in `node:sqlite` (Node 22.5+), which is the same SQLite
 * engine op-sqlite ships on device, so what passes here behaves on the phone.
 * This is the check CLAUDE.md §9 asks for before shipping a schema change.
 *
 *   node db/validate-schema.mjs [path-to-migration.sql]
 *
 * Defaults to db/migrations/0001_init.sql. Exit code 0 iff every assertion
 * passes. Extend the assertions when you add tables or constraints.
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = process.argv[2] ?? join(here, 'migrations', '0001_init.sql');
const schema = readFileSync(schemaPath, 'utf8');

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;'); // SQLite defaults this OFF — the app must too.

let pass = 0;
let fail = 0;
const ok = (name) => {
  pass++;
  console.log(`  ok   ${name}`);
};
const bad = (name, err) => {
  fail++;
  console.log(`  FAIL ${name}${err ? ' — ' + err : ''}`);
};
/** Assert a statement throws (a constraint should reject it). */
const rejects = (name, fn) => {
  try {
    fn();
    bad(name, 'expected rejection, got success');
  } catch {
    ok(name);
  }
};
const id = (s) => s.padEnd(36, '0'); // stand-in uuids (the app generates them from SQLite randomblob — Hermes has no crypto)

console.log(`Validating ${schemaPath}\n`);

console.log('1. Apply schema');
try {
  db.exec(schema);
  ok('schema executes clean');
} catch (e) {
  bad('schema executes clean', e.message);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}

console.log('2. Tables & triggers present');
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((r) => r.name);
const expectedTables = [
  'biomarkers',
  'body_metrics',
  'daily_logs',
  'lab_reports',
  'lab_results',
  'log_entries',
  'protocol_versions',
  'protocols',
  'users',
  'wearable_data',
];
expectedTables.every((t) => tables.includes(t))
  ? ok(`all 10 core tables (${tables.length} total)`)
  : bad('all 10 core tables', `got ${tables.join(',')}`);
const triggers = db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='trigger'").get().c;
triggers === 9 ? ok('9 updated_at triggers') : bad('9 updated_at triggers', `got ${triggers}`);

console.log('3. Happy-path inserts across every table');
try {
  db.exec(`INSERT INTO users (id, timezone) VALUES ('${id('u')}', 'America/New_York');`);
  db.exec(
    `INSERT INTO biomarkers (id, slug, name, category) VALUES ('${id('bm')}', 'apob', 'ApoB', 'cardiovascular');`
  );
  db.exec(`INSERT INTO lab_reports (id, collected_at) VALUES ('${id('lr')}', '2026-07-20');`);
  db.exec(
    `INSERT INTO lab_results (id, biomarker_id, report_id, value, collected_at) VALUES ('${id('res')}', '${id('bm')}', '${id('lr')}', 61.0, '2026-07-20');`
  );
  db.exec(
    `INSERT INTO protocols (id, slug, name, type) VALUES ('${id('p')}', 'morning_stack', 'Morning Stack', 'supplement_stack');`
  );
  db.exec(
    `INSERT INTO protocol_versions (id, protocol_id, version_number) VALUES ('${id('pv')}', '${id('p')}', 1);`
  );
  db.exec(`UPDATE protocols SET current_version_id = '${id('pv')}' WHERE id = '${id('p')}';`);
  db.exec(`INSERT INTO daily_logs (id, date) VALUES ('${id('dl')}', '2026-07-24');`);
  db.exec(
    `INSERT INTO log_entries (id, daily_log_id, type, title, scheduled_time, protocol_id) VALUES ('${id('le')}', '${id('dl')}', 'supplement', 'AM stack', '07:15', '${id('p')}');`
  );
  db.exec(
    `INSERT INTO wearable_data (id, date, metric_type, value, source_device) VALUES ('${id('wd')}', '2026-07-24', 'hrv', 42, 'oura');`
  );
  db.exec(
    `INSERT INTO body_metrics (id, measured_at, weight_kg) VALUES ('${id('bo')}', '2026-07-24T07:00:00.000Z', 80.5);`
  );
  ok('all 10 tables accept a valid row (incl. forward FK current_version_id)');
} catch (e) {
  bad('happy-path inserts', e.message);
}

console.log('4. updated_at trigger fires on UPDATE');
{
  const before = db.prepare('SELECT updated_at FROM users WHERE id = ?').get(id('u')).updated_at;
  db.exec(`UPDATE users SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = '${id('u')}';`);
  db.exec(`UPDATE users SET timezone = 'UTC' WHERE id = '${id('u')}';`);
  const after = db.prepare('SELECT updated_at, created_at FROM users WHERE id = ?').get(id('u'));
  after.updated_at >= before && after.created_at === '2000-01-01T00:00:00.000Z'
    ? ok('trigger stamps updated_at, leaves other cols, no recursion')
    : bad('updated_at trigger', JSON.stringify(after));
}

console.log('5. Constraints reject bad data');
rejects('enum CHECK: bad biological_sex', () =>
  db.exec("INSERT INTO users (id, biological_sex) VALUES ('x', 'yes');")
);
rejects('enum CHECK: bad wearable source_device', () =>
  db.exec(
    "INSERT INTO wearable_data (id, date, metric_type, value, source_device) VALUES ('x','2026-07-24','hrv',42,'fitbit');"
  )
);
rejects('FK: log_entry to missing daily_log', () =>
  db.exec(
    "INSERT INTO log_entries (id, daily_log_id, type, title) VALUES ('x','nope','habit','t');"
  )
);
rejects('json_valid: malformed preferences', () =>
  db.exec("INSERT INTO users (id, preferences) VALUES ('x','{bad');")
);
rejects('GLOB: malformed date', () =>
  db.exec("INSERT INTO daily_logs (id, date) VALUES ('x','07/24/26');")
);
rejects('GLOB: malformed scheduled_time', () =>
  db.exec(
    `INSERT INTO log_entries (id, daily_log_id, type, title, scheduled_time) VALUES ('x','${id('dl')}','habit','t','7am');`
  )
);
rejects('range CHECK: adherence > 100', () =>
  db.exec(
    "INSERT INTO daily_logs (id, date, overall_adherence_score) VALUES ('x','2026-01-01',150);"
  )
);
rejects('CHECK: version_number must be > 0', () =>
  db.exec(
    `INSERT INTO protocol_versions (id, protocol_id, version_number) VALUES ('x','${id('p')}',0);`
  )
);

console.log('6. Delete semantics');
{
  db.exec(`DELETE FROM protocols WHERE id = '${id('p')}';`);
  const le = db.prepare('SELECT protocol_id FROM log_entries WHERE id = ?').get(id('le'));
  le && le.protocol_id === null
    ? ok('deleting a protocol SET NULLs log_entries.protocol_id (history kept)')
    : bad('protocol delete SET NULL', JSON.stringify(le));
}
{
  db.exec(`DELETE FROM lab_reports WHERE id = '${id('lr')}';`);
  const n = db.prepare('SELECT count(*) c FROM lab_results WHERE report_id = ?').get(id('lr')).c;
  n === 0
    ? ok('deleting a lab_report CASCADEs to lab_results')
    : bad('report cascade', `${n} left`);
}
{
  db.exec(`INSERT INTO lab_reports (id, collected_at) VALUES ('${id('lr2')}', '2026-07-20');`);
  db.exec(
    `INSERT INTO lab_results (id, biomarker_id, report_id, value, collected_at) VALUES ('${id('r1')}','${id('bm')}','${id('lr2')}',1,'2026-07-20');`
  );
  rejects('UNIQUE: one value per biomarker per report', () =>
    db.exec(
      `INSERT INTO lab_results (id, biomarker_id, report_id, value, collected_at) VALUES ('${id('r2')}','${id('bm')}','${id('lr2')}',2,'2026-07-20');`
    )
  );
}

console.log('7. Audit hardening (NOT NULL ids, body-metric bounds)');
rejects('NULL id rejected (users)', () =>
  db.exec("INSERT INTO users (id, timezone) VALUES (NULL, 'UTC');")
);
rejects('NULL id rejected (body_metrics)', () =>
  db.exec("INSERT INTO body_metrics (id, measured_at) VALUES (NULL, '2026-07-24T07:00:00.000Z');")
);
rejects('visceral_fat_rating < 0 rejected', () =>
  db.exec(
    `INSERT INTO body_metrics (id, measured_at, visceral_fat_rating) VALUES ('${id('bo2')}', '2026-07-24T07:00:00.000Z', -3);`
  )
);
rejects('weight_kg >= 1000 rejected (fat-finger)', () =>
  db.exec(
    `INSERT INTO body_metrics (id, measured_at, weight_kg) VALUES ('${id('bo3')}', '2026-07-24T07:00:00.000Z', 50000);`
  )
);
// Note: the updated_at triggers are non-recursive only under the default
// recursive_triggers=OFF (asserted in section 4). A WHEN-guarded "safe under ON"
// variant was tried and fails — strftime('now') collides within a cascade — so
// the contract is "the DB client never enables recursive_triggers", enforced in
// the client, not assertable here. See the trigger comment in 0001_init.sql.

db.close();

// ---------------------------------------------------------------------------
// 8. 0066 — `food_log_ratings`, over EVERY migration in order (it needs 0002's
//    `meals`). Only when validating the default schema: a file passed on the
//    command line is validated alone, as before.
// ---------------------------------------------------------------------------
if (process.argv[2] === undefined) {
  console.log('8. 0066 food_log_ratings (all migrations applied in order)');
  const full = new DatabaseSync(':memory:');
  full.exec('PRAGMA foreign_keys = ON;');
  const dir = join(here, 'migrations');
  for (const file of readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort()) {
    full.exec(readFileSync(join(dir, file), 'utf8'));
  }
  const cols = full.prepare('PRAGMA table_info(food_log_ratings)').all();
  const idCol = cols.find((c) => c.name === 'id');
  idCol && idCol.pk === 1 && idCol.notnull === 1 && idCol.type === 'TEXT'
    ? ok('food_log_ratings.id is text PRIMARY KEY NOT NULL')
    : bad('id column', JSON.stringify(idCol));
  ['meal_id', 'rating', 'created_at', 'updated_at'].every(
    (name) => cols.find((c) => c.name === name)?.notnull === 1
  ) && ['issue', 'before_items', 'after_items'].every((name) => cols.find((c) => c.name === name)?.notnull === 0)
    ? ok('meal_id, rating and the stamps are NOT NULL; issue and the snapshots are nullable')
    : bad('nullability', JSON.stringify(cols.map((c) => [c.name, c.notnull])));
  full.exec(`INSERT INTO meals (id, date, name, source) VALUES ('${id('m1')}', '2026-10-21', 'Lunch', 'ai_suggested');
             INSERT INTO meals (id, date, name) VALUES ('${id('m2')}', '2026-10-21', 'Dinner');`);
  const ins = (cols, vals) => () => full.exec(`INSERT INTO food_log_ratings (${cols}) VALUES (${vals});`);
  rejects('NULL id rejected (food_log_ratings)', ins('id, meal_id, rating', `NULL, '${id('m1')}', 'good'`));
  rejects("rating outside ('good','bad') rejected", ins('id, meal_id, rating', `'${id('r0')}', '${id('m1')}', 'meh'`));
  rejects('NULL rating rejected', ins('id, meal_id, rating', `'${id('r0')}', '${id('m1')}', NULL`));
  rejects("issue outside ('portion','item','macros') rejected", ins('id, meal_id, rating, issue', `'${id('r0')}', '${id('m1')}', 'bad', 'taste'`));
  rejects('invalid JSON in before_items rejected', ins('id, meal_id, rating, before_items', `'${id('r0')}', '${id('m1')}', 'bad', '[{'`));
  rejects('invalid JSON in after_items rejected', ins('id, meal_id, rating, after_items', `'${id('r0')}', '${id('m1')}', 'bad', 'nope'`));
  rejects('a "good" carrying an issue rejected', ins('id, meal_id, rating, issue', `'${id('r0')}', '${id('m1')}', 'good', 'portion'`));
  rejects('a "good" carrying a snapshot rejected', ins('id, meal_id, rating, before_items', `'${id('r0')}', '${id('m1')}', 'good', '[]'`));
  rejects('a rating of no meal rejected (FK)', ins('id, meal_id, rating', `'${id('r0')}', '${id('nomeal')}', 'good'`));
  try {
    ins('id, meal_id, rating, issue, before_items', `'${id('r1')}', '${id('m1')}', 'bad', 'portion', '[{"name":"Chicken salad","amount":350}]'`)();
    ins('id, meal_id, rating', `'${id('r2')}', '${id('m2')}', 'good'`)();
    ok('a bad with its issue and snapshot, and a bare good, insert');
  } catch (e) {
    bad('valid ratings insert', e.message);
  }
  rejects('a second rating of one meal rejected (UNIQUE meal_id)', ins('id, meal_id, rating', `'${id('r3')}', '${id('m1')}', 'good'`));
  full.exec(`UPDATE food_log_ratings SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = '${id('r1')}';`);
  full.exec(`UPDATE food_log_ratings SET after_items = '[{"name":"Chicken salad","amount":250}]' WHERE id = '${id('r1')}';`);
  full.prepare('SELECT updated_at FROM food_log_ratings WHERE id = ?').get(id('r1')).updated_at !==
  '2000-01-01T00:00:00.000Z'
    ? ok('the AFTER UPDATE trigger stamps updated_at')
    : bad('updated_at trigger');
  full.exec(`DELETE FROM meals WHERE id = '${id('m1')}';`);
  const left = full.prepare('SELECT meal_id FROM food_log_ratings ORDER BY meal_id').all().map((r) => r.meal_id);
  left.length === 1 && left[0] === id('m2')
    ? ok('deleting a meal CASCADEs to its rating, and only its own')
    : bad('rating cascade', JSON.stringify(left));
  const fk = full.prepare('PRAGMA foreign_key_list(food_log_ratings)').all();
  fk.length === 1 && fk[0].table === 'meals' && fk[0].on_delete === 'CASCADE'
    ? ok('its one foreign key is meals ON DELETE CASCADE')
    : bad('fk', JSON.stringify(fk));
  full.close();
}

// ---------------------------------------------------------------------------
// 9. 0067 — `day_plan_events`, over every migration in order (it needs 0001's
//    `log_entries` for its SET NULL reference).
// ---------------------------------------------------------------------------
if (process.argv[2] === undefined) {
  console.log('9. 0067 day_plan_events (all migrations applied in order)');
  const full = new DatabaseSync(':memory:');
  full.exec('PRAGMA foreign_keys = ON;');
  const dir = join(here, 'migrations');
  for (const file of readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort()) {
    full.exec(readFileSync(join(dir, file), 'utf8'));
  }
  const cols = full.prepare('PRAGMA table_info(day_plan_events)').all();
  const idCol = cols.find((c) => c.name === 'id');
  idCol && idCol.pk === 1 && idCol.notnull === 1 && idCol.type === 'TEXT'
    ? ok('day_plan_events.id is text PRIMARY KEY NOT NULL')
    : bad('id column', JSON.stringify(idCol));
  ['day', 'plan_id', 'item_key', 'kind', 'title', 'rank', 'event', 'at', 'created_at', 'updated_at'].every(
    (name) => cols.find((c) => c.name === name)?.notnull === 1
  ) && ['action', 'log_entry_id'].every((name) => cols.find((c) => c.name === name)?.notnull === 0)
    ? ok('everything but action and log_entry_id is NOT NULL')
    : bad('nullability', JSON.stringify(cols.map((c) => [c.name, c.notnull])));

  full.exec(`INSERT INTO daily_logs (id, date) VALUES ('${id('dl1')}', '2026-10-21');
             INSERT INTO log_entries (id, daily_log_id, type, title) VALUES ('${id('le1')}', '${id('dl1')}', 'supplement', 'Creatine');`);
  const COLS = 'id, day, plan_id, item_key, kind, action, log_entry_id, title, rank, event, at';
  const row = (over = {}) => {
    const v = {
      id: `'${id('e0')}'`,
      day: "'2026-10-21'",
      plan_id: "'p1'",
      item_key: "'do:log_weight'",
      kind: "'do'",
      action: "'log_weight'",
      log_entry_id: 'NULL',
      title: "'Weigh in'",
      rank: '1',
      event: "'shown'",
      at: "'2026-10-21T07:12:00.000Z'",
      ...over,
    };
    return () =>
      full.exec(
        `INSERT INTO day_plan_events (${COLS}) VALUES (${[v.id, v.day, v.plan_id, v.item_key, v.kind, v.action, v.log_entry_id, v.title, v.rank, v.event, v.at].join(', ')});`
      );
  };
  rejects('NULL id rejected (day_plan_events)', row({ id: 'NULL' }));
  rejects('a malformed day rejected', row({ day: "'21/10/2026'" }));
  rejects('an empty plan_id rejected', row({ plan_id: "''" }));
  rejects('an empty item_key rejected', row({ item_key: "''" }));
  rejects("kind outside ('pin','do') rejected", row({ kind: "'nag'" }));
  rejects('an event outside the six rejected', row({ event: "'snoozed'" }));
  rejects('rank 0 rejected', row({ rank: '0' }));
  rejects('rank 4 rejected (a plan holds at most three)', row({ rank: '4' }));
  rejects('a malformed instant rejected', row({ at: "'07:12'" }));
  rejects('a do item without an action rejected', row({ action: 'NULL' }));
  rejects('a pin carrying an action rejected', row({ kind: "'pin'", item_key: `'pin:${id('le1')}'` }));
  rejects('a reference to no mission row rejected (FK)', row({ kind: "'pin'", action: 'NULL', log_entry_id: `'${id('nope')}'` }));
  try {
    row()();
    row({ id: `'${id('e1')}'`, event: "'done'" })();
    row({
      id: `'${id('e2')}'`,
      kind: "'pin'",
      action: 'NULL',
      item_key: `'pin:${id('le1')}'`,
      log_entry_id: `'${id('le1')}'`,
      title: "'Creatine'",
      rank: '2',
    })();
    ok('a do item, its done, and a pin on a real row insert');
  } catch (e) {
    bad('valid events insert', e.message);
  }
  rejects('the same event twice for one item rejected (UNIQUE)', row({ id: `'${id('e3')}'` }));
  try {
    row({ id: `'${id('e4')}'`, plan_id: "'p2'" })();
    ok('…but the same event for the same item of a LATER plan inserts');
  } catch (e) {
    bad('second plan', e.message);
  }
  full.exec(`UPDATE day_plan_events SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = '${id('e1')}';`);
  full.exec(`UPDATE day_plan_events SET title = 'Weigh in now' WHERE id = '${id('e1')}';`);
  full.prepare('SELECT updated_at FROM day_plan_events WHERE id = ?').get(id('e1')).updated_at !==
  '2000-01-01T00:00:00.000Z'
    ? ok('the AFTER UPDATE trigger stamps updated_at')
    : bad('updated_at trigger');
  full.exec(`DELETE FROM log_entries WHERE id = '${id('le1')}';`);
  const pin = full.prepare('SELECT log_entry_id, title FROM day_plan_events WHERE id = ?').get(id('e2'));
  pin && pin.log_entry_id === null && pin.title === 'Creatine'
    ? ok('deleting the mission row SETs the pin’s reference NULL and keeps its title (history survives)')
    : bad('set null', JSON.stringify(pin));
  const fk = full.prepare('PRAGMA foreign_key_list(day_plan_events)').all();
  fk.length === 1 && fk[0].table === 'log_entries' && fk[0].on_delete === 'SET NULL'
    ? ok('its one foreign key is log_entries ON DELETE SET NULL')
    : bad('fk', JSON.stringify(fk));
  full.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
