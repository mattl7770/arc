/**
 * Headless test of the Coach tool registry (src/lib/ai/tools/) against real
 * SQLite via node:sqlite — each tool's execute really reads/writes the same
 * tables the capture screens use. Mirrors db/nutrition.test.mjs; op-sqlite and
 * the model client are never loaded. Run: npm run db:test.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { apiKeyStore } from '../src/lib/ai/api-key-store.ts';
import { shiftISODate, todayISODate } from '../src/lib/db/date.ts';
import {
  backfillPastRow,
  commitDayAhead,
  generateMissionForDay,
  planForDay,
} from '../src/lib/db/repositories/mission-generate.ts';
import { setMissionStatus } from '../src/lib/db/repositories/mission.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { createExperiment } from '../src/lib/db/repositories/experiments.ts';
import { createProtocolWithVersion } from '../src/lib/db/repositories/protocols.ts';
import { logWorkout, replaceWorkout, weekSummary } from '../src/lib/db/repositories/exercise.ts';
import { pairIngestedWorkouts } from '../src/lib/db/repositories/workout-ingest.ts';

import {
  setGoalDirection,
  setUnitPreference,
  setWaterTarget,
  updateProfile,
} from '../src/lib/db/repositories/user.ts';
import { SOURCE_PRIORITY, upsertWearableRows } from '../src/lib/db/repositories/wearables.ts';
// The real ingest mappers — fixtures below are built by the pipeline that runs
// on device, not by hand-written rows that only resemble it.
import {
  STATISTIC_METRICS,
  sleepDailyRows,
  statisticDailyRows,
} from '../src/lib/health/mapping.ts';
import { deriveReadiness } from '../src/lib/home/readiness.ts';
import { isoDaysAgo } from '../src/lib/ai/series.ts';
// §37-38 (C14): the retire path and the id bridge are only meaningful against
// the real recall function and the real shipped pack.
import { searchUserHistory } from '../src/lib/ai/history-search.ts';
import { rememberFact } from '../src/lib/db/repositories/coach-memory.ts';
import { ingestCorpus } from '../src/lib/rag/corpus.ts';
import {
  COACH_TOOLS,
  READ_TOOLS,
  RETIRED_WRITE_NAMES,
  STUB_TOOLS,
  WRITE_TOOLS,
  humanizeToolName,
  toolByName,
  toWireTools,
} from '../src/lib/ai/tools/index.ts';

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
const near = (a, b, eps = 0.05) => typeof a === 'number' && Math.abs(a - b) < eps;
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
/**
 * The generic write path, as the six folded status tools used to be called.
 * A FRESH context each time, because `edit_record` writes its staleness slot
 * into the one it is given and a shared object would leak a previous card's
 * "was" into the next call.
 */
const edit = (db, domain, id, fields) =>
  JSON.parse(toolByName('edit_record').execute(db, { domain, id, fields }, { now: NOW }));
/** The confirmation line `edit_record` would show for that call. */
const editCard = (db, domain, id, fields) =>
  toolByName('edit_record').confirmSummary({ domain, id, fields }, db, { now: NOW });
/** For tools whose execute is async — set_reminder resyncs the OS schedule so it
 * can report what was really scheduled, which can only be known by asking. */
const runAsync = async (name, db, input = {}) =>
  JSON.parse(await toolByName(name).execute(db, input, CTX));
const rejects = async (fn) => {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
};

console.log('0. registry shape: unique names, read/write split, wire mapping');
{
  const names = COACH_TOOLS.map((t) => t.name);
  new Set(names).size === names.length
    ? ok(`tool names unique (${names.length} registered)`)
    : bad('duplicate names', names.join(','));
  READ_TOOLS.every((t) => t.readOnly) ? ok('read tools are readOnly') : bad('read/readOnly');
  WRITE_TOOLS.every((t) => !t.readOnly && typeof t.confirmSummary === 'function')
    ? ok('every write tool is gated and has a confirmSummary')
    : bad('write tools shape');
  STUB_TOOLS.every((t) => !names.includes(t.name))
    ? ok('stub tools (protocols/modes/navigation…) are NOT registered')
    : bad('stub leaked into registry');
  const wire = toWireTools();
  wire.length === names.length &&
  wire.every((t) => t.name && t.description && t.input_schema && t.input_schema.type === 'object')
    ? ok('toWireTools maps name/description/input_schema')
    : bad('wire shape');

  // humanizeToolName must be INJECTIVE over the registry. It is the chip
  // vocabulary AND the receipt fallback for writes recorded before receipts
  // existed, so a collision is not cosmetic: it is two different things having
  // happened to the record and one line of audit trail for both. It stripped
  // `get|list|log|set|complete|dismiss` until 2026-08-25, which rendered
  // set_/complete_/dismiss_reminder identically as "reminder" and get_/log_recipe
  // as "recipe". Asserted here rather than eyeballed, because the next collision
  // arrives with the next tool.
  const byLabel = new Map();
  for (const name of names) {
    const label = humanizeToolName(name);
    byLabel.set(label, [...(byLabel.get(label) ?? []), name]);
  }
  const collisions = [...byLabel.entries()].filter(([, tools]) => tools.length > 1);
  collisions.length === 0
    ? ok(`humanizeToolName is injective over all ${names.length} tools`)
    : bad(
        'tool label collision',
        collisions.map(([label, tools]) => `"${label}" ← ${tools.join(' + ')}`).join('; ')
      );
  // …and it still earns its keep: a read chip is a NOUN (the verb is noise on
  // "get_metric_series"), a write chip is a VERB PHRASE (the verb is the fact).
  humanizeToolName('get_metric_series') === 'metric series' &&
  humanizeToolName('list_reminders') === 'reminders' &&
  humanizeToolName('set_reminder') === 'set reminder' &&
  humanizeToolName('edit_record') === 'edit record'
    ? ok('reads render as nouns, writes as verb phrases')
    : bad('humanize shape', humanizeToolName('set_reminder'));
  // The retired names still humanize, because `landedWriteReceipts` falls back
  // to this for rows written before receipts existed — including rows written
  // by a build that held `complete_reminder`.
  [...RETIRED_WRITE_NAMES].every((name) => humanizeToolName(name).length > 0) &&
  [...RETIRED_WRITE_NAMES].every((name) => !names.includes(name))
    ? ok(
        `${RETIRED_WRITE_NAMES.size} retired write names are gone from the registry and still humanize`
      )
    : bad('retired names');
  READ_TOOLS.every((t) => !/^(get|list)[ _]/.test(humanizeToolName(t.name)))
    ? ok('no read chip still carries its get_/list_ verb')
    : bad('read verb survived stripping');
}

console.log('1. get_today_snapshot: empty day is zeros, then reflects writes');
{
  const { db } = freshDb();
  const empty = run('get_today_snapshot', db);
  empty.date === TODAY &&
  empty.meals.length === 0 &&
  empty.workouts.length === 0 &&
  empty.symptoms.length === 0 &&
  empty.remindersDueToday.length === 0
    ? ok('empty snapshot is empty, not fabricated')
    : bad('empty snapshot', JSON.stringify(empty));

  run('log_meal', db, { name: 'Salmon bowl', time: '12:30', kcal: 700, protein_g: 45 });
  run('log_workout', db, { name: 'Zone 2', kind: 'cardio', duration_min: 40 });
  run('log_symptom', db, { name: 'Headache', severity: 4 });
  run('log_capture', db, { type: 'supplement', title: 'Creatine · 5 g' });
  await runAsync('set_reminder', db, { title: 'Take magnesium', time: '21:00', repeat: 'daily' });

  const snap = run('get_today_snapshot', db);
  snap.meals.length === 1 &&
  near(snap.nutritionTotals.protein_g, 45) &&
  snap.workouts.length === 1 &&
  snap.symptoms.length === 1 &&
  snap.captures.some((c) => c.title === 'Creatine · 5 g') &&
  snap.remindersDueToday.length === 1
    ? ok('snapshot reflects meal, workout, symptom, capture, reminder')
    : bad('populated snapshot', JSON.stringify(snap));

  // 0061: the snapshot carries WHAT THE USER SAID about the day, with no
  // directive and no tone attached. `mode` carried a heroFocus and a
  // toneGuidance a registry wrote, handed to the model as if observed.
  snap.mode === undefined && snap.statuses === undefined
    ? ok('no `mode` field, and no empty `statuses` array on an ordinary day')
    : bad('snapshot day fields', JSON.stringify({ mode: snap.mode, statuses: snap.statuses }));

  run('set_status', db, { label: 'traveling', until: isoDaysAgo(NOW, -2) });
  const withStatus = run('get_today_snapshot', db);
  withStatus.statuses?.length === 1 &&
  withStatus.statuses[0].label === 'traveling' &&
  withStatus.statuses[0].excusesSkips === true &&
  withStatus.statuses[0].source === 'coach' &&
  withStatus.statuses[0].until === isoDaysAgo(NOW, -2)
    ? ok('…and once one is set it carries the label, span, excusal and provenance')
    : bad('snapshot statuses', JSON.stringify(withStatus.statuses));
  withStatus.statuses[0].heroFocus === undefined &&
  withStatus.statuses[0].toneGuidance === undefined
    ? ok('…and NOTHING telling the model how to lead or how to speak')
    : bad('a directive leaked into the status', JSON.stringify(withStatus.statuses[0]));
}

console.log('2. log_metric: display-unit input lands canonical in the right table');
{
  const { db, raw } = freshDb();
  const out = run('log_metric', db, { metric: 'weight', value: 178 });
  out.logged === true ? ok('log_metric reports logged') : bad('result', JSON.stringify(out));
  const row = raw.prepare('SELECT weight_kg, source FROM body_metrics').get();
  row && near(row.weight_kg, 80.74) && row.source === 'manual'
    ? ok('178 lb stored as ~80.74 kg canonical (body_metrics)')
    : bad('canonical weight', JSON.stringify(row));

  run('log_metric', db, { metric: 'weight', value: 81, unit: 'kg' });
  const rows = raw.prepare('SELECT weight_kg FROM body_metrics ORDER BY created_at').all();
  near(rows[1]?.weight_kg, 81, 1e-6)
    ? ok('explicit unit token ("kg") bypasses the display-unit conversion')
    : bad('unit token', JSON.stringify(rows));

  run('log_metric', db, { metric: 'hrv', value: 48 });
  const hrv = raw.prepare(`SELECT * FROM wearable_data WHERE metric_type = 'hrv'`).get();
  hrv && hrv.value === 48 && hrv.date === TODAY && hrv.source_device === 'manual'
    ? ok('hrv lands in wearable_data as manual, keyed to today')
    : bad('hrv row', JSON.stringify(hrv));

  throws(() => run('log_metric', db, { metric: 'weight', value: -5 }))
    ? ok('out-of-range value rejected before any write')
    : bad('bad value accepted');
  throws(() => run('log_metric', db, { metric: 'weight', value: 80, unit: 'stone' }))
    ? ok('unknown unit token rejected with the valid set named')
    : bad('bad unit accepted');
  throws(() => run('log_metric', db, { metric: 'steps', value: 100 }))
    ? ok('unknown metric rejected')
    : bad('bad metric accepted');

  const summary = toolByName('log_metric').confirmSummary({ metric: 'weight', value: 178 }, db);
  summary === 'Log weight 178 lb'
    ? ok(`confirmSummary is the human line ("${summary}")`)
    : bad('confirm summary', summary);
}

console.log('3. log_workout writes the session and its sets transactionally');
{
  const { db, raw } = freshDb();
  run('log_workout', db, {
    name: 'Upper A',
    kind: 'strength',
    duration_min: 55,
    sets: [
      { exercise: 'Bench', reps: 8, weight: 80, unit: 'kg' },
      { exercise: 'Bench', reps: 8, weight: 80, unit: 'kg' },
    ],
  });
  raw.prepare('SELECT count(*) c FROM workouts').get().c === 1 &&
  raw.prepare('SELECT count(*) c FROM workout_sets WHERE weight_kg = 80').get().c === 2
    ? ok('workout + 2 sets persisted with their weights')
    : bad('workout rows');
  throws(() => run('log_workout', db, { name: 'X', kind: 'swimming' }))
    ? ok('unknown kind rejected')
    : bad('bad kind accepted');
  throws(() => run('log_workout', db, { name: 'X', kind: 'strength', sets: [{ reps: 5 }] }))
    ? ok('a set without an exercise name rejected')
    : bad('bad set accepted');
}

console.log('4. log_symptom and log_meal validate before writing');
{
  const { db, raw } = freshDb();
  throws(() => run('log_symptom', db, { name: 'Headache', severity: 11 }))
    ? ok('severity 11 rejected')
    : bad('severity 11 accepted');
  throws(() => run('log_meal', db, { name: 'Lunch', time: '25:00' }))
    ? ok('impossible clock time rejected (25:00)')
    : bad('25:00 accepted');
  throws(() => run('log_meal', db, {}))
    ? ok('a meal without a name rejected')
    : bad('nameless meal accepted');
  raw.prepare('SELECT count(*) c FROM meals').get().c === 0 &&
  raw.prepare('SELECT count(*) c FROM symptoms').get().c === 0
    ? ok('failed validations wrote nothing')
    : bad('partial writes');
}

console.log('5. reminders end to end: set → list → complete/dismiss, with guards');
{
  const { db, raw } = freshDb();
  const daily = await runAsync('set_reminder', db, {
    title: 'Take magnesium',
    time: '21:00',
    repeat: 'daily',
  });
  raw.prepare('SELECT created_by FROM reminders WHERE id = ?').get(daily.id).created_by === 'ai'
    ? ok('tool-created reminder records created_by = ai')
    : bad('created_by');

  // The result must state what REALLY happened, not what the description hopes:
  // under node there is no expo-notifications module, so a schedulable reminder
  // reports module-unavailable and scheduled=false. That is the honesty contract.
  daily.notification &&
  daily.notification.scheduled === false &&
  daily.notification.reason === 'module-unavailable' &&
  /no phone alert will fire/.test(daily.notification.note)
    ? ok('set_reminder reports the OBSERVED delivery outcome (module-unavailable here)')
    : bad('delivery report', JSON.stringify(daily.notification));

  const listed = run('list_reminders', db);
  listed.reminders.length === 1 &&
  listed.reminders[0].title === 'Take magnesium' &&
  listed.reminders[0].dueToday === true
    ? ok('list_reminders surfaces it, due today (daily)')
    : bad('list', JSON.stringify(listed));

  // The RECURRING RAIL, which used to live in `complete_reminder`'s description
  // and now lives in the reminders DOMAIN — refused at CARD time, one Approve
  // tap earlier than the old tool refused it.
  throws(() => editCard(db, 'reminders', daily.id, { status: 'done' }))
    ? ok('edit_record refuses to complete a daily reminder, at card time')
    : bad('recurring completed');
  // …and the payload that hands out the ids carries the rule in words, because
  // no generic tool description can.
  /recurring reminder is never completed/i.test(listed.note ?? '')
    ? ok('list_reminders states the recurring rule when a recurring reminder exists')
    : bad('missing recurring note', JSON.stringify(listed.note));

  const once = await runAsync('set_reminder', db, { title: 'Book DEXA', repeat: 'once' });
  once.notification &&
  once.notification.scheduled === false &&
  once.notification.reason === 'no-time'
    ? ok('an untimed reminder reports no-time, not a permission excuse')
    : bad('untimed delivery report', JSON.stringify(once.notification));
  once.date === null
    ? ok('an untimed one-off reports date: null (there was no day to pin)')
    : bad('untimed date', JSON.stringify(once.date));

  // A TIMED one-off gets its day pinned as it is saved, and the tool must report
  // the day it ACTUALLY landed on — the model relays that day to the user, and
  // it is the difference between "tomorrow 9am" and a reminder that fires daily
  // forever. Fixed clock: Fri 2026-08-07 22:00 local, so 09:00 has gone by.
  {
    const lateCtx = { now: new Date(2026, 7, 7, 22, 0, 0, 0) };
    const tool = toolByName('set_reminder');
    const rolled = JSON.parse(
      await tool.execute(db, { title: 'Call the clinic', time: '09:00' }, lateCtx)
    );
    rolled.date === '2026-08-08' && rolled.repeat === 'once'
      ? ok('set_reminder at 22:00 for "09:00" reports date 2026-08-08 (tomorrow), truthfully')
      : bad('rolled one-off report', JSON.stringify(rolled));
    raw.prepare('SELECT date FROM reminders WHERE id = ?').get(rolled.id).date === '2026-08-08'
      ? ok('  → and that day is PERSISTED, so no later resync can move it again')
      : bad('rolled one-off not persisted');
    // Pinned in the future ⇒ genuinely schedulable, so the honest blocker under
    // node is the missing native module, not "moment-passed".
    rolled.notification.scheduled === false && rolled.notification.reason === 'module-unavailable'
      ? ok('  → schedulable, so it reports module-unavailable (not moment-passed)')
      : bad('rolled delivery report', JSON.stringify(rolled.notification));

    const sameDay = JSON.parse(
      await tool.execute(db, { title: 'Take magnesium', time: '23:30' }, lateCtx)
    );
    sameDay.date === '2026-08-07'
      ? ok('set_reminder at 22:00 for "23:30" reports date 2026-08-07 (today)')
      : bad('same-day one-off report', JSON.stringify(sameDay));

    // An explicitly back-dated one-off is unschedulable and must say so.
    const backdated = JSON.parse(
      await tool.execute(db, { title: 'Missed dose', time: '09:00', date: '2026-08-01' }, lateCtx)
    );
    backdated.date === '2026-08-01' &&
    backdated.notification.scheduled === false &&
    backdated.notification.reason === 'moment-passed'
      ? ok('an explicitly back-dated one-off keeps its day and reports moment-passed')
      : bad('backdated report', JSON.stringify(backdated));

    // The CONFIRMATION CARD must name that pinned day before the user approves.
    // "Set reminder … at 09:00" approved at 22:00 silently writes a row dated
    // tomorrow, so the summary takes the same turn context execute does and
    // resolves the day off the same clock. Formatted by hand — Hermes has no Intl.
    const summaryWith = (input) => tool.confirmSummary(input, db, lateCtx);
    summaryWith({ title: 'Call the clinic', time: '09:00' }) ===
    'Set reminder "Call the clinic" at 09:00 · tomorrow (Sat 8 Aug)'
      ? ok('confirmSummary names the day when a bare-time one-off pins to TOMORROW')
      : bad('summary tomorrow', summaryWith({ title: 'Call the clinic', time: '09:00' }));
    summaryWith({ title: 'Take magnesium', time: '23:30' }) ===
    'Set reminder "Take magnesium" at 23:30'
      ? ok('  → and stays silent about the day when it pins to today (nothing to warn about)')
      : bad('summary today', summaryWith({ title: 'Take magnesium', time: '23:30' }));
    summaryWith({ title: 'Missed dose', time: '09:00', date: '2026-08-01' }) ===
    'Set reminder "Missed dose" at 09:00 · 2026-08-01 (Sat 1 Aug)'
      ? ok('  → an explicit day is still shown, ISO plus its weekday')
      : bad('summary explicit date', summaryWith({ title: 'Missed dose', date: '2026-08-01' }));
    summaryWith({ title: 'Weigh in', time: '07:30', repeat: 'weekly', date: '2026-08-03' }) ===
    'Set reminder "Weigh in" at 07:30 · weekly · 2026-08-03 (Mon 3 Aug)'
      ? ok('  → a weekly anchor is printed as a day, never as "tomorrow"')
      : bad('summary weekly anchor');
    // An UNTIMED one-off derives no day at all, so its card must be identical
    // whatever the clock says — the day suffix appears only when there is a day.
    const earlyCtx = { now: new Date(2026, 7, 7, 0, 1, 0, 0) };
    summaryWith({ title: 'Book DEXA' }) === 'Set reminder "Book DEXA"' &&
    tool.confirmSummary({ title: 'Book DEXA' }, db, earlyCtx) === 'Set reminder "Book DEXA"'
      ? ok('  → an untimed one-off derives no day, so its card is clock-independent')
      : bad('summary untimed', summaryWith({ title: 'Book DEXA' }));

    // Housekeeping: these three would otherwise pollute the list assertions below.
    for (const r of [rolled, sameDay, backdated]) {
      edit(db, 'reminders', r.id, { status: 'dismissed' });
    }
  }
  const summary = editCard(db, 'reminders', once.id, { status: 'done' });
  summary === 'Mark reminder "Book DEXA" done'
    ? ok(`confirmation names the target, never a bare id ("${summary}")`)
    : bad('confirm summary', summary);
  const completed = edit(db, 'reminders', once.id, { status: 'done' });
  completed.edited === true &&
  run('list_reminders', db).reminders.every((r) => r.title !== 'Book DEXA')
    ? ok('edit_record status:done retires the one-off from the active list')
    : bad('complete');

  const dismissSummary = editCard(db, 'reminders', daily.id, { status: 'dismissed' });
  dismissSummary === 'Dismiss reminder "Take magnesium"'
    ? ok('dismiss confirmation names the target too')
    : bad('dismiss summary', dismissSummary);
  edit(db, 'reminders', daily.id, { status: 'dismissed' });
  const emptied = run('list_reminders', db);
  emptied.reminders.length === 0
    ? ok('edit_record status:dismissed ends the daily one')
    : bad('dismiss');
  emptied.note === undefined
    ? ok('…and with no recurring reminder left, the note costs nothing')
    : bad('note emitted with no recurring reminder', JSON.stringify(emptied.note));

  throws(() => edit(db, 'reminders', 'nope', { status: 'dismissed' }))
    ? ok('unknown reminder id rejected with guidance')
    : bad('unknown id accepted');
  (await rejects(() => runAsync('set_reminder', db, { title: 'Weekly check', repeat: 'weekly' })))
    ? ok('weekly without an anchor date rejected at the tool layer')
    : bad('anchorless weekly accepted');
}

