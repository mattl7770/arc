/**
 * Headless test of the Coach's Phase-2 LEVERS (docs/coach-intelligence-review.md
 * §4 Phase 2) against real SQLite via node:sqlite:
 *
 *   - adjust_today — batch mission surgery behind one confirmation, with the
 *     defence-in-depth guards that make acted-on and ad-hoc rows untouchable
 *   - update_protocol's honest today/tomorrow semantics (+ apply_today)
 *   - set_mode's schedulable start date
 *   - the training engine's caller-supplied volume dial (never auto-derived)
 *   - the readiness insight (states the verdict; prescribes nothing)
 *
 * op-sqlite and the model client are never loaded. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { todayISODate } from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { getActiveMode } from '../src/lib/db/repositories/day-modes.ts';
import { generateMissionForDay } from '../src/lib/db/repositories/mission-generate.ts';
import { logNote } from '../src/lib/db/repositories/logs.ts';
import {
  getOrCreateDailyLog,
  insertMissionItem,
  listMission,
} from '../src/lib/db/repositories/mission.ts';
import { createProtocolWithVersion, listProtocols } from '../src/lib/db/repositories/protocols.ts';
import { buildRecommendation } from '../src/lib/db/repositories/training-recommend.ts';
import { createRoutine } from '../src/lib/db/repositories/routines.ts';
import { isoDaysAgo } from '../src/lib/ai/series.ts';
import { computeInsights, generateDailyBrief } from '../src/lib/ai/insights.ts';
import { normalizeVolumeScale } from '../src/lib/exercise/recommend.ts';
import { toolByName } from '../src/lib/ai/tools/index.ts';

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

const NOW = new Date();
const CTX = { now: NOW };
const TODAY = todayISODate(NOW);
const run = (name, db, input = {}) => JSON.parse(toolByName(name).execute(db, input, CTX));
const card = (name, db, input = {}) => toolByName(name).confirmSummary(input, db, CTX);

/** Seed a mission of three planned items; returns them by title. */
function seedMission(db) {
  const log = getOrCreateDailyLog(db, TODAY);
  const items = [
    { title: 'Morning light', type: 'habit', time: '07:00' },
    { title: 'Strength — Upper A', type: 'workout', time: '17:00' },
    { title: 'Magnesium', type: 'supplement', time: '21:00' },
  ];
  for (const it of items) {
    insertMissionItem(db, log.id, it.type, {
      id: 'x',
      title: it.title,
      status: 'pending',
      scheduledTime: it.time,
      category: 'Routine',
    });
  }
  const byTitle = new Map(listMission(db, TODAY).map((m) => [m.title, m]));
  return { log, byTitle };
}

console.log('1. adjust_today applies a whole batch behind ONE confirmation line');
{
  const { db } = freshDb();
  const { byTitle } = seedMission(db);
  const ops = [
    { action: 'complete', id: byTitle.get('Morning light').id },
    { action: 'skip', id: byTitle.get('Strength — Upper A').id },
    { action: 'move', id: byTitle.get('Magnesium').id, scheduled_time: '22:30' },
    {
      action: 'add',
      title: '20-min easy walk',
      type: 'habit',
      scheduled_time: '18:00',
      why: 'Keep blood flow',
    },
  ];
  const summary = card('adjust_today', db, { ops });
  summary.includes('complete "Morning light"') &&
  summary.includes('skip "Strength — Upper A"') &&
  summary.includes('move "Magnesium" → 22:30') &&
  summary.includes('add "20-min easy walk" at 18:00')
    ? ok('one card names every op, resolved to real titles')
    : bad('batch card', summary);

  const result = run('adjust_today', db, { ops });
  const after = new Map(listMission(db, TODAY).map((m) => [m.title, m]));
  after.get('Morning light').status === 'completed' &&
  after.get('Strength — Upper A').status === 'skipped' &&
  after.get('Magnesium').scheduledTime === '22:30' &&
  after.get('20-min easy walk')
    ? ok('all four ops applied to the day')
    : bad('batch apply', JSON.stringify([...after.values()]));
  result.applied.length === 4 && !result.rejected
    ? ok('the tool result reports what it did, with nothing rejected')
    : bad('applied report', JSON.stringify(result));
}

