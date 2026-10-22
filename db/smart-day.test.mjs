/**
 * Headless test of SMART DAY (items 77/78, docs/spikes/smart-day.md, built
 * under the owner's correction of 2026-10-21: nothing hard-coded — the
 * deterministic layer gathers FACTS and the Coach decides the top of Home).
 *
 *   1. the facts builder — fixtures, the logical day, timezone days, and that
 *      no line it writes is an instruction
 *   2. the PLAN parser — valid lines, junk, too many, unknown destinations, a
 *      stale UNTIL, the scaffolding a model wraps round them, SKIP beside them
 *   3. the plan against the record — the top of Home, every transition and the
 *      event it records, a pinned row that no longer exists, replacement, a
 *      plan from yesterday
 *   4. uncounted: the mission, its tally and every adherence function read the
 *      same with a plan and its history as without
 *   5. the 14-day summary, as counts
 *   6. the pass: the block rides the directive (measured), the reply's lines
 *      are parsed out and validated, the chat prompt does not move
 *   7. the turn context names what Home actually shows
 *   8. the status rule: nothing here reads day_statuses
 *
 * op-sqlite is never loaded and no network call is made — the model is a
 * scripted stream. Run: npm run db:test.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { logicalDate, logicalDayUtcRange, shiftISODate, todayISODate } from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  getOrCreateDailyLog,
  insertMissionItem,
  listMission,
  missionAdherence,
  missionDailySeries,
  setMissionStatus,
} from '../src/lib/db/repositories/mission.ts';
import { generateMissionForDay } from '../src/lib/db/repositories/mission-generate.ts';
import { createProtocolWithVersion } from '../src/lib/db/repositories/protocols.ts';
import { protocolAdherence } from '../src/lib/db/repositories/protocol-adherence.ts';
import { createReminder, completeReminder } from '../src/lib/db/repositories/reminders.ts';
import { createRoutine } from '../src/lib/db/repositories/routines.ts';
import { buildDayFacts, dayFactsLines, daysBetween } from '../src/lib/home/day-facts.ts';
import {
  ACTION_SPEC,
  destinationHref,
  evaluatePlan,
  homeTop,
  msUntilNextExpiry,
  PLAN_ACTIONS,
  shownKeys,
  summarizePlanEvents,
  toCoachItemView,
} from '../src/lib/home/day-plan.ts';
import { setNightOutDrinks } from '../src/lib/db/repositories/nutrition.ts';
import { deriveMissionView } from '../src/lib/home/derive-mission.ts';
import { parsePlanReply, resolvePlan, planInstructions } from '../src/lib/home/plan-lines.ts';
import * as plan from '../src/lib/db/repositories/day-plan.ts';
import { snoozeItem, unsnoozeItem } from '../src/lib/home/snooze-store.ts';
import { buildTurnContext } from '../src/lib/ai/turn-context.ts';
import { buildCoachSystemPrompt } from '../src/lib/ai/system-prompt.ts';
import { passDirective, runCoachPass } from '../src/lib/ai/coach-pass.ts';

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
const check = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));

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

// Noon today, so no fixture straddles a day boundary whenever the suite runs.
const NOW = new Date();
NOW.setHours(12, 0, 0, 0);
const TODAY = todayISODate(NOW);
const ZERO = '00:00';
const at = (minutes) => new Date(NOW.getTime() + minutes * 60_000);
const iso = (minutes) => at(minutes).toISOString();

/** A bare fact input, everything empty. */
function emptyInput(over = {}) {
  return {
    now: NOW,
    today: TODAY,
    dayStartsAt: ZERO,
    mission: [],
    snoozed: new Set(),
    weighIns: [],
    meals: [],
    pendingEstimates: 0,
    sleepEnd: null,
    water: { ml: 0, entries: 0 },
    workoutsToday: [],
    liveSession: null,
    routines: [],
    reminders: [],
    appointments: [],
    screenings: [],
    experiments: [],
    ...over,
  };
}

/** Local noon on `day` minus/plus minutes — an instant on that logical day under a midnight boundary. */
function onDay(day, hh, mm = 0) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0).toISOString();
}

