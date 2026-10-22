/**
 * Headless test of the Exercise data layer — the workouts/workout_sets schema
 * (0003_exercise.sql) and its repository (exercise.ts) — against real SQLite
 * via node:sqlite. Mirrors db/log.test.mjs; op-sqlite is never loaded.
 * Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  clearOwnLiveDraft,
  clearWorkoutDraft,
  readWorkoutDraft,
  saveWorkoutDraft,
  subscribeWorkoutDrafts,
} from '../src/lib/db/repositories/workout-drafts.ts';
import { createRoutine, deleteRoutine } from '../src/lib/db/repositories/routines.ts';
import {
  barHearsSlot,
  LIVE_LOGGER_RESUME,
  LIVE_LOGGER_ROUTE,
  readOpenLiveSession,
  restRemainingSec,
  sameSessionBar,
  sessionBarOnScreen,
  sessionBarView,
} from '../src/lib/exercise/session-bar.ts';
import {
  DRAFT_VERSION,
  liveDraftHasData,
  liveDraftMovements,
  liveDraftSessionId,
  liveDraftSetsDone,
  leaveGuard,
  liveFocusDecision,
  liveSessionOpen,
  liveSessionQuiet,
  liveSessionUntouched,
  liveSlotLoss,
  liveSlotState,
  liveStartFor,
  liveStartOf,
  mayClearLiveSlot,
  openSessionLine,
  parseLiveDraft,
  QUIET_LEAVE_MS,
} from '../src/lib/exercise/draft.ts';
import {
  blockSegments,
  moveBlockSegment,
  removeBlockKeepingBinds,
  storedBlockRuns,
  supersetGroups,
} from '../src/lib/exercise/block-order.ts';
import {
  MAX_SESSION_MIN,
  durationFieldText,
  editedDuration,
  parseDurationField,
  shiftSessionStart,
} from '../src/lib/exercise/session-time.ts';
import { trainingDailyTotals } from '../src/lib/ai/series.ts';
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
import {
  hintFields,
  prevPatch,
  prevSpoken,
  removeSetWithUndo,
  restampMovement,
  setFigure,
  setHint,
  setRemovalWords,
  setTargetOf,
  setUndoStands,
  snapLoadDirected,
  targetApplies,
  tickPatch,
  undoSetRemoval,
} from '../src/lib/exercise/set-hints.ts';
import { aiDoorCopy } from '../src/lib/exercise/match.ts';
import { suggestProgression } from '../src/lib/exercise/progression.ts';
import { DEFAULT_UNIT_PREFERENCES } from '../src/lib/user/types.ts';
import { createProtocolWithVersion } from '../src/lib/db/repositories/protocols.ts';
import { setMissionStatus } from '../src/lib/db/repositories/mission.ts';
import { startStatus } from '../src/lib/db/repositories/statuses.ts';
import {
  releaseWorkoutTick,
  tickTrainingForWorkout,
  trainingRowFor,
  untickTraining,
} from '../src/lib/db/repositories/training-tick.ts';
import {
  tickTrainingAfterSave,
  trainingTickOffer,
  trainingTickWords,
} from '../src/lib/exercise/training-tick-offer.ts';
import { closeUndo, currentUndo, offerUndo, runUndo } from '../src/lib/nutrition/undo-store.ts';
import { todayISODate } from '../src/lib/db/date.ts';
import { arriveDay } from '../src/lib/db/seed.ts';

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

// ---------------------------------------------------------------------------
// Owner, on the device, 2026-09-23 — three notes about the live logger:
//   "confirm in progress workouts not getting cleared, should be same for going
//    to rest of the app" · "workout duration should be editable" · "be able to
//    reorder exercises in a workout".
console.log('13. leaving keeps a session; its order and its minutes are editable');
{
  // --- reorder: the order is the array's, and a superset moves as one --------
  const b = (key, linkedToNext = false) => ({ key, linkedToNext });
  const keys = (bs) => bs.map((x) => `${x.key}${x.linkedToNext ? '+' : ''}`).join(' ');
  // 1 | 2+3 | 4 — a single block, a superset, a single block.
  const session = [b(1), b(2, true), b(3), b(4)];

  JSON.stringify(blockSegments(session)) ===
  JSON.stringify([
    { start: 0, end: 0 },
    { start: 1, end: 2 },
    { start: 3, end: 3 },
  ])
    ? ok('a session cuts into movable units: a superset is ONE unit')
    : bad('segments', JSON.stringify(blockSegments(session)));
  keys(moveBlockSegment(session, 1, 1)) === '2+ 3 1 4'
    ? ok('a single exercise steps past a whole superset, never into the middle of it')
    : bad('single past superset', keys(moveBlockSegment(session, 1, 1)));
  keys(moveBlockSegment(session, 3, -1)) === '2+ 3 1 4'
    ? ok('pressing the LOWER member of a superset moves the pair — the bind survives')
    : bad('pair as unit', keys(moveBlockSegment(session, 3, -1)));
  keys(moveBlockSegment(session, 2, 1)) === '1 4 2+ 3'
    ? ok('…in either direction')
    : bad('pair down', keys(moveBlockSegment(session, 2, 1)));
  moveBlockSegment(session, 1, -1) === null &&
  moveBlockSegment(session, 4, 1) === null &&
  moveBlockSegment(session, 99, 1) === null
    ? ok('a move off either end (or of a key that names nothing) is null — the arrow is drawn off')
    : bad('edge moves');
  keys(session) === '1 2+ 3 4'
    ? ok('moving returns a new order and leaves the one it was given untouched')
    : bad('input mutated', keys(session));
  supersetGroups(moveBlockSegment(session, 1, 1)).join() === '1,1,,'
    ? ok('the group numbers Finish writes follow the moved pair')
    : bad('groups after move', supersetGroups(moveBlockSegment(session, 1, 1)).join());

  // A bind left dangling on the last block (its partner removed earlier) binds
  // to nothing — and must not bind to whatever is moved in beneath it.
  const dangling = [b(1), b(2, true)];
  const lifted = moveBlockSegment(dangling, 2, -1);
  keys(lifted) === '2 1' && supersetGroups(lifted).every((g) => g === null)
    ? ok('a dangling bind is cleared by a move, so no superset appears that nobody made')
    : bad('dangling bind', keys(lifted));

  // Removing the lower half of a superset used to leave the upper half bound
  // to whatever came next.
  keys(removeBlockKeepingBinds([b(1, true), b(2), b(3)], 2)) === '1 3'
    ? ok('removing half of a pair does not bind the other half to the next exercise')
    : bad('remove invents superset', keys(removeBlockKeepingBinds([b(1, true), b(2), b(3)], 2)));
  keys(removeBlockKeepingBinds([b(1, true), b(2, true), b(3)], 2)) === '1+ 3'
    ? ok('…while a three-way superset minus its middle is still one superset')
    : bad('three-way remove', keys(removeBlockKeepingBinds([b(1, true), b(2, true), b(3)], 2)));

  // --- the order persists through the row's own set_index ---------------------
  {
    const { db } = freshDb();
    const s = (exerciseId, exercise, supersetGroup = null) => ({
      exercise,
      exerciseId,
      reps: 8,
      weightKg: 60,
      supersetGroup,
    });
    const id = logWorkout(db, { date: '2026-09-23', kind: 'strength', durationMin: 50 }, [
      s('barbell-bench-press', 'Barbell Bench Press', 1),
      s('barbell-bench-press', 'Barbell Bench Press', 1),
      s('barbell-row', 'Barbell Row', 1),
      s('barbell-row', 'Barbell Row', 1),
      { exercise: 'Plank', exerciseId: 'plank', durationSec: 60 },
    ]);
    // The editor moved the plank to the front: the superset's two blocks moved
    // down together, and Save rewrites the sets in the new block order with the
    // groups recomputed from it — the same call shape app/workout-live.tsx uses.
    const [bench, row, plank] = [
      { key: 1, linkedToNext: true },
      { key: 2, linkedToNext: false },
      { key: 3, linkedToNext: false },
    ];
    const moved = moveBlockSegment([bench, row, plank], 3, -1);
    const groups = supersetGroups(moved);
    const byKey = {
      1: [
        s('barbell-bench-press', 'Barbell Bench Press'),
        s('barbell-bench-press', 'Barbell Bench Press'),
      ],
      2: [s('barbell-row', 'Barbell Row'), s('barbell-row', 'Barbell Row')],
      3: [{ exercise: 'Plank', exerciseId: 'plank', durationSec: 60 }],
    };
    replaceWorkout(
      db,
      id,
      { kind: 'strength', durationMin: 50 },
      moved.flatMap((blk, i) => byKey[blk.key].map((set) => ({ ...set, supersetGroup: groups[i] })))
    );
    const after = getWorkoutDetail(db, id);
    after.sets.map((x) => x.exerciseId).join() ===
    'plank,barbell-bench-press,barbell-bench-press,barbell-row,barbell-row'
      ? ok('a reordered session reopens in its new order — set_index is the order, no new column')
      : bad('persisted order', after.sets.map((x) => x.exerciseId).join());
    after.sets.map((x) => x.supersetGroup ?? '-').join() === '-,1,1,1,1'
      ? ok('…and the superset it carried is still one superset')
      : bad('persisted groups', after.sets.map((x) => x.supersetGroup ?? '-').join());
  }

  // --- the live start: a nudge, bounded ---------------------------------------
  const T = Date.parse('2026-09-23T10:00:00.000Z');
  const MIN = 60_000;
  shiftSessionStart(T - 12 * MIN, -5, T) === T - 17 * MIN
    ? ok('"I forgot to press start": −5 moves the start five minutes earlier')
    : bad('earlier', shiftSessionStart(T - 12 * MIN, -5, T));
  shiftSessionStart(T - 2 * MIN, 5, T) === T && shiftSessionStart(T, 5, T) === null
    ? ok('a start never moves into the future — it stops at now, then the control is off')
    : bad('future clamp');
  shiftSessionStart(T - (MAX_SESSION_MIN - 2) * MIN, -5, T) === T - MAX_SESSION_MIN * MIN &&
  shiftSessionStart(T - MAX_SESSION_MIN * MIN, -5, T) === null
    ? ok('…nor further back than the six hours Finish would record at all')
    : bad('past clamp');
  shiftSessionStart(T - 2 * 24 * 60 * MIN, 5, T) === T - 2 * 24 * 60 * MIN + 5 * MIN &&
  shiftSessionStart(T - 2 * 24 * 60 * MIN, -5, T) === null
    ? ok('a draft resumed days later can move toward the range, never further from it')
    : bad('stale start');

  // --- a logged session's minutes ---------------------------------------------
  const field = (text) => JSON.stringify(parseDurationField(text));
  field('') === '{"ok":true,"minutes":null}' && field(' 45 ') === '{"ok":true,"minutes":45}'
    ? ok('the minutes field: blank is "no duration", a number is whole minutes')
    : bad('duration parse', `${field('')} ${field(' 45 ')}`);
  ['0', '45.5', '1000', 'abc', '-5'].every((t) => !parseDurationField(t).ok) &&
  parseDurationField('999').ok
    ? ok('…and 0, fractions, 1000+ and junk are refused rather than stored')
    : bad('duration bounds');

  // --- every reader sees the edited figure ------------------------------------
  {
    const { db, raw } = freshDb();
    const cardio = logWorkout(db, { date: '2026-07-21', kind: 'cardio', durationMin: 20 });
    const lift = logWorkout(
      db,
      {
        date: '2026-07-21',
        kind: 'strength',
        durationMin: 12,
        startedAt: '2026-07-21T16:00:00.000Z',
      },
      [{ exercise: 'Barbell Row', exerciseId: 'barbell-row', reps: 8, weightKg: 70 }]
    );
    // The editor's Save — the sets re-sent, only the minutes changed.
    replaceWorkout(db, cardio, { kind: 'cardio', durationMin: 45 }, []);
    replaceWorkout(db, lift, { kind: 'strength', durationMin: 58 }, [
      { exercise: 'Barbell Row', exerciseId: 'barbell-row', reps: 8, weightKg: 70 },
    ]);
    getWorkoutDetail(db, lift).durationMin === 58
      ? ok('the row carries the corrected figure')
      : bad('row', getWorkoutDetail(db, lift).durationMin);
    raw.prepare('SELECT started_at FROM workouts WHERE id = ?').get(lift).started_at ===
    '2026-07-21T16:00:00.000Z'
      ? ok('…and keeps its start: a corrected duration moves the END, the fact that was wrong')
      : bad('started_at moved');
    weekSummary(db, NOW).zone2Min === 45
      ? ok("the week's cardio minutes read it (weekSummary)")
      : bad('week', weekSummary(db, NOW).zone2Min);
    const rows = listRecentSessions(db).map(sessionDetail);
    rows.includes('45 min') && rows.includes('1 set · 58 min')
      ? ok('the hub rows read it (listRecentSessions → sessionDetail)')
      : bad('hub rows', rows.join(' | '));
    const day = trainingDailyTotals(db, '2026-07-21')[0];
    day.minutes === 103 && day.cardio_min === 45
      ? ok("the Coach's daily training series reads it (trainingDailyTotals)")
      : bad('series', JSON.stringify(day));
    replaceWorkout(db, cardio, { kind: 'cardio', durationMin: null }, []);
    weekSummary(db, NOW).zone2Min === 0 &&
    listRecentSessions(db).map(sessionDetail).includes('Cardio')
      ? ok('clearing the field stores NO duration, and every reader says so — not "0 min"')
      : bad('cleared duration');
  }

  // --- the slot: whose session is it -----------------------------------------
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
  const live = (over, sets = [set(1, { weight: '80', reps: '8', done: true })]) => ({
    version: DRAFT_VERSION,
    startedAt: new Date(2026, 8, 23, 14, 2).getTime(),
    routineId: null,
    ingestId: null,
    restEndsAt: null,
    away: false,
    blocks: [
      {
        key: 1,
        exerciseId: 'barbell-bench-press',
        name: 'Barbell Bench Press',
        loggingType: 'weight_reps',
        measures: 'reps,load',
        mechanic: 'compound',
        restSec: 180,
        prev: [],
        bestE1rm: null,
        linkedToNext: false,
        sets,
      },
    ],
    ...over,
  });
  liveSlotState(null, 'a') === 'free' &&
  liveSlotState(live({ sessionId: 'a' }), 'a') === 'mine' &&
  liveSlotState(live({ sessionId: 'b' }), 'a') === 'other'
    ? ok('the slot reads free / mine / other from one screen’s point of view')
    : bad('slot states');
  // Since the review round (§14): a session with nothing typed is still a
  // session — it has a start and the exercises the owner chose.
  liveSlotState(live({ sessionId: 'b' }, [set(1)]), 'a') === 'other' &&
  liveSlotState({ ...live({ sessionId: 'b' }), version: 1 }, 'a') === 'free'
    ? ok('a draft with nothing typed is still protected; one from another build is not')
    : bad('empty / foreign draft');
  const legacy = live({});
  liveDraftSessionId(legacy) === String(legacy.startedAt) &&
  liveSlotState(legacy, String(legacy.startedAt)) === 'mine'
    ? ok('a draft written before sessionId existed is identified by its start instant')
    : bad('legacy identity');
  JSON.stringify(parseLiveDraft(legacy)) === JSON.stringify(legacy) &&
  parseLiveDraft(live({ sessionId: 'a' })).sessionId === 'a'
    ? ok('sessionId round-trips when present and is not invented when absent — no version bump')
    : bad('sessionId parse');

  // The two things the focus check guards against, played through the store:
  // screen A holds session "a"; the hub then throws it away, or starts "b".
  {
    const { db } = freshDb();
    saveWorkoutDraft(db, 'live', live({ sessionId: 'a' }));
    clearWorkoutDraft(db, 'live'); // the hub's trash, or another copy's Finish
    liveSlotState(readWorkoutDraft(db, 'live')?.value ?? null, 'a') === 'free'
      ? ok('ended elsewhere: the slot is free, and A — which had written — knows it is stale')
      : bad('ended');
    saveWorkoutDraft(db, 'live', live({ sessionId: 'b' })); // "Start new", and a set typed
    liveSlotState(readWorkoutDraft(db, 'live').value, 'a') === 'other'
      ? ok('replaced elsewhere: A sees another session and must not write over it')
      : bad('replaced');
  }

  // --- Home's one line ---------------------------------------------------------
  const at1530 = new Date(2026, 8, 23, 15, 30);
  openSessionLine(live({}), at1530) === 'Workout in progress · 1 set done · started 14:02'
    ? ok('Home: "Workout in progress · 1 set done · started 14:02"')
    : bad('home line', openSessionLine(live({}), at1530));
  openSessionLine(live({}, [set(1, { weight: '80' })]), at1530) ===
  'Workout in progress · started 14:02'
    ? ok('…nothing stamped yet, so no count — the start is still a fact')
    : bad('home line, nothing done', openSessionLine(live({}, [set(1, { weight: '80' })]), at1530));
  openSessionLine(live({ startedAt: new Date(2026, 8, 20, 18, 0).getTime() }), at1530).endsWith(
    'started 2 days ago'
  )
    ? ok('…and a session from an earlier day says how long ago, not a bare clock time')
    : bad(
        'home line, old',
        openSessionLine(live({ startedAt: new Date(2026, 8, 20, 18, 0).getTime() }), at1530)
      );
}

// ---------------------------------------------------------------------------
// The review round on the same three notes (2026-09-23). Each block below is a
// decision the screen used to make inline, moved into a pure function so it can
// be pinned here rather than trusted: whether a session exists, what the focus
// check does with the slot, what the way out asks, what Save writes for the
// minutes, and how a stored session is cut back into blocks.
console.log('14. the review round: every session is kept, and the decisions are pinned');
{
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
  const block = (key, sets = [set(key)]) => ({
    key,
    exerciseId: 'barbell-bench-press',
    name: 'Barbell Bench Press',
    loggingType: 'weight_reps',
    measures: 'reps,load',
    mechanic: 'compound',
    restSec: 180,
    prev: [],
    bestE1rm: null,
    linkedToNext: false,
    sets,
  });
  const live = (over, blocks = [block(1)]) => ({
    version: DRAFT_VERSION,
    sessionId: 'a',
    startedAt: new Date(2026, 8, 23, 14, 2).getTime(),
    routineId: 'push-day',
    ingestId: null,
    restEndsAt: null,
    away: false,
    blocks,
    ...over,
  });

  // --- a session exists from its first exercise ------------------------------
  // The reviewer's failure: a saved workout started, every set blank, left to
  // check Home — no draft was written, so no Home row, no hub card, and the
  // start instant was gone.
  liveSessionOpen([block(1)]) && !liveSessionOpen([])
    ? ok('a session with one exercise and nothing typed is open; an empty sheet is not')
    : bad('liveSessionOpen');
  const untouched = live({});
  const parsed = parseLiveDraft(untouched);
  parsed && !liveDraftHasData(parsed) && parsed.startedAt === untouched.startedAt
    ? ok('…and its draft parses — with its start instant — though nothing in it can be saved yet')
    : bad('untouched draft parse');
  openSessionLine(untouched, new Date(2026, 8, 23, 15, 30)) ===
  'Workout in progress · started 14:02'
    ? ok('Home offers it back: "Workout in progress · started 14:02", no set count')
    : bad('home line (untouched)', openSessionLine(untouched, new Date(2026, 8, 23, 15, 30)));

  // --- the slot, from one screen's point of view -----------------------------
  liveSlotLoss(null, 'a', false) === null
    ? ok('a fresh screen that has written nothing is not stale when the slot is empty')
    : bad('false stale on a fresh screen');
  liveSlotLoss(null, 'a', true) === 'ended'
    ? ok('a screen that HAD written finds the slot empty → ended elsewhere')
    : bad('ended');
  liveSlotLoss(live({ sessionId: 'b' }), 'a', false) === 'other' &&
  liveSlotLoss(live({ sessionId: 'b' }), 'a', true) === 'other'
    ? ok('another session in the slot is "other" whether or not this screen had written')
    : bad('other');
  liveSlotLoss(untouched, 'a', true) === null
    ? ok('its own untouched session in the slot is not a loss')
    : bad('own untouched');
  mayClearLiveSlot(untouched, 'a') &&
  mayClearLiveSlot(null, 'a') &&
  !mayClearLiveSlot(live({ sessionId: 'b' }, [block(9)]), 'a')
    ? ok('a screen may empty the slot of its own session or of nothing — never of another')
    : bad('mayClearLiveSlot');

  // --- the focus decision ----------------------------------------------------
  const mine = live({});
  const mineJson = JSON.stringify(mine);
  const newer = live({}, [block(1, [set(1, { weight: '80', reps: '8', done: true })])]);
  const decide = (stored, owned, lastWritten) =>
    liveFocusDecision(stored, 'a', owned, lastWritten);
  decide(mine, true, mineJson).kind === 'keep'
    ? ok('focus: the slot holds exactly what this screen last wrote → keep')
    : bad('focus keep');
  const adopt = decide(newer, true, mineJson);
  adopt.kind === 'adopt' &&
  adopt.draft.blocks[0].sets[0].done === true &&
  adopt.serialised === JSON.stringify(newer)
    ? ok('focus: the same session, written by another copy of the logger → adopt that copy')
    : bad('focus adopt', JSON.stringify(adopt).slice(0, 120));
  decide(newer, true, null).kind === 'keep'
    ? ok('focus: a screen whose writes never landed adopts nothing — the slot is what it resumed')
    : bad('focus adopt without a write');
  decide(null, false, null).kind === 'keep'
    ? ok('focus: a brand-new screen with an empty slot is not closed to a notice')
    : bad('focus false stale');
  const ended = decide(null, true, mineJson);
  const other = decide(live({ sessionId: 'b' }), true, mineJson);
  ended.kind === 'stale' && ended.why === 'ended' && other.kind === 'stale' && other.why === 'other'
    ? ok('focus: emptied → stale "ended"; another session → stale "other"')
    : bad('focus stale', `${JSON.stringify(ended)} ${JSON.stringify(other)}`);

  // --- the way out never discards --------------------------------------------
  const guard = (over) =>
    leaveGuard({ editing: false, dirty: false, open: true, writeFailed: false, ...over });
  guard({}) === 'leave' && guard({ open: false }) === 'leave'
    ? ok('leaving an unfinished session just leaves — nothing asked, nothing cleared')
    : bad('leave');
  guard({ writeFailed: true }) === 'ask-unsaved-copy' &&
  guard({ writeFailed: true, open: false }) === 'leave'
    ? ok('…unless the last draft write threw, and only when there is a session to lose')
    : bad('unsaved copy');
  guard({ editing: true, dirty: true, writeFailed: true }) === 'ask-discard-changes' &&
  guard({ editing: true }) === 'leave'
    ? ok('an edit with changes asks before dropping them; an untouched edit just leaves')
    : bad('editing guard');

  // --- the rest alert rides the draft ----------------------------------------
  // In the key order the logger's write-through builds it (after restEndsAt).
  const { away: restAway, blocks: restBlocks, ...restHead } = live({
    restEndsAt: Date.now() + 90_000,
  });
  const resting = { ...restHead, restAlertId: 'ios-alert-7', away: restAway, blocks: restBlocks };
  parseLiveDraft(resting).restAlertId === 'ios-alert-7' &&
  JSON.stringify(parseLiveDraft(resting)) === JSON.stringify(resting)
    ? ok('the queued alert id round-trips, so a resumed screen can cancel or replace it')
    : bad('restAlertId round-trip');
  !('restAlertId' in parseLiveDraft(mine)) && !('restAlertId' in parseLiveDraft(live({ restAlertId: '' })))
    ? ok('…and is not invented when absent — no version bump')
    : bad('restAlertId invented');
  {
    const { db } = freshDb();
    saveWorkoutDraft(db, 'live', resting);
    parseLiveDraft(readWorkoutDraft(db, 'live').value).restAlertId === 'ios-alert-7'
      ? ok('…through the store as well: what the hub’s trash reads to cancel it')
      : bad('restAlertId store');
  }

  // --- a logged session's minutes: an untouched field never holds Save -------
  const edited = (stored, text) => JSON.stringify(editedDuration(stored, text));
  [0, 0.3, 1000, 1200.5].every((m) => {
    const e = editedDuration(m, durationFieldText(m));
    return e.ok && e.minutes === m && !e.changed;
  })
    ? ok('untouched 0, 0.3, 1000 and 1200.5 minutes (the Coach, an import) save back exactly')
    : bad('untouched out-of-range', [0, 0.3, 1000].map((m) => edited(m, durationFieldText(m))).join(' '));
  edited(47.6, '48') === '{"ok":true,"minutes":47.6,"changed":false}' &&
  edited(null, '') === '{"ok":true,"minutes":null,"changed":false}'
    ? ok('…including a fraction the field rounds for display, and no figure at all')
    : bad('untouched', `${edited(47.6, '48')} ${edited(null, '')}`);
  edited(0, '0 ') === '{"ok":false}' && edited(47, '1000') === '{"ok":false}'
    ? ok('a figure the owner TYPES is still held to whole minutes 1–999')
    : bad('typed bounds', `${edited(0, '0 ')} ${edited(47, '1000')}`);
  edited(20, '60') === '{"ok":true,"minutes":60,"changed":true}' &&
  edited(20, '') === '{"ok":true,"minutes":null,"changed":true}' &&
  edited(20, ' 20') === '{"ok":true,"minutes":20,"changed":false}'
    ? ok('a real change says so — which is what runs the pairing pass — and a retyped same figure does not')
    : bad('changed', `${edited(20, '60')} ${edited(20, '')} ${edited(20, ' 20')}`);

  // --- a stored session cut back into blocks ---------------------------------
  const ss = (exerciseId, supersetGroup = null, exercise = exerciseId) => ({
    exerciseId,
    exercise,
    supersetGroup,
  });
  const shape = (runs) =>
    runs.map((r) => `${r.name}×${r.sets.length}${r.linkedToNext ? '+' : ''}`).join(' ');
  // The reviewer's probe: a lone bench moved above a Bench + Row superset.
  shape(storedBlockRuns([ss('bench'), ss('bench', 1), ss('row', 1)])) === 'bench×1 bench×1+ row×1'
    ? ok('a lone bench above a Bench + Row superset reopens as two blocks, the superset intact')
    : bad('reviewer probe', shape(storedBlockRuns([ss('bench'), ss('bench', 1), ss('row', 1)])));
  shape(storedBlockRuns([ss('bench', 1), ss('row', 1), ss('bench')])) === 'bench×1+ row×1 bench×1'
    ? ok('…and the mirror case (the superset first, the lone bench after it)')
    : bad('mirror probe');
  shape(storedBlockRuns([ss('bench'), ss('bench'), ss('row')])) === 'bench×2 row×1'
    ? ok('an ungrouped run of one movement is still one block')
    : bad('ungrouped merge');
  shape(storedBlockRuns([ss('bench', 1), ss('row', 1), ss('bench', 1), ss('row', 1)])) ===
  'bench×1+ row×1+ bench×1+ row×1'
    ? ok('an interleaved superset (the Coach logs them that way) stays one chain')
    : bad('interleave');
  shape(storedBlockRuns([ss('bench', 1), ss('row', 1), ss('curl', 2), ss('press', 2)])) ===
  'bench×1+ row×1 curl×1+ press×1'
    ? ok('two neighbouring supersets stay two — the bind is read from each block’s own group')
    : bad('two supersets');
  shape(
    storedBlockRuns([ss(null, 1, 'Sled push'), ss('row', 1), ss(null, null, 'Sled push')])
  ) === 'Sled push×1+ row×1 Sled push×1'
    ? ok('a free-text block keeps the bind Save wrote for it (the old per-movement map dropped it)')
    : bad('free-text bind');

  // End to end through the repository: stored → blocks → the groups Save writes
  // are the groups that were stored.
  {
    const { db } = freshDb();
    const row = (exerciseId, exercise, supersetGroup) => ({
      exercise,
      exerciseId,
      reps: 8,
      weightKg: 60,
      supersetGroup,
    });
    const id = logWorkout(db, { date: '2026-09-23', kind: 'strength', durationMin: 0 }, [
      row('barbell-bench-press', 'Barbell Bench Press', null),
      row('barbell-bench-press', 'Barbell Bench Press', 1),
      row('barbell-row', 'Barbell Row', 1),
    ]);
    const runs = storedBlockRuns(getWorkoutDetail(db, id).sets);
    const groups = supersetGroups(runs);
    const rewritten = runs.flatMap((r, i) => r.sets.map(() => groups[i] ?? '-')).join();
    rewritten === '-,1,1'
      ? ok('a Save of the reopened session writes the superset back exactly as it was stored')
      : bad('round trip groups', rewritten);
    const e = editedDuration(getWorkoutDetail(db, id).durationMin, '0');
    e.ok && e.minutes === 0 && !e.changed
      ? ok('…and a stored 0-minute duration, untouched, does not hold that Save')
      : bad('stored 0 untouched', JSON.stringify(e));
  }
}

console.log('15. a Start taken straight back is dropped quietly (owner, 2026-09-25)');
{
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
  const block = (key, exerciseId, name, sets) => ({
    key,
    exerciseId,
    name,
    loggingType: 'weight_reps',
    measures: 'reps,load',
    mechanic: 'compound',
    restSec: 180,
    prev: [{ reps: 8, weightKg: 80, rpe: null, durationSec: null, distanceM: null }],
    bestE1rm: 101.25,
    linkedToNext: false,
    sets,
  });
  // What Start builds from a saved workout: two exercises, every set blank.
  const T0 = new Date(2026, 8, 25, 18, 0, 0).getTime();
  const started = {
    blocks: [
      block(1, 'barbell-bench-press', 'Barbell Bench Press', [set(1), set(2), set(3)]),
      block(4, 'barbell-row', 'Barbell Row', [set(5), set(6)]),
    ],
    startedAt: T0,
    away: false,
    restEndsAt: null,
  };
  const start = liveStartOf(started);

  QUIET_LEAVE_MS === 10_000 && start.at === T0
    ? ok('the window is ten seconds, measured from the instant Start was pressed')
    : bad('window', `${QUIET_LEAVE_MS} ${start.at}`);

  // --- the window --------------------------------------------------------------
  liveSessionQuiet(start, started, T0 + 4_000) &&
  liveSessionQuiet(start, started, T0) &&
  liveSessionQuiet(start, started, T0 + 9_999)
    ? ok('untouched and left at 0 s, 4 s or 9.999 s → dropped')
    : bad('inside the window');
  !liveSessionQuiet(start, started, T0 + 10_000) && !liveSessionQuiet(start, started, T0 + 600_000)
    ? ok('untouched but left at 10 s or later → kept, the 2026-09-23 rule')
    : bad('after the window');
  !liveSessionQuiet(start, started, T0 - 1)
    ? ok('a clock that reads earlier than Start (set back) → kept: the window cannot be measured')
    : bad('clock set back');
  !liveSessionQuiet(null, started, T0 + 1_000)
    ? ok('no Start baseline — a resumed session, an edit — is never dropped by leaving')
    : bad('null start');

  // --- who gets a baseline: `liveStartFor`, the logger's initializer ------------
  // The screen's `start` state is this call and nothing else (the render suite
  // pins that from the source), so the three ways a logger opens are decided
  // here.
  const asNew = liveStartFor({ draft: null, workoutId: undefined }, started);
  const reopened = parseLiveDraft({
    version: DRAFT_VERSION,
    sessionId: 'r',
    routineId: null,
    ingestId: null,
    ...started,
  });
  const asResumed = liveStartFor({ draft: reopened, workoutId: undefined }, started);
  // No database here, so this id names nothing — still never a fresh Start.
  const asEdit = liveStartFor({ draft: null, workoutId: 'stored-session' }, started);
  reopened !== null &&
  JSON.stringify(asNew) === JSON.stringify(start) &&
  liveSessionQuiet(asNew, started, T0 + 4_000) &&
  asResumed === null &&
  asEdit === null
    ? ok('a NEW session gets the Start baseline; a resumed draft and a workout id get none')
    : bad('liveStartFor', JSON.stringify({ asNew, asResumed, asEdit }));

  // --- every change the owner can make keeps it ---------------------------------
  const withSet = (over) => ({
    ...started,
    blocks: [{ ...started.blocks[0], sets: [set(1, over), set(2), set(3)] }, started.blocks[1]],
  });
  const changes = {
    'a weight typed': withSet({ weight: '80' }),
    'reps typed': withSet({ reps: '8' }),
    'an RPE typed': withSet({ rpe: '8' }),
    'a time typed': withSet({ time: '1' }),
    'a distance typed': withSet({ distance: '2' }),
    'a set ticked done': withSet({ done: true }),
    'a set made a warmup': withSet({ setType: 'warmup' }),
    'a set added': {
      ...started,
      blocks: [
        { ...started.blocks[0], sets: [...started.blocks[0].sets, set(9)] },
        started.blocks[1],
      ],
    },
    'a set removed': {
      ...started,
      blocks: [{ ...started.blocks[0], sets: [set(1), set(2)] }, started.blocks[1]],
    },
    'an exercise added': {
      ...started,
      blocks: [...started.blocks, block(10, 'lat-pulldown', 'Lat Pulldown', [set(11)])],
    },
    'an exercise removed': { ...started, blocks: [started.blocks[0]] },
    'the order changed': { ...started, blocks: moveBlockSegment(started.blocks, 4, -1) },
    'a superset bound': {
      ...started,
      blocks: [{ ...started.blocks[0], linkedToNext: true }, started.blocks[1]],
    },
    'the start moved back 5 min': {
      ...started,
      startedAt: shiftSessionStart(T0, -5, T0 + 3_000),
    },
    'Away turned on': { ...started, away: true },
    'a rest running': { ...started, restEndsAt: T0 + 180_000 },
  };
  const readAsTouched = Object.entries(changes).filter(
    ([, state]) =>
      !liveSessionUntouched(start, state) && !liveSessionQuiet(start, state, T0 + 3_000)
  );
  readAsTouched.length === Object.keys(changes).length
    ? ok(
        `each of ${readAsTouched.length} changes keeps a session left at 3 s (typed, ticked, added, removed, moved, bound, re-timed, away, resting)`
      )
    : bad(
        'a change read as untouched',
        Object.keys(changes)
          .filter((k) => !readAsTouched.some(([name]) => name === k))
          .join(', ')
      );

  // --- back to what Start put there reads as untouched ---------------------------
  const typedThenCleared = withSet({ weight: '' });
  const tickedThenUnticked = withSet({ done: false, pr: false, prKinds: undefined });
  const movedAndBack = {
    ...started,
    blocks: moveBlockSegment(moveBlockSegment(started.blocks, 4, -1), 4, 1),
  };
  liveSessionQuiet(start, typedThenCleared, T0 + 5_000) &&
  liveSessionQuiet(start, tickedThenUnticked, T0 + 5_000) &&
  liveSessionQuiet(start, movedAndBack, T0 + 5_000)
    ? ok('typed and cleared, ticked and unticked, moved and moved back → as Start left it, dropped')
    : bad('back to the start');
  // A blank sheet — no exercises yet — has nothing in the slot to drop, and
  // reading it as quiet only clears an empty slot.
  const blank = { blocks: [], startedAt: T0, away: false, restEndsAt: null };
  liveSessionQuiet(liveStartOf(blank), blank, T0 + 2_000) &&
  !liveSessionQuiet(
    liveStartOf(blank),
    { ...blank, blocks: [block(1, 'barbell-row', 'Barbell Row', [set(1)])] },
    T0 + 2_000
  )
    ? ok('a blank sheet stays quiet until an exercise is added — adding one is a change')
    : bad('blank sheet');

  // --- the slot the drop clears ------------------------------------------------
  const { db } = freshDb();
  const draftOf = (sessionId, state) => ({
    version: DRAFT_VERSION,
    sessionId,
    routineId: 'push-day',
    ingestId: null,
    ...state,
  });
  saveWorkoutDraft(db, 'live', draftOf('mine', started));
  clearOwnLiveDraft(db, 'mine') && readWorkoutDraft(db, 'live') === null
    ? ok('the drop empties the slot of its own session')
    : bad('own clear');
  saveWorkoutDraft(db, 'live', draftOf('theirs', started));
  !clearOwnLiveDraft(db, 'mine') && parseLiveDraft(readWorkoutDraft(db, 'live')?.value) !== null
    ? ok('…and refuses to empty it of another session')
    : bad('other clear');
  clearWorkoutDraft(db, 'live');
  clearOwnLiveDraft(db, 'mine') && readWorkoutDraft(db, 'live') === null
    ? ok('…and an empty slot stays empty')
    : bad('empty clear');

  // --- a kill inside the window keeps the session --------------------------------
  // A kill runs no code: the draft Start wrote on mount is what the next launch
  // finds. Simulated as §10 does — close the handle, open the same bytes.
  const dir = mkdtempSync(join(tmpdir(), 'arc-quiet-'));
  const file = join(dir, 'arc.db');
  {
    const { raw, db: before } = freshDb(file);
    saveWorkoutDraft(before, 'live', draftOf('killed', started));
    raw.close();
  }
  {
    const { raw, db: after } = freshDb(file);
    const back = parseLiveDraft(readWorkoutDraft(after, 'live')?.value);
    back &&
    back.startedAt === T0 &&
    back.blocks.length === 2 &&
    openSessionLine(back, new Date(T0 + 60_000)) === 'Workout in progress · started 18:00'
      ? ok('killed 4 s after Start: the next launch offers it back, start instant intact')
      : bad('kill inside the window', JSON.stringify(back)?.slice(0, 120));
    // …and the logger that reopens it takes no baseline, so backing straight
    // out of the resumed screen, even at once, keeps it.
    const reopenedStart = back ? liveStartFor({ draft: back, workoutId: undefined }, back) : 'x';
    reopenedStart === null && !liveSessionQuiet(reopenedStart, back, T0 + 5_000)
      ? ok('…and the resumed logger takes no Start baseline, so leaving it at once keeps it')
      : bad('resumed baseline', JSON.stringify(reopenedStart));
    raw.close();
  }
  rmSync(dir, { recursive: true, force: true });
}


console.log('16. round 3 — per-set targets, the ✓ that logs them, Prev, and delete with Undo');
{
  const LB = DEFAULT_UNIT_PREFERENCES; // lb, mi
  const KG = { ...DEFAULT_UNIT_PREFERENCES, weight: 'kg', distance: 'km' };
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
  const prevRow = (reps, weightKg, over) => ({
    reps,
    weightKg,
    rpe: null,
    durationSec: null,
    distanceM: null,
    ...over,
  });
  const range = { low: 6, high: 10 };
  const hold100 = setTargetOf(
    suggestProgression({
      sessions: [{ date: '2026-10-14', weightKg: 100, reps: 8, rpe: null }],
      repRange: range,
      incrementKg: lbToKg(2.5),
    }),
    range.high
  );

  // --- the target is the engine's, untouched --------------------------------
  hold100 && hold100.kind === 'hold' && hold100.weightKg === 100 && hold100.reps === 9
    ? ok('setTargetOf keeps the engine’s hold: the same 100 kg, one rep more (9)')
    : bad('hold target', JSON.stringify(hold100));
  setTargetOf(
    suggestProgression({ sessions: [], repRange: range, incrementKg: lbToKg(2.5) }),
    range.high
  ) === undefined
    ? ok('…and no target when the engine says find a weight')
    : bad('find_weight target');
  setTargetOf({ kind: 'hold', targetWeightKg: null, targetReps: 12, note: '' }, 12) === undefined
    ? ok('…nor for a movement it progresses by reps or time (no load to hold)')
    : bad('reps-only target');

  // --- hold, per row: +1 rep on what each row did, capped at the top ----------
  const benchBlock = {
    prev: [prevRow(8, 100), prevRow(8, 100), prevRow(7, 100), prevRow(10, 100)],
    target: hold100,
    measures: 'reps,load',
  };
  const held = [0, 1, 2, 3, 4].map((index) =>
    setHint({
      block: benchBlock,
      index,
      set: set(index + 1),
      basis: 'total',
      away: false,
      editing: false,
      units: KG,
    })
  );
  held.map((h) => h?.reps).join(',') === '9,9,8,10,9' &&
  held.every((h) => h?.weightKg === 100 && h.source === 'target')
    ? ok(
        'hold: 8 · 8 · 7 · 10 last time reads 9 · 9 · 8 · 10 at 100 kg, and a new row the engine’s 9'
      )
    : bad('hold per row', JSON.stringify(held));

  // --- progress rounds UP to a real plate, deload rounds DOWN -----------------
  const progress = {
    kind: 'progress',
    weightKg: 100 + lbToKg(2.5),
    reps: 6,
    repHigh: 10,
    note: '',
  };
  const pKg = setHint({
    block: { prev: [prevRow(10, 100)], target: progress, measures: 'reps,load' },
    index: 0,
    set: set(1),
    basis: null,
    away: false,
    editing: false,
    units: KG,
  });
  near(pKg?.weightKg, 102.5) && pKg?.reps === 6
    ? ok(
        'progress in kg: +1.13 kg goes on the bar as 102.5 kg × 6 (the next plate, never 100 again)'
      )
    : bad('progress kg', JSON.stringify(pKg));
  const pLb = snapLoadDirected(lbToKg(135) + lbToKg(2.5), LB, 'up');
  near(pLb, lbToKg(140))
    ? ok('progress in lb: 135 + 2.5 lb rounds up to 140 lb, a real plate pair')
    : bad('progress lb', String(pLb));
  near(snapLoadDirected(lbToKg(140), LB, 'up'), lbToKg(140))
    ? ok('…and a load already on a step stays on it (140 lb is not pushed to 145)')
    : bad('on-step epsilon');
  near(snapLoadDirected(102.5 * 0.9, KG, 'down'), 90) && near(snapLoadDirected(90, KG, 'down'), 90)
    ? ok('deload rounds down: 92.25 kg → 90 kg, and 90 stays 90')
    : bad('deload snap');
  near(snapLoadDirected(1, KG, 'down'), 1)
    ? ok('…and a deload that would round to nothing keeps the engine’s own figure')
    : bad('deload floor');

  // --- where the target does NOT apply: last time, exactly ------------------
  const lastFor = (over) =>
    setHint({
      block: {
        prev: [prevRow(12, 60, { setType: 'warmup' }), prevRow(8, 100)],
        target: hold100,
        measures: 'reps,load',
      },
      index: 1,
      set: set(2),
      basis: 'total',
      away: false,
      editing: false,
      units: KG,
      ...over,
    });
  const warm = lastFor({ index: 0, set: set(1, { setType: 'warmup' }) });
  warm?.source === 'last' && warm.weightKg === 60 && warm.reps === 12
    ? ok('a warm-up row (as a new block marks last time’s) shows last time’s ramp, not the target')
    : bad('warm-up row', JSON.stringify(warm));
  lastFor({ set: set(2, { setType: 'warmup' }) })?.source === 'last'
    ? ok('…and so does a row the owner marks as a warm-up now')
    : bad('marked warm-up');
  lastFor({ index: 0, set: set(1) })?.source === 'target'
    ? ok('…while a warm-up row he turns into a working set takes the working target: the row decides')
    : bad('unmarked warm-up');
  const away = lastFor({ away: true });
  away?.source === 'last' && away.reps === 8
    ? ok('Away on: last time’s numbers, never a progression step for a different machine')
    : bad('away hint', JSON.stringify(away));
  lastFor({ basis: 'assisted' })?.source === 'last'
    ? ok('an assisted movement (0062): last time, since its figure is help, not load')
    : bad('assisted hint');
  lastFor({ editing: true }) === null
    ? ok('editing a stored session: no hint at all — every row there already happened')
    : bad('editing hint');
  const plank = setHint({
    block: {
      prev: [prevRow(null, null, { durationSec: 90 })],
      target: undefined,
      measures: 'time',
    },
    index: 0,
    set: set(1),
    basis: null,
    away: false,
    editing: false,
    units: KG,
  });
  plank?.durationSec === 90 && hintFields(plank, 'time', KG).time === '1:30'
    ? ok('a plank’s hint is last time’s 1:30, in the clock field’s own form')
    : bad('plank hint', JSON.stringify(plank));
  setHint({
    block: { prev: [], target: undefined, measures: 'reps,load' },
    index: 0,
    set: set(1),
    basis: null,
    away: false,
    editing: false,
    units: KG,
  }) === null
    ? ok('a movement never done: no hint (find a weight)')
    : bad('never done');
  !targetApplies({ target: hold100, measures: 'reps', basis: null, away: false, editing: false }) &&
  targetApplies({
    target: hold100,
    measures: 'reps,load',
    basis: 'per_hand',
    away: false,
    editing: false,
  })
    ? ok('targetApplies: load AND reps needed; any load basis but assisted')
    : bad('targetApplies');

  // --- the ✓ logs what the row shows (the found bug) -------------------------
  const benchHint = held[0];
  const filled = tickPatch(set(1), benchHint, 'reps,load', KG);
  filled?.weight === '100' && filled.reps === '9' && filled.storedWeightKg === 100
    ? ok('✓ on an untouched row logs its grey 100 × 9, with the exact kilograms behind the 100')
    : bad('tick fill', JSON.stringify(filled));
  const typed = tickPatch(set(1, { reps: '7' }), benchHint, 'reps,load', KG);
  typed && !('reps' in typed) && typed.weight === '100'
    ? ok('…a typed figure is kept (7 reps), only the empty load is taken')
    : bad('tick keeps typed', JSON.stringify(typed));
  tickPatch(set(1), null, 'reps,load', KG) === null
    ? ok('✓ on an empty row with nothing to offer is REFUSED — never an empty set saved silently')
    : bad('empty refusal');
  tickPatch(set(1, { rpe: '8' }), null, 'reps,load', KG) === null
    ? ok('…an RPE alone is not a set either')
    : bad('rpe-only refusal');
  const typedOnly = tickPatch(set(1, { reps: '5' }), null, 'reps,load', KG);
  typedOnly !== null && Object.keys(typedOnly).length === 0
    ? ok('…while a row with a figure typed ticks as typed, nothing added')
    : bad('typed only', JSON.stringify(typedOnly));
  const heldLb = tickPatch(set(1), { ...benchHint, weightKg: 61.235 }, 'reps,load', KG);
  heldLb?.weight === '61.2' && heldLb.storedWeightKg === 61.235
    ? ok('a held 61.235 kg shows 61.2 and is logged as 61.235 kg, not the rounded display')
    : bad('stored kg', JSON.stringify(heldLb));

  // --- Prev copies last time in whole (67) -----------------------------------
  const copied = prevPatch(prevRow(8, lbToKg(135)), 'reps,load', LB);
  copied?.weight === '135' && copied.reps === '8' && near(copied.storedWeightKg, lbToKg(135))
    ? ok('tap Prev: 8 × 135 lb copied into the row')
    : bad('prev copy', JSON.stringify(copied));
  const dip = prevPatch(prevRow(12, null), 'reps,load', LB);
  dip?.weight === '' && dip.reps === '12'
    ? ok('…a bodyweight dip last time copies as 12 reps with the load emptied, as it was')
    : bad('prev bodyweight', JSON.stringify(dip));
  prevPatch(undefined, 'reps,load', LB) === null &&
  prevPatch(prevRow(null, null), 'reps,load', LB) === null
    ? ok('…and no last time copies nothing')
    : bad('prev none');
  prevSpoken(prevRow(8, lbToKg(135)), 'reps,load', LB) === '8 reps, 135 lb'
    ? ok('Prev’s spoken label: "8 reps, 135 lb"')
    : bad('prev spoken', prevSpoken(prevRow(8, lbToKg(135)), 'reps,load', LB));

  // --- delete a set, and its Undo (69) ---------------------------------------
  const blockOf = (key, exerciseId, name, sets, over) => ({
    key,
    exerciseId,
    name,
    loggingType: 'weight_reps',
    measures: 'reps,load',
    mechanic: 'compound',
    restSec: 120,
    prev: [],
    bestE1rm: null,
    linkedToNext: false,
    sets,
    ...over,
  });
  // A stand-in stamp: beats a 100 kg record and every earlier set this session.
  const ask = (session, _block, s) => {
    const w = Number(s.weight);
    const before = session.flatMap((b) => b.sets).map((x) => Number(x.weight));
    return w > 100 && before.every((x) => w > x) ? ['heaviest'] : [];
  };
  const start = [
    blockOf(
      1,
      'bench',
      'Bench Press',
      [
        set(11, { weight: '110', reps: '5', done: true, pr: true, prKinds: ['heaviest'] }),
        set(12, { weight: '105', reps: '6', done: true }),
        set(13, { weight: '100', reps: '6' }),
      ],
      { linkedToNext: true }
    ),
    blockOf(2, 'row', 'Barbell Row', [set(21, { weight: '80', reps: '8', done: true })]),
  ];
  const cut = removeSetWithUndo(start, 1, 11, LB);
  const words = cut.removed && setRemovalWords(cut.removed);
  cut.blocks[0].sets.map((s) => s.key).join() === '12,13' &&
  cut.removed?.index === 0 &&
  words?.said === 'Removed set 1 of Bench Press' &&
  words.figure === '5 × 110 lb' &&
  words.spoken === 'Undo removing set 1 of Bench Press'
    ? ok('delete: the set goes, and the Undo row reads "Removed set 1 of Bench Press · 5 × 110 lb"')
    : bad('delete', JSON.stringify({ sets: cut.blocks[0].sets, words }));
  cut.blocks[0].linkedToNext === true && cut.blocks[1] === start[1]
    ? ok('…the superset bind is untouched, and the other block is the same object')
    : bad('bind kept');
  const restamped = restampMovement(cut.blocks, 'bench', ask);
  restamped[0].sets[0].pr === true && restamped[0].sets[0].prKinds?.[0] === 'heaviest'
    ? ok('…and the 105 the 110 was out-lifting by now carries the stamp: PRs follow the delete')
    : bad('restamp after delete', JSON.stringify(restamped[0].sets));
  restamped[1] === cut.blocks[1]
    ? ok('…another movement’s stamps are not asked again')
    : bad('restamp scope');
  setUndoStands(restamped, cut.removed) &&
  setUndoStands(
    restamped.map((b) =>
      b.key === 1 ? { ...b, sets: b.sets.map((s) => (s.key === 13 ? { ...s, reps: '7' } : s)) } : b
    ),
    cut.removed
  )
    ? ok('the Undo stands, and still stands after another row’s figure is edited')
    : bad('undo stands');
  const back = restampMovement(undoSetRemoval(restamped, cut.removed), 'bench', ask);
  back[0].sets.map((s) => s.key).join() === '11,12,13' &&
  back[0].sets[0].pr === true &&
  back[0].sets[1].pr === false &&
  back[0].sets[1].prKinds === undefined
    ? ok('Undo: the 110 back at set 1 with its stamp, and the 105’s stamp taken back')
    : bad('undo', JSON.stringify(back[0].sets));
  const grown = restamped.map((b) => (b.key === 1 ? { ...b, sets: [...b.sets, set(14)] } : b));
  !setUndoStands(grown, cut.removed) && undoSetRemoval(grown, cut.removed) === grown
    ? ok('…a set added since closes it: putting one back would no longer be exact')
    : bad('undo closes on add');
  !setUndoStands(
    restamped.filter((b) => b.key !== 1),
    cut.removed
  )
    ? ok('…and so does removing the exercise')
    : bad('undo closes on block remove');
  removeSetWithUndo(start, 1, 999, LB).removed === null &&
  removeSetWithUndo(start, 9, 11, LB).blocks === start
    ? ok('a key that names nothing removes nothing')
    : bad('unknown key');
  setFigure(set(1, { time: '1:30' }), 'time', KG) === '1:30' &&
  setFigure(set(1), 'reps,load', KG) === null
    ? ok('the figure of a timed set is its clock; an empty row has none')
    : bad('figure');
  const notDone = restampMovement(
    [blockOf(1, 'bench', 'Bench', [set(1, { weight: '120', pr: true, prKinds: ['heaviest'] })])],
    'bench',
    ask
  );
  notDone[0].sets[0].pr === false && notDone[0].sets[0].prKinds === undefined
    ? ok('a set not done carries no stamp after a restamp')
    : bad('not-done stamp');

  // --- the draft carries the target and last time's set types ----------------
  const withTarget = {
    version: DRAFT_VERSION,
    sessionId: 's',
    startedAt: 1,
    routineId: null,
    ingestId: null,
    restEndsAt: null,
    away: false,
    blocks: [
      blockOf(1, 'bench', 'Bench', [set(1)], {
        prev: [prevRow(10, 60, { setType: 'warmup' }), prevRow(8, 100)],
        target: { kind: 'hold', weightKg: 100, reps: 9, repHigh: 10, note: 'Hold the load.' },
      }),
    ],
  };
  JSON.stringify(parseLiveDraft(JSON.parse(JSON.stringify(withTarget)))) ===
  JSON.stringify(withTarget)
    ? ok('a draft with a target and set-typed prev rows round-trips byte for byte')
    : bad('target round trip', JSON.stringify(parseLiveDraft(withTarget)));
  const junk = parseLiveDraft({
    ...withTarget,
    blocks: [
      {
        ...withTarget.blocks[0],
        prev: [{ ...prevRow(8, 100), setType: 'bogus' }],
        target: { kind: 'yolo', weightKg: 100, reps: 9, repHigh: 10 },
      },
    ],
  });
  junk && junk.blocks[0].target === undefined && !('setType' in junk.blocks[0].prev[0])
    ? ok('…while a malformed target or an unknown set type is dropped, not trusted')
    : bad('junk target', JSON.stringify(junk?.blocks[0]));
  const old = parseLiveDraft({ ...withTarget, blocks: [blockOf(1, 'bench', 'Bench', [set(1)])] });
  old && !('target' in old.blocks[0])
    ? ok('…and a draft from before targets resumes without one (last time’s numbers)')
    : bad('old draft');

  // --- the picker's AI row says what the search found (68) -------------------
  const door = (query, offered, shown, available = true) =>
    aiDoorCopy({ query, offered, shown, available });
  door('', false, 69).lead.startsWith('Not in the catalog?') &&
  door('', false, 69).enabled &&
  door('landmine press', true, 0).lead.startsWith('ARC doesn’t have this one.') &&
  door('jefferson curl', true, 4).lead.startsWith('ARC doesn’t have a close match.') &&
  door('bench', false, 6).lead.startsWith('Not what you’re after?') &&
  door('bench', false, 6).spoken === 'Add bench with AI'
    ? ok('the AI row stands on every search: empty, no match, a reach, and under real matches')
    : bad('ai door copy');
  const noKey = door('bench', false, 6, false);
  !noKey.enabled && noKey.lead.includes('model key')
    ? ok('…and with no model key it stays, says what it needs, and is off')
    : bad('no key door');
}

// ---------------------------------------------------------------------------
// Item 71. Owner: "should be able to use the rest of the app while in an
// exercise session." A slim bar above the tab bar (and at a pushed screen's
// foot) carries the workout, its elapsed clock and the rest countdown, and is
// one tap back to the logger. Its decisions are pure
// (src/lib/exercise/session-bar.ts); the render suite §34 draws it.
console.log('17. the session bar reads the one session and the one rest');
{
  const { db } = freshDb();
  const T0 = new Date(2026, 9, 21, 18, 0, 0).getTime();
  const block = {
    key: 1,
    exerciseId: 'barbell-bench-press',
    name: 'Barbell Bench Press',
    loggingType: 'weight_reps',
    measures: 'reps,load',
    mechanic: 'compound',
    restSec: 90,
    prev: [],
    bestE1rm: null,
    linkedToNext: false,
    sets: [
      {
        key: 2,
        weight: '80',
        reps: '8',
        rpe: '',
        time: '',
        distance: '',
        setType: 'normal',
        done: true,
        pr: false,
      },
    ],
  };
  const draft = (over = {}) => ({
    version: DRAFT_VERSION,
    sessionId: 'bar-session',
    startedAt: T0,
    routineId: null,
    ingestId: null,
    restEndsAt: null,
    away: false,
    blocks: [block],
    ...over,
  });

  // --- shows only with an open session -------------------------------------------
  readOpenLiveSession(db) === null ? ok('an empty slot: no session, so no bar') : bad('empty slot');
  saveWorkoutDraft(db, 'live', { version: DRAFT_VERSION - 1, blocks: [block] });
  readOpenLiveSession(db) === null
    ? ok('a draft from another build is no session either — the same gate Home and the hub read')
    : bad('stale version');
  saveWorkoutDraft(db, 'manual', { version: DRAFT_VERSION, sets: [] });
  clearWorkoutDraft(db, 'live');
  readOpenLiveSession(db) === null
    ? ok('the manual slot alone puts nothing on the bar (it has no clock and no rest)')
    : bad('manual slot');
  clearWorkoutDraft(db, 'manual');

  saveWorkoutDraft(db, 'live', draft());
  const open = readOpenLiveSession(db);
  open?.name === 'Workout' && open.draft.startedAt === T0
    ? ok('an open session with no saved workout is named as the logger titles it: "Workout"')
    : bad('unnamed session', JSON.stringify(open)?.slice(0, 120));

  const routineId = createRoutine(db, { name: '  Push day ', notes: null, exercises: [] });
  saveWorkoutDraft(db, 'live', draft({ routineId }));
  readOpenLiveSession(db)?.name === 'Push day'
    ? ok("a session started from a saved workout carries that workout's name")
    : bad('routine name', readOpenLiveSession(db)?.name);
  deleteRoutine(db, routineId);
  readOpenLiveSession(db)?.name === 'Workout'
    ? ok('…and falls back to "Workout" when that saved workout has since been deleted')
    : bad('deleted routine name');

  // --- the elapsed clock and the rest, from the draft's own instants ------------
  const session = { draft: draft({ restEndsAt: T0 + 25 * 60_000 + 90_000 }), name: 'Push day' };
  const at = T0 + 25 * 60_000 + 3_000; // 25:03 in, 87 s of rest left
  const v = sessionBarView(session, at);
  v.elapsed === '25:03' && v.rest?.kind === 'running' && v.rest.clock === '1:27'
    ? ok('25:03 elapsed and 1:27 of rest — both computed from the draft, not counted')
    : bad('running view', JSON.stringify(v));
  v.accessibilityLabel ===
  'Push day in progress, 25:03 elapsed, rest 1:27 left. Return to the workout'
    ? ok('VoiceOver hears the whole bar as one button that says where it goes')
    : bad('a11y label', v.accessibilityLabel);
  const later = sessionBarView(session, at + 30_000);
  later.rest?.kind === 'running' && later.rest.clock === '0:57' && later.elapsed === '25:33'
    ? ok('thirty seconds on, both clocks have moved thirty seconds — one clock, two readings')
    : bad('later view', JSON.stringify(later));
  const done = sessionBarView(session, T0 + 25 * 60_000 + 90_000);
  done.rest?.kind === 'done' && /rest done/.test(done.accessibilityLabel)
    ? ok('at the target instant the rest reads done')
    : bad('done at target', JSON.stringify(done));
  const longAfter = sessionBarView(session, T0 + 2 * 3_600_000);
  longAfter.rest?.kind === 'done'
    ? ok('…and stays done: a rest that ran out is over until the logger starts the next')
    : bad('done later');
  sessionBarView({ draft: draft(), name: 'Workout' }, at).rest === null
    ? ok('no rest set: the bar says nothing about rest')
    : bad('no rest');

  // The arithmetic is the logger's own: the same rounding at the edge, so the
  // bar never reads 0:01 beside a logger at 0:00 (the source pin is §34).
  restRemainingSec(null, at) === null &&
  restRemainingSec(at + 400, at) === 0 &&
  restRemainingSec(at + 600, at) === 1 &&
  restRemainingSec(at - 5_000, at) === 0
    ? ok('rest left rounds to the nearest second and never goes negative, as the logger does')
    : bad('rest rounding');

  // A watch-session fill already happened: the logger shows its day, not a
  // running clock, and so does the bar.
  const fill = sessionBarView({ draft: draft({ ingestId: 'w1' }), name: 'Workout' }, at);
  fill.elapsed === null && !/elapsed/.test(fill.accessibilityLabel)
    ? ok('a watch-session fill shows no elapsed clock, as the logger shows none')
    : bad('fill elapsed', JSON.stringify(fill));
  sessionBarView(session, T0 - 60_000).elapsed === '0:00'
    ? ok('a clock set back before the start reads 0:00, not a negative time')
    : bad('clock set back');

  // --- where it is drawn ---------------------------------------------------------
  sessionBarOnScreen('stack', 'labs') &&
  sessionBarOnScreen('stack', 'workout-log') &&
  !sessionBarOnScreen('stack', LIVE_LOGGER_ROUTE) &&
  !sessionBarOnScreen('tab', 'index') &&
  !sessionBarOnScreen(undefined, 'labs') &&
  LIVE_LOGGER_ROUTE === 'workout-live'
    ? ok('a pushed screen draws it, the live logger never, a tab root leaves it to the tab bar')
    : bad('placement');
  LIVE_LOGGER_RESUME.pathname === '/workout-live' && LIVE_LOGGER_RESUME.params.resume === '1'
    ? ok("a tap goes where Home's Resume row goes: the live logger, resuming the slot")
    : bad('resume href');

  // --- it hears the session end ----------------------------------------------------
  // Every write and every clear announces itself, so a bar that is not the
  // focused screen still learns at once that the session has gone.
  let heard = 0;
  const stop = subscribeWorkoutDrafts(() => heard++);
  saveWorkoutDraft(db, 'live', draft());
  const afterSave = heard;
  clearOwnLiveDraft(db, 'bar-session'); // Finish / the logger's own Discard
  const afterFinish = heard;
  saveWorkoutDraft(db, 'live', draft());
  clearWorkoutDraft(db, 'live'); // the Train hub's trash
  afterSave === 1 && afterFinish === 2 && heard === 4 && readOpenLiveSession(db) === null
    ? ok('a write, a Finish and a hub discard are each announced — and the bar then reads nothing')
    : bad('announcements', `${afterSave} ${afterFinish} ${heard}`);
  saveWorkoutDraft(db, 'live', draft({ sessionId: 'theirs' }));
  const beforeRefusal = heard;
  clearOwnLiveDraft(db, 'bar-session');
  heard === beforeRefusal && readOpenLiveSession(db) !== null
    ? ok("a clear refused for someone else's session announces nothing and the bar stays")
    : bad('refused clear');
  const loud = subscribeWorkoutDrafts(() => {
    throw new Error('listener broke');
  });
  const warn = console.warn;
  console.warn = () => {};
  let survived = false;
  try {
    clearWorkoutDraft(db, 'live');
    survived = readWorkoutDraft(db, 'live') === null;
  } finally {
    console.warn = warn;
  }
  survived && heard === beforeRefusal + 1
    ? ok('a listener that throws stops neither the clear nor the other listeners')
    : bad('throwing listener');
  loud();
  stop();
  saveWorkoutDraft(db, 'live', draft());
  heard === beforeRefusal + 1 ? ok('an unsubscribed bar hears nothing more') : bad('unsubscribe');
  // --- it hears only its own slot, and re-renders only for a change it draws ----------
  // (review, 2026-10-21). Every keystroke in either logger writes its slot, and
  // each mounted bar host re-read and re-rendered on each one.
  const readOpenLiveSessionWith = (d, value) => {
    saveWorkoutDraft(d, 'live', value);
    return readOpenLiveSession(d);
  };
  const keys = [];
  const stopKeys = subscribeWorkoutDrafts((key) => keys.push(key));
  saveWorkoutDraft(db, 'manual', { version: DRAFT_VERSION, sets: [] });
  saveWorkoutDraft(db, 'live', draft());
  clearWorkoutDraft(db, 'manual');
  clearWorkoutDraft(db, 'live');
  stopKeys();
  JSON.stringify(keys) === JSON.stringify(['manual', 'live', 'manual', 'live'])
    ? ok('each write and clear announces WHICH slot changed')
    : bad('announced keys', JSON.stringify(keys));
  barHearsSlot('live') && !barHearsSlot('manual')
    ? ok('the bar listens to the live slot only — a manual logger’s keystrokes are not its business')
    : bad('barHearsSlot');

  saveWorkoutDraft(db, 'live', draft());
  const held = readOpenLiveSession(db);
  // A keystroke: a set's reps change, nothing the bar draws does.
  saveWorkoutDraft(db, 'live', draft({ blocks: [{ ...block, sets: [{ ...block.sets[0], reps: '9' }] }] }));
  const typed = readOpenLiveSession(db);
  // An identical write (the same text again).
  saveWorkoutDraft(db, 'live', draft());
  const same = readOpenLiveSession(db);
  typed !== held && sameSessionBar(held, typed) && sameSessionBar(held, same)
    ? ok('a keystroke or an identical write draws the same bar, so the host keeps its session object')
    : bad('same bar');
  !sameSessionBar(held, readOpenLiveSessionWith(db, draft({ restEndsAt: T0 + 90_000 }))) &&
  !sameSessionBar(held, readOpenLiveSessionWith(db, draft({ startedAt: T0 + 1 }))) &&
  !sameSessionBar(held, readOpenLiveSessionWith(db, draft({ sessionId: 'another' }))) &&
  !sameSessionBar(held, readOpenLiveSessionWith(db, draft({ ingestId: 'watch-1' }))) &&
  !sameSessionBar(held, null) &&
  !sameSessionBar(null, held) &&
  sameSessionBar(null, null)
    ? ok('a new rest, start, session, watch fill or the session ending each redraw the bar')
    : bad('different bar');
  const hostSource = readFileSync(
    new URL('../src/components/exercise/session-bar.tsx', import.meta.url),
    'utf8'
  );
  /if \(barHearsSlot\(key\)\) refresh\(\);/.test(hostSource) &&
  /setSession\(\(prev\) => \(sameSessionBar\(prev, next\) \? prev : next\)\)/.test(hostSource)
    ? ok('the hosts ignore the manual slot and keep the session they have when the bar would not change')
    : bad('host wiring');
  clearWorkoutDraft(db, 'live');

  clearWorkoutDraft(db, 'live');
}

console.log('18. item 70 — a finished session ticks the earliest open Training row, with Undo');
{
  const TODAY = '2026-10-21';
  const YESTERDAY = '2026-10-20';
  const block = (db, items) =>
    createProtocolWithVersion(
      db,
      { name: 'Strength block', type: 'training_block' },
      { items: items.map(([title, time]) => ({ title, scheduled_time: time, dose: null, notes: null })) }
    );
  const stack = (db) =>
    createProtocolWithVersion(
      db,
      { name: 'Stack', type: 'supplement_stack' },
      { items: [{ title: 'Creatine', scheduled_time: '06:00', dose: '5 g', notes: null }] }
    );
  const session = (db, opts = {}) =>
    logWorkout(db, {
      date: opts.date ?? TODAY,
      kind: 'strength',
      routineId: opts.routineId ?? null,
      away: opts.away ?? false,
    });
  const rowOf = (raw, title, date = TODAY) =>
    raw
      .prepare(
        `SELECT e.id, e.status, e.value FROM log_entries e JOIN daily_logs d ON d.id = e.daily_log_id
          WHERE d.date = ? AND e.title = ?`
      )
      .get(date, title);
  const statusOf = (raw, title, date) => rowOf(raw, title, date)?.status;
  const markOf = (raw, title, date) => JSON.parse(rowOf(raw, title, date)?.value ?? '{}').by_workout;
  const routine = (db, name) => createRoutine(db, { name, notes: null, exercises: [] });

  // --- the earliest open row, and only a Training one ------------------------
  {
    const { db, raw } = freshDb();
    stack(db);
    block(db, [
      ['Lift', '18:00'],
      ['Zone 2', '07:00'],
    ]);
    const first = session(db);
    const tick = tickTrainingForWorkout(db, first, TODAY);
    tick?.title === 'Zone 2' &&
    statusOf(raw, 'Zone 2') === 'completed' &&
    statusOf(raw, 'Lift') === 'pending' &&
    statusOf(raw, 'Creatine') === 'pending'
      ? ok('the earliest open Training row ticks (07:00 before 18:00), and the 06:00 supplement does not')
      : bad('earliest open', JSON.stringify(tick));
    const zone = JSON.parse(rowOf(raw, 'Zone 2').value);
    zone.by_workout === first && zone.done_on === TODAY
      ? ok('…through the normal tick: done_on stamped, and the row carries the session’s id')
      : bad('mark', JSON.stringify(zone));

    // Two sessions in a day: the second takes the next open row.
    const second = session(db);
    const tick2 = tickTrainingForWorkout(db, second, TODAY);
    tick2?.title === 'Lift' && markOf(raw, 'Lift') === second
      ? ok('a second session the same day ticks the next open Training row')
      : bad('second session', JSON.stringify(tick2));
    tickTrainingForWorkout(db, session(db), TODAY) === null
      ? ok('…and a third, with none left open, ticks nothing')
      : bad('third session');

    // The same session never ticks twice — a repeated call, or an edit.
    replaceWorkout(db, first, { kind: 'strength', durationMin: 45, notes: 'edited' }, []);
    tickTrainingForWorkout(db, first, TODAY) === null && markOf(raw, 'Zone 2') === first
      ? ok('an edited session does not tick again, and keeps the row it ticked')
      : bad('edit re-tick');
  }

  // --- done and skipped rows are never touched -------------------------------
  {
    const { db, raw } = freshDb();
    block(db, [
      ['Zone 2', '07:00'],
      ['Lift', '18:00'],
    ]);
    tickTrainingForWorkout(db, session(db), TODAY); // generates the day
    setMissionStatus(db, rowOf(raw, 'Zone 2').id, 'pending', TODAY);
    setMissionStatus(db, rowOf(raw, 'Zone 2').id, 'skipped', TODAY);
    const t = tickTrainingForWorkout(db, session(db), TODAY);
    t?.title === 'Lift' && statusOf(raw, 'Zone 2') === 'skipped'
      ? ok('a skipped row is passed over, and stays skipped')
      : bad('skipped', JSON.stringify(t));
    tickTrainingForWorkout(db, session(db), TODAY) === null
      ? ok('…and with the rest done, nothing ticks')
      : bad('all settled');
  }
  {
    const { db, raw } = freshDb();
    block(db, [
      ['Zone 2', '07:00'],
      ['Lift', '18:00'],
    ]);
    arriveDay(db, TODAY);
    tickTrainingForWorkout(db, session(db, { away: true }), TODAY) === null &&
    statusOf(raw, 'Zone 2') === 'pending' && statusOf(raw, 'Lift') === 'pending'
      ? ok('an Away session ticks nothing')
      : bad('away');
    setMissionStatus(db, rowOf(raw, 'Zone 2').id, 'completed', TODAY);
    const t = tickTrainingForWorkout(db, session(db), TODAY);
    t?.title === 'Lift' && markOf(raw, 'Zone 2') === undefined
      ? ok('a row ticked by hand is passed over and wears no session’s mark')
      : bad('done by hand', JSON.stringify(t));
  }

  // --- a row that names a saved workout ---------------------------------------
  {
    const { db, raw } = freshDb();
    const push = routine(db, 'Push Day');
    const pull = routine(db, 'Pull Day');
    block(db, [
      ['PUSH DAY', '07:00'],
      ['Cardio', '18:00'],
    ]);
    const viaPush = session(db, { routineId: push });
    const t = tickTrainingForWorkout(db, viaPush, TODAY);
    t?.title === 'PUSH DAY' && statusOf(raw, 'Cardio') === 'pending'
      ? ok('a row named after a saved workout ticks when THAT workout finishes (case-folded)')
      : bad('named match', JSON.stringify(t));

    const { db: db2, raw: raw2 } = freshDb();
    routine(db2, 'Push Day');
    const pull2 = routine(db2, 'Pull Day');
    block(db2, [
      ['Push Day', '07:00'],
      ['Cardio', '18:00'],
    ]);
    const free = tickTrainingForWorkout(db2, session(db2), TODAY);
    free?.title === 'Cardio' && statusOf(raw2, 'Push Day') === 'pending'
      ? ok('a free session falls through the named row to the next open unnamed one')
      : bad('free fallthrough', JSON.stringify(free));
    tickTrainingForWorkout(db2, session(db2, { routineId: pull2 }), TODAY) === null &&
    statusOf(raw2, 'Push Day') === 'pending'
      ? ok('a different saved workout never ticks the named row; with nothing else open, nothing')
      : bad('non-matching named');

    const { db: db3, raw: raw3 } = freshDb();
    routine(db3, 'Push Day');
    const pull3 = routine(db3, 'Pull Day');
    block(db3, [
      ['Push Day', '07:00'],
      ['Pull Day', '12:00'],
      ['Mobility', '18:00'],
    ]);
    const fall = tickTrainingForWorkout(db3, session(db3, { routineId: pull3 }), TODAY);
    fall?.title === 'Pull Day' && statusOf(raw3, 'Push Day') === 'pending'
      ? ok('Pull Day skips the earlier Push Day row and ticks its own')
      : bad('named fallthrough', JSON.stringify(fall));
    trainingRowFor(db3, { date: TODAY, routineId: null, away: false }, TODAY)?.title === 'Mobility'
      ? ok('…and the read-only choice a card shows agrees: a free session would take Mobility')
      : bad('trainingRowFor');
    void pull;
  }

  // --- a session for yesterday ------------------------------------------------
  {
    const { db, raw } = freshDb();
    block(db, [['Lift', '18:00']]);
    arriveDay(db, YESTERDAY); // yesterday's day exists, its row open
    const late = session(db, { date: YESTERDAY });
    tickTrainingForWorkout(db, late, TODAY) === null &&
    statusOf(raw, 'Lift', YESTERDAY) === 'pending' &&
    rowOf(raw, 'Lift', TODAY) === undefined
      ? ok('a session logged for yesterday ticks nothing, on either day')
      : bad('yesterday');
  }

  // --- the Status rule ---------------------------------------------------------
  {
    const { db, raw } = freshDb();
    block(db, [
      ['Zone 2', '07:00'],
      ['Lift', '18:00'],
    ]);
    startStatus(db, { label: 'Sick', startDate: TODAY, source: 'user', excuses: true });
    const t = tickTrainingForWorkout(db, session(db), TODAY);
    t?.title === 'Zone 2' && statusOf(raw, 'Lift') === 'pending'
      ? ok('a status changes nothing about which row ticks')
      : bad('status', JSON.stringify(t));
  }

  // --- delete takes back only its own tick -----------------------------------
  {
    const { db, raw } = freshDb();
    block(db, [
      ['Zone 2', '07:00'],
      ['Lift', '18:00'],
    ]);
    const a = session(db);
    tickTrainingForWorkout(db, a, TODAY);
    const b = session(db);
    tickTrainingForWorkout(db, b, TODAY);
    const reopened = deleteWorkout(db, a, TODAY);
    const zone = JSON.parse(rowOf(raw, 'Zone 2').value);
    reopened.join() === 'Zone 2' &&
    statusOf(raw, 'Zone 2') === 'pending' &&
    zone.by_workout === undefined &&
    zone.done_on === undefined &&
    statusOf(raw, 'Lift') === 'completed'
      ? ok('deleting a session re-opens the row IT ticked — mark and done_on gone — and no other')
      : bad('delete undo', JSON.stringify({ reopened, zone }));

    // He un-ticks the session's row on Home and ticks it again by hand: the
    // tick is his now, and deleting the session leaves it alone.
    const liftId = rowOf(raw, 'Lift').id;
    setMissionStatus(db, liftId, 'pending', TODAY);
    setMissionStatus(db, liftId, 'completed', TODAY);
    deleteWorkout(db, b, TODAY).length === 0 && statusOf(raw, 'Lift') === 'completed'
      ? ok('a row re-ticked by hand is not taken back by deleting the session')
      : bad('hand re-tick survives delete');
    const lone = session(db);
    releaseWorkoutTick(db, lone, TODAY).length === 0
      ? ok('deleting a session that ticked nothing re-opens nothing')
      : bad('release nothing');
  }

  // --- the Undo ----------------------------------------------------------------
  {
    const { db, raw } = freshDb();
    block(db, [
      ['Zone 2', '07:00'],
      ['Lift', '18:00'],
    ]);
    const words = trainingTickWords('Zone 2');
    words.said === 'Ticked Training: Zone 2' &&
    words.figure === null &&
    words.spoken === 'Undo ticking Zone 2' &&
    words.icon === 'barbell-outline'
      ? ok('the row says "Ticked Training: Zone 2" and VoiceOver hears "Undo ticking Zone 2"')
      : bad('words', JSON.stringify(words));

    const tick = tickTrainingForWorkout(db, session(db), TODAY);
    let synced = 0;
    offerUndo(trainingTickOffer(db, tick, () => synced++));
    const offer = currentUndo();
    offer?.scope.on === 'training' && offer.scope.date === TODAY
      ? ok('the Undo is offered in the shared slot, scoped to today’s training')
      : bad('offer scope', JSON.stringify(offer?.scope));
    // untickTraining runs against the real clock's today for the days-ahead
    // re-derive; the row itself is addressed by id.
    runUndo() === true &&
    statusOf(raw, 'Zone 2') === 'pending' &&
    markOf(raw, 'Zone 2') === undefined &&
    statusOf(raw, 'Lift') === 'pending' &&
    synced === 1 &&
    currentUndo() === null
      ? ok('Undo unticks exactly that row, re-syncs reminders, and closes')
      : bad('undo', JSON.stringify({ synced, z: statusOf(raw, 'Zone 2') }));

    // A row he settled himself since cannot be undone by the session's Undo.
    const again = tickTrainingForWorkout(db, session(db), TODAY);
    offerUndo(trainingTickOffer(db, again, () => {}));
    setMissionStatus(db, again.entryId, 'pending', TODAY);
    setMissionStatus(db, again.entryId, 'skipped', TODAY);
    runUndo() === false && currentUndo()?.refused === true && statusOf(raw, 'Zone 2') === 'skipped'
      ? ok('an Undo after he changed the row himself is refused, and the row keeps his decision')
      : bad('refused undo');
    throws(() => untickTraining(db, again, TODAY))
      ? ok('…and untickTraining itself refuses a row that no longer holds the tick')
      : bad('untick refuse');
    closeUndo();
  }

  // --- the app-side helper: tick, sync, offer ---------------------------------
  {
    const { db, raw } = freshDb();
    block(db, [['Lift', '23:59']]);
    const today = todayISODate();
    const w = logWorkout(db, { date: today, kind: 'strength' });
    let synced = 0;
    const tick = tickTrainingAfterSave(db, w, () => synced++);
    tick?.title === 'Lift' &&
    statusOf(raw, 'Lift', today) === 'completed' &&
    synced === 1 &&
    currentUndo()?.said === 'Ticked Training: Lift'
      ? ok('tickTrainingAfterSave ticks today’s row, re-syncs reminders once, and offers the Undo')
      : bad('after-save helper', JSON.stringify({ tick, synced }));
    closeUndo();
    const none = tickTrainingAfterSave(db, 'no-such-workout', () => synced++);
    none === null && synced === 1 && currentUndo() === null
      ? ok('…and offers nothing when nothing ticked')
      : bad('helper with nothing');
  }

  // --- every finish path calls it --------------------------------------------
  {
    const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
    const live = src('app/workout-live.tsx');
    const log = src('app/workout-log.tsx');
    const imp = src('app/workout-import.tsx');
    const coach = src('src/lib/ai/tools/write-tools.ts');
    live.includes('if (!stored && savedId) tickTrainingAfterSave(getDb(), savedId);')
      ? ok('the live logger ticks after a NEW session’s commit, never after an edit')
      : bad('workout-live wiring');
    log.includes('tickTrainingAfterSave(getDb(), savedId);')
      ? ok('the free-form logger ticks after its commit')
      : bad('workout-log wiring');
    imp.includes('tickTrainingAfterSave(getDb(), savedId);')
      ? ok('the photo import ticks after its commit')
      : bad('workout-import wiring');
    coach.includes('tickTrainingForWorkout(db, id, todayISODate(context.now))')
      ? ok('the Coach’s log_workout ticks after its commit, on the turn’s own today')
      : bad('log_workout wiring');
    // Pairing never ticks: the pass attaches a watch record to a session that
    // was already saved (and already ticked, or not).
    !src('src/lib/db/repositories/workout-ingest.ts').includes('tickTraining') &&
    !src('src/lib/health/sync.ts').includes('tickTraining')
      ? ok('the pairing pass and the Health sync never tick')
      : bad('pairing ticks');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
