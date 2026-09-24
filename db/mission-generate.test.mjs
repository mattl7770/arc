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
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  addVersion,
  createProtocol,
  createProtocolWithVersion,
  deleteProtocol,
  setActive,
} from '../src/lib/db/repositories/protocols.ts';
import {
  hasUnseenRows,
  listMission,
  missionBySource,
  missionDailySeries,
  missionRecordStart,
  moveMissionItem,
  NOT_UNSEEN_SQL,
  remindableEntries,
  setMissionStatus,
  toggleMission,
} from '../src/lib/db/repositories/mission.ts';
import { protocolAdherence } from '../src/lib/db/repositories/protocol-adherence.ts';
import { completeExperiment, createExperiment } from '../src/lib/db/repositories/experiments.ts';
import { arriveDay, ensureTodaySeeded } from '../src/lib/db/seed.ts';

import { addDays, isoWeekday, weekStart } from '../src/lib/protocols/cadence.ts';
import {
  commitDayAhead,
  generateMissionForDay,
  hasCommittedDaysAhead,
  MISSION_HORIZON_DAYS,
  nextOccurrence,
  planForDay,
  planKey,
  projectDays,
  quotaCompletionsThisWeek,
  quotaDoneThisWeek,
  quotaKey,
  rederiveDaysAhead,
  rederiveMissionForDay,
  rederiveMissionFromToday,
  uncommitDayAhead,
} from '../src/lib/db/repositories/mission-generate.ts';
import { startStatus } from '../src/lib/db/repositories/statuses.ts';

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

  // EVERY SEED ROW SURVIVES A RE-DERIVE. The one that used not to was a row
  // whose whole TYPE a mode pulled (Sick dropped 'workout'), and that branch
  // went with the modes in 0061: nothing in the deterministic layer decides any
  // more that a kind of thing does not belong on a day. A status records the
  // fact and reshapes nothing; if today's ride should come off, the Coach takes
  // it off with adjust_today, which the user sees and approves.
  startStatus(db, { label: 'sick', startDate: DATE, endDate: DATE, source: 'user' });
  rederiveMissionForDay(db, DATE);
  const after = rows(raw, DATE).map((r) => r.title);
  after.includes('Cold shower') && after.includes('Creatine') && after.includes('Zone 2 ride')
    ? ok('a re-derive keeps EVERY untouched seed row — a status pulls nothing')
    : bad('re-derive damaged seed rows', JSON.stringify(after));
}

console.log('8. no tracked text file carries a literal NUL byte (the unsearchable-file trap)');
{
  // mission-generate.ts was committed with a RAW 0x00 as planKey's delimiter.
  // It RAN correctly — U+0000 is the ideal separator between a protocol id and
  // an item title, since it can occur in neither — but ripgrep classifies a
  // blob containing 0x00 as BINARY and skips it, so a recursive search over
  // src/ returned zero matches, silently, exit 1. Every grep-based sweep
  // quietly skipped the file that generates Home's entire mission. The fix was
  // to write the six-character escape instead of the byte: identical at
  // runtime inside a template literal, and searchable.
  //
  // The guard is repo-wide rather than about that one file, because the failure
  // mode is "a recursive search lies about a file" and any file can acquire it.
  const NUL = String.fromCharCode(0);
  const BINARY = /\.(jpe?g|png|gif|webp|ico|pdf|ttf|otf|woff2?|zip|mp4|mov|db|sqlite)$/i;
  const root = new URL('../', import.meta.url);
  const tracked = execSync('git ls-files', { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    .toString()
    .split('\n')
    .filter((f) => f.length > 0 && !BINARY.test(f));
  const tainted = tracked.filter((f) => readFileSync(new URL(f, root)).includes(0));
  tainted.length === 0
    ? ok(`${tracked.length} tracked text files, none containing a 0x00 byte`)
    : bad('a source file is invisible to recursive search', tainted.join(', '));
  // The scan has to be able to fail, or "none found" proves nothing.
  Buffer.from(`a${NUL}b`).includes(0) && !Buffer.from('a\\u0000b').includes(0)
    ? ok('…and it catches the raw byte while ignoring the escape that replaced it')
    : bad('NUL scan does not scan');
  // And the replacement is not a workaround with a caveat — it is the same
  // value, so nothing that used the delimiter had to change.
  planKey('Creatine', 'p1') === `p1${NUL}Creatine${NUL}native`
    ? ok('the escape still produces U+0000 — the delimiter is byte-for-byte unchanged')
    : bad('planKey delimiter changed', JSON.stringify(planKey('Creatine', 'p1')));
  // The third component (0050): a CARRIED entry and the day's own occurrence of
  // the same item under the same protocol are two obligations that share a
  // title. Without it either could claim the other's slot in the re-derive's
  // multiset — duplicating the item, or silently deleting today's own row.
  planKey('Creatine', 'p1', true) !== planKey('Creatine', 'p1') &&
  planKey('Creatine', 'p1', true) === `p1${NUL}Creatine${NUL}carried`
    ? ok('a carried entry and a native entry key apart')
    : bad('carried keys collide', JSON.stringify(planKey('Creatine', 'p1', true)));
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
      // Only when asked for, so every document built before §29 is unchanged.
      ...(it.remind ? { remind: true } : {}),
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

// ---------------------------------------------------------------------------
// 0050 — CARRY-OVER and CHECK-OFF MODE (backlog C11, docs/spikes/protocol-
// carryover.md). Two per-protocol columns of execution POLICY, both defaulting
// to exactly today's behaviour.
//
// Dates again chosen and stated: 2026-08-03 is a MONDAY, so 08-04 Tue, 08-05
// Wed, 08-07 Fri. Every case below leaves a day's row UNTOUCHED to create the
// debt — an untouched row is what the owner means by "if you miss something".
// ---------------------------------------------------------------------------

/** Generate a day and return its rows, newest plan first. */
const entriesOn = (db, raw, date) => {
  generateMissionForDay(db, date);
  return rows(raw, date);
};
const valueOf = (row) => JSON.parse(row.value ?? '{}');
const carriedOn = (db, raw, date, title) =>
  entriesOn(db, raw, date).filter((r) => r.title === title && valueOf(r).carried === true);

console.log('15. carry-over is OFF by default and changes nothing');
{
  const { db, raw } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Training', type: 'training_block', startedOn: '2026-08-03' },
    content([{ items: [{ title: 'Lower body', cadence: { kind: 'weekdays', days: [1, 5] } }] }])
  );
  const carry = raw.prepare('SELECT carry_over, checkoff_mode FROM protocols').get();
  carry.carry_over === 0 && carry.checkoff_mode === 'strict'
    ? ok('0050 leaves an existing protocol at carry_over 0 / strict')
    : bad('defaults moved', JSON.stringify(carry));

  entriesOn(db, raw, '2026-08-03'); // Monday plans it; nothing touches it.
  const tue = entriesOn(db, raw, '2026-08-04');
  tue.length === 0
    ? ok('Tuesday is empty — a miss stays attached to the day it was planned for')
    : bad('carried with the toggle off', JSON.stringify(tue.map((r) => r.title)));
  const mon = rows(raw, '2026-08-03')[0];
  valueOf(mon).carried === undefined && valueOf(mon).missed_days === undefined
    ? ok('…and no marks are written anywhere')
    : bad('marks written with the toggle off', mon.value);
}

console.log('16. a weekday miss carries as ONE row, verbatim, and ages');
{
  const { db, raw } = freshDb();
  createProtocolWithVersion(
    db,
    {
      name: 'Training',
      type: 'training_block',
      startedOn: '2026-08-03',
      carryOver: true,
    },
    content([
      {
        items: [
          {
            title: 'Lower body',
            time: '17:30',
            dose: '4x8 @ RPE 7',
            notes: 'Legs are the lever here',
            cadence: { kind: 'weekdays', days: [1, 5] },
          },
        ],
      },
    ])
  );
  const monday = entriesOn(db, raw, '2026-08-03')[0];
  monday && valueOf(monday).carried === undefined
    ? ok('Monday plans its own occurrence, uncarried')
    : bad('monday', JSON.stringify(monday));

  const tue = entriesOn(db, raw, '2026-08-04');
  const carried = tue.filter((r) => r.title === 'Lower body');
  const extras = carried[0] ? valueOf(carried[0]) : {};
  carried.length === 1 && extras.carried === true
    ? ok('Tuesday holds exactly ONE row for it, marked carried')
    : bad('tuesday carry', JSON.stringify(tue.map((r) => [r.title, r.value])));
  extras.carried_days === 1 &&
  extras.carried_from?.date === '2026-08-03' &&
  extras.carried_from?.entry === monday.id
    ? ok('it names the day and the row it is owed from, one day old')
    : bad('carried_from', JSON.stringify(extras));
  carried[0].scheduled_time === '17:30' &&
  extras.dose === '4x8 @ RPE 7' &&
  extras.why === 'Legs are the lever here'
    ? ok('the item comes across verbatim — same time, dose and why')
    : bad('carry lost fields', JSON.stringify(carried[0]));

  const before = rows(raw, '2026-08-04').length;
  rederiveMissionForDay(db, '2026-08-04');
  rows(raw, '2026-08-04').length === before
    ? ok('a second re-derive of the same day adds nothing')
    : bad('re-derive duplicated the carry', `${before} → ${rows(raw, '2026-08-04').length}`);

  const wed = carriedOn(db, raw, '2026-08-05', 'Lower body');
  wed.length === 1 && valueOf(wed[0]).carried_days === 2
    ? ok('Wednesday holds ONE carried row, now two days old')
    : bad('wednesday', JSON.stringify(wed.map((r) => r.value)));

  // Friday: the cadence's own occurrence SUPERSEDES the debt — one obligation,
  // one row — and merely says what is still outstanding behind it.
  const fri = entriesOn(db, raw, '2026-08-07').filter((r) => r.title === 'Lower body');
  fri.length === 1 && valueOf(fri[0]).carried === undefined
    ? ok('Friday holds exactly one row and it is the NATIVE occurrence, not a carry')
    : bad('supersede failed', JSON.stringify(fri.map((r) => r.value)));
  valueOf(fri[0]).missed_days === 1
    ? ok('…marked with the one earlier day still untouched behind it')
    : bad('missed_days', fri[0].value);
}

console.log('17. completing a carried row settles the ORIGINAL as done-late');
{
  const { db, raw } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Training', type: 'training_block', startedOn: '2026-08-03', carryOver: true },
    content([{ items: [{ title: 'Lower body', cadence: { kind: 'weekdays', days: [1, 5] } }] }])
  );
  const monday = entriesOn(db, raw, '2026-08-03')[0];
  const carried = carriedOn(db, raw, '2026-08-04', 'Lower body')[0];
  setMissionStatus(db, carried.id, 'completed');

  const settled = raw.prepare('SELECT * FROM log_entries WHERE id = ?').get(monday.id);
  settled.status === 'skipped' && valueOf(settled).late_on === '2026-08-04'
    ? ok('Monday is settled skipped, stamped with the day it was finally done')
    : bad('original not settled', JSON.stringify(settled));

  // …and the debt is closed, so nothing carries into Wednesday.
  carriedOn(db, raw, '2026-08-05', 'Lower body').length === 0
    ? ok('the debt is closed — Wednesday carries nothing')
    : bad('carry survived its own payment');

  // Un-ticking must be able to undo it, or a mis-tap permanently converts an
  // untouched row into a skip.
  setMissionStatus(db, carried.id, 'pending');
  const reopened = raw.prepare('SELECT * FROM log_entries WHERE id = ?').get(monday.id);
  reopened.status === 'pending' && valueOf(reopened).late_on === undefined
    ? ok('un-ticking the carried row re-opens the debt and clears the stamp')
    : bad('undo failed', JSON.stringify(reopened));
}

console.log('17b. skipping a carried row settles BOTH rows, and the undo re-opens either mark');
{
  const { db, raw } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Training', type: 'training_block', startedOn: '2026-08-03', carryOver: true },
    content([{ items: [{ title: 'Lower body', cadence: { kind: 'weekdays', days: [1, 5] } }] }])
  );
  const monday = entriesOn(db, raw, '2026-08-03')[0];
  const carried = carriedOn(db, raw, '2026-08-04', 'Lower body')[0];
  const untouched = raw
    .prepare("SELECT id FROM log_entries WHERE status = 'pending' AND id NOT IN (?, ?)")
    .all(monday.id, carried.id);

  // Was `skipCarried`, the item sheet's own function, until 2026-09-23; the
  // rule now lives in setMissionStatus itself, so every surface's skip is this.
  setMissionStatus(db, carried.id, 'skipped');
  const copy = raw.prepare('SELECT * FROM log_entries WHERE id = ?').get(carried.id);
  const origin = raw.prepare('SELECT * FROM log_entries WHERE id = ?').get(monday.id);
  copy.status === 'skipped' &&
  origin.status === 'skipped' &&
  valueOf(origin).skipped_via === carried.id
    ? ok('a hand-tapped skip on a carried row settles the copy AND stamps the original')
    : bad('carried skip', `${copy.status} / ${origin.status} / ${origin.value}`);
  untouched.length === 0
    ? ok('…and only those two rows — nothing else on the device was pending to reach')
    : bad('the carried skip reached further', JSON.stringify(untouched));

  // The debt is a decision now, not an outstanding day: the original is no
  // longer `pending`, so nothing re-levies it tomorrow.
  carriedOn(db, raw, '2026-08-05', 'Lower body').length === 0
    ? ok('the skip sticks — Wednesday re-levies nothing')
    : bad('a skipped debt came back');

  setMissionStatus(db, carried.id, 'pending');
  const reopened = raw.prepare('SELECT * FROM log_entries WHERE id = ?').get(monday.id);
  reopened.status === 'pending' && valueOf(reopened).skipped_via === undefined
    ? ok('Put back re-opens an original marked skipped_via and removes the mark')
    : bad('skipped_via undo failed', JSON.stringify(reopened));

  // The SAME undo path still handles the late-completion mark, and an original
  // marked neither is not something a carried row may touch.
  setMissionStatus(db, carried.id, 'completed');
  setMissionStatus(db, carried.id, 'pending');
  const afterLate = raw.prepare('SELECT * FROM log_entries WHERE id = ?').get(monday.id);
  afterLate.status === 'pending' && valueOf(afterLate).late_on === undefined
    ? ok('…and the late_on mark, through the one widened branch')
    : bad('late_on undo broke', JSON.stringify(afterLate));
  setMissionStatus(db, monday.id, 'skipped');
  setMissionStatus(db, carried.id, 'pending');
  raw.prepare('SELECT status FROM log_entries WHERE id = ?').get(monday.id).status === 'skipped'
    ? ok('an original marked NEITHER is left exactly as it is')
    : bad('undo reached an unmarked original');
}

