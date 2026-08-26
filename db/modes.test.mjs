/**
 * Headless test of what SURVIVES the Modes feature's removal (2026-08-25,
 * owner call — src/lib/modes/registry.ts header) against real SQLite via
 * node:sqlite: the read-only day_modes resolution that reports use to judge
 * PAST days, the frozen excusal semantics, and the retirement migration (0043)
 * that ends mode coverage without touching mode history.
 *
 * The feature's own suite (registry levers, mode-aware generation, set_mode)
 * retired with the feature; the re-derive preserve-work tests moved to
 * db/mission-generate.test.mjs, driven by protocol edits — the machinery's
 * remaining production caller. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { getActiveMode, getActiveModeRow } from '../src/lib/db/repositories/day-modes.ts';
import { accountForDay, getModeDefinition } from '../src/lib/modes/registry.ts';

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

function migrator(raw, db) {
  return {
    exec: (sql) => raw.exec(sql),
    getUserVersion: () => raw.prepare('PRAGMA user_version').get().user_version,
    setUserVersion: (n) => raw.exec(`PRAGMA user_version = ${n}`),
    transaction: db.transaction,
  };
}

function freshDb(migrations = MIGRATIONS) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const db = makeDb(raw);
  migrate(migrator(raw, db), migrations);
  return { raw, db };
}

/** Plant a historical day_modes row the way the retired feature's writers did. */
let seq = 0;
function insertDayMode(db, { mode, startDate, endDate = null }) {
  db.run(
    `INSERT INTO day_modes (id, mode, start_date, end_date, label, note)
     VALUES (?, ?, ?, ?, NULL, NULL)`,
    [`dm-test-${++seq}`, mode, startDate, endDate]
  );
}

/** `date` shifted by `delta` days (UTC arithmetic), YYYY-MM-DD. */
function shiftDate(date, delta) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// The retirement migration, found by NAME so this suite survives a renumber —
// it was authored as 0040 against a stale inventory while main's head sat at
// 0042, which the version-filtered fixture here happily papered over: staged
// at v39 the migration was "pending" and every assertion passed, while on a
// real device it would have been silently skipped. Never key this suite on a
// hard-coded version number.
const RETIREMENT = MIGRATIONS.find((m) => m.name.includes('retire_day_modes'));
const HEAD = Math.max(...MIGRATIONS.map((m) => m.version));

console.log('0. the retirement row exists on a fresh database');
{
  RETIREMENT && RETIREMENT.version === HEAD
    ? ok(
        `the retirement migration is the head (${RETIREMENT.version}) — below it, devices skip it silently`
      )
    : bad(
        'RETIREMENT MIGRATION IS NOT THE HEAD — renumber it above main',
        JSON.stringify({ v: RETIREMENT?.version, HEAD })
      );

  const { db } = freshDb();
  const row = db.get(`SELECT * FROM day_modes WHERE id LIKE 'modes-retired-%'`);
  row && row.mode === 'normal' && row.end_date === null
    ? ok('one open-ended Normal row, planted by the migration')
    : bad('retirement row', JSON.stringify(row));
  /^\d{4}-\d{2}-\d{2}$/.test(row?.start_date ?? '')
    ? ok(`its start_date is a real date (${row.start_date})`)
    : bad('start_date shape', row?.start_date);
}

console.log('1. historical resolution: single-day / range / open-ended, newest wins');
{
  // The reports assembly re-resolves getActiveMode per PAST day, so the
  // resolution semantics the feature shipped with must keep holding for rows
  // already on a device. All dates below predate any possible retirement row.
  const { db } = freshDb();
  getActiveMode(db, '2026-08-01') === 'normal'
    ? ok('an unset past day is Normal')
    : bad('default mode');

  insertDayMode(db, { mode: 'sick', startDate: '2026-08-01', endDate: '2026-08-01' });
  getActiveMode(db, '2026-08-01') === 'sick' && getActiveMode(db, '2026-08-02') === 'normal'
    ? ok('a single-day Sick covers that day only')
    : bad('single-day');

  const { db: db2 } = freshDb();
  insertDayMode(db2, { mode: 'travel', startDate: '2026-08-10', endDate: '2026-08-14' });
  getActiveMode(db2, '2026-08-09') === 'normal' &&
  getActiveMode(db2, '2026-08-10') === 'travel' &&
  getActiveMode(db2, '2026-08-14') === 'travel' &&
  getActiveMode(db2, '2026-08-15') === 'normal'
    ? ok('a Travel range covers [start..end] inclusive, nothing outside')
    : bad('range');

  // Open-ended, then a later Normal reset wins from its own start — the
  // resolution rule the retirement's shutdown row leans on.
  const { db: db3 } = freshDb();
  insertDayMode(db3, { mode: 'sick', startDate: '2026-08-01' });
  getActiveMode(db3, '2026-08-05') === 'sick'
    ? ok('an open-ended Sick covers later days')
    : bad('open');
  insertDayMode(db3, { mode: 'normal', startDate: '2026-08-03' });
  getActiveMode(db3, '2026-08-02') === 'sick' && getActiveMode(db3, '2026-08-05') === 'normal'
    ? ok('a later Normal reset ends the open-ended mode from its start, past days unchanged')
    : bad('reset', `${getActiveMode(db3, '2026-08-02')}/${getActiveMode(db3, '2026-08-05')}`);
}