console.log('2. adjust_today can never destroy acted-on work or an ad-hoc capture');
{
  const { db } = freshDb();
  const { byTitle } = seedMission(db);
  const workout = byTitle.get('Strength — Upper A');
  run('adjust_today', db, { ops: [{ action: 'complete', id: workout.id }] });

  // A completed item must survive a remove — history is not the Coach's to delete.
  const result = run('adjust_today', db, { ops: [{ action: 'remove', id: workout.id }] });
  const still = listMission(db, TODAY).find((m) => m.id === workout.id);
  still && still.status === 'completed' && result.rejected && result.rejected.length === 1
    ? ok('removing a COMPLETED item is refused, and the refusal is explained to the model')
    : bad('completed removal', JSON.stringify({ still, result }));

  // An ad-hoc Log-tab capture is not part of the plan and is unaddressable.
  const noteId = logNote(db, TODAY, 'Slept badly, 3am wake');
  const adhoc = run('adjust_today', db, { ops: [{ action: 'remove', id: noteId }] });
  const noteRow = db.get('SELECT id FROM log_entries WHERE id = ?', [noteId]);
  noteRow && adhoc.rejected && adhoc.rejected[0].reason.includes('no such mission item')
    ? ok("an ad-hoc capture isn't a mission item — untouched, and the model is told why")
    : bad('adhoc protection', JSON.stringify({ noteRow, adhoc }));
}

console.log('3. adjust_today validates the whole batch before applying any of it');
{
  const { db } = freshDb();
  seedMission(db);
  const before = listMission(db, TODAY).length;
  throws(() =>
    run('adjust_today', db, {
      ops: [{ action: 'add', title: 'Fine' }, { action: 'skip' }], // second op has no id
    })
  )
    ? ok('an op missing its id rejects the call')
    : bad('validation missed');
  listMission(db, TODAY).length === before
    ? ok('nothing was written — validation runs before the transaction')
    : bad('partial batch applied');
  throws(() => run('adjust_today', db, { ops: [] }))
    ? ok('an empty batch is refused')
    : bad('empty ops');
}

// A protocol edit reaches TODAY, always. `apply_today` is gone (owner call,
// 2026-08-25): the flag had one defensible value, and the asymmetry it encoded
// — mode changes re-derived, protocol edits did not — was never explained
// anywhere the user would meet it.
console.log('4. update_protocol lands on TODAY and versions like code');
{
  const { db } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Evening Stack', type: 'supplement_stack' },
    {
      schema: 2,
      phases: [
        {
          id: 'p1',
          title: null,
          duration_days: null,
          items: [
            {
              id: 'i-mag',
              title: 'Magnesium',
              scheduled_time: '21:00',
              dose: '400 mg',
              notes: null,
              cadence: { kind: 'daily' },
            },
          ],
        },
      ],
    }
  );
  const phases = [
    {
      items: [
        { title: 'Magnesium', scheduled_time: '21:00', dose: '400 mg' },
        { title: 'Zinc', scheduled_time: '21:00', dose: '15 mg' },
      ],
    },
  ];
  const summary = card('update_protocol', db, {
    protocol_slug: 'evening_stack',
    phases,
    change_notes: 'added zinc',
  });
  summary.includes("applies to today's plan now") && summary.includes('(was 1)')
    ? ok('the card says it lands today, and shows the item-count delta')
    : bad('update card', summary);

  const applied = run('update_protocol', db, {
    protocol_slug: 'evening_stack',
    phases,
    change_notes: 'added zinc',
  });
  applied.effective === 'today' && typeof applied.missionAdded === 'number'
    ? ok('the tool re-derives the day and reports the diff')
    : bad('applied result', JSON.stringify(applied));

  run('update_protocol', db, {
    protocol_slug: 'evening_stack',
    phases: [{ items: [...phases[0].items, { title: 'Glycine', dose: '3 g', cadence: '3/week' }] }],
    change_notes: 'added glycine, three a week',
  });
  listProtocols(db)[0].versionNumber === 3
    ? ok('each save is a new immutable version (v3), never an edit')
    : bad('versioning', JSON.stringify(listProtocols(db)));

  // The cadence vocabulary is validated at the boundary: a model that writes
  // something else gets a message it can act on, not a broken protocol.
  let message = '';
  try {
    run('update_protocol', db, {
      protocol_slug: 'evening_stack',
      phases: [{ items: [{ title: 'Magnesium', cadence: 'fortnightly-ish' }] }],
      change_notes: 'nope',
    });
  } catch (e) {
    message = String(e.message);
  }
  message.includes('3/week')
    ? ok('an unreadable cadence is refused at the tool boundary, naming the vocabulary')
    : bad('bad cadence accepted', message);
  listProtocols(db)[0].versionNumber === 3
    ? ok('…and nothing was written — the version count is unchanged')
    : bad('a rejected call still wrote', JSON.stringify(listProtocols(db)));
}

