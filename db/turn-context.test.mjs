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
import { createExperiment } from '../src/lib/db/repositories/experiments.ts';
import { updateProfile } from '../src/lib/db/repositories/user.ts';
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
    ? ok('no Mode line on an empty day either (Modes removed)')
    : bad('mode line', context);
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

console.log('3. seeded database: profile, readiness, mission, experiments');
{
  const { db, raw } = freshDb();
  updateProfile(db, { dateOfBirth: '1992-01-15', biologicalSex: 'male' });

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
  !context.includes('Mode:')
    ? ok('no Mode line — the Modes feature is removed (2026-08-25)')
    : bad('mode line resurfaced', context);
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