console.log('18. daily marks, never a second row; a quota never carries at all');
{
  const { db, raw } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Evening stack', type: 'supplement_stack', startedOn: '2026-08-03', carryOver: true },
    content([{ items: [{ title: 'Magnesium', cadence: { kind: 'daily' } }] }])
  );
  createProtocolWithVersion(
    db,
    { name: 'Training', type: 'training_block', startedOn: '2026-08-03', carryOver: true },
    content([{ items: [{ title: 'Lift', cadence: { kind: 'quota', per_week: 3 } }] }])
  );
  entriesOn(db, raw, '2026-08-03'); // both planned, both left untouched

  const tue = entriesOn(db, raw, '2026-08-04');
  const mag = tue.filter((r) => r.title === 'Magnesium');
  mag.length === 1 && valueOf(mag[0]).carried === undefined
    ? ok('daily: ONE row on Tuesday — its own cadence always supersedes the debt')
    : bad('daily grew a second row', JSON.stringify(mag.map((r) => r.value)));
  valueOf(mag[0]).missed_days === 1
    ? ok('…and today’s row carries the mark instead')
    : bad('daily missed_days', mag[0].value);

  const lift = tue.filter((r) => r.title === 'Lift');
  lift.length === 1 &&
  valueOf(lift[0]).carried === undefined &&
  valueOf(lift[0]).missed_days === undefined
    ? ok('quota: one row, never carried and never marked — the quota IS the carry')
    : bad('quota carried', JSON.stringify(lift.map((r) => r.value)));
}

console.log('19. the 7-day cap, the phase boundary, an excused day, and a pause');
{
  const { db, raw } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Therapy', type: 'therapy_protocol', startedOn: '2026-08-03', carryOver: true },
    content([{ items: [{ title: 'Peptide', cadence: { kind: 'every_n_days', n: 14 } }] }])
  );
  entriesOn(db, raw, '2026-08-03'); // phase day 0 — lands, untouched
  const day7 = carriedOn(db, raw, '2026-08-10', 'Peptide');
  day7.length === 1 && valueOf(day7[0]).carried_days === 7
    ? ok('seven days past the miss it is still carried')
    : bad('day 7', JSON.stringify(day7.map((r) => r.value)));
  const day8 = entriesOn(db, raw, '2026-08-11').filter((r) => r.title === 'Peptide');
  day8.length === 0
    ? ok('on day 8 the debt is out of the window and nothing is carried')
    : bad('cap not applied', JSON.stringify(day8.map((r) => r.value)));
}
{
  const { db, raw } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Creatine', type: 'supplement_stack', startedOn: '2026-08-03', carryOver: true },
    content([
      { title: 'Loading', days: 5, items: [{ title: 'Creatine', dose: '2 caps' }] },
      { title: 'Maintenance', items: [{ title: 'Creatine', dose: '1 cap' }] },
    ])
  );
  entriesOn(db, raw, '2026-08-07'); // day 4 — the LAST day of phase 1, untouched
  const next = entriesOn(db, raw, '2026-08-08').filter((r) => r.title === 'Creatine');
  next.length === 1 && valueOf(next[0]).carried === undefined && valueOf(next[0]).dose === '1 cap'
    ? ok('a miss on the last day of phase 1 does not carry into phase 2')
    : bad('phase boundary crossed', JSON.stringify(next.map((r) => r.value)));
}
{
  const { db, raw } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Training', type: 'training_block', startedOn: '2026-08-03', carryOver: true },
    content([{ items: [{ title: 'Lower body', cadence: { kind: 'weekdays', days: [1, 5] } }] }])
  );
  // An excusing status forgives the skip, so nothing is owed out of Monday.
  startStatus(db, {
    label: 'traveling',
    startDate: '2026-08-03',
    endDate: '2026-08-03',
    source: 'user',
  });
  entriesOn(db, raw, '2026-08-03');
  carriedOn(db, raw, '2026-08-04', 'Lower body').length === 0
    ? ok('nothing carries out of a day the ledger excused')
    : bad('carried out of an excused day');
}
{
  const { db, raw } = freshDb();
  const id = createProtocolWithVersion(
    db,
    { name: 'Training', type: 'training_block', startedOn: '2026-08-03', carryOver: true },
    content([{ items: [{ title: 'Lower body', cadence: { kind: 'weekdays', days: [1, 5] } }] }])
  );
  entriesOn(db, raw, '2026-08-03');
  setActive(db, id, false);
  entriesOn(db, raw, '2026-08-04').length === 0
    ? ok('a paused protocol carries nothing')
    : bad('paused protocol carried');
}

