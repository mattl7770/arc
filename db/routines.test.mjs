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
import { blockSegments, moveBlockSegment } from '../src/lib/exercise/block-order.ts';
import {
  canReorderLines,
  moveRoutineLine,
  newRoutineLine,
  openRoutineList,
  routineExerciseInputs,
  routineLines,
  routineLineTargets,
  routineListReducer,
  showsOrder,
} from '../src/lib/exercise/routine-lines.ts';

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

// ---------------------------------------------------------------------------
// Owner, on the device, 2026-09-23: "be able to reorder exercises in a
// workout." The saved-workout editor (app/routine-edit.tsx) could only append
// and remove, so moving a line meant retyping its targets. It now moves lines
// with the session's own helper (block-order.ts, via routine-lines.ts) and
// saves them through the unchanged updateRoutine / createRoutine.
console.log('8. saved-workout reorder: a line moves whole, and Save keeps the new order');
{
  const { db, raw } = freshDb();
  const line = (exerciseId, targetSets, repLow, repHigh, restSec) => ({
    exerciseId,
    targetSets,
    repLow,
    repHigh,
    restSec,
  });
  const id = createRoutine(db, {
    name: 'Upper B',
    notes: 'pull focus',
    exercises: [
      line('barbell-bench-press', 4, 5, 8, 180),
      line('barbell-row', 4, 6, 10, 150),
      line('lateral-raise', 3, 12, 20, 60),
      // A hold: no rep range and no rest — the nulls must survive the move too.
      line('plank', 3, null, null, null),
    ],
  });
  const detail = getRoutine(db, id);
  const stored = Object.fromEntries(detail.exercises.map((e) => [e.exerciseId, e]));
  const lines = routineLines(detail);
  const [bench, row, lateral, plank] = lines;
  const ids = (ls) => ls.map((l) => l.exerciseId).join();

  lines.every((l) => l.linkedToNext === false) && blockSegments(lines).length === lines.length
    ? ok('a saved workout opens with no superset: every line is its own movable unit')
    : bad('opened binds', JSON.stringify(blockSegments(lines)));
  plank.sets === '3' && plank.repLow === '' && plank.repHigh === '' && plank.rest === ''
    ? ok('a stored null range / rest opens as a blank field, not "null" or "0"')
    : bad('plank line', JSON.stringify(plank));

  // The plank to the top: three presses up, one place at a time.
  let moved = lines;
  for (let i = 0; i < 3; i++) moved = moveRoutineLine(moved, plank.key, -1);
  ids(moved) === 'plank,barbell-bench-press,barbell-row,lateral-raise'
    ? ok('each press moves a line one place, past exactly one neighbour')
    : bad('moved order', ids(moved));
  moveRoutineLine(moved, plank.key, -1) === null && moveRoutineLine(moved, lateral.key, 1) === null
    ? ok('a line at either end cannot move further — null, so the arrow is drawn off')
    : bad('edge moves');
  lines.every((l) => moved.includes(l)) && ids(lines) === ids(detail.exercises)
    ? ok('a move copies no line and leaves the list it was given untouched')
    : bad('lines copied or mutated');
  JSON.stringify(moveRoutineLine(lines, row.key, 1)) ===
  JSON.stringify(moveBlockSegment(lines, row.key, 1))
    ? ok('the editor’s move IS the session’s moveBlockSegment — no second ordering rule')
    : bad('move differs from moveBlockSegment');

  // Targets typed on a line before it moves travel with it.
  moved = moved.map((l) =>
    l.key === row.key ? { ...l, sets: '5', repLow: '8', repHigh: '12', rest: '90' } : l
  );
  moved = moveRoutineLine(moved, row.key, -1);
  ids(moved) === 'plank,barbell-row,barbell-bench-press,lateral-raise' &&
  moved[1].sets === '5' &&
  moved[1].rest === '90'
    ? ok('an edit made before a move rides with the line')
    : bad('edit then move', JSON.stringify(moved[1]));

  // Save: the unchanged repository call with the editor's own mapping.
  updateRoutine(db, id, {
    name: detail.name,
    notes: detail.notes,
    exercises: routineExerciseInputs(moved),
  });
  const after = getRoutine(db, id);
  ids(after.exercises) === 'plank,barbell-row,barbell-bench-press,lateral-raise' &&
  after.exercises.map((e) => e.position).join() === '1,2,3,4'
    ? ok('the saved workout reopens in the new order, positions renumbered 1..4')
    : bad('saved order', ids(after.exercises));
  const target = (e) => [e.targetSets, e.repLow, e.repHigh, e.restSec].join('/');
  const untouched = after.exercises.filter((e) => e.exerciseId !== 'barbell-row');
  untouched.every((e) => target(e) === target(stored[e.exerciseId]))
    ? ok('every line’s sets, rep range and rest are intact after the move (nulls included)')
    : bad(
        'targets',
        untouched
          .map((e) => `${e.exerciseId} ${target(e)} vs ${target(stored[e.exerciseId])}`)
          .join('; ')
      );
  target(after.exercises[1]) === '5/8/12/90'
    ? ok('…and the line edited on the way is saved with its edit, in its new place')
    : bad('edited row', target(after.exercises[1]));
  after.exercises.every(
    (e) =>
      e.exerciseName === stored[e.exerciseId].exerciseName &&
      e.primaryMuscles.join() === stored[e.exerciseId].primaryMuscles.join()
  ) &&
  after.name === 'Upper B' &&
  after.notes === 'pull focus'
    ? ok('names, muscles, the saved workout’s own name and notes are untouched')
    : bad('identity after save', JSON.stringify(after));
  raw.prepare('SELECT count(*) c FROM routine_exercises WHERE routine_id = ?').get(id).c === 4
    ? ok('four lines in, four lines out — none duplicated, none orphaned')
    : bad('line count');
  const strip = (ls) => JSON.stringify(ls.map(({ key: _key, ...rest }) => rest));
  strip(routineLines(after)) === strip(moved)
    ? ok('reopening the editor shows exactly the lines it saved')
    : bad('reopen', strip(routineLines(after)));

  // A new saved workout: lines added from the picker, typed, reordered, created.
  const fresh = [
    { ...newRoutineLine(0, 'overhead-press', 'Overhead Press', 'Front delts'), repLow: '5' },
    { ...newRoutineLine(1, 'chin-up', 'Chin-up', 'Lats'), sets: '4', rest: '120' },
  ];
  const created = getRoutine(
    db,
    createRoutine(db, {
      name: 'Pull first',
      notes: null,
      exercises: routineExerciseInputs(moveRoutineLine(fresh, 1, -1)),
    })
  );
  ids(created.exercises) === 'chin-up,overhead-press' &&
  target(created.exercises[0]) === '4///120' &&
  target(created.exercises[1]) === '3/5//'
    ? ok('a new saved workout reordered before its first Save is created in that order')
    : bad('created', created.exercises.map(target).join(' | '));

  // What Save writes for a field left blank or typed out of range.
  const clamp = (sets) =>
    routineExerciseInputs([{ ...newRoutineLine(0, 'plank', 'Plank', ''), sets }])[0].targetSets;
  clamp('') === 3 && clamp('25') === 20 && clamp('0') === 1 && clamp('4') === 4
    ? ok('sets: blank saves as 3, and a typed figure is held to 1..20')
    : bad('sets clamp', [clamp(''), clamp('25'), clamp('0'), clamp('4')].join());

  // A saved workout carries no superset — but the move is the session's, so a
  // bound pair (should one ever be stored) moves as one and a single line
  // steps past the whole pair, never into it. Save has no bind to write.
  const keys = (ls) => ls.map((l) => `${l.key}${l.linkedToNext ? '+' : ''}`).join(' ');
  const paired = [{ ...bench, linkedToNext: true }, row, lateral, plank];
  keys(moveRoutineLine(paired, row.key, 1)) === '2 0+ 1 3' &&
  keys(moveRoutineLine(paired, lateral.key, -1)) === '2 0+ 1 3'
    ? ok('a pair moves as a unit, whichever member is pressed, matching the session rule')
    : bad('pair move', keys(moveRoutineLine(paired, row.key, 1)));
  Object.keys(routineExerciseInputs(lines)[0]).join() ===
  'exerciseId,targetSets,repLow,repHigh,restSec'
    ? ok('Save writes no bind: routine_exercises has no superset column to receive one')
    : bad('input keys', Object.keys(routineExerciseInputs(lines)[0]).join());
}