console.log('6. get_metric_series returns display units with honest stats');
{
  const { db } = freshDb();
  run('log_metric', db, { metric: 'weight', value: 178 });
  run('log_metric', db, { metric: 'weight', value: 180 });
  const series = run('get_metric_series', db, { metric: 'weight', days: 7 });
  series.unit === 'lb' && series.points.length === 1 && near(series.points[0].value, 179, 0.2)
    ? ok('two same-day weigh-ins average to one daily point, in lb')
    : bad('series', JSON.stringify(series));
  series.stats && series.stats.count === 1
    ? ok('stats ride along')
    : bad('stats', JSON.stringify(series.stats));

  const empty = run('get_metric_series', db, { metric: 'hrv' });
  empty.points.length === 0 && empty.stats === null
    ? ok('an unlogged metric returns empty points + null stats (nothing invented)')
    : bad('empty series', JSON.stringify(empty));

  throws(() => run('get_metric_series', db, { metric: 'weight', days: 0 }))
    ? ok('days: 0 rejected')
    : bad('days 0 accepted');
}

console.log('7. get_nutrition_summary + get_training_summary aggregate honestly');
{
  const { db } = freshDb();
  run('log_meal', db, { name: 'A', kcal: 600, protein_g: 40 });
  run('log_meal', db, { name: 'B', kcal: 800, protein_g: 50 });
  const nutrition = run('get_nutrition_summary', db, { days: 7 });
  nutrition.loggedDays === 1 &&
  near(nutrition.averagesAcrossLoggedDays.kcal, 1400) &&
  near(nutrition.averagesAcrossLoggedDays.protein_g, 90)
    ? ok('nutrition day totals + averages across logged days')
    : bad('nutrition', JSON.stringify(nutrition));

  run('log_workout', db, { name: 'Zone 2', kind: 'cardio', duration_min: 45 });
  run('log_workout', db, { name: 'Upper', kind: 'strength', duration_min: 50 });
  const training = run('get_training_summary', db, { days: 28 });
  training.totals.sessions === 2 &&
  near(training.totals.cardioMinutes, 45) &&
  training.totals.strengthSessions === 1 &&
  training.recentSessions.length === 2
    ? ok('training totals, split by kind, with recent sessions')
    : bad('training', JSON.stringify(training));
}

console.log('8. get_biomarkers: honest when empty, real when a result exists');
{
  const { db, raw } = freshDb();
  const empty = run('get_biomarkers', db);
  empty.resultsAvailable === 0 && typeof empty.note === 'string'
    ? ok('no lab results → says so instead of inventing values')
    : bad('empty biomarkers', JSON.stringify(empty));

  raw
    .prepare(
      `INSERT INTO biomarkers (id, slug, name, category, unit, optimal_range_low, optimal_range_high)
       VALUES ('b1', 'apob', 'ApoB', 'cardiovascular', 'mg/dL', 20, 60)`
    )
    .run();
  raw
    .prepare(
      `INSERT INTO lab_results (id, biomarker_id, value, collected_at, source)
       VALUES ('r1', 'b1', 78, '2026-06-01', 'manual')`
    )
    .run();
  const withData = run('get_biomarkers', db, { category: 'cardiovascular' });
  withData.resultsAvailable === 1 &&
  withData.results[0].slug === 'apob' &&
  withData.results[0].value === 78 &&
  withData.results[0].optimal_range_high === 60
    ? ok('latest value + optimal range returned for the filter')
    : bad('biomarkers', JSON.stringify(withData));
}

console.log('9. get_insights wraps the deterministic engine');
{
  const { db } = freshDb();
  const out = run('get_insights', db);
  Array.isArray(out.insights) && typeof out.briefLine === 'string'
    ? ok('insights array + brief line, no model involved')
    : bad('insights', JSON.stringify(out));
}

console.log('10. backdating: an explicit date lands on that day and shows in the summary');
{
  const { db, raw } = freshDb();
  run('log_meal', db, { name: 'Late dinner', kcal: 800, date: '2026-07-20' });
  raw.prepare('SELECT date FROM meals').get().date === '2026-07-20'
    ? ok('log_meal date param writes the stated day, not today')
    : bad('backdated meal');
  const summary = toolByName('log_meal').confirmSummary(
    { name: 'Late dinner', kcal: 800, date: '2026-07-20' },
    db
  );
  summary.includes('· 2026-07-20') && summary.includes('800 kcal')
    ? ok(`confirmation shows the backdate and the macros ("${summary}")`)
    : bad('backdate summary', summary);
  throws(() => run('log_meal', db, { name: 'Bad', date: '2026-13-45' }))
    ? ok('an impossible calendar date is rejected before the DB')
    : bad('2026-13-45 accepted');
  run('log_workout', db, { name: 'Zone 2', kind: 'cardio', duration_min: 40, date: '2026-07-19' });
  raw.prepare('SELECT date FROM workouts').get().date === '2026-07-19'
    ? ok('log_workout backdates too')
    : bad('backdated workout');
}

console.log('11. set weights arrive in display lb and store canonical kg');
{
  const { db, raw } = freshDb();
  run('log_workout', db, {
    name: 'Upper A',
    kind: 'strength',
    sets: [
      { exercise: 'Bench', reps: 8, weight: 225 },
      { exercise: 'Press', reps: 5, weight: 60, unit: 'kg' },
    ],
  });
  const sets = raw.prepare('SELECT exercise, weight_kg FROM workout_sets ORDER BY set_index').all();
  near(sets[0]?.weight_kg, 225 / 2.2046226218, 1e-6)
    ? ok('225 (lb, the default) stored as ~102.06 kg canonical')
    : bad('lb set', JSON.stringify(sets));
  near(sets[1]?.weight_kg, 60, 1e-9)
    ? ok('unit "kg" passes through unconverted')
    : bad('kg set', JSON.stringify(sets));
  const summary = toolByName('log_workout').confirmSummary(
    { name: 'Upper A', kind: 'strength', sets: [{ exercise: 'Bench', reps: 8, weight: 225 }] },
    db
  );
  summary.includes('Bench 8 × 225 lb')
    ? ok(`confirmation shows the sets in display units ("${summary}")`)
    : bad('set summary', summary);
}

console.log('12. sub-week training windows refuse to extrapolate a weekly rate');
{
  const { db } = freshDb();
  run('log_workout', db, { name: 'Zone 2', kind: 'cardio', duration_min: 60 });
  const training = run('get_training_summary', db, { days: 1 });
  training.weeklyRates === null && near(training.totals.minutes, 60)
    ? ok('days: 1 reports totals but a null weeklyRates (no 420 min/week fiction)')
    : bad('weekly extrapolation', JSON.stringify(training));
}

console.log('13. protocols: get_protocols reads live content; update_protocol versions like code');
{
  const { db, raw } = freshDb();
  // Seed an "evening stack" as a LEGACY v1 document, written the way every
  // version already on the owner's device was. Reading it back through the
  // schema-2 tools is the point: those rows are immutable and must keep
  // working forever.
  const protocolId = createProtocolWithVersion(
    db,
    { name: 'Evening Stack', type: 'supplement_stack' },
    {
      items: [
        { title: 'Magnesium Glycinate', scheduled_time: '21:00', dose: '200 mg', notes: null },
        { title: 'Vitamin D3', scheduled_time: '21:00', dose: '5000 IU', notes: null },
      ],
    },
    'seed'
  );
  const slug = raw.prepare('SELECT slug FROM protocols WHERE id = ?').get(protocolId).slug;

  const view = run('get_protocols', db);
  const stack = view.protocols.find((p) => p.slug === slug);
  const liveItems = stack?.phases?.[0]?.items ?? [];
  stack &&
  stack.name === 'Evening Stack' &&
  stack.versionNumber === 1 &&
  stack.phases.length === 1 &&
  liveItems.length === 2 &&
  liveItems[0].title === 'Magnesium Glycinate' &&
  liveItems[0].dose === '200 mg' &&
  liveItems[0].cadence === 'daily'
    ? ok('get_protocols reads a v1 document as one phase of daily items')
    : bad('get_protocols', JSON.stringify(view));

  // The magnesium scenario: read the current content, resubmit the COMPLETE
  // set plus the change. The confirmation shows the count delta so a wipe is
  // visible, and says which day it lands on.
  const changeInput = {
    protocol_slug: slug,
    phases: [
      {
        items: [
          { title: 'Magnesium Glycinate', scheduled_time: '21:00', dose: '400 mg' },
          { title: 'Vitamin D3', scheduled_time: '21:00', dose: '5000 IU' },
          { title: 'Zinc', scheduled_time: '21:00', dose: '15 mg', cadence: 'mon,wed,fri' },
        ],
      },
    ],
    change_notes: 'Bumped magnesium to 400 mg, added zinc',
  };
  const summary = toolByName('update_protocol').confirmSummary(changeInput, db, CTX);
  summary ===
  'Update "Evening Stack": 3 items (was 2) — Bumped magnesium to 400 mg, added zinc · applies to today\'s plan now'
    ? ok(`confirmation shows the item-count delta and the effective day ("${summary}")`)
    : bad('update summary', summary);

  const out = run('update_protocol', db, changeInput);
  out.updated === true &&
  out.versionNumber === 2 &&
  out.itemCount === 3 &&
  out.protocol === slug &&
  out.effective === 'today'
    ? ok('update_protocol writes version 2 with 3 items, effective today')
    : bad('update result', JSON.stringify(out));

  const versionCount = raw
    .prepare('SELECT count(*) c FROM protocol_versions WHERE protocol_id = ?')
    .get(protocolId).c;
  const current = raw
    .prepare(
      `SELECT v.version_number, v.created_by,
              json_extract(v.content, '$.schema') schema,
              json_array_length(v.content, '$.phases[0].items') n
       FROM protocols p JOIN protocol_versions v ON v.id = p.current_version_id WHERE p.id = ?`
    )
    .get(protocolId);
  versionCount === 2 &&
  current.version_number === 2 &&
  current.created_by === 'ai' &&
  current.schema === 2 &&
  current.n === 3
    ? ok('v1 preserved; current_version_id points at the ai-authored schema-2 v2 (3 items)')
    : bad('versioning', JSON.stringify({ versionCount, current }));

  const after = run('get_protocols', db).protocols.find((p) => p.slug === slug);
  const afterItems = after.phases[0].items;
  after.versionNumber === 2 &&
  afterItems.some((it) => it.title === 'Zinc') &&
  afterItems.find((it) => it.title === 'Magnesium Glycinate').dose === '400 mg' &&
  afterItems.find((it) => it.title === 'Zinc').cadence === 'Mon,Wed,Fri'
    ? ok('get_protocols now reads v2, cadence in the vocabulary it accepts back')
    : bad('post-update read', JSON.stringify(after));

  // An item the model RE-SENT unchanged keeps its identity, which is what a
  // quota counts on and what the version diff matches by. Minting a fresh id
  // for every re-sent item would silently reset both.
  const v2FirstId = raw
    .prepare(
      `SELECT json_extract(v.content, '$.phases[0].items[0].id') id
         FROM protocol_versions v WHERE v.protocol_id = ? AND v.version_number = 2`
    )
    .get(protocolId).id;
  v2FirstId.startsWith('v1-0-')
    ? ok("a re-sent item inherits the v1 document's derived id, so its history is continuous")
    : bad('item identity not inherited', v2FirstId);

  throws(() =>
    run('update_protocol', db, {
      protocol_slug: 'no_such_stack',
      phases: [{ items: [{ title: 'X' }] }],
      change_notes: 'y',
    })
  )
    ? ok('unknown slug rejected with guidance (call get_protocols first)')
    : bad('unknown slug accepted');
  throws(() =>
    run('update_protocol', db, {
      protocol_slug: slug,
      phases: [{ items: [{ dose: '5 g' }] }],
      change_notes: 'z',
    })
  )
    ? ok('an item without a title is rejected before any write')
    : bad('titleless item accepted');
  throws(() =>
    run('update_protocol', db, {
      protocol_slug: slug,
      phases: [{ items: [{ title: 'A' }] }, { items: [{ title: 'B' }] }],
      change_notes: 'unreachable second phase',
    })
  )
    ? ok('an open-ended phase followed by another is refused — nothing after it could start')
    : bad('unreachable phase accepted');
}

console.log('13b. the Coach can SEE a why-line, so an edit no longer erases every one');
{
  const { db, raw } = freshDb();
  const item = (id, title, notes) => ({
    id,
    title,
    scheduled_time: '07:00',
    dose: '5 g',
    notes,
    cadence: { kind: 'daily' },
    remind: false,
  });
  const withNotes = createProtocolWithVersion(
    db,
    {
      name: 'Morning Stack',
      type: 'supplement_stack',
      startedOn: '2026-08-03',
      carryOver: true,
      checkoffMode: 'adjusting',
    },
    {
      schema: 2,
      phases: [
        {
          id: 'phase-0',
          title: null,
          duration_days: null,
          items: [
            item('i1', 'Creatine', 'Loading is done — this is the maintenance dose.'),
            item('i2', 'Vitamin D3', null),
          ],
        },
      ],
    }
  );
  const plain = createProtocolWithVersion(
    db,
    { name: 'Evening Stack', type: 'supplement_stack' },
    {
      schema: 2,
      phases: [{ id: 'p', title: null, duration_days: null, items: [item('j1', 'Zinc', null)] }],
    }
  );
  const slugOf = (id) => raw.prepare('SELECT slug FROM protocols WHERE id = ?').get(id).slug;
  const slug = slugOf(withNotes);

  const read = () => run('get_protocols', db).protocols;
  const seen = read().find((p) => p.slug === slug);
  const seenItems = seen.phases[0].items;
  seenItems[0].notes === 'Loading is done — this is the maintenance dose.' &&
  !('notes' in seenItems[1])
    ? ok('get_protocols emits a why-line, and omits it rather than nulling it when empty')
    : bad('notes emission', JSON.stringify(seenItems));
  seen.carryOver === true && seen.checkoffMode === 'adjusting' && seen.startedOn === '2026-08-03'
    ? ok('…and the three policy facts a plan means nothing without')
    : bad('policy emission', JSON.stringify(seen));
  const defaults = read().find((p) => p.slug === slugOf(plain));
  !('carryOver' in defaults) && !('checkoffMode' in defaults) && !('startedOn' in defaults)
    ? ok('a protocol running the defaults carries no "no"')
    : bad('defaults emitted', JSON.stringify(defaults));

  // THE DEFECT, as it used to behave: an edit that re-sends every item without
  // the field it could not see. Now the model re-sends the note like a dose.
  const resend = {
    protocol_slug: slug,
    phases: [
      {
        items: [
          {
            title: 'Creatine',
            scheduled_time: '07:00',
            dose: '10 g',
            notes: 'Loading is done — this is the maintenance dose.',
            cadence: 'daily',
          },
          { title: 'Vitamin D3', scheduled_time: '07:00', dose: '5 g', cadence: 'daily' },
        ],
      },
    ],
    change_notes: 'Creatine to 10 g',
  };
  toolByName('update_protocol').confirmSummary(resend, db, CTX).includes('why-line') === false
    ? ok('a call that re-sends a note unchanged says nothing about why-lines on the card')
    : bad(
        'spurious why-line phrase',
        toolByName('update_protocol').confirmSummary(resend, db, CTX)
      );
  run('update_protocol', db, resend);
  read().find((p) => p.slug === slug).phases[0].items[0].notes ===
  'Loading is done — this is the maintenance dose.'
    ? ok('a re-sent why-line survives the version')
    : bad('note lost on re-send', JSON.stringify(read().find((p) => p.slug === slug)));

  // Rewording one item's note names THAT item, and touches no other.
  const reword = {
    protocol_slug: slug,
    phases: [
      {
        items: [
          {
            title: 'Creatine',
            scheduled_time: '07:00',
            dose: '10 g',
            notes: 'Ten grams while the saturation window runs.',
            cadence: 'daily',
          },
          { title: 'Vitamin D3', scheduled_time: '07:00', dose: '5 g', cadence: 'daily' },
        ],
      },
    ],
    change_notes: 'Reworded',
  };
  const rewordCard = toolByName('update_protocol').confirmSummary(reword, db, CTX);
  rewordCard.includes('why-line rewritten on "Creatine"')
    ? ok(`the card names the item whose why-line changed ("${rewordCard}")`)
    : bad('reword not named', rewordCard);
  run('update_protocol', db, reword);
  const afterReword = read().find((p) => p.slug === slug).phases[0].items;
  afterReword[0].notes === 'Ten grams while the saturation window runs.' &&
  !('notes' in afterReword[1])
    ? ok('…and only that item — the untouched one is still without a note')
    : bad('reword spread', JSON.stringify(afterReword));

  // Clearing IS omitting — the complete-set rule — so the card has to say so.
  const clear = {
    protocol_slug: slug,
    phases: [
      {
        items: [
          { title: 'Creatine', scheduled_time: '07:00', dose: '10 g', cadence: 'daily' },
          { title: 'Vitamin D3', scheduled_time: '07:00', dose: '5 g', cadence: 'daily' },
        ],
      },
    ],
    change_notes: 'Dropped the rationale',
  };
  const clearCard = toolByName('update_protocol').confirmSummary(clear, db, CTX);
  clearCard.includes('why-line cleared on "Creatine"')
    ? ok(`an omitted why-line reads as CLEARED on the card ("${clearCard}")`)
    : bad('clear not named', clearCard);
  run('update_protocol', db, clear);
  !('notes' in read().find((p) => p.slug === slug).phases[0].items[0])
    ? ok('…and it is genuinely gone, because omitting is how the Coach clears one')
    : bad('clear did not clear');
}

console.log(
  '13c. update_protocol learns to CREATE — the hub said the Coach could and it could not'
);
{
  const { db, raw } = freshDb();
  const call = {
    name: 'Evening wind-down',
    type: 'daily_routine',
    phases: [
      {
        items: [
          { title: 'Magnesium', scheduled_time: '21:00', dose: '400 mg', cadence: 'daily' },
          { title: 'Lights down', scheduled_time: '21:30', cadence: 'daily' },
        ],
      },
    ],
    change_notes: 'Drafted with you',
  };

  const card = toolByName('update_protocol').confirmSummary(call, db, CTX);
  card === 'Create "Evening wind-down": 2 items · starts on today\'s plan'
    ? ok(`the card says CREATE, and how many items ("${card}")`)
    : bad('create card', card);

  const out = run('update_protocol', db, call);
  out.created === true &&
  out.versionNumber === 1 &&
  out.itemCount === 2 &&
  out.effective === 'today'
    ? ok('a call with name and type and NO slug creates the protocol and its v1')
    : bad('create result', JSON.stringify(out));
  const row = raw.prepare('SELECT * FROM protocols WHERE slug = ?').get(out.protocol);
  row &&
  row.name === 'Evening wind-down' &&
  row.type === 'daily_routine' &&
  row.is_active === 1 &&
  row.current_version_id !== null
    ? ok('…with a repository-minted slug, active, pointing at v1')
    : bad('created row', JSON.stringify(row));
  raw.prepare('SELECT created_by FROM protocol_versions WHERE protocol_id = ?').get(row.id)
    .created_by === 'ai'
    ? ok('…and the version is stamped as the Coach’s')
    : bad('authorship not ai');
  // It reaches TODAY like every other protocol write: a protocol the user just
  // approved that put nothing on the day would read as a broken promise.
  out.missionAdded >= 2
    ? ok('…and it lands on today’s mission straight away')
    : bad('create did not reach today', JSON.stringify(out));

  // A SLUG is always an update, never a create. This is what stops a typo
  // silently minting a second protocol beside the one the user meant.
  throws(() =>
    run('update_protocol', db, {
      protocol_slug: 'evening_winddown', // one character out
      name: 'Evening wind-down',
      type: 'daily_routine',
      phases: [{ items: [{ title: 'X' }] }],
      change_notes: 'typo',
    })
  )
    ? ok('a typo in a slug still errors — creation needs the slug ABSENT')
    : bad('a slug typo created a protocol');
  raw.prepare('SELECT count(*) c FROM protocols').get().c === 1
    ? ok('…and nothing was written')
    : bad('a second protocol appeared');

  // The seven-value enum costs 52 tokens of schema; a bare string plus an error
  // that NAMES the set costs 9, and the model recovers either way.
  let typeError = '';
  try {
    run('update_protocol', db, {
      name: 'Bad type',
      type: 'supplements',
      phases: [{ items: [{ title: 'X' }] }],
      change_notes: 'y',
    });
  } catch (e) {
    typeError = e instanceof Error ? e.message : String(e);
  }
  typeError.includes('supplement_stack') &&
  typeError.includes('daily_routine') &&
  typeError.includes('other')
    ? ok('an unknown type errors NAMING the seven values')
    : bad('type error does not name the set', typeError);

  // Neither a slug nor a name: the message says both ways in.
  let missing = '';
  try {
    run('update_protocol', db, { phases: [{ items: [{ title: 'X' }] }], change_notes: 'y' });
  } catch (e) {
    missing = e instanceof Error ? e.message : String(e);
  }
  missing.includes('protocol_slug') && missing.includes('name')
    ? ok('a call naming neither says how to do both')
    : bad('ambiguous call message', missing);
}