console.log('20. checkoff_mode: adjusting re-bases every-N on the last completion');
{
  const { db, raw } = freshDb();
  createProtocolWithVersion(
    db,
    {
      name: 'Sauna strict',
      type: 'therapy_protocol',
      startedOn: '2026-08-03',
      carryOver: true,
      checkoffMode: 'strict',
    },
    content([{ items: [{ title: 'Sauna strict', cadence: { kind: 'every_n_days', n: 3 } }] }])
  );
  createProtocolWithVersion(
    db,
    {
      name: 'Sauna adjusting',
      type: 'therapy_protocol',
      startedOn: '2026-08-03',
      carryOver: true,
      checkoffMode: 'adjusting',
    },
    content([{ items: [{ title: 'Sauna adjusting', cadence: { kind: 'every_n_days', n: 3 } }] }])
  );
  const anchorsBefore = raw
    .prepare('SELECT id, started_on FROM protocols ORDER BY id')
    .all()
    .map((r) => r.started_on)
    .join(',');

  entriesOn(db, raw, '2026-08-03'); // phase day 0 — both land, both untouched
  // Both are done a day LATE, through their carried rows.
  for (const row of entriesOn(db, raw, '2026-08-04')) setMissionStatus(db, row.id, 'completed');

  const day3 = entriesOn(db, raw, '2026-08-06').map((r) => r.title);
  day3.includes('Sauna strict') && !day3.includes('Sauna adjusting')
    ? ok('phase day 3: strict asks again on the original calendar; adjusting does not')
    : bad('day 3', JSON.stringify(day3));
  // Day 4 is read by NATIVENESS, not by presence: strict asked on day 3 and was
  // left untouched, so it is on this day too — as a CARRY, which is the other
  // toggle doing its own job and not the clock moving.
  const day4 = entriesOn(db, raw, '2026-08-07');
  const adjusting = day4.find((r) => r.title === 'Sauna adjusting');
  const strict = day4.find((r) => r.title === 'Sauna strict');
  adjusting &&
  valueOf(adjusting).carried === undefined &&
  strict &&
  valueOf(strict).carried === true
    ? ok('phase day 4: adjusting asks NATIVELY three days after it was done; strict only carries')
    : bad('day 4', JSON.stringify(day4.map((r) => [r.title, r.value])));

  const anchorsAfter = raw
    .prepare('SELECT id, started_on FROM protocols ORDER BY id')
    .all()
    .map((r) => r.started_on)
    .join(',');
  anchorsAfter === anchorsBefore
    ? ok('THE INVARIANT: adjusting never writes started_on, so phase day 0 never moves')
    : bad('started_on moved', `${anchorsBefore} → ${anchorsAfter}`);
}

console.log('21. adjusting is a no-op for daily, weekdays and quota');
{
  const { db, raw } = freshDb();
  createProtocolWithVersion(
    db,
    {
      name: 'Mixed',
      type: 'daily_routine',
      startedOn: '2026-08-03',
      checkoffMode: 'adjusting',
    },
    content([
      {
        items: [
          { title: 'Creatine' },
          { title: 'Lower body', cadence: { kind: 'weekdays', days: [1, 3, 5] } },
          { title: 'Lift', cadence: { kind: 'quota', per_week: 3 } },
        ],
      },
    ])
  );
  for (const row of entriesOn(db, raw, '2026-08-03')) setMissionStatus(db, row.id, 'completed');
  const tue = entriesOn(db, raw, '2026-08-04').map((r) => r.title);
  tue.includes('Creatine')
    ? ok('daily still lands the next day — n is 1, so there is nothing to re-base')
    : bad('daily moved', JSON.stringify(tue));
  !tue.includes('Lower body')
    ? ok('a weekday list is a calendar statement: Tuesday is still not on it')
    : bad('weekdays re-based', JSON.stringify(tue));
  tue.includes('Lift')
    ? ok('a quota is anchored to the calendar week: 1 of 3 done, still asked for')
    : bad('quota re-based', JSON.stringify(tue));
  const wed = entriesOn(db, raw, '2026-08-05').map((r) => r.title);
  wed.includes('Lower body')
    ? ok('…and Wednesday still comes round exactly when the list says')
    : bad('weekdays moved', JSON.stringify(wed));
}

console.log('22. the projection flag: the SAME function, minus the two future-day artefacts');
{
  const { db, raw } = freshDb();
  // One fixture carrying every case at once, because the claim under test is
  // that the flag touches NOTHING except the carry and the quota — which can
  // only be shown by running both paths over the same varied days.
  const stack = createProtocolWithVersion(
    db,
    {
      name: 'Stack',
      type: 'supplement_stack',
      startedOn: '2026-08-03',
      carryOver: true,
    },
    content([
      {
        items: [
          { id: 'creatine', title: 'Creatine', dose: '5 g' },
          { id: 'lower', title: 'Lower body', cadence: { kind: 'weekdays', days: [1, 3, 5] } },
          { id: 'lift', title: 'Lift', cadence: { kind: 'quota', per_week: 3 } },
        ],
      },
    ])
  );
  // `adjusting`, so each projected day also exercises the lastCompletions read.
  const training = createProtocolWithVersion(
    db,
    {
      name: 'Training',
      type: 'training_block',
      startedOn: '2026-08-03',
      checkoffMode: 'adjusting',
    },
    content([{ items: [{ id: 'sauna', title: 'Sauna', cadence: { kind: 'every_n_days', n: 3 } }] }])
  );
  // Two phases, so the horizon crosses a boundary on 2026-08-06.
  createProtocolWithVersion(
    db,
    { name: 'Course', type: 'daily_routine', startedOn: '2026-08-03' },
    content([
      { days: 3, items: [{ id: 'loading', title: 'Loading dose', dose: '2 caps' }] },
      { items: [{ id: 'maintenance', title: 'Maintenance dose', dose: '1 cap' }] },
    ])
  );
  // A status open across the horizon, which must change NOTHING about either
  // path: 0061 took the last thing that could reshape a day out of the
  // deterministic layer, so the projection and the committing plan agree
  // through it rather than agreeing about how to honour it.
  startStatus(db, {
    label: 'sick',
    startDate: '2026-08-06',
    endDate: '2026-08-06',
    source: 'user',
  });

  // Monday is committed. Sauna is done (the `adjusting` clock has something to
  // read); everything else is left untouched, which is what makes Monday's
  // Lower body a DEBT and Monday's Creatine an outstanding daily.
  const monday = entriesOn(db, raw, '2026-08-03');
  setMissionStatus(db, monday.find((r) => r.title === 'Sauna').id, 'completed');

  const QUOTA_ITEMS = new Set(['lift']);
  // `missed_days` is the third thing that comes off a projected day, and for
  // the carry's own reason: it counts UNTOUCHED earlier rows, which projected
  // forward would read today's un-ticked creatine as outstanding on every day
  // of next week. It rides a native row rather than a row of its own, so it is
  // stripped here rather than filtered.
  const withoutCarryMarks = (entry) => {
    const { missed_days, ...extras } = entry.extras;
    return { ...entry, extras };
  };

  let identical = true;
  let sawCarried = false;
  let sawQuota = false;
  let sawMissedMark = false;
  for (let i = 0; i < 6; i++) {
    const date = addDays('2026-08-04', i);
    const committing = planForDay(db, date);
    const projected = planForDay(db, date, { committing: false });
    sawCarried ||= committing.some((e) => e.extras.carried === true);
    sawQuota ||= committing.some((e) => QUOTA_ITEMS.has(e.extras.item));
    sawMissedMark ||= committing.some((e) => e.extras.missed_days !== undefined);
    const expected = committing
      .filter((e) => e.extras.carried !== true && !QUOTA_ITEMS.has(e.extras.item))
      .map(withoutCarryMarks);
    if (JSON.stringify(projected) !== JSON.stringify(expected)) {
      identical = false;
      bad(
        `the flag changed something else on ${date}`,
        `${JSON.stringify(projected)} vs ${JSON.stringify(expected)}`
      );
      break;
    }
  }
  identical
    ? ok('day by day over the six-day horizon, the projection is the committing plan minus both')
    : null;
  // Without these the loop above would pass vacuously on a plan that happened
  // to contain neither artefact.
  sawCarried && sawQuota && sawMissedMark
    ? ok('…and the committing plan really did contain a carry, a quota and a missed-days mark')
    : bad(
        'the fixture produced no artefact to strip',
        `carried ${sawCarried} / quota ${sawQuota} / missed ${sawMissedMark}`
      );
  planForDay(db, '2026-08-06').some((e) => e.title === 'Sauna')
    ? ok('…and an open status pulls nothing out of either path')
    : bad('something still drops a type on a status day');
  // The boundary, read off the projection rather than asserted about the flag:
  // phase 1 runs 3 days from Monday, so Thursday is phase 2.
  const projection = projectDays(db, '2026-08-04');
  projection.length === 6 && projection[0].date === '2026-08-04'
    ? ok('projectDays walks six days and starts TOMORROW — today is the committed rows')
    : bad('projection horizon', JSON.stringify(projection.map((d) => d.date)));
  const thursday = projection.find((d) => d.date === '2026-08-06');
  thursday.entries.some((e) => e.title === 'Maintenance dose') &&
  !thursday.entries.some((e) => e.title === 'Loading dose')
    ? ok('…across a phase boundary, the projected day holds the phase live on IT')
    : bad('phase boundary', JSON.stringify(thursday.entries.map((e) => e.title)));

  // nextOccurrence, and its four honest nulls.
  nextOccurrence(projection, stack, 'lower') === '2026-08-05'
    ? ok('nextOccurrence finds the first projected day carrying the item')
    : bad('nextOccurrence', String(nextOccurrence(projection, stack, 'lower')));
  nextOccurrence(projection, stack, 'lift') === null
    ? ok('…null for a quota: it has an allowance, not a day')
    : bad('quota got a day', String(nextOccurrence(projection, stack, 'lift')));
  setActive(db, training, false);
  nextOccurrence(projectDays(db, '2026-08-04'), training, 'sauna') === null
    ? ok('…null for a paused protocol')
    : bad('a paused protocol projected a day');
}