// ---------------------------------------------------------------------------
// The editor's list state (routine-lines.ts `routineListReducer`). The screen
// holds it with useReducer and only dispatches, so the toggle, the move and
// Save below are the editor's own — a broken dispatch shape or a flipped
// direction fails here, not only on the phone.
console.log('9. the editor list: toggle, move, add, edit, Save — the reducer the screen holds');
{
  const { db } = freshDb();
  const id = createRoutine(db, {
    name: 'Push day',
    notes: null,
    exercises: [
      // The same movement twice — a heavy top set and a back-off line.
      { exerciseId: 'barbell-bench-press', targetSets: 1, repLow: 3, repHigh: 3, restSec: 240 },
      { exerciseId: 'barbell-row', targetSets: 4, repLow: 6, repHigh: 10, restSec: 150 },
      { exerciseId: 'barbell-bench-press', targetSets: 3, repLow: 8, repHigh: 12, restSec: 90 },
    ],
  });
  const detail = getRoutine(db, id);
  const opened = openRoutineList(detail);
  const ids = (s) => s.lines.map((l) => `${l.exerciseId}:${l.sets}`).join();
  JSON.stringify(opened.lines) === JSON.stringify(routineLines(detail)) &&
  opened.reordering === false &&
  opened.nextKey === 3
    ? ok('the editor opens on the stored lines, Order mode off, the next key after the last')
    : bad('opened', JSON.stringify(opened));
  const empty = openRoutineList(null);
  empty.lines.length === 0 && empty.nextKey === 0 && !showsOrder(empty)
    ? ok('a new saved workout opens empty, with no Order plate')
    : bad('empty open', JSON.stringify(empty));

  // Toggle: Reorder turns the Order plate on, Done turns it off.
  const ordering = routineListReducer(opened, { type: 'toggle-order' });
  showsOrder(ordering) && !showsOrder(opened)
    ? ok('Reorder switches the list to the Order plate')
    : bad('toggle on', JSON.stringify(ordering.reordering));
  !showsOrder(routineListReducer(ordering, { type: 'toggle-order' }))
    ? ok('Done switches it back to the Exercises plate')
    : bad('toggle off');

  // Move: the top bench line down past the row, then down again to the end.
  let s = routineListReducer(ordering, { type: 'move', key: 0, direction: 1 });
  ids(s) === 'barbell-row:4,barbell-bench-press:1,barbell-bench-press:3'
    ? ok('a down press moves the line one place down, not up')
    : bad('move down', ids(s));
  s = routineListReducer(s, { type: 'move', key: 0, direction: 1 });
  ids(s) === 'barbell-row:4,barbell-bench-press:3,barbell-bench-press:1'
    ? ok('…and again: the heavy line is now last, the back-off line above it')
    : bad('move down twice', ids(s));
  routineListReducer(s, { type: 'move', key: 0, direction: 1 }) === s
    ? ok('a press at the end changes nothing (the same state back)')
    : bad('end move');
  JSON.stringify(routineListReducer(s, { type: 'move', key: 2, direction: -1 }).lines) ===
  JSON.stringify(moveRoutineLine(s.lines, 2, -1))
    ? ok('the reducer’s move is moveRoutineLine, which is moveBlockSegment')
    : bad('reducer move differs');
  showsOrder(s) ? ok('moving stays in Order mode') : bad('mode lost on move');

  // Add in Order mode: a fresh key, never a reused one, even after a removal.
  s = routineListReducer(s, {
    type: 'add',
    exerciseId: 'lateral-raise',
    name: 'Lateral Raise',
    primaryMuscles: 'Side delts',
  });
  const added = s.lines[s.lines.length - 1];
  added.key === 3 && s.nextKey === 4 && added.sets === '3' && showsOrder(s)
    ? ok('an added line takes the next key, three sets, at the bottom of the Order plate')
    : bad('add', JSON.stringify(added));
  s = routineListReducer(s, { type: 'toggle-order' });
  s = routineListReducer(s, { type: 'remove', key: 3 });
  s = routineListReducer(s, {
    type: 'add',
    exerciseId: 'plank',
    name: 'Plank',
    primaryMuscles: '',
  });
  s.lines[s.lines.length - 1].key === 4
    ? ok('a key is not reused after its line is removed')
    : bad('reused key', JSON.stringify(s.lines.map((l) => l.key)));
  s = routineListReducer(s, { type: 'remove', key: 4 });

  // Edit a field after the move: only that line's target changes.
  s = routineListReducer(s, { type: 'update', key: 2, patch: { rest: '120' } });
  s.lines.find((l) => l.key === 2).rest === '120' && s.lines.find((l) => l.key === 0).rest === '240'
    ? ok('a field edit reaches its own line, wherever the line now sits')
    : bad('update', JSON.stringify(s.lines));

  // Save what the editor holds, and reopen it.
  updateRoutine(db, id, {
    name: detail.name,
    notes: detail.notes,
    exercises: routineExerciseInputs(s.lines),
  });
  const after = getRoutine(db, id);
  after.exercises
    .map((e) => `${e.exerciseId}:${e.targetSets}/${e.repLow}/${e.repHigh}/${e.restSec}`)
    .join() ===
  'barbell-row:4/6/10/150,barbell-bench-press:3/8/12/120,barbell-bench-press:1/3/3/240'
    ? ok('Save writes the editor’s order, each line with its own targets, the edit included')
    : bad('saved', JSON.stringify(after.exercises));

  // One line is nothing to put in order: the Order plate never shows for it.
  const solo = { lines: [opened.lines[0]], reordering: true, nextKey: 1 };
  !canReorderLines(solo.lines) && !showsOrder(solo)
    ? ok('one line: no Order plate, even with the mode asked for')
    : bad('solo order');
  !showsOrder(routineListReducer(solo, { type: 'toggle-order' })) &&
  routineListReducer(solo, { type: 'toggle-order' }).reordering === true
    ? ok('…and a toggle there changes nothing drawn')
    : bad('solo toggle');
}