// ---------------------------------------------------------------------------
console.log('1. the facts builder: facts, and nothing that is an instruction');
{
  const rows = [
    {
      id: 'a',
      title: 'Creatine',
      scheduledTime: '07:30',
      category: 'Supplements',
      dose: '5 g',
      status: 'completed',
    },
    {
      id: 'b',
      title: 'Strength session',
      scheduledTime: '17:30',
      category: 'Training',
      status: 'pending',
    },
    {
      id: 'c',
      title: 'Magnesium',
      scheduledTime: '21:30',
      category: 'Supplements',
      status: 'pending',
    },
    { id: 'd', title: 'Mobility', scheduledTime: '08:00', category: 'Training', status: 'partial' },
    { id: 'e', title: 'Read', category: 'Routine', status: 'skipped' },
  ];
  const facts = buildDayFacts(
    emptyInput({
      mission: rows,
      snoozed: new Set(['c']),
      weighIns: [
        onDay(shiftISODate(TODAY, -1), 7, 5),
        onDay(shiftISODate(TODAY, -4), 7),
        onDay(shiftISODate(TODAY, -7), 6, 50),
      ],
      meals: [
        { date: shiftISODate(TODAY, -1), time: '19:40', kcal: 800, protein_g: 50 },
        { date: TODAY, time: '08:15', kcal: 420.4, protein_g: 31.6 },
        { date: TODAY, time: null, kcal: 100, protein_g: null },
      ],
      pendingEstimates: 1,
      sleepEnd: onDay(TODAY, 6, 48),
      water: { ml: 500, entries: 2 },
      liveSession: { name: 'Upper A', startedAt: at(-30).getTime() },
      routines: [
        { id: 'r-lower', name: 'Lower B', lastStartedAt: null },
        { id: 'r-upper', name: 'Upper A', lastStartedAt: onDay(shiftISODate(TODAY, -4), 18) },
      ],
      reminders: [
        {
          id: 'rem1',
          title: 'Call dentist',
          time: '09:00',
          date: shiftISODate(TODAY, -3),
          repeat: 'once',
        },
        { id: 'rem2', title: 'Stretch', time: '21:00', date: null, repeat: 'daily' },
      ],
      appointments: [{ title: 'Dentist', scheduledAt: onDay(shiftISODate(TODAY, 2), 10) }],
      screenings: [{ name: 'Skin check', nextDue: shiftISODate(TODAY, -10) }],
      experiments: [{ id: 'x1', title: 'No screens', ready: true, daysLeft: 0 }],
    })
  );

  check(
    JSON.stringify(facts.mission.open.map((r) => [r.tag, r.id])) ===
      JSON.stringify([
        ['m1', 'd'],
        ['m2', 'b'],
        ['m3', 'c'],
      ]),
    'open rows only (pending + partial), in Home’s time order, tagged m1…',
    JSON.stringify(facts.mission.open)
  );
  check(
    facts.mission.done === 1 && facts.mission.total === 5,
    'the tally is the mission’s own (1 of 5)'
  );
  check(
    facts.mission.open[2].snoozed && facts.mission.open[0].partial,
    'snoozed and partly-done are stated'
  );
  check(
    facts.weighIn.last?.daysAgo === 1 &&
      facts.weighIn.daysInLast28 === 3 &&
      facts.weighIn.medianGapDays === 3,
    'weigh-ins: last one 1 day ago, 3 days in 28, median gap 3',
    JSON.stringify(facts.weighIn)
  );
  check(
    facts.meals.last?.time === '08:15' &&
      facts.meals.todayCount === 2 &&
      facts.meals.todayKcal === 520 &&
      facts.meals.todayProtein === 32 &&
      facts.meals.pending === 1,
    'meals: the last TIMED meal, today’s count and intake, the waiting estimate',
    JSON.stringify(facts.meals)
  );
  check(facts.woke === '06:48', 'wake time is the end of last night’s recorded sleep');
  check(
    facts.training.saved[0].name === 'Upper A' &&
      facts.training.saved[0].tag === 'w1' &&
      facts.training.live?.name === 'Upper A',
    'saved workouts, most recently started first, tagged w1…; the open live session is named'
  );
  check(
    facts.loops.reminders[0].dueSince === shiftISODate(TODAY, -3) &&
      facts.loops.reminders[1].dueSince === null,
    'a one-off past its floor says since when; a daily reminder does not'
  );
  check(facts.loops.screenings[0].overdue === true, 'an overdue screening says so');
  check(
    facts.tags.map((t) => t.tag).join(',') === 'm1,m2,m3,w1,w2,r1,r2,e1',
    'tags: rows, saved workouts, reminders, experiments — the only handles the pass may use',
    facts.tags.map((t) => t.tag).join(',')
  );

  const lines = dayFactsLines(facts).join('\n');
  check(
    lines.includes('m2 17:30 "Strength session" (Training)') &&
      lines.includes('Weigh-ins: last') &&
      lines.includes('median gap 3 days') &&
      lines.includes('Woke: 06:48') &&
      lines.includes('w1 "Upper A"') &&
      lines.includes('r1 reminder "Call dentist" (due since') &&
      lines.includes('e1 experiment "No screens" window closed'),
    'the lines carry each fact',
    lines
  );
  check(
    !/\b(should|need to|must|remind|time to|don't forget|recommend|consider|try to)\b/i.test(lines),
    'NO FACT IMPLIES AN ACTION — not one line is an instruction (owner, 2026-10-21)',
    lines
  );

  const empty = dayFactsLines(buildDayFacts(emptyInput())).join('\n');
  check(
    empty.includes("Mission: no rows on today's list.") &&
      empty.includes('Weigh-ins: none on record.') &&
      empty.includes('Woke: no sleep recorded') &&
      empty.includes('Open loops: none.'),
    'an empty day is stated as empty, never as zeros invented',
    empty
  );

  // THE LOGICAL DAY: under an 04:00 boundary, 02:30 belongs to yesterday, and
  // a weigh-in at 01:00 is "today" for that day.
  const late = new Date(NOW);
  late.setHours(2, 30, 0, 0);
  const lateDay = logicalDate(late, '04:00');
  const weighedAt = new Date(late);
  weighedAt.setHours(1, 0, 0, 0);
  const lateFacts = buildDayFacts(
    emptyInput({
      now: late,
      today: lateDay,
      dayStartsAt: '04:00',
      weighIns: [weighedAt.toISOString()],
    })
  );
  check(
    lateDay === shiftISODate(todayISODate(late, '00:00'), -1) &&
      lateFacts.weighIn.last?.day === lateDay &&
      lateFacts.weighIn.last?.daysAgo === 0,
    'under an 04:00 day boundary, a 01:00 weigh-in at 02:30 is TODAY’s (the logical day)',
    JSON.stringify(lateFacts.weighIn)
  );
}

// ---------------------------------------------------------------------------
console.log('2. the PLAN parser: strict lines, junk dropped, never shown');
{
  const TAGS = [
    { tag: 'm1', kind: 'row', id: 'row-1', title: 'Creatine' },
    { tag: 'm2', kind: 'row', id: 'row-2', title: 'Strength session' },
    { tag: 'w1', kind: 'routine', id: 'rt-1', title: 'Upper A' },
    { tag: 'r1', kind: 'reminder', id: 'rem-1', title: 'Call dentist' },
    { tag: 'e1', kind: 'experiment', id: 'ex-1', title: 'No screens' },
  ];
  const ctx = { now: NOW, today: TODAY, dayStartsAt: ZERO, tags: TAGS };
  const resolve = (reply) => resolvePlan(parsePlanReply(reply), ctx);

  const good = resolve(
    [
      'Your weigh-ins have gone quiet.',
      '',
      'PLAN DO log_weight UNTIL 13:00 | Weigh in | Nine days since the last one.',
      'PLAN PIN m2 | You moved it twice this week.',
      'PLAN DO start_workout w1 | Upper A',
    ].join('\n')
  );
  check(
    good.decision === 'replace' && good.items.length === 3 && good.refused.length === 0,
    'three valid lines → a plan of three',
    JSON.stringify(good)
  );
  const [first, second, third] = good.items;
  check(
    first.key === 'do:log_weight' &&
      first.rank === 1 &&
      first.title === 'Weigh in' &&
      first.reason === 'Nine days since the last one.' &&
      first.untilGiven,
    'a DO line: action, title, reason, an UNTIL',
    JSON.stringify(first)
  );
  check(new Date(first.until).getHours() === 13, '…UNTIL is that clock time on the logical day');
  check(
    second.kind === 'pin' &&
      second.entryId === 'row-2' &&
      second.title === 'Strength session' &&
      second.rank === 2,
    'a PIN resolves its tag to the row, titled from the row'
  );
  check(
    third.key === 'do:start_workout:rt-1' &&
      third.targetId === 'rt-1' &&
      third.reason === null &&
      !third.untilGiven &&
      third.until === logicalDayUtcRange(TODAY, ZERO).endUtc,
    'no reason is fine; no UNTIL holds to the end of the logical day'
  );

  const parsed = parsePlanReply(
    'Note.\n\nPLAN DO log_meal | Lunch\nPLAN junk words\nplan for tomorrow is in the thread'
  );
  check(
    parsed.text === 'Note.\n\nplan for tomorrow is in the thread' && parsed.malformed.length === 1,
    'every PLAN line leaves the text, parsed or not; lower-case prose stays',
    JSON.stringify(parsed)
  );

  const wrapped = parsePlanReply('SKIP\n\n**Plan:**\n```\nPLAN DO log_water | Water\n```');
  check(
    wrapped.text === 'SKIP' && wrapped.lines.length === 1,
    'the fence and label round the lines go with them (a SKIP stays a SKIP)',
    JSON.stringify(wrapped.text)
  );
  const bullets = parsePlanReply('- PLAN DO open_coach | Talk it through\n1. **PLAN PIN m1**');
  check(
    bullets.lines.length === 2 && bullets.text === '',
    'bullets, list numbers and emphasis are notation, not junk'
  );

  const refusals = (reply) => resolve(reply).refused.map((r) => r.reason);
  check(
    refusals('PLAN DO book_flight | Fly')[0] === 'unknown-action',
    'an unknown destination is dropped'
  );
  check(refusals('PLAN PIN m9')[0] === 'unknown-tag', 'a tag the pass was not shown is dropped');
  check(
    refusals('PLAN PIN w1')[0] === 'wrong-tag',
    'a PIN on a saved workout is the wrong kind of tag'
  );
  check(
    refusals('PLAN DO start_workout m1 | Go')[0] === 'wrong-tag',
    'start_workout needs a w-tag, not a row'
  );
  check(refusals('PLAN DO start_workout | Go')[0] === 'wrong-tag', '…and needs one at all');
  check(
    refusals('PLAN DO log_weight w1 | Weigh')[0] === 'wrong-tag',
    'a tag on an action that takes none is dropped'
  );
  check(
    refusals(`PLAN DO log_weight | ${'x'.repeat(41)}`)[0] === 'title-too-long',
    'a title over 40 is dropped, not cut'
  );
  check(
    refusals(`PLAN DO log_weight | Weigh | ${'y'.repeat(91)}`)[0] === 'reason-too-long',
    'a reason over 90 is dropped, not cut'
  );
  check(
    resolve(`PLAN DO log_weight | Weigh | ${'y'.repeat(90)}`).items.length === 1,
    '…and exactly 90 is allowed'
  );
  check(
    refusals('PLAN DO log_weight UNTIL 11:00 | Weigh')[0] === 'stale-until',
    'an UNTIL already past is a stale line, dropped'
  );
  check(
    refusals('PLAN DO log_weight UNTIL 25:00 | Weigh')[0] === 'malformed',
    'an impossible clock is malformed'
  );
  check(
    refusals('PLAN DO log_weight | Weigh\nPLAN DO log_weight | Again')[0] === 'duplicate',
    'the same item twice is one item'
  );
  const four = resolve(
    'PLAN DO log_weight | A\nPLAN DO log_meal | B\nPLAN DO log_water | C\nPLAN DO open_coach | D'
  );
  check(
    four.items.length === 3 && four.refused[0].reason === 'too-many',
    'a fourth item is dropped: at most three'
  );

  check(resolve('PLAN NONE').decision === 'clear', 'PLAN NONE clears');
  check(resolve('Nothing to add.').decision === 'keep', 'no PLAN line keeps the standing plan');
  check(
    resolve('PLAN DO book_flight | Fly').decision === 'keep',
    '…and so does a reply whose every line was junk'
  );

  // A late day boundary: at 23:00 under 04:00, 01:30 is still today.
  const night = new Date(NOW);
  night.setHours(23, 0, 0, 0);
  const lateCtx = {
    now: night,
    today: logicalDate(night, '04:00'),
    dayStartsAt: '04:00',
    tags: TAGS,
  };
  const lateItem = resolvePlan(
    parsePlanReply('PLAN DO open_coach UNTIL 01:30 | Wind down'),
    lateCtx
  ).items[0];
  check(
    lateItem &&
      new Date(lateItem.until).getTime() > night.getTime() &&
      new Date(lateItem.until).getHours() === 1,
    'under an 04:00 boundary, UNTIL 01:30 at 23:00 is tonight, not this morning'
  );

  // The destinations are a closed list, and each one opens somewhere.
  check(
    PLAN_ACTIONS.every(
      (a) => typeof destinationHref({ action: a, targetId: 'x' }, false).pathname === 'string'
    ),
    'every destination has a route'
  );
  check(
    destinationHref({ action: 'start_workout', targetId: 'rt-1' }, true).params?.resume === '1' &&
      destinationHref({ action: 'start_workout', targetId: 'rt-1' }, false).params?.routineId ===
        'rt-1',
    'start_workout opens the saved workout — or the session already open, never a second one'
  );
}

// ---------------------------------------------------------------------------
/** A database with a real protocol day: three timed rows. */
function seededDay() {
  const { db } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Stack', type: 'supplement_stack' },
    {
      items: [
        { title: 'Creatine', scheduled_time: '07:30' },
        { title: 'Fish oil', scheduled_time: '13:00' },
        { title: 'Magnesium', scheduled_time: '21:30' },
      ],
    }
  );
  generateMissionForDay(db, TODAY);
  return db;
}
const resolution = (items) => ({ decision: 'replace', items, refused: [] });
const endOfDay = logicalDayUtcRange(TODAY, ZERO).endUtc;
const doItem = (action, rank, extra = {}) => ({
  key: extra.targetId ? `do:${action}:${extra.targetId}` : `do:${action}`,
  rank,
  kind: 'do',
  action,
  title: extra.title ?? action,
  reason: extra.reason ?? null,
  until: extra.until ?? endOfDay,
  untilGiven: extra.until !== undefined,
  ...(extra.targetId ? { targetId: extra.targetId } : {}),
});
const pinItem = (row, rank, reason = null) => ({
  key: `pin:${row.id}`,
  rank,
  kind: 'pin',
  entryId: row.id,
  title: row.title,
  reason,
  until: endOfDay,
  untilGiven: false,
});
const events = (db) =>
  db
    .all('SELECT item_key, event FROM day_plan_events ORDER BY item_key, event')
    .map((r) => `${r.item_key.replace(/:[0-9a-f-]{36}$/, ':<id>')}|${r.event}`);