console.log('14. unit preferences drive the Coach write + read path (a metric user)');
{
  const { db, raw } = freshDb();
  setUnitPreference(db, 'weight', 'kg');
  setUnitPreference(db, 'length', 'cm');
  setUnitPreference(db, 'volume', 'ml');

  // The bug this fixes: an unqualified "80" from a kg user must store 80 kg, not
  // 36 kg (the old imperial default). An explicit unit token still overrides.
  run('log_metric', db, { metric: 'weight', value: 80 });
  run('log_metric', db, { metric: 'weight', value: 80, unit: 'lb' });
  const weights = raw
    .prepare('SELECT weight_kg FROM body_metrics WHERE weight_kg IS NOT NULL ORDER BY rowid')
    .all();
  near(weights[0]?.weight_kg, 80, 1e-6)
    ? ok('kg-preference: unqualified weight 80 stores 80 kg, not 36')
    : bad('kg weight write', JSON.stringify(weights));
  near(weights[1]?.weight_kg, 80 / 2.2046226218, 1e-6)
    ? ok('an explicit "lb" token overrides the kg preference (80 lb → 36.3 kg)')
    : bad('lb override', JSON.stringify(weights));

  // The confirmation card must show the user's unit, so an approve isn't blind.
  const summary = toolByName('log_metric').confirmSummary({ metric: 'weight', value: 80 }, db);
  summary === 'Log weight 80 kg'
    ? ok(`confirmation card shows the user's unit ("${summary}")`)
    : bad('kg summary', summary);

  // An explicit-unit override still renders the card in the user's OWN unit
  // (kg here), so the shown value matches the app everywhere — intentional.
  const lbCard = toolByName('log_metric').confirmSummary(
    { metric: 'weight', value: 180, unit: 'lb' },
    db
  );
  lbCard === 'Log weight 81.6 kg'
    ? ok(`explicit "lb" from a kg user still shows the card in kg ("${lbCard}")`)
    : bad('lb-override card', lbCard);

  run('log_metric', db, { metric: 'waist', value: 90 });
  const waist = raw.prepare('SELECT waist_cm FROM body_metrics WHERE waist_cm IS NOT NULL').get();
  near(waist?.waist_cm, 90, 1e-6)
    ? ok('cm-preference: waist 90 stores 90 cm, not 228.6')
    : bad('cm waist', JSON.stringify(waist));

  run('log_metric', db, { metric: 'water', value: 500 });
  const water = raw.prepare(`SELECT value FROM wearable_data WHERE metric_type = 'water_ml'`).get();
  near(water?.value, 500, 1e-6)
    ? ok('ml-preference: water 500 stores 500 ml, not 14786')
    : bad('ml water', JSON.stringify(water));

  const series = run('get_metric_series', db, { metric: 'weight', days: 7 });
  series.unit === 'kg'
    ? ok('get_metric_series reports the series in kg for a kg user')
    : bad('series unit', JSON.stringify(series));

  // log_workout: an unqualified set weight follows the weight preference too.
  run('log_workout', db, {
    name: 'Squat',
    kind: 'strength',
    sets: [{ exercise: 'Squat', reps: 5, weight: 100 }],
  });
  const set = raw.prepare('SELECT weight_kg FROM workout_sets').get();
  near(set?.weight_kg, 100, 1e-6)
    ? ok('kg-preference: an unqualified set weight 100 stores 100 kg (not 45)')
    : bad('kg set', JSON.stringify(set));
  const wSummary = toolByName('log_workout').confirmSummary(
    { name: 'Squat', kind: 'strength', sets: [{ exercise: 'Squat', reps: 5, weight: 100 }] },
    db
  );
  wSummary.includes('100 kg')
    ? ok(`workout card renders the set in kg ("${wSummary}")`)
    : bad('kg set summary', wSummary);
}

console.log('15. get_training_summary.thisWeek is the calendar week (agrees with the Data tab)');
{
  const { db } = freshDb();
  // A fixed Monday so the calendar week and the rolling-7 window barely overlap —
  // the worst-case where the two definitions of "this week" disagree.
  const monday = new Date(2026, 6, 27); // Mon 2026-07-27 (local)
  const ctx = { now: monday };
  const sunday = isoDaysAgo(monday, 1); // 2026-07-26 — LAST calendar week, but in rolling-7
  const todayIso = todayISODate(monday); // 2026-07-27 — this calendar week

  const trainTool = toolByName('log_workout');
  trainTool.execute(db, { name: 'Sun ride', kind: 'cardio', duration_min: 30, date: sunday }, ctx);
  trainTool.execute(
    db,
    { name: 'Mon ride', kind: 'cardio', duration_min: 45, date: todayIso },
    ctx
  );

  const summary = JSON.parse(toolByName('get_training_summary').execute(db, { days: 7 }, ctx));
  const week = weekSummary(db, monday); // exactly what the Data tab renders as "this week"

  // thisWeek is the SAME number the Data tab shows (both call weekSummary): today only.
  summary.thisWeek.cardioMinutes === week.zone2Min && summary.thisWeek.cardioMinutes === 45
    ? ok('thisWeek = Monday-start calendar week (45 min today), identical to weekSummary')
    : bad('thisWeek vs weekSummary', JSON.stringify({ tw: summary.thisWeek, week }));

  // The rolling last-7-days totals DO include Sunday's session; thisWeek must not —
  // this is the divergence the fix pins down so the Coach never calls 75 "this week".
  near(summary.totals.cardioMinutes, 75) && summary.thisWeek.cardioMinutes === 45
    ? ok('rolling 7-day totals include the Sunday session (75); thisWeek excludes it (45)')
    : bad('rolling vs calendar', JSON.stringify(summary));
}

console.log('16. the REAL call site: one turn clock from confirmation card to written row');
{
  // Section 5 exercises `confirmSummary` by handing it a context directly — a
  // path the app never takes. The defect being covered here lived in the CALL
  // SITE: src/lib/ai/coach-service.ts is the only place a confirmation card is
  // rendered repo-wide, and it built the card off one `new Date()` and the row
  // off a second, later one, read AFTER awaiting the user's approval. So this
  // section drives coach-service itself, model stream and all, with the clock
  // injected and MOVED while the user "thinks".
  //
  // Loading that module under node needs three resolutions Metro/tsc do and raw
  // node ESM does not: `expo/fetch` (no node-resolvable entry point) and
  // `@/lib/db/client` (pulls in native op-sqlite) are stubbed to test doubles,
  // and `./tools` needs directory-index resolution. Nothing else is faked —
  // the agentic loop, the tool registry, the repositories and the SQLite writes
  // are the real ones.
  const { register } = await import('node:module');
  const LOADER_HOOK = `
const stub = (source) => ({
  url: 'data:text/javascript,' + encodeURIComponent(source),
  shortCircuit: true,
});
const STUBS = new Map([
  ['expo/fetch', stub('export const fetch = (...args) => globalThis.__ARC_TEST_FETCH__(...args);')],
  ['@/lib/db/client', stub('export const getDb = () => globalThis.__ARC_TEST_DB__;')],
]);
export async function resolve(specifier, context, next) {
  const hit = STUBS.get(specifier);
  if (hit) return hit;
  try {
    return await next(specifier, context);
  } catch (error) {
    if (specifier.startsWith('.')) return next(specifier + '/index.ts', context);
    throw error;
  }
}
`;
  register('data:text/javascript,' + encodeURIComponent(LOADER_HOOK), import.meta.url);
  const { streamCoachReply } = await import('../src/lib/ai/coach-service.ts');

  // --- A scripted Messages API stream (the wire shape model-client parses) ---
  const sse = (events) =>
    events.map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join('');

  const toolUseReply = (name, input) =>
    sse([
      { type: 'message_start', message: {} },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_clock', name, input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ]);

  const textReply = (text) =>
    sse([
      { type: 'message_start', message: {} },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ]);

  const responseOf = (body) => {
    const bytes = new TextEncoder().encode(body);
    let sent = false;
    return {
      ok: true,
      status: 200,
      text: async () => body,
      body: {
        getReader: () => ({
          read: async () =>
            sent ? { done: true } : ((sent = true), { done: false, value: bytes }),
        }),
      },
    };
  };

  /**
   * One complete turn: the model calls set_reminder, the confirmation card is
   * rendered at `startAt`, the user deliberates (the injected clock jumps to
   * `approveAt`), then approves. Returns the card line, the row that landed,
   * and how many clock reads happened before vs. after the approval.
   */
  async function runTurn({ input, startAt, approveAt }) {
    const { db, raw } = freshDb();
    globalThis.__ARC_TEST_DB__ = db;
    const replies = [toolUseReply('set_reminder', input), textReply('Done.')];
    globalThis.__ARC_TEST_FETCH__ = async () => responseOf(replies.shift());

    let instant = startAt;
    let reads = 0;
    let readsAtCard = -1;
    let card = null;

    const result = await streamCoachReply(
      [{ id: 'u1', role: 'user', content: 'remind me', createdAt: 0 }],
      {
        onToken: () => {},
        now: () => {
          reads++;
          return instant;
        },
        confirmWrite: async (request) => {
          card = request.summary;
          readsAtCard = reads;
          instant = approveAt; // approval latency — the wall clock really moved
          return true;
        },
      }
    );

    return {
      card,
      row: raw.prepare('SELECT title, date FROM reminders').get(),
      toolResult: JSON.parse(result.toolCalls[0].result),
      reads,
      readsAtCard,
    };
  }

  await apiKeyStore.setKey('test-key'); // a key set ⇒ the REAL path, not the mock

  // The exact scenario the defect describes: the card is rendered 30 seconds
  // before 09:00 (so "09:00" is still ahead — today), and approval lands 40
  // seconds later, past 09:00. Two clock reads would card "today" and write
  // "tomorrow"; one read cannot.
  const straddle = await runTurn({
    input: { title: 'Take creatine', time: '09:00' },
    startAt: new Date(2026, 7, 7, 8, 59, 30),
    approveAt: new Date(2026, 7, 7, 9, 0, 10),
  });
  straddle.card === 'Set reminder "Take creatine" at 09:00'
    ? ok('card rendered at 08:59:30 for "09:00" names no day — it lands today')
    : bad('straddle card', straddle.card);
  straddle.row.date === '2026-08-07' && straddle.toolResult.date === '2026-08-07'
    ? ok('  → approved at 09:00:10, the row is STILL dated today, exactly as the card said')
    : bad('straddle row', JSON.stringify({ row: straddle.row, result: straddle.toolResult }));
  straddle.reads === straddle.readsAtCard
    ? ok('  → and execute read no clock of its own (one instant, card to row)')
    : bad('clock re-read after approval', `${straddle.readsAtCard} → ${straddle.reads}`);

  // Non-triviality: start the same turn AFTER 09:00 and both halves must move
  // together to tomorrow. A card hardcoded to "today" would pass the test above
  // and fail this one.
  const rolled = await runTurn({
    input: { title: 'Take creatine', time: '09:00' },
    startAt: new Date(2026, 7, 7, 9, 0, 10),
    approveAt: new Date(2026, 7, 7, 9, 0, 20),
  });
  rolled.card === 'Set reminder "Take creatine" at 09:00 · tomorrow (Sat 8 Aug)' &&
  rolled.row.date === '2026-08-08' &&
  rolled.toolResult.date === '2026-08-08'
    ? ok('the same turn started 40s later cards AND writes tomorrow — the day is truly derived')
    : bad('rolled turn', JSON.stringify({ card: rolled.card, row: rolled.row }));

  await apiKeyStore.clearKey();
}

// The owner's report: "asked the Coach for my step count and it did not know."
// The cause was structural — the readable metric set was the MANUAL-LOG registry
// (weight/body_fat/waist/hrv/rhr/water), so the entire HealthKit plane (steps,
// sleep, energy, SpO2, temperatures, VO2max, workouts) was unreachable by any
// tool. These cases pin the fix: discovery from the data, not a hardcoded enum.
console.log('17. wearables: every ingested metric_type is readable by the Coach');
{
  const { db } = freshDb();
  const day = (n) => isoDaysAgo(NOW, n);
  const wear = (rows) =>
    upsertWearableRows(
      db,
      rows.map((r) => ({
        date: r.date,
        metricType: r.metric,
        value: r.value,
        unit: r.unit ?? null,
        sourceDevice: r.device ?? 'apple_watch',
        sourceRawId: `hk:${r.metric}:${r.date}`,
        startTime: null,
        endTime: null,
        metadata: {},
      }))
    );

  const rows = [];
  for (let i = 0; i < 10; i++) {
    rows.push({ date: day(i), metric: 'hrv', value: 50 + i, unit: 'ms' });
    rows.push({ date: day(i), metric: 'rhr', value: 55, unit: 'bpm' });
    rows.push({
      date: day(i),
      metric: 'steps',
      value: 8000 + i * 100,
      unit: 'count',
      device: 'apple_health',
    });
    rows.push({ date: day(i), metric: 'sleep_duration_min', value: 431, unit: 'min' });
    rows.push({
      date: day(i),
      metric: 'active_energy_kcal',
      value: 620,
      unit: 'kcal',
      device: 'apple_health',
    });
  }
  rows.push({ date: day(0), metric: 'sleep_deep_min', value: 74, unit: 'min' });
  rows.push({ date: day(0), metric: 'vo2max', value: 48.2, unit: 'ml_kg_min' });
  rows.push({ date: day(0), metric: 'spo2_pct', value: 97.5, unit: 'pct' });
  rows.push({ date: day(0), metric: 'wrist_temp_c', value: 35.2, unit: 'c' });
  rows.push({ date: day(0), metric: 'respiratory_rate', value: 14.5, unit: 'brpm' });
  rows.push({ date: day(0), metric: 'resting_energy_kcal', value: 1720, unit: 'kcal' });
  // A metric NOTHING in the codebase declares — the "new vendor metric tomorrow"
  // case that a hardcoded enum would silently swallow.
  rows.push({ date: day(0), metric: 'glucose_mgdl', value: 92, unit: 'mgdl' });
  // Recorded, but long outside a short window: absence-in-window ≠ never.
  rows.push({ date: day(40), metric: 'water_ml', value: 500, unit: 'ml', device: 'manual' });
  wear(rows);

  // --- (a) each metric round-trips through get_metric_series ----------------
  const expectations = [
    ['steps', 'count', 8000],
    ['sleep_duration_min', 'min', 431],
    ['active_energy_kcal', 'kcal', 620],
    ['resting_energy_kcal', 'kcal', 1720],
    ['hrv', 'ms', 50],
    ['rhr', 'bpm', 55],
    ['vo2max', 'ml_kg_min', 48.2],
    ['spo2_pct', 'pct', 97.5],
    ['respiratory_rate', 'brpm', 14.5],
    ['sleep_deep_min', 'min', 74],
  ];
  const misses = expectations.filter(([metric, unit, todayValue]) => {
    const out = run('get_metric_series', db, { metric, days: 10 });
    const point = out.points.find((p) => p.date === TODAY);
    return !(out.hasData === true && out.unit === unit && point && near(point.value, todayValue));
  });
  misses.length === 0
    ? ok(
        `all ${expectations.length} HealthKit metric_types round-trip (steps, sleep, energy, SpO2, VO2max…)`
      )
    : bad('unreachable metrics', misses.map((m) => m[0]).join(', '));

  const steps = run('get_metric_series', db, { metric: 'steps', days: 10 });
  // Ten days of points, but only the NINE complete ones are averaged: today is
  // a running total and rides in `todaySoFar` instead (pinned in section 21).
  steps.points.length === 10 &&
  steps.stats.count === 9 &&
  steps.statsExcludesToday === true &&
  near(steps.todaySoFar.value, 8000)
    ? ok('steps returns a real 10-day history with stats — the exact question that failed')
    : bad('steps series', JSON.stringify(steps).slice(0, 200));

  // --- (c) sleep reads as hours/minutes, never a raw minute count ------------
  const sleep = run('get_metric_series', db, { metric: 'sleep' });
  sleep.metric === 'sleep_duration_min' &&
  sleep.points.every((p) => p.hm === '7h 11m') &&
  sleep.stats.avgHm === '7h 11m'
    ? ok('alias "sleep" resolves, and every point carries hm ("7h 11m"), not bare minutes')
    : bad('sleep hm', JSON.stringify(sleep).slice(0, 240));

  // --- (a) a metric NOBODY declared is still readable ------------------------
  const glucose = run('get_metric_series', db, { metric: 'glucose_mgdl' });
  glucose.hasData === true &&
  near(glucose.points[0].value, 92) &&
  glucose.unit === 'mgdl' &&
  glucose.inferred === true
    ? ok('an undeclared metric_type is discovered from the data and read, flagged inferred')
    : bad('discovery', JSON.stringify(glucose).slice(0, 240));

  // --- (c) absence is "no data", never 0 ------------------------------------
  const absent = run('get_metric_series', db, { metric: 'body_temp_c' });
  absent.hasData === false &&
  absent.stats === null &&
  absent.points.length === 0 &&
  absent.lastRecorded === null &&
  /not a zero/.test(absent.note)
    ? ok('a never-recorded metric reports hasData:false + "not a zero", never 0')
    : bad('absent metric', JSON.stringify(absent));

  const stale = run('get_metric_series', db, { metric: 'water', days: 7 });
  stale.hasData === false && stale.lastRecorded === day(40) && /most recent value/.test(stale.note)
    ? ok('recorded-but-outside-the-window says so, and names the last day on record')
    : bad('stale metric', JSON.stringify(stale));

  const unknown = (() => {
    try {
      run('get_metric_series', db, { metric: 'nonsense_metric' });
      return null;
    } catch (e) {
      return e.message;
    }
  })();
  unknown && /steps/.test(unknown) && /glucose_mgdl/.test(unknown)
    ? ok('an unknown name errors with the DEVICE-SPECIFIC valid set (discovered ones included)')
    : bad('unknown metric error', unknown);

  // --- (b) today's wearable picture is IN the snapshot -----------------------
  const snap = run('get_today_snapshot', db);
  snap.wearables &&
  near(snap.wearables.today.steps.value, 8000) &&
  snap.wearables.today.steps.unit === 'count' &&
  snap.wearables.today.sleep_duration_min.hm === '7h 11m' &&
  near(snap.wearables.today.hrv.value, 50) &&
  near(snap.wearables.today.active_energy_kcal.value, 620)
    ? ok('get_today_snapshot carries steps, sleep (h/m), HRV and energy for today')
    : bad('snapshot wearables', JSON.stringify(snap.wearables).slice(0, 300));

  snap.wearables.noDataToday.length === 0 &&
  snap.wearables.availableMetrics.includes('glucose_mgdl') &&
  snap.wearables.availableMetrics.includes('steps')
    ? ok('availableMetrics advertises the whole device set, discovered metrics included')
    : bad('availableMetrics', JSON.stringify(snap.wearables.availableMetrics));

  snap.wearables.today.steps.source === 'Apple Health' &&
  snap.wearables.today.hrv.source === 'Apple Watch'
    ? ok('each value names the source device that won the day')
    : bad('sources', JSON.stringify(snap.wearables.today.steps));

  // --- (b) readiness is Home's, not a second opinion -------------------------
  const home = deriveReadiness(db, TODAY);
  snap.readiness.level === home.readiness.level &&
  snap.readiness.label === home.readiness.label &&
  snap.readiness.detail === home.readiness.detail &&
  JSON.stringify(snap.readiness.pillars) === JSON.stringify(home.pillars) &&
  snap.readiness.hasSignal === home.hasSignal
    ? ok(
        `snapshot readiness IS Home's derivation ("${home.readiness.label}" · ${home.readiness.detail})`
      )
    : bad('readiness mismatch', JSON.stringify({ coach: snap.readiness, home: home.readiness }));
}

console.log('18. wearables: an empty device states absence rather than implying zeros');
{
  const { db } = freshDb();
  const snap = run('get_today_snapshot', db);
  snap.wearables.noDataToday.includes('steps') &&
  snap.wearables.noDataToday.includes('sleep_duration_min') &&
  Object.keys(snap.wearables.today).length === 0 &&
  /never synced/.test(snap.wearables.note)
    ? ok('no wearable data at all ⇒ core metrics named in noDataToday + an explicit note')
    : bad('empty wearables', JSON.stringify(snap.wearables));
  snap.readiness.hasSignal === false && snap.readiness.level === 'unknown'
    ? ok('readiness is `unknown` with hasSignal:false — an absence, not a bad score')
    : bad('empty readiness', JSON.stringify(snap.readiness));

  // Steps synced but nothing else: the still-missing ones must stay named.
  upsertWearableRows(db, [
    {
      date: TODAY,
      metricType: 'steps',
      value: 4210,
      unit: 'count',
      sourceDevice: 'apple_health',
      sourceRawId: `hk:steps:${TODAY}`,
      startTime: null,
      endTime: null,
      metadata: {},
    },
  ]);
  const partial = run('get_today_snapshot', db);
  near(partial.wearables.today.steps.value, 4210) &&
  !partial.wearables.noDataToday.includes('steps') &&
  partial.wearables.noDataToday.includes('sleep_duration_min') &&
  partial.wearables.noDataToday.includes('hrv')
    ? ok('a partial sync reports what exists and still names what does not')
    : bad('partial wearables', JSON.stringify(partial.wearables));
}

console.log('19. wearable values honour Settings › Units (°F/°C, oz/ml)');
{
  const { db } = freshDb();
  upsertWearableRows(db, [
    {
      date: TODAY,
      metricType: 'wrist_temp_c',
      value: 35.2,
      unit: 'c',
      sourceDevice: 'apple_watch',
      sourceRawId: `hk:wrist_temp_c:${TODAY}`,
      startTime: null,
      endTime: null,
      metadata: {},
    },
    {
      date: TODAY,
      metricType: 'water_ml',
      value: 500,
      unit: 'ml',
      sourceDevice: 'manual',
      sourceRawId: `manual:water:${TODAY}:1`,
      startTime: null,
      endTime: null,
      metadata: {},
    },
    {
      date: TODAY,
      metricType: 'water_ml',
      value: 250,
      unit: 'ml',
      sourceDevice: 'manual',
      sourceRawId: `manual:water:${TODAY}:2`,
      startTime: null,
      endTime: null,
      metadata: {},
    },
  ]);

  // Imperial defaults: 35.2 °C → 95.4 °F, 750 ml → 25 oz (water renders whole
  // ounces everywhere in the app — the Coach must not invent extra precision).
  const f = run('get_metric_series', db, { metric: 'wrist_temp' });
  f.unit === '°F' && near(f.points[0].value, 95.4, 0.06)
    ? ok('an °F user reads wrist temperature in °F (35.2 °C → 95.4 °F)')
    : bad('temp F', JSON.stringify(f.points));
  const ozWater = run('get_metric_series', db, { metric: 'water' });
  ozWater.unit === 'oz' && ozWater.points[0].value === 25
    ? ok('water sums the day’s rows (500 + 250 ml) and reports 25 oz for an oz user')
    : bad('water oz', JSON.stringify(ozWater.points));

  setUnitPreference(db, 'temperature', 'C');
  setUnitPreference(db, 'volume', 'ml');
  const c = run('get_metric_series', db, { metric: 'wrist_temp_c' });
  c.unit === '°C' && near(c.points[0].value, 35.2, 0.06)
    ? ok('flipping the preference reports the same row in °C — display only, no rewrite')
    : bad('temp C', JSON.stringify(c.points));
  const mlSnap = run('get_today_snapshot', db);
  mlSnap.wearables.today.water_ml.unit === 'ml' &&
  near(mlSnap.wearables.today.water_ml.value, 750) &&
  mlSnap.wearables.today.wrist_temp_c.unit === '°C'
    ? ok('the snapshot honours the same preferences (750 ml, °C)')
    : bad('snapshot units', JSON.stringify(mlSnap.wearables.today));
}

// The owner's SECOND report of the same symptom: "steps have been synced and
// the home screen correctly displays my step count from apple health, coach is
// not able to read them and reports that no step data has synced when asked."
//
// Round one chased the data layer and proved 18 assertions about it. The data
// layer was never the fault — get_today_snapshot returned the steps then and
// returns them now. What it ALSO returned, in the same object, was
// `readiness.detail = "Connect Apple Health in Settings to power readiness."`,
// deriveReadiness' first-run CALL TO ACTION, emitted whenever there is no
// usable RECOVERY input (HRV/RHR with a baseline, or last night's sleep).
//
// On Home that string is small copy under a strip already showing the step
// count, and a human reads it as "no recovery signal". In JSON it is a flat
// assertion that Apple Health is not connected, sitting a few lines under
// `steps: 8432`, in the payload the system prompt tells the model is the
// authority on today. The model repeated the sentence, not the number.
//
// And for a PHONE-ONLY user it is not a first-run state at all: no watch means
// no HRV, no resting HR and no sleep — forever — so the tool shipped that
// contradiction on every single call, which is exactly why the symptom looked
// permanent and unrelated to any particular day's sync.
//
// So the fixtures below are built by the REAL ingest mappers (statisticDailyRows
// / quantityDailyRows / sleepDailyRows) rather than by hand-written rows, and
// the load-bearing assertion is a NEGATIVE one: no interface instruction may
// appear anywhere in a tool payload that is simultaneously carrying data.
console.log('20. the snapshot never denies a sync it is reporting (owner report, round 2)');
{
  const localDay = (n) =>
    todayISODate(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - n));
  const CONNECT_CTA = 'Connect Apple Health';

  /** A phone-only device: HealthKit merged statistics, no watch, so no recovery. */
  const phoneOnlyDb = () => {
    const { db } = freshDb();
    const rows = [];
    for (const key of ['steps', 'active_energy_kcal', 'resting_energy_kcal']) {
      const spec = STATISTIC_METRICS.find((s) => s.metricType === key);
      const stats = [];
      for (let i = 0; i < 30; i++) {
        stats.push({
          date: localDay(i),
          value: key === 'steps' ? 8432 - i * 37 : key === 'active_energy_kcal' ? 612 : 1720,
        });
      }
      rows.push(...statisticDailyRows(spec, stats));
    }
    upsertWearableRows(db, rows);
    return db;
  };

  const db = phoneOnlyDb();

  // The rows the REAL mapper emits are the ones the arbitration list must know.
  const stepRow = db.get(
    'SELECT unit, source_device, source_raw_id FROM wearable_data WHERE metric_type = ? AND date = ?',
    ['steps', TODAY]
  );
  stepRow.unit === 'count' &&
  stepRow.source_device === 'apple_health' &&
  stepRow.source_raw_id === `hk:steps:${TODAY}` &&
  SOURCE_PRIORITY.includes(stepRow.source_device)
    ? ok('the real ingest writes steps as apple_health/count/hk:steps:<date>, a known source')
    : bad('real step row shape', JSON.stringify(stepRow));

  // Home and the Coach must agree, because they are the same read.
  const home = deriveReadiness(db, TODAY);
  const snap = run('get_today_snapshot', db);
  const homeSteps = home.metrics.find((m) => m.id === 'steps');
  homeSteps.value === '8,432' && near(snap.wearables.today.steps.value, 8432)
    ? ok('Home renders 8,432 steps and the snapshot carries the same 8432 — one read, one answer')
    : bad('home/coach steps', JSON.stringify({ homeSteps, coach: snap.wearables.today.steps }));

  // THE REGRESSION. A payload that is reporting data must never also instruct
  // the user to connect the source of that data.
  const serialised = JSON.stringify(snap);
  Object.keys(snap.wearables.today).length > 0 && !serialised.includes(CONNECT_CTA)
    ? ok('no "Connect Apple Health" instruction anywhere in a payload that carries today’s data')
    : bad('CTA leaked into the tool payload', serialised.slice(0, 400));

  // Readiness is still honestly `unknown` — the fix is about WHAT IT SAYS, not
  // about inventing a verdict from signals that genuinely are not there.
  snap.readiness.level === 'unknown' &&
  snap.readiness.hasSignal === true &&
  /RECOVERY ONLY/.test(snap.readiness.detail) &&
  /NOT mean Apple Health is disconnected/.test(snap.readiness.detail)
    ? ok('readiness stays `unknown` but scopes itself to recovery instead of denying the sync')
    : bad('readiness detail', JSON.stringify(snap.readiness));

  // Silence is what let the contradiction win: nothing in the old payload ever
  // affirmed a working sync, so every ambiguity resolved toward "it is broken".
  /HAS synced today/.test(snap.wearables.note) && /3 metric/.test(snap.wearables.note)
    ? ok('the note states affirmatively that Apple Health synced, and how many metrics')
    : bad('affirmative note', JSON.stringify(snap.wearables.note));

  // A phone has no HRV sensor. Reporting that as "not synced today", every day,
  // is what makes a working sync look broken.
  snap.wearables.noDataToday.includes('hrv') &&
  snap.wearables.neverRecorded.includes('hrv') &&
  snap.wearables.neverRecorded.includes('sleep_duration_min') &&
  !snap.wearables.neverRecorded.includes('steps')
    ? ok('neverRecorded separates "no sensor on this device" from "missing today"')
    : bad('neverRecorded', JSON.stringify(snap.wearables));

  // "and likely other data" — the same question, asked the same way, for the
  // other two metrics the owner named.
  const seriesMisses = ['steps', 'active_energy_kcal'].filter((metric) => {
    const out = run('get_metric_series', db, { metric, days: 30 });
    return !(out.hasData === true && out.points.some((p) => p.date === TODAY));
  });
  seriesMisses.length === 0
    ? ok('get_metric_series over real-mapper rows returns today for steps and active energy')
    : bad('series misses', seriesMisses.join(', '));

  // A metric that is missing TODAY but recorded before must not be relabelled
  // "no sensor" — that is the same conflation in the other direction.
  {
    const db2 = phoneOnlyDb();
    const watch = {
      sourceName: "Matt's Apple Watch",
      bundleId: 'com.apple.health.0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0',
      productType: 'Watch7,1',
    };
    // A night of sleep that ended YESTERDAY morning, from the real sleep mapper.
    const start = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 2, 23, 0, 0, 0);
    const end = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 1, 6, 11, 0, 0);
    upsertWearableRows(
      db2,
      sleepDailyRows([
        { value: 3, startISO: start.toISOString(), endISO: end.toISOString(), provenance: watch },
      ])
    );
    const s2 = run('get_today_snapshot', db2);
    s2.wearables.noDataToday.includes('sleep_duration_min') &&
    !s2.wearables.neverRecorded.includes('sleep_duration_min')
      ? ok('slept the night before but not last night ⇒ noDataToday, NOT neverRecorded')
      : bad('stale-but-recorded', JSON.stringify(s2.wearables));
  }

  // The genuinely empty device keeps its old, correct message — the fix must not
  // have traded one false claim for the opposite one.
  {
    const { db: empty } = freshDb();
    const s3 = run('get_today_snapshot', empty);
    /never synced/.test(s3.wearables.note) &&
    s3.readiness.hasSignal === false &&
    Object.keys(s3.wearables.today).length === 0
      ? ok(
          'a device with no rows at all still says "never synced" — absence still reads as absence'
        )
      : bad('empty device', JSON.stringify(s3.wearables));
  }
}

