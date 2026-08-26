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
import { listMission, setMissionStatus } from '../src/lib/db/repositories/mission.ts';
import { isoWeekday, weekStart } from '../src/lib/protocols/cadence.ts';
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

// ---------------------------------------------------------------------------
// content schema 2: CADENCE and PHASES. Before this, every item of every active
// protocol landed on EVERY day — "creatine daily", "3× a week lower body" and
// "8-week course, then stop" were one shape and all three ran seven days a
// week. Everything below is the fence around that being fixed.
//
// The dates are chosen and stated: 2026-08-01 is a SATURDAY, so 08-03 is the
// Monday that starts the following week. The weekday arithmetic is hand-rolled
// (Hermes has no Intl), so it is pinned against known dates rather than trusted.
// ---------------------------------------------------------------------------

/** A schema-2 content document, built the way the editor builds one. */
const content = (phases) => ({
  schema: 2,
  phases: phases.map((p, i) => ({
    id: p.id ?? `phase-${i}`,
    title: p.title ?? null,
    duration_days: p.days ?? null,
    items: p.items.map((it, j) => ({
      id: it.id ?? `item-${i}-${j}`,
      title: it.title,
      scheduled_time: it.time ?? null,
      dose: it.dose ?? null,
      notes: it.notes ?? null,
      cadence: it.cadence ?? { kind: 'daily' },
    })),
  })),
});

const titlesOn = (db, raw, date) => {
  generateMissionForDay(db, date);
  return rows(raw, date).map((r) => r.title);
};

console.log('8. the weekday arithmetic, pinned against known dates');
{
  // 1970-01-01 was a Thursday, which is what the epoch-day formula has to
  // reproduce; the rest are dates a person can check on a calendar.
  const cases = [
    ['1970-01-01', 4],
    ['2026-08-01', 6], // Saturday
    ['2026-08-02', 7], // Sunday
    ['2026-08-03', 1], // Monday
    ['2024-02-29', 4], // a leap day (Thursday)
    ['2026-12-31', 4],
  ];
  cases.every(([date, day]) => isoWeekday(date) === day)
    ? ok('isoWeekday: 1 = Monday … 7 = Sunday, across a leap day and a year boundary')
    : bad('isoWeekday', JSON.stringify(cases.map(([d]) => [d, isoWeekday(d)])));
  weekStart('2026-08-02') === '2026-07-27' && weekStart('2026-08-03') === '2026-08-03'
    ? ok('a week starts on MONDAY — Sunday belongs to the week before it')
    : bad('weekStart', `${weekStart('2026-08-02')} / ${weekStart('2026-08-03')}`);
}

console.log('9. cadence: daily, weekdays, every-N-days');
{
  const { db, raw } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Mixed', type: 'daily_routine', startedOn: '2026-08-01' },
    content([
      {
        items: [
          { title: 'Creatine' },
          { title: 'Lower body', cadence: { kind: 'weekdays', days: [1, 3, 5] } },
          { title: 'Sauna', cadence: { kind: 'every_n_days', n: 3 } },
        ],
      },
    ])
  );
  // 08-01 Sat = phase day 0 → every_n lands; not a Mon/Wed/Fri.
  const sat = titlesOn(db, raw, '2026-08-01');
  sat.includes('Creatine') && !sat.includes('Lower body') && sat.includes('Sauna')
    ? ok('Saturday: daily lands, Mon/Wed/Fri does not, every-3-days lands on phase day 0')
    : bad('saturday', JSON.stringify(sat));

  const sun = titlesOn(db, raw, '2026-08-02');
  sun.includes('Creatine') && !sun.includes('Lower body') && !sun.includes('Sauna')
    ? ok('Sunday: only the daily item — day 1 is not a multiple of 3')
    : bad('sunday', JSON.stringify(sun));

  const mon = titlesOn(db, raw, '2026-08-03');
  mon.includes('Lower body')
    ? ok('Monday: the weekday item comes round')
    : bad('monday', JSON.stringify(mon));

  const tue = titlesOn(db, raw, '2026-08-04');
  tue.includes('Sauna') && !tue.includes('Lower body')
    ? ok('Tuesday: phase day 3 → every-3-days lands; the weekday item does not')
    : bad('tuesday', JSON.stringify(tue));
}