console.log('3. the plan against the record: the top of Home, and every transition recorded');
{
  const db = seededDay();
  const rows = listMission(db, TODAY);
  const magnesium = rows.find((r) => r.title === 'Magnesium');
  const none = new Set();

  // WITHOUT A PLAN, Home is exactly what it was: the time-ordered hero.
  const before = plan.homeTopFor(db, NOW, none, ZERO);
  const view = deriveMissionView(rows, none);
  check(
    before?.kind === 'mission' && before.row.id === view.next.id,
    'no plan: the top of Home IS deriveMissionView().next'
  );

  plan.applyDayPlan(
    db,
    resolution([
      doItem('log_weight', 1, { title: 'Weigh in', reason: 'Nine days since the last one.' }),
      pinItem(magnesium, 2, 'Sleep has been short.'),
      doItem('open_train', 3, { title: 'Look at the week' }),
    ]),
    NOW,
    ZERO
  );
  const stored = plan.getDayPlan(db);
  check(
    stored?.day === TODAY && stored.items.length === 3,
    'the plan is stored in preferences, for today'
  );

  let top = plan.homeTopFor(db, at(1), none, ZERO);
  check(
    top?.kind === 'coach' && top.item.title === 'Weigh in',
    'the Coach’s first item is the top of Home'
  );

  // A weight that landed BEFORE the plan answers nothing.
  db.run('INSERT INTO body_metrics (id, measured_at, weight_kg, created_at) VALUES (?, ?, ?, ?)', [
    'bm0',
    iso(-60),
    80,
    iso(-60),
  ]);
  check(
    plan.homeTopFor(db, at(1), none, ZERO)?.kind === 'coach',
    'a weight from before the plan does not clear it'
  );
  // One after it does — and the settle records `done`.
  db.run('INSERT INTO body_metrics (id, measured_at, weight_kg, created_at) VALUES (?, ?, ?, ?)', [
    'bm1',
    iso(5),
    80.2,
    iso(5),
  ]);
  plan.settleDayPlan(db, at(6), ZERO);
  check(
    plan.readDayPlan(db, at(6), ZERO).items[0].state === 'done' &&
      !events(db).includes('do:log_weight|done'),
    'the weight arriving reads DONE for the weigh-in item — recorded when the plan closes, not yet'
  );
  top = plan.homeTopFor(db, at(6), none, ZERO);
  check(
    top?.kind === 'pin' &&
      top.row.id === magnesium.id &&
      top.item.reason === 'Sleep has been short.',
    'the next item takes the top: the pinned row, with the Coach’s reason'
  );

  // Snooze on a pinned row means what it always meant: not now.
  snoozeItem(magnesium.id);
  const { snoozedItems } = await import('../src/lib/home/snooze-store.ts');
  top = plan.homeTopFor(db, at(6), snoozedItems(), ZERO);
  check(
    top?.kind === 'coach' && top.item.action === 'open_train',
    'a snoozed pin yields to the next live item'
  );
  unsnoozeItem(magnesium.id);

  // Completing the pinned row is DONE for the pin — read off the row's live
  // status every time, so the Undo of an auto-tick puts the pin back (finding 6).
  setMissionStatus(db, magnesium.id, 'completed', TODAY);
  plan.settleDayPlan(db, at(7), ZERO);
  check(
    plan.readDayPlan(db, at(7), ZERO).items[1].state === 'done' &&
      !events(db).includes('pin:<id>|done'),
    'ticking the pinned row reads DONE for the pin, and records nothing while the plan stands'
  );
  setMissionStatus(db, magnesium.id, 'pending', TODAY);
  plan.settleDayPlan(db, at(7), ZERO);
  top = plan.homeTopFor(db, at(7), none, ZERO);
  check(
    plan.readDayPlan(db, at(7), ZERO).items[1].state === 'live' &&
      top?.kind === 'pin' &&
      top.row.id === magnesium.id,
    'the tick Undone: the pin is live again and back on top — done was never sticky'
  );
  setMissionStatus(db, magnesium.id, 'completed', TODAY);

  // A destination with no data of its own: the tap is the act.
  const live = plan.readDayPlan(db, at(8), ZERO);
  const train = live.items.find((i) => i.action === 'open_train');
  plan.recordPlanEvent(db, live.plan, train, 'started', at(8));
  check(
    plan.readDayPlan(db, at(9), ZERO).items.find((i) => i.action === 'open_train').state === 'done',
    'open_train clears on its tap (started ⇒ done)'
  );
  top = plan.homeTopFor(db, at(9), none, ZERO);
  check(
    top?.kind === 'mission' && top.row.title === 'Creatine',
    'every item cleared: Home is back in time order'
  );

  // REPLACED: a new plan closes the standing plan's open items.
  plan.applyDayPlan(
    db,
    resolution([doItem('log_meal', 1, { title: 'Lunch' }), doItem('log_water', 2)]),
    at(10),
    ZERO
  );
  check(
    events(db).includes('pin:<id>|done') && events(db).includes('do:log_weight|done'),
    'the plan replaced: what the record answered is recorded as DONE as it closes'
  );
  const secondPlan = plan.getDayPlan(db);
  plan.applyDayPlan(db, resolution([doItem('log_water', 1, { title: 'Water' })]), at(11), ZERO);
  const replaced = db.all('SELECT item_key FROM day_plan_events WHERE plan_id = ? AND event = ?', [
    secondPlan.id,
    'replaced',
  ]);
  check(
    replaced.length === 2,
    'the next plan records REPLACED for each still-open item of the last'
  );

  // DISMISSED.
  const third = plan.readDayPlan(db, at(12), ZERO);
  plan.recordPlanEvent(db, third.plan, third.items[0], 'dismissed', at(12));
  check(
    plan.homeTopFor(db, at(12), none, ZERO)?.kind === 'mission',
    'a dismissed item is gone from Home'
  );

  // EXPIRED, by UNTIL.
  plan.applyDayPlan(
    db,
    resolution([doItem('log_water', 1, { title: 'Water', until: iso(30) })]),
    at(13),
    ZERO
  );
  check(plan.homeTopFor(db, at(29), none, ZERO)?.kind === 'coach', 'live until UNTIL…');
  plan.settleDayPlan(db, at(31), ZERO);
  const fourth = plan.getDayPlan(db);
  check(
    plan.homeTopFor(db, at(31), none, ZERO)?.kind === 'mission' &&
      db.get('SELECT 1 AS y FROM day_plan_events WHERE plan_id = ? AND event = ?', [
        fourth.id,
        'expired',
      ])?.y === 1,
    '…and past it the item is EXPIRED, recorded, and Home is back in time order'
  );

  // A PLAN FROM YESTERDAY never reaches today.
  plan.applyDayPlan(
    db,
    resolution([doItem('open_coach', 1, { title: 'Yesterday’s' })]),
    at(40),
    ZERO
  );
  const yesterdayPlan = { ...plan.getDayPlan(db), day: shiftISODate(TODAY, -1) };
  const evaluated = evaluatePlan(yesterdayPlan, {
    now: at(41),
    today: TODAY,
    events: new Set(),
    rows: new Map(),
    weightSince: false,
    mealSince: false,
    waterSince: false,
    workoutSince: false,
    liveStartedAt: null,
    activeReminders: new Set(),
    activeExperiments: new Set(),
    routines: new Set(),
  });
  check(
    evaluated[0].state === 'expired' && evaluated[0].transition === 'expired',
    'yesterday’s plan is expired on today, item by item'
  );

  // A PINNED ROW THAT NO LONGER EXISTS is inert: no hero, nothing recorded.
  const db2 = seededDay();
  const rows2 = listMission(db2, TODAY);
  const gone = rows2.find((r) => r.title === 'Fish oil');
  plan.applyDayPlan(db2, resolution([pinItem(gone, 1, 'Was here.')]), NOW, ZERO);
  db2.run('DELETE FROM log_entries WHERE id = ?', [gone.id]);
  const after = plan.settleDayPlan(db2, at(1), ZERO);
  check(
    after.items[0].state === 'gone' && after.items[0].transition === null,
    'a pinned row that was deleted is GONE — inert, and nothing is recorded for it'
  );
  top = plan.homeTopFor(db2, at(1), none, ZERO);
  check(top?.kind === 'mission' && top.row.id !== gone.id, '…and Home falls back to time order');

  // A deleted routine, a closed reminder.
  const db3 = seededDay();
  const routineId = createRoutine(db3, { name: 'Upper A', notes: null, exercises: [] });
  const reminderId = createReminder(db3, { title: 'Call dentist' }, NOW);
  plan.applyDayPlan(
    db3,
    resolution([
      doItem('start_workout', 1, { title: 'Upper A', targetId: routineId }),
      doItem('open_reminder', 2, { title: 'Dentist', targetId: reminderId }),
    ]),
    NOW,
    ZERO
  );
  completeReminder(db3, reminderId);
  const r3 = plan.settleDayPlan(db3, at(1), ZERO);
  check(
    r3.items[1].state === 'done',
    'a reminder completed on the Coach tab closes its item (done)'
  );
  db3.run('UPDATE routines SET archived = 1 WHERE id = ?', [routineId]);
  check(
    plan.readDayPlan(db3, at(2), ZERO).items[0].state === 'gone',
    'a saved workout archived since is gone, not a dead button'
  );

  // EVERY TRANSITION is one row per item, however often Home re-reads.
  const db4 = seededDay();
  plan.applyDayPlan(db4, resolution([doItem('log_meal', 1, { title: 'Lunch' })]), NOW, ZERO);
  const p4 = plan.readDayPlan(db4, at(1), ZERO);
  for (let i = 0; i < 5; i++) plan.recordPlanEvent(db4, p4.plan, p4.items[0], 'shown', at(1));
  plan.recordPlanEvent(db4, p4.plan, p4.items[0], 'started', at(2));
  plan.recordPlanEvent(db4, p4.plan, p4.items[0], 'started', at(3));
  check(
    plan.readDayPlan(db4, at(3), ZERO).items[0].state === 'live',
    'a tap on log_meal is STARTED; the item stays until a meal lands'
  );
  db4.run(
    "INSERT INTO meals (id, date, time, name, created_at) VALUES ('ml1', ?, '12:10', 'Lunch', ?)",
    [TODAY, iso(10)]
  );
  for (let i = 0; i < 3; i++) plan.settleDayPlan(db4, at(11), ZERO);
  // The day ends; the next morning's settle closes the plan.
  for (let i = 0; i < 2; i++) plan.settleDayPlan(db4, at(24 * 60), ZERO);
  check(
    JSON.stringify(events(db4)) ===
      JSON.stringify(['do:log_meal|done', 'do:log_meal|shown', 'do:log_meal|started']),
    'shown ×5, started ×2, settled ×3 today and ×2 tomorrow → one row each: shown, started, done',
    JSON.stringify(events(db4))
  );
}