// The same bug insights.ts was fixed for, one file over — and the one the owner
// actually asks: "how have my steps been?" sends the model to get_metric_series
// FIRST (system-prompt.ts) and tells it to cite these numbers. Steps accumulate,
// so a two-hour-old today is a fraction of a day; averaging it in beside seven
// complete 8,000-step days reported avg 7,112.5 and min 900 — numbers that
// describe the clock, not the user. Today is not dropped (it is real, and the
// owner wants it) — it is held out of the statistics and reported on its own.
console.log('21. get_metric_series never averages a still-accumulating today (owner: steps)');
{
  const { db } = freshDb();
  const day = (n) => isoDaysAgo(NOW, n);
  const wear = (rows) =>
    upsertWearableRows(
      db,
      rows.map((r) => ({
        date: r.date,
        metricType: r.metric,
        value: r.value,
        unit: r.unit,
        sourceDevice: r.device ?? 'apple_health',
        sourceRawId: `hk:${r.metric}:${r.date}`,
        startTime: null,
        endTime: null,
        metadata: {},
      }))
    );

  const rows = [];
  // Seven identical COMPLETE days...
  for (let i = 1; i <= 7; i++) {
    rows.push({ date: day(i), metric: 'steps', value: 8000, unit: 'count' });
    rows.push({ date: day(i), metric: 'active_energy_kcal', value: 600, unit: 'kcal' });
    rows.push({ date: day(i), metric: 'sleep_duration_min', value: 431, unit: 'min' });
  }
  // ...and a today two hours old.
  rows.push({ date: day(0), metric: 'steps', value: 900, unit: 'count' });
  rows.push({ date: day(0), metric: 'active_energy_kcal', value: 70, unit: 'kcal' });
  // Sleep is a whole fact the moment it is written: last night counts today.
  rows.push({ date: day(0), metric: 'sleep_duration_min', value: 431, unit: 'min' });
  wear(rows);

  const steps = run('get_metric_series', db, { metric: 'steps', days: 8 });

  // (1) The partial day moves NOTHING in the statistics.
  steps.stats.count === 7 &&
  near(steps.stats.avg, 8000) &&
  near(steps.stats.min, 8000) &&
  near(steps.stats.max, 8000) &&
  steps.stats.last.date === day(1) &&
  near(steps.stats.last.value, 8000)
    ? ok('a two-hour-old today moves neither avg (8000, not 7112.5) nor min (8000, not 900)')
    : bad('steps stats polluted by today', JSON.stringify(steps.stats));

  // (2) It is still THERE — visible, real, and labelled as a running total.
  const todayPoint = steps.points.find((p) => p.date === TODAY);
  steps.points.length === 8 &&
  todayPoint &&
  near(todayPoint.value, 900) &&
  todayPoint.partial === true &&
  steps.todaySoFar &&
  steps.todaySoFar.date === TODAY &&
  near(steps.todaySoFar.value, 900) &&
  steps.todaySoFar.partial === true &&
  steps.todaySoFar.unit === 'count'
    ? ok("today's 900 steps are NOT dropped — they are in points (partial) and in todaySoFar")
    : bad('today missing from the payload', JSON.stringify(steps).slice(0, 300));

  // (3) points and stats cover different sets, and the payload says which.
  steps.statsExcludesToday === true &&
  /complete days only/.test(steps.statsBasis) &&
  /RUNNING TOTAL/.test(steps.note) &&
  /Never average today in/.test(steps.note) &&
  /so far today/.test(steps.note)
    ? ok('statsBasis + statsExcludesToday + note spell out that points ≠ the stats window')
    : bad('inconsistency unexplained', JSON.stringify(steps).slice(0, 400));

  // (4) The same class, the other metric the owner named.
  const energy = run('get_metric_series', db, { metric: 'active_energy_kcal', days: 8 });
  energy.stats.count === 7 && near(energy.stats.avg, 600) && near(energy.todaySoFar.value, 70)
    ? ok('active energy accumulates too: today held out of stats, kept as todaySoFar')
    : bad('active energy', JSON.stringify(energy.stats));

  // (5) A LEVEL metric is whole when written — today must keep counting.
  const sleep = run('get_metric_series', db, { metric: 'sleep_duration_min', days: 8 });
  sleep.stats.count === 8 &&
  near(sleep.stats.avg, 431) &&
  sleep.statsExcludesToday === false &&
  sleep.todaySoFar === undefined &&
  sleep.points.every((p) => p.partial === undefined) &&
  sleep.stats.last.date === TODAY
    ? ok("last night's sleep still counts today — a level metric is not held back")
    : bad('sleep wrongly excluded', JSON.stringify(sleep).slice(0, 300));

  // (6) HRV, RHR, VO2max — every sampled reading — stay on the level side.
  {
    const { db: db2 } = freshDb();
    upsertWearableRows(db2, [
      {
        date: TODAY,
        metricType: 'hrv',
        value: 50,
        unit: 'ms',
        sourceDevice: 'apple_watch',
        sourceRawId: 'hk:hrv:today',
        startTime: null,
        endTime: null,
        metadata: {},
      },
    ]);
    const hrv = run('get_metric_series', db2, { metric: 'hrv', days: 7 });
    hrv.stats && hrv.stats.count === 1 && hrv.statsExcludesToday === false
      ? ok('a single HRV reading taken today is a complete fact and is averaged')
      : bad('hrv held back', JSON.stringify(hrv).slice(0, 240));
  }

  // (7) Today alone: there IS data, but no complete day to average. Both facts
  // must be stated — a null `stats` next to a real running total is exactly
  // where a model would otherwise invent a daily figure.
  {
    const { db: db3 } = freshDb();
    upsertWearableRows(db3, [
      {
        date: TODAY,
        metricType: 'steps',
        value: 900,
        unit: 'count',
        sourceDevice: 'apple_health',
        sourceRawId: 'hk:steps:today',
        startTime: null,
        endTime: null,
        metadata: {},
      },
    ]);
    const only = run('get_metric_series', db3, { metric: 'steps', days: 7 });
    only.hasData === true &&
    only.stats === null &&
    near(only.todaySoFar.value, 900) &&
    /no COMPLETE day/.test(only.note)
      ? ok('today-only: stats is null with data present, and the note says why')
      : bad('today-only steps', JSON.stringify(only).slice(0, 320));
  }

  // (8) A summed metric (water: one row per sip) is accumulating by construction
  // and needs no declaration to be handled the same way.
  {
    const { db: db4 } = freshDb();
    setUnitPreference(db4, 'volume', 'ml');
    upsertWearableRows(
      db4,
      [
        { date: day(1), value: 2000 },
        { date: TODAY, value: 250 },
      ].map((r) => ({
        date: r.date,
        metricType: 'water_ml',
        value: r.value,
        unit: 'ml',
        sourceDevice: 'manual',
        sourceRawId: `manual:water:${r.date}`,
        startTime: null,
        endTime: null,
        metadata: {},
      }))
    );
    const water = run('get_metric_series', db4, { metric: 'water', days: 7 });
    water.stats.count === 1 && near(water.stats.avg, 2000) && near(water.todaySoFar.value, 250)
      ? ok('water (agg sum) excludes today from stats without needing its own flag')
      : bad('water', JSON.stringify(water).slice(0, 260));
  }

  // (9) Body metrics are readings, not totals — weight logged today counts.
  {
    const { db: db5 } = freshDb();
    run('log_metric', db5, { metric: 'weight', value: 180 });
    const weight = run('get_metric_series', db5, { metric: 'weight', days: 7 });
    weight.statsExcludesToday === false &&
    weight.stats.count === 1 &&
    weight.todaySoFar === undefined
      ? ok("today's weigh-in is a complete measurement and stays in the stats")
      : bad('weight', JSON.stringify(weight).slice(0, 240));
  }
}

let extraSeq = 0;
const xid = () => `x-${++extraSeq}`;
const seedWearableRow = (raw, metricType, daysAgo, value) =>
  raw
    .prepare(
      `INSERT INTO wearable_data (id, date, metric_type, value, source_device) VALUES (?, ?, ?, ?, 'manual')`
    )
    .run(xid(), isoDaysAgo(NOW, daysAgo), metricType, value);

console.log('22. snapshot carries readiness, profile, mission ids, experiments');
{
  const { db, raw } = freshDb();
  const empty = run('get_today_snapshot', db);
  // `readiness.level`, not `.verdict` — the snapshot now returns deriveReadiness'
  // own shape rather than a re-spelling of it, so the Coach and Home cannot drift.
  empty.readiness &&
  empty.readiness.level === 'unknown' &&
  empty.profile &&
  empty.profile.age === null &&
  Array.isArray(empty.experiments) &&
  empty.experiments.length === 0
    ? ok('empty day: readiness unknown, profile nulls, experiments []')
    : bad('empty snapshot extras', JSON.stringify(empty.readiness));

  // THE TWO SETTINGS THE DAY IS JUDGED BY, and both were the `nutritionTargets`
  // blind spot again: the Home nutrition pillar grades an over-target day as a
  // fault while cutting and as the point while gaining, and the water screen
  // shows no denominator until a goal exists. `waterTarget` is explicitly NULL
  // rather than omitted — unset is a setting the user has not chosen, never a
  // feature ARC lacks.
  empty.goalDirection === 'maintain' && empty.waterTarget === null
    ? ok('the snapshot states the goal direction and an UNSET water target, never silence')
    : bad('goal/water absent', JSON.stringify([empty.goalDirection, empty.waterTarget]));
  {
    const { db: wdb } = freshDb();
    setGoalDirection(wdb, 'gain');
    setWaterTarget(wdb, 3000);
    setUnitPreference(wdb, 'volume', 'oz');
    const snapped = run('get_today_snapshot', wdb);
    snapped.goalDirection === 'gain' &&
    snapped.waterTarget.unit === 'oz' &&
    Math.round(snapped.waterTarget.value) === 101
      ? ok('…and a set target is reported in the user’s own volume unit (3,000 ml → 101 oz)')
      : bad('water target units', JSON.stringify(snapped.waterTarget));
  }

  updateProfile(db, { dateOfBirth: '1992-01-15', biologicalSex: 'male' });
  for (let d = 1; d <= 6; d++) seedWearableRow(raw, 'hrv', d, 50);
  seedWearableRow(raw, 'hrv', 0, 40);
  createExperiment(db, {
    title: 'Magnesium PM',
    hypothesis: 'Better sleep',
    intervention: '400 mg at night',
    metrics: ['hrv', 'sleep'],
    startDate: TODAY,
    durationDays: 14,
  });

  const snap = run('get_today_snapshot', db);
  snap.profile.sex === 'male' && typeof snap.profile.age === 'number'
    ? ok('profile carries age + sex')
    : bad('profile', JSON.stringify(snap.profile));
  // HRV 40 vs a 50 baseline (ratio 0.8) → the same "caution" Home renders.
  snap.readiness.level === 'caution' &&
  Array.isArray(snap.readiness.pillars) &&
  snap.readiness.pillars.some((p) => p.label === 'Recovery' && p.level === 'caution')
    ? ok('readiness verdict + pillars mirror deriveReadiness')
    : bad('readiness', JSON.stringify(snap.readiness));
  snap.experiments.length === 1 &&
  snap.experiments[0].title === 'Magnesium PM' &&
  snap.experiments[0].ready === false &&
  snap.experiments[0].daysLeft === 13
    ? ok('running experiments ride the snapshot')
    : bad('experiments', JSON.stringify(snap.experiments));
}

