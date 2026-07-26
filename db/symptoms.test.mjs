/**
 * Headless test of the symptom data layer — the symptoms table
 * (0004_symptoms.sql), its repository (symptoms.ts), and its integration into
 * the Log feed (logs.ts) — against real SQLite via node:sqlite. Mirrors
 * db/nutrition.test.mjs; op-sqlite is never loaded. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { todayISODate } from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { listTodayEntries } from '../src/lib/db/repositories/logs.ts';
import { listTodaySymptoms, logSymptom } from '../src/lib/db/repositories/symptoms.ts';

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
const OTHER_DAY = '2000-01-01';

console.log('0. migration 0004 creates the symptoms table');
{
  const { raw } = freshDb();
  const t = raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='symptoms'")
    .get();
  t ? ok('symptoms table exists') : bad('symptoms table missing');
}

console.log('1. logSymptom persists name/severity/note, source manual, v4 id');
{
  const { db, raw } = freshDb();
  const id = logSymptom(db, {
    date: TODAY,
    time: '14:20',
    name: 'Headache',
    severity: 6,
    notes: 'after screen time',
  });
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
    ? ok('returned id is a v4 UUID')
    : bad('id shape', id);
  const row = raw.prepare('SELECT * FROM symptoms WHERE id = ?').get(id);
  row &&
  row.name === 'Headache' &&
  row.severity === 6 &&
  row.time === '14:20' &&
  row.notes === 'after screen time' &&
  row.source === 'manual' &&
  row.body_area === null
    ? ok('row stored with every field, source=manual')
    : bad('row contents', JSON.stringify(row));
}

console.log('2. absent severity/time/notes store as NULL');
{
  const { db, raw } = freshDb();
  const id = logSymptom(db, { date: TODAY, name: 'Fatigue' });
  const row = raw.prepare('SELECT * FROM symptoms WHERE id = ?').get(id);
  row && row.severity === null && row.time === null && row.notes === null
    ? ok('unrated symptom stores NULLs, not zeros')
    : bad('null storage', JSON.stringify(row));
}

console.log('3. listTodaySymptoms filters to the day, orders by time (untimed last)');
{
  const { db } = freshDb();
  logSymptom(db, { date: OTHER_DAY, time: '09:00', name: 'Old ache' });
  logSymptom(db, { date: TODAY, time: '15:00', name: 'Afternoon slump' });
  logSymptom(db, { date: TODAY, time: '08:00', name: 'Morning headache' });
  logSymptom(db, { date: TODAY, time: null, name: 'Unclear nausea' });
  const list = listTodaySymptoms(db, TODAY);
  list.length === 3 && list.every((s) => s.date === TODAY)
    ? ok("only today's symptoms are listed")
    : bad('date filter', JSON.stringify(list.map((s) => s.name)));
  JSON.stringify(list.map((s) => s.name)) ===
  JSON.stringify(['Morning headache', 'Afternoon slump', 'Unclear nausea'])
    ? ok('ordered by time, untimed last')
    : bad('order', JSON.stringify(list.map((s) => s.name)));
}

console.log('4. CHECK constraints reject bad data at the DB layer');
{
  const { db } = freshDb();
  throws(() => logSymptom(db, { date: TODAY, name: 'Bad', severity: 0 }))
    ? ok('severity 0 rejected (range 1–10)')
    : bad('severity 0 accepted');
  throws(() => logSymptom(db, { date: TODAY, name: 'Bad', severity: 11 }))
    ? ok('severity 11 rejected')
    : bad('severity 11 accepted');
  throws(() => logSymptom(db, { date: '2026-7-1', name: 'Bad' }))
    ? ok('malformed date rejected by the GLOB check')
    : bad('malformed date accepted');
}

console.log('5. updated_at trigger restamps on UPDATE');
{
  const { db, raw } = freshDb();
  const id = logSymptom(db, { date: TODAY, name: 'Headache', severity: 5 });
  raw
    .prepare('UPDATE symptoms SET updated_at = ? WHERE id = ?')
    .run('2000-01-01T00:00:00.000Z', id);
  db.run('UPDATE symptoms SET severity = ? WHERE id = ?', [7, id]);
  const row = raw.prepare('SELECT updated_at FROM symptoms WHERE id = ?').get(id);
  row && row.updated_at !== '2000-01-01T00:00:00.000Z'
    ? ok('updating a symptom restamps updated_at (recursive_triggers OFF)')
    : bad('updated_at trigger', JSON.stringify(row));
}

console.log('6. a logged symptom appears in the Log feed with a severity suffix');
{
  const { db } = freshDb();
  logSymptom(db, { date: TODAY, name: 'Headache', severity: 6 });
  logSymptom(db, { date: TODAY, name: 'Fatigue' });
  const feed = listTodayEntries(db);
  const withSev = feed.find((f) => f.title === 'Headache · 6/10');
  const noSev = feed.find((f) => f.title === 'Fatigue');
  withSev && withSev.category === 'Symptom' && noSev && noSev.category === 'Symptom'
    ? ok('symptoms show in the feed, category Symptom, severity suffixed when set')
    : bad('symptom feed', JSON.stringify(feed));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