// ---------------------------------------------------------------------------
console.log('3b. review fixes: a past day settles against itself; drinks, pins, timers, labels');
{
  const tomorrowNoon = at(24 * 60);
  const TOMORROW = shiftISODate(TODAY, 1);

  // A PLAN FROM YESTERDAY IS SETTLED AGAINST YESTERDAY (finding 1). A weight
  // logged 30 minutes after the plan, Home never re-opened that day: the next
  // day's settle records DONE for it, and EXPIRED only for what did not land.
  {
    const db = seededDay();
    const rows = listMission(db, TODAY);
    const creatine = rows.find((r) => r.title === 'Creatine');
    plan.applyDayPlan(
      db,
      resolution([
        doItem('log_weight', 1, { title: 'Weigh in' }),
        pinItem(creatine, 2),
        doItem('log_meal', 3, { title: 'Lunch' }),
      ]),
      NOW,
      ZERO
    );
    const p = plan.getDayPlan(db);
    for (const item of p.items) plan.recordPlanEvent(db, p, item, 'shown', NOW);
    db.run(
      "INSERT INTO body_metrics (id, measured_at, weight_kg, source, created_at) VALUES ('w1', ?, 80, 'manual', ?)",
      [iso(30), iso(30)]
    );
    setMissionStatus(db, creatine.id, 'completed', TODAY);
    // Tomorrow's meal answers nothing about today's plan.
    db.run(
      "INSERT INTO meals (id, date, time, name, created_at) VALUES ('mt', ?, '08:00', 'Breakfast', ?)",
      [TOMORROW, tomorrowNoon.toISOString()]
    );
    plan.settleDayPlan(db, tomorrowNoon, ZERO);
    check(
      JSON.stringify(events(db).filter((e) => !e.endsWith('|shown'))) ===
        JSON.stringify(['do:log_meal|expired', 'do:log_weight|done', 'pin:<id>|done']),
      'yesterday’s plan, settled today: the weight and the ticked pin DONE; a meal dated tomorrow leaves log_meal EXPIRED',
      JSON.stringify(events(db))
    );
    const summary = plan.dayPlanSummary(db, TOMORROW);
    check(
      summary.startsWith('Your plan items, last 14 days: 3 shown, 2 acted on (2 done), 0 dismissed, 1 expired'),
      'and the 14-day summary says acted on',
      summary
    );
  }
  {
    // A weight measured TOMORROW is outside the plan day's window; an open pin expires.
    const db = seededDay();
    const fishOil = listMission(db, TODAY).find((r) => r.title === 'Fish oil');
    plan.applyDayPlan(db, resolution([doItem('log_weight', 1), pinItem(fishOil, 2)]), NOW, ZERO);
    db.run(
      "INSERT INTO body_metrics (id, measured_at, weight_kg, source, created_at) VALUES ('w2', ?, 80, 'manual', ?)",
      [tomorrowNoon.toISOString(), tomorrowNoon.toISOString()]
    );
    plan.settleDayPlan(db, at(24 * 60 + 1), ZERO);
    check(
      JSON.stringify(events(db)) === JSON.stringify(['do:log_weight|expired', 'pin:<id>|expired']),
      'a weight from the next day does not settle yesterday’s weigh-in item; the open pin EXPIRED',
      JSON.stringify(events(db))
    );
  }

  // NIGHT OUT'S DRINKS ARE NOT A MEAL (finding 3).
  {
    const db = seededDay();
    plan.applyDayPlan(db, resolution([doItem('log_meal', 1, { title: 'Log dinner' })]), NOW, ZERO);
    setNightOutDrinks(db, TODAY, { count: 2, kind: 'wine' });
    db.run('UPDATE meals SET created_at = ?', [iso(5)]);
    check(
      db.get('SELECT count(*) AS n FROM meals').n === 1 &&
        plan.readDayPlan(db, at(6), ZERO).items[0].state === 'live',
      'the Night-out drinks meal alone leaves log_meal live'
    );
    db.run(
      "INSERT INTO meals (id, date, time, name, created_at) VALUES ('md', ?, '19:30', 'Dinner', ?)",
      [TODAY, iso(10)]
    );
    check(
      plan.readDayPlan(db, at(11), ZERO).items[0].state === 'done',
      'a real meal after it clears the item'
    );
  }

  // A WEIGHT TAKEN BACK puts its item back (finding 6, the do-item half).
  {
    const db = seededDay();
    plan.applyDayPlan(db, resolution([doItem('log_weight', 1)]), NOW, ZERO);
    db.run(
      "INSERT INTO body_metrics (id, measured_at, weight_kg, source, created_at) VALUES ('w3', ?, 80, 'manual', ?)",
      [iso(5), iso(5)]
    );
    plan.settleDayPlan(db, at(6), ZERO);
    db.run("DELETE FROM body_metrics WHERE id = 'w3'");
    check(
      plan.settleDayPlan(db, at(7), ZERO).items[0].state === 'live' && events(db).length === 0,
      'a weight logged then deleted: the weigh-in item is live again, nothing recorded'
    );
  }

  // SHOWN FOR LIVE PINS whose row is drawn (finding 7), so acted on ≤ shown.
  {
    const db = seededDay();
    const rows = listMission(db, TODAY);
    const fishOil = rows.find((r) => r.title === 'Fish oil');
    const magnesium = rows.find((r) => r.title === 'Magnesium');
    plan.applyDayPlan(
      db,
      resolution([doItem('log_water', 1), pinItem(fishOil, 2), pinItem(magnesium, 3)]),
      NOW,
      ZERO
    );
    const read = plan.readDayPlan(db, at(1), ZERO);
    const view = deriveMissionView(rows, new Set());
    const top = homeTop(view, read.items);
    const drawn = new Set(view.rest.map((r) => r.id));
    const keys = shownKeys(read.items, top, drawn);
    check(
      keys.has('do:log_water') && keys.has(`pin:${fishOil.id}`) && keys.has(`pin:${magnesium.id}`),
      'the hero’s item, the Coach row and both drawn pins are shown'
    );
    check(
      JSON.stringify([...shownKeys(read.items, top, null)]) === JSON.stringify(['do:log_water']) &&
        !shownKeys(read.items, top, new Set([fishOil.id])).has(`pin:${magnesium.id}`),
      'no checklist: only the hero; a pin whose row is not drawn is not shown'
    );
    for (const item of read.plan.items) {
      if (keys.has(item.key)) plan.recordPlanEvent(db, read.plan, item, 'shown', at(1));
    }
    setMissionStatus(db, magnesium.id, 'completed', TODAY);
    plan.settleDayPlan(db, tomorrowNoon, ZERO);
    const summary = plan.dayPlanSummary(db, TOMORROW);
    check(
      summary.includes('3 shown, 1 acted on (1 done)') && summary.includes('pinned row 2/1'),
      'a pin ticked counts as shown and acted on — acted on never exceeds shown',
      summary
    );
  }

  // THE TIMER: the earliest live item's UNTIL (finding 4).
  {
    const db = seededDay();
    plan.applyDayPlan(
      db,
      resolution([
        doItem('log_water', 1, { until: iso(90) }),
        doItem('log_meal', 2, { until: iso(30) }),
      ]),
      NOW,
      ZERO
    );
    const live = plan.readDayPlan(db, at(1), ZERO).items;
    check(msUntilNextExpiry(live, at(1)) === 29 * 60_000, 'the timer is set to the earliest live UNTIL');
    const later = plan.readDayPlan(db, at(31), ZERO).items;
    check(
      msUntilNextExpiry(later, at(31)) === 59 * 60_000,
      'past it, the next live item’s UNTIL'
    );
    check(
      msUntilNextExpiry(plan.readDayPlan(db, at(91), ZERO).items, at(91)) === null,
      'nothing live: no timer'
    );
  }

  // START reads RESUME while a session is open (cosmetic): the href already resumes.
  {
    const item = { ...doItem('start_workout', 1, { targetId: 'r1' }), state: 'live', transition: null };
    check(
      toCoachItemView(item).button === 'Start' &&
        toCoachItemView(item, true).button === 'Resume' &&
        destinationHref(item, true).params?.resume === '1',
      'start_workout says Resume while a live session is open, where its tap goes'
    );
  }
}

