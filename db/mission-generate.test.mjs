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
  addVersion,
  createProtocol,
  createProtocolWithVersion,
  setActive,
} from '../src/lib/db/repositories/protocols.ts';
import {
  getOrCreateDailyLog,
  insertMissionItem,
  listMission,
  setMissionStatus,
} from '../src/lib/db/repositories/mission.ts';
import {
  generateMissionForDay,
  rederiveMissionForDay,
} from '../src/lib/db/repositories/mission-generate.ts';
import { createExperiment } from '../src/lib/db/repositories/experiments.ts';
import { logNote } from '../src/lib/db/repositories/logs.ts';
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
  // CHANGED 2026-08-12, and the assertion it replaces is the reason it changed.
  // It read `magExtras.why === '400 mg'` under the name "dose as why" — i.e. it
  // pinned the FLATTENING as the contract. A dose is not a rationale: the two
  // are set in different type voices, and collapsing them forced the hero card
  // to guess from the string's shape which one it had been handed.
  // `why === undefined` is the half that proves the flattening is gone, so it
  // is asserted rather than left implied.
  magExtras.generated === true &&
  magExtras.protocol === 'Evening Stack' &&
  magExtras.dose === '400 mg' &&
  magExtras.why === undefined
    ? ok('value carries generated:true, the protocol name, and the dose as dose — never as why')
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
  // `seed: true` rows, and the re-derive keys off that marker to avoid
  // deleting them: planForDay knows only protocols + experiments, so a row it
  // doesn't recognise is never evidence the row is unwanted.
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

  // A protocol arrives later and the day re-derives: every seed row survives,
  // or the first protocol edit would permanently empty an old device's day.
  createProtocolWithVersion(
    db,
    { name: 'Evening Stack', type: 'supplement_stack' },
    { items: [{ title: 'Magnesium', scheduled_time: '21:00', dose: '400 mg', notes: null }] }
  );
  rederiveMissionForDay(db, DATE);
  const after = rows(raw, DATE).map((r) => r.title);
  after.includes('Cold shower') &&
  after.includes('Creatine') &&
  after.includes('Zone 2 ride') &&
  after.includes('Magnesium')
    ? ok('re-derive keeps every seed row and adds the protocol item beside them')
    : bad('re-derive damaged seed rows', JSON.stringify(after));
}

// Cases 8–12 are the preserve-work fence around rederiveMissionForDay, ported
// from the retired Modes suite (the feature that first drove the diff). Its
// surviving production caller is update_protocol's `apply_today`, so every case
// drives it the same way: a NEW protocol version, then a re-derive.

console.log('8. re-derive reshapes the day WITHOUT destroying work');
{
  const { db, raw } = freshDb();
  const trainingId = createProtocolWithVersion(
    db,
    { name: 'Strength Block', type: 'training_block' },
    {
      items: [
        { title: 'Squats 5x5', scheduled_time: '17:00', dose: null, notes: null },
        { title: 'Rows 3x10', scheduled_time: '17:30', dose: null, notes: null },
      ],
    }
  );
  createProtocolWithVersion(
    db,
    { name: 'Evening Stack', type: 'supplement_stack' },
    { items: [{ title: 'Magnesium', scheduled_time: '21:00', dose: '400 mg', notes: null }] }
  );

  generateMissionForDay(db, DATE);
  const morning = rows(raw, DATE);
  morning.length === 3 ? ok('the day generated 3 protocol items') : bad('setup', morning.length);

  // The user completes one workout, part-finishes the other, logs an ad-hoc
  // note — THEN revises the block to a single mobility session, applied today.
  const idOf = (title) => raw.prepare('SELECT id FROM log_entries WHERE title = ?').get(title).id;
  setMissionStatus(db, idOf('Squats 5x5'), 'completed');
  setMissionStatus(db, idOf('Rows 3x10'), 'partial'); // real progress — must NOT be deleted
  logNote(db, DATE, 'Knee felt off, cutting it short');

  addVersion(db, trainingId, {
    items: [{ title: 'Mobility flow', scheduled_time: '17:00', dose: null, notes: null }],
  });
  const res = rederiveMissionForDay(db, DATE);

  const titles = rows(raw, DATE).map((r) => r.title);
  titles.includes('Squats 5x5') && titles.includes('Rows 3x10')
    ? ok('completed AND partial rows survive a version that no longer lists them')
    : bad('destroyed real work', JSON.stringify(titles));
  raw.prepare("SELECT status FROM log_entries WHERE title = 'Squats 5x5'").get().status ===
    'completed' &&
  raw.prepare("SELECT status FROM log_entries WHERE title = 'Rows 3x10'").get().status === 'partial'
    ? ok('their statuses are untouched')
    : bad('status changed');
  titles.includes('Magnesium') ? ok('the still-wanted supplement is kept') : bad('lost supplement');
  titles.includes('Mobility flow') && res.added === 1
    ? ok(`the new version's item is inserted (added ${res.added})`)
    : bad('new item missing', JSON.stringify(res));
  res.preserved >= 2
    ? ok(`re-derive reports ${res.preserved} preserved rows (acted-on work)`)
    : bad('preserved count', JSON.stringify(res));

  raw.prepare("SELECT count(*) c FROM log_entries WHERE json_extract(value,'$.adhoc') = 1").get()
    .c === 1
    ? ok('the ad-hoc Log-tab note is untouched (never in the mission diff)')
    : bad('AD-HOC CAPTURE DESTROYED');

  const again = rederiveMissionForDay(db, DATE);
  again.added === 0 && again.removed === 0
    ? ok('a second re-derive is a no-op')
    : bad('not idempotent', JSON.stringify(again));
}

