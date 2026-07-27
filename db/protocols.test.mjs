/**
 * Headless test of the Protocols data layer — the 0001 `protocols` +
 * `protocol_versions` tables and their repository (protocols.ts) plus the
 * content parser — against real SQLite via node:sqlite. Mirrors
 * db/nutrition.test.mjs; op-sqlite is never loaded. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { todayISODate } from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  addVersion,
  createProtocol,
  deleteProtocol,
  getCurrentVersion,
  getProtocol,
  listProtocols,
  setActive,
  updateProtocolMeta,
} from '../src/lib/db/repositories/protocols.ts';
import { parseProtocolContent } from '../src/lib/protocols/content.ts';

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
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
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

const TODAY = todayISODate();
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STACK = {
  items: [
    { title: 'Creatine', scheduled_time: '07:30', dose: '5 g', notes: null },
    { title: 'Omega-3', scheduled_time: null, dose: '2 caps, with food', notes: null },
  ],
};

console.log('0. the 0001 protocol tables exist (no migration was added for this feature)');
{
  const { raw } = freshDb();
  const tables = raw
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('protocols','protocol_versions') ORDER BY name"
    )
    .all()
    .map((r) => r.name);
  JSON.stringify(tables) === JSON.stringify(['protocol_versions', 'protocols'])
    ? ok('protocols + protocol_versions are in the schema')
    : bad('tables', JSON.stringify(tables));
}

console.log('1. createProtocol persists the identity row — no version yet');
{
  const { db, raw } = freshDb();
  const id = createProtocol(db, {
    name: 'Morning Stack',
    type: 'supplement_stack',
    description: 'The 7am non-negotiables',
  });
  V4.test(id) ? ok('returned id is a v4 UUID') : bad('id shape', id);
  const row = raw.prepare('SELECT * FROM protocols WHERE id = ?').get(id);
  row &&
  row.slug === 'morning_stack' &&
  row.name === 'Morning Stack' &&
  row.description === 'The 7am non-negotiables' &&
  row.type === 'supplement_stack' &&
  row.is_active === 1 &&
  row.current_version_id === null
    ? ok('row stored: slugged, active by default, current_version_id NULL')
    : bad('row contents', JSON.stringify(row));
  row && row.created_at && row.updated_at
    ? ok('created_at / updated_at stamped by the DB defaults')
    : bad('timestamps', JSON.stringify(row));
}

console.log('2. slugs: repo-owned shape, unique via numeric suffix');
{
  const { db, raw } = freshDb();
  const a = createProtocol(db, { name: 'Zone 2 — Base Block!', type: 'training_block' });
  const b = createProtocol(db, { name: 'Zone 2 (Base) block', type: 'training_block' });
  const c = createProtocol(db, { name: 'Zone 2, base BLOCK', type: 'training_block' });
  const slugs = [a, b, c].map(
    (id) => raw.prepare('SELECT slug FROM protocols WHERE id = ?').get(id).slug
  );
  JSON.stringify(slugs) ===
  JSON.stringify(['zone_2_base_block', 'zone_2_base_block_2', 'zone_2_base_block_3'])
    ? ok('same-name collisions get _2, _3 suffixes')
    : bad('slug suffixes', JSON.stringify(slugs));
  const d = createProtocol(db, { name: '¡¡¡', type: 'other' });
  raw.prepare('SELECT slug FROM protocols WHERE id = ?').get(d).slug === 'protocol'
    ? ok("a name with no usable characters falls back to 'protocol'")
    : bad('slug fallback');
}

console.log('3. addVersion writes v1 and points current_version_id at it');
{
  const { db, raw } = freshDb();
  const pid = createProtocol(db, { name: 'Morning Stack', type: 'supplement_stack' });
  const vid = addVersion(db, pid, STACK, 'Initial stack');
  V4.test(vid) ? ok('returned version id is a v4 UUID') : bad('version id', vid);
  const v = raw.prepare('SELECT * FROM protocol_versions WHERE id = ?').get(vid);
  v &&
  v.protocol_id === pid &&
  v.version_number === 1 &&
  v.change_notes === 'Initial stack' &&
  v.created_by === 'user'
    ? ok("version 1, change_notes and created_by='user' stored")
    : bad('version row', JSON.stringify(v));
  v && JSON.stringify(JSON.parse(v.content)) === JSON.stringify(STACK)
    ? ok('content JSON round-trips intact')
    : bad('content', v && v.content);
  raw.prepare('SELECT current_version_id FROM protocols WHERE id = ?').get(pid)
    .current_version_id === vid
    ? ok('current_version_id points at the new version')
    : bad('pointer');
  const current = getCurrentVersion(db, pid);
  current && current.id === vid
    ? ok('getCurrentVersion resolves the pointer')
    : bad('getCurrentVersion', JSON.stringify(current));
}

console.log('4. a second addVersion bumps the pointer; the old version stays immutable');
{
  const { db, raw } = freshDb();
  const pid = createProtocol(db, { name: 'Morning Stack', type: 'supplement_stack' });
  const v1 = addVersion(db, pid, STACK, 'Initial stack');
  const v1Before = JSON.stringify(
    raw.prepare('SELECT * FROM protocol_versions WHERE id = ?').get(v1)
  );
  const v2Content = {
    items: [
      ...STACK.items,
      { title: 'Magnesium', scheduled_time: '21:30', dose: '400 mg', notes: null },
    ],
  };
  const v2 = addVersion(db, pid, v2Content, 'Added magnesium at night');
  const current = getCurrentVersion(db, pid);
  current && current.id === v2 && current.version_number === 2
    ? ok('current_version_id moved to v2')
    : bad('v2 pointer', JSON.stringify(current));
  JSON.stringify(raw.prepare('SELECT * FROM protocol_versions WHERE id = ?').get(v1)) === v1Before
    ? ok('the v1 row is byte-identical after the bump (immutable snapshot)')
    : bad('v1 mutated');
  raw.prepare('SELECT count(*) c FROM protocol_versions WHERE protocol_id = ?').get(pid).c === 2
    ? ok('both versions are retained')
    : bad('version count');
  const cols = raw
    .prepare("SELECT name FROM pragma_table_info('protocol_versions')")
    .all()
    .map((r) => r.name);
  !cols.includes('updated_at')
    ? ok('protocol_versions has no updated_at — no update path by design')
    : bad('updated_at column exists');
}

console.log('5. DB constraints hold: unique version numbers, valid JSON, sane enums');
{
  const { db, raw } = freshDb();
  const pid = createProtocol(db, { name: 'Morning Stack', type: 'supplement_stack' });
  addVersion(db, pid, STACK);
  throws(() =>
    raw
      .prepare(
        "INSERT INTO protocol_versions (id, protocol_id, version_number, content) VALUES ('dup', ?, 1, '{}')"
      )
      .run(pid)
  )
    ? ok('unique(protocol_id, version_number) rejects a duplicate v1')
    : bad('duplicate version accepted');
  throws(() =>
    raw
      .prepare(
        "INSERT INTO protocol_versions (id, protocol_id, version_number, content) VALUES ('v0', ?, 0, '{}')"
      )
      .run(pid)
  )
    ? ok('version_number 0 rejected (CHECK > 0)')
    : bad('version 0 accepted');
  throws(() =>
    raw
      .prepare(
        "INSERT INTO protocol_versions (id, protocol_id, version_number, content) VALUES ('vx', ?, 9, 'not json')"
      )
      .run(pid)
  )
    ? ok('non-JSON content rejected by json_valid CHECK')
    : bad('bad json accepted');
  throws(() =>
    raw
      .prepare(
        "INSERT INTO protocol_versions (id, protocol_id, version_number, content, created_by) VALUES ('vy', ?, 9, '{}', 'robot')"
      )
      .run(pid)
  )
    ? ok('created_by outside user|ai rejected')
    : bad('bad created_by accepted');
  throws(() => createProtocol(db, { name: 'Bad type', type: 'yolo_routine' }))
    ? ok('unknown protocol type rejected by the enum CHECK')
    : bad('bad type accepted');
  throws(() => addVersion(db, 'no-such-protocol', STACK))
    ? ok('addVersion against a missing protocol rejected by the FK')
    : bad('orphan version accepted');
}

console.log('6. listProtocols: active first then name, live version stats, empty-safe');
{
  const { db } = freshDb();
  listProtocols(db).length === 0 ? ok('empty database lists as []') : bad('empty list');
  const zeta = createProtocol(db, { name: 'Zeta block', type: 'training_block' });
  const alpha = createProtocol(db, { name: 'alpha stack', type: 'supplement_stack' });
  const mid = createProtocol(db, { name: 'Midline routine', type: 'daily_routine' });
  addVersion(db, zeta, STACK);
  addVersion(db, zeta, { items: [STACK.items[0]] }, 'Trimmed');
  setActive(db, alpha, false);
  const list = listProtocols(db);
  JSON.stringify(list.map((p) => p.name)) ===
  JSON.stringify(['Midline routine', 'Zeta block', 'alpha stack'])
    ? ok('active first, then case-insensitive name order')
    : bad('order', JSON.stringify(list.map((p) => p.name)));
  const z = list.find((p) => p.id === zeta);
  z && z.versionNumber === 2 && z.itemCount === 1 && z.isActive === true
    ? ok('live version number + item count come from the current version')
    : bad('zeta stats', JSON.stringify(z));
  const m = list.find((p) => p.id === mid);
  m && m.versionNumber === null && m.itemCount === 0
    ? ok('a version-less protocol reads v-null with 0 items')
    : bad('mid stats', JSON.stringify(m));
  const a = list.find((p) => p.id === alpha);
  a && a.isActive === false ? ok('paused protocol reports isActive false') : bad('alpha state');
}

console.log('7. setActive + updateProtocolMeta mutate the identity row; trigger restamps');
{
  const { db, raw } = freshDb();
  const pid = createProtocol(db, { name: 'Morning Stack', type: 'supplement_stack' });
  raw
    .prepare('UPDATE protocols SET updated_at = ? WHERE id = ?')
    .run('2000-01-01T00:00:00.000Z', pid);
  setActive(db, pid, false);
  const afterPause = raw
    .prepare('SELECT is_active, updated_at FROM protocols WHERE id = ?')
    .get(pid);
  afterPause.is_active === 0 && afterPause.updated_at !== '2000-01-01T00:00:00.000Z'
    ? ok('setActive(false) pauses and the updated_at trigger restamps')
    : bad('pause', JSON.stringify(afterPause));
  setActive(db, pid, true);
  raw.prepare('SELECT is_active FROM protocols WHERE id = ?').get(pid).is_active === 1
    ? ok('setActive(true) resumes')
    : bad('resume');
  updateProtocolMeta(db, pid, { name: 'AM Stack', type: 'daily_routine', description: 'renamed' });
  const meta = raw
    .prepare('SELECT slug, name, type, description FROM protocols WHERE id = ?')
    .get(pid);
  meta.name === 'AM Stack' && meta.type === 'daily_routine' && meta.description === 'renamed'
    ? ok('updateProtocolMeta renames / re-types / re-describes')
    : bad('meta', JSON.stringify(meta));
  meta.slug === 'morning_stack'
    ? ok('the slug never changes after creation (stable identity)')
    : bad('slug drifted', meta.slug);
}

console.log('8. unknown ids read as undefined, not throws');
{
  const { db } = freshDb();
  getProtocol(db, 'nope') === undefined
    ? ok('getProtocol(unknown) is undefined')
    : bad('getProtocol');
  getCurrentVersion(db, 'nope') === undefined
    ? ok('getCurrentVersion(unknown) is undefined')
    : bad('getCurrentVersion');
  const pid = createProtocol(db, { name: 'No versions yet', type: 'other' });
  getCurrentVersion(db, pid) === undefined
    ? ok('getCurrentVersion before any version is undefined')
    : bad('pre-version current');
}

console.log('9. deleting a protocol cascades versions but SET NULLs log history');
{
  const { db, raw } = freshDb();
  const pid = createProtocol(db, { name: 'Morning Stack', type: 'supplement_stack' });
  addVersion(db, pid, STACK);
  addVersion(db, pid, { items: [] }, 'Emptied');
  raw.prepare("INSERT INTO daily_logs (id, date) VALUES ('dl1', ?)").run(TODAY);
  raw
    .prepare(
      "INSERT INTO log_entries (id, daily_log_id, type, protocol_id, title) VALUES ('le1', 'dl1', 'supplement', ?, 'Creatine — AM stack')"
    )
    .run(pid);
  deleteProtocol(db, pid);
  raw.prepare('SELECT count(*) c FROM protocols').get().c === 0
    ? ok('protocol row deleted')
    : bad('protocol survived');
  raw.prepare('SELECT count(*) c FROM protocol_versions').get().c === 0
    ? ok('its versions cascaded away')
    : bad('versions survived');
  const entry = raw.prepare("SELECT protocol_id, title FROM log_entries WHERE id = 'le1'").get();
  entry && entry.protocol_id === null && entry.title === 'Creatine — AM stack'
    ? ok('the log entry survives with protocol_id SET NULL — history preserved')
    : bad('log entry', JSON.stringify(entry));
}

console.log('10. parseProtocolContent is forgiving on read');
{
  const empty = JSON.stringify({ items: [] });
  JSON.stringify(parseProtocolContent(null)) === empty &&
  JSON.stringify(parseProtocolContent('not json')) === empty &&
  JSON.stringify(parseProtocolContent('"a string"')) === empty &&
  JSON.stringify(parseProtocolContent('{}')) === empty &&
  JSON.stringify(parseProtocolContent('{"items": 42}')) === empty
    ? ok('null / malformed / foreign shapes all read as an empty protocol')
    : bad('forgiving parse');
  const parsed = parseProtocolContent(
    JSON.stringify({
      items: [
        { title: '  Creatine  ', scheduled_time: '07:30', dose: '5 g', junk: true },
        { title: '', dose: 'ignored' },
        'not an object',
        { title: 'Walk', scheduled_time: '99:99' },
      ],
    })
  );
  JSON.stringify(parsed) ===
  JSON.stringify({
    items: [
      { title: 'Creatine', scheduled_time: '07:30', dose: '5 g', notes: null },
      { title: 'Walk', scheduled_time: null, dose: null, notes: null },
    ],
  })
    ? ok('titled items normalize (trim, junk keys dropped, bad times nulled); untitled dropped')
    : bad('normalize', JSON.stringify(parsed));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