// ---------------------------------------------------------------------------
console.log('4. uncounted: the mission, its tally and adherence do not move');
{
  const db = seededDay();
  const rows = listMission(db, TODAY);
  const protocolId = rows[0].protocolId;
  const snapshot = () =>
    JSON.stringify({
      mission: listMission(db, TODAY),
      series: missionDailySeries(db, 14, TODAY),
      adherence: missionAdherence(missionDailySeries(db, 14, TODAY)),
      protocol: protocolAdherence(db, protocolId, shiftISODate(TODAY, -13), TODAY),
      entries: db.get('SELECT count(*) AS n FROM log_entries').n,
    });
  setMissionStatus(db, rows[0].id, 'completed', TODAY);
  const baseline = snapshot();

  plan.applyDayPlan(
    db,
    resolution([
      doItem('log_weight', 1, { title: 'Weigh in' }),
      pinItem(rows[1], 2),
      doItem('log_water', 3),
    ]),
    NOW,
    ZERO
  );
  const live = plan.readDayPlan(db, at(1), ZERO);
  for (const item of live.items) plan.recordPlanEvent(db, live.plan, item, 'shown', at(1));
  plan.recordPlanEvent(db, live.plan, live.items[0], 'started', at(2));
  plan.recordPlanEvent(db, live.plan, live.items[2], 'dismissed', at(3));
  db.run('INSERT INTO body_metrics (id, measured_at, weight_kg, created_at) VALUES (?, ?, ?, ?)', [
    'bm1',
    iso(5),
    80,
    iso(5),
  ]);
  plan.settleDayPlan(db, at(6), ZERO);
  check(
    db.get('SELECT count(*) AS n FROM day_plan_events').n >= 5,
    'the plan and its history are on disk'
  );
  check(
    snapshot() === baseline,
    'listMission, missionDailySeries, missionAdherence, protocolAdherence and the row count are byte-identical'
  );
  check(
    deriveMissionView(listMission(db, TODAY), new Set()).total === rows.length,
    '"N of M" is still the mission’s own M — Coach items are not in it'
  );
}

