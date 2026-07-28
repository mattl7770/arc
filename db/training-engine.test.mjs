/**
 * Headless test of the rule-based training engine (docs/exercise-subapp.md §4):
 * the PURE modules (e1rm, freshness, progression, recommend) and the DB-backed
 * analytics/compose reads (training-stats, training-recommend). Real SQLite via
 * node:sqlite; op-sqlite never loaded. Mirrors db/nutrition.test.mjs. Run:
 * npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { logWorkout } from '../src/lib/db/repositories/exercise.ts';
import { createRoutine } from '../src/lib/db/repositories/routines.ts';
import {
  e1rmSeries,
  exerciseSessionTops,
  lastSessionSets,
  personalRecords,
  recentMuscleLoads,
  weeklyMuscleSets,
} from '../src/lib/db/repositories/training-stats.ts';
import { buildRecommendation } from '../src/lib/db/repositories/training-recommend.ts';
import {
  countsForE1rm,
  e1rmForSet,
  effectiveReps,
  weightForReps,
} from '../src/lib/exercise/e1rm.ts';
import { meanFreshness, muscleFreshness } from '../src/lib/exercise/freshness.ts';
import { suggestProgression } from '../src/lib/exercise/progression.ts';
import { recommendToday } from '../src/lib/exercise/recommend.ts';

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
const near = (a, b, eps = 0.5) => typeof a === 'number' && Math.abs(a - b) < eps;

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

// Fixed "now" so freshness decay + week math are deterministic.
const NOW = new Date('2026-07-26T18:00:00.000Z');
/** Log a session whose created_at we control (freshness keys on created_at). */
function logAt(db, raw, whenIso, date, name, kind, sets) {
  const id = logWorkout(db, { date, name, kind }, sets);
  raw.prepare('UPDATE workouts SET created_at = ? WHERE id = ?').run(whenIso, id);
  return id;
}
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

// ---------------------------------------------------------------------------
console.log('1. e1RM: Epley over reps + RIR, with the near-failure filter');
{
  // Epley at 5 reps, no RPE: 100 * (1 + 5/30) = 116.67
  near(e1rmForSet(100, 5, null, 'normal'), 116.67)
    ? ok('e1RM(100kg × 5) = 116.7 (Epley, RIR 0)')
    : bad('epley 5', e1rmForSet(100, 5, null, 'normal'));
  // RPE 8 at 3 reps → n = 3 + 2 = 5 → same as 5 straight reps
  near(e1rmForSet(100, 3, 8, 'normal'), e1rmForSet(100, 5, null, 'normal'))
    ? ok('RPE 8 × 3 reps ≡ 5 reps to failure (reps + RIR collapse)')
    : bad('rpe collapse');
  effectiveReps(3, 8) === 5 ? ok('effectiveReps(3 reps, RPE 8) = 5') : bad('effReps');
  // filters
  !countsForE1rm(100, 15, null, 'normal')
    ? ok('a 15-rep set is filtered (> rep cap)')
    : bad('rep cap');
  !countsForE1rm(100, 5, null, 'warmup') ? ok('a warmup set is filtered') : bad('warmup filter');
  !countsForE1rm(100, 5, 5, 'normal')
    ? ok('RPE 5 (RIR 5) set is filtered (too submaximal)')
    : bad('rir filter');
  e1rmForSet(null, 5, null, 'normal') === null
    ? ok('a bodyweight (null load) set → null e1RM')
    : bad('null load');
  // inverse
  near(weightForReps(120, 5, 2), 120 / (1 + 7 / 30))
    ? ok('weightForReps inverts Epley (target reps at target RIR)')
    : bad('inverse');
}

