/**
 * Headless test of day statuses (migration 0061, docs/spikes/coach-status-
 * buttons-modes-retirement.md) against real SQLite via node:sqlite: the
 * schema and its CHECKs, the retirement row that ends day modes, the
 * repository, the shared excusal definition, the carry, and the readiness
 * baselines. op-sqlite and the model client are never loaded.
 * Run: npm run db:test.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { shiftISODate } from '../src/lib/db/date.ts';
import { getActiveMode } from '../src/lib/db/repositories/day-modes.ts';
import {
  clampStatusSpan,
  endAllStatuses,
  endStatus,
  excusingStatusDaysIn,
  normalizeStatusLabel,
  openStatuses,
  startStatus,
  statusDayNumber,
  statusDaysIn,
  statusesIn,
} from '../src/lib/db/repositories/statuses.ts';
import {
  excusedDatesIn,
  getOrCreateDailyLog,
  insertMissionItem,
  missionDailySeries,
  missionOwed,
} from '../src/lib/db/repositories/mission.ts';
import { generateMissionForDay, planForDay } from '../src/lib/db/repositories/mission-generate.ts';
import { createProtocolWithVersion } from '../src/lib/db/repositories/protocols.ts';
import { upsertWearableRows } from '../src/lib/db/repositories/wearables.ts';
import { deriveReadiness } from '../src/lib/home/readiness.ts';
import { baselineExclusionsIn, hasExclusionSource } from '../src/lib/home/baseline-exclusions.ts';
import { endPromptFor, promptFor, railChips, reaskFor } from '../src/lib/status/chips.ts';
import {
  addMealItem,
  dayAlcohol,
  dayMicroTotals,
  getMeal,
  listMealItems,
  listTodayMeals,
  logMealWithItems,
  nightOutDrinks,
  setItemCount,
  todayTotals,
  updateMealName,
} from '../src/lib/db/repositories/nutrition.ts';
import {
  DRINK_KINDS,
  DRINKS_DEFAULT,
  DRINKS_MAX,
  ETHANOL_KCAL_PER_G,
  STANDARD_DRINK_G,
  alcoholLastNightLine,
  clampDrinks,
  drinksItem,
  nightOutPrompt,
} from '../src/lib/nutrition/drinks.ts';
import { MICROS, parseMicros, scaleMicros, serializeMicros } from '../src/lib/nutrition/micros.ts';
import {
  NIGHT_OUT_CARRIES_UNTIL_HOUR,
  nightOutDay,
  nightOutStepper,
  recordNightOut,
  recordedDrinks,
  saveNightOutDrinks,
} from '../src/lib/status/night-out.ts';
import { buildTurnContext } from '../src/lib/ai/turn-context.ts';
import {
  composerKey,
  NO_SEED,
  seedFromParam,
  seedFromRail,
} from '../src/lib/status/composer-seed.ts';

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

function executorFor(raw, db) {
  return {
    exec: (sql) => raw.exec(sql),
    getUserVersion: () => raw.prepare('PRAGMA user_version').get().user_version,
    setUserVersion: (n) => raw.exec(`PRAGMA user_version = ${n}`),
    transaction: db.transaction,
  };
}

function freshDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const db = makeDb(raw);
  migrate(executorFor(raw, db), MIGRATIONS);
  return { raw, db };
}

const refuses = (raw, sql, params = []) => {
  try {
    raw.prepare(sql).run(...params);
    return false;
  } catch {
    return true;
  }
};

const insertStatus = (raw, cols) =>
  raw
    .prepare(
      `INSERT INTO day_statuses (id, label, start_date, end_date, excuses, note, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      cols.id,
      cols.label,
      cols.start_date,
      cols.end_date ?? null,
      cols.excuses,
      cols.note ?? null,
      cols.source
    );

const TODAY = '2026-09-19';
const daysAgo = (n) => shiftISODate(TODAY, -n);

// ===========================================================================
console.log('1. 0061 on a fresh database: the table, every CHECK, and the retirement row');
// ===========================================================================
{
  const { raw, db } = freshDb();

  const table = raw
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'day_statuses'`)
    .get();
  table ? ok('day_statuses exists') : bad('no day_statuses table');

  const idx = raw
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'day_statuses_start_idx'`
    )
    .get();
  idx ? ok('…with the start_date index') : bad('no index');

  const trg = raw
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'day_statuses_set_updated_at'`
    )
    .get();
  trg ? ok('…and the standard updated_at trigger') : bad('no trigger');

  // A good row first, so every refusal below is a refusal of ONE thing.
  insertStatus(raw, {
    id: 's-good',
    label: 'sick',
    start_date: '2026-09-10',
    end_date: null,
    excuses: 1,
    source: 'user',
  });
  const good = raw.prepare(`SELECT * FROM day_statuses WHERE id = 's-good'`).get();
  good && good.created_at && good.updated_at
    ? ok('a good row inserts and stamps both timestamps')
    : bad('good row', JSON.stringify(good));

  // The NOT-NULL id. SQLite's PRIMARY KEY alone permits nulls on a text key.
  refuses(
    raw,
    `INSERT INTO day_statuses (id, label, start_date, excuses, source)
                VALUES (NULL, 'sick', '2026-09-10', 1, 'user')`
  )
    ? ok('a NULL id is refused — the NOT NULL, not the PRIMARY KEY')
    : bad('null id accepted');

  const long = 'x'.repeat(41);
  refuses(
    raw,
    `INSERT INTO day_statuses (id, label, start_date, excuses, source)
                VALUES ('s-long', ?, '2026-09-10', 1, 'user')`,
    [long]
  )
    ? ok('a 41-character label is refused')
    : bad('long label accepted');

  refuses(
    raw,
    `INSERT INTO day_statuses (id, label, start_date, excuses, source)
                VALUES ('s-empty', '', '2026-09-10', 1, 'user')`
  )
    ? ok('an empty label is refused')
    : bad('empty label accepted');

  refuses(
    raw,
    `INSERT INTO day_statuses (id, label, start_date, excuses, source)
                VALUES ('s-normal', 'normal', '2026-09-10', 1, 'user')`
  )
    ? ok("'normal' is refused as a row — it is a COMMAND")
    : bad('normal accepted as a row');

  refuses(
    raw,
    `INSERT INTO day_statuses (id, label, start_date, end_date, excuses, source)
                VALUES ('s-back', 'sick', '2026-09-10', '2026-09-09', 1, 'user')`
  )
    ? ok('end_date before start_date is refused')
    : bad('inverted span accepted');

  refuses(
    raw,
    `INSERT INTO day_statuses (id, label, start_date, excuses, source)
                VALUES ('s-date', 'sick', '10 Sep 2026', 1, 'user')`
  )
    ? ok('a non-ISO start_date is refused by the GLOB')
    : bad('bad date accepted');

  refuses(
    raw,
    `INSERT INTO day_statuses (id, label, start_date, excuses, source)
                VALUES ('s-src', 'sick', '2026-09-10', 1, 'health')`
  )
    ? ok("an unknown source is refused ('user' | 'coach')")
    : bad('bad source accepted');

  refuses(
    raw,
    `INSERT INTO day_statuses (id, label, start_date, excuses, source)
                VALUES ('s-exc', 'sick', '2026-09-10', 2, 'user')`
  )
    ? ok('excuses = 2 is refused — the column is a boolean')
    : bad('excuses 2 accepted');

  refuses(
    raw,
    `INSERT INTO day_statuses (id, label, start_date, source)
                VALUES ('s-null-exc', 'sick', '2026-09-10', 'user')`
  )
    ? ok('excuses has NO DEFAULT — a row cannot carry a judgement nobody made')
    : bad('excuses defaulted');

  // The retirement row: by NAME, never by version.
  const retired = raw.prepare(`SELECT * FROM day_modes WHERE id = 'modes-retired'`).get();
  retired && retired.mode === 'normal' && retired.end_date === null
    ? ok("the retirement row exists, is 'normal' and is open-ended")
    : bad('retirement row', JSON.stringify(retired));
  retired && /^\d{4}-\d{2}-\d{2}$/.test(retired.start_date)
    ? ok('…dated with a real ISO day')
    : bad('retirement start_date', retired?.start_date);
  getActiveMode(db, retired.start_date) === 'normal'
    ? ok('…and it resolves the day it starts on to Normal')
    : bad('retirement does not resolve');
}

// ===========================================================================
console.log('\n2. production ordering AND the numbering guard, in one');
// ===========================================================================
{
  // Stage every migration up to 0060 BY NAME — never by a hardcoded number, so
  // this test still means what it says after the next renumber.
  const head = MIGRATIONS.find((m) => m.name === '0060_timezone_zone_pair');
  const retirement = MIGRATIONS.find((m) => m.name === '0061_status_replaces_modes');
  head && retirement
    ? ok('0060 and 0061 are both in the bundle, found by name')
    : bad('migration names moved', JSON.stringify([head?.name, retirement?.name]));

  retirement.version > head.version
    ? ok(`…and 0061 sorts ABOVE the staged head (v${retirement.version} > v${head.version})`)
    : bad('0061 is not above 0060 — the runner would skip it forever');

  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const db = makeDb(raw);
  migrate(
    executorFor(raw, db),
    MIGRATIONS.filter((m) => m.version <= head.version)
  );

  // A device in the pre-0061 world: an OPEN-ENDED sick mode set last month from
  // the Home picker, and a Travel range booked for next week.
  //
  // "Next week" counts from the day the release LANDS — the day 0061 stamps
  // its retirement row with, SQLite's `date('now')` — not from the suite's
  // fixed TODAY. Booked off TODAY, the range fell before the retirement row
  // once the wall clock passed TODAY + 7, and the assertion below failed on
  // every run from 2026-09-27 on while the migration was right (2026-10-21).
  const landsOn = raw.prepare(`SELECT date('now') AS d`).get().d;
  raw
    .prepare(`INSERT INTO day_modes (id, mode, start_date, end_date) VALUES (?, ?, ?, ?)`)
    .run('m-sick', 'sick', daysAgo(30), null);
  raw
    .prepare(`INSERT INTO day_modes (id, mode, start_date, end_date) VALUES (?, ?, ?, ?)`)
    .run('m-travel', 'travel', shiftISODate(landsOn, 7), shiftISODate(landsOn, 11));

  // …then the release lands.
  migrate(executorFor(raw, db), MIGRATIONS);

  const row = raw.prepare(`SELECT start_date FROM day_modes WHERE id = 'modes-retired'`).get();
  row ? ok('the retirement row applied on top of a staged device') : bad('retirement not applied');

  getActiveMode(db, daysAgo(30)) === 'sick'
    ? ok('last month still reads Sick — history is untouched')
    : bad('history rewritten', getActiveMode(db, daysAgo(30)));

  const after = shiftISODate(row.start_date, 1);
  getActiveMode(db, after) === 'normal'
    ? ok('the day after the retirement reads Normal — the open-ended mode is over')
    : bad('open-ended mode survived', getActiveMode(db, after));

  getActiveMode(db, shiftISODate(landsOn, 8)) === 'normal'
    ? ok('…and next week reads Normal too — the scheduled Travel range is cancelled')
    : bad('future mode survived', getActiveMode(db, shiftISODate(landsOn, 8)));
}

// ===========================================================================
console.log('\n3. the repository: spans, the re-tap guard, and the excusal flag');
// ===========================================================================
{
  const { db } = freshDb();

  normalizeStatusLabel('  Night   Out ') === 'night out'
    ? ok('a label is trimmed, collapsed and lower-cased')
    : bad('normalize', normalizeStatusLabel('  Night   Out '));

  // ── the chip's own write: no flag stated, so the default applies.
  const sick = startStatus(db, { label: 'Sick', startDate: TODAY, source: 'user' });
  sick.excuses === 1 && sick.label === 'sick' && sick.end_date === null
    ? ok("THE CHIP'S DEFAULT: a status written with no flag EXCUSES (excuses = 1)")
    : bad('chip default', JSON.stringify(sick));
  sick.source === 'user' ? ok('…and records its provenance') : bad('source', sick.source);

  // ── the re-tap guard.
  const again = startStatus(db, { label: 'sick', startDate: TODAY, source: 'user' });
  again.id === sick.id && openStatuses(db, TODAY).length === 1
    ? ok('a re-tap is a NO-OP returning the open row — one row, not two')
    : bad('re-tap', openStatuses(db, TODAY).length);

  // ── the owner's rule: an OMITTED flag preserves the stored value.
  startStatus(db, { label: 'sick', startDate: TODAY, source: 'coach', excuses: false });
  openStatuses(db, TODAY)[0].excuses === 0
    ? ok('an explicit excuses:false flips the stored flag')
    : bad('flip to false failed');
  startStatus(db, { label: 'sick', startDate: TODAY, source: 'coach' });
  openStatuses(db, TODAY)[0].excuses === 0
    ? ok('AN OMITTED FLAG PRESERVES IT — a re-ask never silently re-excuses the day')
    : bad('omitted flag re-excused the day');
  startStatus(db, { label: 'sick', startDate: TODAY, source: 'coach', excuses: true });
  openStatuses(db, TODAY)[0].excuses === 1
    ? ok('…and an explicit excuses:true flips it back')
    : bad('flip to true failed');

  // ── several open at once, newest started first.
  const { db: many } = freshDb();
  startStatus(many, { label: 'traveling', startDate: daysAgo(4), source: 'user' });
  startStatus(many, { label: 'sick', startDate: TODAY, source: 'coach', note: 'day 1' });
  const open = openStatuses(many, TODAY);
  open.length === 2 && open[0].label === 'sick' && open[1].label === 'traveling'
    ? ok('two statuses are open at once, newest started first')
    : bad('open ordering', JSON.stringify(open.map((r) => r.label)));
  open[1] && statusDayNumber(open[1], TODAY) === 5
    ? ok('…and a status knows what day it is on (day 5 of a trip)')
    : bad('day number', statusDayNumber(open[1], TODAY));

  // ── the window: clamped, and empty for an inverted range.
  const days = statusDaysIn(many, daysAgo(2), TODAY);
  days.size === 3 && days.has(daysAgo(2)) && days.has(TODAY) && !days.has(daysAgo(4))
    ? ok('statusDaysIn clamps an open-ended span to the window')
    : bad('clamp', [...days].join(','));
  statusDaysIn(many, TODAY, daysAgo(3)).size === 0
    ? ok('…and returns nothing for an inverted range')
    : bad('inverted range');

  // ── a FUTURE-dated status is stored for its own span and nothing before it.
  const { db: future } = freshDb();
  startStatus(future, {
    label: 'traveling',
    startDate: shiftISODate(TODAY, 3),
    endDate: shiftISODate(TODAY, 6),
    source: 'coach',
  });
  openStatuses(future, TODAY).length === 0 &&
  openStatuses(future, shiftISODate(TODAY, 4)).length === 1
    ? ok('a future-dated status covers its own days and not today')
    : bad('future span');
  clampStatusSpan(
    statusesIn(future, TODAY, shiftISODate(TODAY, 10))[0],
    TODAY,
    shiftISODate(TODAY, 10)
  ).days === 4
    ? ok('…and clampStatusSpan counts its four days')
    : bad('clamped span days');

  // ── `end_date` vs `ended`: the two rows the rail has to tell apart.
  const { db: ended } = freshDb();
  // Born bounded at today — Night out, which ends tonight. ON today.
  const night = startStatus(ended, {
    label: 'night out',
    startDate: TODAY,
    endDate: TODAY,
    source: 'user',
  });
  openStatuses(ended, TODAY).length === 1 &&
  openStatuses(ended, shiftISODate(TODAY, 1)).length === 0
    ? ok('a status born bounded at today is ON today and gone tomorrow')
    : bad('bounded status', openStatuses(ended, TODAY).length);

  // Closed by hand — the ×. OFF at once, and today still covered.
  const sickRow = startStatus(ended, { label: 'sick', startDate: daysAgo(3), source: 'user' });
  endStatus(ended, sickRow.id, TODAY) ? ok('the × ends a running status') : bad('end failed');
  !openStatuses(ended, TODAY).some((r) => r.label === 'sick')
    ? ok('…its chip goes dark THE SAME DAY — ended = 1, not merely a span')
    : bad('chip stayed on after the ×');
  statusDaysIn(ended, TODAY, TODAY).has(TODAY)
    ? ok('…and today stays covered, so the evening’s skips stay excused')
    : bad('today lost its coverage');
  statusesIn(ended, daysAgo(5), TODAY).length === 2
    ? ok('…because the row is kept, never deleted')
    : bad('row deleted on end');
  endStatus(ended, sickRow.id, TODAY) === false
    ? ok('…and ending it twice is false, not a second write')
    : bad('double end');

  // ── 'normal' is a command: it closes every running row and inserts none.
  const { db: reset } = freshDb();
  startStatus(reset, { label: 'sick', startDate: daysAgo(2), source: 'user' });
  startStatus(reset, { label: 'injured', startDate: daysAgo(1), source: 'user' });
  const closed = endAllStatuses(reset, TODAY);
  closed === 2 &&
  openStatuses(reset, TODAY).length === 0 &&
  statusesIn(reset, daysAgo(5), TODAY).length === 2
    ? ok("'normal' closes every running row and INSERTS NONE")
    : bad('normal reset', `${closed} closed, ${statusesIn(reset, daysAgo(5), TODAY).length} rows`);

  // A status scheduled for next week is NOT cancelled — statuses do not
  // supersede each other, so nothing forces the set_mode reset's behaviour.
  const { db: ahead } = freshDb();
  startStatus(ahead, { label: 'traveling', startDate: shiftISODate(TODAY, 7), source: 'coach' });
  startStatus(ahead, { label: 'sick', startDate: TODAY, source: 'user' });
  endAllStatuses(ahead, TODAY);
  openStatuses(ahead, shiftISODate(TODAY, 7)).length === 1
    ? ok("…and it leaves next week's scheduled status standing")
    : bad('scheduled status cancelled');
}

// ===========================================================================
console.log('\n4. the ledger: excusing and NON-excusing statuses over the same day');
// ===========================================================================
{
  const { db } = freshDb();
  const EXCUSED = daysAgo(2);
  const COUNTED = daysAgo(1);

  // The same day twice over: 3 planned, 1 completed, 1 skipped, 1 untouched.
  // Only the status's `excuses` flag differs, so any difference below is the
  // owner's Q2(b) doing its job.
  for (const date of [EXCUSED, COUNTED]) {
    const log = getOrCreateDailyLog(db, date);
    for (const [title, status] of [
      ['Creatine', 'completed'],
      ['Zone 2', 'skipped'],
      ['Magnesium', 'pending'],
    ]) {
      insertMissionItem(db, log.id, 'habit', { id: '', title, status, category: 'Routine' });
    }
  }
  startStatus(db, { label: 'sick', startDate: EXCUSED, endDate: EXCUSED, source: 'user' });
  startStatus(db, {
    label: 'work crunch',
    startDate: COUNTED,
    endDate: COUNTED,
    source: 'coach',
    excuses: false,
  });

  const series = missionDailySeries(db, 14, TODAY);
  const excused = series.find((p) => p.date === EXCUSED);
  const counted = series.find((p) => p.date === COUNTED);

  excused && excused.excused === 2 && excused.skipped === 0 && missionOwed(excused) === 1
    ? ok('an EXCUSING status excuses the tap AND the untouched item — 1 owed of 3')
    : bad('excusing status', JSON.stringify(excused));
  counted && counted.excused === 0 && counted.skipped === 1 && missionOwed(counted) === 3
    ? ok('a NON-EXCUSING status changes nothing — the skip is a miss, 3 owed')
    : bad('non-excusing status', JSON.stringify(counted));

  const dates = excusedDatesIn(db, daysAgo(5), TODAY);
  dates.has(EXCUSED) && !dates.has(COUNTED)
    ? ok('…and the ONE shared definition holds only the excusing day')
    : bad('excusedDatesIn', [...dates].join(','));

  // A live day is not forgiven early, whatever the status says.
  const { db: live } = freshDb();
  const log = getOrCreateDailyLog(live, TODAY);
  insertMissionItem(live, log.id, 'habit', {
    id: '',
    title: 'Zone 2',
    status: 'skipped',
    category: 'Routine',
  });
  insertMissionItem(live, log.id, 'habit', {
    id: '',
    title: 'Magnesium',
    status: 'pending',
    category: 'Routine',
  });
  startStatus(live, { label: 'sick', startDate: TODAY, source: 'user' });
  const today = missionDailySeries(live, 14, TODAY).find((p) => p.date === TODAY);
  today && today.excused === 1 && missionOwed(today) === 1
    ? ok('on a LIVE status day only the tap is excused — a pending item is a morning')
    : bad('live status day', JSON.stringify(today));
}

// ===========================================================================
console.log('\n5. the carry: nothing carries out of an excused day, by ANY reason');
// ===========================================================================
{
  const mkCarry = () => {
    const { raw, db } = freshDb();
    createProtocolWithVersion(
      db,
      { name: 'Evening stack', type: 'supplement_stack', startedOn: daysAgo(3), carryOver: true },
      {
        schema: 2,
        phases: [
          {
            id: 'p0',
            title: null,
            duration_days: null,
            items: [
              {
                id: 'mag',
                title: 'Magnesium',
                scheduled_time: null,
                dose: null,
                notes: null,
                // Friday only. TODAY (2026-09-19) is a Saturday, so the item
                // has no native occurrence today and a debt from yesterday can
                // actually carry — a daily item is simply re-planned instead.
                cadence: { kind: 'weekdays', days: [5] },
              },
            ],
          },
        ],
      }
    );
    return { raw, db };
  };
  const carriedTitles = (db, date) =>
    planForDay(db, date)
      .filter((e) => e.extras?.carried === true)
      .map((e) => e.title);

  // Control: an untouched day DOES breed a debt.
  {
    const { db } = mkCarry();
    generateMissionForDay(db, daysAgo(1));
    carriedTitles(db, TODAY).length === 1
      ? ok('CONTROL: an untouched pending row yesterday carries into today')
      : bad('control carry', JSON.stringify(carriedTitles(db, TODAY)));
  }
  // A status day forgives it.
  {
    const { db } = mkCarry();
    generateMissionForDay(db, daysAgo(1));
    startStatus(db, { label: 'sick', startDate: daysAgo(1), endDate: daysAgo(1), source: 'user' });
    carriedTitles(db, TODAY).length === 0
      ? ok('nothing carries out of a STATUS day — the ledger forgave it')
      : bad('status carry', JSON.stringify(carriedTitles(db, TODAY)));
  }
  // …and so does a timezone day. THE C11 CHANGE, asserted: `outstandingCarries`
  // used to apply its own mode-only filter and never saw this.
  {
    const { raw, db } = mkCarry();
    generateMissionForDay(db, daysAgo(1));
    raw
      .prepare(
        `INSERT INTO timezone_changes
           (id, changed_at, from_offset_min, to_offset_min, from_local_date, to_local_date)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('tz-1', `${daysAgo(1)}T09:00:00.000Z`, -480, 60, daysAgo(1), daysAgo(1));
    carriedTitles(db, TODAY).length === 0
      ? ok('nothing carries out of a TIMEZONE-excused day either — the C11 change')
      : bad('timezone carry', JSON.stringify(carriedTitles(db, TODAY)));
  }
  // A NON-excusing status still breeds the debt: it did not forgive the day.
  {
    const { db } = mkCarry();
    generateMissionForDay(db, daysAgo(1));
    startStatus(db, {
      label: 'work crunch',
      startDate: daysAgo(1),
      endDate: daysAgo(1),
      source: 'coach',
      excuses: false,
    });
    carriedTitles(db, TODAY).length === 1
      ? ok('…but a NON-excusing status does not forgive the debt')
      : bad('non-excusing carry', JSON.stringify(carriedTitles(db, TODAY)));
  }
}

// ===========================================================================
console.log('\n6. the readiness baselines: excluded, counted, and honest about it');
// ===========================================================================
{
  const plantHrv = (db, date, value) =>
    upsertWearableRows(db, [
      {
        date,
        metricType: 'hrv',
        value,
        unit: 'ms',
        sourceDevice: 'apple_watch',
        sourceRawId: `hk:hrv:${date}`,
        startTime: null,
        endTime: null,
        metadata: {},
      },
    ]);
  const plantSession = (db, date, sets) => {
    db.run(`INSERT INTO workouts (id, date, name, kind) VALUES (?, ?, '', 'strength')`, [
      `w-${date}`,
      date,
    ]);
    for (let i = 0; i < sets; i++) {
      db.run(
        `INSERT INTO workout_sets (id, workout_id, exercise, exercise_id, set_index, set_type, reps, weight_kg)
         VALUES (?, ?, 'Barbell Bench Press', 'barbell-bench-press', ?, 'normal', 8, 80)`,
        [`w-${date}-${i}`, `w-${date}`, i]
      );
    }
  };
  /** 30 prior HRV days plus five prior sessions, so Strain is never vacuous. */
  const plantHistory = (db, { dip = [] } = {}) => {
    for (let i = 1; i <= 30; i++) plantHrv(db, daysAgo(i), dip.includes(i) ? 20 : 50);
    plantHrv(db, TODAY, 50);
    for (let i = 2; i <= 6; i++) plantSession(db, daysAgo(i), 12);
    plantSession(db, daysAgo(1), 12);
  };

  // (a) three of 30 days under a status — the baseline is the other 27.
  {
    const { db } = freshDb();
    plantHistory(db, { dip: [1, 2, 3] });
    startStatus(db, { label: 'sick', startDate: daysAgo(3), endDate: daysAgo(1), source: 'user' });
    const view = deriveReadiness(db, TODAY);
    view.excludedStatusDays === 3
      ? ok('three status days are excluded — and COUNTED, so the copy can say so')
      : bad('excluded count', view.excludedStatusDays);
    view.recoveryDaysRemaining === 0 &&
    view.pillars.find((p) => p.label === 'Recovery').level !== 'unknown'
      ? ok('…Recovery still has a verdict, graded against the other 27 days')
      : bad('recovery lost', JSON.stringify(view.pillars.find((p) => p.label === 'Recovery')));

    const exclusions = baselineExclusionsIn(db, daysAgo(31), TODAY, TODAY);
    hasExclusionSource(exclusions, 'status') && !hasExclusionSource(exclusions, 'away')
      ? ok('…and the exclusion names its SOURCE as `status`, not as a trip')
      : bad('exclusion source');
  }

  // (b) day 3 of an open status with a full history — present, still grading.
  {
    const { db } = freshDb();
    plantHistory(db);
    startStatus(db, { label: 'traveling', startDate: daysAgo(2), source: 'user' });
    const view = deriveReadiness(db, TODAY);
    view.excludedStatusDays === 3 && view.recoveryDaysRemaining === 0
      ? ok('day 3 of an open status: 3 days excluded, no verdict lost yet')
      : bad('day 3', `${view.excludedStatusDays}/${view.recoveryDaysRemaining}`);
  }

  // (c) a 31-day open status — Recovery starves, Strain keeps grading.
  {
    const { db } = freshDb();
    plantHistory(db);
    startStatus(db, { label: 'injured', startDate: daysAgo(31), source: 'user' });
    const view = deriveReadiness(db, TODAY);
    const recovery = view.pillars.find((p) => p.label === 'Recovery');
    const strain = view.pillars.find((p) => p.label === 'Strain');
    recovery.level === 'unknown' && view.recoveryDaysRemaining > 0 && view.recoveryPausedByStatus
      ? ok('past ~25 days Recovery reads `unknown`, and the STATUS is named as the reason')
      : bad('long status recovery', JSON.stringify([recovery.level, view.recoveryDaysRemaining]));
    strain.level !== 'unknown'
      ? ok('…while STRAIN keeps grading — its baseline is session-counted, never excluded')
      : bad('strain lost its verdict', JSON.stringify(strain));
    view.pillars.find((p) => p.label === 'Sleep') &&
    view.pillars.find((p) => p.label === 'Nutrition')
      ? ok('…and Sleep and Nutrition read today only, so they are untouched')
      : bad('pillars missing');
  }

  // The ordinary day: nothing excluded, nothing said.
  {
    const { db } = freshDb();
    plantHistory(db);
    const view = deriveReadiness(db, TODAY);
    view.excludedStatusDays === 0 && view.recoveryPausedByStatus === false
      ? ok('on an ordinary day the count is zero and the status sheet prints no clause')
      : bad('ordinary day');
  }

  // (e) WHAT HOME STILL DRAWS DOES NOT MOVE when a status starts or ends TODAY
  // (2026-09-23). useReadiness stopped re-deriving on a status change when
  // Home's line went: the day joins the exclusion set, but a baseline only
  // reads the days before the one it grades. Only the COUNT moves, and Home no
  // longer prints it — the status sheet derives its own when it opens. `now` is
  // pinned, so a minute boundary between derivations cannot move the clock.
  {
    const { db } = freshDb();
    // Yesterday dips, so a baseline that lost it would read differently.
    plantHistory(db, { dip: [1] });
    const now = new Date('2026-09-19T12:00:00');
    const drawn = (view) => JSON.stringify([view.readiness, view.pillars, view.metrics]);
    const before = deriveReadiness(db, TODAY, { now });
    const row = startStatus(db, { label: 'sick', startDate: TODAY, source: 'user' });
    const started = deriveReadiness(db, TODAY, { now });
    endStatus(db, row.id, TODAY);
    const ended = deriveReadiness(db, TODAY, { now });
    drawn(started) === drawn(before) && drawn(ended) === drawn(before)
      ? ok('starting or ending a status TODAY moves nothing Home draws from readiness')
      : bad('a status moved the readiness view Home draws', drawn(started));
    started.excludedStatusDays === before.excludedStatusDays + 1 &&
    ended.excludedStatusDays === started.excludedStatusDays
      ? ok('…only the count moves (+1, today), and ending leaves today covered')
      : bad(
          'count',
          `${before.excludedStatusDays}/${started.excludedStatusDays}/${ended.excludedStatusDays}`
        );

    // The control: the same comparison DOES see a status that reaches back one
    // day, because yesterday's dip leaves the baseline — so the equality above
    // is not the check going blind.
    const { db: control } = freshDb();
    plantHistory(control, { dip: [1] });
    const controlBefore = deriveReadiness(control, TODAY, { now });
    startStatus(control, { label: 'sick', startDate: daysAgo(1), source: 'user' });
    drawn(deriveReadiness(control, TODAY, { now })) !== drawn(controlBefore)
      ? ok('…while a status covering YESTERDAY does move it (the control)')
      : bad('the comparison cannot see a baseline change');
  }

  // (d) THE LIE THE COUNTERFACTUAL PREVENTS. A phone with no watch has no
  // recovery verdict for a reason that predates this morning's status by
  // months, and "no recovery verdict until it ends" would blame the status for
  // a silence it had nothing to do with.
  {
    const { db } = freshDb();
    startStatus(db, { label: 'sick', startDate: TODAY, source: 'user' });
    const view = deriveReadiness(db, TODAY);
    view.recoveryDaysRemaining > 0 && view.recoveryPausedByStatus === false
      ? ok('with NO wearable history the status is not blamed for the missing verdict')
      : bad('blamed the status', JSON.stringify(view.recoveryPausedByStatus));
  }
}