// ---------------------------------------------------------------------------
console.log('5. the 14-day summary: counts, handed over as facts');
{
  const { db } = freshDb();
  check(
    plan.dayPlanSummary(db, TODAY) === 'Your plan items, last 14 days: none yet.',
    'nothing yet says so'
  );
  const rows = [
    ['p1', 'do:log_weight', 'do', 'log_weight', 'shown'],
    ['p1', 'do:log_weight', 'do', 'log_weight', 'started'],
    ['p1', 'do:log_weight', 'do', 'log_weight', 'done'],
    ['p1', 'do:log_meal', 'do', 'log_meal', 'shown'],
    ['p1', 'do:log_meal', 'do', 'log_meal', 'dismissed'],
    ['p2', 'do:log_weight', 'do', 'log_weight', 'shown'],
    ['p2', 'do:log_weight', 'do', 'log_weight', 'done'],
    ['p2', 'pin:x', 'pin', null, 'shown'],
    ['p2', 'pin:x', 'pin', null, 'expired'],
    ['p3', 'do:open_coach', 'do', 'open_coach', 'replaced'],
  ];
  let n = 0;
  for (const [planId, key, kind, action, event] of rows) {
    db.run(
      `INSERT INTO day_plan_events (id, day, plan_id, item_key, kind, action, title, rank, event, at)
       VALUES (?, ?, ?, ?, ?, ?, 't', 1, ?, ?)`,
      [`ev${n++}`, TODAY, planId, key, kind, action, event, NOW.toISOString()]
    );
  }
  // Outside the window: never counted.
  db.run(
    `INSERT INTO day_plan_events (id, day, plan_id, item_key, kind, action, title, rank, event, at)
     VALUES ('old', ?, 'p0', 'do:log_meal', 'do', 'log_meal', 't', 1, 'shown', ?)`,
    [shiftISODate(TODAY, -14), NOW.toISOString()]
  );
  const summary = plan.dayPlanSummary(db, TODAY);
  check(
    summary ===
      'Your plan items, last 14 days: 4 shown, 2 acted on (2 done), 1 dismissed, 1 expired, 1 replaced. ' +
        'By kind (shown/acted on): log_weight 2/2 · log_meal 1/0 · pinned row 1/0 · open_coach 0/0.',
    'counted per item, acted on = started or done, by kind; the 15th day back is out',
    summary
  );
  check(
    summarizePlanEvents([]) === 'Your plan items, last 14 days: none yet.',
    'the pure summary agrees'
  );
}