console.log('23. snapshot mission items expose ids (the address a mission tool needs)');
{
  const { db } = freshDb();
  run('log_metric', db, { metric: 'weight', value: 178 }); // ensures a daily_log exists
  const snap = run('get_today_snapshot', db);
  // Mission may be empty (no protocols seeded), but WHEN items exist they must
  // carry ids — assert on the shape contract via a seeded item instead.
  const { getOrCreateDailyLog, insertMissionItem } =
    await import('../src/lib/db/repositories/mission.ts');
  const log = getOrCreateDailyLog(db, TODAY);
  insertMissionItem(db, log.id, 'habit', {
    id: 'unused',
    title: 'Morning light',
    status: 'pending',
    category: 'Routine',
    why: 'Circadian anchor',
  });
  const snap2 = run('get_today_snapshot', db);
  snap2.mission.length === 1 &&
  typeof snap2.mission[0].id === 'string' &&
  snap2.mission[0].id.length > 0 &&
  snap2.mission[0].category === 'Routine' &&
  snap2.mission[0].why === 'Circadian anchor'
    ? ok('mission items carry id + category + why')
    : bad('mission ids', JSON.stringify(snap2.mission));
  snap.mission.length === 0
    ? ok('before seeding, an unplanned day reports an empty mission (no fabricated rows)')
    : bad('pre-seed mission not empty', JSON.stringify(snap.mission));
}

console.log('24. get_metric_series reads sleep/steps/energy; future rows never leak');
{
  const { db, raw } = freshDb();
  for (let d = 0; d <= 4; d++) seedWearableRow(raw, 'sleep_duration_min', d, 420 + d);
  seedWearableRow(raw, 'steps', 1, 9000);
  seedWearableRow(raw, 'active_energy_kcal', 1, 650);
  // A future-dated row (clock skew / bad import) must not appear at all.
  seedWearableRow(raw, 'sleep_duration_min', -3, 999);

  const sleep = run('get_metric_series', db, { metric: 'sleep', days: 14 });
  sleep.unit === 'min' && sleep.stats.count === 5
    ? ok('sleep series in fixed minutes, 5 real days')
    : bad('sleep series', JSON.stringify(sleep.stats));
  sleep.points.every((p) => p.date <= TODAY) && sleep.stats.max < 999
    ? ok('the future-dated row is excluded from points and stats')
    : bad('future leak', JSON.stringify(sleep.points));
  run('get_metric_series', db, { metric: 'steps', days: 7 }).stats.count === 1
    ? ok('steps series reads')
    : bad('steps');
  run('get_metric_series', db, { metric: 'active_energy', days: 7 }).unit === 'kcal'
    ? ok('active_energy series reads in kcal')
    : bad('energy');
}

console.log('25. get_biomarker_history: trend behind the latest value, exact-first resolution');
{
  const { db, raw } = freshDb();
  const insertMarker = (id, slug, name) =>
    raw
      .prepare(
        `INSERT INTO biomarkers (id, slug, name, category, unit, optimal_range_low, optimal_range_high)
         VALUES (?, ?, ?, 'hormone', 'ng/dL', 20, 60)`
      )
      .run(id, slug, name);
  insertMarker('bm1', 'apob', 'ApoB');
  insertMarker('bm2', 'testosterone', 'Testosterone');
  insertMarker('bm3', 'testosterone_free', 'Testosterone, Free');
  raw
    .prepare(
      `INSERT INTO lab_results (id, biomarker_id, value, collected_at, source) VALUES (?, ?, ?, ?, 'manual')`
    )
    .run('lr1', 'bm1', 95, '2026-01-10');
  raw
    .prepare(
      `INSERT INTO lab_results (id, biomarker_id, value, collected_at, source) VALUES (?, ?, ?, ?, 'manual')`
    )
    .run('lr2', 'bm1', 78, '2026-06-01');

  const bySlug = run('get_biomarker_history', db, { biomarker: 'apob' });
  bySlug.found && bySlug.resultCount === 2 && bySlug.results[0].value === 95
    ? ok('slug lookup returns the full series, oldest first')
    : bad('slug lookup', JSON.stringify(bySlug));
  // "Testosterone" is a substring of "Testosterone, Free" — the exact name
  // match must win outright, never read as ambiguous (the labs discipline).
  const exact = run('get_biomarker_history', db, { biomarker: 'Testosterone' });
  exact.found && exact.slug === 'testosterone'
    ? ok('exact name beats the substring trap (Testosterone vs Testosterone, Free)')
    : bad('exact-name', JSON.stringify(exact));
  const ambiguous = run('get_biomarker_history', db, { biomarker: 'testo' });
  !ambiguous.found && ambiguous.candidates && ambiguous.candidates.length === 2
    ? ok('an ambiguous fragment returns candidates instead of guessing')
    : bad('ambiguous', JSON.stringify(ambiguous));
  const missing = run('get_biomarker_history', db, { biomarker: 'zzz' });
  !missing.found
    ? ok('no match → found:false, no invention')
    : bad('missing', JSON.stringify(missing));
}

console.log('26. get_training_recommendation reports engine state (never decides)');
{
  const { db } = freshDb();
  const rec = run('get_training_recommendation', db);
  rec.recommendation && typeof rec.recommendation.kind === 'string' && rec.recommendation.why
    ? ok(`recommendation present (kind: ${rec.recommendation.kind})`)
    : bad('recommendation shape', JSON.stringify(rec.recommendation));
  Array.isArray(rec.muscleFreshness) && rec.muscleFreshness.length >= 10
    ? ok(`muscle freshness ledger rides along (${rec.muscleFreshness.length} muscles)`)
    : bad('ledger', JSON.stringify(rec.muscleFreshness));
  Array.isArray(rec.weeklyVolume) && rec.weeklyVolume.length === 0
    ? ok('no logged sets → empty weekly volume, not 16 zero rows')
    : bad('volume', JSON.stringify(rec.weeklyVolume));
  if (rec.recommendation.exercises) {
    rec.recommendation.exercises.every((e) => e.target && typeof e.target.kind === 'string')
      ? ok('every recommended exercise carries a progression target')
      : bad('targets', JSON.stringify(rec.recommendation.exercises[0]));
  } else {
    ok('no exercises on this recommendation kind (nothing to target)');
  }
}

console.log('27. log_workout resolves catalog exercise ids — a unique match only');
{
  const { db, raw } = freshDb();
  const result = run('log_workout', db, {
    name: 'Upper A',
    kind: 'strength',
    duration_min: 50,
    sets: [
      { exercise: 'Barbell Bench Press', reps: 8, weight: 100, unit: 'kg' },
      { exercise: 'bench press', reps: 8, weight: 100, unit: 'kg' }, // alias, case-insensitive
      // A misspelling the tolerant matcher owns (2026-09-14, A7): one
      // transposition from an alias, and nothing else is close.
      { exercise: 'bnech press', reps: 8, weight: 100, unit: 'kg' },
      { exercise: 'Press', reps: 5, weight: 60, unit: 'kg' }, // no unique match
    ],
  });
  const ids = raw
    .prepare(`SELECT exercise_id FROM workout_sets ORDER BY set_index, rowid`)
    .all()
    .map((r) => r.exercise_id);
  ids[0] === 'barbell-bench-press' && ids[1] === 'barbell-bench-press'
    ? ok('exact name and exact alias both resolve to the catalog id')
    : bad('resolution', JSON.stringify(ids));
  ids[2] === 'barbell-bench-press'
    ? ok('…and so does a typo that is one edit from exactly one movement')
    : bad('typo resolution', JSON.stringify(ids));
  // THE PIN, and the reason tolerance is not looseness: "Press" is contained in
  // nine movements, is not close to any of them, and must therefore resolve to
  // none of them. A wrong exercise_id attributes a set to the wrong muscles for
  // the life of the database.
  ids[3] === null
    ? ok('a non-unique name stays NULL — never a guess')
    : bad('ambiguous resolved', JSON.stringify(ids));
  result.unmatchedExercises &&
  result.unmatchedExercises.length === 1 &&
  result.unmatchedExercises[0] === 'Press'
    ? ok('the tool result names the unmatched exercise so the model can say so')
    : bad('unmatched note', JSON.stringify(result));
}

console.log('28. future log dates are rejected; set_status "until" may still be future');
{
  const { db } = freshDb();
  const future = isoDaysAgo(NOW, -2);
  throws(() => run('log_metric', db, { metric: 'weight', value: 178, date: future }))
    ? ok('log_metric refuses a future date')
    : bad('future weight accepted');
  throws(() => run('log_meal', db, { name: 'Lunch', date: future }))
    ? ok('log_meal refuses a future date')
    : bad('future meal accepted');
  const past = run('log_metric', db, { metric: 'weight', value: 178, date: isoDaysAgo(NOW, 1) });
  past.logged ? ok('a real backdate still logs') : bad('backdate broken');
  const status = run('set_status', db, { label: 'traveling', until: future });
  status.set && status.until === future
    ? ok('set_status "until" legitimately reaches into the future')
    : bad('set_status until', JSON.stringify(status));

  // The rejection must fire at CARD time too — a knowable failure must never
  // cost the user an Approve tap (card shows, user approves, execute throws).
  throws(() =>
    toolByName('log_metric').confirmSummary({ metric: 'weight', value: 178, date: future }, db, CTX)
  )
    ? ok('confirmSummary throws on a future date BEFORE the card is shown')
    : bad('future date reached the confirmation card');
  const reminderCard = toolByName('set_reminder').confirmSummary(
    { title: 'Book DEXA', date: future },
    db,
    CTX
  );
  reminderCard.includes(future)
    ? ok("set_reminder's card still accepts a future date (its dates reach forward)")
    : bad('reminder card', reminderCard);
}

console.log('29. an evening weigh-in west of UTC still lands in its own series');
{
  // REGRESSION: body_metrics stores a UTC INSTANT, so west of UTC an evening
  // weigh-in already carries tomorrow's UTC date. Bounding the window with a
  // local date string (`substr(measured_at,1,10) <= today`) silently dropped
  // the user's own reading; the bound must be the end-of-local-day instant.
  const { db, raw } = freshDb();
  const local = todayISODate(NOW);
  // Stamp it the way the local evening does: an instant inside today locally,
  // whose UTC date may be tomorrow.
  const eveningUtc = new Date(
    NOW.getFullYear(),
    NOW.getMonth(),
    NOW.getDate(),
    23,
    30,
    0,
    0
  ).toISOString();
  raw
    .prepare(
      `INSERT INTO body_metrics (id, measured_at, weight_kg, source) VALUES (?, ?, ?, 'manual')`
    )
    .run('bm-evening', eveningUtc, 80);
  const series = run('get_metric_series', db, { metric: 'weight', days: 7 });
  series.points.length === 1
    ? ok(
        `a 23:30 local weigh-in is in the series (UTC date ${eveningUtc.slice(0, 10)}, local ${local})`
      )
    : bad('evening weigh-in dropped', JSON.stringify(series));

  // A genuinely future reading (tomorrow evening) is still excluded.
  const tomorrowUtc = new Date(
    NOW.getFullYear(),
    NOW.getMonth(),
    NOW.getDate() + 1,
    20,
    0,
    0,
    0
  ).toISOString();
  raw
    .prepare(
      `INSERT INTO body_metrics (id, measured_at, weight_kg, source) VALUES (?, ?, ?, 'manual')`
    )
    .run('bm-future', tomorrowUtc, 99);
  run('get_metric_series', db, { metric: 'weight', days: 7 }).points.length === 1
    ? ok('a genuinely future weigh-in is still excluded')
    : bad(
        'future weigh-in leaked',
        JSON.stringify(run('get_metric_series', db, { metric: 'weight', days: 7 }))
      );
}

console.log('30. dual-writer sleep night: the Coach cites the arbitrated winner, like Home');
{
  const { db, raw } = freshDb();
  const day = isoDaysAgo(NOW, 1);
  const insert = raw.prepare(
    `INSERT INTO wearable_data (id, date, metric_type, value, source_device) VALUES (?, ?, ?, ?, ?)`
  );
  insert.run('dw-1', day, 'sleep_duration_min', 450, 'apple_watch');
  insert.run('dw-2', day, 'sleep_duration_min', 380, 'oura');
  const sleep = run('get_metric_series', db, { metric: 'sleep', days: 7 });
  // SOURCE_PRIORITY ranks apple_watch above oura — Home shows 450; a pooled
  // average (415) would be a number no app surface displays.
  sleep.stats.count === 1 && sleep.points[0].value === 450
    ? ok('sleep series returns the source-arbitrated 450, not the 415 pooled average')
    : bad('dual-writer sleep', JSON.stringify(sleep.points));
}

console.log('31. recipes + grocery tools (docs/recipes-grocery.md §6)');
{
  const { db } = freshDb();
  const summary = (name, input) => toolByName(name).confirmSummary(input, db, CTX);

  // Empty book reads honestly.
  const emptyBook = run('get_recipes', db);
  emptyBook.recipes.length === 0 && emptyBook.omitted === 0
    ? ok('get_recipes on an empty book → empty, omitted 0')
    : bad('empty book', JSON.stringify(emptyBook));

  // save_recipe: card, then the row — source 'ai', lines unresolved.
  const chili = {
    title: 'High-protein chili',
    servings: 4,
    ingredients: [
      { raw: '500 g lean ground beef' },
      { raw: '2 cans black beans' },
      { raw: 'salt to taste' },
    ],
    steps: ['Brown the beef.', 'Simmer with the beans.'],
  };
  summary('save_recipe', chili) === 'Save recipe "High-protein chili" — 3 ingredients, 4 servings'
    ? ok('save_recipe card names title, line count, servings')
    : bad('save_recipe card', summary('save_recipe', chili));
  const saved = run('save_recipe', db, chili);
  const { getRecipe, listIngredients, resolveIngredient, setIngredientNegligible } =
    await import('../src/lib/db/repositories/recipes.ts');
  const savedRow = getRecipe(db, saved.id);
  savedRow.source === 'ai' && savedRow.servings === 4
    ? ok('save_recipe lands source=ai')
    : bad('save_recipe row', JSON.stringify(savedRow));
  const chiliLines = listIngredients(db, saved.id);
  chiliLines.every((l) => l.grams === null) &&
  chiliLines[0].qty === 500 &&
  chiliLines[0].unit === 'g'
    ? ok('lines land UNRESOLVED with the overlay parsed from raw')
    : bad('save_recipe lines', JSON.stringify(chiliLines[0]));
  throws(() => summary('save_recipe', { ...chili, ingredients: [] }))
    ? ok('empty ingredients refused')
    : bad('empty ingredients');
  throws(() => summary('save_recipe', { ...chili, servings: 0 }))
    ? ok('servings 0 refused')
    : bad('servings 0');

  // get_recipe detail: ids + resolution state; unknown id corrects the model.
  const detail = run('get_recipe', db, { recipe_id: saved.id });
  detail.ingredients.length === 3 &&
  detail.ingredients.every((l) => typeof l.id === 'string' && l.resolved === false) &&
  detail.nutrition.complete === false &&
  detail.nutrition.perServing.kcal === null
    ? ok('get_recipe: ingredient ids + honest incomplete nutrition')
    : bad('get_recipe', JSON.stringify(detail.nutrition));
  throws(() => run('get_recipe', db, { recipe_id: 'nope' }))
    ? ok('get_recipe unknown id → corrective error')
    : bad('get_recipe unknown');

  // Resolve the two real lines; the salt is negligible → nutrition completes.
  const { createFood } = await import('../src/lib/db/repositories/foods.ts');
  const beef = createFood(db, {
    name: 'Lean ground beef',
    kcal_100g: 250,
    protein_g_100g: 26,
    carbs_g_100g: 0,
    fat_g_100g: 15,
  });
  const beans = createFood(db, {
    name: 'Black beans',
    kcal_100g: 130,
    protein_g_100g: 9,
    carbs_g_100g: 24,
    fat_g_100g: 0.5,
  });
  resolveIngredient(db, chiliLines[0].id, beef, 500);
  resolveIngredient(db, chiliLines[1].id, beans, 480);
  setIngredientNegligible(db, chiliLines[2].id, true);
  const completeDetail = run('get_recipe', db, { recipe_id: saved.id });
  // 500g beef = 1250 kcal + 480g beans = 624 kcal → 1874 / 4 = 468.5 → 469 rounded
  completeDetail.nutrition.complete === true && completeDetail.nutrition.perServing.kcal === 469
    ? ok('resolution + negligible → gate opens, per-serving kcal rounded')
    : bad('complete detail', JSON.stringify(completeDetail.nutrition));

  // log_recipe: card carries portion + honest kcal; backdate suffix; XOR guards.
  summary('log_recipe', { recipe_id: saved.id, servings: 2 }) ===
  'Log 2 servings of "High-protein chili" (~937 kcal)'
    ? ok('log_recipe card: portion + ~kcal from the gate')
    : bad('log_recipe card', summary('log_recipe', { recipe_id: saved.id, servings: 2 }));
  summary('log_recipe', { recipe_id: saved.id, date: '2026-08-01' }) ===
  'Log 1 serving of "High-protein chili" (~469 kcal) · 2026-08-01'
    ? ok('log_recipe card names a backdate')
    : bad('backdate card', summary('log_recipe', { recipe_id: saved.id, date: '2026-08-01' }));
  throws(() => summary('log_recipe', { recipe_id: saved.id, servings: 1, grams: 100 }))
    ? ok('servings AND grams refused before the card')
    : bad('XOR');
  throws(() => summary('log_recipe', { recipe_id: saved.id, grams: 100 }))
    ? ok('grams without a recorded cooked weight refused with the corrective error')
    : bad('grams refusal');
  const logged = run('log_recipe', db, { recipe_id: saved.id, servings: 2, time: '19:00' });
  const { getMeal } = await import('../src/lib/db/repositories/nutrition.ts');
  const cookedMeal = getMeal(db, logged.mealId);
  logged.uncountedIngredients === 0 &&
  cookedMeal.recipe_id === saved.id &&
  near(cookedMeal.kcal, 937, 1)
    ? ok('log_recipe stamps the meal with recipe provenance and scaled snapshots')
    : bad('log_recipe meal', JSON.stringify(cookedMeal));

  // An incomplete recipe's card says so instead of showing a number.
  const draft = run('save_recipe', db, {
    title: 'Mystery stew',
    servings: 2,
    ingredients: [{ raw: 'some vegetables' }],
  });
  summary('log_recipe', { recipe_id: draft.id }) ===
  'Log 1 serving of "Mystery stew" (nutrition incomplete — 1 ingredient uncounted)'
    ? ok('incomplete recipe card discloses the undercount, never a number')
    : bad('incomplete card', summary('log_recipe', { recipe_id: draft.id }));

  // A recipe with nothing loggable refuses BEFORE the card — never an approved
  // action that then fails (bug-hunt 2026-08-08).
  const saltWater = run('save_recipe', db, {
    title: 'Salt water',
    servings: 1,
    ingredients: [{ raw: 'water' }, { raw: 'salt to taste' }],
  });
  for (const l of listIngredients(db, saltWater.id)) setIngredientNegligible(db, l.id, true);
  throws(() => summary('log_recipe', { recipe_id: saltWater.id }))
    ? ok('all-negligible recipe refused before the card')
    : bad('all-negligible card');

  // add_grocery_items: batch card, coach provenance, guards.
  const addInput = { items: [{ name: 'Milk', qty: '2' }, { name: 'Spinach' }] };
  summary('add_grocery_items', addInput) === 'Add 2 items to the grocery list: Milk (2) · Spinach'
    ? ok('add_grocery_items card lists every item with qty')
    : bad('grocery card', summary('add_grocery_items', addInput));
  run('add_grocery_items', db, addInput).added === 2 ? ok('batch add lands') : bad('batch add');
  const { listOpenGroceryItems, getGroceryItem } =
    await import('../src/lib/db/repositories/grocery.ts');
  listOpenGroceryItems(db).every((i) => i.source === 'coach')
    ? ok('coach-added items carry source=coach')
    : bad('source coach');
  throws(() => summary('add_grocery_items', { items: [] }))
    ? ok('empty batch refused')
    : bad('empty batch');

  // get_grocery_list: ids + categories; complete_grocery_items resolves names.
  const list = run('get_grocery_list', db);
  const milk = list.sections.flatMap((s) => s.items).find((i) => i.name === 'Milk');
  list.openCount === 2 && typeof milk.id === 'string'
    ? ok('get_grocery_list returns the ids the write tools need')
    : bad('grocery list', JSON.stringify(list));
  summary('complete_grocery_items', { ids: [milk.id] }) === 'Check off 1 item: Milk'
    ? ok('complete_grocery_items card resolves ids to names')
    : bad('checkoff card', summary('complete_grocery_items', { ids: [milk.id] }));
  throws(() => summary('complete_grocery_items', { ids: ['bogus'] }))
    ? ok('unknown grocery id refused before the card')
    : bad('unknown grocery id');
  run('complete_grocery_items', db, { ids: [milk.id] }).checked === 1 &&
  getGroceryItem(db, milk.id).checked_at !== null
    ? ok('check-off stamps checked_at (soft state)')
    : bad('checkoff execute');

  // add_recipe_to_grocery_list: card counts the included lines; exclude works.
  const addRecipeInput = { recipe_id: saved.id, exclude: [chiliLines[2].id] };
  summary('add_recipe_to_grocery_list', addRecipeInput) ===
  'Add 2 ingredients from "High-protein chili" to the grocery list'
    ? ok('add_recipe_to_grocery_list card: title + included count')
    : bad('recipe→list card', summary('add_recipe_to_grocery_list', addRecipeInput));
  run('add_recipe_to_grocery_list', db, addRecipeInput).added === 2
    ? ok('excluded line stays off the list')
    : bad('recipe→list execute');
  const withRecipe = run('get_grocery_list', db);
  withRecipe.sections.flatMap((s) => s.items).some((i) => i.forRecipe === 'High-protein chili')
    ? ok('list items carry their recipe backlink title')
    : bad('forRecipe', JSON.stringify(withRecipe));
  throws(() =>
    summary('add_recipe_to_grocery_list', {
      recipe_id: saved.id,
      exclude: chiliLines.map((l) => l.id),
    })
  )
    ? ok('all-excluded refused (nothing to add)')
    : bad('all excluded');
}