console.log('10. an N-per-week quota: surfaced until met, and a skip does not spend it');
{
  const { db, raw } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Training', type: 'training_block', startedOn: '2026-08-03' },
    content([{ items: [{ id: 'lift', title: 'Lift', cadence: { kind: 'quota', per_week: 3 } }] }])
  );
  // Monday 08-03 → Sunday 08-09 is ONE Monday-start week.
  const settle = (date, status) => {
    const row = rows(raw, date).find((r) => r.title === 'Lift');
    setMissionStatus(db, row.id, status);
  };

  titlesOn(db, raw, '2026-08-03').includes('Lift')
    ? ok('Monday: nothing done yet, so it is on the plan')
    : bad('mon');
  settle('2026-08-03', 'completed');
  titlesOn(db, raw, '2026-08-04').includes('Lift')
    ? ok('Tuesday: 1 of 3 done, still on the plan')
    : bad('tue');
  settle('2026-08-04', 'skipped');
  titlesOn(db, raw, '2026-08-05').includes('Lift')
    ? ok('Wednesday: the SKIP did not consume quota — still 1 of 3, still on the plan')
    : bad('skip consumed quota');
  settle('2026-08-05', 'completed');
  titlesOn(db, raw, '2026-08-06');
  settle('2026-08-06', 'completed');

  const fri = titlesOn(db, raw, '2026-08-07');
  !fri.includes('Lift')
    ? ok('Friday: the third session is done, so it stops being asked for')
    : bad('quota met but still planned', JSON.stringify(fri));

  // The week boundary: Sunday still shows nothing, Monday starts over.
  const sun = titlesOn(db, raw, '2026-08-09');
  !sun.includes('Lift')
    ? ok('Sunday closes the week still met')
    : bad('sunday', JSON.stringify(sun));
  const nextMon = titlesOn(db, raw, '2026-08-10');
  nextMon.includes('Lift')
    ? ok('the next MONDAY starts a fresh quota — the week rolls, the count does not carry')
    : bad('new week did not reset', JSON.stringify(nextMon));
}

console.log('11. quota counting joins on ITEM IDENTITY, not on the title');
{
  const { db, raw } = freshDb();
  const id = createProtocolWithVersion(
    db,
    { name: 'Training', type: 'training_block', startedOn: '2026-08-03' },
    content([{ items: [{ id: 'lift', title: 'Lift', cadence: { kind: 'quota', per_week: 2 } }] }])
  );
  titlesOn(db, raw, '2026-08-03');
  const row = rows(raw, '2026-08-03').find((r) => r.title === 'Lift');
  JSON.parse(row.value).item === 'lift'
    ? ok('a generated row stamps the item id it came from')
    : bad('no item stamp', row.value);
  setMissionStatus(db, row.id, 'completed');

  // Rename the item — same id, new text. A title-keyed count would forget the
  // Monday session and start the week over.
  addVersion(
    db,
    id,
    content([
      { items: [{ id: 'lift', title: 'Lift heavy', cadence: { kind: 'quota', per_week: 2 } }] },
    ]),
    'renamed'
  );
  titlesOn(db, raw, '2026-08-04');
  const tue = rows(raw, '2026-08-04').find((r) => r.title === 'Lift heavy');
  tue ? ok('Tuesday: 1 of 2 done, the renamed item is still asked for') : bad('tue missing');
  setMissionStatus(db, tue.id, 'completed');
  const wed = titlesOn(db, raw, '2026-08-05');
  !wed.includes('Lift heavy')
    ? ok('Wednesday: the rename did not reset the quota — 2 of 2 counted across the change')
    : bad('rename reset the quota', JSON.stringify(wed));
}

console.log('12. phases: the generator picks the phase by date, and an ended protocol stops');
{
  const { db, raw } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Creatine', type: 'supplement_stack', startedOn: '2026-08-01' },
    content([
      { title: 'Loading', days: 7, items: [{ title: 'Creatine', dose: '20 g' }] },
      { title: 'Maintenance', items: [{ title: 'Creatine', dose: '5 g' }] },
    ])
  );
  const doseOn = (date) => {
    generateMissionForDay(db, date);
    const row = rows(raw, date).find((r) => r.title === 'Creatine');
    return row ? JSON.parse(row.value).dose : null;
  };
  doseOn('2026-08-01') === '20 g' && doseOn('2026-08-07') === '20 g'
    ? ok('the loading phase runs its seven days at 20 g')
    : bad('loading dose', doseOn('2026-08-07'));
  doseOn('2026-08-08') === '5 g'
    ? ok('the transition day switches to maintenance — "20 g for a week, then 5" is expressible')
    : bad('transition dose', doseOn('2026-08-08'));

  const { db: db2, raw: raw2 } = freshDb();
  createProtocolWithVersion(
    db2,
    { name: 'Course', type: 'therapy_protocol', startedOn: '2026-08-01' },
    content([{ days: 7, items: [{ title: 'Peptide' }] }])
  );
  titlesOn(db2, raw2, '2026-08-07').includes('Peptide')
    ? ok('a bounded protocol runs to its last day')
    : bad('last day missing');
  generateMissionForDay(db2, '2026-08-08');
  rows(raw2, '2026-08-08').length === 0
    ? ok('…and then ENDS — an eight-week course that stops is expressible too')
    : bad('ended protocol still generating', JSON.stringify(rows(raw2, '2026-08-08')));

  const { db: db3, raw: raw3 } = freshDb();
  createProtocolWithVersion(
    db3,
    { name: 'Later', type: 'daily_routine', startedOn: '2026-09-01' },
    content([{ items: [{ title: 'Not yet' }] }])
  );
  generateMissionForDay(db3, '2026-08-15');
  rows(raw3, '2026-08-15').length === 0
    ? ok('a protocol anchored in the future puts nothing on a day before it starts')
    : bad('future protocol generated', JSON.stringify(rows(raw3, '2026-08-15')));
}

