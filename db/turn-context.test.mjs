/**
 * Headless test of the per-turn "Current state" block (src/lib/ai/turn-context.ts)
 * against real SQLite via node:sqlite — the deterministic preamble every Coach
 * turn now carries so the model never starts blind. Mirrors db/coach-tools.test.mjs;
 * op-sqlite and the model client are never loaded. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { todayISODate } from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { getOrCreateDailyLog, insertMissionItem } from '../src/lib/db/repositories/mission.ts';
import { endStatus, startStatus } from '../src/lib/db/repositories/statuses.ts';
import { createExperiment } from '../src/lib/db/repositories/experiments.ts';
import { setGoalDirection, updateProfile } from '../src/lib/db/repositories/user.ts';
import { addGroceryItems } from '../src/lib/db/repositories/grocery.ts';
import { isoDaysAgo } from '../src/lib/ai/series.ts';
import { ageOn, buildTurnContext } from '../src/lib/ai/turn-context.ts';

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

let seq = 0;
const uid = () => `tc-${++seq}`;
const seedWearable = (raw, metricType, daysAgo, value) =>
  raw
    .prepare(
      `INSERT INTO wearable_data (id, date, metric_type, value, source_device) VALUES (?, ?, ?, ?, 'manual')`
    )
    .run(uid(), isoDaysAgo(NOW, daysAgo), metricType, value);

const NOW = new Date();
const TODAY = todayISODate(NOW);
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

console.log('1. ageOn: whole years, birthday edges, honest null');
{
  ageOn('1992-01-15', '2026-08-08') === 34
    ? ok('mid-year: 34')
    : bad('mid-year', String(ageOn('1992-01-15', '2026-08-08')));
  ageOn('1992-08-08', '2026-08-08') === 34
    ? ok('birthday today counts the new year')
    : bad('birthday', String(ageOn('1992-08-08', '2026-08-08')));
  ageOn('1992-08-09', '2026-08-08') === 33
    ? ok('day before the birthday is still the old year')
    : bad('day-before', String(ageOn('1992-08-09', '2026-08-08')));
  ageOn(null, TODAY) === null && ageOn('junk', TODAY) === null
    ? ok('null/garbage DOB → null, never a fake age')
    : bad('null handling');
  ageOn('2030-01-01', '2026-08-08') === null
    ? ok('future DOB → null (negative age never leaks)')
    : bad('future dob', String(ageOn('2030-01-01', '2026-08-08')));
}

console.log('2. empty database: every line is honest, nothing invented');
{
  const { db } = freshDb();
  const context = buildTurnContext(db, NOW);
  context.includes(`Current date: ${TODAY} (${WEEKDAYS[NOW.getDay()]})`)
    ? ok('date line carries today + weekday')
    : bad('date line', context.split('\n')[1]);
  context.includes('profile not filled in')
    ? ok('no profile → says so')
    : bad('profile line', context);
  !context.includes('Mode:')
    ? ok('NO mode line, ever — modes were retired in 0061')
    : bad('mode line survived', context);
  !context.includes('Status:')
    ? ok('…and no status line on an ordinary day, the Timezone line’s economy')
    : bad('phantom status line', context);
  context.includes('Readiness: no wearable signal yet')
    ? ok('no wearables → honest no-signal line')
    : bad('readiness line', context);
  context.includes('Mission: not generated yet today')
    ? ok('no mission → says so')
    : bad('mission line', context);
  context.includes('Signals: ') ? ok('brief line always present') : bad('signals line', context);
  !context.includes('Experiment ')
    ? ok('no experiments → no experiment lines')
    : bad('phantom experiment', context);
}

console.log('3. seeded database: profile, status, readiness, mission, experiments');
{
  const { db, raw } = freshDb();
  updateProfile(db, { dateOfBirth: '1992-01-15', biologicalSex: 'male' });
  startStatus(db, { label: 'Sick', startDate: TODAY, endDate: TODAY, source: 'user' });

  // 6 baseline days + today, HRV suppressed today → a real readiness verdict.
  for (let d = 1; d <= 6; d++) seedWearable(raw, 'hrv', d, 50);
  seedWearable(raw, 'hrv', 0, 40);

  const log = getOrCreateDailyLog(db, TODAY);
  insertMissionItem(db, log.id, 'habit', {
    id: 'unused',
    title: 'Morning light',
    status: 'completed',
    category: 'Routine',
  });
  insertMissionItem(db, log.id, 'habit', {
    id: 'unused',
    title: 'Zone 2 - 40 min',
    status: 'pending',
    scheduledTime: '17:30',
    category: 'Training',
  });

  createExperiment(db, {
    title: 'Magnesium PM',
    hypothesis: 'Better sleep',
    intervention: '400 mg magnesium glycinate at night',
    metrics: ['hrv', 'sleep'],
    startDate: TODAY,
    durationDays: 14,
  });
  createExperiment(db, {
    title: 'Cold showers',
    hypothesis: 'Higher HRV',
    intervention: '2 min cold finish',
    metrics: ['hrv'],
    startDate: isoDaysAgo(NOW, 10),
    durationDays: 3,
  });

  const context = buildTurnContext(db, NOW);
  context.includes('male') && context.includes('units: weight lb')
    ? ok('profile line carries sex + unit preferences')
    : bad('profile', context);
  // The goal direction rides this same line, and is printed AT ITS DEFAULT
  // unlike Status and Timezone: those are events, where absence means nothing
  // happened, and this is a dial that always has a position. `maintain`
  // withheld is indistinguishable from `maintain` never asked about — the
  // coverage manifest's whole failure mode, one line further down.
  context.includes('· goal: maintain')
    ? ok('…and the goal direction, stated even at its default (a dial, not an event)')
    : bad('goal direction missing from the state block', context);
  {
    const { db: gdb } = freshDb();
    setGoalDirection(gdb, 'cut');
    buildTurnContext(gdb, NOW).includes('· goal: cut')
      ? ok('…and it follows the setting the nutrition pillar actually grades against')
      : bad('goal direction not read back');
  }
  context.includes('Status: sick — since today, through') &&
  context.includes('(set by you)') &&
  context.includes('leave the readiness baselines')
    ? ok('the status line carries the fact, its age, its span and who set it')
    : bad('status', context);
  !context.includes('skips still count')
    ? ok('…and says nothing about excusal, because it excuses (the default)')
    : bad('excusal named when it is the default', context);
  context.includes('Readiness: ') && context.includes('Pillars: ')
    ? ok('readiness verdict + pillars present with wearable data')
    : bad('readiness', context);
  context.includes('Mission: 1 of 2 done') && context.includes('next: "Zone 2 - 40 min" at 17:30')
    ? ok('mission progress + next pending item')
    : bad('mission', context);
  context.includes('Experiment "Magnesium PM": running, 13 days left')
    ? ok('running experiment with days left')
    : bad('running experiment', context);
  context.includes('Experiment "Cold showers": window CLOSED') &&
  context.includes('ready to read out')
    ? ok('an ended experiment is flagged ready to read out')
    : bad('ready experiment', context);
}

console.log('4. an experiment on its final day says "last day", never "0 days left"');
{
  const { db } = freshDb();
  // start = today-2, duration 3 → end_date = today: daysLeft 0, ready false.
  createExperiment(db, {
    title: 'Late caffeine cutoff',
    hypothesis: 'Deeper sleep',
    intervention: 'No caffeine after 12:00',
    metrics: ['sleep'],
    startDate: isoDaysAgo(NOW, 2),
    durationDays: 3,
  });
  const context = buildTurnContext(db, NOW);
  context.includes('Experiment "Late caffeine cutoff": running, last day — window closes tonight')
    ? ok('final day phrased like the app (Home says "Last day" too)')
    : bad('last-day phrasing', context);
  !context.includes('0 days left')
    ? ok('"0 days left" never reaches the model (it invites a premature readout)')
    : bad('raw 0 leaked', context);
}

console.log("R. today's numbers ride in the block, so trivial questions cost no round-trip");
{
  const { db, raw } = freshDb();
  const put = (metric, value) =>
    raw
      .prepare(
        `INSERT INTO wearable_data (id, date, metric_type, value, source_device)
         VALUES (?, ?, ?, ?, 'apple_health')`
      )
      .run(`w-${metric}`, TODAY, metric, value);
  put('steps', 8432);
  put('active_energy_kcal', 412);
  put('sleep_duration_min', 422);
  put('sleep_deep_min', 78);
  put('rhr', 54);

  const context = buildTurnContext(db, NOW);
  // "How many steps have I taken today?" measured ~10k tokens at first live
  // testing, because the model had to spend a whole extra round-trip on
  // get_metric_series to read a number already sitting on disk.
  /8,432 steps/.test(context)
    ? ok('steps are answerable straight from the block — no get_metric_series round-trip')
    : bad('steps missing from context', context);
  /412 kcal active/.test(context) ? ok('active energy too') : bad('kcal missing');
  /slept 7h02/.test(context)
    ? ok('sleep is rendered as hours and minutes, not raw minutes')
    : bad('sleep formatting', context);
  /78 min deep/.test(context) && /RHR 54 bpm/.test(context)
    ? ok('deep sleep and RHR ride along')
    : bad('deep/rhr missing', context);

  // The whole line must stay cheap — it is in the UNCACHED per-turn block, so
  // every token here is paid at full price on every single request.
  const line = context.split('\n').find((l) => l.startsWith('Today so far:'));
  line && line.length < 130
    ? ok(`the line costs ~${Math.round(line.length / 3.6)} uncached tokens (${line.length} chars)`)
    : bad('today line too long for an uncached block', String(line && line.length));

  // A quiet day adds NOTHING, so the model still knows to reach for a tool
  // rather than concluding zero steps from a line that never appeared.
  const { db: quiet } = freshDb();
  !/Today so far/.test(buildTurnContext(quiet, NOW))
    ? ok('no wearable data → no line at all (never a fabricated zero)')
    : bad('empty day still emits the line');
}

console.log('S. the status line: two at once, the exclusion clause, and the revert cue');
{
  const { db } = freshDb();
  startStatus(db, { label: 'Traveling', startDate: isoDaysAgo(NOW, 3), source: 'user' });
  startStatus(db, { label: 'sick', startDate: TODAY, source: 'coach' });
  const context = buildTurnContext(db, NOW);
  const line = context.split('\n').find((l) => l.startsWith('Status:')) ?? '';

  line.includes('sick — since today, open-ended (set by me)') &&
  line.includes('traveling — day 4, open-ended (set by you)')
    ? ok('both statuses are named, newest first, each with its age, span and author')
    : bad('two-status line', line);
  line.includes('Baselines exclude 4 status days')
    ? ok('…and the line says how many days left the readiness baselines')
    : bad('exclusion clause', line);
  !line.includes('No recovery verdict')
    ? ok('…without the escalation, because Recovery can still grade')
    : bad('premature escalation', line);

  // A status the Coach recorded as context WITHOUT absolution says so — the
  // owner's Q2(b) reaching the model, not just the ledger.
  const { db: counting } = freshDb();
  startStatus(counting, {
    label: 'work crunch',
    startDate: TODAY,
    source: 'coach',
    excuses: false,
  });
  (
    buildTurnContext(counting, NOW)
      .split('\n')
      .find((l) => l.startsWith('Status:')) ?? ''
  ).includes('skips still count')
    ? ok('a NON-excusing status is marked; the excusing default is left unsaid')
    : bad('non-excusing not marked', buildTurnContext(counting, NOW));

  // THE REVERT CUE. Nothing else tells the Coach a window it bounded with
  // update_protocol has closed.
  const { db: over } = freshDb();
  const row = startStatus(over, {
    label: 'traveling',
    startDate: isoDaysAgo(NOW, 5),
    source: 'user',
  });
  endStatus(over, row.id, isoDaysAgo(NOW, 1));
  const ended = buildTurnContext(over, NOW);
  ended.includes('traveling ended yesterday — put back what it took out.')
    ? ok('the day after it ends, the block says so once')
    : bad('no revert cue', ended);
  const { db: longOver } = freshDb();
  const old = startStatus(longOver, {
    label: 'traveling',
    startDate: isoDaysAgo(NOW, 9),
    source: 'user',
  });
  endStatus(longOver, old.id, isoDaysAgo(NOW, 2));
  !buildTurnContext(longOver, NOW).includes('Status:')
    ? ok('…and the day after THAT, nothing — it is not a sentence re-sent forever')
    : bad('revert cue outstayed its welcome', buildTurnContext(longOver, NOW));

  // TWO OVERLAPPING. Sick ended yesterday while Traveling runs on: the cue is
  // about the status that ended, and whether some other one is still open has
  // no bearing on it. Until 2026-09-23 it printed only when NOTHING was open,
  // so ending Sick on a trip told the Coach nothing the next day.
  const { db: overlap } = freshDb();
  startStatus(overlap, { label: 'traveling', startDate: isoDaysAgo(NOW, 6), source: 'user' });
  const flu = startStatus(overlap, {
    label: 'sick',
    startDate: isoDaysAgo(NOW, 4),
    source: 'user',
  });
  endStatus(overlap, flu.id, isoDaysAgo(NOW, 1));
  const both = buildTurnContext(overlap, NOW);
  const statusLines = both.split('\n').filter((l) => l.startsWith('Status:'));
  both.includes('sick ended yesterday — put back what it took out.')
    ? ok('ending Sick while Traveling continues still gives the revert cue the next day')
    : bad('revert cue suppressed by an open status', both);
  statusLines.length === 2 &&
  statusLines[0].includes('traveling — day 7, open-ended') &&
  !statusLines[0].includes('sick') &&
  !statusLines[1].includes('traveling')
    ? ok('…on its own line, after the open status, and neither line names the other')
    : bad('overlap lines', statusLines.join(' | '));

  // The same label ended yesterday and running again today (a relapse, or a
  // second tap): "put back what it took out" would contradict the open line,
  // so the cue is withheld for that label and only that label.
  const { db: relapse } = freshDb();
  const first = startStatus(relapse, {
    label: 'sick',
    startDate: isoDaysAgo(NOW, 3),
    source: 'user',
  });
  endStatus(relapse, first.id, isoDaysAgo(NOW, 1));
  startStatus(relapse, { label: 'sick', startDate: TODAY, source: 'user' });
  const injury = startStatus(relapse, {
    label: 'injured',
    startDate: isoDaysAgo(NOW, 2),
    source: 'user',
  });
  endStatus(relapse, injury.id, isoDaysAgo(NOW, 1));
  const back = buildTurnContext(relapse, NOW);
  !back.includes('sick ended yesterday') && back.includes('injured ended yesterday')
    ? ok('a label running again today gets no revert cue; another that ended still does')
    : bad('relapse cue', back);

  // A booking the Coach made for next week, so a later session can see it.
  const { db: booked } = freshDb();
  startStatus(booked, {
    label: 'traveling',
    startDate: isoDaysAgo(NOW, -4),
    endDate: isoDaysAgo(NOW, -8),
    source: 'coach',
  });
  const bookedContext = buildTurnContext(booked, NOW);
  bookedContext.includes(`Scheduled: traveling from ${isoDaysAgo(NOW, -4)}`) &&
  !bookedContext.includes('Status:')
    ? ok('a scheduled status is named as scheduled, never as open')
    : bad('scheduled line', bookedContext);
}

console.log('G. the standing grocery list rides in the block, so an add costs no pre-read');
{
  // "We need milk" cost the owner TWO tool calls (get_grocery_list, then
  // add_grocery_items) and therefore THREE requests, each re-sending the whole
  // 14.6k-token cached prefix. The read existed only to honour "never re-add an
  // open duplicate" — a question the block can answer for a few tokens.
  const groceryLine = (db) =>
    buildTurnContext(db, NOW)
      .split('\n')
      .find((l) => l.startsWith('Grocery list'));

  const { db: empty } = freshDb();
  groceryLine(empty) === 'Grocery list: empty'
    ? ok('empty list says so — the strongest possible "milk is not on it" signal')
    : bad('empty grocery line', String(groceryLine(empty)));

  const { db } = freshDb();
  addGroceryItems(db, [
    { name: 'eggs', qty_text: '18' },
    { name: 'olive oil', qty_text: '1 L' },
    { name: 'Eggs', qty_text: '6' },
  ]);
  const line = groceryLine(db);
  /eggs/i.test(line) && /olive oil/.test(line)
    ? ok('open items are named, so a duplicate check needs no round-trip')
    : bad('names missing from grocery line', String(line));
  // Consolidated by normalized name — "eggs" and "Eggs" are one line, exactly
  // as the Log screen draws them, so the model cannot think it has two.
  (line.match(/eggs/gi) ?? []).length === 1
    ? ok('duplicate names consolidate to one entry')
    : bad('grocery line double-counts a name', String(line));
  !/18|1 L/.test(line)
    ? ok('quantities stay out — the duplicate check does not need them')
    : bad('quantities leaked into the uncached block', String(line));
  !/[0-9a-f]{8}-[0-9a-f]{4}/.test(line)
    ? ok('no ids — a v4 UUID costs more tokens than the item it labels')
    : bad('ids leaked into the uncached block', String(line));
  /get_grocery_list/.test(line)
    ? ok('names-only is declared, so the model still reads the tool for ids')
    : bad('grocery line does not point at the tool', String(line));

  // Past the cap the block reports the COUNT and stops. A TRUNCATED list is
  // worse than none: the model cannot tell "not shown" from "not listed", and
  // would re-add a duplicate with full confidence.
  const { db: big } = freshDb();
  addGroceryItems(
    big,
    Array.from({ length: 45 }, (_, i) => ({ name: `item ${i}` }))
  );
  const bigLine = groceryLine(big);
  /45 open items/.test(bigLine) && !/item 7/.test(bigLine)
    ? ok('past the cap: the count and a pointer at the tool, never a partial list')
    : bad('long grocery list not capped honestly', String(bigLine));

  // It is in the UNCACHED block, so every character is billed at full rate on
  // every request of every turn — a shopping list must never tax sleep questions.
  const { db: typical } = freshDb();
  addGroceryItems(
    typical,
    'milk eggs spinach yogurt salmon olive-oil almonds berries coffee kefir'
      .split(' ')
      .map((name) => ({ name }))
  );
  const typicalLine = groceryLine(typical);
  typicalLine.length < 220
    ? ok(`a 10-item list costs ~${Math.round(typicalLine.length / 3.6)} uncached tokens`)
    : bad('grocery line too long for an uncached block', String(typicalLine.length));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
