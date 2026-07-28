/**
 * Headless test of the training-programs data layer — 0020_programs.sql
 * (programs + program_days + program_weeks) and its repository (programs.ts) —
 * against real SQLite via node:sqlite. Mirrors db/nutrition.test.mjs; op-sqlite
 * is never loaded. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { createRoutine } from '../src/lib/db/repositories/routines.ts';
import {
  activateProgram,
  createProgram,
  deactivateProgram,
  deleteProgram,
  getActiveProgram,
  getProgram,
  listPrograms,
  scheduledToday,
  updateProgram,
} from '../src/lib/db/repositories/programs.ts';

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

/** Two routines to schedule; returns their ids. */
function seedRoutines(db) {
  const push = createRoutine(db, {
    name: 'Push',
    notes: null,
    exercises: [
      { exerciseId: 'barbell-bench-press', targetSets: 4, repLow: 5, repHigh: 8, restSec: 180 },
    ],
  });
  const legs = createRoutine(db, {
    name: 'Legs',
    notes: null,
    exercises: [
      { exerciseId: 'barbell-back-squat', targetSets: 5, repLow: 3, repHigh: 5, restSec: 240 },
    ],
  });
  return { push, legs };
}

// 2026-07-20 is a Monday (verified in exercise.test.mjs week math).
const MONDAY = '2026-07-20';

console.log('0. migration 0020 creates all three program tables');
{
  const { raw } = freshDb();
  const names = raw
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('programs','program_days','program_weeks') ORDER BY name"
    )
    .all()
    .map((r) => r.name);
  JSON.stringify(names) === JSON.stringify(['program_days', 'program_weeks', 'programs'])
    ? ok('programs + program_days + program_weeks exist')
    : bad('tables', JSON.stringify(names));
  raw.prepare('PRAGMA user_version').get().user_version >= 20
    ? ok('user_version >= 20')
    : bad('user_version');
}

console.log('1. createProgram + getProgram round-trips split + week kinds');
{
  const { db } = freshDb();
  const { push, legs } = seedRoutines(db);
  const id = createProgram(db, {
    name: 'Upper/Lower 5wk',
    notes: 'mesocycle',
    weeks: 5,
    days: [
      { dow: 1, routineId: push },
      { dow: 4, routineId: legs },
    ],
    weekKinds: ['accumulation', 'accumulation', 'accumulation', 'accumulation', 'deload'],
  });
  const detail = getProgram(db, id);
  detail && detail.name === 'Upper/Lower 5wk' && detail.weeks === 5 && detail.activeStart === null
    ? ok('program identity persists, inactive by default')
    : bad('program row', JSON.stringify(detail));
  detail.days.length === 2 &&
  detail.days[0].dow === 1 &&
  detail.days[0].routineName === 'Push' &&
  detail.days[1].dow === 4 &&
  detail.days[1].routineName === 'Legs'
    ? ok('split maps weekday → routine, joined + dow-ordered')
    : bad('days', JSON.stringify(detail.days));
  detail.weekKinds.join() === 'accumulation,accumulation,accumulation,accumulation,deload'
    ? ok('weekKinds length === weeks, week 5 marked deload, rest accumulation')
    : bad('weekKinds', JSON.stringify(detail.weekKinds));
}

console.log('2. week markers store sparsely (only non-accumulation weeks)');
{
  const { db, raw } = freshDb();
  const { push } = seedRoutines(db);
  const id = createProgram(db, {
    name: 'P',
    notes: null,
    weeks: 4,
    days: [{ dow: 1, routineId: push }],
    weekKinds: ['accumulation', 'accumulation', 'accumulation', 'deload'],
  });
  raw.prepare('SELECT count(*) c FROM program_weeks WHERE program_id = ?').get(id).c === 1
    ? ok('only the deload week wrote a program_weeks row (accumulation is implied)')
    : bad('sparse weeks');
}

