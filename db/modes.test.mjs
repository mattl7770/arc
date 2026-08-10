/**
 * Headless test of Modes (docs/information-architecture.md §Modes) against real
 * SQLite via node:sqlite: the day_modes repository (0026), the mode registry,
 * the mode-aware mission generator (drop types + inject items), and the real
 * set_mode Coach tool. op-sqlite / the model client are never loaded.
 * Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { todayISODate } from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { createProtocolWithVersion } from '../src/lib/db/repositories/protocols.ts';
import {
  clearMode,
  getActiveMode,
  getActiveModeRow,
  setMode,
} from '../src/lib/db/repositories/day-modes.ts';
import {
  generateMissionForDay,
  rederiveMissionForDay,
} from '../src/lib/db/repositories/mission-generate.ts';
import {
  getOrCreateDailyLog,
  insertMissionItem,
  listMission,
  setMissionStatus,
} from '../src/lib/db/repositories/mission.ts';
import { deriveMissionView } from '../src/lib/home/derive-mission.ts';
import { logNote } from '../src/lib/db/repositories/logs.ts';
import { ensureTodaySeeded } from '../src/lib/db/seed.ts';
import {
  MODE_KEYS,
  accountForDay,
  getModeDefinition,
  modeChangesPlan,
  modeDirective,
} from '../src/lib/modes/registry.ts';
import { toolByName } from '../src/lib/ai/tools/index.ts';

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
const entriesFor = (raw, date) =>
  raw
    .prepare(
      `SELECT e.type, e.title, e.protocol_id, e.value FROM log_entries e
       JOIN daily_logs d ON d.id = e.daily_log_id WHERE d.date = ?`
    )
    .all(date);

console.log('0. no mode set → Normal; set/range/open-ended resolve; latest wins');
{
  const { db } = freshDb();
  getActiveMode(db, DATE) === 'normal' ? ok('an unset day is Normal') : bad('default mode');

  // Just today (endDate == startDate).
  setMode(db, { mode: 'sick', startDate: DATE, endDate: DATE });
  getActiveMode(db, DATE) === 'sick' && getActiveMode(db, '2026-08-02') === 'normal'
    ? ok('a single-day Sick covers that day only')
    : bad('single-day', getActiveMode(db, DATE));

  // A range (a trip).
  const { db: db2 } = freshDb();
  setMode(db2, { mode: 'travel', startDate: '2026-08-10', endDate: '2026-08-14' });
  getActiveMode(db2, '2026-08-09') === 'normal' &&
  getActiveMode(db2, '2026-08-10') === 'travel' &&
  getActiveMode(db2, '2026-08-14') === 'travel' &&
  getActiveMode(db2, '2026-08-15') === 'normal'
    ? ok('a Travel range covers [start..end] inclusive, nothing outside')
    : bad('range');

  // Open-ended, then a later reset wins.
  const { db: db3 } = freshDb();
  setMode(db3, { mode: 'sick', startDate: '2026-08-01' }); // open-ended
  getActiveMode(db3, '2026-08-05') === 'sick'
    ? ok('open-ended Sick covers future days')
    : bad('open');
  clearMode(db3, '2026-08-03'); // reset from the 3rd
  getActiveMode(db3, '2026-08-02') === 'sick' && getActiveMode(db3, '2026-08-05') === 'normal'
    ? ok('a later Normal reset ends the open-ended mode from its own start, past days unchanged')
    : bad('reset', `${getActiveMode(db3, '2026-08-02')}/${getActiveMode(db3, '2026-08-05')}`);
}

console.log('1. registry: definitions + modeChangesPlan');
{
  getModeDefinition('sick').excusesSkips === true &&
  getModeDefinition('sick').dropTypes.includes('workout') &&
  getModeDefinition('deload').excusesSkips === false
    ? ok('Sick excuses skips + drops workouts; Deload does not excuse')
    : bad('definitions');
  modeChangesPlan('sick') === true &&
  modeChangesPlan('social') === true &&
  modeChangesPlan('normal') === false &&
  modeChangesPlan('custom') === false
    ? ok('modeChangesPlan true for Sick/Social, false for Normal/Custom')
    : bad('modeChangesPlan');
}

console.log('1a. EVERY injected mode item is scheduled — an untimed one sinks the whole mode');
{
  // The regression this guards is the reason modes felt inert: the mission is
  // one chronological list and derive-mission.ts sorts an untimed item to
  // MAX_SAFE_INTEGER, so an item with no time lands BELOW every protocol item
  // and the mode never reaches the hero. ModeItem.scheduledTime is required at
  // the type level; this asserts it at the value level too, for every mode,
  // including any mode added later.
  const untimed = [];
  for (const key of MODE_KEYS) {
    for (const item of getModeDefinition(key).addItems) {
      if (typeof item.scheduledTime !== 'string' || !/^[0-9]{2}:[0-9]{2}$/.test(item.scheduledTime))
        untimed.push(`${key}/${item.title}`);
    }
  }
  untimed.length === 0
    ? ok('every mode item across every mode carries a valid HH:MM')
    : bad('untimed mode items sink to the bottom of the day', JSON.stringify(untimed));

  // The day-framing modes must LEAD. 07:00 beats any plausible protocol item,
  // which is what puts the mode's own instruction in the hero slot.
  const leadOf = (key) =>
    getModeDefinition(key)
      .addItems.map((i) => i.scheduledTime)
      .sort()[0];
  leadOf('sick') === '07:00' && leadOf('travel') === '07:00' && leadOf('deload') === '07:00'
    ? ok('Sick / Travel / Deload each lead the day at 07:00 (they take the hero)')
    : bad('lead times', `${leadOf('sick')}/${leadOf('travel')}/${leadOf('deload')}`);

  // Social is the deliberate exception: a night out bends the evening only, so
  // claiming the morning hero would be visibly false.
  leadOf('social') >= '12:00'
    ? ok(`Social deliberately does NOT take the morning hero (leads ${leadOf('social')})`)
    : bad('social hijacked the morning', leadOf('social'));
}

console.log('1b. modeDirective: heroFocus reaches a surface, with a tagline fallback');
{
  modeDirective('sick') === getModeDefinition('sick').heroFocus && modeDirective('sick').length > 0
    ? ok('modeDirective returns the mode heroFocus')
    : bad('directive sick', modeDirective('sick'));
  modeDirective('normal') === ''
    ? ok('Normal has no directive — the default day renders no banner')
    : bad('normal directive', modeDirective('normal'));
  // Custom carries no heroFocus, but a mode that is ON must still say something.
  modeDirective('custom') === getModeDefinition('custom').tagline &&
  modeDirective('custom').length > 0
    ? ok('Custom (no heroFocus) falls back to its tagline, never empty')
    : bad('custom fallback', modeDirective('custom'));
  MODE_KEYS.filter((k) => k !== 'normal').every((k) => modeDirective(k).length > 0)
    ? ok('every non-Normal mode has a directive to lead the day with')
    : bad('a mode that is ON has nothing to say');
}

console.log('1c. accountForDay: excusesSkips is an actual count, not just model guidance');
{
  const sick = accountForDay('sick', { skipped: 2 });
  sick.excused === 2 && sick.missed === 0 && typeof sick.note === 'string'
    ? ok(`Sick excuses 2 skips, 0 missed ("${sick.note}")`)
    : bad('sick accounting', JSON.stringify(sick));

  const deload = accountForDay('deload', { skipped: 2 });
  deload.excused === 0 && deload.missed === 2 && deload.note === null
    ? ok('Deload does NOT excuse — 2 missed, and it says nothing about judgement')
    : bad('deload accounting', JSON.stringify(deload));

  const normal = accountForDay('normal', { skipped: 3 });
  normal.excused === 0 && normal.missed === 3 && normal.note === null
    ? ok('Normal counts all 3 skips as misses, no note')
    : bad('normal accounting', JSON.stringify(normal));

  accountForDay('sick', { skipped: 0 }).note === null
    ? ok('an excusing mode with nothing skipped stays silent (no "0 skipped")')
    : bad('zero-skip note leaked');

  // A bad caller must never render "-1 skipped" on the owner's home screen.
  const clamped = accountForDay('social', { skipped: -4 });
  clamped.excused === 0 && clamped.note === null
    ? ok('a negative count is clamped, not rendered')
    : bad('negative skipped', JSON.stringify(clamped));
}

console.log('2. Sick mission: drops the training protocol, injects rest/fluids/immune');
{
  const { db, raw } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Strength Block', type: 'training_block' },
    { items: [{ title: 'Squats 5x5', scheduled_time: '17:00', dose: null, notes: null }] }
  );
  createProtocolWithVersion(
    db,
    { name: 'Evening Stack', type: 'supplement_stack' },
    { items: [{ title: 'Magnesium', scheduled_time: '21:00', dose: '400 mg', notes: null }] }
  );
  setMode(db, { mode: 'sick', startDate: DATE });

  const n = generateMissionForDay(db, DATE);
  const rows = entriesFor(raw, DATE);
  const types = rows.map((r) => r.type);
  !types.includes('workout')
    ? ok('the workout (training_block) is DROPPED in Sick mode')
    : bad('workout not dropped', JSON.stringify(types));
  rows.some((r) => r.title === 'Magnesium')
    ? ok('the non-training protocol (supplement) is KEPT')
    : bad('supplement dropped');
  const modeItems = rows.filter((r) => JSON.parse(r.value).mode === 'sick');
  modeItems.length === 3 &&
  modeItems.some((r) => r.title === 'Rest — no training today') &&
  modeItems.some((r) => r.title === 'Immune support')
    ? ok('3 Sick items injected (rest / fluids / immune), tagged mode:sick')
    : bad('sick items', JSON.stringify(modeItems.map((r) => r.title)));
  n === rows.length && n === 4
    ? ok('total = 1 kept supplement + 3 sick items = 4')
    : bad('count', `${n}/${rows.length}`);
}

console.log('2a. THE OWNER TEST: switching to Sick changes what Home LEADS with');
{
  // The whole point of the 2026-08-09 work. Previously the mode's items carried
  // no scheduled_time, sorted to MAX_SAFE_INTEGER in deriveMissionView, and
  // landed BELOW the 21:00 supplement — so the hero still said "Magnesium" and
  // Sick mode looked like the normal day minus a workout. This runs the real
  // Home derivation over the real generated rows and asserts the hero itself.
  const { db } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Morning Stack', type: 'supplement_stack' },
    { items: [{ title: 'Creatine', scheduled_time: '08:00', dose: '5 g', notes: null }] }
  );
  createProtocolWithVersion(
    db,
    { name: 'Strength Block', type: 'training_block' },
    { items: [{ title: 'Squats 5x5', scheduled_time: '17:00', dose: null, notes: null }] }
  );

  const normalHero = deriveMissionView(
    (generateMissionForDay(db, DATE), listMission(db, DATE)),
    new Set()
  ).next;
  normalHero.title === 'Creatine'
    ? ok('Normal day leads with the earliest protocol item (Creatine, 08:00)')
    : bad('normal hero', normalHero && normalHero.title);

  setMode(db, { mode: 'sick', startDate: DATE, endDate: DATE });
  rederiveMissionForDay(db, DATE);
  const sickView = deriveMissionView(listMission(db, DATE), new Set());
  sickView.next.title === 'Rest — no training today'
    ? ok('Sick day leads with "Rest — no training today" — the mode TAKES the hero')
    : bad('sick hero did not change', sickView.next && sickView.next.title);

  // ...and the mode's own items are threaded through the day, not appended
  // after everything else. Rest 07:00 < Creatine 08:00 < fluids 11:00.
  const order = sickView.items.map((i) => i.title);
  order.indexOf('Rest — no training today') === 0 &&
  order.indexOf('Extra fluids') > order.indexOf('Creatine') &&
  order.indexOf('Immune support') > order.indexOf('Extra fluids')
    ? ok('Sick items interleave chronologically, they are not an appendix')
    : bad('mode items not interleaved', JSON.stringify(order));

  // A mode item is attributed to the MODE, not dressed as a protocol.
  const rest = sickView.items.find((i) => i.title === 'Rest — no training today');
  rest.category === 'Sick' && rest.protocol === undefined
    ? ok('a mode item reads "SICK" — mode in the category slot, no fake protocol')
    : bad('mode item attribution', JSON.stringify({ c: rest.category, p: rest.protocol }));

  // Back to Normal restores the original hero — the change is not one-way.
  clearMode(db, DATE);
  rederiveMissionForDay(db, DATE);
  deriveMissionView(listMission(db, DATE), new Set()).next.title === 'Creatine'
    ? ok('back to Normal, the hero returns to Creatine (round trip is clean)')
    : bad('round trip hero');
}

console.log('3. no protocols + Sick still injects the mode items');
{
  const { db, raw } = freshDb();
  setMode(db, { mode: 'sick', startDate: DATE });
  const n = generateMissionForDay(db, DATE);
  n === 3 && entriesFor(raw, DATE).every((r) => JSON.parse(r.value).mode === 'sick')
    ? ok('a protocol-less Sick day is still 3 mode items (not empty)')
    : bad('no-protocol sick', n);
}

console.log('4. Normal mode is the baseline — protocols pass through unchanged');
{
  const { db, raw } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Strength Block', type: 'training_block' },
    { items: [{ title: 'Squats 5x5', scheduled_time: '17:00', dose: null, notes: null }] }
  );
  // No mode set → Normal.
  const n = generateMissionForDay(db, DATE);
  const rows = entriesFor(raw, DATE);
  n === 1 && rows[0].type === 'workout' && rows.every((r) => JSON.parse(r.value).mode === undefined)
    ? ok('Normal generates the protocol workout, no mode items, nothing dropped')
    : bad('normal baseline', JSON.stringify(rows.map((r) => r.title)));
}

console.log('5. Social mode injects its 3 guardrail items');
{
  const { db, raw } = freshDb();
  setMode(db, { mode: 'social', startDate: DATE });
  generateMissionForDay(db, DATE);
  const titles = entriesFor(raw, DATE).map((r) => r.title);
  titles.includes('Eat earlier') && titles.includes('Cap it') && titles.length === 3
    ? ok('Social adds eat-earlier / hydrate / cap-it')
    : bad('social items', JSON.stringify(titles));
}

console.log('6. the real set_mode Coach tool writes a mode + honest confirmation');
{
  const { db } = freshDb();
  const now = new Date(2026, 7, 1); // 2026-08-01 local
  const ctx = { now };
  const today = todayISODate(now);

  const tool = toolByName('set_mode');
  tool && !tool.readOnly
    ? ok('set_mode is a registered, gated write tool (no longer a stub)')
    : bad('not registered');

  const summary = tool.confirmSummary({ mode: 'travel', until: '2026-08-07' }, db);
  summary === 'Set Travel mode through 2026-08-07'
    ? ok(`confirmation names the mode + range ("${summary}")`)
    : bad('confirm', summary);

  const out = JSON.parse(tool.execute(db, { mode: 'travel', until: '2026-08-07' }, ctx));
  out.set === true && out.mode === 'travel' && out.from === today && out.until === '2026-08-07'
    ? ok('execute sets Travel for the range starting today')
    : bad('execute', JSON.stringify(out));
  getActiveMode(db, today) === 'travel' && getActiveModeRow(db, today).note === null
    ? ok('getActiveMode now reads Travel for today')
    : bad('post-set active mode');

  // 'normal' resets — and it must END THE WHOLE RANGE, not just today (the
  // Travel range above ran through 08-07). A single-day normal would let Travel
  // resurface tomorrow.
  const reset = JSON.parse(tool.execute(db, { mode: 'normal' }, ctx));
  reset.mode === 'normal' &&
  reset.until === null &&
  getActiveMode(db, today) === 'normal' &&
  getActiveMode(db, '2026-08-04') === 'normal' &&
  getActiveMode(db, '2026-08-07') === 'normal'
    ? ok('set_mode normal resets open-ended — ends the whole Travel range, not just today')
    : bad(
        'reset via tool',
        `${getActiveMode(db, today)}/${getActiveMode(db, '2026-08-04')}/${getActiveMode(db, '2026-08-07')}`
      );

  // A past `until` is rejected (would store an inert, no-day row).
  let threw = false;
  try {
    tool.execute(db, { mode: 'travel', until: '2026-07-31' }, ctx);
  } catch {
    threw = true;
  }
  threw
    ? ok('an `until` before today is rejected, not silently stored inert')
    : bad('past until accepted');
}

console.log('7. get_today_snapshot surfaces the active mode + its guidance');
{
  const { db } = freshDb();
  const now = new Date(2026, 7, 1);
  const ctx = { now };
  setMode(db, { mode: 'sick', startDate: todayISODate(now) });
  const snap = JSON.parse(toolByName('get_today_snapshot').execute(db, {}, ctx));
  snap.mode &&
  snap.mode.key === 'sick' &&
  snap.mode.excusesSkips === true &&
  typeof snap.mode.toneGuidance === 'string' &&
  typeof snap.mode.heroFocus === 'string'
    ? ok('snapshot reports mode:sick with heroFocus + toneGuidance + excusesSkips')
    : bad('snapshot mode', JSON.stringify(snap.mode));
}

console.log('8. mid-day re-derive reshapes the day WITHOUT destroying work');
{
  const { db, raw } = freshDb();
  createProtocolWithVersion(
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

  // Morning: a Normal day generates 3 protocol items.
  generateMissionForDay(db, DATE);
  const morning = entriesFor(raw, DATE);
  morning.length === 3 ? ok('Normal day generated 3 protocol items') : bad('setup', morning.length);

  // The user completes one workout and logs an ad-hoc note, THEN falls ill.
  const squats = morning.find((r) => r.title === 'Squats 5x5');
  const squatsId = raw.prepare('SELECT id FROM log_entries WHERE title = ?').get('Squats 5x5').id;
  setMissionStatus(db, squatsId, 'completed');
  const rowsId = raw.prepare('SELECT id FROM log_entries WHERE title = ?').get('Rows 3x10').id;
  setMissionStatus(db, rowsId, 'partial'); // real progress — must NOT be deleted
  logNote(db, DATE, 'Throat feels raw');
  squats ? ok('one workout completed, one partial, one ad-hoc note logged') : bad('fixture');

  setMode(db, { mode: 'sick', startDate: DATE, endDate: DATE });
  const res = rederiveMissionForDay(db, DATE);

  const after = entriesFor(raw, DATE);
  const titles = after.map((r) => r.title);
  // The COMPLETED + PARTIAL workouts survive even though Sick drops 'workout'.
  titles.includes('Squats 5x5') && titles.includes('Rows 3x10')
    ? ok('completed AND partial workouts survive a mode that drops their type')
    : bad('destroyed real work', JSON.stringify(titles));
  raw.prepare("SELECT status FROM log_entries WHERE title = 'Squats 5x5'").get().status ===
    'completed' &&
  raw.prepare("SELECT status FROM log_entries WHERE title = 'Rows 3x10'").get().status === 'partial'
    ? ok('their statuses are untouched')
    : bad('status changed');
  // The untouched pending supplement is still wanted by Sick (not a dropped type).
  titles.includes('Magnesium') ? ok('the still-wanted supplement is kept') : bad('lost supplement');
  // Sick's own items are now present.
  titles.includes('Rest — no training today') && titles.includes('Immune support')
    ? ok(`Sick items injected mid-day (added ${res.added})`)
    : bad('no sick items', JSON.stringify(titles));
  res.preserved >= 2
    ? ok(`re-derive reports ${res.preserved} preserved rows (acted-on work)`)
    : bad('preserved count', JSON.stringify(res));

  // The ad-hoc note is untouched — the worst failure mode.
  raw.prepare("SELECT count(*) c FROM log_entries WHERE json_extract(value,'$.adhoc') = 1").get()
    .c === 1
    ? ok('the ad-hoc Log-tab note is untouched (never in the mission diff)')
    : bad('AD-HOC CAPTURE DESTROYED');

  // Idempotent: nothing changes on a second call.
  const again = rederiveMissionForDay(db, DATE);
  again.added === 0 && again.removed === 0 && entriesFor(raw, DATE).length === after.length
    ? ok('a second re-derive is a no-op')
    : bad('not idempotent', JSON.stringify(again));
}

console.log('9. re-derive removes an UNTOUCHED item the new mode drops');
{
  const { db, raw } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Strength Block', type: 'training_block' },
    { items: [{ title: 'Squats 5x5', scheduled_time: '17:00', dose: null, notes: null }] }
  );
  generateMissionForDay(db, DATE);
  setMode(db, { mode: 'sick', startDate: DATE, endDate: DATE });
  const res = rederiveMissionForDay(db, DATE);
  const titles = entriesFor(raw, DATE).map((r) => r.title);
  !titles.includes('Squats 5x5') && res.removed === 1
    ? ok('an untouched pending workout IS removed when Sick drops training')
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
  res.added === 1 && entriesFor(raw, DATE).length === 1
    ? ok('a day with no planned rows delegates to generateMissionForDay')
    : bad('delegate', JSON.stringify(res));
}

console.log('11. re-derive NEVER destroys the first-run mock mission (no protocols)');
{
  // The default onboarding state: no protocols, so ensureTodaySeeded plants the
  // mock day. Two taps (Sick, then Normal) must not empty Home. Adversarial
  // review reproduced an 11 -> 2 permanent loss here before the fix.
  const { db, raw } = freshDb();
  const mock = [
    { id: 'm1', title: 'Cold shower', status: 'pending', category: 'Morning', why: 'demo' },
    { id: 'm2', title: 'Creatine', status: 'pending', category: 'Supplements', why: '5 g' },
    { id: 'm3', title: 'Zone 2 ride', status: 'pending', category: 'Training', why: '35 min' },
    { id: 'm4', title: 'Magnesium', status: 'pending', category: 'Evening', why: '400 mg' },
  ];
  ensureTodaySeeded(db, DATE, mock);
  const seeded = entriesFor(raw, DATE).length;
  seeded === 4 ? ok('first-run mock day seeded (4 items)') : bad('seed fixture', seeded);

  setMode(db, { mode: 'sick', startDate: DATE, endDate: DATE });
  rederiveMissionForDay(db, DATE);
  const sickTitles = entriesFor(raw, DATE).map((r) => r.title);
  // Sick drops the TYPE 'workout', so the mock ride goes; the rest survive.
  sickTitles.includes('Cold shower') &&
  sickTitles.includes('Creatine') &&
  sickTitles.includes('Magnesium') &&
  !sickTitles.includes('Zone 2 ride')
    ? ok('Sick keeps the mock items it does not drop, pulls only the training one')
    : bad('sick over-deleted the mock day', JSON.stringify(sickTitles));

  clearMode(db, DATE);
  rederiveMissionForDay(db, DATE);
  const backTitles = entriesFor(raw, DATE).map((r) => r.title);
  backTitles.includes('Cold shower') &&
  backTitles.includes('Creatine') &&
  backTitles.includes('Magnesium')
    ? ok('back to Normal, the mock mission is still intact (not wiped)')
    : bad('NORMAL WIPED THE MOCK DAY', JSON.stringify(backTitles));
}

console.log('12. duplicate titles in one protocol survive a mode round trip');
{
  // A protocol legitimately listing the same item twice (two doses). Keying by
  // title alone collapsed these and lost the second dose permanently.
  const { db, raw } = freshDb();
  createProtocolWithVersion(
    db,
    { name: 'Stack', type: 'supplement_stack' },
    {
      items: [
        { title: 'Magnesium', scheduled_time: '08:00', dose: '200 mg', notes: null },
        { title: 'Magnesium', scheduled_time: '21:00', dose: '400 mg', notes: null },
        { title: 'Creatine', scheduled_time: '08:00', dose: '5 g', notes: null },
      ],
    }
  );
  generateMissionForDay(db, DATE);
  const before = entriesFor(raw, DATE).filter((r) => r.title === 'Magnesium').length;
  before === 2 ? ok('both Magnesium doses generated') : bad('dose fixture', before);

  setMode(db, { mode: 'social', startDate: DATE, endDate: DATE });
  rederiveMissionForDay(db, DATE);
  const during = entriesFor(raw, DATE).filter((r) => r.title === 'Magnesium').length;
  during === 2 ? ok('both doses survive the switch to Social') : bad('dose lost in Social', during);

  clearMode(db, DATE);
  rederiveMissionForDay(db, DATE);
  const after = entriesFor(raw, DATE);
  const doses = after.filter((r) => r.title === 'Magnesium').length;
  doses === 2 && after.length === 3
    ? ok('Normal -> Social -> Normal restores exactly the original 3-item plan')
    : bad('round trip lost a dose', JSON.stringify(after.map((r) => r.title)));
}

console.log('13. a preserved PENDING non-generated row is not duplicated by the plan');
{
  const { db, raw } = freshDb();
  const log = getOrCreateDailyLog(db, DATE);
  // A hand-added pending row whose title matches one of Sick's own items.
  insertMissionItem(db, log.id, 'habit', {
    id: 'x1',
    title: 'Extra fluids',
    status: 'pending',
    category: 'Morning',
    why: 'hand-added',
  });
  setMode(db, { mode: 'sick', startDate: DATE, endDate: DATE });
  rederiveMissionForDay(db, DATE);
  const fluids = entriesFor(raw, DATE).filter((r) => r.title === 'Extra fluids').length;
  fluids === 1
    ? ok('the mode item does not duplicate an existing pending row of the same name')
    : bad('duplicated a preserved pending row', fluids);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
