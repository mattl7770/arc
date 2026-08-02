/**
 * Headless test of the protocol → mission generator
 * (src/lib/db/repositories/mission-generate.ts) and the protocol-first
 * ensureTodaySeeded (src/lib/db/seed.ts), against real SQLite via node:sqlite.
 * No op-sqlite, no Expo. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  createProtocol,
  createProtocolWithVersion,
  setActive,
} from '../src/lib/db/repositories/protocols.ts';
import { listMission } from '../src/lib/db/repositories/mission.ts';
import { generateMissionForDay } from '../src/lib/db/repositories/mission-generate.ts';
import { ensureTodaySeeded } from '../src/lib/db/seed.ts';

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

const DATE = '2026-08-01';
const rows = (raw, date) =>
  raw
    .prepare(
      `SELECT e.* FROM log_entries e JOIN daily_logs d ON d.id = e.daily_log_id WHERE d.date = ?
       ORDER BY (e.scheduled_time IS NULL), e.scheduled_time, e.created_at, e.id`
    )
    .all(date);

console.log('0. generateMissionForDay expands active protocols into the day');
{
  const { db, raw } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Evening Stack', type: 'supplement_stack' },
    {
      items: [
        { title: 'Magnesium Glycinate', scheduled_time: '21:00', dose: '400 mg', notes: null },
        { title: 'Vitamin D3', scheduled_time: '08:00', dose: '5000 IU', notes: null },
      ],
    }
  );
  createProtocolWithVersion(
    db,
    { name: 'Morning Routine', type: 'daily_routine' },
    { items: [{ title: 'Sunlight + walk', scheduled_time: '07:00', dose: null, notes: '10 min' }] }
  );

  const n = generateMissionForDay(db, DATE);
  n === 3 ? ok('returned 3 (2 supplements + 1 routine item)') : bad('count', n);

  const entries = rows(raw, DATE);
  const mag = entries.find((e) => e.title === 'Magnesium Glycinate');
  mag && mag.type === 'supplement' && mag.scheduled_time === '21:00' && mag.protocol_id
    ? ok('supplement item → type supplement, time + protocol_id set')
    : bad('supplement entry', JSON.stringify(mag));
  const magExtras = JSON.parse(mag.value);
  magExtras.generated === true &&
  magExtras.protocol === 'Evening Stack' &&
  magExtras.why === '400 mg'
    ? ok('value carries generated:true, protocol name, and dose as why')
    : bad('supplement extras', mag.value);
  const walk = entries.find((e) => e.title === 'Sunlight + walk');
  walk && walk.type === 'habit' && JSON.parse(walk.value).why === '10 min'
    ? ok('routine item → type habit, notes as why when no dose')
    : bad('routine entry', JSON.stringify(walk));

  const mission = listMission(db, DATE);
  mission.length === 3 &&
  mission.every((m) => m.protocol) &&
  mission.find((m) => m.title === 'Magnesium Glycinate')?.category === 'Supplements'
    ? ok('listMission surfaces all three with protocol + fallback category')
    : bad('listMission', JSON.stringify(mission));
}

console.log('1. idempotent — a second run adds nothing');
{
  const { db, raw } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Stack', type: 'supplement_stack' },
    {
      items: [{ title: 'Creatine', scheduled_time: null, dose: '5 g', notes: null }],
    }
  );
  generateMissionForDay(db, DATE);
  const again = generateMissionForDay(db, DATE);
  again === 0 && rows(raw, DATE).length === 1
    ? ok('second call returns 0, no duplicate entries')
    : bad('idempotency', `${again} / ${rows(raw, DATE).length} rows`);
}

console.log('2. paused and version-less protocols are excluded');
{
  const { db } = freshDb();
  const pausedId = createProtocolWithVersion(
    db,
    { name: 'Paused', type: 'supplement_stack' },
    {
      items: [{ title: 'Should not appear', scheduled_time: null, dose: null, notes: null }],
    }
  );
  setActive(db, pausedId, false);
  // A protocol with no version at all (current_version_id NULL).
  createProtocol(db, { name: 'Empty', type: 'daily_routine' });

  const n = generateMissionForDay(db, DATE);
  n === 0 ? ok('paused + version-less protocols contribute nothing (0)') : bad('excluded', n);
}

console.log('3. protocol type → log_entry type mapping');
{
  const { db, raw } = freshDb();
  const cases = [
    ['training_block', 'workout'],
    ['meal_template', 'meal'],
    ['therapy_protocol', 'therapy'],
    ['sleep_protocol', 'habit'],
    ['other', 'habit'],
  ];
  for (const [ptype] of cases) {
    createProtocolWithVersion(
      db,
      { name: `P-${ptype}`, type: ptype },
      {
        items: [{ title: `item-${ptype}`, scheduled_time: null, dose: null, notes: null }],
      }
    );
  }
  generateMissionForDay(db, DATE);
  const entries = rows(raw, DATE);
  const allMapped = cases.every(([ptype, expected]) => {
    const e = entries.find((r) => r.title === `item-${ptype}`);
    return e && e.type === expected;
  });
  allMapped
    ? ok('training→workout, meal_template→meal, therapy→therapy, sleep/other→habit')
    : bad('type mapping', JSON.stringify(entries.map((e) => [e.title, e.type])));
}

console.log('4. ensureTodaySeeded is protocol-first, mock only as fallback');
{
  const { db, raw } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Real Stack', type: 'supplement_stack' },
    {
      items: [{ title: 'Omega-3', scheduled_time: '08:00', dose: '2 g', notes: null }],
    }
  );
  // A non-empty mock fallback that must be IGNORED because a protocol exists.
  const mock = [
    { id: 'm1', title: 'MOCK ITEM', status: 'pending', category: 'Morning', why: 'demo' },
  ];
  ensureTodaySeeded(db, DATE, mock);
  const entries = rows(raw, DATE);
  entries.length === 1 && entries[0].title === 'Omega-3' && entries[0].protocol_id
    ? ok('with an active protocol, the day is generated from it (mock ignored)')
    : bad('protocol-first', JSON.stringify(entries.map((e) => e.title)));
}

console.log('5. ensureTodaySeeded falls back to the mock mission with no protocols');
{
  const { db, raw } = freshDb();
  const mock = [
    { id: 'm1', title: 'Cold shower', status: 'pending', category: 'Morning', why: 'demo' },
    { id: 'm2', title: 'Creatine', status: 'pending', category: 'Supplements', why: '5 g' },
  ];
  ensureTodaySeeded(db, DATE, mock);
  const entries = rows(raw, DATE);
  entries.length === 2 &&
  entries.every((e) => e.protocol_id === null) &&
  entries.every((e) => JSON.parse(e.value).seed === true)
    ? ok('no protocols → mock mission planted, marked seed:true, no protocol_id')
    : bad('fallback', JSON.stringify(entries.map((e) => e.title)));
}

console.log('6. a user WITH protocols never gets the mock demo, however empty the day');
{
  // The regression: the fallback used to be gated on "the generator returned 0
  // rows" instead of "the user has never had a protocol". So pausing the last
  // protocol before a trip (or deleting it, or saving one with no items) planted
  // 11 FABRICATED mock entries on the next morning's first Home open — rendered
  // as the real plan and handed to the Coach with no seed marker.
  const mock = [
    { id: 'm1', title: 'MOCK ITEM', status: 'pending', category: 'Morning', why: 'demo' },
  ];

  {
    const { db, raw } = freshDb();
    const id = createProtocolWithVersion(
      db,
      { name: 'Real Stack', type: 'supplement_stack' },
      { items: [{ title: 'Omega-3', scheduled_time: '08:00', dose: '2 g', notes: null }] }
    );
    setActive(db, id, false);
    ensureTodaySeeded(db, DATE, mock);
    const planted = rows(raw, DATE).map((e) => e.title);
    planted.length === 0
      ? ok('paused last protocol → empty day (Home shows its empty state), no mock rows')
      : bad('paused protocol resurrected the demo', JSON.stringify(planted));
  }

  {
    const { db, raw } = freshDb();
    // The editor's canSave permits zero items, so this is reachable.
    createProtocolWithVersion(db, { name: 'Emptied', type: 'daily_routine' }, { items: [] });
    ensureTodaySeeded(db, DATE, mock);
    const planted = rows(raw, DATE).map((e) => e.title);
    planted.length === 0
      ? ok('active protocol with no items → empty day, no mock rows')
      : bad('empty protocol resurrected the demo', JSON.stringify(planted));
  }

  {
    const { db, raw } = freshDb();
    createProtocol(db, { name: 'Draft', type: 'daily_routine' });
    ensureTodaySeeded(db, DATE, mock);
    const planted = rows(raw, DATE).map((e) => e.title);
    planted.length === 0
      ? ok('version-less protocol still counts as "has a plan", no mock rows')
      : bad('version-less protocol resurrected the demo', JSON.stringify(planted));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