console.log('22b. quotaDoneThisWeek counts TODAY, and the addDays shortcut would not');
{
  const { db, raw } = freshDb();
  const id = createProtocolWithVersion(
    db,
    { name: 'Training', type: 'training_block', startedOn: '2026-08-03' },
    content([{ items: [{ id: 'lift', title: 'Lift', cadence: { kind: 'quota', per_week: 3 } }] }])
  );
  // Monday and Tuesday done, then this morning's — three sessions, of which the
  // generator's bound can only ever see two.
  for (const date of ['2026-08-03', '2026-08-04', '2026-08-05']) {
    setMissionStatus(db, entriesOn(db, raw, date).find((r) => r.title === 'Lift').id, 'completed');
  }
  const today = '2026-08-05';
  const key = quotaKey(id, 'lift');
  quotaDoneThisWeek(db, today).get(key) === 3
    ? ok('the display count includes the session ticked this morning: 3 of 3')
    : bad('quotaDoneThisWeek', String(quotaDoneThisWeek(db, today).get(key)));
  quotaCompletionsThisWeek(db, today).get(key) === 2
    ? ok('…while the generator still counts 2, because a row must not be judged by its own day')
    : bad('quotaCompletionsThisWeek moved', String(quotaCompletionsThisWeek(db, today).get(key)));

  // THE SUNDAY TRAP, on its own fixture — the one above has met its quota by
  // Wednesday and stops landing. Faking an inclusive bound with
  // addDays(today, 1) rolls weekStart into the NEXT week one day in seven, and
  // the range goes empty.
  const sundayDb = freshDb();
  const weekly = createProtocolWithVersion(
    sundayDb.db,
    { name: 'Walk', type: 'daily_routine', startedOn: '2026-08-03' },
    content([{ items: [{ id: 'walk', title: 'Walk', cadence: { kind: 'quota', per_week: 7 } }] }])
  );
  const sunday = '2026-08-09'; // Aug 3 2026 is a Monday, so this is a Sunday.
  const walkKey = quotaKey(weekly, 'walk');
  setMissionStatus(
    sundayDb.db,
    entriesOn(sundayDb.db, sundayDb.raw, sunday).find((r) => r.title === 'Walk').id,
    'completed'
  );
  quotaDoneThisWeek(sundayDb.db, sunday).get(walkKey) === 1 &&
  (quotaCompletionsThisWeek(sundayDb.db, addDays(sunday, 1)).get(walkKey) ?? 0) === 0
    ? ok('on a Sunday the addDays shortcut reads 0 — which is why this is a sibling query')
    : bad(
        'the Sunday trap did not reproduce',
        `${quotaDoneThisWeek(sundayDb.db, sunday).get(walkKey)} / ${quotaCompletionsThisWeek(sundayDb.db, addDays(sunday, 1)).get(walkKey)}`
      );
  sundayDb.raw.close();
}

// ---------------------------------------------------------------------------
// THE MISSION DAY PICKER AND THE FUTURE CHECK-OFF (2026-09-19,
// docs/spikes/mission-day-picker-and-future-checkoff.md). No migration: two new
// value keys, `done_on` and `ahead`.
//
// Same stated dates as the carry-over block above — 2026-08-01 is a SATURDAY,
// so 08-03 Mon, 08-04 Tue, 08-05 Wed, 08-06 Thu, 08-07 Fri.
// ---------------------------------------------------------------------------

/**
 * Tap one row of a future day the way the Plan screen does: it holds the plan
 * it rendered, so it knows both the position and what is standing there. Used
 * wherever the ORDER of the plan is incidental to the case — §24 addresses the
 * ordinal by hand, because the ordinal is what it is testing.
 */
const tapAhead = (db, date, today, match) => {
  const plan = planForDay(db, date, { today });
  const ordinal = plan.findIndex(match);
  const entry = plan[ordinal];
  if (entry === undefined) return null;
  return commitDayAhead(db, date, today, {
    ordinal,
    expect: { title: entry.title, protocolId: entry.protocolId, itemId: entry.extras.item },
  });
};

console.log('23. the future view: no carry, no quota, and every entry marked AHEAD');
{
  const { db, raw } = freshDb();
  const TODAY = '2026-08-04';
  createProtocolWithVersion(
    db,
    { name: 'Stack', type: 'supplement_stack', startedOn: '2026-08-03', carryOver: true },
    content([
      {
        items: [
          { id: 'creatine', title: 'Creatine', dose: '5 g' },
          { id: 'lower', title: 'Lower body', cadence: { kind: 'weekdays', days: [1, 3, 5] } },
          { id: 'lift', title: 'Lift', cadence: { kind: 'quota', per_week: 3 } },
        ],
      },
    ])
  );
  // Monday committed and left untouched: every one of its rows is now a debt.
  generateMissionForDay(db, '2026-08-03');

  const future = planForDay(db, '2026-08-06', { today: TODAY });
  future.length > 0 && future.every((e) => e.extras.ahead === true)
    ? ok('every entry of a day that has not happened carries the ahead mark')
    : bad('ahead mark', JSON.stringify(future.map((e) => e.extras)));
  !future.some((e) => e.extras.carried === true || e.extras.missed_days !== undefined)
    ? ok('…none of them is a debt, and none wears a missed-days mark')
    : bad('a future day grew a carry', JSON.stringify(future.map((e) => e.extras)));
  !future.some((e) => e.extras.item === 'lift')
    ? ok('…and the quota item is not placed: an allowance is not a day')
    : bad('a quota landed on a future day');

  // `{ today }` and `{ committing: false }` are the same read, to the byte,
  // except for the mark. Stripping `ahead` by overriding it with undefined
  // keeps every other key in its original position, so this is an ORDER-
  // sensitive comparison and not a set comparison.
  const withoutAhead = (entries) =>
    JSON.stringify(entries.map((e) => ({ ...e, extras: { ...e.extras, ahead: undefined } })));
  withoutAhead(future) === JSON.stringify(planForDay(db, '2026-08-06', { committing: false }))
    ? ok('…and the option is the flag plus the mark, and nothing else')
    : bad('the option diverged from the flag', withoutAhead(future));

  raw.prepare('SELECT count(*) c FROM daily_logs WHERE date = ?').get('2026-08-06').c === 0
    ? ok('looking at a future day writes nothing — it has no daily_log at all')
    : bad('viewing committed a day');

  // Asked about TODAY, `{ today }` is still a COMMITTING read: the arrival
  // re-derive passes it and must get the carry and the quota, not a projection.
  JSON.stringify(planForDay(db, TODAY, { today: TODAY })) === JSON.stringify(planForDay(db, TODAY))
    ? ok('asked about today, the option changes nothing: it is a committing read')
    : bad('{ today } projected today');

  // The anchor trap. A NULL-anchored protocol read on a day ahead must start
  // TODAY, or committing the day would start the clock in the future.
  const fresh = freshDb();
  const unanchored = createProtocolWithVersion(
    fresh.db,
    { name: 'Course', type: 'daily_routine' },
    content([
      { days: 3, items: [{ id: 'loading', title: 'Loading dose' }] },
      { items: [{ id: 'maintenance', title: 'Maintenance dose' }] },
    ])
  );
  const ahead3 = planForDay(fresh.db, addDays(TODAY, 3), { today: TODAY });
  ahead3.some((e) => e.title === 'Maintenance dose')
    ? ok('a NULL-anchored protocol is read as starting TODAY, so today+3 is already phase 2')
    : bad('null anchor', JSON.stringify(ahead3.map((e) => e.title)));
  fresh.raw.prepare('SELECT started_on FROM protocols WHERE id = ?').get(unanchored).started_on ===
  null
    ? ok('…and reading the day still wrote no anchor')
    : bad('planForDay wrote started_on');
  planForDay(fresh.db, addDays(TODAY, 3)).some((e) => e.title === 'Loading dose')
    ? ok('…while without `today` it reads the VIEWED day as the anchor (the wrong answer, pinned)')
    : bad('the anchor fallback did not reproduce');
  fresh.raw.close();
  raw.close();
}