console.log('32. schema/parser drift: every key a tool reads is a key it declares');
{
  // WHY THIS EXISTS. On 2026-08-11 a description-trimming pass rewrote several
  // tool schemas and renamed two of their properties — complete_grocery_items
  // declared "item_ids" while both handlers read "ids", and
  // add_recipe_to_grocery_list declared "exclude_ingredient_ids" while both read
  // "exclude". The first threw on EVERY call; the second silently ignored every
  // exclusion and re-added ingredients the user already had.
  //
  // Nothing caught it. tsc cannot: inputSchema is an untyped record, so a
  // property NAME is just a string. This suite could not: every other test here
  // calls handlers directly with hand-built objects, which is precisely the
  // contract the model does NOT get — the schema is what reaches the model
  // verbatim (toWireTools), with additionalProperties: false forbidding the key
  // the code actually wanted.
  //
  // So this reads the SOURCE of each tool's object literal and asserts that
  // every top-level input key it looks up is one the schema declares. Scope is
  // deliberately the literal itself: keys parsed inside shared helpers are not
  // scanned (a false negative we accept) rather than attributed to whichever
  // tool happens to sit next to the helper (a false positive we do not).
  const sources = [
    readFileSync(new URL('../src/lib/ai/tools/read-tools.ts', import.meta.url), 'utf8'),
    readFileSync(new URL('../src/lib/ai/tools/write-tools.ts', import.meta.url), 'utf8'),
    readFileSync(new URL('../src/lib/ai/tools/record-tools.ts', import.meta.url), 'utf8'),
  ];

  /** The tool object literal: `const xTool: CoachTool = {` … a lone `};`. */
  function toolLiteral(name) {
    for (const src of sources) {
      const at = src.indexOf("  name: '" + name + "',");
      if (at < 0) continue;
      const open = src.lastIndexOf(': CoachTool = {', at);
      const close = src.indexOf('\n};', at);
      if (open < 0 || close < 0) continue;
      return src.slice(open, close);
    }
    return null;
  }

  // Both shapes the codebase uses to pull a key out of the tool's own input:
  // a helper call — reqString(args, 'x') — and a direct read — args.x.
  const HELPER =
    /\b(?:reqString|reqNumber|reqEnum|reqBoolean|optString|optNumber|optDate|optEnum|optBoolean|parseIdArray)\s*\(\s*(?:args|asRecord\(input\))\s*,\s*'([^']+)'/g;
  const DIRECT = /\bargs\.([A-Za-z_][A-Za-z0-9_]*)\b/g;

  let drift = 0;
  let scanned = 0;
  for (const tool of COACH_TOOLS) {
    const body = toolLiteral(tool.name);
    if (body === null) continue;
    scanned += 1;
    const declared = new Set(Object.keys(tool.inputSchema?.properties ?? {}));
    const read = new Set();
    for (const re of [HELPER, DIRECT]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(body)) !== null) read.add(m[1]);
    }
    for (const key of read) {
      if (!declared.has(key)) {
        drift += 1;
        bad(
          tool.name + ' reads "' + key + '"',
          'schema declares {' + [...declared].join(', ') + '}'
        );
      }
    }
  }

  scanned === COACH_TOOLS.length
    ? ok('every registered tool literal was located and scanned (' + scanned + ')')
    : bad('tool literals not found', scanned + ' of ' + COACH_TOOLS.length);
  drift === 0
    ? ok('no schema/parser key drift across ' + COACH_TOOLS.length + ' tools')
    : bad('schema/parser drift', drift + ' mismatched keys');

  // The other half of the same contract.
  let undeclaredRequired = 0;
  for (const tool of COACH_TOOLS) {
    const declared = new Set(Object.keys(tool.inputSchema?.properties ?? {}));
    for (const key of tool.inputSchema?.required ?? []) {
      if (!declared.has(key)) {
        undeclaredRequired += 1;
        bad(tool.name + ' requires "' + key + '"', 'which its properties do not declare');
      }
    }
  }
  undeclaredRequired === 0
    ? ok('every required key is declared in properties')
    : bad('required/properties drift', String(undeclaredRequired));
}

console.log('33. nutrition targets: the shipped feature the Coach told the owner it lacked');
{
  // THE REPORT (2026-08-11). Asked "what do you think of my nutrition goals for
  // today?", the Coach answered: "I don't actually have a 'nutrition goals'
  // setting to check against — nothing in your profile or protocols defines a
  // kcal/protein/carb target." nutrition_targets shipped in 0015, the owner
  // edits it at app/nutrition-targets.tsx, and app/nutrition.tsx draws its macro
  // grid from it. No tool read the table, so the model reported its own
  // blindness as a fact about the product. These assertions are that reply,
  // turned into a failing condition.
  const { db, raw } = freshDb();
  const summary = (name, input) => toolByName(name).confirmSummary(input, db, CTX);

  const blank = run('get_today_snapshot', db).nutritionTargets;
  blank.set === false &&
  blank.note.includes('NOT set') &&
  blank.note.includes('set_nutrition_targets')
    ? ok('unset targets read as UNSET, and name the tool that sets them')
    : bad('blank targets', JSON.stringify(blank));
  const blankSummary = run('get_nutrition_summary', db);
  blankSummary.targets === null && typeof blankSummary.targetsNote === 'string'
    ? ok('get_nutrition_summary says targets are unset rather than staying silent')
    : bad('summary targets', JSON.stringify(blankSummary.targets));

  // The card carries every number being written — approving it writes all of it.
  summary('set_nutrition_targets', { kcal: 2400, protein_g: 180 }) ===
  'Set daily targets: 2400 kcal · 180 g protein'
    ? ok('set_nutrition_targets card names each target')
    : bad('targets card', summary('set_nutrition_targets', { kcal: 2400, protein_g: 180 }));

  const set = run('set_nutrition_targets', db, {
    kcal: 2400,
    protein_g: 180,
    notes: 'cut phase',
  });
  const row = raw.prepare('SELECT * FROM nutrition_targets').get();
  set.set === true &&
  set.effectiveFrom === TODAY &&
  row.created_by === 'ai' &&
  row.effective_date === TODAY &&
  row.notes === 'cut phase' &&
  row.carbs_g === null
    ? ok("the version lands effective today, stamped 'ai', with omitted macros NULL")
    : bad('targets row', JSON.stringify(row));

  // The day now counts DOWN, through the same functions the Eat tab uses.
  run('log_meal', db, { name: 'Eggs and oats', kcal: 600, protein_g: 40 });
  const counting = run('get_today_snapshot', db).nutritionTargets;
  counting.set === true &&
  counting.since === TODAY &&
  counting.setBy === 'you (the Coach)' &&
  counting.progress.kcal.remaining === 1800 &&
  counting.progress.protein_g.remaining === 140 &&
  counting.progress.carbs_g === undefined
    ? ok('the snapshot counts down each targeted macro, and only the targeted ones')
    : bad('countdown', JSON.stringify(counting.progress));

  // A meal logged with NO numbers must block the subtraction, not inflate it —
  // the Eat tab's own guard (src/lib/nutrition/remaining.ts), reused here so the
  // two surfaces cannot disagree about what is knowable.
  run('log_meal', db, { name: 'Handful of nuts' });
  const guarded = run('get_today_snapshot', db).nutritionTargets;
  guarded.progress.kcal.remaining === null &&
  guarded.progress.kcal.eaten === 600 &&
  typeof guarded.note === 'string'
    ? ok('an unpriced meal withholds the remainder and says why, never a false figure')
    : bad('guard', JSON.stringify(guarded));

  // Replacement is a version, not a patch: a DROP is the consequence approving
  // this can hide, so the card has to name it.
  const dropCard = summary('set_nutrition_targets', { protein_g: 200 });
  dropCard ===
  'Set daily targets: 200 g protein — was 2400 kcal · 180 g protein — drops the kcal target'
    ? ok('the card names what the new version DROPS')
    : bad('drop card', dropCard);

  throws(() => summary('set_nutrition_targets', {}))
    ? ok('an empty target set is refused before the card')
    : bad('empty set accepted');
  throws(() => summary('set_nutrition_targets', { kcal: 0 }))
    ? ok('0 is refused — every reader treats a non-positive target as no target')
    : bad('zero accepted');
  throws(() => summary('set_nutrition_targets', { protein_g: -5 }))
    ? ok('a negative target is refused')
    : bad('negative accepted');
  raw.prepare('SELECT count(*) c FROM nutrition_targets').get().c === 1
    ? ok('no rejected call wrote a row')
    : bad('rejected call wrote');

  const withTargets = run('get_nutrition_summary', db);
  withTargets.targets.kcal === 2400 &&
  withTargets.targets.protein_g === 180 &&
  withTargets.targets.setBy === 'you (the Coach)' &&
  withTargets.targetsNote === undefined &&
  // Reported ONCE. A per-day copy of an unchanged set is pure payload cost.
  withTargets.perDay.every((d) => d.target === undefined)
    ? ok('get_nutrition_summary carries the governing targets, once')
    : bad('summary targets', JSON.stringify(withTargets.targets));
}

console.log('34. screenings + appointments: the second domain no tool could see');
{
  const { db } = freshDb();
  const summary = (name, input) => toolByName(name).confirmSummary(input, db, CTX);
  const dayFrom = (offset) =>
    todayISODate(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + offset));

  const empty = run('get_screenings', db);
  empty.screenings.length === 0 && typeof empty.emptyNote === 'string'
    ? ok('an empty ledger reads as "none tracked", not as an absent feature')
    : bad('empty screenings', JSON.stringify(empty));

  const { addScreening, addAppointment, getScreening } =
    await import('../src/lib/db/repositories/screenings.ts');
  const colonoscopy = addScreening(db, {
    name: 'Colonoscopy',
    category: 'imaging',
    intervalMonths: 120,
    lastCompleted: '2016-01-01',
  });
  addScreening(db, {
    name: 'Skin check',
    category: 'derm',
    intervalMonths: 12,
    nextDue: dayFrom(10),
  });
  addScreening(db, {
    name: 'Dental cleaning',
    category: 'dental',
    intervalMonths: 6,
    nextDue: dayFrom(200),
  });
  const oneOff = addScreening(db, { name: 'Baseline echo', category: 'cardio' });
  addAppointment(db, {
    title: 'Annual physical',
    provider: 'Dr Reyes',
    scheduledAt: new Date(NOW.getTime() + 86400000).toISOString(),
  });
  addAppointment(db, {
    title: 'Derm follow-up',
    scheduledAt: new Date(NOW.getTime() - 86400000).toISOString(),
  });

  const ledger = run('get_screenings', db);
  const byName = Object.fromEntries(ledger.screenings.map((s) => [s.name, s]));
  byName['Colonoscopy'].status === 'overdue' &&
  byName['Skin check'].status === 'due' &&
  byName['Dental cleaning'].status === 'scheduled' &&
  // 'untracked' is its own state: a one-off with nothing after it. Calling that
  // "not due" would imply a cadence that is not there.
  byName['Baseline echo'].status === 'untracked'
    ? ok('overdue / due / scheduled / untracked are all distinguished')
    : bad('statuses', JSON.stringify(ledger.screenings));
  ledger.upcomingAppointments.length === 1 &&
  ledger.upcomingAppointments[0].title === 'Annual physical' &&
  /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2}$/.test(ledger.upcomingAppointments[0].when)
    ? ok('upcoming appointments come back with a readable local when')
    : bad('appointments', JSON.stringify(ledger.upcomingAppointments));
  ledger.pastBookingsStillOpen.length === 1 &&
  ledger.pastBookingsStillOpen[0].title === 'Derm follow-up' &&
  ledger.note.includes('log_screening_done')
    ? ok('a booking whose day passed unclosed is surfaced with the fix named')
    : bad('stale bookings', JSON.stringify(ledger.pastBookingsStillOpen));
  ledger.emptyNote === undefined ? ok('the empty note drops once data exists') : bad('emptyNote');

  // The card names the CONSEQUENCE — rolling a decennial screening moves the
  // next one by the same amount, and the user approves that date, not just the act.
  summary('log_screening_done', { id: colonoscopy, date: '2026-08-01' }) ===
  'Mark "Colonoscopy" done 2026-08-01 — next due 2036-08-01'
    ? ok('log_screening_done card names the date and the rolled next-due')
    : bad('screening card', summary('log_screening_done', { id: colonoscopy, date: '2026-08-01' }));
  summary('log_screening_done', { id: oneOff }).endsWith('— one-off, nothing scheduled after it')
    ? ok('a one-off card says nothing is scheduled after it')
    : bad('one-off card', summary('log_screening_done', { id: oneOff }));

  const done = run('log_screening_done', db, { id: colonoscopy, date: '2026-08-01' });
  const rolled = getScreening(db, colonoscopy);
  done.logged === true && rolled.last_completed === '2026-08-01' && rolled.next_due === '2036-08-01'
    ? ok('the cadence rolls from the date given, not the day of the tap')
    : bad('rolled screening', JSON.stringify(rolled));
  run('get_screenings', db).screenings.find((s) => s.name === 'Colonoscopy').status === 'scheduled'
    ? ok('the rolled screening leaves the overdue set')
    : bad('still overdue');

  throws(() => summary('log_screening_done', { id: 'nope' }))
    ? ok('an unknown screening id is refused before the card')
    : bad('unknown id accepted');
  throws(() => summary('log_screening_done', { id: colonoscopy, date: dayFrom(3) }))
    ? ok('a future completion date is refused — logs record what already happened')
    : bad('future date accepted');
  throws(() => run('log_screening_done', db, { id: colonoscopy, date: 'yesterday' }))
    ? ok('a non-ISO date is refused')
    : bad('bad date accepted');
}

console.log('35. save_knowledge_entry (docs/knowledge-subapp.md §6, migration 0038)');
{
  const { db } = freshDb();
  const summary = (name, input) => toolByName(name).confirmSummary(input, db, CTX);

  const tool = toolByName('save_knowledge_entry');
  tool ? ok('save_knowledge_entry is registered') : bad('save_knowledge_entry not registered');
  tool.readOnly === false
    ? ok('it is a WRITE tool, so every call goes through the confirmation gate')
    : bad('registered read-only');
  tool.inputSchema.additionalProperties === false
    ? ok('additionalProperties: false')
    : bad('schema is open');
  ['title', 'topic', 'body', 'section'].every((k) => tool.inputSchema.required.includes(k))
    ? ok('title, topic, body and section are all required')
    : bad('required keys', JSON.stringify(tool.inputSchema.required));
  // `section` is REQUIRED and not defaulted, deliberately (0044). A model that
  // omits it has usually just been told something about the USER, so the
  // convenient default — 'scientific', the DB's — is wrong in exactly the case
  // that matters: it would file a fact about his knee in with the articles.
  JSON.stringify(tool.inputSchema.properties.section.enum) ===
  JSON.stringify(['personal', 'scientific'])
    ? ok('section is a two-value enum, personal first')
    : bad('section enum', JSON.stringify(tool.inputSchema.properties.section));
  tool.inputSchema.properties.section.description === undefined
    ? ok('…with no per-property description — the two values are defined once, in the tool’s')
    : bad('section restates its own description (the duplication coach-eval §6 punishes)');
  /`personal`/.test(tool.description) && /`scientific`/.test(tool.description)
    ? ok('…and the tool description is where they are defined')
    : bad('the sections are not explained anywhere the model reads', tool.description);

  // The DOCTRINE that makes the compact card safe: the model must present the
  // body before calling. If that ever disappears, the card becomes a one-line
  // approval for a document the user never saw.
  //
  // It is pinned in TWO places with a deliberate split of labour, per the
  // prompt-budget rule in db/coach-eval.test.mjs §6 — the description carries
  // the TERSE form (it is what the model reads when deciding to call, and it is
  // billed per tool), the system prompt carries the full rail once (it is
  // cached, and the reasoning belongs where the other rails live). Both are
  // asserted, neither is allowed to carry the other's copy.
  /present the entry in your message first/i.test(tool.description)
    ? ok('the description tells the model to present the entry before calling')
    : bad('present-before-calling missing from the description');
  /only on their request or invitation/i.test(tool.description)
    ? ok('the description forbids proactive self-archiving')
    : bad('invitation-only rule missing');

  const entry = {
    title: 'Magnesium forms differ in absorption',
    topic: 'supplements',
    section: 'scientific',
    body:
      'Glycinate is generally better tolerated than citrate, which is notably laxative at ' +
      'the doses people actually take. Elemental magnesium per gram differs by form, so a ' +
      'dose stated in milligrams of compound is not a dose of magnesium.',
  };
  const card = summary('save_knowledge_entry', entry);
  // The section is ON THE CARD (0044): it decides which half of the base the
  // entry can be found in afterwards, and "personal" is the one the user would
  // want to catch being wrong before approving it.
  card === 'Save scientific entry "Magnesium forms differ in absorption" · supplements · 38 words'
    ? ok('the card is section · title · topic · word count')
    : bad('card wording', card);
  summary('save_knowledge_entry', { ...entry, section: 'personal' }).startsWith(
    'Save personal entry'
  )
    ? ok('…and a personal entry says so on the card')
    : bad(
        'personal card wording',
        summary('save_knowledge_entry', { ...entry, section: 'personal' })
      );
  throws(() => summary('save_knowledge_entry', { ...entry, section: 'medical' }))
    ? ok('a section outside the enum fails at the card, not at the DB CHECK')
    : bad('an unknown section reached the write path');

  const result = run('save_knowledge_entry', db, entry);
  result.saved === true && typeof result.id === 'string'
    ? ok('execute reports the save with the new id')
    : bad('execute result', JSON.stringify(result));

  const row = db.get('SELECT * FROM knowledge_entries WHERE id = ?', [result.id]);
  row && row.source === 'coach'
    ? ok("the row lands with source='coach' — provenance the user can see in the reader")
    : bad('row source', JSON.stringify(row));
  row.body === entry.body ? ok('the body round-trips verbatim') : bad('body altered');
  // BOTH values land. A section parameter the model can set but that the write
  // path ignores would be the worst of both — the model would believe it had
  // filed a personal fact and the user would never find it there.
  row.section === 'scientific'
    ? ok('the scientific section reaches the row')
    : bad('section not written', row.section);
  const personalRow = db.get('SELECT * FROM knowledge_entries WHERE id = ?', [
    run('save_knowledge_entry', db, {
      ...entry,
      title: 'How his gut reacts to magnesium',
      section: 'personal',
    }).id,
  ]);
  personalRow.section === 'personal'
    ? ok('…and so does the personal one')
    : bad('personal section not written', personalRow.section);

  // It goes through the SHARED repository path, so it is chunked and therefore
  // retrievable the moment it lands — a Coach-saved entry is indistinguishable
  // from a hand-written one downstream.
  const chunks = db.all('SELECT * FROM knowledge_chunks WHERE entry_id = ?', [result.id]);
  chunks.length > 0 && chunks.every((c) => c.source === 'user-knowledge' && c.pack_version === null)
    ? ok('chunks were written under the reserved source (the pack-protection invariant holds)')
    : bad('chunking did not happen through the shared path', JSON.stringify(chunks));

  throws(() => summary('save_knowledge_entry', { ...entry, title: '  ' }))
    ? ok('a blank title fails at the card, before costing an Approve tap')
    : bad('blank title accepted');
  throws(() => summary('save_knowledge_entry', { ...entry, body: '' }))
    ? ok('a blank body fails at the card')
    : bad('blank body accepted');

  // Still deliberately OUT (spec §6) — recorded here so adding one is a decision
  // someone has to make on purpose. Reading a knowledge entry stays
  // search_history's job, which returns the excerpt AND (C14) the id.
  !toolByName('get_knowledge_entry')
    ? ok('no get_knowledge_entry — search_history already returns knowledge excerpts')
    : bad('a read tool was added without the batched registry change');

  // === C14: the same tool REVISES, given an id ==============================
  //
  // The owner's requirement is read AND write on both stores, and this half was
  // write-once: the Coach could draft a page with him and then never correct it.
  // A revision resends the whole entry — `title`, `topic`, `body` and `section`
  // stay required — so what he approves on the card is the whole new text, and a
  // CREATE can still never arrive without a body.
  tool.inputSchema.properties.id && !tool.inputSchema.required.includes('id')
    ? ok('`id` is an OPTIONAL property: present = rewrite, absent = new entry')
    : bad('id is missing or required', JSON.stringify(tool.inputSchema.required));
  tool.inputSchema.properties.id.description === undefined
    ? ok('…carrying no description of its own — the tool’s last clause says what it does')
    : bad('id restates the tool description (coach-eval §6 duplication)');

  const revision = {
    id: result.id,
    title: 'Magnesium forms differ in absorption',
    topic: 'supplements',
    section: 'scientific',
    body: 'Glycinate over citrate. Citrate is laxative at the doses people take.',
  };
  const revisionCard = summary('save_knowledge_entry', revision);
  // The card must NOT read like the create card. Approving "Save …" for
  // something that silently replaces a page you already have is exactly the
  // failure a confirmation gate exists to prevent.
  revisionCard.startsWith('Rewrite scientific entry "Magnesium forms differ in absorption"')
    ? ok('a rewrite says REWRITE on the card, never "Save"')
    : bad('rewrite card wording', revisionCard);
  !revisionCard.includes('was “')
    ? ok('…and does not name an old title when the title did not change')
    : bad('noise on an unchanged title', revisionCard);
  summary('save_knowledge_entry', { ...revision, title: 'Magnesium, revisited' }).includes(
    'was “Magnesium forms differ in absorption”'
  )
    ? ok('…but does name it when the rewrite renames the entry')
    : bad('a rename hid the entry it replaces');
  throws(() => summary('save_knowledge_entry', { ...revision, id: 'nope' }))
    ? ok('an unknown id fails at the card, before costing an Approve tap')
    : bad('an unknown id reached the write path');
  /search_history/.test(
    (() => {
      try {
        summary('save_knowledge_entry', { ...revision, id: 'nope' });
        return '';
      } catch (e) {
        return e.message;
      }
    })()
  )
    ? ok('…and the error names where ids come from')
    : bad('the unknown-id error does not point at search_history');

  const revised = run('save_knowledge_entry', db, revision);
  revised.replaced === true && revised.id === result.id
    ? ok('execute reports a replacement, on the SAME id — no orphan second entry')
    : bad('revision result', JSON.stringify(revised));
  db.get('SELECT count(*) c FROM knowledge_entries WHERE title = ?', [revision.title]).c === 1
    ? ok('…and the base still holds one entry with that title, not two')
    : bad('the rewrite added a row instead of replacing one');
  db.get('SELECT body FROM knowledge_entries WHERE id = ?', [result.id]).body === revision.body
    ? ok('the new body is what is stored')
    : bad('body not replaced');
  // THE ONE THAT MATTERS. Chunks are what the Coach retrieves; a rewrite that
  // left the old passages behind would have the model citing a stance the user
  // retracted, out of an entry whose visible text no longer says it.
  db
    .all('SELECT body FROM knowledge_chunks WHERE entry_id = ?', [result.id])
    .every((c) => !/Elemental magnesium per gram/.test(c.body))
    ? ok('the OLD passages are gone — a rewrite cannot leave stale doctrine retrievable')
    : bad('stale chunks survived the rewrite');
}