console.log('5. set_mode schedules ahead; a past start is refused');
{
  const { db } = freshDb();
  const monday = isoDaysAgo(NOW, -3);
  const friday = isoDaysAgo(NOW, -7);
  const scheduledCard = card('set_mode', db, { mode: 'travel', from: monday, until: friday });
  scheduledCard.includes(monday) && scheduledCard.includes(friday)
    ? ok('the card names the real span, not "for today"')
    : bad('scheduled card', scheduledCard);

  const result = run('set_mode', db, { mode: 'travel', from: monday, until: friday });
  result.set && result.from === monday && result.until === friday
    ? ok('a future-dated mode is stored for its own span')
    : bad('scheduled set', JSON.stringify(result));
  getActiveMode(db, TODAY) === 'normal' && getActiveMode(db, monday) === 'travel'
    ? ok('today is untouched; the mode is active on its start date')
    : bad('active mode', `${getActiveMode(db, TODAY)} / ${getActiveMode(db, monday)}`);
  typeof result.note === 'string' && result.note.includes('will generate')
    ? ok('the result explains that the day generates under the mode later')
    : bad('scheduled note', JSON.stringify(result));

  throws(() => run('set_mode', db, { mode: 'sick', from: isoDaysAgo(NOW, 2) }))
    ? ok('a past start date is refused')
    : bad('past start accepted');
  throws(() => run('set_mode', db, { mode: 'travel', from: friday, until: monday }))
    ? ok('an end before the start is refused')
    : bad('inverted range accepted');

  // Today still re-derives immediately (the pre-existing behavior).
  const todayResult = run('set_mode', db, { mode: 'sick' });
  typeof todayResult.missionAdded === 'number' && getActiveMode(db, TODAY) === 'sick'
    ? ok('a mode set for today still reshapes today immediately')
    : bad('today mode', JSON.stringify(todayResult));
}

console.log('6. the volume dial is caller-supplied, clamped, and compiles to real sets');
{
  normalizeVolumeScale(undefined) === undefined && normalizeVolumeScale(1) === undefined
    ? ok('no dial and a 1.0 dial are both "no adjustment"')
    : bad('no-op dial', String(normalizeVolumeScale(1)));
  normalizeVolumeScale(0.001) === 0.1 && normalizeVolumeScale(99) === 1.5
    ? ok('wild values clamp into a sane band (0.1–1.5)')
    : bad('clamp', `${normalizeVolumeScale(0.001)} / ${normalizeVolumeScale(99)}`);
  normalizeVolumeScale(Number.NaN) === undefined
    ? ok('NaN is treated as absent, never as zero volume')
    : bad('NaN dial');

  const { db, raw } = freshDb();
  const bench = raw.prepare(`SELECT id FROM exercises WHERE name = 'Barbell Bench Press'`).get();
  const row = raw.prepare(`SELECT id FROM exercises WHERE name = 'Barbell Back Squat'`).get();
  createRoutine(db, {
    name: 'Upper A',
    notes: null,
    exercises: [
      { exerciseId: bench.id, targetSets: 4, repLow: 5, repHigh: 8, restSec: 180 },
      { exerciseId: row.id, targetSets: 3, repLow: 5, repHigh: 8, restSec: 180 },
    ],
  });

  const plan = buildRecommendation(db, NOW).recommendation;
  const planned = plan.exercises.map((e) => e.targetSets);
  planned.join(',') === '4,3'
    ? ok('the plan as written carries its routine set targets (4, 3)')
    : bad('planned sets', planned.join(','));

  const lighter = buildRecommendation(db, NOW, { volumeScale: 0.6 }).recommendation;
  lighter.exercises.map((e) => e.targetSets).join(',') === '3,2'
    ? ok('a 60% dial compiles to 3 and 2 working sets (ceil, never below 1)')
    : bad('scaled sets', lighter.exercises.map((e) => e.targetSets).join(','));
  lighter.why.includes('60%')
    ? ok('the session why says the volume was adjusted')
    : bad('why', lighter.why);

  const floored = buildRecommendation(db, NOW, { volumeScale: 0.1 }).recommendation;
  floored.exercises.every((e) => e.targetSets >= 1)
    ? ok('even the smallest dial leaves at least one working set')
    : bad('floor', JSON.stringify(floored.exercises.map((e) => e.targetSets)));

  // The tool surfaces the dial as a PREVIEW; nothing is written.
  const preview = run('get_training_recommendation', db, { volume_scale: 0.5 });
  preview.volumeScaleApplied === 0.5 &&
  preview.recommendation.exercises[0].sets === 2 &&
  buildRecommendation(db, NOW).recommendation.exercises[0].targetSets === 4
    ? ok('get_training_recommendation previews the dial without changing the plan')
    : bad('preview', JSON.stringify(preview.recommendation.exercises));
}

