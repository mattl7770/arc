/**
 * Headless test of the protocol → mission generator
 * (src/lib/db/repositories/mission-generate.ts) and the protocol-only
 * ensureTodaySeeded (src/lib/db/seed.ts), against real SQLite via node:sqlite.
 * No op-sqlite, no Expo. Run: npm run db:test.
 *
 * Cases 5–7 are the regression fence around the fabrication defect fixed on
 * 2026-08-07: Home used to plant an eleven-item demo mission (two rows
 * pre-marked `completed`) into the user's health database on every day that had
 * no active protocol. A day with nothing to plan must now stay EMPTY.
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
import {
  generateMissionForDay,
  rederiveMissionForDay,
} from '../src/lib/db/repositories/mission-generate.ts';
import { setMode } from '../src/lib/db/repositories/day-modes.ts';
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

console.log('4. ensureTodaySeeded generates the day from active protocols');
{
  const { db, raw } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Real Stack', type: 'supplement_stack' },
    {
      items: [{ title: 'Omega-3', scheduled_time: '08:00', dose: '2 g', notes: null }],
    }
  );
  ensureTodaySeeded(db, DATE);
  const entries = rows(raw, DATE);
  entries.length === 1 && entries[0].title === 'Omega-3' && entries[0].protocol_id
    ? ok('the day is generated from the protocol, linked by protocol_id')
    : bad('protocol generation', JSON.stringify(entries.map((e) => e.title)));

  // Every open calls it; the day must not grow.
  ensureTodaySeeded(db, DATE);
  ensureTodaySeeded(db, DATE);
  rows(raw, DATE).length === 1
    ? ok('repeat calls (every open + every focus) add nothing')
    : bad('idempotent ensure', rows(raw, DATE).length);
}

console.log('5. REGRESSION — no protocols means ZERO planted rows, on every day');
{
  const { db, raw } = freshDb();
  // The real first-run state: a migrated but otherwise untouched database.
  ensureTodaySeeded(db, DATE);
  const entries = rows(raw, DATE);
  entries.length === 0
    ? ok('a protocol-less day plants nothing at all')
    : bad('FABRICATED A MISSION', JSON.stringify(entries.map((e) => e.title)));

  const mission = listMission(db, DATE);
  mission.length === 0
    ? ok('listMission is empty — Home renders its first-run state, not "2 of 11"')
    : bad('listMission not empty', JSON.stringify(mission.map((m) => m.title)));

  // Nothing auto-creates protocols, so the old bug replanted daily. Walk a week.
  const week = ['2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06'];
  for (const d of week) ensureTodaySeeded(db, d);
  const total = raw.prepare('SELECT count(*) c FROM log_entries').get().c;
  total === 0
    ? ok('five more days open, still zero rows written (no daily replant)')
    : bad('replanted across days', total);

  // No row anywhere may claim to be completed work the user never did.
  const completed = raw
    .prepare("SELECT count(*) c FROM log_entries WHERE status = 'completed'")
    .get().c;
  completed === 0
    ? ok('no row is pre-marked completed')
    : bad('pre-completed rows exist', completed);
}

console.log('6. an ad-hoc capture does not fabricate around itself');
{
  // A user with no protocols who logs something themselves gets exactly that —
  // their own row, and nothing generated to keep it company.
  const { db, raw } = freshDb();
  ensureTodaySeeded(db, DATE);
  const log = raw.prepare('SELECT id FROM daily_logs WHERE date = ?').get(DATE);
  log
    ? ok('the daily_log row itself is still created (the day exists, it is empty)')
    : bad('no daily_log');
  ensureTodaySeeded(db, DATE);
  rows(raw, DATE).length === 0
    ? ok('re-opening an empty day stays empty')
    : bad('second open planted rows', rows(raw, DATE).length);
}

console.log('7. seed:true rows are still honoured (existing devices hold them)');
{
  // The fabrication is gone, but devices that ran the old build still contain
  // `seed: true` rows, and the mode re-derive keys off that marker to avoid
  // deleting them. The fixture path proves the marker still round-trips.
  const { db, raw } = freshDb();
  const fixture = [
    { id: 'm1', title: 'Cold shower', status: 'pending', category: 'Morning', why: 'demo' },
    { id: 'm2', title: 'Creatine', status: 'pending', category: 'Supplements', why: '5 g' },
    { id: 'm3', title: 'Zone 2 ride', status: 'pending', category: 'Training', why: '35 min' },
  ];
  ensureTodaySeeded(db, DATE, fixture);
  const entries = rows(raw, DATE);
  entries.length === 3 &&
  entries.every((e) => e.protocol_id === null) &&
  entries.every((e) => JSON.parse(e.value).seed === true)
    ? ok('explicit fixture items plant as seed:true with no protocol_id')
    : bad('fixture path', JSON.stringify(entries.map((e) => e.title)));

  // Sick drops the TYPE 'workout'; every other seed row must survive the
  // re-derive, or a mode tap would permanently empty an old device's day.
  setMode(db, { mode: 'sick', startDate: DATE, endDate: DATE });
  rederiveMissionForDay(db, DATE);
  const after = rows(raw, DATE).map((r) => r.title);
  after.includes('Cold shower') && after.includes('Creatine') && !after.includes('Zone 2 ride')
    ? ok('re-derive keeps untouched seed rows, pulls only the dropped type')
    : bad('re-derive damaged seed rows', JSON.stringify(after));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