// ---------------------------------------------------------------------------
console.log('6. the pass: the block rides the directive, the lines come back validated');
{
  const sse = (text) =>
    [
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}`,
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      '',
      '',
    ].join('\n');
  const fetchFor = (body, capture) => async (_url, init) => {
    if (capture) capture.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      text: async () => '',
      body: {
        getReader() {
          let done = false;
          return {
            async read() {
              if (done) return { done: true };
              done = true;
              return { done: false, value: new TextEncoder().encode(body) };
            },
          };
        },
      },
    };
  };
  const { apiKeyStore } = await import('../src/lib/ai/api-key-store.ts');
  await apiKeyStore.setKey('test-key');

  const db = seededDay();
  createRoutine(db, { name: 'Upper A', notes: null, exercises: [] });
  const requests = [];
  const result = await runCoachPass(db, {
    trigger: { kind: 'daily' },
    now: NOW,
    fetchImpl: fetchFor(
      sse(
        'SKIP\n\nPLAN DO log_weight | Weigh in | Nine days since the last one.\nPLAN PIN m2\nPLAN DO teleport | Nope'
      ),
      requests
    ),
  });
  // The directive may be a string or text blocks (the conversation cache breakpoint).
  const raw = requests[0].messages[0].content;
  const content = typeof raw === 'string' ? raw : raw.map((block) => block.text ?? '').join('');
  check(
    content.includes('=== Top of Home ===') && content.includes('=== end of Top of Home ==='),
    'the directive carries ONE delimited block'
  );
  check(
    content.includes('Mission: 0 of 3 done.') && content.includes('m1 07:30 "Creatine"'),
    'with the day’s facts and the tags'
  );
  check(
    content.includes('start_workout <w-tag>') &&
      content.includes('open_reminder <r-tag>') &&
      content.includes('open_experiment <e-tag>'),
    'each action that takes a tag names the tag letter the facts mint'
  );
  check(
    /\(PROPOSE, NUDGE and PLAN lines are the exceptions\)|\(NUDGE and PLAN lines are the exceptions\)/.test(content),
    'SKIP still stands, with PLAN lines allowed beside it'
  );
  check(
    result.status === 'silent' && result.message === null,
    'SKIP + PLAN lines is a SILENT pass — no line reaches the thread'
  );
  check(
    result.plan?.decision === 'replace' &&
      result.plan.items.length === 2 &&
      result.plan.items[1].title === 'Fish oil' &&
      result.plan.refused[0]?.reason === 'unknown-action',
    'the lines come back validated against THIS pass’s tags; junk is refused',
    JSON.stringify(result.plan)
  );
  check(
    !requests[0].system.some?.((block) => /PLAN (PIN|DO)|Top of Home/.test(block.text ?? '')) &&
      !buildCoachSystemPrompt().includes('PLAN PIN') &&
      !JSON.stringify(requests[0].tools).includes('PLAN'),
    'the chat system prompt and the tool schemas carry nothing of it (the §6 ceilings cannot move)'
  );

  // MEASURED: the block is the pass's own, uncached cost.
  const block = plan.dayPlanDirectiveFor(db, NOW, ZERO).block.join('\n');
  const instructions = planInstructions({
    clock: '12:00',
    today: TODAY,
    facts: [],
    summary: '',
    current: [],
    tags: [],
  }).join('\n');
  console.log(
    `  ·    measured: Top of Home block ${block.length} chars (~${Math.round(block.length / 4)} tokens) on this day; ` +
      `the fixed instructions alone ${instructions.length} chars (~${Math.round(instructions.length / 4)} tokens)`
  );
  check(
    instructions.length < 2400,
    'the fixed instructions stay under 2,400 characters (~600 tokens)',
    String(instructions.length)
  );

  // Through the store: the plan is written after the pass, and Home's top follows it.
  const { coachPassStore } = await import('../src/lib/ai/pass-store.ts');
  await apiKeyStore.hydrate();
  coachPassStore.reset();
  const db5 = seededDay();
  const outcome = await coachPassStore.maybeRun(db5, {
    unlocked: true,
    now: NOW,
    fetchImpl: fetchFor(sse('SKIP\nPLAN DO log_water | Water')),
  });
  check(
    outcome === 'silent' &&
      plan.getDayPlan(db5)?.items[0]?.action === 'log_water' &&
      plan.homeTopFor(db5, at(1), new Set(), ZERO)?.kind === 'coach',
    'the store writes the plan after a silent pass, and the top of Home follows it',
    outcome
  );
  // A pass that never reached the model writes no plan.
  coachPassStore.reset();
  const db6 = seededDay();
  const offline = await coachPassStore.maybeRun(db6, {
    unlocked: true,
    now: NOW,
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  check(
    offline === 'offline' &&
      plan.getDayPlan(db6) === null &&
      plan.homeTopFor(db6, NOW, new Set(), ZERO)?.kind === 'mission',
    'offline: no plan, and Home is time order'
  );

  check(
    !passDirective({ kind: 'daily' }, TODAY).includes('Top of Home'),
    'without the block the directive is the text it was'
  );
  check(
    ACTION_SPEC.log_weight.clearsOnTap === false && ACTION_SPEC.open_coach.clearsOnTap === true,
    'data-backed items wait for their data; open_* items clear on the tap'
  );
}

// ---------------------------------------------------------------------------
console.log('7. the turn context names what Home actually shows');
{
  const db = seededDay();
  const rows = listMission(db, TODAY);
  const creatine = rows.find((r) => r.title === 'Creatine');
  const fishOil = rows.find((r) => r.title === 'Fish oil');
  check(
    buildTurnContext(db, NOW).includes('next: "Creatine" at 07:30'),
    'no plan, nothing snoozed: the first open row'
  );
  snoozeItem(creatine.id);
  check(
    buildTurnContext(db, NOW).includes('next: "Fish oil" at 13:00'),
    'a snoozed row is not "next" — the hero skips it, so the Coach does'
  );
  unsnoozeItem(creatine.id);
  setMissionStatus(db, creatine.id, 'partial', TODAY);
  check(
    buildTurnContext(db, NOW).includes('next: "Creatine" at 07:30'),
    'a PARTIAL row is still the hero, and still "next"'
  );
  plan.applyDayPlan(db, resolution([pinItem(fishOil, 1)]), NOW, ZERO);
  check(
    buildTurnContext(db, at(1)).includes('next: "Fish oil" at 13:00 (pinned by your plan)'),
    'a pinned row is named as pinned'
  );
  plan.applyDayPlan(db, resolution([doItem('log_weight', 1, { title: 'Weigh in' })]), at(2), ZERO);
  check(
    buildTurnContext(db, at(3)).includes(
      'next: your plan item "Weigh in" (log_weight; not a mission row)'
    ),
    'a Coach item is named as one, and as not a mission row'
  );
}

// ---------------------------------------------------------------------------
console.log('8. the status rule: no deterministic read of day_statuses');
{
  const files = [
    'src/lib/home/day-facts.ts',
    'src/lib/home/day-plan.ts',
    'src/lib/home/plan-lines.ts',
    'src/lib/db/repositories/day-plan.ts',
    'src/hooks/use-day-plan.ts',
    'src/components/home/coach-item-row.tsx',
  ];
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const leaks = files.filter((file) => {
    const code = strip(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
    return /day_statuses|repositories\/statuses|lib\/status\/|openStatuses|statusesIn|excusedDatesIn|baselineExclusionsIn/.test(
      code
    );
  });
  check(
    leaks.length === 0,
    `none of the ${files.length} smart-day modules reads a status`,
    leaks.join(', ')
  );

  // And a status changes nothing about the facts or the top of Home.
  const db = seededDay();
  const { startStatus } = await import('../src/lib/db/repositories/statuses.ts');
  const factsBefore = JSON.stringify(plan.gatherDayFacts(db, NOW, ZERO));
  const topBefore = JSON.stringify(plan.homeTopFor(db, NOW, new Set(), ZERO));
  startStatus(db, { label: 'sick', startDate: TODAY, source: 'user' });
  check(
    JSON.stringify(plan.gatherDayFacts(db, NOW, ZERO)) === factsBefore &&
      JSON.stringify(plan.homeTopFor(db, NOW, new Set(), ZERO)) === topBefore,
    'a sick day: the facts and the top of Home are byte-identical — what it means is the Coach’s call'
  );
}

// ---------------------------------------------------------------------------
// LAST, because assigning TZ changes how every local Date in this process reads.
console.log('9. timezone days: the facts read the phone’s own clock');
{
  // TIMEZONE DAYS: the same instants read on the phone's own clock. Node
  // re-reads TZ when it is assigned.
  const savedTz = process.env.TZ;
  try {
    const instant = new Date('2026-10-21T06:30:00Z');
    const weigh = '2026-10-20T14:00:00Z';
    const factsIn = (tz) => {
      process.env.TZ = tz;
      const today = logicalDate(instant, '00:00');
      return {
        today,
        facts: buildDayFacts(emptyInput({ now: instant, today, weighIns: [weigh] })),
      };
    };
    const la = factsIn('America/Los_Angeles');
    const tokyo = factsIn('Asia/Tokyo');
    check(
      la.today === '2026-10-20' &&
        la.facts.clock === '23:30' &&
        la.facts.weighIn.last?.daysAgo === 0,
      'in Los Angeles: 23:30 on the 20th, and the weigh-in was today',
      JSON.stringify([la.today, la.facts.clock, la.facts.weighIn])
    );
    check(
      tokyo.today === '2026-10-21' &&
        tokyo.facts.clock === '15:30' &&
        tokyo.facts.weighIn.last?.daysAgo === 1,
      'in Tokyo: 15:30 on the 21st, and the same weigh-in was yesterday',
      JSON.stringify([tokyo.today, tokyo.facts.clock, tokyo.facts.weighIn])
    );
    check(
      daysBetween('2026-03-07', '2026-03-09') === 2 &&
        daysBetween('2026-10-31', '2026-11-02') === 2,
      'day gaps are DST-proof'
    );
  } finally {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
