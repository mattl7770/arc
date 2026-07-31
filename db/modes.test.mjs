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
import { generateMissionForDay } from '../src/lib/db/repositories/mission-generate.ts';
import { getModeDefinition, modeChangesPlan } from '../src/lib/modes/registry.ts';
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