console.log('3. scheduledToday derives the session from active_start + weekday');
{
  const { db } = freshDb();
  const { push, legs } = seedRoutines(db);
  const id = createProgram(db, {
    name: 'PL',
    notes: null,
    weeks: 5,
    days: [
      { dow: 1, routineId: push },
      { dow: 4, routineId: legs },
    ],
    weekKinds: ['accumulation', 'accumulation', 'accumulation', 'accumulation', 'deload'],
  });
  scheduledToday(db, MONDAY) === null
    ? ok('inactive program → no scheduled session')
    : bad('should be null');
  activateProgram(db, id, MONDAY);

  const mon = scheduledToday(db, MONDAY);
  mon &&
  mon.kind === 'train' &&
  mon.routineName === 'Push' &&
  mon.program.week === 1 &&
  mon.program.weeks === 5 &&
  mon.program.weekKind === 'accumulation'
    ? ok('Mon week 1 → train Push, week 1 of 5, accumulation')
    : bad('monday', JSON.stringify(mon));

  const thu = scheduledToday(db, '2026-07-23'); // Thursday, week 1
  thu && thu.kind === 'train' && thu.routineName === 'Legs'
    ? ok('Thu week 1 → train Legs')
    : bad('thursday', JSON.stringify(thu));

  const tue = scheduledToday(db, '2026-07-21'); // Tuesday — no day mapped
  tue && tue.kind === 'rest' && tue.program.week === 1
    ? ok('Tue (no routine mapped) → rest day, week 1')
    : bad('tuesday', JSON.stringify(tue));

  const deloadMon = scheduledToday(db, '2026-08-17'); // Monday, +28d → week 5
  deloadMon &&
  deloadMon.kind === 'train' &&
  deloadMon.routineName === 'Push' &&
  deloadMon.program.week === 5 &&
  deloadMon.program.weekKind === 'deload'
    ? ok('Mon of week 5 → train Push, flagged deload')
    : bad('deload week', JSON.stringify(deloadMon));

  const finished = scheduledToday(db, '2026-08-24'); // +35d → week 6 > 5
  finished === null
    ? ok('past the last week → no scheduled session (program ended)')
    : bad('finished', JSON.stringify(finished));

  const beforeStart = scheduledToday(db, '2026-07-13'); // a week before active_start
  beforeStart === null ? ok('before the start date → no scheduled session') : bad('before start');
}

console.log('4. activation is exclusive (one program runs at a time)');
{
  const { db } = freshDb();
  const { push } = seedRoutines(db);
  const a = createProgram(db, {
    name: 'A',
    notes: null,
    weeks: 4,
    days: [{ dow: 1, routineId: push }],
    weekKinds: ['accumulation', 'accumulation', 'accumulation', 'accumulation'],
  });
  const b = createProgram(db, {
    name: 'B',
    notes: null,
    weeks: 4,
    days: [{ dow: 2, routineId: push }],
    weekKinds: ['accumulation', 'accumulation', 'accumulation', 'accumulation'],
  });
  activateProgram(db, a, MONDAY);
  getActiveProgram(db)?.id === a ? ok('activating A makes it the active program') : bad('active A');
  activateProgram(db, b, MONDAY);
  const active = getActiveProgram(db);
  active?.id === b && getProgram(db, a).activeStart === null
    ? ok('activating B clears A (exactly one active)')
    : bad('exclusive activation', JSON.stringify(active));
  deactivateProgram(db, b);
  getActiveProgram(db) === undefined
    ? ok('deactivate clears the running instance')
    : bad('deactivate');
}

console.log('5. updateProgram replaces split + weeks atomically');
{
  const { db, raw } = freshDb();
  const { push, legs } = seedRoutines(db);
  const id = createProgram(db, {
    name: 'X',
    notes: null,
    weeks: 4,
    days: [{ dow: 1, routineId: push }],
    weekKinds: ['accumulation', 'accumulation', 'accumulation', 'deload'],
  });
  activateProgram(db, id, MONDAY);
  updateProgram(db, id, {
    name: 'X2',
    notes: 'edited',
    weeks: 6,
    days: [
      { dow: 2, routineId: legs },
      { dow: 5, routineId: push },
    ],
    weekKinds: [
      'accumulation',
      'accumulation',
      'accumulation',
      'accumulation',
      'accumulation',
      'deload',
    ],
  });
  const detail = getProgram(db, id);
  detail.name === 'X2' &&
  detail.weeks === 6 &&
  detail.days.map((d) => `${d.dow}:${d.routineName}`).join() === '2:Legs,5:Push' &&
  detail.weekKinds[5] === 'deload' &&
  detail.activeStart === MONDAY
    ? ok('identity + split + weeks replaced; active_start preserved')
    : bad('update', JSON.stringify(detail));
  raw.prepare('SELECT count(*) c FROM program_days WHERE program_id = ?').get(id).c === 2
    ? ok('old split rows fully replaced (no orphans)')
    : bad('orphans');
}

