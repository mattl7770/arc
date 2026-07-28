/**
 * Headless test of the routines data layer — 0012_routines.sql (routines +
 * routine_exercises) and its repository (routines.ts) — against real SQLite via
 * node:sqlite, plus the 0013 workouts.routine_id link. Mirrors
 * db/nutrition.test.mjs; op-sqlite is never loaded. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { logWorkout } from '../src/lib/db/repositories/exercise.ts';
import {
  createRoutine,
  deleteRoutine,
  getRoutine,
  listRoutines,
  touchRoutineStarted,
  updateRoutine,
} from '../src/lib/db/repositories/routines.ts';

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

const UPPER = {
  name: 'Upper A',
  notes: 'push focus',
  exercises: [
    { exerciseId: 'barbell-bench-press', targetSets: 4, repLow: 5, repHigh: 8, restSec: 180 },
    { exerciseId: 'barbell-row', targetSets: 4, repLow: 6, repHigh: 10, restSec: 150 },
    { exerciseId: 'lateral-raise', targetSets: 3, repLow: 12, repHigh: 20, restSec: 60 },
  ],
};

console.log('1. createRoutine + getRoutine round-trips with ordered, joined lines');
{
  const { db } = freshDb();
  const id = createRoutine(db, UPPER);
  const detail = getRoutine(db, id);
  detail && detail.name === 'Upper A' && detail.notes === 'push focus' && !detail.archived
    ? ok('routine identity persists')
    : bad('routine row', JSON.stringify(detail));
  detail.exercises.map((e) => e.position).join() === '1,2,3'
    ? ok('lines are 1-based and ordered by position')
    : bad('positions', JSON.stringify(detail.exercises.map((e) => e.position)));
  detail.exercises[0].exerciseName === 'Barbell Bench Press' &&
  detail.exercises[0].targetSets === 4 &&
  detail.exercises[0].repLow === 5 &&
  detail.exercises[0].repHigh === 8 &&
  detail.exercises[0].restSec === 180
    ? ok('each line joins its exercise name + carries its targets')
    : bad('line 1', JSON.stringify(detail.exercises[0]));
  detail.exercises[0].primaryMuscles.join() === 'chest'
    ? ok('each line carries its exercise primary muscles (for freshness scoring)')
    : bad('line muscles', JSON.stringify(detail.exercises[0].primaryMuscles));
}

console.log('2. listRoutines summarizes count + total sets, active only, name-ordered');
{
  const { db } = freshDb();
  createRoutine(db, UPPER);
  createRoutine(db, {
    name: 'Legs',
    notes: null,
    exercises: [
      { exerciseId: 'barbell-back-squat', targetSets: 5, repLow: 3, repHigh: 5, restSec: 240 },
      { exerciseId: 'romanian-deadlift', targetSets: 3, repLow: 8, repHigh: 12, restSec: 150 },
    ],
  });
  const list = listRoutines(db);
  list.map((r) => r.name).join() === 'Legs,Upper A'
    ? ok('name-ordered')
    : bad('order', JSON.stringify(list.map((r) => r.name)));
  const legs = list.find((r) => r.name === 'Legs');
  legs.exerciseCount === 2 && legs.totalSets === 8
    ? ok('exerciseCount + totalSets summarized in SQL')
    : bad('legs summary', JSON.stringify(legs));
}

console.log('3. updateRoutine replaces lines atomically (positions stay contiguous)');
{
  const { db, raw } = freshDb();
  const id = createRoutine(db, UPPER);
  updateRoutine(db, id, {
    name: 'Upper A2',
    notes: null,
    exercises: [
      { exerciseId: 'overhead-press', targetSets: 3, repLow: 5, repHigh: 8, restSec: 180 },
      { exerciseId: 'chin-up', targetSets: 3, repLow: 6, repHigh: 10, restSec: 120 },
    ],
  });
  const detail = getRoutine(db, id);
  detail.name === 'Upper A2' &&
  detail.exercises.length === 2 &&
  detail.exercises.map((e) => e.exerciseId).join() === 'overhead-press,chin-up' &&
  detail.exercises.map((e) => e.position).join() === '1,2'
    ? ok('lines fully replaced, positions re-numbered from 1')
    : bad('update', JSON.stringify(detail.exercises));
  raw.prepare('SELECT count(*) c FROM routine_exercises WHERE routine_id = ?').get(id).c === 2
    ? ok('old lines are gone (no orphans left behind)')
    : bad('orphans');
}

console.log('4. schema guards on routine_exercises');
{
  const { db, raw } = freshDb();
  const id = createRoutine(db, UPPER);
  throws(() =>
    raw
      .prepare(
        'INSERT INTO routine_exercises (id,routine_id,exercise_id,position,target_sets,rep_low,rep_high) VALUES (?,?,?,?,?,?,?)'
      )
      .run('re-x', id, 'barbell-bench-press', 1, 3, 10, 5)
  )
    ? ok('rep_low > rep_high rejected (CHECK low <= high)')
    : bad('rep range CHECK');
  throws(() =>
    raw
      .prepare(
        'INSERT INTO routine_exercises (id,routine_id,exercise_id,position,target_sets) VALUES (?,?,?,?,?)'
      )
      .run('re-y', id, 'barbell-bench-press', 1, 0)
  )
    ? ok('target_sets < 1 rejected')
    : bad('target_sets CHECK');
  throws(() =>
    raw
      .prepare(
        'INSERT INTO routine_exercises (id,routine_id,exercise_id,position,target_sets) VALUES (?,?,?,?,?)'
      )
      .run('re-z', id, 'no-such-exercise', 1, 3)
  )
    ? ok('a line referencing an unknown exercise is rejected (FK)')
    : bad('exercise FK');
}

console.log('5. delete semantics: lines CASCADE, workout link SET NULL');
{
  const { db, raw } = freshDb();
  const id = createRoutine(db, UPPER);
  // a workout run FROM this routine
  const wId = logWorkout(db, {
    date: '2026-07-26',
    name: 'Upper A',
    kind: 'strength',
    routineId: id,
  });
  raw.prepare('SELECT routine_id FROM workouts WHERE id = ?').get(wId).routine_id === id
    ? ok('a workout stores the routine it was started from')
    : bad('workout routine_id');
  deleteRoutine(db, id);
  raw.prepare('SELECT count(*) c FROM routine_exercises WHERE routine_id = ?').get(id).c === 0
    ? ok('deleting a routine CASCADEs its lines')
    : bad('cascade lines');
  const w = raw.prepare('SELECT routine_id FROM workouts WHERE id = ?').get(wId);
  w && w.routine_id === null
    ? ok('…but the workout survives, its routine_id SET NULL (history kept)')
    : bad('workout SET NULL', JSON.stringify(w));
}

console.log('6. touchRoutineStarted stamps last_started_at');
{
  const { db } = freshDb();
  const id = createRoutine(db, UPPER);
  listRoutines(db)[0].lastStartedAt === null ? ok('starts null') : bad('initial last_started');
  touchRoutineStarted(db, id, '2026-07-26T18:00:00.000Z');
  listRoutines(db)[0].lastStartedAt === '2026-07-26T18:00:00.000Z'
    ? ok('touchRoutineStarted records the instant')
    : bad('last_started', listRoutines(db)[0].lastStartedAt);
}

console.log('7. empty-safe');
{
  const { db } = freshDb();
  listRoutines(db).length === 0 ? ok('listRoutines → empty array') : bad('empty list');
  getRoutine(db, 'nope') === undefined ? ok('getRoutine(unknown) → undefined') : bad('unknown get');
  const id = createRoutine(db, { name: 'Empty', notes: null, exercises: [] });
  const detail = getRoutine(db, id);
  detail.exercises.length === 0 && listRoutines(db).find((r) => r.id === id).totalSets === 0
    ? ok('a routine with no lines is valid (0 sets)')
    : bad('empty routine');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