console.log('7. readiness insight: states the verdict, prescribes nothing, no brief duplication');
{
  const { db, raw } = freshDb();
  let n = 0;
  const seed = (metric, daysAgo, value) =>
    raw
      .prepare(
        `INSERT INTO wearable_data (id, date, metric_type, value, source_device) VALUES (?, ?, ?, ?, 'manual')`
      )
      .run(`rd-${++n}`, isoDaysAgo(NOW, daysAgo), metric, value);
  for (let d = 1; d <= 6; d++) seed('hrv', d, 50);
  seed('hrv', 0, 38); // ratio 0.76 → poor

  const insights = computeInsights(db, NOW);
  const readiness = insights.find((i) => i.kind === 'readiness');
  readiness && readiness.tone === 'watch'
    ? ok('a poor-readiness morning produces a watch-tone readiness insight')
    : bad('readiness insight missing', JSON.stringify(insights.map((i) => i.id)));
  readiness && /HRV 38/.test(readiness.detail)
    ? ok('it carries the same evidence Home shows')
    : bad('readiness detail', readiness && readiness.detail);
  // The engine must hand the model STATE, never an instruction — Home's own
  // "Back off today" copy is a prescription and must not become the headline.
  readiness &&
  !/(should|cut|reduce|skip|deload|back off|go easy|rest today)/i.test(readiness.headline)
    ? ok('the headline states the level without prescribing a response')
    : bad('prescriptive headline', readiness && readiness.headline);
  readiness && readiness.detail.includes('Home shows this as')
    ? ok('the Home label rides in the detail, so the two surfaces stay traceable')
    : bad('missing home label', readiness && readiness.detail);
  !/Recovery is (well )?below your baseline/.test(generateDailyBrief(db, NOW))
    ? ok('the brief does not repeat what the readiness strip already shows')
    : bad('brief duplicates readiness', generateDailyBrief(db, NOW));
}

// ---------------------------------------------------------------------------
// Regressions from the Phase 2–6 adversarial review. Each of these shipped as
// a real defect; the assertion is the reproduction.
// ---------------------------------------------------------------------------

console.log('R1. adjust_today `add` must not suppress a day that was never generated');
{
  const { db } = freshDb();
  // A protocol exists, but nothing has generated today yet — the Coach tab was
  // the first surface opened this morning, so Home's ensureTodaySeeded never ran.
  createProtocolWithVersion(
    db,
    { name: 'Morning Stack', type: 'supplement_stack' },
    {
      items: [
        { title: 'Creatine 5g', scheduled_time: '07:30' },
        { title: 'Omega-3', scheduled_time: '07:30' },
      ],
    }
  );
  listMission(db, TODAY).length === 0 ? ok('the day starts ungenerated') : bad('precondition');

  run('adjust_today', db, { ops: [{ action: 'add', title: 'Sauna 20m', type: 'therapy' }] });

  const titles = listMission(db, TODAY).map((m) => m.title);
  titles.includes('Creatine 5g') && titles.includes('Omega-3')
    ? ok("the protocol's own items are still generated alongside the addition")
    : bad('the add swallowed the whole day', JSON.stringify(titles));
  titles.includes('Sauna 20m')
    ? ok('…and the added item is there too')
    : bad('add lost', JSON.stringify(titles));
}

