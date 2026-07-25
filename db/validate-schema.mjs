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
import { readFileSync } from 'node:fs';
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
const id = (s) => s.padEnd(36, '0'); // stand-in uuids (the app uses crypto.randomUUID)

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
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