console.log('24. commitDayAhead: the guards, the ordinal, and what one tap writes');
{
  const { db, raw } = freshDb();
  const TODAY = '2026-08-04';
  const FRIDAY = '2026-08-07';
  // TWO items under ONE title — two doses, the multiset case planKey cannot
  // resolve and the reason the tapped row is addressed by position.
  const stack = createProtocolWithVersion(
    db,
    { name: 'Stack', type: 'supplement_stack' },
    content([
      {
        items: [
          { id: 'mag-am', title: 'Magnesium', dose: '200 mg', time: '08:00' },
          { id: 'mag-pm', title: 'Magnesium', dose: '400 mg', time: '21:00' },
        ],
      },
    ])
  );
  const expectAm = { title: 'Magnesium', protocolId: stack, itemId: 'mag-am' };
  const expectPm = { title: 'Magnesium', protocolId: stack, itemId: 'mag-pm' };

  commitDayAhead(db, TODAY, TODAY, { ordinal: 0, expect: expectAm }) === null
    ? ok('refuses today itself — an arrived day goes through the ordinary toggle')
    : bad('committed today as a day ahead');
  commitDayAhead(db, addDays(TODAY, MISSION_HORIZON_DAYS + 1), TODAY, {
    ordinal: 0,
    expect: expectAm,
  }) === null
    ? ok('…and refuses a day past the horizon')
    : bad('committed past the horizon');
  commitDayAhead(db, FRIDAY, TODAY, {
    ordinal: 1,
    expect: { title: 'Zinc', protocolId: stack, itemId: 'zinc' },
  }) === null
    ? ok('…and refuses when the row at that position is no longer what the screen drew')
    : bad('a stale expect committed');
  raw.prepare('SELECT count(*) c FROM daily_logs').get().c === 0 &&
  raw.prepare('SELECT count(*) c FROM log_entries').get().c === 0
    ? ok('…and not one refusal left a daily_log or a row behind')
    : bad('a refused commit wrote something');

  const ticked = commitDayAhead(db, FRIDAY, TODAY, { ordinal: 1, expect: expectPm });
  const friday = rows(raw, FRIDAY);
  friday.length === 2
    ? ok('one tap commits the WHOLE day, not the row')
    : bad('committed rows', String(friday.length));
  const am = friday.find((r) => valueOf(r).item === 'mag-am');
  const pm = friday.find((r) => valueOf(r).item === 'mag-pm');
  ticked === pm.id && pm.status === 'completed' && am.status === 'pending'
    ? ok('…and the SECOND row of the same title is the one completed — position, not key')
    : bad('ordinal', JSON.stringify(friday.map((r) => [valueOf(r).item, r.status])));
  valueOf(pm).done_on === TODAY
    ? ok('…stamped with the day of the TAP, not the day of the row')
    : bad('done_on', String(valueOf(pm).done_on));
  valueOf(am).ahead === true && valueOf(pm).ahead === true
    ? ok('…and both committed rows carry the ahead mark')
    : bad('ahead on committed rows', friday.map((r) => r.value).join(' | '));
  raw.prepare('SELECT started_on FROM protocols WHERE id = ?').get(stack).started_on === TODAY
    ? ok('…and the NULL-anchored protocol is anchored to TODAY, never to Friday')
    : bad(
        'anchor',
        String(raw.prepare('SELECT started_on FROM protocols WHERE id = ?').get(stack).started_on)
      );

  commitDayAhead(db, FRIDAY, TODAY, { ordinal: 0, expect: expectAm }) === null
    ? ok('a second tap on an already-committed day writes nothing')
    : bad('the day was committed twice');
  uncommitDayAhead(db, FRIDAY, TODAY) === false
    ? ok('un-committing refuses while the day holds an acted-on row')
    : bad('un-committed a day with a completion on it');

  toggleMission(db, pm.id, TODAY);
  valueOf(rows(raw, FRIDAY).find((r) => r.id === pm.id)).done_on === undefined
    ? ok('un-ticking removes the stamp')
    : bad('done_on survived an un-tick');
  uncommitDayAhead(db, FRIDAY, TODAY) === true && rows(raw, FRIDAY).length === 0
    ? ok('…and un-ticking the last tick lets the day go back to being computed')
    : bad('the day was not emptied');
  raw.close();
}

console.log('25. a tick made AHEAD: strict keeps the calendar, adjusting re-bases on the tap');
{
  // Sauna every 3 days from Sat 2026-08-01 → 08-01, 04, 07, 10.
  const TODAY = '2026-08-05';
  const sauna = (checkoffMode) =>
    content([
      {
        items: [
          { id: 'creatine', title: 'Creatine' },
          { id: 'sauna', title: 'Sauna', cadence: { kind: 'every_n_days', n: 3 } },
        ],
      },
    ]);

  const strictDb = freshDb();
  const strict = createProtocolWithVersion(
    strictDb.db,
    { name: 'Sauna block', type: 'therapy_protocol', startedOn: '2026-08-01' },
    sauna()
  );
  commitDayAhead(strictDb.db, '2026-08-07', TODAY, {
    ordinal: 1,
    expect: { title: 'Sauna', protocolId: strict, itemId: 'sauna' },
  });
  planForDay(strictDb.db, '2026-08-10').some((e) => e.extras.item === 'sauna')
    ? ok('strict: the 7th ticked on the 5th leaves the 10th exactly where the calendar had it')
    : bad('strict moved the clock');
  !planForDay(strictDb.db, '2026-08-08').some((e) => e.extras.item === 'sauna')
    ? ok('…and puts nothing in between')
    : bad('strict invented an occurrence');
  strictDb.raw.close();

  const adjDb = freshDb();
  const adj = createProtocolWithVersion(
    adjDb.db,
    {
      name: 'Sauna block',
      type: 'therapy_protocol',
      startedOn: '2026-08-01',
      checkoffMode: 'adjusting',
    },
    sauna()
  );
  commitDayAhead(adjDb.db, '2026-08-07', TODAY, {
    ordinal: 1,
    expect: { title: 'Sauna', protocolId: adj, itemId: 'sauna' },
  });
  planForDay(adjDb.db, '2026-08-08').some((e) => e.extras.item === 'sauna')
    ? ok('adjusting: done on the 5th, so the 8th is next — three days after the day it was DONE')
    : bad('adjusting did not re-base');
  !planForDay(adjDb.db, '2026-08-07').some((e) => e.extras.item === 'sauna')
    ? ok('…and the 7th stops being a native occurrence of its own plan')
    : bad('the 7th still lands');
  // Which is exactly why the completed row has to be preserved by the diff
  // rather than kept by landing. The day arrives, the plan no longer names it,
  // and it stands.
  arriveDay(adjDb.db, '2026-08-07');
  const arrived = adjDb.raw
    .prepare(
      `SELECT e.* FROM log_entries e JOIN daily_logs d ON d.id = e.daily_log_id WHERE d.date = ?`
    )
    .all('2026-08-07');
  const arrivedSauna = arrived.find((r) => valueOf(r).item === 'sauna');
  arrivedSauna && arrivedSauna.status === 'completed'
    ? ok('…yet its completed row stands through the day arriving')
    : bad('the completed row was removed', JSON.stringify(arrived.map((r) => [r.title, r.status])));
  valueOf(arrivedSauna).ahead === true
    ? ok('…keeping the mark as provenance, which is safe only because the predicate is a PAIR')
    : bad('provenance lost');
  const arrivedCreatine = arrived.find((r) => valueOf(r).item === 'creatine');
  arrivedCreatine.status === 'pending' && valueOf(arrivedCreatine).ahead === undefined
    ? ok('…while the row still pending had its mark stripped by the arrival diff')
    : bad('the mark survived on a pending row', arrivedCreatine.value);
  adjDb.raw.prepare('SELECT started_on FROM protocols WHERE id = ?').get(adj).started_on ===
  '2026-08-01'
    ? ok('…and adjusting still never writes started_on (the 0050 invariant)')
    : bad('started_on moved');
  adjDb.raw.close();

  // The quota arithmetic. A completion LATER in the same week has to count, or
  // a 3×/wk item records four sessions. The shipped commit path never places a
  // quota item on a day ahead (§23), so the state is built directly: the
  // predicate is the fence around the ARITHMETIC, not around a v1 gesture.
  const quotaDb = freshDb();
  const lift = createProtocolWithVersion(
    quotaDb.db,
    { name: 'Training', type: 'training_block', startedOn: '2026-08-03' },
    content([{ items: [{ id: 'lift', title: 'Lift', cadence: { kind: 'quota', per_week: 3 } }] }])
  );
  const tickLift = (date, tapDay) => {
    generateMissionForDay(quotaDb.db, date);
    const row = rows(quotaDb.raw, date).find((r) => r.title === 'Lift');
    setMissionStatus(quotaDb.db, row.id, 'completed', tapDay);
  };
  tickLift('2026-08-07', '2026-08-03'); // Friday's row, ticked on Monday
  tickLift('2026-08-03', '2026-08-03'); // Monday
  tickLift('2026-08-04', '2026-08-04'); // Tuesday
  !planForDay(quotaDb.db, '2026-08-05').some((e) => e.extras.item === 'lift')
    ? ok('a 3×/wk quota with Friday, Monday and Tuesday done does not land again on Wednesday')
    : bad('the quota landed a fourth time');
  quotaCompletionsThisWeek(quotaDb.db, '2026-08-05').get(quotaKey(lift, 'lift')) === 3
    ? ok('…because the week is counted WHOLE, minus only the day being planned')
    : bad(
        'week count',
        String(quotaCompletionsThisWeek(quotaDb.db, '2026-08-05').get(quotaKey(lift, 'lift')))
      );
  // The exclusion of the row's own day is unchanged, and still load-bearing.
  quotaCompletionsThisWeek(quotaDb.db, '2026-08-04').get(quotaKey(lift, 'lift')) === 2
    ? ok('…and a row is still never judged by its own day')
    : bad('the own-day exclusion moved');
  quotaDb.raw.close();
}