console.log('R2. complete/skip never rewrite work already recorded');
{
  const { db } = freshDb();
  const { byTitle } = seedMission(db);
  const id = byTitle.get('Strength — Upper A').id;

  run('adjust_today', db, { ops: [{ action: 'complete', id }] });
  const firstStamp = db.get('SELECT completed_at FROM log_entries WHERE id = ?', [id]).completed_at;
  firstStamp ? ok('completing stamps completed_at') : bad('no completed_at');

  // Re-completing must not move the timestamp to "now".
  run('adjust_today', db, { ops: [{ action: 'complete', id }] });
  db.get('SELECT completed_at FROM log_entries WHERE id = ?', [id]).completed_at === firstStamp
    ? ok('re-completing is idempotent — the original time stands')
    : bad('completed_at was restamped');

  // Skipping something already completed must be REFUSED, not silently applied
  // (it would null completed_at and erase when the work actually happened).
  const out = run('adjust_today', db, { ops: [{ action: 'skip', id }] });
  const still = db.get('SELECT status, completed_at FROM log_entries WHERE id = ?', [id]);
  still.status === 'completed' && still.completed_at === firstStamp
    ? ok('skipping completed work is refused; the record survives intact')
    : bad('history destroyed', JSON.stringify(still));
  out.rejected && out.rejected.length === 1
    ? ok('…and the refusal is reported to the model, not swallowed')
    : bad('silent refusal', JSON.stringify(out));
}

console.log('R3. an approved removal survives a later mode change');
{
  const { db } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Daily', type: 'daily_routine' },
    {
      items: [
        { title: 'Zone 2 — 45m', scheduled_time: '06:30' },
        { title: 'Evening walk', scheduled_time: '20:00' },
      ],
    }
  );
  generateMissionForDay(db, TODAY);
  const walk = listMission(db, TODAY).find((m) => m.title === 'Evening walk');
  walk ? ok('the day generated from the protocol') : bad('no generated day');

  run('adjust_today', db, { ops: [{ action: 'remove', id: walk.id }] });
  !listMission(db, TODAY).some((m) => m.title === 'Evening walk')
    ? ok('the removal takes effect immediately')
    : bad('remove did nothing');

  // The user now says they are travelling. Re-derive recomputes the day from
  // the protocol — and used to resurrect exactly what they just removed.
  run('set_mode', db, { mode: 'travel' });
  !listMission(db, TODAY).some((m) => m.title === 'Evening walk')
    ? ok('…and it stays removed after a mode change re-derives the day')
    : bad('the mode change resurrected an approved removal');
  getActiveMode(db, TODAY) === 'travel' ? ok('the mode itself did apply') : bad('mode not set');
}

console.log('R4. an experiment only occupies the days it actually runs');
{
  const { db } = freshDb();
  const yesterday = isoDaysAgo(NOW, 1);
  const longAgo = isoDaysAgo(NOW, 30);
  // Still `active` because nobody has read it out — but its window closed.
  db.run(
    `INSERT INTO experiments (id, title, hypothesis, intervention, metrics, start_date, end_date, status)
     VALUES ('x-done', 'Magnesium', 'helps sleep', 'Magnesium 400mg at 21:00', '["sleep"]', ?, ?, 'active')`,
    [longAgo, yesterday]
  );
  generateMissionForDay(db, TODAY);
  !listMission(db, TODAY).some((m) => m.title.includes('Magnesium'))
    ? ok('a finished-but-unread experiment no longer plants a task every day')
    : bad('closed experiment still injecting');

  // One that has not begun yet is equally not today's business.
  const { db: db2 } = freshDb();
  db2.run(
    `INSERT INTO experiments (id, title, hypothesis, intervention, metrics, start_date, end_date, status)
     VALUES ('x-future', 'Cold plunge', 'helps HRV', 'Cold plunge 3m', '["hrv"]', ?, ?, 'active')`,
    [isoDaysAgo(NOW, -5), isoDaysAgo(NOW, -19)]
  );
  generateMissionForDay(db2, TODAY);
  !listMission(db2, TODAY).some((m) => m.title.includes('Cold plunge'))
    ? ok('a not-yet-started experiment does not appear early either')
    : bad('future experiment injecting');

  // …while one genuinely running today still does.
  const { db: db3 } = freshDb();
  db3.run(
    `INSERT INTO experiments (id, title, hypothesis, intervention, metrics, start_date, end_date, status)
     VALUES ('x-live', 'Creatine', 'helps output', 'Creatine 5g daily', '["hrv"]', ?, ?, 'active')`,
    [isoDaysAgo(NOW, 3), isoDaysAgo(NOW, -10)]
  );
  generateMissionForDay(db3, TODAY);
  listMission(db3, TODAY).some((m) => m.title.includes('Creatine'))
    ? ok('…and a live experiment still lands on the mission (adherence stays visible)')
    : bad('live experiment missing');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
