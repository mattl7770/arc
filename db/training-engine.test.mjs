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
import {
  getWorkoutDetail,
  listRecentSessions,
  logWorkout,
  replaceWorkout,
  weekSummary,
} from '../src/lib/db/repositories/exercise.ts';
import { sessionDetail } from '../src/lib/exercise/format.ts';
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
import {
  freshnessFromFatigue,
  meanFreshness,
  muscleFreshness,
} from '../src/lib/exercise/freshness.ts';
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
/**
 * Log a session whose created_at we control (freshness keys on created_at).
 * `away` (0055) is additive and defaults to undefined, i.e. home — which is
 * what every existing caller below means and what every workout meant before
 * the column existed.
 */
function logAt(db, raw, whenIso, date, name, kind, sets, away) {
  const id = logWorkout(db, { date, name, kind, ...(away ? { away: true } : {}) }, sets);
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
  // 5 fractional sets → 100·e^(−5/8) = 54. Under the retired linear ramp this
  // read 38/"fatigued"; the exponential says a five-set chest session is an
  // ordinary session, not a wipeout, and reserves the bottom of the scale for
  // the sessions that earn it (see §5b).
  chest.freshness === 54 && chest.state === 'recovering'
    ? ok('5 hard chest sets just now → chest reads 54 / recovering')
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
// The calibration IS the specification. The owner's 2026-08-14 report — "I just
// did a whole back day and it only hit related muscles down to 80%, they should
// have gone to like 20 or 30" — is the reason this block exists: three real
// sessions, logged the way the app logs them, pinned to the bands they should
// read. Retuning FRESH_SCALE or the shape of freshnessFromFatigue moves these
// numbers, and that is the point — you have to come here and say so.
console.log('5b. freshness calibration: a hard back day, an accessory day, one set');
{
  const { db, raw } = freshDb();
  const sets = (exerciseId, name, n) =>
    Array.from({ length: n }, () => ({ exercise: name, exerciseId, reps: 9, weightKg: 60 }));

  // A whole back day: 17 working sets over five movements. Nothing exotic —
  // this is what the seeded catalog's back exercises look like in a real log.
  const backDay = [
    ...sets('lat-pulldown', 'Lat Pulldown', 4),
    ...sets('pull-up', 'Pull-Up', 3),
    ...sets('barbell-row', 'Barbell Row', 4),
    ...sets('seated-cable-row', 'Seated Cable Row', 3),
    ...sets('face-pull', 'Face Pull', 3),
  ];
  logAt(db, raw, hoursAgo(0.5), '2026-07-26', 'Back', 'strength', backDay);
  const back = muscleFreshness(recentMuscleLoads(db, 14, NOW), NOW);
  const f = (m) => back.find((e) => e.muscle === m).freshness;

  f('lats') >= 20 && f('lats') <= 40
    ? ok(`hard back day → lats ${f('lats')} (owner's 20-40 band)`)
    : bad('back day lats', f('lats'));
  f('upper_back') >= 15 && f('upper_back') <= 40
    ? ok(`hard back day → upper back ${f('upper_back')}`)
    : bad('back day upper_back', f('upper_back'));
  // Synergists take real load but must not read as though they were the focus.
  f('biceps') > f('lats') && f('biceps') <= 60 && f('rear_delts') <= 60
    ? ok(`its synergists land mid-scale — biceps ${f('biceps')}, rear delts ${f('rear_delts')}`)
    : bad('synergists', JSON.stringify({ b: f('biceps'), r: f('rear_delts') }));
  // Nothing clips. The retired linear model printed 0 for lats AND upper back
  // AND biceps here, which is three muscles wearing one number.
  new Set([f('lats'), f('upper_back'), f('biceps')]).size === 3
    ? ok('three different volumes read as three different numbers — no clipping at zero')
    : bad('clipped', JSON.stringify([f('lats'), f('upper_back'), f('biceps')]));

  // A light accessory day: three sets of lateral raises and nothing else.
  const { db: db2, raw: raw2 } = freshDb();
  logAt(
    db2,
    raw2,
    hoursAgo(0.5),
    '2026-07-26',
    'Accessories',
    'strength',
    sets('lateral-raise', 'Lateral Raise', 3)
  );
  const acc = muscleFreshness(recentMuscleLoads(db2, 14, NOW), NOW).find(
    (e) => e.muscle === 'side_delts'
  );
  acc.freshness >= 60 && acc.freshness <= 80
    ? ok(`light accessory day (3 sets) → side delts ${acc.freshness}, dented not spent`)
    : bad('accessory day', JSON.stringify(acc));

  // One set. The floor of the model has to stay quiet, or every reading below
  // it is noise: a single set is a dent, and the muscle is still fresh.
  const { db: db3, raw: raw3 } = freshDb();
  logAt(db3, raw3, hoursAgo(0.5), '2026-07-26', 'One', 'strength', sets('barbell-curl', 'Curl', 1));
  const one = muscleFreshness(recentMuscleLoads(db3, 14, NOW), NOW).find(
    (e) => e.muscle === 'biceps'
  );
  one.freshness >= 85 && one.freshness <= 90 && one.state === 'fresh'
    ? ok(`a single hard set → ${one.freshness} / fresh (a dent, not an annihilation)`)
    : bad('single set', JSON.stringify(one));

  // Monotone and unclipped over the whole realistic range — the property the
  // `min(1, F/8)` clamp broke.
  const curve = [1, 2, 4, 8, 12, 16, 24, 32].map((n) => freshnessFromFatigue(n));
  curve.every((v, i) => i === 0 || v < curve[i - 1]) && curve[curve.length - 1] > 0
    ? ok(`freshness is strictly monotone in volume and never reaches 0: ${curve.join(' → ')}`)
    : bad('curve', curve.join(','));
}

// ---------------------------------------------------------------------------
// B1 / 0046. Before this, a run could not record its duration at all; now it
// can, and treating a 45-minute run as ONE set of quads would tell the recovery
// model that almost nothing happened — and offer a leg day the morning after a
// long run. The number below is the calibration, and this section IS the
// specification: retune ENDURANCE_MINUTES_PER_SET and this is what moves.
console.log('5c. freshness calibration: endurance work is dosed by the clock, not by the set');
{
  const run = (durationSec, rpe = null) => [
    { exercise: 'Treadmill Run', exerciseId: 'treadmill-run', durationSec, distanceM: 8000, rpe },
  ];
  const legs = (db, raw, sets) => {
    logAt(db, raw, hoursAgo(0), '2026-07-26', 'Run', 'cardio', sets);
    const ledger = muscleFreshness(recentMuscleLoads(db, 14, NOW), NOW);
    return (m) => ledger.find((e) => e.muscle === m).freshness;
  };

  // THE ANCHOR. 45 minutes, no RPE: 4.5 effort units on the primary (quads),
  // 2.25 on the secondaries at role weight 0.5.
  {
    const { db, raw } = freshDb();
    const f = legs(db, raw, run(45 * 60));
    f('quads') === 57
      ? ok('a 45-minute run reads quads 57 — recovering, about a third of a leg day')
      : bad('45-min run quads', f('quads'));
    f('calves') === 75 && f('hamstrings') === 75 && f('glutes') === 75
      ? ok('…and its secondaries 75 — a real dent, not a session')
      : bad('45-min run secondaries', JSON.stringify([f('calves'), f('hamstrings'), f('glutes')]));
    f('chest') === 100 && f('biceps') === 100
      ? ok('…and nothing it does not work')
      : bad('run leaked to the upper body');
  }

  // The same run logged as one set with NO duration is the pre-0046 reading:
  // one working set. It has to stay that, because a distance-only import still
  // happened and reading it as free would be the worse error.
  {
    const { db, raw } = freshDb();
    const f = legs(db, raw, [
      { exercise: 'Treadmill Run', exerciseId: 'treadmill-run', distanceM: 8000 },
    ]);
    f('quads') === 88
      ? ok('a run with no duration falls back to one working set (quads 88), not to zero')
      : bad('duration-less run', f('quads'));
  }

  // RPE still scales it, through the same knob every other set uses: an easy
  // jog costs half a hard tempo of the same length.
  {
    const { db, raw } = freshDb();
    const easy = legs(db, raw, run(45 * 60, 5))('quads');
    const { db: db2, raw: raw2 } = freshDb();
    const hard = legs(db2, raw2, run(45 * 60, 9))('quads');
    easy > hard && easy === 75 && hard === 57
      ? ok(`an easy 45 min (RPE 5) reads ${easy}, a hard one ${hard}`)
      : bad('rpe scaling', JSON.stringify({ easy, hard }));
  }

  // The cap. A three-hour run hits ENDURANCE_EFFORT_CAP; ten hours (the
  // duration_sec ceiling) may not read 0, which the model promises never to
  // print, and may not out-assert a hand-set "Spent" (~44 units).
  {
    const { db, raw } = freshDb();
    const f = legs(db, raw, run(10 * 3600 - 1));
    f('quads') === 11 && f('quads') > 0
      ? ok('the longest loggable set is capped at 11, above the model’s floor')
      : bad('cap', f('quads'));
  }

  // A PLANK is not endurance work: time without distance is a hold, and a hold
  // is one set of abs however long it lasts. This is the branch that keeps a
  // 60-second plank from reading as a tenth of a set.
  {
    const { db, raw } = freshDb();
    logAt(db, raw, hoursAgo(0), '2026-07-26', 'Core', 'strength', [
      { exercise: 'Plank', exerciseId: 'plank', durationSec: 60 },
    ]);
    const abs = muscleFreshness(recentMuscleLoads(db, 14, NOW), NOW).find(
      (e) => e.muscle === 'abs'
    );
    abs.freshness === 88
      ? ok('a 60-second plank is one set of abs (88), not 0.1 of one')
      : bad('plank effort', JSON.stringify(abs));
  }

  // Weekly VOLUME does not follow: MEV/MAV/MRV are resistance-training
  // landmarks, so scaling a run to 4.5 "sets" would measure it against a scale
  // it was never on. One row, one set.
  {
    const { db, raw } = freshDb();
    logAt(db, raw, hoursAgo(0), '2026-07-26', 'Run', 'cardio', run(45 * 60));
    const quads = weeklyMuscleSets(db, NOW).find((v) => v.muscle === 'quads');
    quads.sets === 1
      ? ok('…while weekly volume counts that same run as ONE set (the deliberate asymmetry)')
      : bad('volume scaled by duration', JSON.stringify(quads));
  }
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

// ---------------------------------------------------------------------------
// C13 / migration 0055. The governing sentence is "an away session is real
// training and unreal measurement", and every assertion below is one half of
// it: the measurement half excludes, the training half is untouched.
console.log('9. the away-gym flag: real training, unreal measurement (0055)');
{
  const { db, raw } = freshDb();
  const bench = (reps, weightKg, rpe) => ({
    exercise: 'Bench',
    exerciseId: 'barbell-bench-press',
    reps,
    weightKg,
    rpe,
  });

  // The flag is OFF on a session nobody said anything about — every existing
  // caller (the Coach, the photo import, the manual logger) means "home",
  // because none of them can know otherwise.
  const homeId = logAt(db, raw, hoursAgo(72), '2026-07-23', 'Upper A', 'strength', [
    bench(5, 100, 8),
  ]);
  getWorkoutDetail(db, homeId).away === false
    ? ok('a session logged with no opinion about it is not away — off is the default')
    : bad('default away', JSON.stringify(getWorkoutDetail(db, homeId).away));

  // ...and an away session, whose numbers are the BEST ON RECORD. This is the
  // corner case the owner will hit first: the away gym's machine is easier and
  // he genuinely moves more weight.
  const awayId = logAt(
    db,
    raw,
    hoursAgo(10),
    '2026-07-26',
    'Upper A',
    'strength',
    [bench(5, 140, 8)],
    true
  );
  getWorkoutDetail(db, awayId).away === true
    ? ok('…and one logged away comes back away')
    : bad('away not persisted');

  // --- (a) no record, even at the top of the board --------------------------
  const prs = personalRecords(db, 'barbell-bench-press');
  near(prs.maxWeightKg, 100) && near(prs.bestSetVolumeKg, 500)
    ? ok('the 140 kg away set sets NO record — the 100 kg home set still owns them')
    : bad('away set a PR', JSON.stringify(prs));
  near(prs.bestE1rmKg, 100 * (1 + 7 / 30))
    ? ok('…including the e1RM, the bar every future session has to clear')
    : bad('away e1RM leaked', prs.bestE1rmKg);

  // --- (b) the chart keeps it, marked --------------------------------------
  const series = e1rmSeries(db, 'barbell-bench-press');
  series.length === 2 && series[0].date === '2026-07-23' && series[1].date === '2026-07-26'
    ? ok('the away session is still PLOTTED — hiding it would be a different lie')
    : bad('away point dropped', JSON.stringify(series));
  series[1].away === true && series[0].away === undefined
    ? ok('…and marked, while the home point carries no mark at all')
    : bad('chart mark', JSON.stringify(series));

  // --- (c) the prefill prefers the last HOME session ------------------------
  const prev = lastSessionSets(db, 'barbell-bench-press');
  prev.length === 1 && near(prev[0].weightKg, 100)
    ? ok('the next session is pre-filled from the last HOME session, not the newer away one')
    : bad('prefill took away numbers', JSON.stringify(prev));

  // --- (d) the stall branch cannot be tripped by a trip ---------------------
  // Three weeks away on stiffer machines is exactly the deload branch's input:
  // STALL_SESSIONS sessions with no strength gain and reps below the top of the
  // range. Without the exclusion ARC recommends dropping 10% off a lift that
  // never stalled — the false regression this whole feature exists to prevent.
  const { db: gym, raw: gymRaw } = freshDb();
  const range = { low: 5, high: 8 };
  [
    ['2026-07-01', 100],
    ['2026-07-05', 102.5],
    ['2026-07-09', 105],
  ].forEach(([date, kg], i) => {
    logAt(gym, gymRaw, hoursAgo(600 - i * 50), date, 'Upper A', 'strength', [bench(6, kg, 8)]);
  });
  ['2026-07-14', '2026-07-18', '2026-07-22'].forEach((date, i) => {
    logAt(
      gym,
      gymRaw,
      hoursAgo(300 - i * 50),
      date,
      'Upper A',
      'strength',
      [bench(6, 80, 9)],
      true
    );
  });
  const tops = exerciseSessionTops(gym, 'barbell-bench-press');
  tops.length === 6 && tops.filter((t) => t.away).length === 3
    ? ok('all six sessions reach the history list, three of them marked away')
    : bad('session tops', JSON.stringify(tops.map((t) => [t.date, t.away])));
  const suggestion = suggestProgression({ sessions: tops, repRange: range, incrementKg: 2.5 });
  suggestion.kind !== 'deload' && near(suggestion.targetWeightKg, 105)
    ? ok(`three away sessions do NOT trigger a deload — still ${suggestion.kind} at 105 kg`)
    : bad('false deload', JSON.stringify(suggestion));
  // ...and the branch still fires when the stall is real, so the exclusion has
  // not simply disabled it.
  suggestProgression({
    sessions: tops.map((t) => ({ ...t, away: false })),
    repRange: range,
    incrementKg: 2.5,
  }).kind === 'deload'
    ? ok('…while the very same six sessions, all at home, DO deload — the branch still works')
    : bad('deload branch broken');

  // --- (e) the training half: nothing that counts work changes --------------
  // The no-change test. Freshness multiplies role weight × effort × decay and
  // never reads the weight; volume and the week count sets and minutes. So the
  // SAME sets must produce byte-identical readings with the flag on and off,
  // and this is the assertion that stops a later pass "completing" the feature
  // by adding an away branch to any of them.
  const readWork = () => ({
    freshness: muscleFreshness(recentMuscleLoads(db, 14, NOW), NOW),
    volume: weeklyMuscleSets(db, NOW),
    week: weekSummary(db, NOW),
  });
  const withAway = JSON.stringify(readWork());
  raw.prepare('UPDATE workouts SET away = 0 WHERE id = ?').run(awayId);
  const withoutAway = JSON.stringify(readWork());
  withAway === withoutAway
    ? ok('freshness, weekly volume and the week summary are IDENTICAL with the flag on and off')
    : bad('a work reading moved with the flag');

  // --- (f) nothing to re-derive --------------------------------------------
  // The architectural gift: PRs are awarded live and never stored, and every
  // other affected read is computed from the sets on demand. So flipping the
  // flag on a two-week-old session changes what the next read returns, with no
  // cache to invalidate — asserted rather than assumed.
  near(personalRecords(db, 'barbell-bench-press').maxWeightKg, 140)
    ? ok('clearing the flag hands the 140 kg set its record back on the very next read')
    : bad('flag flip did not re-derive', personalRecords(db, 'barbell-bench-press').maxWeightKg);
  replaceWorkout(db, awayId, { kind: 'strength', away: true }, [bench(5, 140, 8)]);
  near(personalRecords(db, 'barbell-bench-press').maxWeightKg, 100)
    ? ok('…and setting it again through the past-session editor takes it away again')
    : bad('editor flip', personalRecords(db, 'barbell-bench-press').maxWeightKg);
  replaceWorkout(db, awayId, { kind: 'strength' }, [bench(5, 140, 8)]);
  getWorkoutDetail(db, awayId).away === true
    ? ok('an edit that does not mention the flag PRESERVES it — silence is not "home"')
    : bad('omitted away cleared the flag');

  // --- (g) the session list says so ----------------------------------------
  const recent = listRecentSessions(db);
  recent[0].away === true && sessionDetail(recent[0]).endsWith('Away gym')
    ? ok(`the list says where it happened: "${sessionDetail(recent[0])}"`)
    : bad('session list mark', JSON.stringify(recent.map((s) => [s.date, s.away])));

  // --- (h) the fallback: an away session beats no placeholder at all --------
  const { db: hotel, raw: hotelRaw } = freshDb();
  logAt(
    hotel,
    hotelRaw,
    hoursAgo(20),
    '2026-07-25',
    'Upper A',
    'strength',
    [bench(8, 60, 8)],
    true
  );
  const only = lastSessionSets(hotel, 'barbell-bench-press');
  only.length === 1 && near(only[0].weightKg, 60)
    ? ok('with no home session at all, the away one still pre-fills — better than nothing')
    : bad('fallback prefill', JSON.stringify(only));
  personalRecords(hotel, 'barbell-bench-press').maxWeightKg === null
    ? ok('…while still setting no record, because it is still not a measurement')
    : bad('fallback PR leaked');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
