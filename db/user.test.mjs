/**
 * Headless test of the user profile + preferences data layer — the `users` table
 * (0001_init.sql) and its repository (user.ts) — against real SQLite via
 * node:sqlite. Mirrors db/nutrition.test.mjs; op-sqlite is never loaded.
 * Run: node --import ./db/register-ts-hooks.mjs db/user.test.mjs
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  getOrCreateUser,
  getPreferences,
  setAppLockEnabled,
  setUnitPreference,
  updateProfile,
} from '../src/lib/db/repositories/user.ts';

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

console.log('1. getOrCreateUser creates exactly one row and is idempotent');
{
  const { db, raw } = freshDb();
  const a = getOrCreateUser(db);
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(a.id)
    ? ok('returns a row with a v4 UUID id')
    : bad('id shape', a.id);
  a.timezone === 'UTC' && a.preferences === '{}'
    ? ok('DB defaults applied (timezone UTC, preferences {})')
    : bad('defaults', JSON.stringify(a));
  const b = getOrCreateUser(db);
  const count = raw.prepare('SELECT count(*) c FROM users').get().c;
  b.id === a.id && count === 1
    ? ok('second call returns the same row; still exactly one user row')
    : bad('idempotency', `id match=${b.id === a.id} count=${count}`);
}

console.log('2. getPreferences returns imperial defaults on a fresh profile');
{
  const { db } = freshDb();
  const p = getPreferences(db);
  p.units.weight === 'lb' &&
  p.units.distance === 'mi' &&
  p.units.volume === 'oz' &&
  p.units.length === 'in' &&
  p.units.temperature === 'F'
    ? ok('defaults are lb / mi / oz / in / F')
    : bad('defaults', JSON.stringify(p));
}

console.log('3. setUnitPreference persists and round-trips; other units untouched');
{
  const { db } = freshDb();
  const after = setUnitPreference(db, 'weight', 'kg');
  after.units.weight === 'kg'
    ? ok('returned prefs reflect the change')
    : bad('return', JSON.stringify(after));
  const reread = getPreferences(db);
  reread.units.weight === 'kg' && reread.units.distance === 'mi' && reread.units.length === 'in'
    ? ok('persisted across a re-read; distance/length stay at defaults')
    : bad('persistence', JSON.stringify(reread));
}

console.log('4. setUnitPreference preserves unknown preference keys');
{
  const { db, raw } = freshDb();
  const user = getOrCreateUser(db);
  // Simulate a future/unknown preference already stored.
  raw
    .prepare('UPDATE users SET preferences = ? WHERE id = ?')
    .run('{"theme":"pine","units":{"distance":"km"}}', user.id);
  setUnitPreference(db, 'weight', 'kg');
  const row = raw.prepare('SELECT preferences FROM users WHERE id = ?').get(user.id);
  const parsed = JSON.parse(row.preferences);
  parsed.theme === 'pine' && parsed.units.distance === 'km' && parsed.units.weight === 'kg'
    ? ok('unknown key (theme) and prior unit (distance:km) both survive the merge')
    : bad('merge', JSON.stringify(parsed));
  const prefs = getPreferences(db);
  prefs.units.distance === 'km' && prefs.units.weight === 'kg'
    ? ok('normalised read reflects both the prior and new unit')
    : bad('normalised', JSON.stringify(prefs));
}

console.log('5. a valid-but-unexpected JSON blob normalises to defaults (never throws)');
{
  const { db, raw } = freshDb();
  const user = getOrCreateUser(db);
  // json_valid() blocks truly invalid JSON, so exercise the tolerance path with
  // a valid JSON value that isn't a preferences object (an array).
  raw.prepare('UPDATE users SET preferences = ? WHERE id = ?').run('[1,2,3]', user.id);
  const prefs = getPreferences(db);
  prefs.units.weight === 'lb' && prefs.units.temperature === 'F'
    ? ok('a non-object JSON blob normalises to defaults')
    : bad('non-object blob', JSON.stringify(prefs));
}

console.log('6. updateProfile patches only provided fields; updated_at restamps');
{
  const { db, raw } = freshDb();
  const user = getOrCreateUser(db);
  raw
    .prepare('UPDATE users SET updated_at = ? WHERE id = ?')
    .run('2000-01-01T00:00:00.000Z', user.id);
  updateProfile(db, { fullName: 'Matt', biologicalSex: 'male' });
  const row = raw.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  row.full_name === 'Matt' && row.biological_sex === 'male' && row.timezone === 'UTC'
    ? ok('name + sex set; timezone (not provided) unchanged')
    : bad('patch', JSON.stringify(row));
  row.updated_at !== '2000-01-01T00:00:00.000Z'
    ? ok('updated_at trigger restamped on UPDATE')
    : bad('updated_at', row.updated_at);
  updateProfile(db, { timezone: 'America/Los_Angeles' });
  const row2 = raw.prepare('SELECT full_name, timezone FROM users WHERE id = ?').get(user.id);
  row2.full_name === 'Matt' && row2.timezone === 'America/Los_Angeles'
    ? ok('a later patch changes timezone while keeping the earlier name')
    : bad('second patch', JSON.stringify(row2));
}

console.log('7. DB CHECKs still guard bad profile input');
{
  const { db } = freshDb();
  throws(() => updateProfile(db, { biologicalSex: 'martian' }))
    ? ok('bad biological_sex rejected by the enum CHECK')
    : bad('bad sex accepted');
  throws(() => updateProfile(db, { dateOfBirth: '13/07/1990' }))
    ? ok('malformed date_of_birth rejected by the GLOB CHECK')
    : bad('bad DOB accepted');
}

console.log('8. app lock defaults OFF and normalises from junk to OFF');
{
  const { db, raw } = freshDb();
  getPreferences(db).appLock.enabled === false
    ? ok('fresh profile has appLock.enabled false')
    : bad('default', JSON.stringify(getPreferences(db)));
  const user = getOrCreateUser(db);
  // A corrupt/foreign value must never read as enabled — the lock can't turn
  // itself on by accident.
  raw
    .prepare('UPDATE users SET preferences = ? WHERE id = ?')
    .run('{"appLock":{"enabled":"yes"}}', user.id);
  getPreferences(db).appLock.enabled === false
    ? ok('non-boolean enabled ("yes") normalises to false')
    : bad('junk enabled read as true');
  raw.prepare('UPDATE users SET preferences = ? WHERE id = ?').run('{"appLock":[true]}', user.id);
  getPreferences(db).appLock.enabled === false
    ? ok('non-object appLock section normalises to false')
    : bad('array appLock read as true');
}

console.log('9. setAppLockEnabled persists and preserves the rest of the blob');
{
  const { db, raw } = freshDb();
  const user = getOrCreateUser(db);
  raw
    .prepare('UPDATE users SET preferences = ? WHERE id = ?')
    .run('{"theme":"pine","units":{"weight":"kg"}}', user.id);
  const on = setAppLockEnabled(db, true);
  on.appLock.enabled === true && on.units.weight === 'kg'
    ? ok('returned prefs: lock on, prior unit intact')
    : bad('enable return', JSON.stringify(on));
  const stored = JSON.parse(
    raw.prepare('SELECT preferences FROM users WHERE id = ?').get(user.id).preferences
  );
  stored.theme === 'pine' && stored.units.weight === 'kg' && stored.appLock.enabled === true
    ? ok('unknown key (theme) and units survive the merge; appLock persisted')
    : bad('merge', JSON.stringify(stored));
  getPreferences(db).appLock.enabled === true
    ? ok('persisted across a re-read')
    : bad('persistence');
  const off = setAppLockEnabled(db, false);
  off.appLock.enabled === false && getPreferences(db).appLock.enabled === false
    ? ok('disable round-trips too')
    : bad('disable', JSON.stringify(off));
}

console.log("10. setUnitPreference and setAppLockEnabled don't clobber each other");
{
  const { db } = freshDb();
  setAppLockEnabled(db, true);
  const afterUnit = setUnitPreference(db, 'weight', 'kg');
  afterUnit.appLock.enabled === true && afterUnit.units.weight === 'kg'
    ? ok('unit write keeps the lock on (and reports it)')
    : bad('unit write', JSON.stringify(afterUnit));
  const afterLock = setAppLockEnabled(db, false);
  afterLock.units.weight === 'kg'
    ? ok('lock write keeps the unit choice')
    : bad('lock write', JSON.stringify(afterLock));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