console.log('26. a day committed ahead never holds a plan the app no longer makes');
{
  const { db, raw } = freshDb();
  const TODAY = '2026-08-04';
  const FRIDAY = '2026-08-07';
  const stack = createProtocolWithVersion(
    db,
    { name: 'Stack', type: 'supplement_stack', startedOn: '2026-08-03' },
    content([
      {
        items: [
          { id: 'creatine', title: 'Creatine' },
          { id: 'zinc', title: 'Zinc' },
        ],
      },
    ])
  );
  createProtocolWithVersion(
    db,
    { name: 'Gym', type: 'training_block', startedOn: '2026-08-03' },
    content([{ items: [{ id: 'lower', title: 'Lower body' }] }])
  );
  const experiment = createExperiment(db, {
    title: 'Cold exposure',
    hypothesis: 'HRV rises',
    intervention: 'Cold shower',
    metrics: ['hrv'],
    startDate: '2026-08-03',
    durationDays: 10,
  });

  hasCommittedDaysAhead(db, TODAY) === false
    ? ok('with nothing committed ahead the gate answers no, in one query')
    : bad('the gate was already true');
  tapAhead(db, FRIDAY, TODAY, (e) => e.extras.item === 'creatine');
  hasCommittedDaysAhead(db, TODAY) === true
    ? ok('…and flips the moment a day ahead is committed')
    : bad('the gate did not flip');
  rows(raw, FRIDAY).length === 4
    ? ok('Friday is committed whole: two supplements, a session and the experiment')
    : bad(
        'friday',
        rows(raw, FRIDAY)
          .map((r) => r.title)
          .join(', ')
      );

  // A mode set over Friday was the first of three seams here. Modes retired in
  // 0061 — planForDay drops no types and injects no items — so that seam cannot
  // fire any more. The two below prove the same claim (a re-derive from today
  // reaches a day already committed ahead) through changes that still happen.
  completeExperiment(db, experiment, { conclusion: 'no effect' });
  rederiveMissionFromToday(db, TODAY);
  !rows(raw, FRIDAY).some((r) => r.title === 'Cold shower')
    ? ok('…and so does concluding an experiment, a seam that re-derived nothing before')
    : bad('the concluded experiment kept its row');
  deleteProtocol(db, stack);
  rederiveMissionFromToday(db, TODAY);
  const afterDelete = rows(raw, FRIDAY);
  !afterDelete.some((r) => r.title === 'Zinc')
    ? ok('…and deleting a protocol takes its untouched rows off Friday too')
    : bad('a deleted protocol kept its pending row');
  afterDelete.some((r) => r.title === 'Creatine' && r.status === 'completed')
    ? ok('…while everything the user actually asserted stands through all three')
    : bad(
        'a completed row was destroyed',
        JSON.stringify(afterDelete.map((r) => [r.title, r.status]))
      );
  raw.close();

  // A NULL-anchored protocol, through the seam that re-derives everything.
  const anchorDb = freshDb();
  const unanchored = createProtocolWithVersion(
    anchorDb.db,
    { name: 'Course', type: 'daily_routine' },
    content([{ items: [{ id: 'loading', title: 'Loading dose' }] }])
  );
  rederiveMissionFromToday(anchorDb.db, TODAY);
  anchorDb.raw.prepare('SELECT started_on FROM protocols WHERE id = ?').get(unanchored)
    .started_on === TODAY
    ? ok('rederiveMissionFromToday anchors to TODAY before it touches any day')
    : bad('anchor after the sweep');
  anchorDb.raw.close();

  // A COMPLETION on today reshapes a day already committed ahead: the most
  // common gesture in the app, and the one a committed-ahead day would go
  // stale on. A CARRIED row paid late is a completion on a non-native day,
  // which is what moves the adjusting clock off the phase grid.
  const tickDb = freshDb();
  const TODAY2 = '2026-08-05';
  const carry = createProtocolWithVersion(
    tickDb.db,
    {
      name: 'Sauna block',
      type: 'therapy_protocol',
      startedOn: '2026-08-01',
      carryOver: true,
      checkoffMode: 'adjusting',
    },
    content([
      {
        items: [
          { id: 'creatine', title: 'Creatine' },
          { id: 'sauna', title: 'Sauna', cadence: { kind: 'every_n_days', n: 3 } },
        ],
      },
    ])
  );
  generateMissionForDay(tickDb.db, '2026-08-04'); // a native sauna day, left untouched
  tapAhead(tickDb.db, '2026-08-10', TODAY2, (e) => e.extras.item === 'creatine');
  rows(tickDb.raw, '2026-08-10').some((r) => valueOf(r).item === 'sauna')
    ? ok('the 10th is committed ahead holding its native sauna')
    : bad('the committed day lacks the sauna');
  const carried = entriesOn(tickDb.db, tickDb.raw, TODAY2).find(
    (r) => valueOf(r).item === 'sauna' && valueOf(r).carried === true
  );
  setMissionStatus(tickDb.db, carried.id, 'completed', TODAY2);
  rederiveDaysAhead(tickDb.db, TODAY2);
  !rows(tickDb.raw, '2026-08-10').some((r) => valueOf(r).item === 'sauna')
    ? ok('…and paying the debt on the 5th takes it straight back off the 10th')
    : bad('the committed day went stale on a tick');
  rows(tickDb.raw, '2026-08-10').some((r) => valueOf(r).item === 'creatine')
    ? ok('…without disturbing what was ticked there')
    : bad('rederiveDaysAhead destroyed the tick');
  tickDb.raw.close();
}

console.log('27. a committed day ARRIVING: the marks come off, and the carry arrives with it');
{
  const { db, raw } = freshDb();
  const TODAY = '2026-08-04';
  const FRIDAY = '2026-08-07';
  const stack = createProtocolWithVersion(
    db,
    { name: 'Stack', type: 'supplement_stack', startedOn: '2026-08-03', carryOver: true },
    content([
      {
        items: [
          { id: 'creatine', title: 'Creatine' },
          { id: 'zinc', title: 'Zinc' },
          { id: 'mag', title: 'Magnesium', cadence: { kind: 'weekdays', days: [1] } },
        ],
      },
    ])
  );
  // Monday's Monday-only magnesium is missed — an untouched row, i.e. the debt.
  generateMissionForDay(db, '2026-08-03');
  tapAhead(db, FRIDAY, TODAY, (e) => e.extras.item === 'creatine');
  !rows(raw, FRIDAY).some((r) => valueOf(r).carried === true)
    ? ok('a day committed ahead holds no debt — Monday’s magnesium is not on Friday yet')
    : bad('a future day carried a debt');
  hasUnseenRows(db, FRIDAY) === true
    ? ok('…and reads as unseen while a row written before it is still pending')
    : bad('hasUnseenRows was false');

  // THE 0050 INVARIANT, in its new form: using the feature cannot make a rate
  // look worse. Friday has two rows; only the one he asserted is judged.
  const passedUnopened = missionDailySeries(db, 7, FRIDAY).find((p) => p.date === FRIDAY);
  passedUnopened.planned === 1 && passedUnopened.completed === 1
    ? ok('a committed-ahead day that passed unopened reads planned 1 · completed 1')
    : bad('the unopened day entered the rate', JSON.stringify(passedUnopened));

  arriveDay(db, FRIDAY);
  const arrived = rows(raw, FRIDAY);
  arrived.filter((r) => r.status === 'pending' && valueOf(r).ahead === true).length === 0
    ? ok('arriving strips the mark from every row still pending')
    : bad('marks survived arrival', arrived.map((r) => r.value).join(' | '));
  valueOf(arrived.find((r) => valueOf(r).item === 'creatine')).ahead === true
    ? ok('…and leaves it on the completed row as provenance')
    : bad('provenance lost');
  arrived.some((r) => r.title === 'Magnesium' && valueOf(r).carried === true)
    ? ok('…and the carry a future day never had is added the morning the day becomes today')
    : bad('the carry did not arrive', arrived.map((r) => r.title).join(', '));
  hasUnseenRows(db, FRIDAY) === false
    ? ok('…after which the day no longer reads as unseen')
    : bad('still unseen after arrival');
  const arrivedSeries = missionDailySeries(db, 7, FRIDAY).find((p) => p.date === FRIDAY);
  arrivedSeries.planned === 2
    ? ok('…and only now does it owe its whole plan')
    : bad('arrived day', JSON.stringify(arrivedSeries));
  raw.close();

  // THE BOUNDARY, BOTH WAYS (§3.9). Forward is the arrival above. Backward is a
  // day generated AS today that the logical today has since retreated behind:
  // its rows are ordinary — no mark — so it is not unseen, is not a debt, and
  // is ticked like any committed day.
  const backDb = freshDb();
  createProtocolWithVersion(
    backDb.db,
    { name: 'Stack', type: 'supplement_stack', startedOn: '2026-08-03', carryOver: true },
    content([{ items: [{ id: 'creatine', title: 'Creatine' }] }])
  );
  generateMissionForDay(backDb.db, '2026-08-05'); // generated as today, then today retreats
  hasUnseenRows(backDb.db, '2026-08-05') === false
    ? ok('a day that was today when it generated is never unseen, whatever the boundary does')
    : bad('an ordinary day read as unseen');
  !planForDay(backDb.db, '2026-08-06').some((e) => e.extras.carried === true)
    ? ok('…and its untouched rows are not a debt on the day after it')
    : bad('the former today became a debt');
  const backRow = rows(backDb.raw, '2026-08-05')[0];
  toggleMission(backDb.db, backRow.id, '2026-08-04');
  const backAfter = rows(backDb.raw, '2026-08-05')[0];
  backAfter.status === 'completed' && valueOf(backAfter).done_on === '2026-08-04'
    ? ok('…and it is ticked like any committed day, stamped with the logical day of the tap')
    : bad(
        'the retreated day could not be ticked',
        JSON.stringify([backAfter.status, backAfter.value])
      );
  backDb.raw.close();
}