console.log('6. delete semantics + FK guards');
{
  const { db, raw } = freshDb();
  const { push } = seedRoutines(db);
  const id = createProgram(db, {
    name: 'D',
    notes: null,
    weeks: 3,
    days: [{ dow: 1, routineId: push }],
    weekKinds: ['accumulation', 'accumulation', 'deload'],
  });
  deleteProgram(db, id);
  raw.prepare('SELECT count(*) c FROM program_days WHERE program_id = ?').get(id).c === 0 &&
  raw.prepare('SELECT count(*) c FROM program_weeks WHERE program_id = ?').get(id).c === 0
    ? ok('deleting a program CASCADEs its days + week markers')
    : bad('cascade');
  // deleting a ROUTINE cascades the program_days that point at it (day → rest)
  const id2 = createProgram(db, {
    name: 'E',
    notes: null,
    weeks: 3,
    days: [{ dow: 1, routineId: push }],
    weekKinds: ['accumulation', 'accumulation', 'accumulation'],
  });
  raw.prepare('DELETE FROM routines WHERE id = ?').run(push);
  raw.prepare('SELECT count(*) c FROM program_days WHERE program_id = ?').get(id2).c === 0
    ? ok('deleting a routine removes it from program splits (day reverts to rest)')
    : bad('routine cascade');
  // bad enums / FKs rejected
  throws(() =>
    raw
      .prepare("INSERT INTO program_weeks (id,program_id,week,kind) VALUES ('w',?,1,'bulk')")
      .run(id2)
  )
    ? ok('week kind outside the enum is rejected')
    : bad('week kind CHECK');
  throws(() =>
    raw
      .prepare("INSERT INTO program_days (id,program_id,dow,routine_id) VALUES ('d',?,9,?)")
      .run(id2, push)
  )
    ? ok('dow outside 1..7 is rejected')
    : bad('dow CHECK');
}

console.log('7. listPrograms: active first, currentWeek only for the running one');
{
  const { db } = freshDb();
  const { push } = seedRoutines(db);
  const a = createProgram(db, {
    name: 'Bravo',
    notes: null,
    weeks: 5,
    days: [{ dow: 1, routineId: push }],
    weekKinds: ['accumulation', 'accumulation', 'accumulation', 'accumulation', 'deload'],
  });
  createProgram(db, {
    name: 'Alpha',
    notes: null,
    weeks: 4,
    days: [{ dow: 1, routineId: push }],
    weekKinds: ['accumulation', 'accumulation', 'accumulation', 'accumulation'],
  });
  activateProgram(db, a, MONDAY);
  const list = listPrograms(db, '2026-08-03'); // week 3 of A (14 days in)
  list[0].name === 'Bravo' && list[0].active && list[0].currentWeek === 3
    ? ok('active program sorts first with its current week (3)')
    : bad('active first', JSON.stringify(list));
  list[1].name === 'Alpha' && !list[1].active && list[1].currentWeek === null
    ? ok('inactive program: not active, no current week')
    : bad('inactive', JSON.stringify(list[1]));
  list.every((p) => p.trainingDays === 1)
    ? ok('trainingDays counted from the split')
    : bad('trainingDays');
}

console.log('8. empty-safe');
{
  const { db } = freshDb();
  listPrograms(db, MONDAY).length === 0 ? ok('listPrograms → empty') : bad('empty list');
  getProgram(db, 'nope') === undefined ? ok('getProgram(unknown) → undefined') : bad('unknown');
  scheduledToday(db, MONDAY) === null
    ? ok('scheduledToday with no programs → null')
    : bad('no active');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
