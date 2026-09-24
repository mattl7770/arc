/**
 * Headless test of the Exercise data layer — the workouts/workout_sets schema
 * (0003_exercise.sql) and its repository (exercise.ts) — against real SQLite
 * via node:sqlite. Mirrors db/log.test.mjs; op-sqlite is never loaded.
 * Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  addSet,
  deleteWorkout,
  getWorkoutDetail,
  listRecentSessions,
  localWeekRange,
  logWorkout,
  replaceWorkout,
  weekSummary,
} from '../src/lib/db/repositories/exercise.ts';
import {
  clearWorkoutDraft,
  readWorkoutDraft,
  saveWorkoutDraft,
} from '../src/lib/db/repositories/workout-drafts.ts';
import {
  DRAFT_VERSION,
  liveDraftHasData,
  liveDraftMovements,
  liveDraftSetsDone,
  parseLiveDraft,
} from '../src/lib/exercise/draft.ts';
import {
  lastSessionSets,
  personalRecords,
  recentMuscleLoads,
  weeklyMuscleSets,
} from '../src/lib/db/repositories/training-stats.ts';
import { muscleFreshness } from '../src/lib/exercise/freshness.ts';
import { lbToKg, parseClock, sessionDetail, sessionTitle } from '../src/lib/exercise/format.ts';
import {
  CLOCK_ENTRY_MAX_DIGITS,
  clockFieldShows,
  clockToDigits,
  commitClock,
  digitsToClock,
  digitsToSeconds,
  pressClockKey,
  secondsToClock,
} from '../src/lib/exercise/clock-entry.ts';

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

/**
 * A migrated database. In memory by default; pass a `file` to get one on disk,
 * which §10 needs — the only way to simulate the app being killed is to close
 * the handle and open a new one over the same bytes, exactly as a relaunch does.
 */