console.log('28. the three-valued-logic pin: an ordinary pending row survives all five reads');
{
  const { db, raw } = freshDb();
  const TODAY = '2026-08-05';
  const stack = createProtocolWithVersion(
    db,
    { name: 'Stack', type: 'supplement_stack', startedOn: '2026-08-03', carryOver: true },
    content([
      {
        items: [
          { id: 'creatine', title: 'Creatine' },
          { id: 'mag', title: 'Magnesium', cadence: { kind: 'weekdays', days: [1] } },
        ],
      },
    ])
  );
  generateMissionForDay(db, '2026-08-03'); // Monday, untouched
  generateMissionForDay(db, '2026-08-04'); // Tuesday, untouched
  // A row with a NULL `value` — the state removeMissionItem's COALESCE exists
  // to survive, and the one json_extract cannot be asked about at all.
  const tuesdayLog = raw.prepare('SELECT id FROM daily_logs WHERE date = ?').get('2026-08-04').id;
  raw
    .prepare(
      `INSERT INTO log_entries (id, daily_log_id, type, title, status, value, source)
       VALUES ('null-value-row', ?, 'habit', 'Hand-added', 'pending', NULL, 'manual')`
    )
    .run(tuesdayLog);

  const series = missionDailySeries(db, 7, TODAY);
  const monday = series.find((p) => p.date === '2026-08-03');
  const tuesday = series.find((p) => p.date === '2026-08-04');
  monday.planned === 2
    ? ok('the day series still counts an ordinary pending row, which carries no `ahead` key')
    : bad('series monday', JSON.stringify(monday));
  tuesday.planned === 2
    ? ok('…and the NULL-value row beside it')
    : bad('series tuesday', JSON.stringify(tuesday));
  missionBySource(db, '2026-08-03', '2026-08-04').reduce((n, s) => n + s.planned, 0) === 4
    ? ok('missionBySource counts all four')
    : bad('bySource', JSON.stringify(missionBySource(db, '2026-08-03', '2026-08-04')));
  missionRecordStart(db, TODAY) === '2026-08-03'
    ? ok('…the record still begins on Monday')
    : bad('recordStart', String(missionRecordStart(db, TODAY)));
  protocolAdherence(db, stack, '2026-08-03', '2026-08-04').planned === 3
    ? ok('…the protocol record still counts its three obligations')
    : bad('adherence', JSON.stringify(protocolAdherence(db, stack, '2026-08-03', '2026-08-04')));
  planForDay(db, TODAY).some((e) => e.extras.carried === true)
    ? ok('…and outstandingCarries still sees Monday’s untouched magnesium as a debt')
    : bad('carry-over was disabled outright by the predicate');

  // The SHAPE, pinned at source: an IS NULL test, never a negated conjunction.
  NOT_UNSEEN_SQL === "(json_extract(value, '$.ahead') IS NULL OR status <> 'pending')"
    ? ok('the predicate is an IS NULL test paired with a status test')
    : bad('NOT_UNSEEN_SQL changed shape', NOT_UNSEEN_SQL);
  // And the negated form is not a style preference — it is run here, against
  // the same rows, and it drops every one of them.
  const total = raw.prepare('SELECT count(*) c FROM log_entries').get().c;
  const right = raw.prepare(`SELECT count(*) c FROM log_entries WHERE ${NOT_UNSEEN_SQL}`).get().c;
  const wrong = raw
    .prepare(
      `SELECT count(*) c FROM log_entries
        WHERE NOT (json_extract(value, '$.ahead') = 1 AND status = 'pending')`
    )
    .get().c;
  right === total && total > 0
    ? ok(`…and it keeps every one of the ${total} rows in this fixture`)
    : bad('the shipped predicate dropped rows', `${right} of ${total}`);
  wrong === 0
    ? ok('…where the negated form keeps NONE of them: the bug, reproduced')
    : bad('the trap did not reproduce', `${wrong} of ${total}`);
  raw.close();
}

// ---------------------------------------------------------------------------
// PHASE 0 of the protocol-menus compaction (2026-09-23): three defects in the
// mission layer, each reproduced here before it was fixed. §29–30 are the
// moved row that snapped back; §31 is the carried row whose skip evaporated
// overnight unless it was made from the item sheet. (The third defect, a Coach
// pause that never reached today, is fenced in db/coach-levers.test.mjs R7.)
// 2026-08-03 is a Monday, as above.
// ---------------------------------------------------------------------------

/** The day's `daily_logs.id` — what moveMissionItem is addressed by. */
const logIdOn = (raw, date) => raw.prepare('SELECT id FROM daily_logs WHERE date = ?').get(date).id;
const rowById = (raw, id) => raw.prepare('SELECT * FROM log_entries WHERE id = ?').get(id);

/** A Database that records every statement it runs, so "wrote nothing" is checkable. */
const spied = (db) => {
  const statements = [];
  return {
    statements,
    db: {
      ...db,
      run: (sql, params) => {
        statements.push(sql);
        db.run(sql, params);
      },
    },
  };
};

console.log('29. a row moved by hand keeps its time through a same-day re-derive');
{
  const { db, raw } = freshDb();
  const TODAY = '2026-08-03';
  const items = (creatineDose, creatineWhy, omegaTitle, omegaTime) => [
    {
      id: 'creatine',
      title: 'Creatine',
      time: '07:00',
      dose: creatineDose,
      notes: creatineWhy,
      remind: true,
    },
    { id: 'omega', title: omegaTitle, time: omegaTime },
    { id: 'zinc', title: 'Zinc', time: '12:00' },
  ];
  const stack = createProtocolWithVersion(
    db,
    { name: 'Stack', type: 'supplement_stack', startedOn: TODAY },
    content([{ items: items('5 g', 'Saturation', 'Omega-3', '08:00') }])
  );
  generateMissionForDay(db, TODAY);
  const byItem = (item) => rows(raw, TODAY).find((r) => valueOf(r).item === item);
  const creatine = byItem('creatine');
  const omega = byItem('omega');
  const zinc = byItem('zinc');
  moveMissionItem(db, logIdOn(raw, TODAY), creatine.id, '21:00');
  moveMissionItem(db, logIdOn(raw, TODAY), zinc.id, null); // "any time today"

  // The unrelated edit that used to undo the move: re-dose creatine, rewrite
  // its why-line, and move omega-3 in the plan. Every protocol save, restore,
  // Settings save and update_protocol runs exactly this re-derive.
  addVersion(
    db,
    stack,
    content([{ items: items('10 g', 'Loading week', 'Omega-3', '09:00') }]),
    'loading week'
  );
  rederiveMissionFromToday(db, TODAY);

  const moved = rowById(raw, creatine.id);
  moved.scheduled_time === '21:00'
    ? ok('the moved row keeps the time it was moved to')
    : bad('the move snapped back to the plan', moved.scheduled_time);
  valueOf(moved).dose === '10 g' && valueOf(moved).why === 'Loading week'
    ? ok('…while its dose and why-line still follow the edit')
    : bad('the moved row stopped following its item', moved.value);
  valueOf(moved).moved === true
    ? ok('…and it keeps the mark, so the next re-derive keeps it too')
    : bad('the re-sync dropped the mark', moved.value);
  rowById(raw, zinc.id).scheduled_time === null
    ? ok('a row moved to "any time" stays untimed')
    : bad('the untimed move snapped back', String(rowById(raw, zinc.id).scheduled_time));
  const omegaAfter = rowById(raw, omega.id);
  omegaAfter.scheduled_time === '09:00' && valueOf(omegaAfter).moved === undefined
    ? ok('a row that was NOT moved still follows a time edit to its item')
    : bad('an unmoved row stopped following its item', JSON.stringify(omegaAfter));

  // Today's reminders are read from the committed rows, so the nudge goes
  // where the row now is — not back to 07:00.
  const nudge = remindableEntries(db, TODAY).find((r) => r.itemId === 'creatine');
  nudge?.scheduledTime === '21:00'
    ? ok('the reminder sync reads the moved time, not the plan’s')
    : bad('reminder read the plan', JSON.stringify(nudge));

  // Nothing new since: a second re-derive must write nothing at all, which is
  // only true if the kept mark compares equal to what the re-sync would write.
  const probe = spied(db);
  rederiveMissionFromToday(probe.db, TODAY);
  probe.statements.filter((s) => /UPDATE log_entries/.test(s)).length === 0
    ? ok('a second re-derive with nothing new writes no row')
    : bad('the kept mark churns every re-derive', probe.statements.join(' | '));

  // A tick and its undo in between rewrite `value` twice; the mark survives.
  setMissionStatus(db, creatine.id, 'completed', TODAY);
  setMissionStatus(db, creatine.id, 'pending', TODAY);
  addVersion(
    db,
    stack,
    content([{ items: items('15 g', 'Loading week', 'Omega-3', '09:00') }]),
    'more'
  );
  rederiveMissionFromToday(db, TODAY);
  const ticked = rowById(raw, creatine.id);
  ticked.scheduled_time === '21:00' && valueOf(ticked).dose === '15 g'
    ? ok('…through a tick and an un-tick as well')
    : bad('a status write lost the mark', JSON.stringify(ticked));

  // A RETITLE rebuilds the row — the diff matches on the title — so the move
  // has to go across with the item rather than die with the old row.
  moveMissionItem(db, logIdOn(raw, TODAY), omega.id, '18:00');
  addVersion(
    db,
    stack,
    content([{ items: items('15 g', 'Loading week', 'Fish oil', '09:00') }]),
    'renamed'
  );
  rederiveMissionFromToday(db, TODAY);
  const fish = byItem('omega');
  fish?.title === 'Fish oil' && fish.scheduled_time === '18:00' && valueOf(fish).moved === true
    ? ok('a retitled item rebuilds its row at the time it was moved to')
    : bad('the retitle snapped the move back', JSON.stringify(fish));
  rows(raw, TODAY).filter((r) => valueOf(r).item === 'omega').length === 1
    ? ok('…as ONE row, not the old one beside a new one')
    : bad(
        'retitle duplicated',
        rows(raw, TODAY)
          .map((r) => r.title)
          .join(', ')
      );

  // The move said WHEN, not whether: pausing still takes the row off today.
  setActive(db, stack, false);
  rederiveMissionFromToday(db, TODAY);
  rows(raw, TODAY).length === 0
    ? ok('a pause still takes a moved row off today')
    : bad(
        'a moved row outlived its paused protocol',
        rows(raw, TODAY)
          .map((r) => r.title)
          .join()
      );
  raw.close();
}

