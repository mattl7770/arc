/**
 * Headless test of day statuses (migration 0061, docs/spikes/coach-status-
 * buttons-modes-retirement.md) against real SQLite via node:sqlite: the
 * schema and its CHECKs, the retirement row that ends day modes, the
 * repository, the shared excusal definition, the carry, and the readiness
 * baselines. op-sqlite and the model client are never loaded.
 * Run: npm run db:test.
 */
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
  raw
    .prepare(`INSERT INTO day_modes (id, mode, start_date, end_date) VALUES (?, ?, ?, ?)`)
    .run('m-sick', 'sick', daysAgo(30), null);
  raw
    .prepare(`INSERT INTO day_modes (id, mode, start_date, end_date) VALUES (?, ?, ?, ?)`)
    .run('m-travel', 'travel', shiftISODate(TODAY, 7), shiftISODate(TODAY, 11));

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

  getActiveMode(db, shiftISODate(TODAY, 8)) === 'normal'
    ? ok('…and next week reads Normal too — the scheduled Travel range is cancelled')
    : bad('future mode survived', getActiveMode(db, shiftISODate(TODAY, 8)));
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