console.log('13. a mid-day edit reaches TODAY through the re-derive, preserving work');
{
  const { db, raw } = freshDb();
  const id = createProtocolWithVersion(
    db,
    { name: 'Stack', type: 'supplement_stack', startedOn: DATE },
    content([
      {
        items: [
          { id: 'a', title: 'Creatine', dose: '5 g' },
          { id: 'b', title: 'Omega-3' },
        ],
      },
    ])
  );
  generateMissionForDay(db, DATE);
  const creatine = rows(raw, DATE).find((r) => r.title === 'Creatine');
  setMissionStatus(db, creatine.id, 'completed');

  // The edit: drop Omega-3, add Zinc, and re-dose the item already taken.
  addVersion(
    db,
    id,
    content([
      {
        items: [
          { id: 'a', title: 'Creatine', dose: '10 g' },
          { id: 'c', title: 'Zinc' },
        ],
      },
    ]),
    'dropped omega, added zinc'
  );
  const result = rederiveMissionForDay(db, DATE);
  const after = rows(raw, DATE);
  const stillCreatine = after.find((r) => r.title === 'Creatine');
  stillCreatine &&
  stillCreatine.id === creatine.id &&
  stillCreatine.status === 'completed' &&
  after.some((r) => r.title === 'Zinc') &&
  !after.some((r) => r.title === 'Omega-3')
    ? ok('the edit lands today: the untouched item goes, the new one arrives, the DONE one stays')
    : bad('mid-day edit', JSON.stringify({ result, after: after.map((r) => [r.title, r.status]) }));

  // And an item whose quota is already met this week must not be re-added by
  // the re-derive — the diff and the cadence have to agree.
  const { db: db2, raw: raw2 } = freshDb();
  const qid = createProtocolWithVersion(
    db2,
    { name: 'Training', type: 'training_block', startedOn: '2026-08-03' },
    content([{ items: [{ id: 'lift', title: 'Lift', cadence: { kind: 'quota', per_week: 1 } }] }])
  );
  generateMissionForDay(db2, '2026-08-03');
  setMissionStatus(db2, rows(raw2, '2026-08-03').find((r) => r.title === 'Lift').id, 'completed');
  generateMissionForDay(db2, '2026-08-04');
  addVersion(
    db2,
    qid,
    content([{ items: [{ id: 'lift', title: 'Lift', cadence: { kind: 'quota', per_week: 1 } }] }]),
    'no-op edit'
  );
  rederiveMissionForDay(db2, '2026-08-04');
  !rows(raw2, '2026-08-04').some((r) => r.title === 'Lift')
    ? ok('a quota already met this week is not re-added by an edit later in the week')
    : bad('quota item resurrected', JSON.stringify(rows(raw2, '2026-08-04').map((r) => r.title)));
}

console.log('14. an UNANCHORED active protocol is anchored by the first generation');
{
  const { db, raw } = freshDb();
  // Exactly the state a protocol is created in: active, with a version, and no
  // phase clock. The generator reads NULL as "starts today" and stamps it, so
  // phase 1 begins on the first day it actually plans something.
  createProtocolWithVersion(
    db,
    { name: 'Titrated', type: 'supplement_stack' },
    content([
      { title: 'Ramp', days: 2, items: [{ title: 'Peptide', dose: '0.5 mg' }] },
      { title: 'Full', items: [{ title: 'Peptide', dose: '1 mg' }] },
    ])
  );
  raw.prepare('SELECT started_on FROM protocols').get().started_on === null
    ? ok('it starts unanchored')
    : bad('anchored at creation');
  generateMissionForDay(db, DATE);
  raw.prepare('SELECT started_on FROM protocols').get().started_on === DATE
    ? ok('the generation anchors it to the day it first planned something')
    : bad('not anchored by generation');
  JSON.parse(rows(raw, DATE).find((r) => r.title === 'Peptide').value).dose === '0.5 mg'
    ? ok('…and that day is day 0 of phase 1, so the user starts at the bottom of the ramp')
    : bad('wrong phase on first day');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