// ---------------------------------------------------------------------------
console.log('2. freshness: fresh when rested, depleted right after, decays back');
{
  const loads = [
    // 5 hard primary chest sets, just now
    ...Array.from({ length: 5 }, () => ({
      muscle: 'chest',
      roleWeight: 1,
      reps: 8,
      rpe: 8,
      weightKg: 80,
      setType: 'normal',
      whenIso: hoursAgo(0.1),
    })),
  ];
  const ledger = muscleFreshness(loads, NOW);
  const chest = ledger.find((m) => m.muscle === 'chest');
  chest.freshness < 50 && chest.state === 'fatigued'
    ? ok('5 hard chest sets just now → chest reads fatigued (< 50)')
    : bad('chest fresh now', JSON.stringify(chest));
  ledger.find((m) => m.muscle === 'quads').freshness === 100
    ? ok('an untrained muscle reads 100 / fresh')
    : bad('untrained');
  ledger.length === 16
    ? ok('ledger has all 16 muscles in order')
    : bad('ledger size', ledger.length);
  // same load 96h ago → chest recovered (72h muscle, τ=24h → ~2% left)
  const old = loads.map((l) => ({ ...l, whenIso: hoursAgo(96) }));
  const recovered = muscleFreshness(old, NOW).find((m) => m.muscle === 'chest');
  recovered.freshness >= 80 && recovered.state === 'fresh'
    ? ok('same volume 96h ago → chest recovered to fresh (decay)')
    : bad('decay', JSON.stringify(recovered));
  // secondary counts half
  const sec = muscleFreshness(
    [
      {
        muscle: 'triceps',
        roleWeight: 0.5,
        reps: 8,
        rpe: 8,
        weightKg: 40,
        setType: 'normal',
        whenIso: hoursAgo(0.1),
      },
    ],
    NOW
  ).find((m) => m.muscle === 'triceps');
  const prim = muscleFreshness(
    [
      {
        muscle: 'triceps',
        roleWeight: 1,
        reps: 8,
        rpe: 8,
        weightKg: 40,
        setType: 'normal',
        whenIso: hoursAgo(0.1),
      },
    ],
    NOW
  ).find((m) => m.muscle === 'triceps');
  sec.freshness > prim.freshness
    ? ok('a secondary (0.5) fatigues less than a primary (1.0) — fractional counting')
    : bad('fractional', `${sec.freshness} vs ${prim.freshness}`);
  // warmups ignored
  muscleFreshness(
    [
      {
        muscle: 'chest',
        roleWeight: 1,
        reps: 5,
        rpe: null,
        weightKg: 40,
        setType: 'warmup',
        whenIso: hoursAgo(0.1),
      },
    ],
    NOW
  ).find((m) => m.muscle === 'chest').freshness === 100
    ? ok('warmup sets do not deplete freshness')
    : bad('warmup freshness');
  meanFreshness(ledger, ['chest', 'quads']) === Math.round((chest.freshness + 100) / 2)
    ? ok('meanFreshness averages the named muscles')
    : bad('meanFreshness');
}

// ---------------------------------------------------------------------------
console.log('3. progression: double progression, stall → deload, cold start');
{
  const range = { low: 5, high: 8 };
  const inc = 2.5;
  // hit top of range with a rep in reserve → add load, reset reps
  const prog = suggestProgression({
    sessions: [{ date: '2026-07-20', weightKg: 100, reps: 8, rpe: 8 }],
    repRange: range,
    incrementKg: inc,
  });
  prog.kind === 'progress' && near(prog.targetWeightKg, 102.5) && prog.targetReps === 5
    ? ok('top of range at RIR≥1 → progress (+increment, reset to bottom)')
    : bad('progress', JSON.stringify(prog));
  // mid-range → hold, chase a rep
  const hold = suggestProgression({
    sessions: [{ date: '2026-07-20', weightKg: 100, reps: 6, rpe: 9 }],
    repRange: range,
    incrementKg: inc,
  });
  hold.kind === 'hold' && near(hold.targetWeightKg, 100) && hold.targetReps === 7
    ? ok('mid-range → hold the load, add a rep')
    : bad('hold', JSON.stringify(hold));
  // 3 stalled sessions, no strength gain, below top → deload
  const deload = suggestProgression({
    sessions: [
      { date: '2026-07-10', weightKg: 100, reps: 6, rpe: 9 },
      { date: '2026-07-13', weightKg: 100, reps: 6, rpe: 9 },
      { date: '2026-07-16', weightKg: 100, reps: 6, rpe: 9 },
    ],
    repRange: range,
    incrementKg: inc,
  });
  deload.kind === 'deload' && near(deload.targetWeightKg, 90)
    ? ok('3 sessions with no gain, below top → deload ~10%')
    : bad('deload', JSON.stringify(deload));
  // no history → find weight
  const cold = suggestProgression({ sessions: [], repRange: range, incrementKg: inc });
  cold.kind === 'find_weight' && cold.targetWeightKg === null && cold.targetReps === 5
    ? ok('no loaded history → find_weight at the bottom of the range')
    : bad('cold start', JSON.stringify(cold));
}