console.log('36. the coverage manifest: the model is told what it CANNOT see');
{
  // WHY. The nutrition-targets reply was not a nutrition bug. From inside the
  // model's view — the tool schemas and nothing else — "no tool reads X" and
  // "ARC has no X" produce identical evidence, so the false answer and the true
  // one are indistinguishable at the point of speaking. No prompt instruction
  // fixes that: there is no observation to be careful with. The manifest is the
  // missing observation, and these assertions are what keep it true.
  const { buildCoverageManifest, coverageProblems, COACH_DOMAINS, UNCOVERED_DOMAINS } =
    await import('../src/lib/ai/tools/index.ts');
  const { buildCoachSystemPrompt } = await import('../src/lib/ai/system-prompt.ts');

  const problems = coverageProblems();
  problems.length === 0
    ? ok(`every registered tool is classified into a domain (${COACH_DOMAINS.length} domains)`)
    : bad('coverage drift', problems.join('; '));

  const manifest = buildCoverageManifest();
  const prompt = buildCoachSystemPrompt();
  prompt.includes(manifest)
    ? ok('the manifest reaches the system prompt verbatim')
    : bad('manifest not in prompt');
  manifest === buildCoverageManifest()
    ? ok('the manifest is byte-identical per call, so the cached prefix still hits')
    : bad('manifest not stable');
  UNCOVERED_DOMAINS.length > 0 && UNCOVERED_DOMAINS.every((d) => manifest.includes(d))
    ? ok(`all ${UNCOVERED_DOMAINS.length} blind spots are named to the model`)
    : bad('blind spots missing');
  manifest.includes('meals and nutrition targets') && manifest.includes('screenings')
    ? ok('the domains closed on this branch read as covered')
    : bad('new domains not in manifest');
  // The knowledge domain acquired a write tool with 0038, so the DERIVED
  // read/write split must have moved it on its own — nothing here is
  // hand-labelled, which is the whole point of generating the manifest.
  /Read and write:[^\n]*the knowledge base and past conversations/.test(manifest)
    ? ok('the knowledge domain moved to read-and-write when it gained save_knowledge_entry')
    : bad('knowledge domain not derived as writable', manifest);

  // The conflict doctrine and the memory/knowledge line are prompt text, not
  // schema, so nothing else would catch their removal.
  const promptText = buildCoachSystemPrompt();
  /cite BOTH, name the difference/.test(promptText)
    ? ok('the conflict doctrine (cite both, name the difference) is in the prompt')
    : bad('conflict doctrine missing from the prompt');
  /follow THEIR committed stance/.test(promptText)
    ? ok('…and the hierarchy: the user’s stance wins for personal coaching')
    : bad('conflict hierarchy missing');
  /[Pp]resent the drafted entry in full BEFORE calling/.test(promptText)
    ? ok('the present-before-calling rail is stated in full in the cached prompt')
    : bad('present-before-calling missing from the prompt');
  // The invitation-only rail moved out of this bullet and into its own on
  // 2026-09-19, where it now governs adjust_today, save_knowledge_entry AND
  // edit_record from one sentence — which is how the doctrine was funded
  // without raising a ceiling. Assert the RULE, and that it still names the
  // knowledge write, rather than the sentence it used to live in.
  /INVITATION ONLY\./.test(promptText) &&
  /never to tidy, never to file away your own output/.test(promptText) &&
  ['adjust_today', 'save_knowledge_entry', 'edit_record', 'delete_record'].every((t) =>
    new RegExp(`INVITATION ONLY[^\\n]*${t}`).test(promptText)
  )
    ? ok('one INVITATION ONLY bullet covers all four tools that act on the record')
    : bad('the invitation-only doctrine is missing or no longer names all four tools');
  // Q2(b) in the model's own copy: a record of a day is CORRECTED, not removed.
  /a record of a day is corrected, never removed/.test(promptText)
    ? ok('…and the deletion rule rides the same bullet, in one clause')
    : bad('the delete doctrine is missing');
  promptText.includes('"Magnesium citrate upsets his stomach" is a memory.')
    ? ok('the memory-vs-knowledge litmus is in the prompt verbatim')
    : bad('memory/knowledge litmus missing');
  // 0044 gave the model a SECOND place to put a fact about the user, so the
  // litmus needed its third leg. Without this line the Coach has two tools for
  // one sentence and picks between them arbitrarily — and the failure is
  // invisible, because either choice produces a plausible-looking write.
  /The split is LENGTH, not subject/.test(promptText)
    ? ok('…and the memory-vs-personal-entry rule is LENGTH, stated explicitly')
    : bad('the length rule is missing — the model has two tools for one sentence');
  ['"your record"', '"your knowledge"', '"ARC reference"'].every((l) => promptText.includes(l))
    ? ok('all three retrieval labels are named, so a citation can be read')
    : bad('retrieval labels missing from the prompt');
  /BLIND to, never proof the user lacks the feature/.test(manifest)
    ? ok('the rule is stated as a fact about evidence, not as an exhortation')
    : bad('rule missing');

  // The guard has to actually guard. Add a domain naming a tool that was never
  // registered and confirm the check fails — otherwise "0 problems" proves
  // nothing about a manifest that has drifted from the registry.
  COACH_DOMAINS.push({ label: 'a domain that does not exist', tools: ['no_such_tool'] });
  const caught = coverageProblems();
  COACH_DOMAINS.pop();
  caught.length === 1 && caught[0].includes('no_such_tool')
    ? ok('a manifest entry naming an unregistered tool fails the check')
    : bad('guard does not guard', JSON.stringify(caught));
  coverageProblems().length === 0 ? ok('and the registry is clean again') : bad('cleanup');
}

// ===========================================================================
// 37. `ml` and the Coach (0047, backlog B2).
//
// THE FINDING, recorded because it is the answer to "make the Coach's food and
// meal tools speak the unit": **no Coach tool carries a food portion at all.**
//
//   · `log_meal` writes a FREE-FORM meal — a name, a time and optional macro
//     totals. There is no amount on it to qualify, and `meals` has no portion
//     column for one to live in. Adding a `unit` here would be a property the
//     model can only mis-fill, describing a number that does not exist.
//   · `log_recipe` takes `grams` — the cooked weight of a DISH, against the
//     recipe's own `total_weight_g`. 0047 deliberately left `recipe_ingredients`
//     in grams (see its header), so that argument is still exactly grams.
//   · `save_recipe`'s ingredient `unit` is free text off the written line
//     ("1 cup milk") and is normalisation-only, never a conversion.
//
// So the honest change to the tool schemas is NO change, and the measured
// delta is 0 tokens on both ceilings — §6 above still reads 9,223 / 3,668.
// Nothing was raised and nothing had to be trimmed to pay for it.
//
// What DOES have to hold is that a millilitre meal is not invisible or
// distorted to a Coach that reads the day. That is what this section asserts,
// through the real tools against a real database.
// ===========================================================================
console.log('37. a millilitre meal reads correctly through the Coach’s eyes');
{
  const { createFood, getFood } = await import('../src/lib/db/repositories/foods.ts');
  const { logMealWithItems } = await import('../src/lib/db/repositories/nutrition.ts');
  const { itemForPortion } = await import('../src/lib/nutrition/servings.ts');
  const { db } = freshDb();
  const today = todayISODate();

  const milk = createFood(db, {
    name: 'Oat drink',
    basis: 'ml',
    kcal_100g: 46,
    protein_g_100g: 1,
    carbs_g_100g: 6.7,
    fat_g_100g: 1.5,
  });
  const oats = createFood(db, { name: 'Oats', kcal_100g: 379, protein_g_100g: 13 });
  logMealWithItems(db, {
    date: today,
    time: '08:00',
    name: 'Breakfast',
    items: [
      itemForPortion(getFood(db, milk), { amount: 250 }),
      itemForPortion(getFood(db, oats), { amount: 50 }),
    ],
  });

  // 250 ml × 0.46 = 115 kcal; 50 g × 3.79 = 189.5. The point is that they SUM —
  // kcal is the common currency, so the Coach never has to know about units to
  // count a day correctly, which is why no tool needed a new property.
  const snap = run('get_today_snapshot', db);
  near(snap.nutritionTotals.kcal, 304.5)
    ? ok('the day’s kcal include the drink — a millilitre item is not invisible to the Coach')
    : bad('snapshot totals', JSON.stringify(snap.nutritionTotals));
  near(snap.nutritionTotals.protein_g, 9)
    ? ok('and so do its macros (2.5 g from the drink, 6.5 g from the oats)')
    : bad('snapshot protein', JSON.stringify(snap.nutritionTotals));

  const summary = run('get_nutrition_summary', db, { days: 2 });
  const day = summary.perDay.find((d) => d.date === today);
  day && near(day.kcal, 304.5)
    ? ok('get_nutrition_summary counts the same day the same way')
    : bad('nutrition summary', JSON.stringify(summary.perDay));

  // And the tool the model WOULD reach for when the user says "I drank a
  // smoothie" is unchanged — it logs a free-form meal, with no portion to
  // mis-unit. Stated as an assertion so that adding an amount to this schema
  // later has to come past this line and the accounting above it.
  const logMealSchema = toolByName('log_meal').inputSchema.properties;
  !('unit' in logMealSchema) && !('grams' in logMealSchema) && !('amount' in logMealSchema)
    ? ok('log_meal still carries no portion at all, so it carries no unit either')
    : bad('log_meal grew a portion', JSON.stringify(Object.keys(logMealSchema)));
  toolByName('log_recipe').inputSchema.properties.grams.description.includes('Cooked grams')
    ? ok('log_recipe’s grams is still a dish weight in grams — 0047 left recipes alone')
    : bad('log_recipe grams description moved');
}

// ---------------------------------------------------------------------------
// B1 / 0046. "I ran 8k in 45 minutes" and "I held a plank for 90 seconds" are
// things the owner says out loud, and until now the Coach had nowhere to put
// either: log_workout took reps and a weight and nothing else.
console.log('37. log_workout carries time and distance, and the card promises the real row');
{
  const { db, raw } = freshDb();
  const tool = toolByName('log_workout');
  const summary = tool.confirmSummary(
    {
      kind: 'cardio',
      duration_min: 45,
      sets: [
        { exercise: 'Treadmill Run', duration_s: 2700, distance_m: 8000 },
        // The model guessing reps and a load onto a plank — the exact input the
        // repository's measure rule exists to refuse.
        { exercise: 'Plank', reps: 3, weight: 45, duration_s: 90 },
      ],
    },
    db
  );
  // The default distance preference is miles, so 8 km renders as 4.97 mi — the
  // card speaks the owner's units, exactly as the weight half already did.
  summary.includes('Treadmill Run 45:00 · 4.97 mi')
    ? ok(`the card shows the run's time and distance in display units ("${summary}")`)
    : bad('run summary', summary);
  // THE PROMISE. The model sent a plank 3 × 45 lb; the repository will store
  // neither. The card has to say what will actually land, or an Approve tap
  // approves a row that never existed.
  summary.includes('Plank 1:30') && !summary.includes('45 lb')
    ? ok('…and the plank line is masked to its 90 seconds, as the row will be')
    : bad('card promised fields the repository drops', summary);
  !/"/.test(summary) && summary.startsWith('Log workout ·')
    ? ok('…and no longer quotes an invented session name (the schema stopped asking)')
    : bad('name still in summary', summary);

  run('log_workout', db, {
    kind: 'cardio',
    duration_min: 45,
    sets: [
      { exercise: 'Treadmill Run', duration_s: 2700, distance_m: 8000 },
      { exercise: 'Plank', reps: 3, weight: 45, duration_s: 90 },
    ],
  });
  const rows = raw
    .prepare(
      'SELECT exercise, exercise_id, reps, weight_kg, duration_sec, distance_m FROM workout_sets ORDER BY set_index'
    )
    .all();
  const runRow = rows[0];
  runRow.exercise_id === 'treadmill-run' &&
  runRow.duration_sec === 2700 &&
  runRow.distance_m === 8000 &&
  runRow.reps === null &&
  runRow.weight_kg === null
    ? ok('a spoken run lands as seconds + metres against the catalog movement')
    : bad('run row', JSON.stringify(runRow));
  const plank = rows[1];
  plank.duration_sec === 90 && plank.reps === null && plank.weight_kg === null
    ? ok('…and the reps and load the model invented for a plank are dropped, not stored')
    : bad('plank row', JSON.stringify(plank));

  // The read side reports them back, so the Coach can answer "how far did I run
  // this week" from its own tool rather than from the conversation.
  const training = JSON.parse(toolByName('get_training_summary').execute(db, {}, { now: NOW }));
  const session = training.recentSessions[0];
  session.setMetres === 8000 && session.setSeconds === 2790
    ? ok('get_training_summary reports the session’s summed metres and seconds')
    : bad('training read', JSON.stringify(session));
}

console.log('37. retiring a knowledge entry (C14, folded into edit_record 2026-09-19)');
{
  const { db } = freshDb();

  // `retire_knowledge_entry` was its own tool until the 2026-09-19 fold. What
  // that tool argued for was the CARD — "taking something out of the base is
  // not a smaller version of putting something in it" — and every assertion
  // below is about the card, the archive and the search, which is why they all
  // still read the same. Only the tool name beneath changed.
  const id = run('save_knowledge_entry', db, {
    title: 'Zone 2 three times a week',
    topic: 'training',
    section: 'scientific',
    body: 'Three ninety-minute sessions a week, conversational pace, heart rate capped.',
  }).id;

  const card = editCard(db, 'knowledge', id, { status: 'archived' });
  card === 'Retire entry "Zone 2 three times a week"'
    ? ok('the card names the entry by title, not by id — verbatim from the old tool')
    : bad('card wording', card);
  toolByName('edit_record').confirmMeta(
    { domain: 'knowledge', id, fields: { status: 'archived' } },
    db,
    { now: NOW }
  ).selfEvident === false
    ? ok('…and it keeps its consequence lanes: retiring is never self-evident')
    : bad('retiring went brief');
  throws(() => editCard(db, 'knowledge', 'nope', { status: 'archived' }))
    ? ok('an unknown id fails at the card')
    : bad('unknown id accepted');
  // The knowledge domain has NO create path — `save_knowledge_entry` owns it —
  // so C14's schema objection (a flag would make title and body optional)
  // cannot arise here: nothing in edit_record can mint a bodiless entry.
  throws(() => editCard(db, 'knowledge', id, { title: 'Renamed' }))
    ? ok('edit_record cannot rewrite an entry’s text — that is save_knowledge_entry’s')
    : bad('knowledge text edited through the generic path');

  const out = edit(db, 'knowledge', id, { status: 'archived' });
  out.edited === true ? ok('execute reports the retirement') : bad(JSON.stringify(out));
  db.get('SELECT archived_at FROM knowledge_entries WHERE id = ?', [id]).archived_at !== null
    ? ok('the row is archived — SOFT, so the user can restore what the Coach retired')
    : bad('the entry was not archived');
  db.all('SELECT * FROM knowledge_chunks WHERE entry_id = ?', [id]).length === 0
    ? ok('…and its chunks are gone, so it leaves every search with no archived_at join')
    : bad('a retired entry is still retrievable');
  searchUserHistory(db, 'zone conversational pace').length === 0
    ? ok('search_history confirms it: a retired entry cannot be cited again')
    : bad('a retired entry still comes back from search');

  // Restoring is the USER's. The domain accepts one value, so a model that
  // wants the page back has to ask for it rather than take it.
  throws(() => editCard(db, 'knowledge', id, { status: 'active' }))
    ? ok('there is no un-retire: `archived` is the only value the domain accepts')
    : bad('the Coach can un-retire an entry');
}

console.log('38. the id bridge (C14): a search hit the Coach can actually write back to');
{
  const { db } = freshDb();
  // Before C14 a search hit was a DEAD END for both stores: the Coach could read
  // an entry and had no way to name it again, and a memory past the prompt's 40
  // could be found by text and never forgotten. "Read and write on both stores"
  // was half-true, and the missing half was the id.
  const entryId = run('save_knowledge_entry', db, {
    title: 'Creatine at 5 g, daily, no loading',
    topic: 'supplements',
    section: 'scientific',
    body: 'Five grams daily, every day, no loading phase. Timing does not matter.',
  }).id;
  const memoryId = rememberFact(db, {
    content: 'Creatine gives him no stomach trouble at 5 g',
    category: 'context',
  });
  ingestCorpus(db);

  const hits = searchUserHistory(db, 'creatine loading stomach', 20);
  const entryHit = hits.find((h) => /your knowledge/.test(h.source));
  entryHit?.id === entryId
    ? ok('a knowledge hit carries the ENTRY id — the address the write tools take')
    : bad('entry hit id', JSON.stringify(entryHit));
  const memoryHit = hits.find((h) => /^remembered/.test(h.source));
  memoryHit?.id === memoryId
    ? ok('a memory hit carries its id, so `forget` can reach past the prompt’s 40')
    : bad('memory hit id', JSON.stringify(memoryHit));

  // The pack is the user's to READ and never to revise, and the absent id is
  // what enforces it — there is no address to hand a write tool.
  const packHits = searchUserHistory(db, 'apob', 20).filter((h) => /ARC reference/.test(h.source));
  packHits.length > 0 && packHits.every((h) => h.id === undefined)
    ? ok('ARC’s shipped pack carries NO id — it is not the user’s to rewrite or retire')
    : bad('a pack hit offered a writable id', JSON.stringify(packHits));

  // And the id survives the round trip through the tool, which is the only path
  // the model actually sees.
  const toolHits = run('search_history', db, { query: 'creatine loading' }).results;
  toolHits.some((h) => h.id === entryId)
    ? ok('search_history’s own payload carries it — read leads to write in one call')
    : bad('the tool dropped the id', JSON.stringify(toolHits));
}