// ===========================================================================
console.log('\n7. excusing vs. baseline: the two predicates are NOT the same predicate');
// ===========================================================================
{
  const { db } = freshDb();
  startStatus(db, {
    label: 'work crunch',
    startDate: daysAgo(2),
    endDate: daysAgo(1),
    source: 'coach',
    excuses: false,
  });
  const all = statusDaysIn(db, daysAgo(5), TODAY);
  const excusing = excusingStatusDaysIn(db, daysAgo(5), TODAY);
  all.size === 2 && excusing.size === 0
    ? ok('a non-excusing status leaves the BASELINES but not the ledger (Q3(a) vs Q2(b))')
    : bad('split', `${all.size} / ${excusing.size}`);

  // Two statuses on one day, disagreeing: the excusing one still forgives it.
  const { db: both } = freshDb();
  startStatus(both, { label: 'sick', startDate: TODAY, source: 'user' });
  startStatus(both, { label: 'work crunch', startDate: TODAY, source: 'coach', excuses: false });
  excusingStatusDaysIn(both, TODAY, TODAY).has(TODAY)
    ? ok('…and when two disagree on one day, the excusing one still forgives it')
    : bad('disagreement');
}

// ===========================================================================
console.log('\n8. the seeded prompt: from either screen, it reaches the composer exactly once');
// ===========================================================================
{
  // The Coach tab, reduced to what its composer is handed. `arrive(p)` is Home
  // (or the Protocols hub) pushing the tab with `prompt: p`; `clear()` is the
  // tab dropping the param once it has taken it; `end(text)` is the × in the
  // tab's own sheet. "Reached" means the composer REMOUNTED holding the text:
  // ChatInput reads `initialText` once, so a seed whose key did not change
  // never reaches the field, whatever `text` says.
  const tab = (param) => {
    let seed = seedFromParam(NO_SEED, param);
    let key = composerKey(seed);
    const step = (next) => {
      seed = next;
      const was = key;
      key = composerKey(seed);
      return { remounted: key !== was, text: seed.text, key };
    };
    return {
      first: () => ({ remounted: true, text: seed.text, key }),
      arrive: (p) => step(seedFromParam(seed, p)),
      clear: () => step(seedFromParam(seed, undefined)),
      end: (text) => step(seedFromRail(seed, text)),
      stay: () => step(seedFromParam(seed, seed.param)),
    };
  };
  const reached = (r, text) => r.remounted && r.text === text;

  const sick = promptFor('sick');
  const traveling = promptFor('traveling');
  const ended = endPromptFor('sick');

  // The owner-facing failure, as a sequence: Sick from Home, then ended from
  // the Coach tab's own sheet, then a status set on Home again.
  const t = tab(sick);
  reached(t.first(), sick)
    ? ok("Home's prompt is in the composer on the tab's first mount")
    : bad('first mount', JSON.stringify(t.first()));
  const cleared = t.clear();
  !cleared.remounted
    ? ok('…and dropping the consumed param does not remount it (a draft in progress survives)')
    : bad('clearing the param remounted the composer', JSON.stringify(cleared));
  reached(t.end(ended), ended)
    ? ok("the × on the Coach tab's sheet seeds its end sentence")
    : bad('rail seed');
  const after = t.arrive(traveling);
  reached(after, traveling)
    ? ok('THE LATCH: a status set on Home after that × still reaches the composer')
    : bad('Home prompt swallowed after a rail seed', JSON.stringify(after));
  const again = t.stay();
  !again.remounted
    ? ok('…exactly once: the same param on the next render does not reseed it')
    : bad('reseeded on a plain re-render', JSON.stringify(again));

  // The SAME sentence twice from Home, a × between them. Only the drop of the
  // consumed param lets the second one register as an arrival at all.
  const u = tab(sick);
  u.clear();
  u.end(ended);
  const twice = u.arrive(sick);
  reached(twice, sick)
    ? ok('the same Home prompt a second time, after a ×, reaches the composer again')
    : bad('repeat Home prompt swallowed', JSON.stringify(twice));

  // The × twice in a row with the same sentence: the counter is the key.
  const v = tab(undefined);
  const e1 = v.end(ended);
  const e2 = v.end(ended);
  reached(e1, ended) && reached(e2, ended) && e1.key !== e2.key
    ? ok('the same end sentence seeded twice remounts the composer twice')
    : bad('rail reseed', JSON.stringify([e1, e2]));

  // A tab that never received anything mounts an empty draft, keyed as before.
  const w = tab(undefined);
  w.first().text === undefined && composerKey(NO_SEED) === 'composer' && !w.stay().remounted
    ? ok('no prompt: an empty composer, and nothing remounts it')
    : bad('empty composer', JSON.stringify(w.first()));

  // The other order: a Home prompt, then a × on the tab — the × still lands.
  const x = tab(reaskFor('sick'));
  x.clear();
  reached(x.end(ended), ended)
    ? ok('a × after a Home prompt reaches the composer too')
    : bad('rail after param');

  // The wiring, pinned by source: this suite cannot render the tab with
  // changing params, so what connects the pure steps above to the screen is
  // asserted where it is written.
  const coach = readFileSync(new URL('../app/(tabs)/coach.tsx', import.meta.url), 'utf8');
  /seedFromParam\(/.test(coach) &&
  /seedFromRail\(/.test(coach) &&
  /key=\{composerKey\(/.test(coach) &&
  /setParams\(\{\s*prompt:\s*undefined\s*\}\)/.test(coach)
    ? ok('coach.tsx routes both sources through the seed and drops the param it consumed')
    : bad('coach.tsx no longer wires the seed handoff');
}

// ===========================================================================
// Items 61/80 (2026-10-21) — Night out asks "how many drinks?", logs them as
// alcohol on the day, and tells the Coach and the next morning's readiness.
// NO automatic plan changes (§13 pins it).
// ===========================================================================
const near = (a, b) => Math.abs(a - b) < 1e-9;
const NIGHT = (db) => openStatuses(db, TODAY).filter((row) => row.label === 'night out');

console.log('\n9. the drinks figures: 14 g a standard drink, every kind, and the words are facts');
{
  STANDARD_DRINK_G === 14 && STANDARD_DRINK_G * ETHANOL_KCAL_PER_G === 98
    ? ok('a standard drink is 14 g of ethanol — 98 kcal from the ethanol alone')
    : bad('standard drink constants');
  DRINKS_DEFAULT === 2 && DRINKS_MAX === 20 && clampDrinks(-3) === 0 && clampDrinks(99) === 20
    ? ok('the stepper holds 0–20 and opens on 2')
    : bad('stepper bounds');
  DRINK_KINDS.map((k) => k.kind).join() === 'beer,wine,spirits,cocktail'
    ? ok('four kinds, in a fixed order: beer · wine · spirits · cocktail')
    : bad('kinds', DRINK_KINDS.map((k) => k.kind).join());
  // Every kind records 14 g a drink; only the kcal and carbs differ, and each
  // is at least the ethanol's own energy (the glass cannot carry less than the
  // alcohol in it) — at SR Legacy's own 6.93 kcal/g, 97, which is why spirits
  // read 97 rather than the Atwater 98.
  const all = DRINK_KINDS.every((spec) => {
    const item = drinksItem({ count: 3, kind: spec.kind });
    const micros = parseMicros(item.micros);
    return (
      near(micros.alcohol_g, 42) &&
      item.serving_qty === 3 &&
      item.piece_name === 'drink' &&
      item.unit === 'ml' &&
      item.kcal === spec.kcal * 3 &&
      spec.kcal >= Math.floor(14 * 6.93)
    );
  });
  all
    ? ok('3 drinks of any kind: 42 g alcohol, counted in drinks, in ml, kcal ≥ the ethanol’s')
    : bad('drinks item');
  const beer = drinksItem({ count: 4, kind: 'beer' });
  beer.kcal === 612 && near(beer.carbs_g, 50.4)
    ? ok('4 beers: 612 kcal, 50.4 g carbs (FDC 14003, 12 fl oz)')
    : bad('beer figures', JSON.stringify(beer));

  // The words. A fact, with the count — and NOT the other chips' "adjust
  // accordingly": a count of drinks is not a request to rework the day.
  const sent = nightOutPrompt({ count: 4, kind: 'wine' });
  sent === 'Night out tonight — 4 drinks (wine) so far.'
    ? ok(`the sentence Night out sends is a fact: "${sent}"`)
    : bad('night out prompt', sent);
  !/adjust|should|too many|limit|careful|heavy/i.test(sent) &&
  !/adjust|should|too many|limit|careful|heavy/i.test(
    alcoholLastNightLine({ grams: 56, drinks: 4 })
  )
    ? ok('…and neither it nor the morning line carries a verdict or an ask')
    : bad('judgement words in the drinks copy');
  nightOutPrompt({ count: 0, kind: 'beer' }) === 'Night out tonight — not drinking.'
    ? ok('zero drinks is a fact too: "not drinking"')
    : bad('zero prompt', nightOutPrompt({ count: 0, kind: 'beer' }));
}

console.log('\n10. the stepper → the record: the status, then the drinks as a meal on the day');
{
  const { db } = freshDb();
  // Only Night out asks first.
  const chips = railChips([]);
  chips.filter((c) => c.asksDrinks).map((c) => c.label).join() === 'night out'
    ? ok('only the Night out chip asks for a count before it writes')
    : bad('asksDrinks', JSON.stringify(chips.map((c) => [c.label, c.asksDrinks])));

  const first = recordNightOut(db, TODAY, { count: DRINKS_DEFAULT, kind: 'beer' });
  const rows = NIGHT(db);
  first.started && rows.length === 1 && rows[0].end_date === TODAY && rows[0].source === 'user'
    ? ok('Save writes Night out, bounded at today, set by the user — and says it started it')
    : bad('night out status', JSON.stringify([first, rows]));
  const meals = listTodayMeals(db, TODAY);
  const items = meals.length === 1 ? listMealItems(db, meals[0].id) : [];
  meals.length === 1 &&
  meals[0].name === 'Night out · 2 drinks' &&
  meals[0].time === null &&
  items.length === 1 &&
  items[0].name === 'Beer' &&
  items[0].serving_qty === 2 &&
  items[0].piece_name === 'drink' &&
  near(parseMicros(items[0].micros).alcohol_g, 28)
    ? ok('…and the drinks as ONE meal, "Night out · 2 drinks": 2 × Beer, 28 g alcohol')
    : bad('night out meal', JSON.stringify([meals, items]));
  near(meals[0].kcal, 306) && near(meals[0].carbs_g, 25.2)
    ? ok('the meal carries the drinks’ kcal and carbs (306 kcal, 25.2 g)')
    : bad('meal totals', JSON.stringify(meals[0]));
  const read = recordedDrinks(db, TODAY);
  read && read.count === 2 && read.kind === 'beer'
    ? ok('the stepper re-opens on what it recorded: 2, beer')
    : bad('recorded drinks', JSON.stringify(read));
  recordedDrinks(db, daysAgo(1)) === null
    ? ok('a day with no Night out drinks opens on nothing recorded')
    : bad('empty day read');
}

console.log('\n11. editing the count later that day — one status, one meal, re-counted');
{
  const { db } = freshDb();
  recordNightOut(db, TODAY, { count: 2, kind: 'beer' });
  const again = recordNightOut(db, TODAY, { count: 4, kind: 'wine' });
  const meals = listTodayMeals(db, TODAY);
  const items = listMealItems(db, meals[0].id);
  !again.started && NIGHT(db).length === 1
    ? ok('a re-count starts nothing: still one Night out row (and nothing to send)')
    : bad('recount status', JSON.stringify([again, NIGHT(db)]));
  meals.length === 1 &&
  meals[0].name === 'Night out · 4 drinks' &&
  items.length === 1 &&
  items[0].name === 'Wine' &&
  items[0].serving_qty === 4 &&
  near(parseMicros(items[0].micros).alcohol_g, 56) &&
  near(meals[0].kcal, 500)
    ? ok('…the same meal, renamed "Night out · 4 drinks": 4 × Wine, 56 g, 500 kcal')
    : bad('recount meal', JSON.stringify([meals, items]));

  // Re-counted on meal-detail instead (0059's count control): the alcohol
  // scales WITH the kcal, because the micros vocabulary carries alcohol_g.
  setItemCount(db, items[0].id, 3);
  const scaled = listMealItems(db, meals[0].id)[0];
  near(parseMicros(scaled.micros).alcohol_g, 42) && near(scaled.kcal, 375)
    ? ok('a re-count on meal-detail scales the alcohol with the kcal (3 → 42 g, 375 kcal)')
    : bad('meal-detail rescale', JSON.stringify(scaled));
  recordedDrinks(db, TODAY)?.count === 3
    ? ok('…and the stepper reads that count back')
    : bad('read after meal-detail', JSON.stringify(recordedDrinks(db, TODAY)));
  serializeMicros(scaleMicros(parseMicros('{"alcohol_g":14,"sodium_mg":10}'), 2)) ===
  '{"sodium_mg":20,"alcohol_g":28}'
    ? ok('parse → scale → serialize keeps alcohol_g (it is not dropped as an unknown key)')
    : bad('micros round trip');

  // A renamed meal is the user's: a re-count leaves the name alone.
  updateMealName(db, meals[0].id, 'Sam’s birthday');
  recordNightOut(db, TODAY, { count: 5, kind: 'wine' });
  getMeal(db, meals[0].id).name === 'Sam’s birthday'
    ? ok('a meal the user renamed keeps his name through a re-count')
    : bad('rename kept', getMeal(db, meals[0].id).name);

  // Something else added to that meal survives the count going to 0; the
  // stepper's row goes, and the meal stays with what is left.
  addMealItem(db, meals[0].id, { name: 'Fries', kcal: 400, carbs_g: 50 });
  recordNightOut(db, TODAY, { count: 0, kind: 'wine' });
  const left = listMealItems(db, meals[0].id);
  left.length === 1 && left[0].name === 'Fries' && near(getMeal(db, meals[0].id).kcal, 400)
    ? ok('count 0 removes only the drinks row; the fries the user added stay, totals follow')
    : bad('zero with other items', JSON.stringify(left));
  dayAlcohol(db, TODAY) === null && recordedDrinks(db, TODAY) === null
    ? ok('…and the day records no alcohol')
    : bad('zero alcohol', JSON.stringify(dayAlcohol(db, TODAY)));

  // On its own, count 0 takes the meal with it — an empty meal reads as an
  // unpriced one.
  const solo = freshDb().db;
  recordNightOut(solo, TODAY, { count: 3, kind: 'spirits' });
  recordNightOut(solo, TODAY, { count: 0, kind: 'spirits' });
  listTodayMeals(solo, TODAY).length === 0 && NIGHT(solo).length === 1
    ? ok('count 0 on its own deletes the drinks meal; the Night out status stays')
    : bad('zero solo', JSON.stringify(listTodayMeals(solo, TODAY)));

  // A drink the stepper did not write — a described pint with the model's
  // alcohol figure — is never rewritten by it, and still counts in the day.
  const other = freshDb().db;
  logMealWithItems(other, {
    date: TODAY,
    time: '19:00',
    name: 'Pub',
    source: 'ai_suggested',
    items: [{ name: 'IPA', amount: 568, unit: 'ml', kcal: 250, micros: '{"alcohol_g":28}' }],
  });
  recordNightOut(other, TODAY, { count: 1, kind: 'beer' });
  const pub = listTodayMeals(other, TODAY).find((m) => m.name === 'Pub');
  listTodayMeals(other, TODAY).length === 2 &&
  listMealItems(other, pub.id)[0].name === 'IPA' &&
  near(dayAlcohol(other, TODAY).grams, 42) &&
  dayAlcohol(other, TODAY).drinks === 3
    ? ok('another alcohol row is left alone by the stepper, and the day sums both (42 g, 3)')
    : bad('foreign alcohol', JSON.stringify(dayAlcohol(other, TODAY)));
  nightOutDrinks(other, TODAY)?.count === 1
    ? ok('…while the stepper reads back only its own count')
    : bad('stepper count with foreign row');
}

console.log('\n12. the day’s totals include the drinks');
{
  const { db } = freshDb();
  logMealWithItems(db, {
    date: TODAY,
    time: '12:30',
    name: 'Lunch',
    items: [{ name: 'Chicken salad', kcal: 550, protein_g: 45, carbs_g: 20, fat_g: 30 }],
  });
  const before = todayTotals(db, TODAY);
  recordNightOut(db, TODAY, { count: 3, kind: 'cocktail' });
  const after = todayTotals(db, TODAY);
  near(after.kcal - before.kcal, 441) &&
  near(after.carbs_g - before.carbs_g, 38.1) &&
  near(after.protein_g, before.protein_g) &&
  after.mealCount === 2
    ? ok('3 cocktails add 441 kcal and 38.1 g carbs to the day, and nothing to protein')
    : bad('day totals', JSON.stringify([before, after]));
  near(dayMicroTotals(db, TODAY).alcohol_g, 42)
    ? ok('the day’s micro totals carry 42 g alcohol')
    : bad('day micros', JSON.stringify(dayMicroTotals(db, TODAY)));
  !MICROS.some((m) => m.key === 'alcohol_g')
    ? ok('…but alcohol is NOT on the micros shortlist (no reference value, no estimator ask)')
    : bad('alcohol leaked onto the shortlist');
}

console.log('\n13. THE RULE: Night out changes no protocol, mission or reminder row');
{
  // A planned day: a protocol, today's mission generated from it.
  const { raw, db } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Training', type: 'training_block', startedOn: daysAgo(3) },
    {
      schema: 2,
      phases: [
        {
          id: 'p0',
          title: null,
          duration_days: null,
          items: [
            {
              id: 'run',
              title: 'Zone 2 run',
              scheduled_time: '07:00',
              dose: null,
              notes: null,
              cadence: { kind: 'daily' },
            },
            {
              id: 'lift',
              title: 'Strength session',
              scheduled_time: '18:00',
              dose: null,
              notes: null,
              cadence: { kind: 'daily' },
            },
          ],
        },
      ],
    }
  );
  generateMissionForDay(db, TODAY);
  generateMissionForDay(db, shiftISODate(TODAY, 1));
  const TABLES = ['log_entries', 'daily_logs', 'protocols', 'protocol_versions', 'reminders'];
  const snapshot = () =>
    JSON.stringify(
      TABLES.map((t) => {
        try {
          return raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
        } catch {
          return `no table ${t}`;
        }
      })
    );
  const planned = snapshot();
  planForDay(db, TODAY).length >= 2
    ? ok('CONTROL: the day is planned (two mission items from the protocol)')
    : bad('control plan', JSON.stringify(planForDay(db, TODAY)));
  recordNightOut(db, TODAY, { count: 6, kind: 'spirits' });
  recordNightOut(db, TODAY, { count: 9, kind: 'beer' });
  recordNightOut(db, TODAY, { count: 0, kind: 'beer' });
  recordNightOut(db, TODAY, { count: 4, kind: 'wine' });
  snapshot() === planned
    ? ok('set, re-count ×2 and zero: every mission, protocol and reminder row is byte-identical')
    : bad('Night out moved a plan row');
  // Tomorrow regenerates exactly as planned, with last night's drinks on record.
  generateMissionForDay(db, shiftISODate(TODAY, 1));
  snapshot() === planned
    ? ok('…and regenerating tomorrow after it changes nothing either')
    : bad('tomorrow regenerated differently after Night out');

  // Pinned by source as well: the write behind the stepper imports no plan
  // repository, and the store routes the stepper through it.
  const nightOut = readFileSync(new URL('../src/lib/status/night-out.ts', import.meta.url), 'utf8');
  const store = readFileSync(new URL('../src/lib/status/store.ts', import.meta.url), 'utf8');
  !/repositories\/(mission|mission-generate|protocols|reminders)/.test(nightOut) &&
  !/repositories\/(mission|mission-generate|protocols|reminders)/.test(store) &&
  /saveNightOutDrinks\(getDb\(\)/.test(store) &&
  /recordNightOut\(db, date, drinks\)/.test(nightOut)
    ? ok('night-out.ts and the store import no mission/protocol/reminder repository')
    : bad('a plan repository is reachable from the Night out write');
}

console.log('\n14. the Coach’s day context and the next morning’s readiness');
{
  const { db } = freshDb();
  const noon = new Date(2026, 8, 19, 12, 0);
  const tomorrowMorning = new Date(2026, 8, 20, 8, 0);
  !buildTurnContext(db, noon).includes('Alcohol:')
    ? ok('no drinks, no Alcohol line — it costs nothing on an ordinary turn')
    : bad('alcohol line on a dry day');

  recordNightOut(db, TODAY, { count: 2, kind: 'beer' });
  const tonight = buildTurnContext(db, noon);
  tonight.includes(`Alcohol: 2 standard drinks (28 g ethanol) today, ${TODAY}`)
    ? ok('the Coach sees tonight’s count and grams in its per-turn state block')
    : bad('coach context today', tonight.split('\n').find((l) => l.startsWith('Alcohol')));
  /Status: night out — since today/.test(tonight)
    ? ok('…beside the Night out status line it already printed')
    : bad('status line missing');

  recordNightOut(db, TODAY, { count: 4, kind: 'beer' });
  const morning = buildTurnContext(db, tomorrowMorning);
  morning.includes(`Alcohol: 4 standard drinks (56 g ethanol) last night, ${TODAY}`)
    ? ok('the next morning it reads "last night", with the re-counted 4 and 56 g')
    : bad('coach context next morning', morning.split('\n').find((l) => l.startsWith('Alcohol')));

  // Readiness: the fact is exposed, and nothing it grades moves.
  const NEXT = shiftISODate(TODAY, 1);
  const plant = (date, value) =>
    upsertWearableRows(db, [
      {
        date,
        metricType: 'hrv',
        value,
        unit: 'ms',
        sourceDevice: 'apple_watch',
        sourceRawId: `hk:hrv:${date}`,
        startTime: null,
        endTime: null,
        metadata: {},
      },
    ]);
  for (let i = 0; i <= 30; i++) plant(shiftISODate(NEXT, -i), i === 0 ? 38 : 50);
  const withDrinks = deriveReadiness(db, NEXT);
  withDrinks.alcoholLastNight &&
  near(withDrinks.alcoholLastNight.grams, 56) &&
  withDrinks.alcoholLastNight.drinks === 4
    ? ok('the next morning’s readiness exposes alcoholLastNight: 4 drinks, 56 g')
    : bad('alcoholLastNight', JSON.stringify(withDrinks.alcoholLastNight));
  alcoholLastNightLine(withDrinks.alcoholLastNight) ===
  'Alcohol last night — 4 standard drinks · 56 g'
    ? ok('Home’s line under the pillars: "Alcohol last night — 4 standard drinks · 56 g"')
    : bad('home line', alcoholLastNightLine(withDrinks.alcoholLastNight));
  alcoholLastNightLine(null) === null && deriveReadiness(db, TODAY).alcoholLastNight === null
    ? ok('no drinks the night before: no line at all')
    : bad('dry morning line');

  // The same night with the count zeroed — same status, no drinks. Every grade
  // is identical: the drinks are an input for the model, not for the score.
  recordNightOut(db, TODAY, { count: 0, kind: 'beer' });
  const dry = deriveReadiness(db, NEXT);
  const grades = (v) =>
    JSON.stringify([v.readiness, v.pillars.filter((p) => p.label !== 'Nutrition'), v.metrics]);
  dry.alcoholLastNight === null && grades(dry) === grades(withDrinks)
    ? ok('…and the verdict, Recovery, Sleep, Strain and the metrics are identical without them')
    : bad('readiness moved with the drinks', `${grades(dry)}\n${grades(withDrinks)}`);
}

console.log('\n15. the morning after: re-counting Night out past the day boundary (2026-10-21 review)');
{
  // The reviewer's case, as the store drives it: Night out at 22:30 with 4
  // beers; at 01:15 — a new logical day under the 00:00 boundary — he opens
  // the stepper again and makes it 6. It must re-count LAST night's row: one
  // status, one drinks meal, 6 drinks, no second Coach sentence.
  const D = '2026-10-17';
  const D1 = '2026-10-18';
  const evening = new Date(2026, 9, 17, 22, 30);
  const smallHours = new Date(2026, 9, 18, 1, 15);
  const { db } = freshDb();
  const first = saveNightOutDrinks(db, D, { count: 4, kind: 'beer' }, evening);
  first.started === true && first.date === D
    ? ok('22:30: the first save starts Night out on its own day (and sends its sentence)')
    : bad('first save', JSON.stringify(first));
  const opened = nightOutStepper(db, D1, smallHours);
  opened.lastNight === true && opened.recorded?.count === 4 && opened.recorded.kind === 'beer'
    ? ok('01:15 the next day: the stepper opens on last night’s 4 beers, as a re-count')
    : bad('stepper at 01:15', JSON.stringify(opened));
  const second = saveNightOutDrinks(db, D1, { count: 6, kind: 'beer' }, smallHours);
  const rows = db.all('SELECT label, start_date, end_date FROM day_statuses');
  second.started === false &&
  second.date === D &&
  rows.length === 1 &&
  rows[0].start_date === D &&
  dayAlcohol(db, D)?.drinks === 6 &&
  dayAlcohol(db, D1) === null &&
  listTodayMeals(db, D).length === 1 &&
  listTodayMeals(db, D1).length === 0
    ? ok('…and Save makes it 6 on last night: one status, one drinks meal, nothing on the new day, no message')
    : bad('second save', JSON.stringify({ second, rows, d: dayAlcohol(db, D), d1: dayAlcohol(db, D1) }));
  const morning = deriveReadiness(db, D1);
  morning.alcoholLastNight?.drinks === 6 &&
  alcoholLastNightLine(morning.alcoholLastNight) === 'Alcohol last night — 6 standard drinks · 84 g'
    ? ok('readiness’s "last night" line shows the corrected 6')
    : bad('readiness after re-count', JSON.stringify(morning.alcoholLastNight));

  // The cut-off, either side of it: until noon the night is still being
  // counted; from noon a tap is a new evening.
  NIGHT_OUT_CARRIES_UNTIL_HOUR === 12 &&
  nightOutDay(db, D1, new Date(2026, 9, 18, 11, 59)) === D &&
  nightOutDay(db, D1, new Date(2026, 9, 18, 12, 0)) === D1
    ? ok('11:59 the morning after is still last night’s; 12:00 is today’s')
    : bad('cut-off');
  const later = saveNightOutDrinks(db, D1, { count: 2, kind: 'wine' }, new Date(2026, 9, 18, 19, 0));
  later.started === true && later.date === D1 && dayAlcohol(db, D)?.drinks === 6
    ? ok('19:00 the next day: a new Night out on that day, last night’s 6 untouched')
    : bad('next evening', JSON.stringify(later));
  nightOutDay(db, D1, new Date(2026, 9, 18, 9, 0)) === D1
    ? ok('once today has its own Night out, today’s is the one re-counted, at any hour')
    : bad('today first');

  // Only a Night out STARTED yesterday carries — not one that began earlier.
  const { db: older } = freshDb();
  startStatus(older, { label: 'night out', startDate: shiftISODate(D, -1), endDate: D, source: 'coach' });
  const { db: none } = freshDb();
  nightOutDay(older, D1, smallHours) === D1 && nightOutDay(none, D1, smallHours) === D1
    ? ok('no Night out started yesterday: the morning after is an ordinary today')
    : bad('older status carried');
  const fresh = saveNightOutDrinks(none, D1, { count: 3, kind: 'beer' }, smallHours);
  fresh.started === true && fresh.date === D1
    ? ok('…and a Night out first set at 01:15 starts on the new day, as before')
    : bad('first at 01:15', JSON.stringify(fresh));
}

console.log('\n16. the stepper’s night is decided when it OPENS (2026-10-21 fix round)');
{
  // Opened at 11:59 on last night's 4, saved at 12:00:30: a fresh clock reads a
  // new evening, which used to start a second Night out with the 6 on top of
  // the 4 (10 drinks recorded across two nights for one).
  const D = '2026-10-17';
  const D1 = '2026-10-18';
  const { db } = freshDb();
  saveNightOutDrinks(db, D, { count: 4, kind: 'beer' }, new Date(2026, 9, 17, 22, 30));
  const opened = nightOutStepper(db, D1, new Date(2026, 9, 18, 11, 59));
  opened.date === D && opened.lastNight === true
    ? ok('the stepper opened at 11:59 names the night it chose: last night')
    : bad('stepper target', JSON.stringify(opened));
  const saved = saveNightOutDrinks(db, D1, { count: 6, kind: 'beer' }, new Date(2026, 9, 18, 12, 0, 30), opened);
  saved.started === false &&
  saved.date === D &&
  db.all('SELECT * FROM day_statuses').length === 1 &&
  dayAlcohol(db, D)?.drinks === 6 &&
  dayAlcohol(db, D1) === null
    ? ok('…and its Save at 12:00:30 re-counts THAT night: 6 on last night, no second Night out, no message')
    : bad('save past noon', JSON.stringify({ saved, d: dayAlcohol(db, D), d1: dayAlcohol(db, D1) }));

  // The other crossing: a first Night out opened at 23:59 and saved after the
  // day turned is still the evening the panel showed — started, with its
  // sentence, on that day.
  const { db: late } = freshDb();
  const tonight = nightOutStepper(late, D, new Date(2026, 9, 17, 23, 59));
  const first = saveNightOutDrinks(late, D1, { count: 3, kind: 'wine' }, new Date(2026, 9, 18, 0, 0, 30), tonight);
  tonight.lastNight === false &&
  first.started === true &&
  first.date === D &&
  dayAlcohol(late, D)?.drinks === 3 &&
  dayAlcohol(late, D1) === null
    ? ok('a first Night out opened at 23:59 and saved at 00:00:30 starts on the evening it was opened')
    : bad('save past midnight', JSON.stringify(first));

  // The store hands the stepper's night back, from the sheet to the Save.
  const store = readFileSync(new URL('../src/lib/status/store.ts', import.meta.url), 'utf8');
  /saveNightOutDrinks\(getDb\(\), todayISODate\(\), drinks, new Date\(\), night\)/.test(store) &&
  /night: \{ date, lastNight \}/.test(store)
    ? ok('the store reads the night when the stepper opens and saves to it')
    : bad('store does not carry the stepper’s night');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