// ---------------------------------------------------------------------------
console.log('4. training-stats: PRs, e1RM series, session tops, prefill, muscle loads');
{
  const { db, raw } = freshDb();
  // three bench sessions, progressing
  logAt(db, raw, hoursAgo(240), '2026-07-16', 'Upper A', 'strength', [
    { exercise: 'Bench', exerciseId: 'barbell-bench-press', reps: 5, weightKg: 100, rpe: 8 },
  ]);
  logAt(db, raw, hoursAgo(120), '2026-07-21', 'Upper A', 'strength', [
    { exercise: 'Bench', exerciseId: 'barbell-bench-press', reps: 5, weightKg: 102.5, rpe: 8 },
    { exercise: 'Bench', exerciseId: 'barbell-bench-press', reps: 4, weightKg: 102.5, rpe: 9 },
    // a warmup that must NOT count
    {
      exercise: 'Bench',
      exerciseId: 'barbell-bench-press',
      reps: 5,
      weightKg: 60,
      setType: 'warmup',
    },
  ]);
  logAt(db, raw, hoursAgo(10), '2026-07-26', 'Upper A', 'strength', [
    { exercise: 'Bench', exerciseId: 'barbell-bench-press', reps: 6, weightKg: 105, rpe: 8 },
  ]);

  const pr = personalRecords(db, 'barbell-bench-press');
  near(pr.maxWeightKg, 105) && near(pr.bestSetVolumeKg, 630)
    ? ok('PRs: heaviest load 105, best set volume 105×6=630')
    : bad('PR weight/volume', JSON.stringify(pr));
  near(pr.bestE1rmKg, 105 * (1 + 8 / 30))
    ? ok('PR: best e1RM from the 105×6 @RPE8 set')
    : bad('PR e1rm', pr.bestE1rmKg);

  const series = e1rmSeries(db, 'barbell-bench-press');
  series.length === 3 && series[0].date === '2026-07-16' && series[2].date === '2026-07-26'
    ? ok('e1RM series: one point per session date, oldest → newest')
    : bad('series', JSON.stringify(series));
  series[2].e1rm > series[0].e1rm
    ? ok('e1RM trends up across the three sessions')
    : bad('series trend');

  const tops = exerciseSessionTops(db, 'barbell-bench-press');
  tops.length === 3 && tops[0].date === '2026-07-16' && near(tops[2].weightKg, 105)
    ? ok('session tops: best working set per session, oldest → newest')
    : bad('tops', JSON.stringify(tops));

  const prev = lastSessionSets(db, 'barbell-bench-press');
  prev.length === 1 && near(prev[0].weightKg, 105) && prev[0].reps === 6
    ? ok('lastSessionSets returns the most recent session (warmup excluded)')
    : bad('prefill', JSON.stringify(prev));

  const loads = recentMuscleLoads(db, 14, NOW);
  const chestLoads = loads.filter((l) => l.muscle === 'chest');
  chestLoads.length > 0 &&
  chestLoads.every((l) => l.roleWeight === 1) &&
  !loads.some((l) => l.setType === 'warmup')
    ? ok('recentMuscleLoads maps sets→muscles (chest primary 1.0), excludes warmups')
    : bad('muscle loads', chestLoads.length);
  loads.some((l) => l.muscle === 'triceps' && l.roleWeight === 0.5)
    ? ok('bench also loads triceps as a secondary (0.5)')
    : bad('secondary load');
}

// ---------------------------------------------------------------------------
console.log('5. weeklyMuscleSets: fractional weekly volume per muscle');
{
  const { db, raw } = freshDb();
  logAt(db, raw, hoursAgo(10), '2026-07-22', 'Upper', 'strength', [
    { exercise: 'Bench', exerciseId: 'barbell-bench-press', reps: 8, weightKg: 80 },
    { exercise: 'Bench', exerciseId: 'barbell-bench-press', reps: 8, weightKg: 80 },
  ]);
  const vol = weeklyMuscleSets(db, NOW);
  const chest = vol.find((v) => v.muscle === 'chest');
  const tri = vol.find((v) => v.muscle === 'triceps');
  chest.sets === 2 && tri.sets === 1
    ? ok('2 bench sets → chest 2.0 (primary), triceps 1.0 (2 × 0.5 secondary)')
    : bad('weekly volume', JSON.stringify({ chest, tri }));
}