console.log('9. re-derive removes an UNTOUCHED item the new version drops');
{
  const { db, raw } = freshDb();
  const id = createProtocolWithVersion(
    db,
    { name: 'Strength Block', type: 'training_block' },
    { items: [{ title: 'Squats 5x5', scheduled_time: '17:00', dose: null, notes: null }] }
  );
  generateMissionForDay(db, DATE);
  addVersion(db, id, {
    items: [{ title: 'Deadlifts 3x5', scheduled_time: '17:00', dose: null, notes: null }],
  });
  const res = rederiveMissionForDay(db, DATE);
  const titles = rows(raw, DATE).map((r) => r.title);
  !titles.includes('Squats 5x5') && titles.includes('Deadlifts 3x5') && res.removed === 1
    ? ok("an untouched pending item is swapped for the new version's item")
    : bad('should have removed', JSON.stringify({ titles, res }));
}

console.log('10. re-derive on an ungenerated day just generates it');
{
  const { db, raw } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Evening Stack', type: 'supplement_stack' },
    { items: [{ title: 'Magnesium', scheduled_time: '21:00', dose: '400 mg', notes: null }] }
  );
  const res = rederiveMissionForDay(db, DATE);
  res.added === 1 && rows(raw, DATE).length === 1
    ? ok('a day with no planned rows delegates to generateMissionForDay')
    : bad('delegate', JSON.stringify(res));
}

console.log('11. duplicate titles in one protocol survive a re-derive round trip');
{
  // A protocol legitimately listing the same item twice (two doses). Keying by
  // title alone collapsed these and lost the second dose permanently.
  const { db, raw } = freshDb();
  const original = {
    items: [
      { title: 'Magnesium', scheduled_time: '08:00', dose: '200 mg', notes: null },
      { title: 'Magnesium', scheduled_time: '21:00', dose: '400 mg', notes: null },
      { title: 'Creatine', scheduled_time: '08:00', dose: '5 g', notes: null },
    ],
  };
  const id = createProtocolWithVersion(db, { name: 'Stack', type: 'supplement_stack' }, original);
  generateMissionForDay(db, DATE);
  const doses = () => rows(raw, DATE).filter((r) => r.title === 'Magnesium').length;
  doses() === 2 ? ok('both Magnesium doses generated') : bad('dose fixture', doses());

  addVersion(db, id, {
    items: [
      ...original.items,
      { title: 'Zinc', scheduled_time: '21:00', dose: '15 mg', notes: null },
    ],
  });
  rederiveMissionForDay(db, DATE);
  doses() === 2 ? ok('both doses survive an additive revision') : bad('dose lost', doses());

  addVersion(db, id, original);
  rederiveMissionForDay(db, DATE);
  doses() === 2 && rows(raw, DATE).length === 3
    ? ok('reverting the revision restores exactly the original 3-item plan')
    : bad('round trip lost a dose', JSON.stringify(rows(raw, DATE).map((r) => r.title)));
}

console.log('12. a preserved PENDING non-generated row is not duplicated by the plan');
{
  const { db, raw } = freshDb();
  const log = getOrCreateDailyLog(db, DATE);
  // A hand-added pending row whose title matches the plan's own next entry —
  // here, a running experiment's intervention (protocol_id null on both sides,
  // so the multiset diff must count the preserved row as already satisfying it).
  insertMissionItem(db, log.id, 'habit', {
    id: 'x1',
    title: 'Extra fluids',
    status: 'pending',
    category: 'Morning',
    why: 'hand-added',
  });
  createExperiment(db, {
    title: 'Hydration test',
    hypothesis: 'More water, fewer headaches',
    intervention: 'Extra fluids',
    metrics: ['headaches'],
    startDate: DATE,
    durationDays: 7,
  });
  rederiveMissionForDay(db, DATE);
  const fluids = rows(raw, DATE).filter((r) => r.title === 'Extra fluids').length;
  fluids === 1
    ? ok('the plan does not duplicate an existing pending row of the same name')
    : bad('duplicated a preserved pending row', fluids);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
