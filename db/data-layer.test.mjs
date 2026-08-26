/**
 * Headless test of the data layer (repositories, seed, derivation) against real
 * SQLite via node:sqlite — the same engine op-sqlite ships. Imports the app's
 * actual TypeScript (Node strips types); op-sqlite itself is never loaded (only
 * client.ts imports it, and this test talks to the Database interface directly).
 * Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { applyConnectionPragmas } from '../src/lib/db/pragmas.ts';
import {
  getOrCreateDailyLog,
  listMission,
  setMissionStatus,
  toggleMission,
  toMissionItem,
} from '../src/lib/db/repositories/mission.ts';
import { ensureTodaySeeded, seedReferenceData } from '../src/lib/db/seed.ts';
import { deriveMissionView } from '../src/lib/home/derive-mission.ts';

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

/** A node:sqlite-backed Database (matches src/lib/db/database.ts) + migration executor. */
function makeDb(raw) {
  const database = {
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
  const executor = {
    exec: (sql) => raw.exec(sql),
    getUserVersion: () => raw.prepare('PRAGMA user_version').get().user_version,
    setUserVersion: (n) => raw.exec(`PRAGMA user_version = ${n}`),
    transaction: database.transaction,
  };
  return { database, executor };
}

function freshDb() {
  const raw = new DatabaseSync(':memory:');
  // The app connection turns FK enforcement on via this same helper; routing the
  // harness through it means dropping it from the app path fails a test here.
  applyConnectionPragmas((sql) => raw.exec(sql));
  const { database, executor } = makeDb(raw);
  migrate(executor, MIGRATIONS);
  return { raw, db: database };
}

// A tiny seed mission mirroring mock-day's shape (kept local so the test
// doesn't import '@/'-aliased app files).
const SEED = [
  {
    id: 'a',
    title: 'Morning light',
    scheduledTime: '06:45',
    category: 'Morning',
    status: 'completed',
    estimatedMinutes: 10,
    protocol: 'Circadian Base',
  },
  {
    id: 'b',
    title: 'AM stack',
    scheduledTime: '07:15',
    category: 'Supplements',
    status: 'pending',
    why: 'take with fat',
    protocol: 'Morning Stack v4',
  },
  { id: 'c', title: 'Zone 2', scheduledTime: '17:00', category: 'Training', status: 'pending' },
  { id: 'd', title: 'In bed', scheduledTime: '22:15', category: 'Evening', status: 'pending' },
];
const TODAY = '2026-07-24';

console.log('1. Reference-data seed is idempotent');
{
  const { db, raw } = freshDb();
  seedReferenceData(db);
  const afterFirst = raw.prepare('SELECT count(*) c FROM biomarkers').get().c;
  seedReferenceData(db);
  const afterSecond = raw.prepare('SELECT count(*) c FROM biomarkers').get().c;
  afterFirst > 0 ? ok(`seeded ${afterFirst} biomarkers`) : bad('biomarkers seeded');
  afterFirst === afterSecond
    ? ok('re-seeding adds no duplicates (INSERT OR IGNORE)')
    : bad('idempotent reference seed', `${afterFirst} -> ${afterSecond}`);
  raw.close();
}

console.log('2. ensureTodaySeeded plants today, then is a no-op');
{
  const { db, raw } = freshDb();
  ensureTodaySeeded(db, TODAY, SEED);
  const first = listMission(db, TODAY);
  ensureTodaySeeded(db, TODAY, SEED);
  const second = listMission(db, TODAY);
  first.length === SEED.length
    ? ok(`seeded ${first.length} mission items`)
    : bad('seed count', first.length);
  second.length === SEED.length
    ? ok('second seed is a no-op (no duplication)')
    : bad('re-seed', second.length);
}

console.log('3. listMission maps rows to view-models, ordered by time');
{
  const { db } = freshDb();
  ensureTodaySeeded(db, TODAY, SEED);
  const items = listMission(db, TODAY);
  const times = items.map((i) => i.scheduledTime);
  JSON.stringify(times) === JSON.stringify(['06:45', '07:15', '17:00', '22:15'])
    ? ok('returned in chronological order')
    : bad('mission order', JSON.stringify(times));
  const am = items.find((i) => i.title === 'AM stack');
  am &&
  am.category === 'Supplements' &&
  am.why === 'take with fat' &&
  am.protocol === 'Morning Stack v4'
    ? ok('presentation extras (category/why/protocol) round-trip through value json')
    : bad('extras round-trip', JSON.stringify(am));
  const light = items.find((i) => i.title === 'Morning light');
  light && light.status === 'completed' && light.estimatedMinutes === 10
    ? ok('status and estimate preserved')
    : bad('status/estimate', JSON.stringify(light));
}

console.log('4. setMissionStatus / toggle persist and stamp completed_at');
{
  const { db, raw } = freshDb();
  ensureTodaySeeded(db, TODAY, SEED);
  const items = listMission(db, TODAY);
  const zone2 = items.find((i) => i.title === 'Zone 2');
  setMissionStatus(db, zone2.id, 'completed');
  const afterComplete = listMission(db, TODAY).find((i) => i.id === zone2.id);
  const rowC = raw.prepare('SELECT completed_at FROM log_entries WHERE id = ?').get(zone2.id);
  afterComplete.status === 'completed'
    ? ok('setMissionStatus persists')
    : bad('status persist', afterComplete.status);
  rowC.completed_at ? ok('completed_at stamped on completion') : bad('completed_at set');
  toggleMission(db, zone2.id);
  const afterToggle = listMission(db, TODAY).find((i) => i.id === zone2.id);
  const rowT = raw.prepare('SELECT completed_at FROM log_entries WHERE id = ?').get(zone2.id);
  afterToggle.status === 'pending'
    ? ok('toggle flips completed -> pending')
    : bad('toggle', afterToggle.status);
  rowT.completed_at === null
    ? ok('completed_at cleared when un-completing')
    : bad('completed_at cleared', rowT.completed_at);
  raw.close();
}

console.log('5. updated_at trigger fires on a status write');
{
  const { db, raw } = freshDb();
  ensureTodaySeeded(db, TODAY, SEED);
  const id = listMission(db, TODAY)[0].id;
  const before = raw.prepare('SELECT updated_at FROM log_entries WHERE id = ?').get(id).updated_at;
  // Push created_at back (to prove the trigger leaves it alone) AND write a stale
  // updated_at sentinel: a live AFTER UPDATE trigger overwrites the sentinel with
  // now, so `updated_at !== sentinel` is the only thing that fails when the
  // trigger is dead — a bare `>= before` admits equality and passes on a
  // non-firing trigger (the pattern wearables.test.mjs section 0 uses).
  raw.exec(
    `UPDATE log_entries SET created_at = '2000-01-01T00:00:00.000Z', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = '${id}'`
  );
  setMissionStatus(db, id, 'skipped');
  const after = raw.prepare('SELECT updated_at, created_at FROM log_entries WHERE id = ?').get(id);
  after.updated_at !== '2000-01-01T00:00:00.000Z' &&
  after.updated_at >= before &&
  after.created_at === '2000-01-01T00:00:00.000Z'
    ? ok('updated_at stamped by trigger, created_at untouched')
    : bad('updated_at trigger via repo', JSON.stringify(after));
  raw.close();
}

console.log('6. getOrCreateDailyLog is find-or-create');
{
  const { db, raw } = freshDb();
  const a = getOrCreateDailyLog(db, TODAY);
  const b = getOrCreateDailyLog(db, TODAY);
  const count = raw.prepare('SELECT count(*) c FROM daily_logs WHERE date = ?').get(TODAY).c;
  a.id === b.id && count === 1
    ? ok('returns the same row, creates only once')
    : bad('find-or-create', count);
  raw.close();
}

console.log('7. deriveMissionView: chronological split, hero, snooze');
{
  // Out-of-order: a later item completed while earlier ones pend — must NOT
  // collapse (only the leading settled run collapses).
  const items = [
    { id: 'a', title: 'x', scheduledTime: '06:45', category: 'M', status: 'completed' },
    { id: 'b', title: 'y', scheduledTime: '07:15', category: 'S', status: 'pending' },
    { id: 'c', title: 'z', scheduledTime: '12:30', category: 'N', status: 'completed' },
    { id: 'd', title: 'w', scheduledTime: '17:00', category: 'T', status: 'pending' },
  ];
  const v = deriveMissionView(items, new Set());
  v.leadingSettled.map((i) => i.id).join() === 'a'
    ? ok('only the leading settled run collapses (out-of-order stays visible)')
    : bad('leadingSettled', v.leadingSettled.map((i) => i.id).join());
  v.rest.some((i) => i.id === 'c')
    ? ok('an out-of-order completed item stays in the visible list')
    : bad('out-of-order visible');
  v.next && v.next.id === 'b' ? ok('hero = first pending item') : bad('hero', v.next && v.next.id);
  const snoozedView = deriveMissionView(items, new Set(['b']));
  snoozedView.next && snoozedView.next.id === 'd'
    ? ok('snoozing the hero advances it to the next pending item')
    : bad('snooze advances hero', snoozedView.next && snoozedView.next.id);
}

console.log('8. FK enforcement is the pragma the helper applies, not the schema');
{
  // The ON DELETE actions the schema leans on (SET NULL to preserve execution
  // history, CASCADE to clear a report's results) are inert unless the connection
  // turns foreign_keys ON — raw SQLite defaults it OFF. If the app's open path ever
  // dropped applyConnectionPragmas, every FK-dependent assertion in the labs
  // suite would still pass (each harness sets the pragma itself), while on device
  // the cascades silently stopped firing. So prove the helper is what arms them:
  // the same schema, once WITHOUT the pragma and once with it.
  //
  // node:sqlite's DatabaseSync enables foreign keys by default
  // (enableForeignKeyConstraints defaults true), unlike raw SQLite / op-sqlite —
  // so we must open with it OFF to model the device's un-pragma'd default and let
  // applyConnectionPragmas be the thing that arms enforcement.
  const schema = `
    CREATE TABLE parent (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE child (
      id TEXT PRIMARY KEY NOT NULL,
      parent_id TEXT REFERENCES parent(id) ON DELETE CASCADE
    );`;

  const without = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  without.exec(schema);
  without.exec("INSERT INTO parent (id) VALUES ('p')");
  without.exec("INSERT INTO child (id, parent_id) VALUES ('c', 'p')");
  without.exec("DELETE FROM parent WHERE id = 'p'");
  without.prepare('SELECT count(*) c FROM child').get().c === 1
    ? ok('without the pragma the CASCADE does NOT fire (FKs default OFF)')
    : bad('cascade fired without the pragma');
  without.close();

  const withPragma = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  withPragma.exec(schema);
  applyConnectionPragmas((sql) => withPragma.exec(sql));
  withPragma.exec("INSERT INTO parent (id) VALUES ('p')");
  withPragma.exec("INSERT INTO child (id, parent_id) VALUES ('c', 'p')");
  withPragma.exec("DELETE FROM parent WHERE id = 'p'");
  withPragma.prepare('SELECT count(*) c FROM child').get().c === 0
    ? ok('once the helper runs the CASCADE fires (child cleared)')
    : bad('cascade did not fire after the helper');
  withPragma.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
