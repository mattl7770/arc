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
import {
  getMeal,
  insertMealPhoto,
  listMealItems,
  listTodayMeals,
  logMeal,
  logMealWithItems,
  todayTotals,
  updateMealName,
  updateMealTime,
} from '../src/lib/db/repositories/nutrition.ts';
import {
  isValidClock,
  mealDayLabel,
  parseClockParts,
  partsFromClock,
  shiftDay,
} from '../src/lib/nutrition/meal-time.ts';

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

// === Re-timing a logged meal (owner request, 2026-08-12) =====================

const YESTERDAY = shiftDay(TODAY, -1);

console.log('9. updateMealTime rewrites the clock time in place');
{
  const { db, raw } = freshDb();
  const id = logMeal(db, { date: TODAY, time: '00:40', name: 'Late plate', kcal: 500 });
  raw.prepare('UPDATE meals SET updated_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', id);
  updateMealTime(db, id, { date: TODAY, time: '23:40' });
  const row = getMeal(db, id);
  row && row.time === '23:40' && row.date === TODAY
    ? ok('the time moves and the date is left alone')
    : bad('same-day retime', JSON.stringify(row));
  row && row.name === 'Late plate' && near(row.kcal, 500)
    ? ok('name and macros are untouched (this write owns when, nothing else)')
    : bad('collateral damage', JSON.stringify(row));
  row && row.updated_at !== '2000-01-01T00:00:00.000Z'
    ? ok('the updated_at trigger restamps the edited meal')
    : bad('updated_at after retime', JSON.stringify(row));
}

console.log('10. moving a meal across the day boundary moves BOTH days’ totals');
{
  const { db } = freshDb();
  // The motivating case: eaten at 00:40, belongs to the evening before.
  const late = logMeal(db, { date: TODAY, time: '00:40', name: 'Late plate', kcal: 500 });
  logMeal(db, { date: TODAY, time: '12:30', name: 'Lunch', kcal: 700, protein_g: 40 });
  logMeal(db, { date: YESTERDAY, time: '08:00', name: 'Breakfast', kcal: 300, protein_g: 20 });

  const beforeToday = todayTotals(db, TODAY);
  const beforeYesterday = todayTotals(db, YESTERDAY);
  near(beforeToday.kcal, 1200) && near(beforeYesterday.kcal, 300)
    ? ok('before: today 1200 kcal over 2 meals, yesterday 300 over 1')
    : bad('pre-move totals', JSON.stringify([beforeToday, beforeYesterday]));

  updateMealTime(db, late, { date: YESTERDAY, time: '23:40' });

  const afterToday = todayTotals(db, TODAY);
  const afterYesterday = todayTotals(db, YESTERDAY);
  near(afterToday.kcal, 700) && afterToday.mealCount === 1
    ? ok('the source day loses the meal and its energy')
    : bad('source day after move', JSON.stringify(afterToday));
  near(afterYesterday.kcal, 800) && afterYesterday.mealCount === 2
    ? ok('the destination day gains them — no recompute, the reads group by date')
    : bad('destination day after move', JSON.stringify(afterYesterday));
  near(afterToday.kcal + afterYesterday.kcal, beforeToday.kcal + beforeYesterday.kcal)
    ? ok('nothing is created or destroyed across the boundary')
    : bad('energy conservation', `${afterToday.kcal} + ${afterYesterday.kcal}`);

  // And the day lists follow, which is what the Eaten-today plate renders.
  listTodayMeals(db, TODAY).length === 1 &&
  JSON.stringify(listTodayMeals(db, YESTERDAY).map((m) => m.name)) ===
    JSON.stringify(['Breakfast', 'Late plate'])
    ? ok('both day lists follow, the moved meal sorted by its new time')
    : bad('day lists after move', JSON.stringify(listTodayMeals(db, YESTERDAY).map((m) => m.name)));
}