console.log('30. the move mark through carry-over and a day committed ahead');
{
  const { db, raw } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Training', type: 'training_block', startedOn: '2026-08-03', carryOver: true },
    content([
      {
        items: [
          {
            id: 'lower',
            title: 'Lower body',
            time: '17:30',
            cadence: { kind: 'weekdays', days: [1, 5] },
          },
        ],
      },
    ])
  );
  const monday = entriesOn(db, raw, '2026-08-03')[0];
  moveMissionItem(db, logIdOn(raw, '2026-08-03'), monday.id, '19:00');
  // Monday passes untouched, so Tuesday carries the debt. A move is a
  // statement about ONE day ("Today only" is what adjust_today says of it), so
  // the debt is re-offered at the item's own time.
  const copy = carriedOn(db, raw, '2026-08-04', 'Lower body')[0];
  copy && copy.scheduled_time === '17:30' && valueOf(copy).moved === undefined
    ? ok('a moved day’s debt is re-offered at the item’s own time — the move was about Monday')
    : bad('the move leaked into the next day', JSON.stringify(copy));

  moveMissionItem(db, logIdOn(raw, '2026-08-04'), copy.id, '20:00');
  rederiveMissionForDay(db, '2026-08-04');
  const kept = rowById(raw, copy.id);
  kept.scheduled_time === '20:00' && valueOf(kept).moved === true
    ? ok('a carried copy moved by hand keeps its time through a re-derive')
    : bad('the carried copy snapped back', JSON.stringify(kept));
  valueOf(kept).carried === true &&
  valueOf(kept).carried_from?.entry === monday.id &&
  valueOf(kept).carried_days === 1
    ? ok('…and every carry mark rides along with it')
    : bad('carry marks lost', kept.value);
  raw.close();

  // A day committed ahead on the Plan screen is re-derived by every save, and
  // re-derived once more the morning it arrives. The move has to survive both.
  const ahead = freshDb();
  const TODAY = '2026-08-04';
  const FRIDAY = '2026-08-07';
  const stackItems = (zincDose) => [
    { id: 'creatine', title: 'Creatine', time: '07:00' },
    { id: 'zinc', title: 'Zinc', time: '08:00', dose: zincDose },
  ];
  const stack = createProtocolWithVersion(
    ahead.db,
    { name: 'Stack', type: 'supplement_stack', startedOn: '2026-08-03' },
    content([{ items: stackItems('15 mg') }])
  );
  tapAhead(ahead.db, FRIDAY, TODAY, (e) => e.extras.item === 'creatine');
  const zinc = rows(ahead.raw, FRIDAY).find((r) => valueOf(r).item === 'zinc');
  moveMissionItem(ahead.db, logIdOn(ahead.raw, FRIDAY), zinc.id, '12:00');
  addVersion(ahead.db, stack, content([{ items: stackItems('30 mg') }]), 'more zinc');
  rederiveMissionFromToday(ahead.db, TODAY); // re-derives the committed Friday too
  const friday = rowById(ahead.raw, zinc.id);
  friday.scheduled_time === '12:00' &&
  valueOf(friday).dose === '30 mg' &&
  valueOf(friday).ahead === true &&
  valueOf(friday).moved === true
    ? ok('a row on a day committed ahead keeps its move through the re-derive a save runs')
    : bad('the committed-ahead move snapped back', JSON.stringify(friday));
  arriveDay(ahead.db, FRIDAY);
  const arrived = rowById(ahead.raw, zinc.id);
  arrived.scheduled_time === '12:00' &&
  valueOf(arrived).ahead === undefined &&
  valueOf(arrived).moved === true
    ? ok('…and when the day arrives the ahead mark comes off and the move stays')
    : bad('arrival lost the move', JSON.stringify(arrived));
  ahead.raw.close();
}

console.log('31. a hand-made skip of a carried row settles the debt, whichever surface made it');
{
  const { db, raw } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Training', type: 'training_block', startedOn: '2026-08-03', carryOver: true },
    content([{ items: [{ title: 'Lower body', cadence: { kind: 'weekdays', days: [1, 5] } }] }])
  );
  createProtocolWithVersion(
    db,
    { name: 'Mobility', type: 'daily_routine', startedOn: '2026-08-03' },
    content([{ items: [{ title: 'Hips', cadence: { kind: 'daily' } }] }])
  );
  const monday = entriesOn(db, raw, '2026-08-03').find((r) => r.title === 'Lower body');
  const tuesday = entriesOn(db, raw, '2026-08-04');
  const copy = tuesday.find((r) => r.title === 'Lower body' && valueOf(r).carried === true);

  // The hero card's Skip (src/hooks/use-today-mission.ts) and adjust_today's
  // skip both reach the row through setMissionStatus(…, 'skipped'). Only the
  // item sheet used to call its own `skipCarried`, so only the sheet settled
  // the debt.
  setMissionStatus(db, copy.id, 'skipped', '2026-08-04');
  const origin = rowById(raw, monday.id);
  rowById(raw, copy.id).status === 'skipped' &&
  origin.status === 'skipped' &&
  valueOf(origin).skipped_via === copy.id
    ? ok('a skip on a carried copy settles the original, stamped with the copy that did it')
    : bad('the original was left owed', `${origin.status} / ${origin.value}`);
  carriedOn(db, raw, '2026-08-05', 'Lower body').length === 0
    ? ok('…so tomorrow carries nothing: the skip was a decision, not a delay')
    : bad('the skipped debt was carried again');

  // The row's own tap is the undo (toggleMission: skipped → pending), and it
  // has to re-open BOTH rows, as the sheet's Put back always did.
  toggleMission(db, copy.id, '2026-08-04');
  const reopened = rowById(raw, monday.id);
  rowById(raw, copy.id).status === 'pending' &&
  reopened.status === 'pending' &&
  valueOf(reopened).skipped_via === undefined
    ? ok('the row toggle re-opens the copy AND the original, and removes the mark')
    : bad('the undo left the original skipped', JSON.stringify(reopened));

  // A SKIP is the decision, not any settle: partial is progress, and the debt
  // stays owed.
  setMissionStatus(db, copy.id, 'partial', '2026-08-04');
  rowById(raw, monday.id).status === 'pending'
    ? ok('marking a carried copy partial leaves the original owed')
    : bad('partial settled the debt', rowById(raw, monday.id).value);

  // Done late, then changed to skipped: the original is re-filed, not
  // double-stamped with both marks.
  setMissionStatus(db, copy.id, 'completed', '2026-08-04');
  setMissionStatus(db, copy.id, 'skipped', '2026-08-04');
  const refiled = rowById(raw, monday.id);
  refiled.status === 'skipped' &&
  valueOf(refiled).skipped_via === copy.id &&
  valueOf(refiled).late_on === undefined
    ? ok('a done-late copy changed to skipped re-files the original as skipped, not done late')
    : bad('the original wears the wrong mark', refiled.value);

  // And an ordinary row's skip is exactly what it always was: that row, alone.
  const hips = tuesday.find((r) => r.title === 'Hips');
  const others = () =>
    JSON.stringify(
      raw
        .prepare('SELECT id, status, value FROM log_entries WHERE id <> ? ORDER BY id')
        .all(hips.id)
    );
  const before = others();
  setMissionStatus(db, hips.id, 'skipped', '2026-08-04');
  rowById(raw, hips.id).status === 'skipped' && others() === before
    ? ok('a skip on an ordinary row reaches no other row')
    : bad('an ordinary skip reached further');
  raw.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
