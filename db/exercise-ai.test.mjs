/**
 * Headless test of the exercise features that are not the logger: the body
 * figure's GEOMETRY (figure.ts — completeness, coverage, non-overlap, the
 * rasteriser, the view budget and the opacity ramp), hand-set freshness anchors
 * (migration 0037), the photo-import parser/grounder (import-workout.ts),
 * backdated-fatigue attribution (training-stats.attributedInstant + the
 * freshness window), the AI exercise-search parser (ai-search.ts), and custom
 * exercises carrying instructions. Real SQLite via node:sqlite; op-sqlite /
 * Expo / the network never loaded — the model calls themselves are NOT tested
 * here, only the pure request/parse/ground layers around them (the
 * db/nutrition-style split). Run: npm run db:test.
 *
 * What §1 CANNOT test is how the figure looks, which is the thing that has been
 * rejected twice. It tests the invariants a drawing can be wrong about
 * silently — a muscle floating off the body, two shapes painting over each
 * other, a polygon wound so it rasterises to nothing, a node count that turns a
 * scrolling screen to treacle. Looks stay an on-device check (memory: verify on
 * device, not web).
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
  FIGURE_MUSCLES,
  MUSCLE_FRESH,
  MUSCLE_SPENT,
  coveredByBody,
  figureViewCount,
  freshnessFill,
  mappedMuscles,
  musclesFor,
  polyBars,
  shapeBounds,
  shapesOverlap,
} from '../src/lib/exercise/figure.ts';
import {
  clearMuscleAnchor,
  listMuscleAnchors,
  setMuscleAnchor,
} from '../src/lib/db/repositories/muscle-anchors.ts';
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
  musclesFor('front').length > 0 && musclesFor('back').length > 0
    ? ok('both sides carry muscle shapes')
    : bad('sides');
  const inGrid = (s) => {
    const b = shapeBounds(s);
    return b.x >= 0 && b.y >= 0 && b.x + b.w <= FIGURE_GRID.w && b.y + b.h <= FIGURE_GRID.h;
  };
  FIGURE_MUSCLES.every((m) => inGrid(m.shape))
    ? ok(`every muscle shape sits inside the ${FIGURE_GRID.w}×${FIGURE_GRID.h} grid`)
    : bad('shape bounds');
  // The back view must include the muscles invisible from the front.
  const back = new Set(musclesFor('back').map((m) => m.muscle));
  ['lats', 'upper_back', 'lower_back', 'glutes', 'hamstrings', 'traps', 'rear_delts'].every((m) =>
    back.has(m)
  )
    ? ok('posterior chain lives on the back view')
    : bad('back coverage');

  // --- the invariants the 2026-08-12 contoured rewrite inherits -------------
  // A muscle means "quads" only because of where it sits ON A PERSON, so the
  // silhouette is load-bearing and every shape has to ride on it. Now sampled
  // against the ROUNDED body blocks rather than their bounding rects, so a
  // muscle hanging off a curved shoulder fails here instead of on the phone.
  const offBody = FIGURE_MUSCLES.filter((m) => !coveredByBody(m.shape));
  offBody.length === 0
    ? ok('every muscle shape is fully covered by the body silhouette')
    : bad('shapes off the body', offBody.map((m) => `${m.muscle}@${m.side}`).join(' '));

  // The contour is drawn by inflating each block by BODY_OUTLINE, so the
  // INFLATED body — not just its fill — has to stay on the grid, or the
  // silhouette's outline clips against the edge of the figure box.
  FIGURE_BODY.every(({ shape }) => {
    const b = shapeBounds(shape);
    return (
      b.x - BODY_OUTLINE >= 0 &&
      b.y - BODY_OUTLINE >= 0 &&
      b.x + b.w + BODY_OUTLINE <= FIGURE_GRID.w &&
      b.y + b.h + BODY_OUTLINE <= FIGURE_GRID.h
    );
  })
    ? ok('the inflated silhouette stays inside the grid (the contour never clips)')
    : bad('body outline clips the grid');

  // Two overlapping shapes on one side would paint one reading over another and
  // silently lose a muscle. Rasterised, not bounding-box: the two heads of a
  // quad, and a lat beside its erector column, have overlapping BOXES and share
  // no area — a box test would condemn correct anatomy.
  //
  // Shapes of the SAME muscle are exempt, and that is not a loophole: the two
  // heads of a quadriceps carry ONE reading, so where they touch nothing is
  // lost. What this guards is a DIFFERENT muscle's reading being painted over,
  // which is unrecoverable.
  const overlaps = [];
  for (const list of [musclesFor('front'), musclesFor('back')]) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        if (list[a].muscle === list[b].muscle) continue;
        if (shapesOverlap(list[a].shape, list[b].shape)) {
          overlaps.push(`${list[a].muscle}/${list[b].muscle}`);
        }
      }
    }
  }
  overlaps.length === 0
    ? ok('no two DIFFERENT muscles overlap on a side')
    : bad('overlapping shapes', overlaps.join(' '));

  // A polygon has to rasterise into something. An empty bar list is a shape
  // wound wrong or degenerate, and it draws as nothing at all.
  const empty = FIGURE_MUSCLES.filter(
    (m) => m.shape.kind === 'poly' && polyBars(m.shape.pts, 8).length < 8
  );
  empty.length === 0
    ? ok('every polygon rasterises to one span on every scanline')
    : bad('degenerate polygons', empty.map((m) => m.muscle).join(' '));

  // The BODY is polygons too since 2026-08-14 — the fix that actually mattered,
  // because a rectangular torso over a narrower rectangular waist reads as
  // boxes whatever is drawn on top of it. Same degeneracy check.
  const emptyBody = FIGURE_BODY.filter(
    (b) => b.shape.kind === 'poly' && polyBars(b.shape.pts, 8).length < 8
  );
  emptyBody.length === 0
    ? ok('every body polygon rasterises cleanly too')
    : bad('degenerate body', emptyBody.map((b) => b.part).join(' '));

  // The drawing lives inside two scrolling screens, so its node count is a
  // budget. Counted, never assumed — see figureViewCount. The ceiling rose from
  // 600 to 900 to pay for the polygonal body and finer muscle bars; what kept it
  // reachable was making every DOME a blob (skull, shoulder caps, biceps and
  // triceps, glutes, the inner calf belly, hands, feet), one view each.
  const hub = figureViewCount(118);
  const full = figureViewCount(128);
  full <= 900
    ? ok(`the figure pair costs ${hub} views at 118pt and ${full} at 128pt (ceiling 900)`)
    : bad('view budget blown', String(full));

  // --- the ramp (owner, 2026-08-14: spent fades to GREY, not to pale green) --
  const relLum = (h) => {
    const c = [1, 3, 5]
      .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => {
    const x = relLum(a);
    const y = relLum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  // paper-hi — the plate the figure sits on, and (since this round) the colour
  // the head, hands and feet are drawn in.
  const PLATE = '#F5F3EC';
  const at = (f) => freshnessFill(f).color;

  at(100).toLowerCase() === MUSCLE_FRESH.toLowerCase() &&
  at(0).toLowerCase() === MUSCLE_SPENT.toLowerCase() &&
  freshnessFill(50).alpha === 1
    ? ok(`the ramp runs ${MUSCLE_SPENT} spent → ${MUSCLE_FRESH} fresh, opaque throughout`)
    : bad('ramp ends', JSON.stringify([freshnessFill(0), freshnessFill(100)]));

  // WCAG 1.4.11: a graphical object needs 3:1 against the surface it sits on —
  // EVERY reading, not just the fresh end. That is what a floor is for.
  const failing = [];
  for (let f = 0; f <= 100; f++) if (ratio(at(f), PLATE) < 3) failing.push(f);
  failing.length === 0
    ? ok(
        `every reading clears 3:1 on the plate — 0: ${ratio(at(0), PLATE).toFixed(2)}, ` +
          `50: ${ratio(at(50), PLATE).toFixed(2)}, 100: ${ratio(at(100), PLATE).toFixed(2)}`
      )
    : bad('contrast floor breached at', failing.join(','));

  // Head, hands and feet draw in the PLATE colour precisely so a spent muscle
  // cannot be mistaken for one of them. Their old `hairline` grey sat 1.32:1
  // from the spent end, which the previous author flagged and this answers.
  ratio(at(0), PLATE) >= 3
    ? ok(`the spent end clears the non-data parts at ${ratio(at(0), PLATE).toFixed(2)}:1`)
    : bad('spent collides with the neutral parts');

  // Monotone in LUMINANCE the whole way and the two ends measurably apart, so
  // the reading survives a greyscale render as well as a hue-blind one.
  let monotone = true;
  for (let f = 1; f <= 100; f++) if (relLum(at(f)) >= relLum(at(f - 1))) monotone = false;
  const ends = ratio(at(0), at(100));
  monotone && ends >= 2
    ? ok(`it darkens monotonically toward fresh; the ends are ${ends.toFixed(2)}:1 apart`)
    : bad('ramp shape', `monotone=${monotone} ends=${ends.toFixed(2)}`);

  // Clamped outside 0-100, and no mud in the middle: green stays the leading
  // channel almost the whole way, so the interpolation never turns olive.
  const mid = at(50);
  const midG = parseInt(mid.slice(3, 5), 16);
  at(-50) === at(0) &&
  at(1e9) === at(100) &&
  midG > parseInt(mid.slice(1, 3), 16) &&
  midG > parseInt(mid.slice(5, 7), 16)
    ? ok(`the ramp clamps outside 0-100, and its midpoint ${mid} is still a green, not mud`)
    : bad('ramp clamp/midpoint', mid);
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

// ---------------------------------------------------------------------------
console.log('8. hand-set freshness anchors (0037): assert, decay, supersede, clear');
{
  const { db } = freshDb();
  const now = new Date(2026, 7, 12, 12, 0, 0);
  const iso = (d) => d.toISOString();

  // An anchor asserted right now IS the reading.
  const anchorNow = (muscle, freshness, at) => [{ muscle, freshness, anchoredAt: iso(at) }];
  const quads = (loads, anchors, when = now) =>
    muscleFreshness(loads, when, anchors).find((m) => m.muscle === 'quads');

  const spent = quads([], anchorNow('quads', 0, now));
  spent.freshness === 0 && spent.state === 'fatigued'
    ? ok('an anchor of 0 reads 0 with no sets at all')
    : bad('anchor 0', JSON.stringify(spent));
  spent.anchoredAt === iso(now)
    ? ok('the ledger says the reading rests on a hand-set value')
    : bad('anchoredAt missing', JSON.stringify(spent));
  quads([], anchorNow('quads', 55, now)).freshness === 55
    ? ok('an anchor of 55 reads 55')
    : bad('anchor 55');

  // It DECAYS on the muscle's own clock — τ = 72/3 = 24h for quads. A
  // hand-asserted ZERO is deliberately worse than any session can produce (see
  // ANCHOR_FLOOR_PERCENT in freshness.ts): it comes back over roughly five
  // days, not three, so "I am completely wrecked" no longer recovers at exactly
  // the rate one ordinary hard session did under the retired linear model.
  const later = new Date(2026, 7, 15, 12, 0, 0);
  const decayed = quads([], anchorNow('quads', 0, now), later);
  decayed.freshness >= 70 && decayed.freshness < 90
    ? ok(`a "fully spent" anchor recovers to ${decayed.freshness} after three days`)
    : bad('anchor did not decay', JSON.stringify(decayed));
  const muchLater = quads([], anchorNow('quads', 0, now), new Date(2026, 7, 17, 12, 0, 0));
  muchLater.freshness >= 90
    ? ok(`…and to ${muchLater.freshness} after five`)
    : bad('anchor never recovers', JSON.stringify(muchLater));
  // Anything the adjuster can write round-trips exactly through the new
  // exponential inverse — the contract the screen depends on, since every tap
  // writes and immediately re-reads.
  [10, 20, 40, 55, 70, 90, 100].every((v) => quads([], anchorNow('quads', v, now)).freshness === v)
    ? ok('every value the adjuster can write round-trips through the model exactly')
    : bad('anchor round-trip');

  // Sets BEFORE the anchor are superseded — the assertion already accounts for
  // them, so replaying them would double-count.
  const before = Array.from({ length: 8 }, () => ({
    muscle: 'quads',
    roleWeight: 1,
    reps: 8,
    rpe: 8,
    weightKg: 100,
    setType: 'normal',
    whenIso: iso(new Date(2026, 7, 12, 6, 0, 0)),
  }));
  quads(before, anchorNow('quads', 100, now)).freshness === 100
    ? ok('sets logged before the anchor are superseded by it')
    : bad('supersede', JSON.stringify(quads(before, anchorNow('quads', 100, now))));

  // Sets AFTER it deplete from it, so a real session takes the reading back
  // without anyone clearing anything.
  const after = Array.from({ length: 4 }, () => ({
    muscle: 'quads',
    roleWeight: 1,
    reps: 8,
    rpe: 8,
    weightKg: 100,
    setType: 'normal',
    whenIso: iso(new Date(2026, 7, 12, 13, 0, 0)),
  }));
  const worked = quads(after, anchorNow('quads', 100, now), new Date(2026, 7, 12, 14, 0, 0));
  worked.freshness > 30 && worked.freshness < 70
    ? ok(`four sets after a "fresh" anchor pull it to ${worked.freshness}`)
    : bad('post-anchor sets', JSON.stringify(worked));

  // Stale anchors age out with the lookback window, so nothing rots.
  const ancient = quads([], anchorNow('quads', 0, new Date(2026, 6, 1, 12, 0, 0)));
  ancient.freshness === 100 && ancient.anchoredAt === null
    ? ok('an anchor older than the lookback window is ignored, and stops claiming the reading')
    : bad('stale anchor', JSON.stringify(ancient));

  // A future-dated anchor is not a reading about today.
  quads([], anchorNow('quads', 0, new Date(2026, 7, 13, 12, 0, 0))).freshness === 100
    ? ok('a future-dated anchor does not deplete anything today')
    : bad('future anchor');

  // The repository: one row per muscle, UPSERT replaces, clear removes.
  setMuscleAnchor(db, 'quads', 40);
  setMuscleAnchor(db, 'chest', 0);
  setMuscleAnchor(db, 'quads', 70);
  const rows = listMuscleAnchors(db);
  rows.length === 2 && rows.find((r) => r.muscle === 'quads').freshness === 70
    ? ok('one anchor per muscle; setting again replaces it')
    : bad('upsert', JSON.stringify(rows));
  rows.every((r) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(r.anchoredAt))
    ? ok('anchored_at is a SQLite-stamped ISO instant')
    : bad('anchored_at shape', JSON.stringify(rows));
  setMuscleAnchor(db, 'chest', 250);
  listMuscleAnchors(db).find((r) => r.muscle === 'chest').freshness === 100
    ? ok('an out-of-range value is clamped, never written raw')
    : bad('clamp');
  clearMuscleAnchor(db, 'quads');
  listMuscleAnchors(db).some((r) => r.muscle === 'quads') === false
    ? ok('clearing an anchor removes the row')
    : bad('clear');
  throws(() =>
    db.run(`INSERT INTO muscle_freshness_anchors (id, muscle, freshness, anchored_at)
                       VALUES ('x', 'earlobe', 50, '2026-08-12T12:00:00.000Z')`)
  )
    ? ok('the muscle vocabulary is a CHECK, not a convention')
    : bad('muscle CHECK');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
