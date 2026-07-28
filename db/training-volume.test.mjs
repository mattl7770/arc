/**
 * Headless test of the phase-2 training engine: the weekly-volume-vs-landmarks
 * verdict (volume.ts), the program-aware + volume-aware recommendation
 * (training-recommend.ts over 0020), and the pure rest-alert builder
 * (notifications/rest-timer.ts). Real SQLite via node:sqlite; op-sqlite / Expo
 * never loaded. Mirrors db/nutrition.test.mjs. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { logWorkout } from '../src/lib/db/repositories/exercise.ts';
import { createRoutine } from '../src/lib/db/repositories/routines.ts';
import { activateProgram, createProgram } from '../src/lib/db/repositories/programs.ts';
import { buildRecommendation } from '../src/lib/db/repositories/training-recommend.ts';
import {
  muscleVolume,
  volumeAttention,
  volumeLedger,
  volumeStatus,
} from '../src/lib/exercise/volume.ts';
import { VOLUME_LANDMARKS } from '../src/lib/exercise/constants.ts';
import { buildRestAlert } from '../src/lib/notifications/rest-timer.ts';

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

// Wed 2026-07-22 noon local — its Monday-start week is Jul 20 … Jul 26.
const NOW = new Date(2026, 6, 22, 12, 0, 0);
const MONDAY = '2026-07-20';
function logAt(db, raw, whenIso, date, name, sets) {
  const id = logWorkout(db, { date, name, kind: 'strength' }, sets);
  raw.prepare('UPDATE workouts SET created_at = ? WHERE id = ?').run(whenIso, id);
  return id;
}

// ---------------------------------------------------------------------------
console.log('1. volumeStatus against MEV/MAV/MRV');
{
  const chest = VOLUME_LANDMARKS.chest; // 8 / 16 / 22
  volumeStatus(4, chest) === 'under' ? ok('below MEV → under') : bad('under');
  volumeStatus(10, chest) === 'optimal' ? ok('MEV..MAV → optimal') : bad('optimal');
  volumeStatus(18, chest) === 'approaching' ? ok('MAV..MRV → approaching') : bad('approaching');
  volumeStatus(22, chest) === 'over' ? ok('at/over MRV → over') : bad('over');
  const v = muscleVolume('chest', 4);
  v.guidance === 'Add sets' && v.mev === 8 && v.mrv === 22
    ? ok('muscleVolume carries landmarks + add/hold/cut guidance')
    : bad('muscleVolume', JSON.stringify(v));
}

console.log('2. volumeLedger + volumeAttention');
{
  const ledger = volumeLedger([
    { muscle: 'chest', sets: 4 }, // under (mev 8)
    { muscle: 'quads', sets: 22 }, // over (mrv 20)
    { muscle: 'biceps', sets: 12 }, // optimal
  ]);
  ledger.length === 16 ? ok('ledger covers all 16 muscles') : bad('ledger size', ledger.length);
  const attn = volumeAttention(ledger);
  attn.under.some((s) => s.startsWith('Chest')) &&
  !attn.under.some((s) => s.startsWith('Front delts'))
    ? ok('under-MEV flags Chest but NOT MEV-0 muscles (front delts) — no noise')
    : bad('attention.under', JSON.stringify(attn.under));
  attn.over.some((s) => s.startsWith('Quads'))
    ? ok('over-MRV flags Quads (22 ≥ 20)')
    : bad('attention.over', JSON.stringify(attn.over));
}

console.log('3. buildRecommendation surfaces the weekly volume ledger');
{
  const { db, raw } = freshDb();
  logAt(db, raw, '2026-07-22T10:00:00.000Z', '2026-07-22', 'Chest', [
    { exercise: 'Bench', exerciseId: 'barbell-bench-press', reps: 8, weightKg: 80 },
    { exercise: 'Bench', exerciseId: 'barbell-bench-press', reps: 8, weightKg: 80 },
  ]);
  const { volume } = buildRecommendation(db, NOW);
  const chest = volume.find((v) => v.muscle === 'chest');
  chest && chest.sets === 2 && chest.status === 'under'
    ? ok('volume ledger reflects this week: chest 2 sets, under MEV')
    : bad('volume in recommendation', JSON.stringify(chest));
}

console.log('4. an active program schedules today → recommendation follows the program');
{
  const { db } = freshDb();
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
  const prog = createProgram(db, {
    name: 'PL',
    notes: null,
    weeks: 5,
    // NOW is a Wednesday (dow 3) → map Wed to Legs, Mon to Push.
    days: [
      { dow: 1, routineId: push },
      { dow: 3, routineId: legs },
    ],
    weekKinds: ['accumulation', 'accumulation', 'accumulation', 'accumulation', 'deload'],
  });
  activateProgram(db, prog, MONDAY);
  const { recommendation } = buildRecommendation(db, NOW); // Wed of week 1
  recommendation.kind === 'routine' &&
  recommendation.routineName === 'Legs' &&
  recommendation.program &&
  recommendation.program.week === 1 &&
  recommendation.program.weeks === 5 &&
  recommendation.why.startsWith('Week 1 of 5')
    ? ok("program's Wed session (Legs) is recommended with week context")
    : bad('program recommend', JSON.stringify(recommendation));
}

console.log('5. a program rest day → rest recommendation (freshness pick suppressed)');
{
  const { db } = freshDb();
  const push = createRoutine(db, {
    name: 'Push',
    notes: null,
    exercises: [
      { exerciseId: 'barbell-bench-press', targetSets: 4, repLow: 5, repHigh: 8, restSec: 180 },
    ],
  });
  // Also make a second routine so the freshness pick WOULD return something if
  // the program didn't take precedence.
  createRoutine(db, {
    name: 'Legs',
    notes: null,
    exercises: [
      { exerciseId: 'barbell-back-squat', targetSets: 5, repLow: 3, repHigh: 5, restSec: 240 },
    ],
  });
  const prog = createProgram(db, {
    name: 'MonOnly',
    notes: null,
    weeks: 4,
    days: [{ dow: 1, routineId: push }], // only Monday; Wed (NOW) is rest
    weekKinds: ['accumulation', 'accumulation', 'accumulation', 'accumulation'],
  });
  activateProgram(db, prog, MONDAY);
  const { recommendation } = buildRecommendation(db, NOW); // Wed → rest
  recommendation.kind === 'rest' && recommendation.program && recommendation.program.week === 1
    ? ok('program rest day → rest recommendation, not a freshness pick')
    : bad('rest recommend', JSON.stringify(recommendation));
}

console.log('6. deload week → recommendation flags the cut, suppresses the caution');
{
  const { db, raw } = freshDb();
  const push = createRoutine(db, {
    name: 'Push',
    notes: null,
    exercises: [
      { exerciseId: 'barbell-bench-press', targetSets: 4, repLow: 5, repHigh: 8, restSec: 180 },
    ],
  });
  const prog = createProgram(db, {
    name: 'Meso',
    notes: null,
    weeks: 5,
    days: [{ dow: 3, routineId: push }], // Wed
    weekKinds: ['accumulation', 'accumulation', 'accumulation', 'accumulation', 'deload'],
  });
  // Fatigue chest hard so freshness would normally caution — deload must mute it.
  for (let i = 0; i < 6; i++) {
    logAt(db, raw, '2026-08-19T09:00:00.000Z', '2026-08-19', 'Bench', [
      { exercise: 'Bench', exerciseId: 'barbell-bench-press', reps: 8, weightKg: 80, rpe: 10 },
    ]);
  }
  activateProgram(db, prog, MONDAY);
  const deloadNow = new Date(2026, 7, 19, 12, 0, 0); // Wed 2026-08-19 → week 5
  const { recommendation } = buildRecommendation(db, deloadNow);
  recommendation.kind === 'routine' &&
  recommendation.program.weekKind === 'deload' &&
  /deload/i.test(recommendation.why) &&
  recommendation.caution === false
    ? ok('deload week: why mentions the cut, caution suppressed')
    : bad('deload recommend', JSON.stringify(recommendation));
}

console.log('7. no active program → falls back to the freshness pick (unchanged behaviour)');
{
  const { db } = freshDb();
  createRoutine(db, {
    name: 'Push',
    notes: null,
    exercises: [
      { exerciseId: 'barbell-bench-press', targetSets: 4, repLow: 5, repHigh: 8, restSec: 180 },
    ],
  });
  const { recommendation } = buildRecommendation(db, NOW);
  recommendation.kind === 'routine' &&
  recommendation.routineName === 'Push' &&
  !recommendation.program
    ? ok('with a routine but no program → freshness pick, no program context')
    : bad('fallback', JSON.stringify(recommendation));
}

console.log('8. buildRestAlert (pure) clamps + shapes the request');
{
  const a = buildRestAlert(150);
  a.trigger.type === 'timeInterval' && a.trigger.seconds === 150 && a.trigger.repeats === false
    ? ok('150s → a one-shot timeInterval trigger')
    : bad('trigger', JSON.stringify(a.trigger));
  buildRestAlert(0).trigger.seconds === 1
    ? ok('0s clamps to 1s (never fire-immediately)')
    : bad('clamp 0');
  buildRestAlert(NaN).trigger.seconds === 1 ? ok('NaN clamps to 1s') : bad('clamp NaN');
  buildRestAlert(90.6).trigger.seconds === 91 ? ok('fractional seconds round') : bad('round');
  a.content.title === 'Rest complete' && a.content.data.kind === 'rest-timer'
    ? ok('content carries a title + a rest-timer data tag')
    : bad('content', JSON.stringify(a.content));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
