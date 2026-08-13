/**
 * Headless test of the 2026-08-11 exercise features: the body-figure region map
 * (figure.ts completeness), the photo-import parser/grounder (import-workout.ts),
 * backdated-fatigue attribution (training-stats.attributedInstant + the
 * freshness window), the AI exercise-search parser (ai-search.ts), and custom
 * exercises carrying instructions. Real SQLite via node:sqlite; op-sqlite /
 * Expo / the network never loaded — the model calls themselves are NOT tested
 * here, only the pure request/parse/ground layers around them (the
 * db/nutrition-style split). Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { logWorkout } from '../src/lib/db/repositories/exercise.ts';
import { createCustomExercise, getExercise } from '../src/lib/db/repositories/exercise-catalog.ts';
import { attributedInstant, recentMuscleLoads } from '../src/lib/db/repositories/training-stats.ts';
import {
  BODY_OUTLINE,
  FIGURE_BODY,
  FIGURE_GRID,
  FIGURE_REGIONS,
  coveredByBody,
  mappedMuscles,
  regionsFor,
} from '../src/lib/exercise/figure.ts';
import {
  freshnessSummary,
  freshnessTally,
  muscleNames,
} from '../src/components/exercise/freshness-display.ts';
import { MUSCLE_ORDER } from '../src/lib/exercise/constants.ts';
import { muscleFreshness } from '../src/lib/exercise/freshness.ts';
import {
  buildWorkoutParseRequest,
  groundWorkoutImport,
  parseWorkoutImport,
} from '../src/lib/exercise/import-workout.ts';
import {
  buildExerciseSearchRequest,
  parseExerciseSearch,
  resolveSearchMatches,
} from '../src/lib/exercise/ai-search.ts';

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

// ---------------------------------------------------------------------------
console.log('1. figure map: complete over the 16 muscles, sane geometry');
{
  const mapped = mappedMuscles();
  MUSCLE_ORDER.every((m) => mapped.has(m))
    ? ok('every muscle group appears on the figure (front and/or back)')
    : bad('unmapped muscles', MUSCLE_ORDER.filter((m) => !mapped.has(m)).join(','));
  regionsFor('front').length > 0 && regionsFor('back').length > 0
    ? ok('both sides carry regions')
    : bad('sides');
  const inGrid = (r) =>
    r.x >= 0 && r.y >= 0 && r.x + r.w <= FIGURE_GRID.w && r.y + r.h <= FIGURE_GRID.h;
  FIGURE_REGIONS.every(inGrid)
    ? ok(`every region sits inside the ${FIGURE_GRID.w}×${FIGURE_GRID.h} grid`)
    : bad('region bounds');
  // The back view must include the muscles invisible from the front.
  const back = new Set(regionsFor('back').map((r) => r.muscle));
  ['lats', 'upper_back', 'lower_back', 'glutes', 'hamstrings', 'traps', 'rear_delts'].every((m) =>
    back.has(m)
  )
    ? ok('posterior chain lives on the back view')
    : bad('back coverage');

  // --- the 2026-08-12 rework's invariants ---------------------------------
  // A muscle cell means "quads" only because of where it sits ON A PERSON, so
  // the silhouette is load-bearing now and every region has to ride on it.
  const offBody = FIGURE_REGIONS.filter((r) => !coveredByBody(r));
  offBody.length === 0
    ? ok('every region is fully covered by the body silhouette')
    : bad('regions off the body', offBody.map((r) => `${r.muscle}@${r.x},${r.y}`).join(' '));

  // The contour is drawn by inflating each block by BODY_OUTLINE, so the
  // INFLATED body — not just its fill — has to stay on the grid, or the
  // silhouette's outline clips against the edge of the figure box.
  FIGURE_BODY.every(
    (b) =>
      b.x - BODY_OUTLINE >= 0 &&
      b.y - BODY_OUTLINE >= 0 &&
      b.x + b.w + BODY_OUTLINE <= FIGURE_GRID.w &&
      b.y + b.h + BODY_OUTLINE <= FIGURE_GRID.h
  )
    ? ok('the inflated silhouette stays inside the grid (the contour never clips)')
    : bad('body outline clips the grid');

  // Two overlapping cells on one side would paint one state over another and
  // silently lose a muscle's reading.
  const overlaps = [];
  for (const list of [regionsFor('front'), regionsFor('back')]) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const p = list[a];
        const q = list[b];
        const ox = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x);
        const oy = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
        if (ox > 0 && oy > 0) overlaps.push(`${p.muscle}/${q.muscle}`);
      }
    }
  }
  overlaps.length === 0
    ? ok('no two regions on a side overlap')
    : bad('overlapping regions', overlaps.join(' '));

  // Below ~9pt a hollow ring closes up and reads as solid, which would collapse
  // the one hue-free cue separating `recovering` from `fatigued` — the two
  // fills measure 1.03:1 against each other. 118 is the component's default.
  const smallest =
    Math.min(...FIGURE_REGIONS.map((r) => Math.min(r.w, r.h))) * (118 / FIGURE_GRID.w);
  smallest >= 9
    ? ok(`smallest cell is ${smallest.toFixed(1)}pt at the default figure width`)
    : bad('a cell is too small to carry a ring', `${smallest.toFixed(1)}pt`);
}

// ---------------------------------------------------------------------------
console.log('1b. freshness display: tally, spoken summary, the never-trained basis');
{
  const ledger = MUSCLE_ORDER.map((muscle) => ({
    muscle,
    freshness: 100,
    state: 'fresh',
    hoursSinceLast: null,
  }));
  const virgin = freshnessTally(ledger);
  virgin.neverTrained && virgin.fresh.length === 16 && virgin.total === 16
    ? ok('a never-trained ledger reads 16/16 fresh AND flags its own basis')
    : bad('virgin tally', JSON.stringify(virgin));
  freshnessSummary(ledger).includes('No sessions logged')
    ? ok('the spoken summary states the basis when nothing has been logged')
    : bad('virgin summary', freshnessSummary(ledger));

  const worked = ledger.map((m) => {
    if (m.muscle === 'chest') return { ...m, freshness: 30, state: 'fatigued', hoursSinceLast: 6 };
    if (m.muscle === 'triceps')
      return { ...m, freshness: 65, state: 'recovering', hoursSinceLast: 6 };
    return m;
  });
  const t = freshnessTally(worked);
  t.fresh.length === 14 && t.recovering.length === 1 && t.fatigued.length === 1 && !t.neverTrained
    ? ok('a worked ledger splits 14 fresh / 1 recovering / 1 fatigued')
    : bad('worked tally', JSON.stringify(t));
  const summary = freshnessSummary(worked);
  summary.includes('14 of 16') && summary.includes('chest') && summary.includes('triceps')
    ? ok('the spoken summary names every marked muscle')
    : bad('worked summary', summary);
  muscleNames(['front_delts', 'lower_back']) === 'Front delts · Lower back'
    ? ok('printed muscle names join on the sheet mid-dot')
    : bad('muscleNames', muscleNames(['front_delts', 'lower_back']));
}

// ---------------------------------------------------------------------------
console.log('2. parseWorkoutImport: validation, clamps, fences');
{
  const reply = `\`\`\`json
{"date": "2026-08-09", "name": "Push Day", "kind": "strength", "durationMin": 52,
 "exercises": [
   {"name": "Bench Press", "sets": [
     {"reps": 8, "weight": 135, "weightUnit": "lb", "rpe": 8},
     {"reps": 8, "weight": 135, "weightUnit": "lb", "rpe": null}]},
   {"name": "Pull-Up", "sets": [{"reps": 10, "weight": null, "weightUnit": null, "rpe": null}]}
 ], "notes": "second page cropped"}
\`\`\``;
  const parsed = parseWorkoutImport(reply);
  parsed.date === '2026-08-09' && parsed.name === 'Push Day' && parsed.kind === 'strength'
    ? ok('header fields parse (through ```json fences)')
    : bad('header', JSON.stringify(parsed));
  parsed.exercises.length === 2 &&
  parsed.exercises[0].sets.length === 2 &&
  parsed.exercises[0].sets[0].weight === 135 &&
  parsed.exercises[0].sets[0].weightUnit === 'lb' &&
  parsed.exercises[1].sets[0].weight === null
    ? ok('exercises + sets parse; bodyweight rows keep null weight')
    : bad('sets', JSON.stringify(parsed.exercises));
  parsed.notes === 'second page cropped' ? ok('notes carried') : bad('notes');

  const junk = parseWorkoutImport(
    '{"date": "yesterday", "name": "", "kind": "yoga", "durationMin": -5, "exercises": [' +
      '{"name": "Bench", "sets": [{"reps": 8.6, "weight": 5000, "weightUnit": "lb", "rpe": 22}]},' +
      '{"name": "Ghost", "sets": [{"reps": null, "weight": null, "weightUnit": null, "rpe": null}]}' +
      '], "notes": ""}'
  );
  junk.date === null && junk.kind === 'strength' && junk.durationMin === null
    ? ok("junk header degrades safely (relative date → null, unknown kind → 'strength')")
    : bad('junk header', JSON.stringify(junk));
  junk.exercises.length === 1 &&
  junk.exercises[0].sets[0].reps === 9 &&
  junk.exercises[0].sets[0].weight === null &&
  junk.exercises[0].sets[0].rpe === null
    ? ok('junk numbers clamp (fractional reps round, 5000 lb + RPE 22 rejected, empty set dropped)')
    : bad('junk sets', JSON.stringify(junk.exercises));
  junk.name === 'Imported workout' ? ok('blank name gets the honest default') : bad('name default');

  throws(() => parseWorkoutImport('no json here'))
    ? ok('reply without JSON throws')
    : bad('no-JSON');
  throws(() => parseWorkoutImport('{"exercises": []}'))
    ? ok('reply with no usable sets throws')
    : bad('empty throws');
}

// ---------------------------------------------------------------------------
console.log('3. groundWorkoutImport: confident matches only');
{
  const { db } = freshDb();
  const grounded = groundWorkoutImport(db, {
    date: null,
    name: 'X',
    kind: 'strength',
    durationMin: null,
    notes: null,
    exercises: [
      {
        name: 'Barbell Bench Press',
        exerciseId: null,
        sets: [{ reps: 5, weight: 100, weightUnit: 'kg', rpe: null }],
      },
      {
        name: 'RDL',
        exerciseId: null,
        sets: [{ reps: 8, weight: 100, weightUnit: 'kg', rpe: null }],
      },
      {
        name: 'bench',
        exerciseId: null,
        sets: [{ reps: 5, weight: 60, weightUnit: 'kg', rpe: null }],
      },
      {
        name: 'Cossack Squat',
        exerciseId: null,
        sets: [{ reps: 10, weight: null, weightUnit: null, rpe: null }],
      },
    ],
  });
  grounded.exercises[0].exerciseId === 'barbell-bench-press'
    ? ok('exact name matches the catalog id')
    : bad('exact', grounded.exercises[0].exerciseId);
  grounded.exercises[1].exerciseId === 'romanian-deadlift'
    ? ok("alias matches ('RDL' → Romanian Deadlift)")
    : bad('alias', grounded.exercises[1].exerciseId);
  grounded.exercises[2].exerciseId === null
    ? ok("a generic single token ('bench') deliberately does NOT match")
    : bad('single token', grounded.exercises[2].exerciseId);
  grounded.exercises[3].exerciseId === null
    ? ok('an unknown movement stays free text')
    : bad('unknown', grounded.exercises[3].exerciseId);
}

// ---------------------------------------------------------------------------
console.log('4. buildWorkoutParseRequest shape (image first, note appended)');
{
  const req = buildWorkoutParseRequest('B64DATA', 'units are kg');
  req.messages.length === 1 &&
  req.messages[0].content[0].type === 'image' &&
  req.messages[0].content[0].source.data === 'B64DATA' &&
  req.messages[0].content[1].type === 'text' &&
  req.messages[0].content[1].text.includes('units are kg')
    ? ok('image block first, user note rides the text block')
    : bad('request', JSON.stringify(req.messages[0].content.map((c) => c.type)));
  /TRANSCRIBE/.test(req.system) ? ok('system prompt demands transcription') : bad('system');
}

// ---------------------------------------------------------------------------
console.log('5. backdated fatigue attribution (attributedInstant + the window)');
{
  // Same local day → created_at wins verbatim.
  const sameDay = new Date(2026, 7, 11, 9, 0, 0).toISOString();
  attributedInstant('2026-08-11', sameDay) === sameDay
    ? ok('same-day log keeps its created_at instant')
    : bad('same day');
  // Backdated → the workout's own date at local noon.
  const attributed = attributedInstant('2026-08-04', sameDay);
  new Date(attributed).getTime() === new Date(2026, 7, 4, 12, 0, 0).getTime()
    ? ok('backdated log is attributed to its date at local noon')
    : bad('backdated', attributed);

  // End to end: an import backdated a week must NOT read as fresh fatigue.
  const { db, raw } = freshDb();
  const now = new Date(2026, 7, 11, 18, 0, 0);
  const id = logWorkout(
    db,
    { date: '2026-08-04', name: 'Imported', kind: 'strength', notes: 'Imported from a photo.' },
    [
      { exercise: 'Bench', exerciseId: 'barbell-bench-press', reps: 8, weightKg: 80 },
      { exercise: 'Bench', exerciseId: 'barbell-bench-press', reps: 8, weightKg: 80 },
      { exercise: 'Bench', exerciseId: 'barbell-bench-press', reps: 8, weightKg: 80 },
      { exercise: 'Bench', exerciseId: 'barbell-bench-press', reps: 8, weightKg: 80 },
      { exercise: 'Bench', exerciseId: 'barbell-bench-press', reps: 8, weightKg: 80 },
    ]
  );
  // created_at is "now" (the import moment) — pin it to the test's clock day.
  raw
    .prepare('UPDATE workouts SET created_at = ? WHERE id = ?')
    .run(new Date(2026, 7, 11, 17, 0, 0).toISOString(), id);
  const ledger = muscleFreshness(recentMuscleLoads(db, 14, now), now);
  const chest = ledger.find((m) => m.muscle === 'chest');
  chest.freshness >= 80
    ? ok('a week-old imported session reads recovered, not just-trained')
    : bad('imported freshness', JSON.stringify(chest));
}

// ---------------------------------------------------------------------------
console.log('6. parseExerciseSearch: enum discipline, drops half-definitions');
{
  const reply = JSON.stringify({
    matches: [
      { id: 'barbell-bench-press' },
      { id: 'nope-not-real' },
      { id: 'barbell-bench-press' },
    ],
    created: [
      {
        name: 'Landmine Press',
        equipment: 'barbell',
        primaryMuscles: ['front_delts', 'front_delts', 'earlobe'],
        secondaryMuscles: ['triceps', 'front_delts'],
        movementPattern: 'push_v',
        mechanic: 'compound',
        loggingType: 'weight_reps',
        unilateral: true,
        instructions: ['Wedge the bar in a corner.', 'Press from the shoulder.', ''],
      },
      {
        name: 'Broken One',
        equipment: 'jetpack',
        primaryMuscles: ['chest'],
        loggingType: 'weight_reps',
      },
    ],
    note: 'Closest existing is the overhead press.',
  });
  const parsed = parseExerciseSearch(reply);
  parsed.matchIds.join() === 'barbell-bench-press,nope-not-real'
    ? ok('match ids dedupe, order kept (unknowns resolved later)')
    : bad('matchIds', JSON.stringify(parsed.matchIds));
  parsed.creations.length === 1
    ? ok('an invalid-equipment creation is dropped whole')
    : bad('drops');
  const c = parsed.creations[0];
  c.primaryMuscles.join() === 'front_delts' &&
  c.secondaryMuscles.join() === 'triceps' &&
  c.unilateral === true &&
  c.instructions.length === 2
    ? ok('creation vetted: muscles deduped + enum-checked, secondary≠primary, empty steps dropped')
    : bad('creation', JSON.stringify(c));
  parsed.note === 'Closest existing is the overhead press.' ? ok('note carried') : bad('note');

  const { db } = freshDb();
  const resolved = resolveSearchMatches(db, parsed);
  resolved.matches.length === 1 && resolved.matches[0].id === 'barbell-bench-press'
    ? ok('resolution drops ids the catalog does not know')
    : bad('resolve', JSON.stringify(resolved.matches.map((m) => m.id)));

  throws(() => parseExerciseSearch('{"matches": [], "created": [], "note": null}'))
    ? ok('an empty result throws (the UI reports, never renders nothing)')
    : bad('empty result');

  const req = buildExerciseSearchRequest('rear delts with bands', [
    { id: 'face-pull', name: 'Face Pull' },
  ]);
  req.messages[0].content.includes('face-pull :: Face Pull') &&
  req.messages[0].content.includes('rear delts with bands')
    ? ok('request carries the catalog index and the ask')
    : bad('request');
}

// ---------------------------------------------------------------------------
console.log('7. createCustomExercise persists instructions (AI-created movements)');
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
    secondaryMuscles: ['triceps'],
    instructions: ['Wedge the bar in a corner.', 'Press from the shoulder.'],
  });
  const row = raw.prepare('SELECT instructions FROM exercises WHERE id = ?').get(id);
  JSON.parse(row.instructions).length === 2
    ? ok('instructions land as valid JSON on the row')
    : bad('instructions', row.instructions);
  getExercise(db, id)?.name === 'Landmine Press'
    ? ok('the created movement reads back through the repo')
    : bad('read back');
  const bare = createCustomExercise(db, {
    name: 'No Steps',
    equipment: 'other',
    loggingType: 'duration',
    primaryMuscles: ['abs'],
  });
  raw.prepare('SELECT instructions FROM exercises WHERE id = ?').get(bare).instructions === null
    ? ok('no instructions stores NULL, not an empty array')
    : bad('bare instructions');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