console.log('11. a meal’s time can be cleared, and an impossible clock is refused');
{
  const { db } = freshDb();
  const id = logMeal(db, { date: TODAY, time: '12:30', name: 'Lunch', kcal: 700 });
  updateMealTime(db, id, { date: TODAY, time: null });
  getMeal(db, id).time === null
    ? ok('clearing the time stores NULL (an untimed meal is a real state)')
    : bad('clear time', JSON.stringify(getMeal(db, id)));
  logMeal(db, { date: TODAY, time: '08:00', name: 'Breakfast', kcal: 200 });
  JSON.stringify(listTodayMeals(db, TODAY).map((m) => m.name)) ===
  JSON.stringify(['Breakfast', 'Lunch'])
    ? ok('the now-untimed meal sorts last in the day')
    : bad('untimed ordering', JSON.stringify(listTodayMeals(db, TODAY).map((m) => m.name)));

  // The schema's GLOB CHECK only tests the SHAPE — '99:99' passes it. The
  // repository is the layer where hours are hours.
  throws(() => updateMealTime(db, id, { date: TODAY, time: '99:99' }))
    ? ok('99:99 is refused even though the GLOB CHECK would accept it')
    : bad('99:99 accepted');
  throws(() => updateMealTime(db, id, { date: TODAY, time: '8:05' }))
    ? ok('an unpadded 8:05 is refused (the editor pads before it gets here)')
    : bad('unpadded time accepted');
  getMeal(db, id).time === null
    ? ok('a refused write changes nothing')
    : bad('refused write leaked', JSON.stringify(getMeal(db, id)));
}

console.log('12. the pure when-editor helpers (src/lib/nutrition/meal-time.ts)');
{
  shiftDay('2026-08-12', -1) === '2026-08-11' && shiftDay('2026-08-12', 1) === '2026-08-13'
    ? ok('shiftDay steps a day either way')
    : bad('shiftDay', shiftDay('2026-08-12', -1));
  shiftDay('2026-03-01', -1) === '2026-02-28' && shiftDay('2026-01-01', -1) === '2025-12-31'
    ? ok('shiftDay crosses month and year ends (2026 is not a leap year)')
    : bad('shiftDay boundaries', `${shiftDay('2026-03-01', -1)} / ${shiftDay('2026-01-01', -1)}`);
  shiftDay('2024-03-01', -1) === '2024-02-29'
    ? ok('shiftDay knows 2024-02-29 exists')
    : bad('shiftDay leap day', shiftDay('2024-03-01', -1));

  mealDayLabel('2026-08-12', '2026-08-12') === 'Today' &&
  mealDayLabel('2026-08-11', '2026-08-12') === 'Yesterday'
    ? ok('mealDayLabel names today and yesterday')
    : bad('mealDayLabel near', mealDayLabel('2026-08-11', '2026-08-12'));
  mealDayLabel('2026-08-01', '2026-08-12') === 'Sat 1 Aug'
    ? ok('an older day in this year is an unambiguous weekday + date')
    : bad('mealDayLabel far', mealDayLabel('2026-08-01', '2026-08-12'));
  mealDayLabel('2025-08-01', '2026-08-12') === 'Fri 1 Aug 2025'
    ? ok('a day in another year carries the year — a stepper can reach one')
    : bad('mealDayLabel year', mealDayLabel('2025-08-01', '2026-08-12'));

  parseClockParts('8', '5').kind === 'time' && parseClockParts('8', '5').value === '08:05'
    ? ok('parseClockParts pads what a number pad actually produces')
    : bad('parseClockParts pad', JSON.stringify(parseClockParts('8', '5')));
  parseClockParts('23', '').value === '23:00'
    ? ok('a blank minute field reads as :00')
    : bad('blank minute', JSON.stringify(parseClockParts('23', '')));
  parseClockParts('', '').kind === 'none'
    ? ok('both fields blank is "none" — a clearable time, not a failure')
    : bad('blank clock', JSON.stringify(parseClockParts('', '')));
  parseClockParts('24', '00').kind === 'invalid' &&
  parseClockParts('12', '60').kind === 'invalid' &&
  parseClockParts('x', '00').kind === 'invalid'
    ? ok('24:00, 12:60 and non-digits are "invalid" — Save goes inert')
    : bad('invalid clocks accepted');

  isValidClock(null) && isValidClock('23:59') && !isValidClock('99:99') && !isValidClock('8:05')
    ? ok('isValidClock accepts NULL and real clocks, rejects the GLOB-shaped lies')
    : bad('isValidClock');

  JSON.stringify(partsFromClock('08:05')) === JSON.stringify({ hour: '08', minute: '05' }) &&
  JSON.stringify(partsFromClock(null)) === JSON.stringify({ hour: '', minute: '' })
    ? ok('partsFromClock round-trips, and an untimed meal opens the editor empty')
    : bad('partsFromClock', JSON.stringify(partsFromClock('08:05')));
}

