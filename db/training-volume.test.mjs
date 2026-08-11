/**
 * Headless test of the phase-2 training engine: the weekly-volume-vs-landmarks
 * verdict (volume.ts), the volume-aware recommendation over saved workouts
 * (training-recommend.ts over 0020), and the pure rest-alert builder
 * (notifications/rest-timer.ts). Real SQLite via node:sqlite; op-sqlite / Expo
 * never loaded. Mirrors db/nutrition.test.mjs. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { logWorkout } from '../src/lib/db/repositories/exercise.ts';
import { createRoutine } from '../src/lib/db/repositories/routines.ts';
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

console.log('4. volumeScale dials the recommended working sets (the Coach turn passes it)');
{
  const { db } = freshDb();
  createRoutine(db, {
    name: 'Push',
    notes: null,
    exercises: [
      { exerciseId: 'barbell-bench-press', targetSets: 4, repLow: 5, repHigh: 8, restSec: 180 },
    ],
  });
  const dialled = buildRecommendation(db, NOW, { volumeScale: 0.5 }).recommendation;
  dialled.kind === 'routine' && dialled.exercises[0].targetSets === 2
    ? ok('volumeScale 0.5 halves the planned working sets (4 → 2)')
    : bad('volumeScale', JSON.stringify(dialled.kind === 'routine' ? dialled.exercises : dialled));
  const neutral = buildRecommendation(db, NOW, { volumeScale: 1 }).recommendation;
  neutral.kind === 'routine' && neutral.exercises[0].targetSets === 4
    ? ok('volumeScale 1 is a no-op (4 sets untouched)')
    : bad('neutral scale', JSON.stringify(neutral));
}

console.log('5. the freshness pick over saved workouts (the default path)');
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

console.log('6. buildRestAlert (pure) clamps + shapes the request');
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