function freshDb(file) {
  const raw = new DatabaseSync(file ?? ':memory:');
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

// Wed 2026-07-22, noon LOCAL — its Monday-start week is Jul 20 … Jul 26.
const NOW = new Date(2026, 6, 22, 12, 0, 0);

console.log('1. logWorkout + addSet persist (weight canonical kg)');
{
  const { db, raw } = freshDb();
  const id = logWorkout(
    db,
    { date: '2026-07-22', name: 'Upper A', kind: 'strength', durationMin: 52 },
    [
      { exercise: 'Bench press', reps: 8, weightKg: lbToKg(135) },
      { exercise: 'Bench press', reps: 8, weightKg: lbToKg(135) },
      { exercise: 'Chin-up', reps: 10, weightKg: null },
    ]
  );
  const w = raw.prepare('SELECT * FROM workouts').get();
  w && w.id === id && w.name === 'Upper A' && w.kind === 'strength' && near(w.duration_min, 52)
    ? ok('workout row persists with name/kind/duration')
    : bad('workout row', JSON.stringify(w));
  const sets = raw
    .prepare('SELECT * FROM workout_sets WHERE workout_id = ? ORDER BY set_index')
    .all(id);
  sets.length === 3 &&
  sets.map((s) => s.set_index).join(',') === '1,2,3' &&
  near(sets[0].weight_kg, 135 / 2.2046226218) &&
  sets[2].weight_kg === null
    ? ok('sets persist in order, weight stored as canonical kg (null for bodyweight)')
    : bad('set rows', JSON.stringify(sets));

  addSet(db, id, { exercise: 'Chin-up', reps: 8 });
  const appended = raw
    .prepare(
      'SELECT set_index, reps, weight_kg FROM workout_sets WHERE workout_id = ? ORDER BY set_index DESC'
    )
    .get(id);
  appended.set_index === 4 && appended.reps === 8 && appended.weight_kg === null
    ? ok('addSet appends, continuing the 1-based set_index')
    : bad('addSet', JSON.stringify(appended));
}

console.log('2. logWorkout is transactional — a bad set rolls back the workout');
{
  const { db, raw } = freshDb();
  throws(() =>
    logWorkout(db, { date: '2026-07-22', name: 'Upper A', kind: 'strength' }, [
      { exercise: 'Bench press', reps: -1 }, // trips the reps >= 0 CHECK
    ])
  )
    ? ok('a CHECK-violating set makes logWorkout throw')
    : bad('bad set should throw');
  const count = raw.prepare('SELECT count(*) c FROM workouts').get().c;
  count === 0
    ? ok('…and the workout row is rolled back with it (no half-saved session)')
    : bad('rollback', `${count} workout rows left behind`);
}

console.log('3. ON DELETE CASCADE — deleting a workout removes its sets');
{
  const { db, raw } = freshDb();
  const id = logWorkout(db, { date: '2026-07-22', name: 'Upper A', kind: 'strength' }, [
    { exercise: 'Bench press', reps: 8, weightKg: 60 },
    { exercise: 'Row', reps: 10, weightKg: 50 },
  ]);
  db.run('DELETE FROM workouts WHERE id = ?', [id]);
  const left = raw.prepare('SELECT count(*) c FROM workout_sets').get().c;
  left === 0
    ? ok('sets are gone with their workout (FKs ON, CASCADE enforced)')
    : bad('cascade', `${left} orphan sets`);
}

console.log('4. schema guards reject bad rows');
{
  const { db } = freshDb();
  throws(() => logWorkout(db, { date: '2026-07-22', name: 'Yoga', kind: 'yoga' }))
    ? ok("kind outside the enum ('yoga') is rejected")
    : bad('kind CHECK');
  throws(() => logWorkout(db, { date: '2026-7-22', name: 'Upper A', kind: 'strength' }))
    ? ok("malformed date ('2026-7-22') is rejected by the GLOB CHECK")
    : bad('date CHECK');
  throws(() =>
    logWorkout(db, { date: '2026-07-22', name: 'Upper A', kind: 'strength', durationMin: -5 })
  )
    ? ok('negative duration is rejected')
    : bad('duration CHECK');
  throws(() =>
    logWorkout(db, { date: '2026-07-22', name: 'Upper A', kind: 'strength' }, [
      { exercise: 'Bench press', weightKg: -60 },
    ])
  )
    ? ok('negative set weight is rejected')
    : bad('weight CHECK');
  throws(() =>
    logWorkout(db, { date: '2026-07-22', name: 'Upper A', kind: 'strength' }, [
      { exercise: 'Bench press', weightKg: 1000 },
    ])
  )
    ? ok('set weight >= 1000 kg is rejected (fat-finger bound)')
    : bad('weight upper CHECK');
}

console.log('4b. NOT NULL ids and updated_at triggers on both new tables');
{
  const { db, raw } = freshDb();
  throws(() =>
    raw
      .prepare(
        `INSERT INTO workouts (id, date, name, kind) VALUES (NULL, '2026-07-22', 'X', 'other')`
      )
      .run()
  )
    ? ok('NULL id rejected (workouts)')
    : bad('workouts NULL id');
  const id = logWorkout(db, { date: '2026-07-22', name: 'Upper A', kind: 'strength' }, [
    { exercise: 'Bench press', reps: 8, weightKg: 60 },
  ]);
  throws(() =>
    raw
      .prepare(`INSERT INTO workout_sets (id, workout_id, exercise) VALUES (NULL, ?, 'Row')`)
      .run(id)
  )
    ? ok('NULL id rejected (workout_sets)')
    : bad('workout_sets NULL id');
  // Any UPDATE — even one that tries to set updated_at itself — gets re-stamped
  // by the trigger, so a planted bogus value must not survive.
  raw.prepare(`UPDATE workouts SET updated_at = '1999-01-01T00:00:00.000Z' WHERE id = ?`).run(id);
  const w = raw.prepare('SELECT updated_at FROM workouts WHERE id = ?').get(id);
  w.updated_at !== '1999-01-01T00:00:00.000Z'
    ? ok('workouts updated_at trigger re-stamps on UPDATE')
    : bad('workouts trigger');
  raw
    .prepare(`UPDATE workout_sets SET updated_at = '1999-01-01T00:00:00.000Z' WHERE workout_id = ?`)
    .run(id);
  const s = raw.prepare('SELECT updated_at FROM workout_sets WHERE workout_id = ?').get(id);
  s.updated_at !== '1999-01-01T00:00:00.000Z'
    ? ok('workout_sets updated_at trigger re-stamps on UPDATE')
    : bad('workout_sets trigger');
}

console.log('5. weekSummary aggregates the Monday-start local week');
{
  const { db } = freshDb();
  const range = localWeekRange(NOW);
  range.start === '2026-07-20' && range.end === '2026-07-26'
    ? ok('localWeekRange(Wed Jul 22) → Mon Jul 20 … Sun Jul 26')
    : bad('week range', JSON.stringify(range));
  const sunday = localWeekRange(new Date(2026, 6, 26, 23, 0, 0));
  sunday.start === '2026-07-20'
    ? ok('a Sunday-night now still belongs to the Monday-start week')
    : bad('sunday range', JSON.stringify(sunday));

  logWorkout(db, { date: '2026-07-20', name: 'Zone 2', kind: 'cardio', durationMin: 30 });
  logWorkout(db, { date: '2026-07-21', name: 'Zone 2', kind: 'cardio', durationMin: 45 });
  logWorkout(db, { date: '2026-07-22', name: 'Upper A', kind: 'strength', durationMin: 52 });
  logWorkout(db, { date: '2026-07-22', name: 'Hips', kind: 'mobility', durationMin: 15 });
  // Out of week (previous Sunday / next Monday) — must not count.
  logWorkout(db, { date: '2026-07-19', name: 'Zone 2', kind: 'cardio', durationMin: 60 });
  logWorkout(db, { date: '2026-07-27', name: 'Lower B', kind: 'strength', durationMin: 55 });
  const week = weekSummary(db, NOW);
  near(week.zone2Min, 75)
    ? ok('Zone 2 minutes = in-week cardio only (30 + 45)')
    : bad('zone2Min', week.zone2Min);
  week.strengthSessions === 1
    ? ok('strength count = in-week strength sessions only, mobility excluded')
    : bad('strengthSessions', week.strengthSessions);
}

console.log('6. listRecentSessions orders newest-first with set counts');
{
  const { db, raw } = freshDb();
  logWorkout(db, { date: '2026-07-20', name: 'Older', kind: 'cardio', durationMin: 45 });
  const b = logWorkout(db, { date: '2026-07-22', name: 'Morning', kind: 'strength' }, [
    { exercise: 'Squat', reps: 5, weightKg: 100 },
  ]);
  const c = logWorkout(db, { date: '2026-07-22', name: 'Evening', kind: 'strength' }, [
    { exercise: 'Bench press', reps: 8, weightKg: 60 },
    { exercise: 'Row', reps: 10, weightKg: 50 },
  ]);
  // Same date: force distinct created_at so the tiebreak is deterministic.
  raw.prepare(`UPDATE workouts SET created_at = '2026-07-22T08:00:00.000Z' WHERE id = ?`).run(b);
  raw.prepare(`UPDATE workouts SET created_at = '2026-07-22T18:00:00.000Z' WHERE id = ?`).run(c);
  const sessions = listRecentSessions(db);
  sessions.map((s) => s.name).join(',') === 'Evening,Morning,Older'
    ? ok('date DESC, then created_at DESC within a date')
    : bad('order', JSON.stringify(sessions.map((s) => s.name)));
  sessions.map((s) => s.setCount).join(',') === '2,1,0'
    ? ok('each session carries its own set count (0 for the cardio row)')
    : bad('set counts', JSON.stringify(sessions.map((s) => s.setCount)));
  const detail = sessionDetail(sessions[2]);
  detail === '45 min'
    ? ok(`a set-less cardio session renders "${detail}"`)
    : bad('cardio detail', detail);
  sessionDetail(sessions[0]) === '2 sets'
    ? ok('a duration-less strength session renders "2 sets"')
    : bad('strength detail', sessionDetail(sessions[0]));

  const limited = listRecentSessions(db, 2);
  limited.length === 2 && limited[0].id === c && limited[1].id === b
    ? ok('limit truncates after ordering')
    : bad('limit', JSON.stringify(limited.map((s) => s.name)));
}

console.log('7. empty-safe on a fresh database');
{
  const { db } = freshDb();
  const week = weekSummary(db);
  week.zone2Min === 0 && week.strengthSessions === 0
    ? ok('weekSummary → zeros, not nulls')
    : bad('empty week', JSON.stringify(week));
  listRecentSessions(db).length === 0
    ? ok('listRecentSessions → empty array')
    : bad('empty sessions');
}

// ---------------------------------------------------------------------------
// Owner, 2026-08-14: "Introduce the ability to edit and view past workouts."
// The whole point of the feature is the LAST assertion in here — a correction
// has to move everything derived from the session, or the edit is cosmetic.
console.log('8. view, edit and delete a past session — and the recompute');
{
  const { db, raw } = freshDb();
  const NOW = new Date('2026-07-26T18:00:00.000Z');
  const set = (exerciseId, exercise, reps) => ({ exercise, exerciseId, reps, weightKg: 70 });
  const id = logWorkout(db, { date: '2026-07-26', kind: 'strength' }, [
    set('lat-pulldown', 'Lat Pulldown', 10),
    set('lat-pulldown', 'Lat Pulldown', 9),
    set('lat-pulldown', 'Lat Pulldown', 8),
    set('barbell-row', 'Barbell Row', 8),
    set('barbell-row', 'Barbell Row', 8),
    set('barbell-row', 'Barbell Row', 7),
    set('face-pull', 'Face Pull', 15),
  ]);
  raw.prepare('UPDATE workouts SET created_at = ? WHERE id = ?').run(NOW.toISOString(), id);

  // --- view -----------------------------------------------------------------
  const detail = getWorkoutDetail(db, id);
  detail && detail.sets.length === 7 && detail.date === '2026-07-26' && detail.kind === 'strength'
    ? ok('getWorkoutDetail returns the session and every set')
    : bad('detail', JSON.stringify(detail));
  detail.sets.map((s) => s.setIndex).join() === '1,2,3,4,5,6,7'
    ? ok('sets come back in the order they were performed')
    : bad('order', detail.sets.map((s) => s.setIndex).join());
  detail.sets[0].exerciseId === 'lat-pulldown' && detail.sets[0].reps === 10
    ? ok('each set carries its catalog id and its numbers')
    : bad('set shape', JSON.stringify(detail.sets[0]));
  getWorkoutDetail(db, 'nope') === undefined
    ? ok('an unknown id is undefined, not a throw')
    : bad('unknown id');

  const lats = () =>
    muscleFreshness(recentMuscleLoads(db, 14, NOW), NOW).find((m) => m.muscle === 'lats').freshness;
  const before = lats();
  before < 60 ? ok(`before the edit, lats read ${before}`) : bad('pre-edit freshness', before);

  // --- edit -----------------------------------------------------------------
  // The owner over-logged: it was one pulldown set, not three, and the rows are
  // gone entirely. Same call shape the editor uses — the whole set list, rewritten.
  replaceWorkout(db, id, { kind: 'strength', durationMin: 44 }, [
    set('lat-pulldown', 'Lat Pulldown', 10),
    set('face-pull', 'Face Pull', 15),
  ]);
  const edited = getWorkoutDetail(db, id);
  edited.sets.length === 2 && edited.durationMin === 44 && edited.date === '2026-07-26'
    ? ok('replaceWorkout rewrites the sets and keeps the date it happened on')
    : bad('edited', JSON.stringify(edited));
  edited.sets.map((s) => s.setIndex).join() === '1,2'
    ? ok('set_index is renumbered from 1, so the editor reopens in order')
    : bad('reindex', edited.sets.map((s) => s.setIndex).join());
  raw.prepare('SELECT count(*) c FROM workout_sets').get().c === 2
    ? ok('the replaced rows are gone, not orphaned')
    : bad('orphans', raw.prepare('SELECT count(*) c FROM workout_sets').get().c);

  // --- THE RECOMPUTE --------------------------------------------------------
  const after = lats();
  after > before
    ? ok(`editing the session moved muscle freshness: lats ${before} → ${after}`)
    : bad('freshness did not recompute', `${before} → ${after}`);
  const vol = weeklyMuscleSets(db, NOW).find((v) => v.muscle === 'lats');
  vol.sets === 1
    ? ok('weekly volume recomputed too — lats 1.0 set, down from 4.0')
    : bad('volume', JSON.stringify(vol));
  const summary = listRecentSessions(db)[0];
  summary.setCount === 2 && sessionDetail(summary) === '2 sets · 44 min'
    ? ok('the hub row follows: "2 sets · 44 min"')
    : bad('summary', sessionDetail(summary));
  sessionTitle(summary) === 'Lat Pulldown · Face Pull'
    ? ok('…and titles itself off the movements, since sessions have no names')
    : bad('title', sessionTitle(summary));

  // A rejected set rolls the whole rewrite back — a bad edit must never leave
  // the session emptied. 5000 kg trips the schema's fat-finger CHECK.
  throws(() =>
    replaceWorkout(db, id, { kind: 'strength' }, [
      { exercise: 'Lat Pulldown', exerciseId: 'lat-pulldown', reps: 8, weightKg: 5000 },
    ])
  )
    ? ok('an invalid set throws')
    : bad('bad set accepted');
  getWorkoutDetail(db, id).sets.length === 2
    ? ok('…and the session still holds the sets it had — the rewrite is atomic')
    : bad('rollback', getWorkoutDetail(db, id).sets.length);

  // --- delete ---------------------------------------------------------------
  deleteWorkout(db, id);
  getWorkoutDetail(db, id) === undefined &&
  raw.prepare('SELECT count(*) c FROM workout_sets').get().c === 0
    ? ok('deleting a session takes its sets with it (ON DELETE CASCADE)')
    : bad('delete');
  lats() === 100
    ? ok('and the freshness it contributed disappears with it')
    : bad('post-delete freshness', lats());
  deleteWorkout(db, 'nope');
  ok('deleting an unknown id is a no-op, not a throw');
}

// ---------------------------------------------------------------------------
// Owner, 2026-08-14: "Workouts dont need names, remove this."
console.log('9. sessions have no names');
{
  const { db } = freshDb();
  const id = logWorkout(db, { date: '2026-07-26', kind: 'strength' }, [
    { exercise: 'Barbell Row', exerciseId: 'barbell-row', reps: 8, weightKg: 60 },
    { exercise: 'Lat Pulldown', exerciseId: 'lat-pulldown', reps: 10, weightKg: 50 },
    { exercise: 'Face Pull', exerciseId: 'face-pull', reps: 15, weightKg: 20 },
    { exercise: 'Barbell Curl', exerciseId: 'barbell-curl', reps: 10, weightKg: 30 },
  ]);
  // The column is dormant, not gone: it is still NOT NULL, so the repository
  // has to satisfy it without asking anyone for a value.
  db.get('SELECT name FROM workouts WHERE id = ?', [id]).name === ''
    ? ok("no name supplied → '' in the dormant NOT NULL column, no throw")
    : bad('default name');
  const s = listRecentSessions(db)[0];
  sessionTitle(s) === 'Barbell Row · Lat Pulldown · Face Pull +1 more'
    ? ok('the list titles a session by its movements, capped at three')
    : bad('title', sessionTitle(s));
  const cardio = logWorkout(db, { date: '2026-07-26', kind: 'cardio', durationMin: 40 });
  sessionTitle(listRecentSessions(db).find((r) => r.id === cardio)) === 'Cardio'
    ? ok('a session with no movements falls back to its kind')
    : bad('cardio title');
  // A name that IS supplied (the Coach still passes one) is stored and simply
  // not rendered — nothing here reads it.
  const named = logWorkout(db, { date: '2026-07-26', name: 'Back day', kind: 'strength' });
  db.get('SELECT name FROM workouts WHERE id = ?', [named]).name === 'Back day'
    ? ok('a supplied name is still stored — the column keeps working')
    : bad('supplied name');
}

// ---------------------------------------------------------------------------
// Owner, 2026-09-14: "losing workout information when closing app mid workout,
// necessary for fixing when app bugs." ARC data has one copy, so this suite is
// about a session that must survive the process dying — and, just as hard, a
// draft that must never be mistaken for a workout that happened.
console.log('10. the live draft survives a kill — and never reaches the stats');
{
  const dir = mkdtempSync(join(tmpdir(), 'arc-draft-'));
  const file = join(dir, 'arc.db');
  const NOW = new Date(2026, 8, 14, 18, 0, 0); // Mon 2026-09-14, local

  // A drafted set, in full — every field, so the round-trip below compares a
  // COMPLETE object and a field added to DraftSet without being added here
  // fails loudly instead of silently not being tested.
  const set = (key, over) => ({
    key,
    weight: '',
    reps: '',
    rpe: '',
    time: '',
    distance: '',
    setType: 'normal',
    done: false,
    pr: false,
    ...over,
  });

  // A session mid-flight: three sets stamped, a fourth half-typed, a run logged
  // by time and distance, a rest timer running, one superset bound, and the
  // away-gym flag ON. Exactly what is in React state when iOS pulls the rug.
  //
  // `away: true` rather than the default, because a flag only proves it
  // round-trips when it is carrying the value that is NOT what a missing field
  // would read as (C13, 0055, DRAFT_VERSION 3). A resumed session that quietly
  // forgot it was logged in a hotel would set a false PR on the first confirm.
  const draft = {
    version: DRAFT_VERSION,
    startedAt: NOW.getTime() - 22 * 60_000,
    routineId: null,
    // 0054 — null on every session that is not filling in a watch-recorded
    // blank, which is all of them here. It rides in the draft for the same
    // reason `routineId` does: an app kill mid-fill must not forget which
    // ingested session the sets belong to.
    ingestId: null,
    restEndsAt: NOW.getTime() + 45_000,
    away: true,
    blocks: [
      {
        key: 1,
        exerciseId: 'barbell-bench-press',
        name: 'Barbell Bench Press',
        loggingType: 'weight_reps',
        measures: 'reps,load',
        mechanic: 'compound',
        restSec: 180,
        prev: [{ reps: 8, weightKg: 80, rpe: null, durationSec: null, distanceM: null }],
        bestE1rm: 101.25,
        linkedToNext: true,
        sets: [
          set(1, { weight: '80', reps: '8', rpe: '8', done: true }),
          set(2, { weight: '80', reps: '8', done: true }),
          set(3, { weight: '85', reps: '6', rpe: '9', done: true, pr: true }),
          set(4, { weight: '85' }),
        ],
      },
      {
        key: 2,
        exerciseId: 'barbell-row',
        name: 'Barbell Row',
        loggingType: 'weight_reps',
        measures: 'reps,load',
        mechanic: 'compound',
        restSec: 180,
        prev: [],
        bestE1rm: null,
        linkedToNext: false,
        sets: [set(5, { weight: '70', reps: '10', done: true })],
      },
      // B1 (0046): the block that has no reps and no load at all. It is here
      // because a draft that could only carry reps × load is exactly what the
      // version bump exists to throw away — this one has to round-trip.
      {
        key: 3,
        exerciseId: 'treadmill-run',
        name: 'Treadmill Run',
        loggingType: 'distance_duration',
        measures: 'time,distance',
        mechanic: 'compound',
        restSec: null,
        prev: [],
        bestE1rm: null,
        linkedToNext: false,
        sets: [set(6, { time: '26:40', distance: '5.2', done: true })],
      },
    ],
  };

  // --- the kill -------------------------------------------------------------
  {
    const { db, raw } = freshDb(file);
    saveWorkoutDraft(db, 'live', draft);
    raw.close(); // the process dies here — nothing else runs, no save, no cleanup
  }

  // --- reopening ------------------------------------------------------------
  const { db, raw } = freshDb(file);
  const restored = parseLiveDraft(readWorkoutDraft(db, 'live').value);
  restored ? ok('the draft is still there after the database is reopened') : bad('no draft');
  JSON.stringify(restored) === JSON.stringify(draft)
    ? ok('…and every block, set, typed character and flag came back identical')
    : bad('draft round-trip', JSON.stringify(restored));
  restored.blocks[0].sets[3].weight === '85' && restored.blocks[0].sets[3].reps === ''
    ? ok('a half-typed set survives exactly as half-typed')
    : bad('half-typed set', JSON.stringify(restored.blocks[0].sets[3]));
  restored.startedAt === draft.startedAt && restored.restEndsAt === draft.restEndsAt
    ? ok('the clock and the rest timer come back as absolute instants, not from zero')
    : bad('instants');
  restored.blocks[0].linkedToNext === true && restored.blocks[0].sets[2].pr === true
    ? ok('the superset bind and the PR stamp survive too')
    : bad('flags');
  restored.away === true
    ? ok('…and so does the away-gym flag, which a v2 draft could not have carried')
    : bad('away flag lost on resume', JSON.stringify(restored.away));
  liveDraftHasData(restored) && liveDraftSetsDone(restored) === 5
    ? ok('the hub can say what is in it: 5 sets logged')
    : bad('summary', liveDraftSetsDone(restored));
  liveDraftMovements(restored).join(' · ') === 'Barbell Bench Press · Barbell Row · Treadmill Run'
    ? ok('…and name the movements, in the order they were performed')
    : bad('movements', liveDraftMovements(restored).join());
  // 0046: the run's whole content is a time and a distance. "Is there anything
  // here" has to count those, or a finished run is not a session — no Resume
  // card, no write-through, Finish disabled on work that plainly happened.
  liveDraftHasData({
    ...restored,
    blocks: [{ ...restored.blocks[2], sets: [{ ...restored.blocks[2].sets[0], done: false }] }],
  })
    ? ok('a run with only a time and a distance typed counts as data')
    : bad('time/distance not counted as draft data');

  // --- THE EXCLUSION --------------------------------------------------------
  // The whole reason the draft is not a flagged `workouts` row. Nothing that
  // reads training can see it, because nothing that reads training reads this
  // table — there is no predicate for a future query to forget.
  raw.prepare('SELECT count(*) c FROM workout_sets').get().c === 0
    ? ok('a full draft session has written ZERO workout_sets rows')
    : bad('draft leaked sets');
  raw.prepare('SELECT count(*) c FROM workouts').get().c === 0
    ? ok('…and zero workouts rows')
    : bad('draft leaked a workout');
  const week = weekSummary(db, NOW);
  week.strengthSessions === 0 && week.zone2Min === 0
    ? ok('the week reads 0 sessions — an unfinished session is not a session')
    : bad('week summary', JSON.stringify(week));
  listRecentSessions(db).length === 0
    ? ok('recent sessions is empty — nothing to open, because nothing happened')
    : bad('recent sessions');
  recentMuscleLoads(db, 14, NOW).length === 0
    ? ok('muscle freshness sees no load: the chest is not fatigued by a draft')
    : bad('freshness leaked');
  weeklyMuscleSets(db, NOW).every((v) => v.sets === 0)
    ? ok('weekly volume counts none of it')
    : bad('volume leaked');
  personalRecords(db, 'barbell-bench-press').bestE1rmKg === null
    ? ok('and the 85 × 6 stamped PR is NOT a personal record until the session saves')
    : bad('PR leaked', personalRecords(db, 'barbell-bench-press').bestE1rmKg);
  lastSessionSets(db, 'barbell-bench-press').length === 0
    ? ok('…nor does it become "last time" in the next session’s placeholders')
    : bad('prev leaked');

  // --- finishing ------------------------------------------------------------
  // The one moment a draft becomes a workout: logWorkout, then the draft goes.
  logWorkout(db, { date: '2026-09-14', kind: 'strength', durationMin: 22 }, [
    { exercise: 'Barbell Bench Press', exerciseId: 'barbell-bench-press', reps: 8, weightKg: 80 },
  ]);
  clearWorkoutDraft(db, 'live');
  weekSummary(db, NOW).strengthSessions === 1
    ? ok('finishing lands the session in the week exactly once')
    : bad('finish');
  readWorkoutDraft(db, 'live') === null
    ? ok('…and the draft is gone with it — no Resume card over a saved workout')
    : bad('draft survived the finish');

  // --- discarding -----------------------------------------------------------
  // Abandoning is one DELETE. No half workout, no orphaned sets, no cascade.
  saveWorkoutDraft(db, 'live', draft);
  const setsBefore = raw.prepare('SELECT count(*) c FROM workout_sets').get().c;
  clearWorkoutDraft(db, 'live');
  readWorkoutDraft(db, 'live') === null &&
  raw.prepare('SELECT count(*) c FROM workout_drafts').get().c === 0
    ? ok('discarding leaves nothing behind in the draft store')
    : bad('discard');
  raw.prepare('SELECT count(*) c FROM workout_sets').get().c === setsBefore &&
  raw.prepare('SELECT count(*) c FROM workouts').get().c === 1
    ? ok('…and touches not one row of the real training history')
    : bad('discard damaged history');
  clearWorkoutDraft(db, 'live');
  ok('discarding an absent draft is a no-op, not a throw');

  // --- the two slots are independent ---------------------------------------
  saveWorkoutDraft(db, 'live', draft);
  saveWorkoutDraft(db, 'manual', { version: DRAFT_VERSION, startedAt: 1, mode: 'past' });
  clearWorkoutDraft(db, 'manual');
  readWorkoutDraft(db, 'live') !== null
    ? ok('the free-form logger’s draft is a separate slot — discarding it spares the live one')
    : bad('slots not independent');

  // --- the write is an upsert, not an append --------------------------------
  saveWorkoutDraft(db, 'live', { ...draft, restEndsAt: null });
  const rows = raw.prepare("SELECT count(*) c FROM workout_drafts WHERE key = 'live'").get().c;
  rows === 1 && parseLiveDraft(readWorkoutDraft(db, 'live').value).restEndsAt === null
    ? ok('a draft has no history, only a latest — one row per slot, overwritten')
    : bad('upsert', rows);

  // --- a draft from an older build is thrown away, never half-read ----------
  saveWorkoutDraft(db, 'live', { ...draft, version: 99 });
  parseLiveDraft(readWorkoutDraft(db, 'live').value) === null
    ? ok('a payload from another version reads as nothing to resume')
    : bad('version not enforced');
  // B1 (0046) was the first release to actually USE that: DRAFT_VERSION went
  // 1 → 2 because DraftSet grew a time and a distance. A v1 payload is a
  // complete, plausible-looking session — exactly the case where half-reading
  // it would resurrect a run as reps × load. C13 (0055) is the second: 2 → 3,
  // because LiveDraft grew `away`, and a v2 payload read as "home" would be
  // right almost always — which is the wrong standard for the one flag whose
  // job is keeping an incomparable load out of the baseline.
  DRAFT_VERSION === 3
    ? ok('DRAFT_VERSION is 3 — C13 added the away flag to the session')
    : bad('draft version', String(DRAFT_VERSION));
  saveWorkoutDraft(db, 'live', {
    version: 1,
    startedAt: NOW.getTime(),
    routineId: null,
    restEndsAt: null,
    blocks: [
      {
        key: 1,
        exerciseId: 'plank',
        name: 'Plank',
        loggingType: 'duration',
        mechanic: 'isolation',
        restSec: 60,
        prev: [],
        bestE1rm: null,
        linkedToNext: false,
        // A v1 set: no `time`, no `distance`, and a plank's hold typed into the
        // only numeric field v1 had.
        sets: [{ key: 1, weight: '', reps: '90', rpe: '', setType: 'normal', done: true }],
      },
    ],
  });
  parseLiveDraft(readWorkoutDraft(db, 'live').value) === null
    ? ok('a v1 draft evaporates — a plank does not come back as 90 reps')
    : bad('v1 draft survived the bump');
  saveWorkoutDraft(db, 'live', { version: DRAFT_VERSION, startedAt: 1, blocks: 'nonsense' });
  parseLiveDraft(readWorkoutDraft(db, 'live').value) === null
    ? ok('…and so does junk — parsing is total, never a throw on the mount path')
    : bad('junk not rejected');
  throws(() => db.run("INSERT INTO workout_drafts (id, key, value) VALUES ('x', 'nope', '{}')"))
    ? ok('the key vocabulary is CHECK-enforced: only live and manual exist')
    : bad('key CHECK missing');
  throws(() =>
    db.run("INSERT INTO workout_drafts (id, key, value) VALUES ('y', 'manual', 'not json')")
  )
    ? ok('and the payload must be JSON (json_valid)')
    : bad('json_valid missing');

  raw.close();
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// B1 / migration 0046. Owner, 2026-09-14: "Distance instead of reps for running
// workouts… time for some exercises i.e. planks." An exercise declares what it
// measures; a set carries those fields and only those.
console.log('11. an exercise declares what it measures, and a set carries only that');
{
  const { db, raw } = freshDb();
  const measuresOf = (id) => db.get('SELECT measures FROM exercises WHERE id = ?', [id])?.measures;

  // --- the backfill, on the SHIPPED catalog ---------------------------------
  // Pass 1 derives from logging_type; pass 4 corrects the carry by name.
  const expected = {
    'barbell-bench-press': 'reps,load',
    'pull-up': 'reps,load', // weighted_bodyweight collapses to reps × load
    'push-up': 'reps', // bodyweight_reps
    plank: 'time',
    'treadmill-run': 'time,distance',
    'rowing-erg': 'time,distance',
    'stationary-bike': 'time,distance',
    'incline-walk': 'time,distance',
    'farmers-carry': 'load,distance', // owner: "a farmer's carry is load + distance"
  };
  const wrong = Object.entries(expected).filter(([id, m]) => measuresOf(id) !== m);
  wrong.length === 0
    ? ok(
        'the nine shipped cases backfill exactly (plank time · run time+distance · carry load+distance)'
      )
    : bad('catalog backfill', JSON.stringify(wrong.map(([id, m]) => [id, m, measuresOf(id)])));
  // The trap the name passes are written around: four of the catalog's most-used
  // lifts are called "Row", and '*row*' would have made every one of them cardio.
  ['barbell-row', 'dumbbell-row', 'seated-cable-row', 'machine-row', 'walking-lunge'].every(
    (id) => measuresOf(id) === 'reps,load'
  )
    ? ok('…and the name passes spare Barbell/Dumbbell/Cable/Machine Row and the Walking Lunge')
    : bad('name backfill over-matched a lift');
  db.all(
    "SELECT id FROM exercises WHERE measures NOT IN ('reps','reps,load','time','time,distance','load,distance')"
  ).length === 0
    ? ok('every seeded row landed on one of the five shapes the catalog actually uses')
    : bad('stray measures');

  // --- the backfill, on a POPULATED fixture ---------------------------------
  // The real reason the by-name passes exist: the picker's New-exercise form
  // derives logging_type from EQUIPMENT alone, so every custom movement the
  // owner added is stored as a reps × load lift whatever it is. Applying 0046
  // to a database that already holds those is the case that matters, and it is
  // why this runs the migration by hand over rows inserted first.
  {
    const fresh = new DatabaseSync(':memory:');
    fresh.exec('PRAGMA foreign_keys = ON;');
    const fdb = makeDb(fresh);
    const runner = {
      exec: (sql) => fresh.exec(sql),
      getUserVersion: () => fresh.prepare('PRAGMA user_version').get().user_version,
      setUserVersion: (n) => fresh.exec(`PRAGMA user_version = ${n}`),
      transaction: fdb.transaction,
    };
    // Migrate to 0045 only — the state a device is in before this release.
    migrate(
      runner,
      MIGRATIONS.filter((m) => m.version <= 45)
    );
    const custom = [
      ['c1', 'Running', 'bodyweight', 'bodyweight_reps'],
      ['c2', 'Side Plank', 'bodyweight', 'bodyweight_reps'],
      ['c3', 'Outdoor Cycling', 'other', 'weight_reps'],
      ['c4', 'Swimming', 'other', 'weight_reps'],
      ['c5', 'Sled Push', 'other', 'weight_reps'],
      ['c6', 'Trunk Rotation', 'cable', 'weight_reps'], // contains "run"
      ['c7', 'Weighted Plank', 'plate', 'weight_duration'],
      ['c8', 'Pendlay Row', 'barbell', 'weight_reps'],
    ];
    for (const [id, name, equipment, lt] of custom) {
      fdb.run(
        'INSERT INTO exercises (id, name, equipment, logging_type, is_custom) VALUES (?, ?, ?, ?, 1)',
        [id, name, equipment, lt]
      );
    }
    // A set logged against one of them, so the ALTERs run on a NON-EMPTY table
    // — the 0034 failure mode (a constraint that passes on an empty fixture and
    // rejects the ALTER on the owner's device) can only show up here. Written
    // with raw SQL, not the repository: the repository is this build's, and
    // this database is deliberately one migration behind it.
    const w = 'w1';
    fdb.run("INSERT INTO workouts (id, date, name, kind) VALUES (?, '2026-09-01', '', 'cardio')", [
      w,
    ]);
    fdb.run(
      "INSERT INTO workout_sets (id, workout_id, exercise, exercise_id, set_index, reps) VALUES ('s1', ?, 'Running', 'c1', 1, 1)",
      [w]
    );
    migrate(runner, MIGRATIONS);
    ok('0046 applies to a populated database — the ALTERs do not reject existing rows');
    const got = Object.fromEntries(
      fresh
        .prepare('SELECT id, measures FROM exercises WHERE is_custom = 1')
        .all()
        .map((r) => [r.id, r.measures])
    );
    const want = {
      c1: 'time,distance',
      c2: 'time',
      c3: 'time,distance',
      c4: 'time,distance',
      c5: 'load,distance',
      c6: 'reps,load',
      c7: 'load,time',
      c8: 'reps,load',
    };
    JSON.stringify(got) === JSON.stringify(want)
      ? ok('custom rows the picker mis-typed are corrected by name, and only those')
      : bad('custom backfill', JSON.stringify(got));
    fresh.prepare('SELECT count(*) c FROM workout_sets WHERE workout_id = ?').get(w).c === 1
      ? ok('…and the set logged against one of them is untouched')
      : bad('backfill lost a set');
    fresh.close();
  }

  // --- the repository rule: a set carries the fields its exercise implies ----
  const id = logWorkout(db, { date: '2026-09-14', kind: 'strength' }, [
    // A plank sent reps and a weight — what the Coach would send if it guessed.
    {
      exercise: 'Plank',
      exerciseId: 'plank',
      reps: 3,
      weightKg: 20,
      durationSec: 90,
      distanceM: 400,
    },
    // A run: no reps, no load, and that is a complete set.
    { exercise: 'Treadmill Run', exerciseId: 'treadmill-run', durationSec: 2700, distanceM: 8000 },
    // Free text: nothing to imply anything, so everything is kept.
    { exercise: 'Some Machine', reps: 10, weightKg: 40 },
  ]);
  const rows = db.all(
    'SELECT exercise, reps, weight_kg, duration_sec, distance_m FROM workout_sets WHERE workout_id = ? ORDER BY set_index',
    [id]
  );
  const plank = rows[0];
  plank.reps === null && plank.weight_kg === null && plank.duration_sec === 90
    ? ok('a plank stores its 90 seconds and NULLs the reps and load it was handed')
    : bad('plank fields', JSON.stringify(plank));
  plank.distance_m === null
    ? ok('…and the distance too — a plank measures time and nothing else')
    : bad('plank distance', JSON.stringify(plank));
  const run = rows[1];
  run.reps === null &&
  run.weight_kg === null &&
  run.duration_sec === 2700 &&
  run.distance_m === 8000
    ? ok('a run with no reps and no load is a first-class row (the seam D3 lands on)')
    : bad('run fields', JSON.stringify(run));
  rows[2].reps === 10 && near(rows[2].weight_kg, 40)
    ? ok('a free-text set has no movement to imply anything, so it keeps what it was given')
    : bad('free-text fields', JSON.stringify(rows[2]));

  // --- a plank can never set an e1RM ---------------------------------------
  const prs = personalRecords(db, 'plank');
  prs.bestE1rmKg === null && prs.maxWeightKg === null && prs.bestSetVolumeKg === null
    ? ok('a plank has no e1RM, no top set and no set volume — not zero, NULL')
    : bad('plank load PRs', JSON.stringify(prs));
  prs.bestDurationSec === 90
    ? ok('…its record is the longest hold, which is the honest one')
    : bad('plank duration PR', JSON.stringify(prs));
  const runPrs = personalRecords(db, 'treadmill-run');
  runPrs.bestDistanceM === 8000 && runPrs.bestDurationSec === 2700
    ? ok('a run records farthest and longest')
    : bad('run PRs', JSON.stringify(runPrs));
  // 2700 s over 8 km = 337.5 s/km.
  near(runPrs.bestPaceSecPerKm, 337.5)
    ? ok('…and a pace, in seconds per km')
    : bad('pace PR', String(runPrs.bestPaceSecPerKm));
  runPrs.bestE1rmKg === null
    ? ok('a run has no e1RM either — e1RM needs a load AND the reps under it')
    : bad('run e1rm leaked');
  // A sprint is excluded from the pace record: its pace is real and says nothing
  // about any distance the owner trains at.
  logWorkout(db, { date: '2026-09-14', kind: 'cardio' }, [
    { exercise: 'Treadmill Run', exerciseId: 'treadmill-run', durationSec: 12, distanceM: 100 },
  ]);
  near(personalRecords(db, 'treadmill-run').bestPaceSecPerKm, 337.5)
    ? ok('a 100 m dash does not become the pace record (PACE_PR_MIN_M)')
    : bad('short piece set the pace PR');

  // --- the schema's own guards ---------------------------------------------
  throws(() => db.run("UPDATE exercises SET measures = 'load,reps' WHERE id = 'plank'"))
    ? ok('measures is a CHECK: the subset must be in canonical order, one spelling only')
    : bad('measures CHECK missing');
  throws(() => db.run("UPDATE exercises SET measures = 'vibes' WHERE id = 'plank'"))
    ? ok('…and outside the vocabulary is rejected')
    : bad('measures vocabulary');
  throws(() =>
    db.run(
      "INSERT INTO workout_sets (id, workout_id, exercise, distance_m) VALUES ('d', ?, 'X', -5)",
      [id]
    )
  )
    ? ok('distance_m is metres and cannot be negative')
    : bad('distance CHECK missing');
  raw.close();
}

// ---------------------------------------------------------------------------
// Owner, on device, 2026-09-23: "plank time should not require me to put in a
// colon, should automatically fill right to left". The set clock is a plain
// number pad now and the colons are drawn. These are its rules, pure, and the
// proof that the stored value did not move: every text the field produces is
// read by `parseClock` — the loggers' reader, unchanged — as exactly the
// seconds its digits mean (src/lib/exercise/clock-entry.ts).
console.log('12. the set clock fills from the right, and stores what it always stored');
{
  // Type keys into a field holding `start`, as src/components/exercise/
  // duration-field.tsx does: the first key may replace (A3), the rest shift.
  const type = (keys, start = '', replace = false) => {
    let digits = start;
    let first = replace;
    const drawn = [];
    for (const key of keys) {
      digits = pressClockKey(digits, key, first);
      first = false;
      drawn.push(digitsToClock(digits));
    }
    return { digits, drawn: drawn.join(' ') };
  };

  // --- every example in the ask ---------------------------------------------
  const filled = type(['1', '3', '0', '5', '0']);
  filled.drawn === '0:01 0:13 1:30 13:05 1:30:50'
    ? ok('1 → 0:01 · 13 → 0:13 · 130 → 1:30 · 1305 → 13:05 · 13050 → 1:30:50')
    : bad('fill from the right', filled.drawn);
  [
    ['1', 1],
    ['13', 13],
    ['130', 90],
    ['1305', 785],
    ['13050', 5450],
  ].every(([d, s]) => digitsToSeconds(d) === s && parseClock(digitsToClock(d)) === s)
    ? ok('…each is the seconds it reads as, and parseClock reads the drawn clock the same')
    : bad('digit seconds');

  // --- backspace --------------------------------------------------------------
  type(Array(6).fill('Backspace'), '13050').drawn === '13:05 1:30 0:13 0:01  '
    ? ok('Backspace shifts the last digit back out, down to empty, then does nothing')
    : bad('backspace', type(Array(6).fill('Backspace'), '13050').drawn);

  // --- the colon is drawn, never typed ----------------------------------------
  ['Enter', 'Tab', ':', '.', ',', ' ', 'a', ''].every((k) => pressClockKey('130', k) === '130')
    ? ok('a colon, a point, Enter or a letter moves nothing — only digits and Backspace do')
    : bad('a non-digit key moved the buffer');
  pressClockKey('1', '30') === '130'
    ? ok('a key reporting several digits is taken one digit at a time')
    : bad('multi-digit key', pressClockKey('1', '30'));

  // --- leading zeros ----------------------------------------------------------
  type(['0', '0', '4', '5']).drawn === '  0:04 0:45'
    ? ok('a leading zero moves nothing on the clock (0 0 4 5 → 0:45) and spends no place')
    : bad('leading zero', type(['0', '0', '4', '5']).drawn);
  type(['5', '0', '0']).drawn === '0:05 0:50 5:00'
    ? ok('…but a zero after a digit is a digit (5 0 0 → 5:00)')
    : bad('inner zero', type(['5', '0', '0']).drawn);

  // --- empty ------------------------------------------------------------------
  digitsToClock('') === '' &&
  digitsToSeconds('') === null &&
  clockFieldShows('') === '' &&
  clockToDigits('') === '' &&
  commitClock('') === ''
    ? ok('empty draws nothing (the placeholder shows), means nothing, and commits to empty')
    : bad('empty');
  parseClock(commitClock('')) === null
    ? ok('…so an empty field still saves no duration — NULL, not zero')
    : bad('empty saves a value');

  // --- seconds past 59: normalised on commit, not rejected --------------------
  const ninety = type(['1', '9', '0']);
  ninety.drawn === '0:01 0:19 1:90' && digitsToSeconds(ninety.digits) === 150
    ? ok('1 9 0 reads 1:90 while it is typed — nothing is refused — and means 150 s')
    : bad('190 while typing', JSON.stringify(ninety));
  commitClock('1:90') === '2:30' && parseClock('1:90') === 150 && parseClock('2:30') === 150
    ? ok('…and settles to 2:30 on commit: the same 150 s, re-spelled')
    : bad('commit 1:90', commitClock('1:90'));
  // Why not normalise as they type: 1 9 0 5 is 19:05. Normalising at the 0 would
  // have turned the buffer into 2 3 0 and put the 5 on 23:05.
  type(['1', '9', '0', '5']).drawn.endsWith('19:05')
    ? ok('digits typed after an un-normalised pair land where they were typed (1905 → 19:05)')
    : bad('typing past 1:90', type(['1', '9', '0', '5']).drawn);
  commitClock('0:75') === '1:15' &&
  commitClock('60:00') === '1:00:00' &&
  commitClock('99:99') === '1:40:39'
    ? ok('minutes past 59 carry into hours the same way (60:00 → 1:00:00, 99:99 → 1:40:39)')
    : bad(
        'minute carry',
        [commitClock('0:75'), commitClock('60:00'), commitClock('99:99')].join(' ')
      );
  commitClock('2:30') === '2:30' && commitClock(commitClock('9:99:99')) === commitClock('9:99:99')
    ? ok('commit is idempotent — a normal clock is left exactly as it is')
    : bad('commit is not idempotent');

  // --- the hour boundary ------------------------------------------------------
  digitsToClock('5959') === '59:59' && digitsToSeconds('5959') === 3599
    ? ok('5959 → 59:59, the last four-digit clock, one second under the hour')
    : bad('5959');
  digitsToClock('10000') === '1:00:00' && digitsToSeconds('10000') === 3600
    ? ok('10000 → 1:00:00: the fifth digit is the hour')
    : bad('10000');
  secondsToClock(3599) === '59:59' &&
  secondsToClock(3600) === '1:00:00' &&
  secondsToClock(3661) === '1:01:01'
    ? ok('a stored duration opens as m:ss under the hour and h:mm:ss from it')
    : bad('hour boundary from seconds', [3599, 3600, 3661].map(secondsToClock).join(' '));

  // --- the maximum ------------------------------------------------------------
  CLOCK_ENTRY_MAX_DIGITS === 5 &&
  pressClockKey('95959', '1') === '95959' &&
  type(['1', '2', '3', '4', '5', '6']).digits === '12345'
    ? ok('five digits is the most the field takes — a sixth is refused')
    : bad('max digits');
  digitsToClock('95959') === '9:59:59' &&
  digitsToSeconds('95959') === 35999 &&
  secondsToClock(35999) === '9:59:59'
    ? ok('…and 9:59:59, five digits, is the longest set the schema stores (duration_sec < 36000)')
    : bad('9:59:59');
  // Five digits can still spell more than the schema takes. That is left exactly
  // as typed for the loggers' own over-limit guard to name — never clamped.
  digitsToClock('99999') === '9:99:99' && parseClock('9:99:99') === 38439
    ? ok('9:99:99 is kept as typed (38,439 s) for the over-limit guard to flag, not clamped')
    : bad('over-limit kept');
  commitClock('9:99:99') === '10:40:39' &&
  clockToDigits('10:40:39') === '104039' &&
  pressClockKey('104039', '5') === '104039' &&
  digitsToClock(pressClockKey('104039', 'Backspace')) === '1:04:03'
    ? ok('…its commit reads 10:40:39, takes no further digit, and Backspace still edits it')
    : bad('over-limit commit', commitClock('9:99:99'));

  // --- A3: select on focus, reconciled with the microwave ---------------------
  type(['2', '0', '0'], '130', true).drawn === '0:02 0:20 2:00'
    ? ok(
        'a filled field just focused: the first DIGIT starts a new number (2 0 0 over 1:30 → 2:00)'
      )
    : bad('first digit replaces', type(['2', '0', '0'], '130', true).drawn);
  type(['Backspace', '5'], '130', true).drawn === '0:13 1:35'
    ? ok('…but a first BACKSPACE edits the last digit, it does not clear (1:30 → 0:13 → 1:35)')
    : bad('first backspace', type(['Backspace', '5'], '130', true).drawn);
  type(['0', '4', '5'], '130', true).drawn === ' 0:04 0:45'
    ? ok('…and a first 0 starts the number over as empty, as a leading zero does anywhere')
    : bad('first zero', type(['0', '4', '5'], '130', true).drawn);
  type(['5'], '', true).drawn === '0:05'
    ? ok('replacing an empty field is just typing into it')
    : bad('replace on empty');

  // --- an existing value opens as its digits ----------------------------------
  const stored = secondsToClock(90);
  stored === '1:30' && clockFieldShows(stored) === '1:30' && clockToDigits(stored) === '130'
    ? ok('a stored 90 s set opens as 1:30 — the digits 1 3 0')
    : bad('stored 90 s', JSON.stringify([stored, clockFieldShows(stored), clockToDigits(stored)]));
  digitsToClock(pressClockKey(clockToDigits(stored), 'Backspace')) === '0:13'
    ? ok('…so one Backspace edits its last digit (1:30 → 0:13)')
    : bad('stored backspace');
  clockFieldShows('1:90') === '1:90' && clockToDigits('1:90') === '190'
    ? ok('a draft saved mid-typing (1:90) comes back exactly as it was left, not normalised')
    : bad('mid-typing draft');

  // --- a stored zero ----------------------------------------------------------
  // duration_sec >= 0 admits it. Drawn blank, the editor's delete-and-reinsert
  // would re-save a set nobody touched as NULL.
  secondsToClock(0) === '0:00' &&
  clockFieldShows('0:00') === '0:00' &&
  commitClock('0:00') === '0:00' &&
  parseClock('0:00') === 0
    ? ok('a stored 0 s set opens as 0:00, not blank, and saves back as 0 untouched')
    : bad('stored zero');
  clockToDigits('0:00') === '' &&
  digitsToClock(pressClockKey(clockToDigits('0:00'), 'Backspace', true)) === '' &&
  digitsToClock(pressClockKey(clockToDigits('0:00'), '5', true)) === '0:05'
    ? ok('…and has no digits of its own: a Backspace clears it, a digit replaces it')
    : bad('zero digits');

  // --- drafts typed on the old punctuation keyboard ---------------------------
  // A v3 draft written by the previous build holds whatever was typed there,
  // and a bare number was SECONDS. It must draw the seconds it will save.
  const legacy = [
    ['90', '1:30', 90],
    ['130', '2:10', 130], // looks like 1:30 now; it was 130 seconds
    ['5:', '5:00', 300], // a trailing colon, mid-typing
    ['45:0', '45:00', 2700], // a half-typed second
    ['01:30', '1:30', 90],
    [' 1:30 ', '1:30', 90],
    ['1:05:30', '1:05:30', 3930],
  ];
  const misread = legacy.filter(
    ([text, shows, s]) =>
      clockFieldShows(text) !== shows ||
      parseClock(text) !== s ||
      digitsToSeconds(clockToDigits(text)) !== s ||
      parseClock(commitClock(text)) !== s
  );
  misread.length === 0
    ? ok('an old draft draws the seconds it will save: 90 → 1:30, 130 → 2:10, 5: → 5:00')
    : bad('legacy drafts', JSON.stringify(misread));
  clockFieldShows('1:3a') === '' &&
  clockToDigits('1:3a') === '' &&
  commitClock('1:3a') === '' &&
  parseClock('1:3a') === null
    ? ok('…and text parseClock cannot read draws empty and saves no duration, as it always did')
    : bad('legacy junk');

  // --- the stored value is unchanged: exhaustively ----------------------------
  // Every buffer the field can hold — 1 to 5 digits, no leading zero — draws a
  // clock that `parseClock` reads as exactly the seconds its digits mean, and
  // that reopens as the same digits.
  const drift = [];
  let buffers = 0;
  for (let n = 1; n < 100000 && drift.length < 5; n++) {
    const digits = String(n);
    const text = digitsToClock(digits);
    buffers++;
    if (
      parseClock(text) !== digitsToSeconds(digits) ||
      clockToDigits(text) !== digits ||
      clockFieldShows(text) !== text ||
      parseClock(commitClock(text)) !== parseClock(text)
    ) {
      drift.push(digits);
    }
  }
  drift.length === 0 && buffers === 99999
    ? ok(
        `all ${buffers} buffers draw a clock parseClock reads as their own seconds, reopen as themselves, and keep their seconds through commit`
      )
    : bad('buffer round-trip', drift.join(' '));
  // Every storable second opens as a normal clock that saves back as itself and
  // that commit leaves alone — so opening a stored session and closing it again
  // changes nothing, and the free-form logger's "only a change of value dirties
  // the row" test can never see a re-spelling as an edit.
  const secDrift = [];
  for (let s = 0; s < 36000 && secDrift.length < 5; s++) {
    const text = secondsToClock(s);
    if (
      parseClock(text) !== s ||
      commitClock(text) !== text ||
      clockFieldShows(text) !== text ||
      text.replace(/:/g, '').replace(/^0+/, '').length > CLOCK_ENTRY_MAX_DIGITS
    ) {
      secDrift.push(s);
    }
  }
  secDrift.length === 0
    ? ok(
        'every storable duration (0 … 35,999 s) opens as a clock of ≤ 5 digits that saves back as itself'
      )
    : bad('seconds round-trip', secDrift.join(' '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
