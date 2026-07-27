/**
 * Headless test of the reminders data layer — the reminders table
 * (0009_reminders.sql) and its repository (reminders.ts) — against real SQLite
 * via node:sqlite. Mirrors db/nutrition.test.mjs; op-sqlite is never loaded.
 * Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  completeReminder,
  createReminder,
  dismissReminder,
  isDueOn,
  listActiveReminders,
} from '../src/lib/db/repositories/reminders.ts';

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

console.log('0. migrations: 0009 (reminders) applies');
{
  const { raw } = freshDb();
  const version = raw.prepare('PRAGMA user_version').get().user_version;
  version >= 6 ? ok(`user_version is ${version} (>= 6)`) : bad('user_version', version);
  raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='reminders'`).get()
    ? ok('reminders table exists')
    : bad('reminders table missing');
}

console.log('1. createReminder persists with sane defaults, app-generated v4 id');
{
  const { db, raw } = freshDb();
  const id = createReminder(db, { title: 'Take magnesium', time: '21:00' });
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
    ? ok('returned id is a v4 UUID')
    : bad('id shape', id);
  const row = raw.prepare('SELECT * FROM reminders WHERE id = ?').get(id);
  row &&
  row.title === 'Take magnesium' &&
  row.time === '21:00' &&
  row.date === null &&
  row.repeat === 'once' &&
  row.status === 'active' &&
  row.created_by === 'user' &&
  row.created_at &&
  row.updated_at
    ? ok('row stored: repeat once, status active, created_by user')
    : bad('row contents', JSON.stringify(row));

  const aiId = createReminder(db, { title: 'Log weight', repeat: 'daily', createdBy: 'ai' });
  raw.prepare('SELECT created_by FROM reminders WHERE id = ?').get(aiId).created_by === 'ai'
    ? ok('Coach-initiated reminders record created_by = ai')
    : bad('created_by ai');
}

console.log('2. listActiveReminders: timed in clock order, untimed last, inactive gone');
{
  const { db } = freshDb();
  createReminder(db, { title: 'Evening', time: '21:00' });
  createReminder(db, { title: 'Untimed' });
  createReminder(db, { title: 'Morning', time: '07:30' });
  const done = createReminder(db, { title: 'Old one', time: '06:00' });
  completeReminder(db, done);
  const dismissed = createReminder(db, { title: 'Cancelled', time: '06:30' });
  dismissReminder(db, dismissed);

  const titles = listActiveReminders(db).map((r) => r.title);
  JSON.stringify(titles) === JSON.stringify(['Morning', 'Evening', 'Untimed'])
    ? ok('clock order, untimed last; done/dismissed filtered out')
    : bad('order/filter', JSON.stringify(titles));
}

console.log('3. status transitions restamp updated_at via the trigger');
{
  const { db, raw } = freshDb();
  const id = createReminder(db, { title: 'X' });
  raw
    .prepare('UPDATE reminders SET updated_at = ? WHERE id = ?')
    .run('2000-01-01T00:00:00.000Z', id);
  completeReminder(db, id);
  const row = raw.prepare('SELECT status, updated_at FROM reminders WHERE id = ?').get(id);
  row.status === 'done' && row.updated_at !== '2000-01-01T00:00:00.000Z'
    ? ok('completeReminder sets done and restamps updated_at')
    : bad('trigger', JSON.stringify(row));
}

console.log('4. CHECK constraints reject bad data at the DB layer');
{
  const { db, raw } = freshDb();
  throws(() => createReminder(db, { title: 'Bad', time: '9:00' }))
    ? ok('unpadded time rejected by the GLOB check')
    : bad('unpadded time accepted');
  throws(() => createReminder(db, { title: 'Bad', date: '2026-7-1' }))
    ? ok('malformed date rejected by the GLOB check')
    : bad('malformed date accepted');
  throws(() => createReminder(db, { title: 'Bad', repeat: 'hourly' }))
    ? ok('unknown repeat rejected by the enum CHECK')
    : bad('unknown repeat accepted');
  throws(() => createReminder(db, { title: 'Bad', repeat: 'weekly' }))
    ? ok('weekly without an anchor date rejected by the cross-CHECK')
    : bad('anchorless weekly accepted');
  throws(() =>
    raw.prepare(`INSERT INTO reminders (id, title, status) VALUES ('x', 'Bad', 'snoozed')`).run()
  )
    ? ok('unknown status rejected by the enum CHECK')
    : bad('unknown status accepted');
  throws(() => raw.prepare(`INSERT INTO reminders (id) VALUES ('y')`).run())
    ? ok('a reminder with no title rejected (title NOT NULL)')
    : bad('titleless reminder accepted');
}

console.log('5. isDueOn: once/daily/weekly semantics');
{
  const { db } = freshDb();
  createReminder(db, { title: 'undated-once' });
  createReminder(db, { title: 'dated-once', date: '2026-07-27' });
  createReminder(db, { title: 'daily', repeat: 'daily' });
  // 2026-07-27 is a Monday; weekly anchored there fires Mondays.
  createReminder(db, { title: 'weekly-mon', repeat: 'weekly', date: '2026-07-27' });
  const byTitle = Object.fromEntries(listActiveReminders(db).map((r) => [r.title, r]));

  isDueOn(byTitle['undated-once'], '2026-07-26') && isDueOn(byTitle['undated-once'], '2026-08-01')
    ? ok('an undated one-off is due any day')
    : bad('undated once');
  isDueOn(byTitle['dated-once'], '2026-07-27') && !isDueOn(byTitle['dated-once'], '2026-07-28')
    ? ok('a dated one-off is due only on its date')
    : bad('dated once');
  isDueOn(byTitle['daily'], '2026-07-26') && isDueOn(byTitle['daily'], '2027-01-01')
    ? ok('daily is due every day')
    : bad('daily');
  isDueOn(byTitle['weekly-mon'], '2026-08-03') && !isDueOn(byTitle['weekly-mon'], '2026-08-04')
    ? ok('weekly fires on the anchor weekday only (Mon 2026-08-03, not Tue)')
    : bad('weekly');

  const dismissed = { ...byTitle['daily'], status: 'dismissed' };
  !isDueOn(dismissed, '2026-07-26') ? ok('non-active is never due') : bad('dismissed due');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
