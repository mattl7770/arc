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
  exerciseLoadBases,
  getExercise,
  listExercises,
  musclesByExercise,
  resolveExerciseByName,
  setExerciseLoadBasis,
} from '../src/lib/db/repositories/exercise-catalog.ts';
import { logWorkout } from '../src/lib/db/repositories/exercise.ts';
import {
  asLoadBasis,
  deriveLoadBasis,
  LOAD_BASES,
  LOAD_BASIS_LABEL,
  loadMovedFactor,
  loadMovedKg,
  loadRecordsApply,
  weightColumnHeading,
  withLoadBasis,
} from '../src/lib/exercise/load-basis.ts';
import { rankExerciseMatches } from '../src/lib/exercise/match.ts';

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

console.log('0. migration 0011 seeds the catalog');
{
  const { raw } = freshDb();
  // Floor, not exact: later windows' migrations (0020 programs, …) raise it.
  raw.prepare('PRAGMA user_version').get().user_version >= 13
    ? ok('user_version >= 13 (later migrations tolerated; reserved-number gaps too)')
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

// ---------------------------------------------------------------------------
// The 2026-08-14 freshness fix. A set whose exercise_id is NULL is invisible to
// muscle freshness, e1RM, PRs and volume alike, and three of the four write
// paths could produce one — so every path now backstops through this resolver
// (src/lib/db/repositories/exercise.ts, insertSet).
console.log('7. resolveExerciseByName: plurals resolve, ambiguity never guesses');
{
  const { db } = freshDb();
  const r = (n) => resolveExerciseByName(db, n);

  r('Lat Pulldown') === 'lat-pulldown' && r('barbell row') === 'barbell-row'
    ? ok('exact catalog name resolves, case-insensitively')
    : bad('exact', `${r('Lat Pulldown')} / ${r('barbell row')}`);
  // The plural is how anyone actually writes a log, and the whole reason the
  // Coach's strict matcher resolved almost nothing.
  r('lat pulldowns') === 'lat-pulldown' &&
  r('Barbell Rows') === 'barbell-row' &&
  r('face pulls') === 'face-pull' &&
  r('seated cable rows') === 'seated-cable-row'
    ? ok('plurals resolve — "lat pulldowns", "Barbell Rows", "face pulls", "seated cable rows"')
    : bad('plurals', [r('lat pulldowns'), r('Barbell Rows'), r('face pulls')].join());
  r('Bench Press') === 'barbell-bench-press' && r('bench presses') === 'barbell-bench-press'
    ? ok('aliases resolve, and "press" does not stem into nonsense')
    : bad('alias', `${r('Bench Press')} / ${r('bench presses')}`);
  r('RDL') === 'romanian-deadlift' && r('Pullups') === 'pull-up'
    ? ok('abbreviations and squashed spellings resolve through aliases')
    : bad('abbrev', `${r('RDL')} / ${r('Pullups')}`);

  // Confidence discipline: ambiguous stays null rather than guessing. Pinned
  // the same way db/coach-tools.test.mjs §27 pins it for the Coach.
  r('Press') === null && r('Bench') === null && r('curls') === null && r('row') === null
    ? ok('a single ambiguous token never resolves — no guessing')
    : bad('ambiguity', [r('Press'), r('Bench'), r('curls'), r('row')].join());
  r('') === null && r('   ') === null && r('Zercher Yoke Carry') === null
    ? ok('empty and genuinely unknown names stay free text')
    : bad('unknown', r('Zercher Yoke Carry'));

  // A custom movement joins the same namespace the moment it is created.
  const id = createCustomExercise(db, {
    name: 'Meadows Row',
    equipment: 'barbell',
    loggingType: 'weight_reps',
    unilateral: true,
    primaryMuscles: ['upper_back'],
  });
  r('meadows rows') === id
    ? ok('a custom exercise resolves by name too, plural included')
    : bad('custom', r('meadows rows'));
  archiveExercise(db, id);
  r('meadows rows') === null
    ? ok('an archived exercise stops claiming names')
    : bad('archived resolves');
}

// ---------------------------------------------------------------------------
// Owner, 2026-09-14: "more intelligent search for exercises, i.e. common
// misspellings, alternative names." Two halves, and the difference between them
// is the whole safety story: the RESOLVER must answer with one id or none,
// because its answer becomes a row's exercise_id; the PICKER can show a ranked
// list and let a human choose.
console.log('8. tolerant matching: misspellings resolve, ambiguity still refuses');
{
  const { db } = freshDb();
  const r = (n) => resolveExerciseByName(db, n);

  r('bnech press') === 'barbell-bench-press' &&
  r('bench pres') === 'barbell-bench-press' &&
  r('dumbell curl') === 'dumbbell-curl' &&
  r('incline dumbell press') === 'incline-dumbbell-press'
    ? ok('a mistyped name resolves — "bnech press", "bench pres", "dumbell curl"')
    : bad('typos', [r('bnech press'), r('bench pres'), r('dumbell curl')].join());
  r('sqaut') === 'barbell-back-squat'
    ? ok('a transposition counts as ONE edit, so "sqaut" is the squat')
    : bad('transposition', r('sqaut'));
  r('skullcrusher') === 'skull-crusher' &&
  r('skull crushers') === 'skull-crusher' &&
  r('lying tricep extension') === 'skull-crusher'
    ? ok('words run together and the alternative name both land on Skull Crusher')
    : bad('squash/alias', [r('skullcrusher'), r('lying tricep extension')].join());
  r('pull-downs') === 'lat-pulldown' && r('chinup') === 'chin-up'
    ? ok('punctuation and joined spellings fold the same way — "pull-downs", "chinup"')
    : bad('punctuation', `${r('pull-downs')} / ${r('chinup')}`);

  // THE PINS. Tolerance must not become guessing: these are the same refusals
  // §7 makes, re-checked with the fuzzy tier in place, and the ones
  // db/coach-tools.test.mjs §27 pins for the Coach's log_workout.
  r('Press') === null &&
  r('Bench') === null &&
  r('press') === null &&
  r('extension') === null &&
  r('machine') === null
    ? ok('a bare "Press" / "Bench" / "extension" still resolves to NOTHING')
    : bad('ambiguous resolved', [r('Press'), r('Bench'), r('extension')].join());
  r('raise') === null && r('pull') === null && r('fly') === null
    ? ok('…and so do the other one-word families — short words get no tolerance')
    : bad('short words', [r('raise'), r('pull'), r('fly')].join());
  r('Zercher Yoke Carry') === null && r('kettlebell juggling') === null
    ? ok('a movement that genuinely is not in the catalog stays free text')
    : bad('invented resolved', r('Zercher Yoke Carry'));
  r('deadlift sumo') === null
    ? ok('the longer-input direction is still refused — "deadlift sumo" is not Deadlift')
    : bad('reverse prefix', r('deadlift sumo'));

  // A tie resolves to nothing, even when both candidates are one edit away.
  createCustomExercise(db, {
    name: 'Cable Crunch B',
    equipment: 'cable',
    loggingType: 'weight_reps',
    primaryMuscles: ['abs'],
  });
  createCustomExercise(db, {
    name: 'Cable Crunch C',
    equipment: 'cable',
    loggingType: 'weight_reps',
    primaryMuscles: ['abs'],
  });
  r('cable crunch d') === null
    ? ok('two movements equally close is not evidence — a tie resolves to null')
    : bad('tie resolved', r('cable crunch d'));
}

console.log('9. ranked search: what the picker lists, and in what order');
{
  const { db } = freshDb();
  const catalog = listExercises(db).map((e) => ({
    id: e.id,
    name: e.name,
    aliases: e.aliases,
  }));
  const names = new Map(catalog.map((e) => [e.id, e.name]));
  const search = (q) => rankExerciseMatches(catalog, q).map((m) => names.get(m.id));

  search('lat pulldown')[0] === 'Lat Pulldown'
    ? ok('an exact name ranks first')
    : bad('exact first', search('lat pulldown')[0]);
  search('pulldown')[0] === 'Lat Pulldown'
    ? ok('an exact ALIAS outranks the movements that merely contain the word')
    : bad('alias first', search('pulldown').slice(0, 3).join());
  {
    const results = search('press');
    results.includes('Leg Press') &&
    results.includes('Overhead Press') &&
    results.includes('Barbell Bench Press') &&
    results.length >= 8
      ? ok('an ambiguous word LISTS every press — the picker is allowed to')
      : bad('press list', results.slice(0, 5).join());
  }
  {
    const results = search('curl');
    results.every((n) => n.toLowerCase().includes('curl'))
      ? ok('…and lists only curls for "curl" — no fuzzy noise while a real match exists')
      : bad('curl noise', results.join());
  }
  {
    // The half-typed misspelling: the reason the token tier exists at all.
    const results = search('bnech');
    results[0] === 'Barbell Bench Press' && results.includes('Dumbbell Bench Press')
      ? ok('"bnech" finds the bench presses, own-name matches ranked above alias ones')
      : bad('bnech', results.slice(0, 3).join());
  }
  search('skullcrusher')[0] === 'Skull Crusher'
    ? ok('"skullcrusher" finds Skull Crusher — identical letters, so an exact match')
    : bad('skullcrusher', search('skullcrusher')[0]);
  search('zzzz').length === 0 && search('').length === 0
    ? ok('gibberish and an empty query match nothing, rather than everything')
    : bad('empty/gibberish', search('zzzz').length);
  {
    // Determinism: a list that reshuffles between keystrokes is unusable.
    const a = search('row').join();
    const b = search('row').join();
    a === b && a.length > 0 ? ok('the order is stable across identical queries') : bad('unstable');
  }
}

console.log('10. load basis: derived from the catalog row, corrected by the owner (0062)');
{
  const { db, raw } = freshDb();

  // EVERY seeded movement, by id, with the basis its weight figure has. This is
  // the specification of `deriveLoadBasis` over real rows — a seeded movement
  // added later without an entry here fails the completeness check below.
  const EXPECT = {
    'barbell-bench-press': 'total',
    'incline-barbell-bench-press': 'total',
    'dumbbell-bench-press': 'per_hand',
    'incline-dumbbell-press': 'per_hand',
    'machine-chest-press': 'stack',
    'cable-fly': 'per_side', // two stacks, one handle each ("Cable Crossover")
    'dumbbell-fly': 'per_hand',
    'push-up': null, // measures reps only — no figure to describe
    'chest-dip': 'bodyweight_plus',
    'pull-up': 'bodyweight_plus',
    'chin-up': 'bodyweight_plus',
    'lat-pulldown': 'stack',
    'barbell-row': 'total',
    'dumbbell-row': 'per_hand', // "One-Arm Row"
    'seated-cable-row': 'stack',
    'machine-row': 'stack',
    'face-pull': 'stack',
    'straight-arm-pulldown': 'stack', // "straight-arm" is not "single-arm"
    'back-extension': 'bodyweight_plus',
    'barbell-shrug': 'total',
    'dumbbell-shrug': 'per_hand',
    'overhead-press': 'total',
    'dumbbell-shoulder-press': 'per_hand',
    'machine-shoulder-press': 'stack',
    'lateral-raise': 'per_hand',
    'cable-lateral-raise': 'per_hand', // unilateral upper-body cable = one arm, one handle
    'reverse-fly': 'per_hand', // a DUMBBELL fly: the two-stack rule is cable-only
    'front-raise': 'per_hand',
    'barbell-curl': 'total',
    'dumbbell-curl': 'per_hand',
    'hammer-curl': 'per_hand',
    'preacher-curl': 'total',
    'cable-curl': 'stack',
    'incline-dumbbell-curl': 'per_hand',
    'close-grip-bench-press': 'total',
    'triceps-pushdown': 'stack',
    'overhead-triceps-extension': 'total', // one dumbbell, both hands ("French Press")
    'skull-crusher': 'total',
    'triceps-dip': 'bodyweight_plus',
    'wrist-curl': 'per_hand',
    'farmers-carry': 'per_hand',
    'barbell-back-squat': 'total',
    'front-squat': 'total',
    'leg-press': 'stack', // machine → stack; a plate-loaded sled is the owner's correction
    'goblet-squat': 'total',
    'leg-extension': 'stack',
    'bulgarian-split-squat': 'per_hand',
    'walking-lunge': 'per_hand',
    'hack-squat': 'stack',
    'romanian-deadlift': 'total',
    'lying-leg-curl': 'stack',
    'seated-leg-curl': 'stack',
    'stiff-leg-deadlift': 'total',
    'conventional-deadlift': 'total',
    'hip-thrust': 'total',
    'trap-bar-deadlift': 'total',
    'cable-pull-through': 'stack',
    'kettlebell-swing': 'total', // one bell, two hands
    'standing-calf-raise': 'stack',
    'seated-calf-raise': 'stack',
    plank: null,
    'hanging-leg-raise': null,
    'cable-crunch': 'stack',
    'ab-wheel-rollout': null,
    'russian-twist': 'total',
    'treadmill-run': null,
    'rowing-erg': null,
    'stationary-bike': null,
    'incline-walk': null,
  };
  const seeded = raw
    .prepare('SELECT id FROM exercises WHERE is_custom = 0 ORDER BY id')
    .all()
    .map((r) => r.id);
  const unlisted = seeded.filter((id) => !(id in EXPECT));
  unlisted.length === 0 && seeded.length === Object.keys(EXPECT).length
    ? ok(`every one of the ${seeded.length} seeded movements has an expected basis`)
    : bad('seed/expectation mismatch', unlisted.join(', ') || `${seeded.length} seeded`);
  const wrong = seeded.filter((id) => getExercise(db, id).loadBasis !== EXPECT[id]);
  wrong.length === 0
    ? ok(`deriveLoadBasis reads all ${seeded.length} seeded rows as expected (five bases and none)`)
    : bad(
        'derivation disagrees',
        wrong.map((id) => `${id}: ${getExercise(db, id).loadBasis} ≠ ${EXPECT[id]}`).join('; ')
      );
  // Nothing is STORED for any of them: NULL is "ARC's reading", and 0062
  // writes no backfill.
  raw.prepare('SELECT count(*) AS n FROM exercises WHERE load_basis IS NOT NULL').get().n === 0
    ? ok('0062 stores nothing: every seeded row reads its basis, none holds a copy')
    : bad('a derived basis was stored');
  getExercise(db, 'barbell-bench-press').loadBasisSetByOwner === false &&
  getExercise(db, 'barbell-bench-press').loadBasisDerived === 'total'
    ? ok('…and says so: not set by the owner, derived = total')
    : bad('provenance flags', JSON.stringify(getExercise(db, 'barbell-bench-press')));

  // The name rules, on rows the seed does not carry — the brief's own examples.
  const base = {
    aliases: [],
    loggingType: 'weight_reps',
    measures: 'reps,load',
    unilateral: false,
    movementPattern: null,
  };
  const derive = (over) => deriveLoadBasis({ ...base, ...over });
  const cases = [
    [{ name: 'Alternating Dumbbell Curl', equipment: 'dumbbell' }, 'per_hand'],
    [{ name: 'Single-Arm Cable Row', equipment: 'cable', movementPattern: 'pull_h' }, 'per_hand'],
    [{ name: 'Single-Arm Cable Fly', equipment: 'cable' }, 'per_hand'], // one handle beats two stacks
    [{ name: 'Cable Crossover', equipment: 'cable' }, 'per_side'],
    [{ name: 'Kettlebell Goblet Squat', equipment: 'kettlebell' }, 'total'],
    [{ name: 'Dumbbell Pullover', equipment: 'dumbbell' }, 'total'],
    [{ name: 'Single-Arm Kettlebell Swing', equipment: 'kettlebell' }, 'per_hand'],
    [{ name: 'Iso-Lateral Row', equipment: 'machine' }, 'per_side'],
    [{ name: 'Plate-Loaded Leg Press', equipment: 'machine' }, 'per_side'],
    [{ name: 'Leg Press', equipment: 'machine' }, 'stack'],
    [{ name: 'Smith Squat', equipment: 'smith' }, 'total'],
    [
      { name: 'Assisted Pull-Up', equipment: 'machine', loggingType: 'assisted_bodyweight' },
      'assisted',
    ],
    [{ name: 'Weighted Plank', equipment: 'bodyweight', measures: 'load,time' }, 'bodyweight_plus'],
    [
      { name: 'Glute Kickback', equipment: 'cable', unilateral: true, movementPattern: 'hinge' },
      'stack',
    ],
    [{ name: 'Plank', equipment: 'bodyweight', measures: 'time', loggingType: 'duration' }, null],
  ];
  const misses = cases.filter(([ex, want]) => derive(ex) !== want);
  misses.length === 0
    ? ok(`the name rules hold on ${cases.length} rows the seed does not carry`)
    : bad(
        'name rules',
        misses.map(([ex, want]) => `${ex.name}: ${derive(ex)} ≠ ${want}`).join('; ')
      );

  // THE CORRECTION. A plate-loaded leg press — what the owner's gym has.
  setExerciseLoadBasis(db, 'leg-press', 'per_side');
  const corrected = getExercise(db, 'leg-press');
  corrected.loadBasis === 'per_side' &&
  corrected.loadBasisSetByOwner === true &&
  corrected.loadBasisDerived === 'stack' &&
  raw.prepare(`SELECT load_basis FROM exercises WHERE id = 'leg-press'`).get().load_basis ===
    'per_side'
    ? ok('a correction is stored, wins, and is marked as the owner’s — ARC’s reading still known')
    : bad('correction', JSON.stringify(corrected));
  // Choosing ARC's own reading is "go back", stored as NULL — so a non-NULL can
  // only ever mean "the owner disagreed".
  setExerciseLoadBasis(db, 'leg-press', 'stack');
  raw.prepare(`SELECT load_basis FROM exercises WHERE id = 'leg-press'`).get().load_basis ===
    null && getExercise(db, 'leg-press').loadBasisSetByOwner === false
    ? ok('choosing the derived basis writes NULL, not a copy of the derivation')
    : bad('derived choice stored');
  setExerciseLoadBasis(db, 'leg-press', 'total');
  setExerciseLoadBasis(db, 'leg-press', null);
  getExercise(db, 'leg-press').loadBasis === 'stack'
    ? ok('null resets to ARC’s reading')
    : bad('reset', getExercise(db, 'leg-press').loadBasis);

  // It RELABELS; it never rescales. The logged figure is untouched.
  logWorkout(db, { date: '2026-09-20', kind: 'strength' }, [
    { exercise: 'Leg Press', exerciseId: 'leg-press', reps: 10, weightKg: 100 },
  ]);
  setExerciseLoadBasis(db, 'leg-press', 'per_side');
  raw.prepare(`SELECT weight_kg FROM workout_sets WHERE exercise_id = 'leg-press'`).get()
    .weight_kg === 100
    ? ok('a correction touches no logged set: 100 kg stays 100 kg, now read per side')
    : bad('rescaled');

  // The column's own guard, and the repository's in front of it.
  throws(() => raw.exec(`UPDATE exercises SET load_basis = 'per_arm' WHERE id = 'plank'`))
    ? ok('CHECK rejects a basis outside the six')
    : bad('junk basis stored');
  throws(() => setExerciseLoadBasis(db, 'plank', 'per_arm'))
    ? ok('…and the repository refuses it before SQL does')
    : bad('repo accepted junk');
  throws(() => setExerciseLoadBasis(db, 'no-such-movement', 'total'))
    ? ok('…and refuses a movement that does not exist')
    : bad('ghost correction');
  // A stored basis on a movement that records no load describes nothing.
  setExerciseLoadBasis(db, 'plank', 'total');
  getExercise(db, 'plank').loadBasis === null &&
  getExercise(db, 'plank').loadBasisSetByOwner === false
    ? ok('a plank has no weight figure, whatever is stored: basis null, not "set by you"')
    : bad('plank basis', JSON.stringify(getExercise(db, 'plank')));

  // The batch read agrees with the row read, one statement for many ids.
  const ids = ['leg-press', 'dumbbell-row', 'plank', 'pull-up', 'nope'];
  const batch = exerciseLoadBases(db, ids);
  batch.get('leg-press') === 'per_side' &&
  batch.get('dumbbell-row') === 'per_hand' &&
  batch.get('plank') === null &&
  batch.get('pull-up') === 'bodyweight_plus' &&
  !batch.has('nope')
    ? ok('exerciseLoadBases resolves many ids exactly as getExercise does')
    : bad('batch', JSON.stringify([...batch]));

  // A custom movement is derived like a seeded one.
  const custom = createCustomExercise(db, {
    name: 'Single-Arm Landmine Row',
    equipment: 'dumbbell',
    loggingType: 'weight_reps',
    primaryMuscles: ['lats'],
  });
  getExercise(db, custom).loadBasis === 'per_hand'
    ? ok('a custom movement gets the same reading (per hand)')
    : bad('custom basis', getExercise(db, custom).loadBasis);
}

console.log('11. load basis: the heading, the inline form, and the doubling rule');
{
  const heading = weightColumnHeading('kg', 'per_hand');
  heading.length === 2 && heading[0] === 'kg' && heading[1] === 'Per hand'
    ? ok('the logger heading is two lines: unit over basis ("kg" / "Per hand")')
    : bad('heading', JSON.stringify(heading));
  weightColumnHeading('lb', null).join('|') === 'lb'
    ? ok('…and just the unit on a free-text block, where no basis is known')
    : bad('null heading');
  LOAD_BASES.every(
    (b) => typeof LOAD_BASIS_LABEL[b] === 'string' && LOAD_BASIS_LABEL[b].length <= 8
  )
    ? ok('every basis label fits the ~63pt load column (8 characters or fewer)')
    : bad('label too long', LOAD_BASES.map((b) => LOAD_BASIS_LABEL[b]).join());
  withLoadBasis('30 kg', 'per_hand') === '30 kg per hand' &&
  withLoadBasis('100 kg', 'total') === '100 kg total' &&
  withLoadBasis('30 kg', null) === '30 kg'
    ? ok('withLoadBasis: "30 kg per hand", "100 kg total", unchanged with no basis')
    : bad('inline');
  asLoadBasis('per_hand') === 'per_hand' &&
  asLoadBasis('per_arm') === null &&
  asLoadBasis(3) === null
    ? ok('asLoadBasis is total: anything outside the six reads as no correction')
    : bad('asLoadBasis');

  // THE DOUBLING DECISION, pinned. Only a sum ACROSS movements may convert a
  // figure, and only through this factor: both hands (or both sides) carried
  // the load; a stack, a whole bar and added load count as logged; assistance
  // is not a load that was moved.
  loadMovedFactor('per_hand') === 2 &&
  loadMovedFactor('per_side') === 2 &&
  loadMovedFactor('total') === 1 &&
  loadMovedFactor('stack') === 1 &&
  loadMovedFactor('bodyweight_plus') === 1 &&
  loadMovedFactor('assisted') === null &&
  loadMovedFactor(null) === null
    ? ok('loadMovedFactor: per hand / per side ×2, total / stack / added ×1, assisted refuses')
    : bad('factor table');
  loadMovedKg(30, 8, 'per_hand') === 480 &&
  loadMovedKg(100, 5, 'total') === 500 &&
  loadMovedKg(40, 8, 'assisted') === null &&
  loadMovedKg(null, 8, 'total') === null
    ? ok(
        'loadMovedKg: 30 kg × 8 per hand moved 480 kg; an assisted set moved nothing ARC can count'
      )
    : bad('loadMovedKg');
  loadRecordsApply('assisted') === false && loadRecordsApply('per_hand') && loadRecordsApply(null)
    ? ok('load records apply to every basis but assisted (a higher figure is an easier set)')
    : bad('loadRecordsApply');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