// === Renaming a logged meal (owner request, 2026-08-15) ======================
//
// A meal's name was ALWAYS a free-text NOT NULL column (0002) — not a slot and
// not derived from the items — so the whole feature is one UPDATE of one column
// and needed no migration. What has to be pinned is therefore not that the name
// changes (it obviously does) but that NOTHING ELSE does, and that a name can
// never become blank.

console.log('13. updateMealName rewrites the name and nothing else');
{
  const { db, raw } = freshDb();
  const { mealId } = logMealWithItems(db, {
    date: TODAY,
    time: '12:30',
    name: 'Lunch',
    source: 'ai_suggested',
    notes: 'ate half of it',
    items: [
      { name: 'Chicken thigh', grams: 150, kcal: 300, protein_g: 28 },
      { name: 'Rice', grams: 200, kcal: 260, carbs_g: 57 },
    ],
  });
  insertMealPhoto(db, { meal_id: mealId, file_name: 'lunch.jpg', source: 'camera' });
  const before = getMeal(db, mealId);
  raw
    .prepare('UPDATE meals SET updated_at = ? WHERE id = ?')
    .run('2000-01-01T00:00:00.000Z', mealId);

  updateMealName(db, mealId, 'Leftover chicken and rice');

  const after = getMeal(db, mealId);
  after && after.name === 'Leftover chicken and rice'
    ? ok('the name is rewritten')
    : bad('rename', JSON.stringify(after));
  after &&
  after.date === before.date &&
  after.time === before.time &&
  near(after.kcal, before.kcal) &&
  near(after.protein_g, before.protein_g) &&
  near(after.carbs_g, before.carbs_g) &&
  after.source === 'ai_suggested' &&
  after.notes === 'ate half of it'
    ? ok('when, totals, provenance and notes are untouched (this write owns the name)')
    : bad('collateral damage', JSON.stringify(after));
  JSON.stringify(listMealItems(db, mealId).map((i) => i.name)) ===
  JSON.stringify(['Chicken thigh', 'Rice'])
    ? ok('the items survive a rename intact')
    : bad('items after rename', JSON.stringify(listMealItems(db, mealId).map((i) => i.name)));
  raw.prepare('SELECT count(*) c FROM meal_photos WHERE meal_id = ?').get(mealId).c === 1
    ? ok('the photo row survives a rename')
    : bad('photo after rename');
  after && after.updated_at !== '2000-01-01T00:00:00.000Z'
    ? ok('the updated_at trigger restamps the renamed meal')
    : bad('updated_at after rename', JSON.stringify(after));

  // The renamed meal is what the Eaten-today plate draws.
  JSON.stringify(listTodayMeals(db, TODAY).map((m) => m.name)) ===
  JSON.stringify(['Leftover chicken and rice'])
    ? ok('the day list carries the new name')
    : bad('day list after rename', JSON.stringify(listTodayMeals(db, TODAY).map((m) => m.name)));
}

console.log('14. a meal can never be renamed to nothing');
{
  const { db } = freshDb();
  const id = logMeal(db, { date: TODAY, time: '08:05', name: 'Protein oats', kcal: 620 });

  // There is no derived title to fall back to — meals.name is NOT NULL and
  // nothing reconstructs one — so an empty name is REFUSED, not stored. The
  // editor disables Save on exactly this predicate; this is the backstop.
  throws(() => updateMealName(db, id, ''))
    ? ok('an empty name is refused')
    : bad('empty name accepted');
  throws(() => updateMealName(db, id, '   '))
    ? ok('a whitespace-only name is refused too (it trims to empty)')
    : bad('whitespace name accepted');
  getMeal(db, id).name === 'Protein oats'
    ? ok('a refused rename changes nothing — the meal keeps the name it had')
    : bad('refused rename leaked', JSON.stringify(getMeal(db, id)));

  updateMealName(db, id, '  Overnight oats  ');
  getMeal(db, id).name === 'Overnight oats'
    ? ok('a name is trimmed before it is stored')
    : bad('untrimmed name', JSON.stringify(getMeal(db, id)));

  // Renaming a meal to what it is already called is a no-op, not an error — a
  // casing fix goes through the same path (the renameFolder rule).
  updateMealName(db, id, 'Overnight oats');
  getMeal(db, id).name === 'Overnight oats'
    ? ok('renaming a meal to its own name is allowed')
    : bad('self-rename', JSON.stringify(getMeal(db, id)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
