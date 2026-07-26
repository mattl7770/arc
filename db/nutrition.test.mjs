/**
 * Headless test of the Nutrition data layer — the meals table
 * (0002_nutrition.sql) and its repository (nutrition.ts) — against real SQLite
 * via node:sqlite. Mirrors db/log.test.mjs; op-sqlite is never loaded.
 * Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { todayISODate } from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { listTodayMeals, logMeal, todayTotals } from '../src/lib/db/repositories/nutrition.ts';

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
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-6;
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

console.log('0. migrations: 0002 (meals) applies on top of 0001');
{
  const { raw } = freshDb();
  // user_version is the HIGHEST applied migration — >= 2 once 0002 has run
  // (it's 3 with exercise's 0003 also present after the merge; assert the floor
  // so this stays correct as later migrations land).
  const version = raw.prepare('PRAGMA user_version').get().user_version;
  version >= 2
    ? ok(`user_version is ${version} (>= 2, 0002 applied)`)
    : bad('user_version', version);
  const meals = raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meals'")
    .get();
  meals ? ok('meals table exists') : bad('meals table missing');
}

console.log('1. logMeal persists a full meal, source manual, app-generated v4 id');
{
  const { db, raw } = freshDb();
  const id = logMeal(db, {
    date: TODAY,
    time: '08:05',
    name: 'Breakfast · Protein Forward',
    kcal: 640,
    protein_g: 42,
    carbs_g: 30,
    fat_g: 28,
  });
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
    ? ok('returned id is a v4 UUID')
    : bad('id shape', id);
  const row = raw.prepare('SELECT * FROM meals WHERE id = ?').get(id);
  row &&
  row.date === TODAY &&
  row.time === '08:05' &&
  row.name === 'Breakfast · Protein Forward' &&
  near(row.kcal, 640) &&
  near(row.protein_g, 42) &&
  near(row.carbs_g, 30) &&
  near(row.fat_g, 28) &&
  row.source === 'manual' &&
  row.notes === null
    ? ok('row stored with every field and source=manual')
    : bad('row contents', JSON.stringify(row));
  row && row.created_at && row.updated_at
    ? ok('created_at / updated_at stamped by the DB defaults')
    : bad('timestamps', JSON.stringify(row));
}

console.log('2. absent macros store as NULL (not 0), and a null time is allowed');
{
  const { db, raw } = freshDb();
  const id = logMeal(db, { date: TODAY, time: null, name: 'Late snack', kcal: 200 });
  const row = raw.prepare('SELECT * FROM meals WHERE id = ?').get(id);
  row && row.time === null && row.protein_g === null && row.carbs_g === null && row.fat_g === null
    ? ok('unrecorded time/macros are NULL')
    : bad('null storage', JSON.stringify(row));
}

console.log('3. updated_at trigger restamps on UPDATE');
{
  const { db, raw } = freshDb();
  const id = logMeal(db, { date: TODAY, time: '12:30', name: 'Lunch', kcal: 700 });
  raw.prepare('UPDATE meals SET updated_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', id);
  db.run('UPDATE meals SET name = ? WHERE id = ?', ['Lunch · Template B', id]);
  const row = raw.prepare('SELECT updated_at FROM meals WHERE id = ?').get(id);
  row && row.updated_at !== '2000-01-01T00:00:00.000Z'
    ? ok('updating a meal restamps updated_at (no recursion — recursive_triggers OFF)')
    : bad('updated_at trigger', JSON.stringify(row));
}

console.log('4. listTodayMeals filters to the day and sorts by time, untimed last');
{
  const { db } = freshDb();
  logMeal(db, { date: OTHER_DAY, time: '09:00', name: 'Yesterday breakfast', kcal: 500 });
  logMeal(db, { date: TODAY, time: '12:30', name: 'Lunch', kcal: 720 });
  logMeal(db, { date: TODAY, time: '08:05', name: 'Breakfast', kcal: 640 });
  logMeal(db, { date: TODAY, time: null, name: 'Untimed shake', kcal: 220 });
  const meals = listTodayMeals(db, TODAY);
  meals.length === 3 && meals.every((m) => m.date === TODAY)
    ? ok("only today's meals are listed")
    : bad('date filter', JSON.stringify(meals.map((m) => m.name)));
  JSON.stringify(meals.map((m) => m.name)) ===
  JSON.stringify(['Breakfast', 'Lunch', 'Untimed shake'])
    ? ok('ordered by eating time, untimed meal last')
    : bad('order', JSON.stringify(meals.map((m) => m.name)));
}

console.log('5. todayTotals sums the day; NULL macros are skipped, not zeroing');
{
  const { db } = freshDb();
  logMeal(db, { date: TODAY, time: '08:05', name: 'Breakfast', kcal: 640, protein_g: 42 });
  logMeal(db, {
    date: TODAY,
    time: '12:30',
    name: 'Lunch',
    kcal: 720,
    protein_g: 48,
    carbs_g: 60,
    fat_g: 30,
  });
  logMeal(db, { date: OTHER_DAY, time: '12:30', name: 'Old lunch', kcal: 999 });
  const t = todayTotals(db, TODAY);
  near(t.kcal, 1360) && near(t.protein_g, 90) && near(t.carbs_g, 60) && near(t.fat_g, 30)
    ? ok('kcal and macro sums are right, across only today')
    : bad('sums', JSON.stringify(t));
  t.mealCount === 2 ? ok('mealCount counts today only') : bad('mealCount', t.mealCount);
}

console.log('6. empty-safe: a day with no meals reads as zeros, not NULLs');
{
  const { db } = freshDb();
  const t = todayTotals(db, TODAY);
  t.kcal === 0 && t.protein_g === 0 && t.carbs_g === 0 && t.fat_g === 0 && t.mealCount === 0
    ? ok('todayTotals is all zeros on an empty day')
    : bad('empty totals', JSON.stringify(t));
  listTodayMeals(db, TODAY).length === 0
    ? ok('listTodayMeals is an empty array')
    : bad('empty list');
}

console.log('7. CHECK constraints reject bad data at the DB layer');
{
  const { db } = freshDb();
  throws(() => logMeal(db, { date: TODAY, time: '08:05', name: 'Bad', kcal: -1 }))
    ? ok('negative kcal rejected')
    : bad('negative kcal accepted');
  throws(() => logMeal(db, { date: TODAY, time: '08:05', name: 'Bad', protein_g: -5 }))
    ? ok('negative protein rejected')
    : bad('negative protein accepted');
  throws(() => logMeal(db, { date: '2026-7-1', time: '08:05', name: 'Bad' }))
    ? ok('malformed date rejected by the GLOB check')
    : bad('malformed date accepted');
  throws(() => logMeal(db, { date: TODAY, time: '8:05', name: 'Bad' }))
    ? ok('unpadded time rejected by the GLOB check (the UI normalizes to HH:MM)')
    : bad('unpadded time accepted');
  throws(() =>
    db.run(`INSERT INTO meals (id, date, name, source) VALUES ('x', ?, 'Bad', 'carrier_pigeon')`, [
      TODAY,
    ])
  )
    ? ok('unknown source rejected by the enum CHECK')
    : bad('unknown source accepted');
  throws(() => db.run(`INSERT INTO meals (id, date) VALUES ('y', ?)`, [TODAY]))
    ? ok('a meal with no name rejected (name NOT NULL)')
    : bad('nameless meal accepted');
}

console.log('8. meals stay out of the mission/log tables — no daily_log side effects');
{
  const { db, raw } = freshDb();
  logMeal(db, { date: TODAY, time: '08:05', name: 'Breakfast', kcal: 640 });
  const dailyLogs = raw.prepare('SELECT count(*) c FROM daily_logs').get().c;
  const logEntries = raw.prepare('SELECT count(*) c FROM log_entries').get().c;
  dailyLogs === 0 && logEntries === 0
    ? ok('logging a meal touches only the meals table')
    : bad('side effects', `daily_logs=${dailyLogs} log_entries=${logEntries}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