console.log('2. THE RETIREMENT: it ends live coverage, past verdicts untouched');
{
  // Reproduce a real device: migrate to the head as it stood BEFORE the
  // retirement (every migration except the retirement itself — by NAME, so a
  // renumber cannot quietly turn this back into a fixture no device was ever
  // in), live with modes exactly as the feature allowed — an open-ended Sick
  // set from Home (its picker only ever wrote open-ended) — then apply the
  // full set, as an app update would.
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const db = makeDb(raw);
  const preRemoval = MIGRATIONS.filter((m) => m !== RETIREMENT);
  migrate(migrator(raw, db), preRemoval);
  insertDayMode(db, { mode: 'sick', startDate: '2026-08-01' }); // open-ended, never cleared
  const applied = migrate(migrator(raw, db), MIGRATIONS);
  applied.applied.length === 1 && applied.applied[0] === RETIREMENT.name
    ? ok('the update applies exactly the retirement migration (it was truly pending)')
    : bad('RETIREMENT DID NOT APPLY on a real device head', JSON.stringify(applied));

  const retirement = db.get(`SELECT start_date FROM day_modes WHERE id LIKE 'modes-retired-%'`);
  const S = retirement.start_date;

  getActiveMode(db, shiftDate(S, -1)) === 'sick'
    ? ok('the day BEFORE retirement still reads Sick — history is not rewritten')
    : bad('history rewritten', getActiveMode(db, shiftDate(S, -1)));
  getActiveMode(db, S) === 'normal' && getActiveMode(db, shiftDate(S, 30)) === 'normal'
    ? ok('from the retirement date on, the stale open-ended Sick no longer applies')
    : bad('stale mode survived retirement', getActiveMode(db, S));

  // A mode SCHEDULED for days after the retirement is superseded too — with
  // the writers gone there would be no surface left to see or cancel it.
  const raw2 = new DatabaseSync(':memory:');
  raw2.exec('PRAGMA foreign_keys = ON;');
  const db2 = makeDb(raw2);
  migrate(migrator(raw2, db2), preRemoval);
  insertDayMode(db2, { mode: 'travel', startDate: '2027-01-10', endDate: '2027-01-14' });
  migrate(migrator(raw2, db2), MIGRATIONS);
  getActiveMode(db2, '2027-01-12') === 'normal'
    ? ok('a future-scheduled Travel is superseded by the retirement row')
    : bad('future mode survived', getActiveMode(db2, '2027-01-12'));

  // Idempotence of the whole path: a second migrate call applies nothing and
  // the retirement row stays singular.
  migrate(migrator(raw, db), MIGRATIONS);
  db.get(`SELECT count(*) AS c FROM day_modes WHERE id LIKE 'modes-retired-%'`).c === 1
    ? ok('re-running migrations does not duplicate the retirement row')
    : bad('retirement row duplicated');
}

console.log('3. accountForDay: the frozen excusal arithmetic reports still consume');
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

  const clamped = accountForDay('social', { skipped: -4 });
  clamped.excused === 0 && clamped.note === null
    ? ok('a negative count is clamped, not rendered')
    : bad('negative skipped', JSON.stringify(clamped));
}

console.log('4. the frozen definitions never drift — past days keep their verdicts');
{
  // These six pairs are the judgment historical days were lived under. A change
  // here would silently rewrite the reports ledger for days already on the
  // owner's device, which is exactly what the freeze forbids.
  const expected = {
    normal: ['Normal', false],
    travel: ['Travel', true],
    sick: ['Sick', true],
    deload: ['Deload', false],
    social: ['Social', true],
    custom: ['Custom', false],
  };
  const drifted = Object.entries(expected).filter(([key, [label, excuses]]) => {
    const def = getModeDefinition(key);
    return def.label !== label || def.excusesSkips !== excuses;
  });
  drifted.length === 0
    ? ok('all six retired keys carry their shipped label + excusal, verbatim')
    : bad('FROZEN DEFINITION DRIFTED', JSON.stringify(drifted));

  getModeDefinition('nonsense').label === 'Normal'
    ? ok('an unknown key still resolves to Normal (defensive default)')
    : bad('unknown key');
}

console.log('5. getActiveModeRow returns the covering row itself');
{
  const { db } = freshDb();
  insertDayMode(db, { mode: 'travel', startDate: '2026-08-10', endDate: '2026-08-14' });
  const row = getActiveModeRow(db, '2026-08-12');
  row && row.mode === 'travel' && row.start_date === '2026-08-10'
    ? ok('the Travel row backs the resolved key (reports read label/note off it)')
    : bad('row read', JSON.stringify(row));
  getActiveModeRow(db, '2026-08-20') === null
    ? ok('an uncovered day has no row — Normal is the absence, not a stored row')
    : bad('phantom row');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