console.log('38. the double-count: one session, two tools, counted once (0054)');
{
  // THE DEFECT THIS PINS. The Coach reads ingested minutes through the `workout`
  // metric AND reads `workouts` through get_training_summary. A session logged in
  // ARC and also recorded by the watch appeared in both, and nothing could tell —
  // asked "how much did I train yesterday", the model could answer 100 minutes
  // for one 60-minute lift and a 40-minute walk.
  const { db } = freshDb();
  // The registry's own clock (CTX/TODAY), so the tools' "today" and this
  // fixture's day are the same day by construction.
  const DAY = TODAY;
  const lift = { start: new Date(NOW.getTime() - 3 * 3_600_000), minutes: 60 };
  const walk = { start: new Date(NOW.getTime() - 10 * 3_600_000), minutes: 40 };
  const span = (s, m) => ({
    startTime: s.toISOString(),
    endTime: new Date(s.getTime() + m * 60_000).toISOString(),
  });

  // The owner logs the lift; the watch records the same hour, plus a walk ARC
  // knows nothing else about.
  logWorkout(db, {
    date: DAY,
    kind: 'strength',
    durationMin: lift.minutes,
    startedAt: lift.start.toISOString(),
  });
  upsertWearableRows(db, [
    {
      date: DAY,
      metricType: 'workout',
      value: lift.minutes,
      unit: 'min',
      sourceDevice: 'garmin',
      sourceRawId: 'watch-lift',
      ...span(lift.start, lift.minutes),
      metadata: { activity: 'Strength training', activity_type_raw: 50, kcal: 410 },
    },
    {
      date: DAY,
      metricType: 'workout',
      value: walk.minutes,
      unit: 'min',
      sourceDevice: 'garmin',
      sourceRawId: 'watch-walk',
      ...span(walk.start, walk.minutes),
      metadata: { activity: 'Walking', activity_type_raw: 52, kcal: 120 },
    },
  ]);

  // The day is still accumulating, so it rides in `points` (flagged partial) and
  // is deliberately held out of `stats` — read the point, which is the number the
  // model is shown.
  const ingestedMinutes = (payload) => payload.points.find((p) => p.date === DAY)?.value;

  const beforeSeries = run('get_metric_series', db, { metric: 'workout', days: 2 });
  near(ingestedMinutes(beforeSeries), 100, 0.5)
    ? ok('unpaired, the ingested metric reports 100 min — the hour ARC logged, counted twice')
    : bad('pre-pair ingested minutes', JSON.stringify(beforeSeries.points));

  pairIngestedWorkouts(db, NOW);

  const series = run('get_metric_series', db, { metric: 'workout', days: 2 });
  near(ingestedMinutes(series), 40, 0.5)
    ? ok('paired, it reports 40 — only the walk ARC has no log for')
    : bad('post-pair ingested minutes', JSON.stringify(series.points));
  /not also logged in ARC|NOT also logged/i.test(series.aggregation) ||
  /not logged in ARC/i.test(series.label)
    ? ok('…and the payload says so in words, where the model reads the number')
    : bad('series provenance wording', `${series.label} / ${series.aggregation}`);

  const summary = run('get_training_summary', db, { days: 7 });
  summary.totals.minutes === 60 && summary.totals.sessions === 1
    ? ok('get_training_summary still counts the logged hour exactly once')
    : bad('summary totals', JSON.stringify(summary.totals));
  summary.ingestedSessions?.length === 1 && summary.ingestedSessions[0].minutes === 40
    ? ok('…and lists the watch-only walk separately, so nothing is lost')
    : bad('ingestedSessions', JSON.stringify(summary.ingestedSessions));
  summary.ingestedSessions[0].kcal === 120 && summary.ingestedSessions[0].source === 'Garmin'
    ? ok('the unpaired session carries what the watch measured, named by source')
    : bad('ingested session fields', JSON.stringify(summary.ingestedSessions[0]));

  // 60 (from `workouts`) + 40 (from `wearable_data`) = 100 real minutes, and the
  // same hour appears in exactly one of the two.
  near(summary.totals.minutes + ingestedMinutes(series), 100, 0.5)
    ? ok('the two tools now sum to the truth instead of over-reporting it')
    : bad('sum across tools', summary.totals.minutes + ingestedMinutes(series));

  // The snapshot reads the same de-duplicated number.
  const snapshot = run('get_today_snapshot', db, {});
  const shown = snapshot.wearables?.today?.workout;
  shown == null || near(shown.value, 40, 0.5)
    ? ok('today’s snapshot reports the same de-duplicated ingested minutes')
    : bad('snapshot workout minutes', JSON.stringify(shown));
}

// ---------------------------------------------------------------------------
// C13 (0055). The Coach's whole share of the away-gym feature: it needs no
// arithmetic, only to be TOLD, or it reads a travel week's lighter loads as a
// decline and says so — which is the complaint the feature answers.
console.log('42. get_training_summary carries the away flag, and the tool says what it means');
{
  const { db } = freshDb();
  logWorkout(db, { date: todayISODate(NOW), kind: 'strength', durationMin: 40 }, [
    { exercise: 'Bench', exerciseId: 'barbell-bench-press', reps: 5, weightKg: 100 },
  ]);
  logWorkout(db, { date: isoDaysAgo(NOW, 1), kind: 'strength', durationMin: 35, away: true }, [
    { exercise: 'Bench', exerciseId: 'barbell-bench-press', reps: 5, weightKg: 70 },
  ]);
  const summary = JSON.parse(toolByName('get_training_summary').execute(db, {}, { now: NOW }));
  const [today, yesterday] = summary.recentSessions;
  yesterday.away === true
    ? ok('the away session comes back flagged')
    : bad('away missing from the read', JSON.stringify(yesterday));
  // Omitted, not `false`: almost every session is at the usual gym, and ten
  // rows each carrying "away": false is twenty tokens of "no".
  'away' in today === false
    ? ok('…while an ordinary session carries no field at all')
    : bad('home session pays for the flag', JSON.stringify(today));
  // The payload is useless without the sentence. A model that sees `away: true`
  // and has not been told what it means will still call 70 kg a regression.
  const description = toolByName('get_training_summary').description;
  /away: true/.test(description) && /regression/.test(description)
    ? ok('the tool description tells the model not to read those loads as a regression')
    : bad('no away doctrine in the description', description);
}

// ---------------------------------------------------------------------------
// D3b (docs §15). The Coach's whole share of in-workout heart rate: the numbers,
// and NO sentence in the tool description. The judgment — what 142 means for
// this person at this load — belongs in the model, which holds the session list,
// the resting-HR baseline and the owner's age (or the turn context's "profile
// not filled in", which is what tells it to ask).
console.log('43. get_training_summary carries the watch’s heart rate, on both lists');
{
  const { db } = freshDb();
  const DAY = TODAY;
  const lift = { start: new Date(NOW.getTime() - 3 * 3_600_000), minutes: 60 };
  const walk = { start: new Date(NOW.getTime() - 10 * 3_600_000), minutes: 40 };
  const span = (s, m) => ({
    startTime: s.toISOString(),
    endTime: new Date(s.getTime() + m * 60_000).toISOString(),
  });

  logWorkout(db, {
    date: DAY,
    kind: 'strength',
    durationMin: lift.minutes,
    startedAt: lift.start.toISOString(),
  });
  // A third session the owner logged that the watch never saw — the row that
  // proves the field is omitted rather than nulled. It carries a START TIME, of
  // an hour neither watch record touches, and that is load-bearing since the day
  // rule landed (2026-09-21): a session with no start time on a day the watch
  // recorded something IS a pairing candidate now, so "the watch never saw it"
  // has to be said with a clock rather than assumed from a silence.
  logWorkout(db, {
    date: DAY,
    kind: 'strength',
    durationMin: 25,
    startedAt: new Date(NOW.getTime() - 6 * 3_600_000).toISOString(),
  });
  upsertWearableRows(db, [
    {
      date: DAY,
      metricType: 'workout',
      value: lift.minutes,
      unit: 'min',
      sourceDevice: 'garmin',
      sourceRawId: 'watch-lift',
      ...span(lift.start, lift.minutes),
      metadata: {
        activity: 'Strength training',
        activity_type_raw: 50,
        kcal: 410,
        hr: { avg: 128, max: 162, method: 'workout' },
      },
    },
    {
      date: DAY,
      metricType: 'workout',
      value: walk.minutes,
      unit: 'min',
      sourceDevice: 'garmin',
      sourceRawId: 'watch-walk',
      ...span(walk.start, walk.minutes),
      metadata: {
        activity: 'Walking',
        activity_type_raw: 52,
        kcal: 120,
        hr: { avg: 96, max: 118, method: 'source' },
      },
    },
  ]);
  pairIngestedWorkouts(db, NOW);

  const summary = run('get_training_summary', db, { days: 7 });
  const paired = summary.recentSessions.find((s) => s.duration_min === lift.minutes);
  const unwatched = summary.recentSessions.find((s) => s.duration_min === 25);

  paired?.hr?.avg === 128 && paired.hr.max === 162
    ? ok('a paired session carries the watch’s average and peak, read through the 0054 link')
    : bad('paired hr in the payload', JSON.stringify(paired));
  // Omitted, not nulled — the rule this file already applies to `away`,
  // `setSeconds` and `setMetres`. Ten sessions each carrying two explicit nulls
  // is twenty tokens of "no".
  unwatched && 'hr' in unwatched === false
    ? ok('…while a session the watch never saw carries no field at all')
    : bad('unwatched session pays for the field', JSON.stringify(unwatched));
  summary.ingestedSessions?.[0]?.hr?.avg === 96
    ? ok('the watch-only walk carries its own figure on the ingested list')
    : bad('ingested hr', JSON.stringify(summary.ingestedSessions));

  // The id is a JOIN KEY, not payload: selecting it is what lets the pair be
  // read for the whole page in one statement, and emitting it would be ten rows
  // of UUID the model can do nothing with.
  'id' in (paired ?? {}) === false
    ? ok('…and the workout id stays out of the payload — it is a join key, not a fact')
    : bad('workout id leaked into the payload');

  // NOT a description change. The schema sits single digits under its ceiling
  // (coach-eval §6), the fields are self-describing, and a sentence telling the
  // model how to read a heart rate would be the clinical judgment the house
  // rule keeps out of code. Deferred until a transcript shows it is needed.
  const description = toolByName('get_training_summary').description;
  /heart rate|bpm|\bhr\b/i.test(description) === false
    ? ok('the tool description says nothing about heart rate — payload only, no schema cost')
    : bad('a heart-rate sentence entered the description', description);
}

console.log('44. the Plan screen is payload-only: `doneOn` and `ahead`, both omitted by default');
{
  const { db } = freshDb();
  const protocolId = createProtocolWithVersion(
    db,
    // Anchored three days back, so YESTERDAY is inside the protocol's own run
    // and can be generated — a backfill needs a row that existed to be missed.
    { name: 'Evening stack', type: 'supplement_stack', startedOn: shiftISODate(TODAY, -3) },
    {
      schema: 2,
      phases: [
        {
          id: 'p1',
          title: null,
          duration_days: null,
          items: [
            {
              id: 'mag',
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
  generateMissionForDay(db, TODAY);

  // THE DEFAULT SHAPE. An ordinary day carries neither field — that is what
  // makes the token delta zero in practice as well as by construction.
  const plain = run('get_today_snapshot', db);
  'ahead' in plain === false
    ? ok('an ordinary day emits no `ahead` array at all')
    : bad('`ahead` was emitted empty', JSON.stringify(plain.ahead));
  plain.mission.every((m) => !('doneOn' in m))
    ? ok('…and no mission row carries `doneOn`')
    : bad('doneOn on an untouched row', JSON.stringify(plain.mission));

  // An ORDINARY tick, made on the day it belongs to, still carries nothing:
  // `doneOn` states a DIFFERENCE, and there is none.
  const todayRow = db.get(
    `SELECT e.id FROM log_entries e JOIN daily_logs d ON d.id = e.daily_log_id
      WHERE d.date = ? AND e.title = 'Magnesium'`,
    [TODAY]
  );
  setMissionStatus(db, todayRow.id, 'completed', TODAY);
  run('get_today_snapshot', db).mission.every((m) => !('doneOn' in m))
    ? ok('…and a tick made on its own day still carries none')
    : bad('doneOn on a same-day tick');

  // A DAY AHEAD, committed by one tick on the Plan screen.
  const tomorrow = shiftISODate(TODAY, 1);
  const plan = planForDay(db, tomorrow, { today: TODAY });
  commitDayAhead(db, tomorrow, TODAY, {
    ordinal: 0,
    expect: { title: plan[0].title, protocolId: plan[0].protocolId, itemId: plan[0].extras.item },
  });
  const withAhead = run('get_today_snapshot', db);
  Array.isArray(withAhead.ahead) &&
  withAhead.ahead.length === 1 &&
  withAhead.ahead[0].day === tomorrow &&
  withAhead.ahead[0].title === 'Magnesium' &&
  withAhead.ahead[0].protocol === 'Evening stack'
    ? ok('a row ticked on a day ahead appears in `ahead` with its day, title and protocol')
    : bad('ahead payload', JSON.stringify(withAhead.ahead));
  // Today's own rows are untouched by it: `ahead` is about days that have not
  // happened, and the mission array is still today.
  withAhead.mission.every((m) => !('doneOn' in m))
    ? ok('…while today’s mission array is unchanged')
    : bad('the commit leaked into today', JSON.stringify(withAhead.mission));

  // A BACKFILL. Yesterday's untouched row, ticked this morning: the day it
  // belongs to is yesterday, and the day it was recorded is today.
  const yesterday = shiftISODate(TODAY, -1);
  generateMissionForDay(db, yesterday);
  const pastRow = db.get(
    `SELECT e.id FROM log_entries e JOIN daily_logs d ON d.id = e.daily_log_id
      WHERE d.date = ? AND e.title = 'Magnesium'`,
    [yesterday]
  );
  backfillPastRow(db, pastRow.id, TODAY) === 'ok'
    ? ok('a pending original inside the window can be backfilled')
    : bad('the backfill was refused');
  // It sits under YESTERDAY, so it is not in today's mission array at all —
  // which is the honest reading, and why `doneOn` rides the row rather than
  // becoming a second list. `ahead` is about the days that have NOT happened
  // and is unmoved by a correction to one that has.
  const afterBackfill = run('get_today_snapshot', db);
  afterBackfill.date === TODAY &&
  afterBackfill.mission.every((m) => m.title !== 'Magnesium' || !('doneOn' in m)) &&
  afterBackfill.ahead.length === 1 &&
  afterBackfill.ahead[0].day === tomorrow
    ? ok('…and a correction to a past day moves neither today’s rows nor `ahead`')
    : bad('the backfill leaked into the snapshot', JSON.stringify(afterBackfill.ahead));
  // The tool's DESCRIPTION did not move. Payload only — the two ceilings in
  // coach-eval §6 guard the cached prefix, and nothing was added to it.
  const description = toolByName('get_today_snapshot').description;
  /ahead|doneOn|day picker|plan screen/i.test(description) === false
    ? ok('the tool description says nothing about either field — payload, not schema')
    : bad('a sentence about the day picker entered the description', description);
}

// ---------------------------------------------------------------------------
// The day rule (2026-09-21). §41 proved the de-duplication for a SPAN pair; the
// whole risk of a second pairing rule is that it makes a link the readers do not
// recognise as one, and the same hour starts appearing in two tools again. It
// cannot here, because the predicate is "is there a link" and never "how was it
// made" — but that is exactly the kind of thing that stays true only while
// somebody checks.
console.log('45. a DAY-paired session is counted once too, and the payload says how it paired');
{
  const { db } = freshDb();
  const DAY = TODAY;
  // LOCAL wall-clock instants on DAY. The day rule compares an ARC session's
  // logical day against an ingested session's, so a fixture built as an offset
  // from `new Date()` would land on yesterday whenever the suite happens to run
  // in the small hours — a test that passes by time of day is not a test.
  const at = (hour) => {
    const [y, m, d] = DAY.split('-').map(Number);
    return new Date(y, m - 1, d, hour, 0, 0, 0);
  };
  const lift = { start: at(13), minutes: 60 };
  const walk = { start: at(7), minutes: 40 };
  const span = (s, m) => ({
    startTime: s.toISOString(),
    endTime: new Date(s.getTime() + m * 60_000).toISOString(),
  });

  // The owner logs the lift the way he actually logs it — after the fact, with
  // no start time. The watch recorded the same hour, and a walk besides.
  logWorkout(db, { date: DAY, kind: 'strength', durationMin: lift.minutes }, [
    { exercise: 'Bench', exerciseId: 'barbell-bench-press', reps: 5, weightKg: 100 },
  ]);
  upsertWearableRows(db, [
    {
      date: DAY,
      metricType: 'workout',
      value: lift.minutes,
      unit: 'min',
      sourceDevice: 'garmin',
      sourceRawId: 'watch-lift',
      ...span(lift.start, lift.minutes),
      metadata: { activity: 'Strength training', activity_type_raw: 50, kcal: 410 },
    },
    {
      date: DAY,
      metricType: 'workout',
      value: walk.minutes,
      unit: 'min',
      sourceDevice: 'garmin',
      sourceRawId: 'watch-walk',
      ...span(walk.start, walk.minutes),
      metadata: { activity: 'Walking', activity_type_raw: 52, kcal: 120 },
    },
  ]);

  pairIngestedWorkouts(db, NOW);

  const ingestedMinutes = (payload) => payload.points.find((p) => p.date === DAY)?.value;
  const series = run('get_metric_series', db, { metric: 'workout', days: 2 });
  near(ingestedMinutes(series), 40, 0.5)
    ? ok('the ingested metric reports 40 — the logged hour is subtracted by a DAY link too')
    : bad('day-paired ingested minutes', JSON.stringify(series.points));

  const summary = run('get_training_summary', db, { days: 7 });
  summary.totals.minutes === 60 && summary.totals.sessions === 1
    ? ok('…and get_training_summary still counts that hour exactly once')
    : bad('summary totals', JSON.stringify(summary.totals));
  near(summary.totals.minutes + ingestedMinutes(series), 100, 0.5)
    ? ok('…so the two tools sum to the 100 minutes that really happened')
    : bad('sum across tools', summary.totals.minutes + ingestedMinutes(series));
  summary.ingestedSessions?.length === 1 && summary.ingestedSessions[0].minutes === 40
    ? ok('the walk is still listed separately — de-duplication never means deletion')
    : bad('ingestedSessions', JSON.stringify(summary.ingestedSessions));

  // The one thing the model should read differently: this pair was made from a
  // date and a close duration, with no clock behind it.
  const paired = summary.recentSessions.find((s) => s.duration_min === lift.minutes);
  paired?.watchPairedBy === 'same day'
    ? ok('…and the row says HOW it was matched, so its calories are held a little loosely')
    : bad('watchPairedBy missing', JSON.stringify(paired));

  // A SPAN pair carries no such field: it shares a clock and needs no caveat.
  // Omitted rather than spelled out, the rule this payload applies throughout.
  const { db: db2 } = freshDb();
  logWorkout(db2, {
    date: DAY,
    kind: 'strength',
    durationMin: lift.minutes,
    startedAt: lift.start.toISOString(),
  });
  upsertWearableRows(db2, [
    {
      date: DAY,
      metricType: 'workout',
      value: lift.minutes,
      unit: 'min',
      sourceDevice: 'garmin',
      sourceRawId: 'watch-lift',
      ...span(lift.start, lift.minutes),
      metadata: { activity: 'Strength training', activity_type_raw: 50, kcal: 410 },
    },
  ]);
  pairIngestedWorkouts(db2, NOW);
  const spanned = run('get_training_summary', db2, { days: 7 }).recentSessions[0];
  spanned && 'watchPairedBy' in spanned === false
    ? ok('a span pair carries no field at all — only the weaker match pays for one')
    : bad('span pair grew a field', JSON.stringify(spanned));
}

// Owner, 2026-09-23: "workout duration should be editable." The session screen
// writes the figure through replaceWorkout, and the Coach reads the column at
// query time — so the corrected minutes are what its next training read carries.
console.log('46. a duration corrected on the session screen is what the Coach reads');
{
  const { db } = freshDb();
  const id = logWorkout(db, { date: TODAY, kind: 'cardio', durationMin: 20 });
  replaceWorkout(db, id, { kind: 'cardio', durationMin: 45 }, []);
  const training = run('get_training_summary', db, { days: 7 });
  training.recentSessions[0]?.duration_min === 45 && near(training.totals.cardioMinutes, 45)
    ? ok('get_training_summary carries the corrected 45 min, in the list and in the totals')
    : bad('coach duration', JSON.stringify(training));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