console.log('10. an Order row names its targets, so two lines of one movement differ');
{
  const t = (sets, repLow, repHigh, rest) =>
    routineLineTargets({ ...newRoutineLine(0, 'x', 'X', ''), sets, repLow, repHigh, rest });
  const heavy = t('1', '3', '3', '240');
  const backOff = t('3', '8', '12', '90');
  heavy.text === '1 × 3 · 240 s rest' && heavy.spoken === '1 set of 3, 240 seconds rest'
    ? ok('a top set: "1 × 3 · 240 s rest", spoken without the symbol')
    : bad('heavy', JSON.stringify(heavy));
  backOff.text === '3 × 8–12 · 90 s rest' && backOff.spoken === '3 sets of 8 to 12, 90 seconds rest'
    ? ok('a rep range reads "8–12" and is spoken "8 to 12"')
    : bad('back-off', JSON.stringify(backOff));
  heavy.text !== backOff.text && heavy.spoken !== backOff.spoken
    ? ok('the two bench lines read differently, drawn and spoken')
    : bad('lines not told apart');
  const hold = t('3', '', '', '');
  hold.text === '3 sets' && hold.spoken === '3 sets'
    ? ok('a hold with no range or rest reads "3 sets"')
    : bad('hold', JSON.stringify(hold));
  const blank = t('', '5', '', '60');
  blank.text === '3 × 5 · 60 s rest'
    ? ok('blank sets reads 3 (the placeholder, and what Save writes); one rep bound reads alone')
    : bad('blank', JSON.stringify(blank));
  t('4', '', '10', '').text === '4 × 10' && t(' 2 ', ' 6 ', ' 6 ', ' ').text === '2 × 6'
    ? ok('a high bound alone, and a range whose ends match, each read as one figure')
    : bad('one-figure reps', [t('4', '', '10', '').text, t(' 2 ', ' 6 ', ' 6 ', ' ').text].join());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