// ---------------------------------------------------------------------------
console.log('6. recommendToday (pure): freshest routine, caution, empty');
{
  const ledger = [
    { muscle: 'chest', freshness: 95, state: 'fresh', hoursSinceLast: 100 },
    { muscle: 'quads', freshness: 30, state: 'fatigued', hoursSinceLast: 5 },
  ];
  const mk = (id, m, fresh) => ({
    routineId: id,
    routineName: id,
    lastStartedAt: null,
    exercises: [
      { exerciseId: 'x', name: 'X', primaryMuscles: [m], freshness: fresh, suggestion: {} },
    ],
  });
  const rec = recommendToday(
    { ledger, routines: [mk('Push', 'chest', 95), mk('Legs', 'quads', 30)], fallbackExercises: [] },
    NOW
  );
  rec.kind === 'routine' && rec.routineName === 'Push' && !rec.caution
    ? ok('picks the freshest routine (Push over Legs)')
    : bad('pick routine', JSON.stringify(rec));
  const rec2 = recommendToday(
    { ledger, routines: [mk('Legs', 'quads', 30)], fallbackExercises: [] },
    NOW
  );
  rec2.kind === 'routine' && rec2.caution
    ? ok('a low-freshness routine is still recommended, flagged caution (never gated)')
    : bad('caution', JSON.stringify(rec2));
  const rec3 = recommendToday({ ledger, routines: [], fallbackExercises: [] }, NOW);
  rec3.kind === 'empty' ? ok('no routines + no fallback → empty guidance') : bad('empty');
}

// ---------------------------------------------------------------------------
console.log('7. buildRecommendation end-to-end (DB → engine)');
{
  const { db, raw } = freshDb();
  // Trained legs hard 6h ago; chest untouched. A routine each.
  logAt(db, raw, hoursAgo(6), '2026-07-26', 'Legs', 'strength', [
    { exercise: 'Squat', exerciseId: 'barbell-back-squat', reps: 5, weightKg: 140, rpe: 9 },
    { exercise: 'Squat', exerciseId: 'barbell-back-squat', reps: 5, weightKg: 140, rpe: 9 },
    { exercise: 'Squat', exerciseId: 'barbell-back-squat', reps: 5, weightKg: 140, rpe: 9 },
  ]);
  createRoutine(db, {
    name: 'Push',
    notes: null,
    exercises: [
      { exerciseId: 'barbell-bench-press', targetSets: 4, repLow: 5, repHigh: 8, restSec: 180 },
    ],
  });
  createRoutine(db, {
    name: 'Legs',
    notes: null,
    exercises: [
      { exerciseId: 'barbell-back-squat', targetSets: 5, repLow: 3, repHigh: 5, restSec: 240 },
    ],
  });
  const { ledger, recommendation } = buildRecommendation(db, NOW);
  ledger.find((m) => m.muscle === 'quads').freshness <
  ledger.find((m) => m.muscle === 'chest').freshness
    ? ok('ledger: quads (trained 6h ago) fresher-score below chest (untouched)')
    : bad('ledger order');
  recommendation.kind === 'routine' && recommendation.routineName === 'Push'
    ? ok('recommends Push (fresh chest) over Legs (fatigued quads)')
    : bad('e2e recommend', JSON.stringify(recommendation));
  recommendation.exercises[0].suggestion.kind === 'find_weight'
    ? ok('the bench line carries a progression suggestion (find_weight, no history)')
    : bad('e2e suggestion', JSON.stringify(recommendation.exercises[0].suggestion));
}

// ---------------------------------------------------------------------------
console.log('8. buildRecommendation fallback: no routines → freshest muscles');
{
  const { db } = freshDb();
  const { recommendation } = buildRecommendation(db, NOW);
  recommendation.kind === 'muscles' && recommendation.exercises.length > 0
    ? ok('no routines → freshest-muscle fallback with real movements')
    : bad('fallback', JSON.stringify(recommendation));
  recommendation.exercises.every((e) => e.primaryMuscles.length > 0)
    ? ok('each fallback movement has primary muscles')
    : bad('fallback muscles');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
