/**
 * Headless test of the exercise catalog — 0011_exercise_catalog.sql (exercises
 * + exercise_muscles + the seeded core) and its repository (exercise-catalog.ts)
 * — against real SQLite via node:sqlite. Mirrors db/nutrition.test.mjs;
 * op-sqlite is never loaded. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  archiveExercise,
  createCustomExercise,
  getExercise,
  listExercises,
  musclesByExercise,
} from '../src/lib/db/repositories/exercise-catalog.ts';

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

console.log('0. migration 0011 seeds the catalog (user_version reaches 13 with 0012/0013)');
{
  const { raw } = freshDb();
  raw.prepare('PRAGMA user_version').get().user_version === 13
    ? ok('user_version = 13 (max of applied migrations, gaps tolerated)')
    : bad('user_version', raw.prepare('PRAGMA user_version').get().user_version);
  const ex = raw.prepare('SELECT count(*) c FROM exercises').get().c;
  ex === 69 ? ok(`69 seeded exercises`) : bad('exercise count', ex);
  const mus = raw.prepare('SELECT count(*) c FROM exercise_muscles').get().c;
  mus === 164 ? ok('164 muscle mappings') : bad('muscle count', mus);
  const covered = raw
    .prepare("SELECT count(DISTINCT muscle) c FROM exercise_muscles WHERE role='primary'")
    .get().c;
  covered === 16
    ? ok('all 16 muscle groups appear as a primary mover')
    : bad('muscles covered', covered);
}

console.log('1. listExercises decodes muscles, aliases, and flags');
{
  const { db } = freshDb();
  const all = listExercises(db);
  all.length === 69 ? ok('lists all live exercises') : bad('list count', all.length);
  // name-ordered
  const sorted = [...all].sort((a, b) => a.name.localeCompare(b.name));
  all.map((e) => e.id).join() === sorted.map((e) => e.id).join()
    ? ok('name-ordered (COLLATE NOCASE)')
    : bad('order');
  const bench = all.find((e) => e.id === 'barbell-bench-press');
  bench &&
  bench.primaryMuscles.join() === 'chest' &&
  bench.secondaryMuscles.slice().sort().join() === 'front_delts,triceps' &&
  bench.equipment === 'barbell' &&
  bench.movementPattern === 'push_h' &&
  bench.mechanic === 'compound' &&
  bench.loggingType === 'weight_reps' &&
  !bench.isCustom
    ? ok('bench press decodes: chest primary, front_delts+triceps secondary, barbell/push_h')
    : bad('bench decode', JSON.stringify(bench));
  bench.aliases.includes('Bench Press')
    ? ok('aliases decode from JSON')
    : bad('aliases', JSON.stringify(bench.aliases));
}

console.log('2. listExercises filters: search / muscle / equipment (AND-combined)');
{
  const { db } = freshDb();
  // search matches an alias, not just the name ("RDL" → Romanian Deadlift)
  const rdl = listExercises(db, { search: 'RDL' });
  rdl.length === 1 && rdl[0].id === 'romanian-deadlift'
    ? ok('search matches an alias (RDL → Romanian Deadlift)')
    : bad('alias search', JSON.stringify(rdl.map((e) => e.id)));
  // search matches name, case-insensitively
  const squats = listExercises(db, { search: 'squat' });
  squats.length >= 4 &&
  squats.every((e) => /squat/i.test(e.name) || e.aliases.some((a) => /squat/i.test(a)))
    ? ok('search matches name case-insensitively')
    : bad('name search', JSON.stringify(squats.map((e) => e.id)));
  // muscle filter (any role)
  const chest = listExercises(db, { muscle: 'chest' });
  chest.length > 0 &&
  chest.every((e) => e.primaryMuscles.includes('chest') || e.secondaryMuscles.includes('chest'))
    ? ok('muscle filter returns only exercises touching that muscle')
    : bad('muscle filter');
  // equipment filter
  const bb = listExercises(db, { equipment: 'barbell' });
  bb.length > 0 && bb.every((e) => e.equipment === 'barbell')
    ? ok('equipment filter is exact')
    : bad('equipment filter');
  // AND-combined: barbell + chest
  const bbChest = listExercises(db, { equipment: 'barbell', muscle: 'chest' });
  bbChest.every((e) => e.equipment === 'barbell') &&
  bbChest.some((e) => e.id === 'barbell-bench-press') &&
  !bbChest.some((e) => e.equipment !== 'barbell')
    ? ok('filters AND-combine (barbell AND chest)')
    : bad('AND filters', JSON.stringify(bbChest.map((e) => e.id)));
}

console.log('3. createCustomExercise inserts exercise + muscles atomically');
{
  const { db, raw } = freshDb();
  const id = createCustomExercise(db, {
    name: 'Landmine Press',
    equipment: 'barbell',
    loggingType: 'weight_reps',
    movementPattern: 'push_v',
    mechanic: 'compound',
    unilateral: true,
    primaryMuscles: ['front_delts'],
    secondaryMuscles: ['triceps', 'chest'],
  });
  UUID_RE.test(id) ? ok('custom exercise id is a v4 UUID (not a slug)') : bad('custom id', id);
  const got = getExercise(db, id);
  got &&
  got.isCustom &&
  got.unilateral &&
  got.primaryMuscles.join() === 'front_delts' &&
  got.secondaryMuscles.slice().sort().join() === 'chest,triceps'
    ? ok('custom row is is_custom, unilateral, with its muscle mappings')
    : bad('custom decode', JSON.stringify(got));
  // it now shows in the catalog list
  listExercises(db).some((e) => e.id === id)
    ? ok('custom exercise appears in the catalog list')
    : bad('custom not listed');
  // a secondary that duplicates a primary is dropped (UNIQUE(exercise,muscle))
  const id2 = createCustomExercise(db, {
    name: 'Dup Muscle Test',
    equipment: 'dumbbell',
    loggingType: 'weight_reps',
    primaryMuscles: ['biceps'],
    secondaryMuscles: ['biceps', 'forearms'],
  });
  const rows = raw
    .prepare('SELECT muscle, role FROM exercise_muscles WHERE exercise_id = ?')
    .all(id2);
  rows.length === 2
    ? ok('a secondary duplicating a primary muscle is dropped (no UNIQUE violation)')
    : bad('dup muscle', JSON.stringify(rows));
}

console.log('4. schema guards reject bad catalog rows');
{
  const { raw } = freshDb();
  throws(() =>
    raw
      .prepare(
        "INSERT INTO exercises (id,name,equipment,logging_type) VALUES ('x','X','jetpack','weight_reps')"
      )
      .run()
  )
    ? ok('equipment outside the enum is rejected')
    : bad('equipment CHECK');
  throws(() =>
    raw
      .prepare(
        "INSERT INTO exercises (id,name,equipment,logging_type) VALUES ('x','X','barbell','vibes')"
      )
      .run()
  )
    ? ok('logging_type outside the enum is rejected')
    : bad('logging_type CHECK');
  throws(() =>
    raw
      .prepare(
        "INSERT INTO exercises (id,name,equipment,logging_type,aliases) VALUES ('x','X','barbell','weight_reps','{not json')"
      )
      .run()
  )
    ? ok('non-JSON aliases is rejected (json_valid)')
    : bad('aliases CHECK');
  throws(() =>
    raw
      .prepare(
        "INSERT INTO exercise_muscles (id,exercise_id,muscle,role) VALUES ('m','barbell-bench-press','earlobe','primary')"
      )
      .run()
  )
    ? ok('muscle outside the 16-group enum is rejected')
    : bad('muscle CHECK');
  // UNIQUE(exercise_id, muscle)
  throws(() =>
    raw
      .prepare(
        "INSERT INTO exercise_muscles (id,exercise_id,muscle,role) VALUES ('m2','barbell-bench-press','chest','secondary')"
      )
      .run()
  )
    ? ok('a duplicate (exercise, muscle) is rejected (UNIQUE)')
    : bad('unique muscle');
  // NULL id rejected
  throws(() =>
    raw
      .prepare(
        "INSERT INTO exercises (id,name,equipment,logging_type) VALUES (NULL,'X','barbell','weight_reps')"
      )
      .run()
  )
    ? ok('NULL exercise id rejected')
    : bad('NULL id');
}

console.log('5. exercise_muscles CASCADE + archive');
{
  const { db, raw } = freshDb();
  const id = createCustomExercise(db, {
    name: 'Temp Move',
    equipment: 'cable',
    loggingType: 'weight_reps',
    primaryMuscles: ['lats'],
  });
  raw.prepare('DELETE FROM exercises WHERE id = ?').run(id);
  raw.prepare('SELECT count(*) c FROM exercise_muscles WHERE exercise_id = ?').get(id).c === 0
    ? ok('deleting an exercise CASCADEs its muscle rows')
    : bad('cascade');
  // archive hides from the list but keeps the row + reads via getExercise
  archiveExercise(db, 'barbell-bench-press');
  !listExercises(db).some((e) => e.id === 'barbell-bench-press')
    ? ok('archived exercise drops out of the catalog list')
    : bad('archive list');
  getExercise(db, 'barbell-bench-press')?.id === 'barbell-bench-press'
    ? ok('…but getExercise still resolves it (history stays readable)')
    : bad('archive get');
}

console.log('6. musclesByExercise batches the mapping for many ids');
{
  const { db } = freshDb();
  const map = musclesByExercise(db, ['barbell-bench-press', 'barbell-back-squat', 'nope']);
  map.get('barbell-bench-press')?.primary.join() === 'chest' &&
  map.get('barbell-back-squat')?.primary.join() === 'quads' &&
  !map.has('nope')
    ? ok('returns primary/secondary per id, skips unknown ids')
    : bad('musclesByExercise', JSON.stringify([...map]));
  musclesByExercise(db, []).size === 0 ? ok('empty input → empty map') : bad('empty batch');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
