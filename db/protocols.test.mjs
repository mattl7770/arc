/**
 * Headless test of the Protocols data layer — the 0001 `protocols` +
 * `protocol_versions` tables and their repository (protocols.ts) plus the
 * content parser — against real SQLite via node:sqlite. Mirrors
 * db/nutrition.test.mjs; op-sqlite is never loaded. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { todayISODate } from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  addVersion,
  createProtocol,
  createProtocolWithVersion,
  deleteProtocol,
  ensureStartedOn,
  getCurrentVersion,
  getProtocol,
  listProtocols,
  listVersions,
  protocolFieldsOf,
  restoreVersion,
  saveProtocolEdit,
  setActive,
  setStartedOn,
  updateProtocolMeta,
} from '../src/lib/db/repositories/protocols.ts';
import { cadenceText, parseCadenceText } from '../src/lib/protocols/cadence.ts';
import {
  MINUTE_STEP,
  NO_TIME,
  PARKED_TIME,
  dateToTime,
  normalizeTime,
  timeToDate,
} from '../src/lib/protocols/clock-time.ts';
import {
  allItems,
  emptyContent,
  legacyItemId,
  normalizeCadence,
  normalizeContent,
  normalizeItem,
  parseProtocolContent,
  validateContent,
} from '../src/lib/protocols/content.ts';
import {
  blankItem,
  buildContent,
  moveToPhase,
  parseDays,
  seedPhases,
} from '../src/lib/protocols/edit-form.ts';
import { fieldPatch, rebaseContent } from '../src/lib/protocols/rebase.ts';
import { diffContent, diffLines } from '../src/lib/protocols/diff.ts';
import { phaseOn, totalDays } from '../src/lib/protocols/phase.ts';

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
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
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

const TODAY = todayISODate();
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STACK = {
  items: [
    { title: 'Creatine', scheduled_time: '07:30', dose: '5 g', notes: null },
    { title: 'Omega-3', scheduled_time: null, dose: '2 caps, with food', notes: null },
  ],
};

console.log('0. the 0001 protocol tables exist (no migration was added for this feature)');
{
  const { raw } = freshDb();
  const tables = raw
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('protocols','protocol_versions') ORDER BY name"
    )
    .all()
    .map((r) => r.name);
  JSON.stringify(tables) === JSON.stringify(['protocol_versions', 'protocols'])
    ? ok('protocols + protocol_versions are in the schema')
    : bad('tables', JSON.stringify(tables));
}

console.log('1. createProtocol persists the identity row — no version yet');
{
  const { db, raw } = freshDb();
  const id = createProtocol(db, {
    name: 'Morning Stack',
    type: 'supplement_stack',
    description: 'The 7am non-negotiables',
  });
  V4.test(id) ? ok('returned id is a v4 UUID') : bad('id shape', id);
  const row = raw.prepare('SELECT * FROM protocols WHERE id = ?').get(id);
  row &&
  row.slug === 'morning_stack' &&
  row.name === 'Morning Stack' &&
  row.description === 'The 7am non-negotiables' &&
  row.type === 'supplement_stack' &&
  row.is_active === 1 &&
  row.current_version_id === null
    ? ok('row stored: slugged, active by default, current_version_id NULL')
    : bad('row contents', JSON.stringify(row));
  row && row.created_at && row.updated_at
    ? ok('created_at / updated_at stamped by the DB defaults')
    : bad('timestamps', JSON.stringify(row));
}

console.log('2. slugs: repo-owned shape, unique via numeric suffix');
{
  const { db, raw } = freshDb();
  const a = createProtocol(db, { name: 'Zone 2 — Base Block!', type: 'training_block' });
  const b = createProtocol(db, { name: 'Zone 2 (Base) block', type: 'training_block' });
  const c = createProtocol(db, { name: 'Zone 2, base BLOCK', type: 'training_block' });
  const slugs = [a, b, c].map(
    (id) => raw.prepare('SELECT slug FROM protocols WHERE id = ?').get(id).slug
  );
  JSON.stringify(slugs) ===
  JSON.stringify(['zone_2_base_block', 'zone_2_base_block_2', 'zone_2_base_block_3'])
    ? ok('same-name collisions get _2, _3 suffixes')
    : bad('slug suffixes', JSON.stringify(slugs));
  const d = createProtocol(db, { name: '¡¡¡', type: 'other' });
  raw.prepare('SELECT slug FROM protocols WHERE id = ?').get(d).slug === 'protocol'
    ? ok("a name with no usable characters falls back to 'protocol'")
    : bad('slug fallback');
}

console.log('3. addVersion writes v1 and points current_version_id at it');
{
  const { db, raw } = freshDb();
  const pid = createProtocol(db, { name: 'Morning Stack', type: 'supplement_stack' });
  const vid = addVersion(db, pid, STACK, 'Initial stack');
  V4.test(vid) ? ok('returned version id is a v4 UUID') : bad('version id', vid);
  const v = raw.prepare('SELECT * FROM protocol_versions WHERE id = ?').get(vid);
  v &&
  v.protocol_id === pid &&
  v.version_number === 1 &&
  v.change_notes === 'Initial stack' &&
  v.created_by === 'user'
    ? ok("version 1, change_notes and created_by='user' stored")
    : bad('version row', JSON.stringify(v));
  v && JSON.stringify(JSON.parse(v.content)) === JSON.stringify(STACK)
    ? ok('content JSON round-trips intact')
    : bad('content', v && v.content);
  raw.prepare('SELECT current_version_id FROM protocols WHERE id = ?').get(pid)
    .current_version_id === vid
    ? ok('current_version_id points at the new version')
    : bad('pointer');
  const current = getCurrentVersion(db, pid);
  current && current.id === vid
    ? ok('getCurrentVersion resolves the pointer')
    : bad('getCurrentVersion', JSON.stringify(current));
}

console.log('4. a second addVersion bumps the pointer; the old version stays immutable');
{
  const { db, raw } = freshDb();
  const pid = createProtocol(db, { name: 'Morning Stack', type: 'supplement_stack' });
  const v1 = addVersion(db, pid, STACK, 'Initial stack');
  const v1Before = JSON.stringify(
    raw.prepare('SELECT * FROM protocol_versions WHERE id = ?').get(v1)
  );
  const v2Content = {
    items: [
      ...STACK.items,
      { title: 'Magnesium', scheduled_time: '21:30', dose: '400 mg', notes: null },
    ],
  };
  const v2 = addVersion(db, pid, v2Content, 'Added magnesium at night');
  const current = getCurrentVersion(db, pid);
  current && current.id === v2 && current.version_number === 2
    ? ok('current_version_id moved to v2')
    : bad('v2 pointer', JSON.stringify(current));
  JSON.stringify(raw.prepare('SELECT * FROM protocol_versions WHERE id = ?').get(v1)) === v1Before
    ? ok('the v1 row is byte-identical after the bump (immutable snapshot)')
    : bad('v1 mutated');
  raw.prepare('SELECT count(*) c FROM protocol_versions WHERE protocol_id = ?').get(pid).c === 2
    ? ok('both versions are retained')
    : bad('version count');
  const cols = raw
    .prepare("SELECT name FROM pragma_table_info('protocol_versions')")
    .all()
    .map((r) => r.name);
  !cols.includes('updated_at')
    ? ok('protocol_versions has no updated_at — no update path by design')
    : bad('updated_at column exists');
}

console.log('5. DB constraints hold: unique version numbers, valid JSON, sane enums');
{
  const { db, raw } = freshDb();
  const pid = createProtocol(db, { name: 'Morning Stack', type: 'supplement_stack' });
  addVersion(db, pid, STACK);
  throws(() =>
    raw
      .prepare(
        "INSERT INTO protocol_versions (id, protocol_id, version_number, content) VALUES ('dup', ?, 1, '{}')"
      )
      .run(pid)
  )
    ? ok('unique(protocol_id, version_number) rejects a duplicate v1')
    : bad('duplicate version accepted');
  throws(() =>
    raw
      .prepare(
        "INSERT INTO protocol_versions (id, protocol_id, version_number, content) VALUES ('v0', ?, 0, '{}')"
      )
      .run(pid)
  )
    ? ok('version_number 0 rejected (CHECK > 0)')
    : bad('version 0 accepted');
  throws(() =>
    raw
      .prepare(
        "INSERT INTO protocol_versions (id, protocol_id, version_number, content) VALUES ('vx', ?, 9, 'not json')"
      )
      .run(pid)
  )
    ? ok('non-JSON content rejected by json_valid CHECK')
    : bad('bad json accepted');
  throws(() =>
    raw
      .prepare(
        "INSERT INTO protocol_versions (id, protocol_id, version_number, content, created_by) VALUES ('vy', ?, 9, '{}', 'robot')"
      )
      .run(pid)
  )
    ? ok('created_by outside user|ai rejected')
    : bad('bad created_by accepted');
  throws(() => createProtocol(db, { name: 'Bad type', type: 'yolo_routine' }))
    ? ok('unknown protocol type rejected by the enum CHECK')
    : bad('bad type accepted');
  throws(() => addVersion(db, 'no-such-protocol', STACK))
    ? ok('addVersion against a missing protocol rejected by the FK')
    : bad('orphan version accepted');
}

console.log('6. listProtocols: active first then name, live version stats, empty-safe');
{
  const { db } = freshDb();
  listProtocols(db).length === 0 ? ok('empty database lists as []') : bad('empty list');
  const zeta = createProtocol(db, { name: 'Zeta block', type: 'training_block' });
  const alpha = createProtocol(db, { name: 'alpha stack', type: 'supplement_stack' });
  const mid = createProtocol(db, { name: 'Midline routine', type: 'daily_routine' });
  addVersion(db, zeta, STACK);
  addVersion(db, zeta, { items: [STACK.items[0]] }, 'Trimmed');
  setActive(db, alpha, false);
  const list = listProtocols(db);
  JSON.stringify(list.map((p) => p.name)) ===
  JSON.stringify(['Midline routine', 'Zeta block', 'alpha stack'])
    ? ok('active first, then case-insensitive name order')
    : bad('order', JSON.stringify(list.map((p) => p.name)));
  const z = list.find((p) => p.id === zeta);
  z && z.versionNumber === 2 && z.itemCount === 1 && z.isActive === true
    ? ok('live version number + item count come from the current version')
    : bad('zeta stats', JSON.stringify(z));
  const m = list.find((p) => p.id === mid);
  m && m.versionNumber === null && m.itemCount === 0
    ? ok('a version-less protocol reads v-null with 0 items')
    : bad('mid stats', JSON.stringify(m));
  const a = list.find((p) => p.id === alpha);
  a && a.isActive === false ? ok('paused protocol reports isActive false') : bad('alpha state');
}

console.log('7. setActive + updateProtocolMeta mutate the identity row; trigger restamps');
{
  const { db, raw } = freshDb();
  const pid = createProtocol(db, { name: 'Morning Stack', type: 'supplement_stack' });
  raw
    .prepare('UPDATE protocols SET updated_at = ? WHERE id = ?')
    .run('2000-01-01T00:00:00.000Z', pid);
  setActive(db, pid, false);
  const afterPause = raw
    .prepare('SELECT is_active, updated_at FROM protocols WHERE id = ?')
    .get(pid);
  afterPause.is_active === 0 && afterPause.updated_at !== '2000-01-01T00:00:00.000Z'
    ? ok('setActive(false) pauses and the updated_at trigger restamps')
    : bad('pause', JSON.stringify(afterPause));
  setActive(db, pid, true);
  raw.prepare('SELECT is_active FROM protocols WHERE id = ?').get(pid).is_active === 1
    ? ok('setActive(true) resumes')
    : bad('resume');
  updateProtocolMeta(db, pid, { name: 'AM Stack', type: 'daily_routine', description: 'renamed' });
  const meta = raw
    .prepare('SELECT slug, name, type, description FROM protocols WHERE id = ?')
    .get(pid);
  meta.name === 'AM Stack' && meta.type === 'daily_routine' && meta.description === 'renamed'
    ? ok('updateProtocolMeta renames / re-types / re-describes')
    : bad('meta', JSON.stringify(meta));
  meta.slug === 'morning_stack'
    ? ok('the slug never changes after creation (stable identity)')
    : bad('slug drifted', meta.slug);
}

console.log('8. unknown ids read as undefined, not throws');
{
  const { db } = freshDb();
  getProtocol(db, 'nope') === undefined
    ? ok('getProtocol(unknown) is undefined')
    : bad('getProtocol');
  getCurrentVersion(db, 'nope') === undefined
    ? ok('getCurrentVersion(unknown) is undefined')
    : bad('getCurrentVersion');
  const pid = createProtocol(db, { name: 'No versions yet', type: 'other' });
  getCurrentVersion(db, pid) === undefined
    ? ok('getCurrentVersion before any version is undefined')
    : bad('pre-version current');
}

console.log('9. deleting a protocol cascades versions but SET NULLs log history');
{
  const { db, raw } = freshDb();
  const pid = createProtocol(db, { name: 'Morning Stack', type: 'supplement_stack' });
  addVersion(db, pid, STACK);
  addVersion(db, pid, { items: [] }, 'Emptied');
  raw.prepare("INSERT INTO daily_logs (id, date) VALUES ('dl1', ?)").run(TODAY);
  raw
    .prepare(
      "INSERT INTO log_entries (id, daily_log_id, type, protocol_id, title) VALUES ('le1', 'dl1', 'supplement', ?, 'Creatine — AM stack')"
    )
    .run(pid);
  deleteProtocol(db, pid);
  raw.prepare('SELECT count(*) c FROM protocols').get().c === 0
    ? ok('protocol row deleted')
    : bad('protocol survived');
  raw.prepare('SELECT count(*) c FROM protocol_versions').get().c === 0
    ? ok('its versions cascaded away')
    : bad('versions survived');
  const entry = raw.prepare("SELECT protocol_id, title FROM log_entries WHERE id = 'le1'").get();
  entry && entry.protocol_id === null && entry.title === 'Creatine — AM stack'
    ? ok('the log entry survives with protocol_id SET NULL — history preserved')
    : bad('log entry', JSON.stringify(entry));
}

console.log('10. parseProtocolContent is forgiving on read');
{
  const empty = JSON.stringify(emptyContent());
  JSON.stringify(parseProtocolContent(null)) === empty &&
  JSON.stringify(parseProtocolContent('not json')) === empty &&
  JSON.stringify(parseProtocolContent('"a string"')) === empty &&
  JSON.stringify(parseProtocolContent('{}')) === empty &&
  JSON.stringify(parseProtocolContent('{"items": 42}')) === empty &&
  JSON.stringify(parseProtocolContent('{"schema":2,"phases":"nope"}')) === empty
    ? ok('null / malformed / foreign shapes all read as one empty open-ended phase')
    : bad('forgiving parse');

  const parsed = parseProtocolContent(
    JSON.stringify({
      items: [
        { title: '  Creatine  ', scheduled_time: '07:30', dose: '5 g', junk: true },
        { title: '', dose: 'ignored' },
        'not an object',
        { title: 'Walk', scheduled_time: '99:99' },
        { title: 'Nap', scheduled_time: '24:15' },
        { title: 'Lights out', scheduled_time: '23:59' },
      ],
    })
  );
  const titles = parsed.phases[0].items.map((i) => i.title);
  parsed.schema === 2 &&
  parsed.phases.length === 1 &&
  parsed.phases[0].duration_days === null &&
  titles.join('|') === 'Creatine|Walk|Nap|Lights out' &&
  parsed.phases[0].items[0].scheduled_time === '07:30' &&
  parsed.phases[0].items[1].scheduled_time === null &&
  parsed.phases[0].items[2].scheduled_time === null &&
  parsed.phases[0].items[3].scheduled_time === '23:59'
    ? ok('titled items normalize; impossible clock times (99:99, 24:15) nulled, 23:59 kept')
    : bad('normalize', JSON.stringify(parsed));
  parsed.phases[0].items.every((i) => i.cadence.kind === 'daily')
    ? ok('every legacy item reads as DAILY — exactly what the old generator did with them')
    : bad('legacy cadence', JSON.stringify(parsed));
}

// ---------------------------------------------------------------------------
// content schema 2 — phases + cadence. Everything from here to §11 arrived with
// the 2026-08-25 rework; §10 above is the legacy read path it must never break.
// ---------------------------------------------------------------------------

console.log('10a. the legacy read is DETERMINISTIC — the same v1 bytes give the same ids');
{
  // `protocol_versions` is immutable, so an old version is re-parsed on every
  // read. Ids derived from a counter or from randomness would differ each time
  // and a diff between two v1 versions would read as "everything changed".
  const json = JSON.stringify({
    items: [{ title: 'Creatine', dose: '5 g' }, { title: 'Omega-3' }],
  });
  const a = parseProtocolContent(json);
  const b = parseProtocolContent(json);
  JSON.stringify(a) === JSON.stringify(b)
    ? ok('two parses of the same bytes are byte-identical')
    : bad('non-deterministic parse', `${JSON.stringify(a)}\n${JSON.stringify(b)}`);
  a.phases[0].id === 'v1-phase' && a.phases[0].items[0].id === legacyItemId(0, 'Creatine')
    ? ok('ids derive from index + title, and the derivation is exported for the diff')
    : bad('derived ids', JSON.stringify(a.phases[0]));
  a.phases[0].items[0].id !== a.phases[0].items[1].id
    ? ok('two items of one document never collide')
    : bad('id collision', JSON.stringify(a));
}

console.log('10b. cadence: canonical text, round-trip, and forgiving normalisation');
{
  const cases = [
    [{ kind: 'daily' }, 'daily'],
    [{ kind: 'weekdays', days: [1, 3, 5] }, 'Mon,Wed,Fri'],
    [{ kind: 'every_n_days', n: 3 }, 'every 3 days'],
    [{ kind: 'quota', per_week: 3 }, '3/week'],
  ];
  cases.every(([c, text]) => cadenceText(c) === text)
    ? ok('every cadence kind has one canonical phrase')
    : bad('cadenceText', JSON.stringify(cases.map(([c]) => cadenceText(c))));
  cases.every(([c]) => JSON.stringify(parseCadenceText(cadenceText(c))) === JSON.stringify(c))
    ? ok('…and it round-trips through parseCadenceText — the Coach speaks the same vocabulary')
    : bad('round trip');

  JSON.stringify(parseCadenceText('MON, wed , fri')) ===
    JSON.stringify({ kind: 'weekdays', days: [1, 3, 5] }) &&
  JSON.stringify(parseCadenceText('every 3d')) ===
    JSON.stringify({ kind: 'every_n_days', n: 3 }) &&
  JSON.stringify(parseCadenceText('3 per week')) ===
    JSON.stringify({ kind: 'quota', per_week: 3 }) &&
  JSON.stringify(parseCadenceText('every 1 day')) === JSON.stringify({ kind: 'daily' })
    ? ok('spacing, case and "every 1 day" are all read the way a person would mean them')
    : bad('forgiving parse of cadence text');
  parseCadenceText('fortnightly') === null &&
  parseCadenceText('9/week') === null &&
  parseCadenceText('every 1000 days') === null
    ? ok('anything outside the vocabulary is null, so the tool boundary can refuse it')
    : bad('cadence text accepted junk');

  // The STORED shape normalises the other way: unreadable becomes daily,
  // because an item that lands too often is visible and fixable while one that
  // silently stops landing is not.
  normalizeCadence(undefined).kind === 'daily' &&
  normalizeCadence({ kind: 'weekdays', days: [] }).kind === 'daily' &&
  normalizeCadence({ kind: 'every_n_days', n: 1 }).kind === 'daily' &&
  normalizeCadence({ kind: 'quota', per_week: 12 }).kind === 'daily' &&
  normalizeCadence('nonsense').kind === 'daily'
    ? ok('a stored cadence that cannot be read degrades to daily, never to "never"')
    : bad('normalizeCadence');
  JSON.stringify(normalizeCadence({ kind: 'weekdays', days: [5, 1, 5, 9, 3] })) ===
  JSON.stringify({ kind: 'weekdays', days: [1, 3, 5] })
    ? ok('weekday lists are deduped, sorted and cleaned of out-of-range days')
    : bad('weekday normalisation');
}

console.log('10c. validateContent refuses the two documents that cannot work');
{
  const phase = (id, duration, items) => ({ id, title: null, duration_days: duration, items });
  const item = (id, title, cadence) => ({
    id,
    title,
    scheduled_time: null,
    dose: null,
    notes: null,
    cadence: cadence ?? { kind: 'daily' },
  });
  validateContent({ schema: 2, phases: [phase('a', null, [item('i', 'X')])] }) === null
    ? ok('one open-ended phase is the ordinary document and passes')
    : bad('valid content rejected');
  const midOpen = validateContent({
    schema: 2,
    phases: [phase('a', null, []), phase('b', 14, [])],
  });
  typeof midOpen === 'string' && midOpen.includes('Phase 1')
    ? ok('an open-ended phase followed by another is refused, naming the phase')
    : bad('mid-phase open-ended accepted', String(midOpen));
  const noDays = validateContent({
    schema: 2,
    phases: [phase('a', 7, [item('i', 'X', { kind: 'weekdays', days: [] })])],
  });
  typeof noDays === 'string' && noDays.includes('X')
    ? ok('a weekday cadence naming no days is refused, naming the item')
    : bad('empty weekday list accepted', String(noDays));
  validateContent({ schema: 2, phases: [] }) !== null
    ? ok('a document with no phases at all is refused')
    : bad('phaseless content accepted');
}

console.log('10d. phaseOn walks the phase clock');
{
  const c = {
    schema: 2,
    phases: [
      { id: 'load', title: 'Loading', duration_days: 7, items: [] },
      { id: 'main', title: 'Maintenance', duration_days: null, items: [] },
    ],
  };
  const on = (date) => phaseOn(c, '2026-08-01', date);
  on('2026-08-01').window.index === 0 &&
  on('2026-08-01').window.dayInPhase === 0 &&
  on('2026-08-07').window.index === 0 &&
  on('2026-08-07').window.dayInPhase === 6
    ? ok('phase 1 owns its whole span, day 0 first')
    : bad('phase 1 window', JSON.stringify(on('2026-08-07')));
  on('2026-08-08').window.index === 1 && on('2026-08-08').window.dayInPhase === 0
    ? ok('the transition day is day 0 of phase 2, not day 8 of phase 1')
    : bad('transition', JSON.stringify(on('2026-08-08')));
  on('2027-01-01').window.index === 1
    ? ok('an open-ended last phase runs forever')
    : bad('open-ended phase ended', JSON.stringify(on('2027-01-01')));
  on('2026-07-31').kind === 'not_started'
    ? ok('a date before the anchor is "not started", never phase 1')
    : bad('pre-start', JSON.stringify(on('2026-07-31')));

  const bounded = {
    schema: 2,
    phases: [{ id: 'course', title: null, duration_days: 56, items: [] }],
  };
  const ended = phaseOn(bounded, '2026-08-01', '2026-09-26');
  ended.kind === 'ended' && ended.endedOn === '2026-09-25'
    ? ok('a bounded last phase ENDS, and names its last active day')
    : bad('ended state', JSON.stringify(ended));
  phaseOn(bounded, '2026-08-01', '2026-09-25').kind === 'running'
    ? ok('…and the last day itself still runs')
    : bad('off-by-one at the end');
  totalDays(bounded) === 56 && totalDays(c) === null
    ? ok('totalDays is a number for a finite protocol and null for an open-ended one')
    : bad('totalDays', String(totalDays(c)));
}

console.log('10e. the version diff — the payoff the history never paid');
{
  const item = (id, title, extra = {}) => ({
    id,
    title,
    scheduled_time: null,
    dose: null,
    notes: null,
    cadence: { kind: 'daily' },
    ...extra,
  });
  const one = (items, duration = null) => ({
    schema: 2,
    phases: [{ id: 'p', title: null, duration_days: duration, items }],
  });

  const before = one([item('a', 'Creatine', { dose: '5 g' }), item('b', 'Omega-3')]);
  const after = one([
    item('a', 'Creatine', { dose: '10 g' }),
    item('c', 'Zinc', { cadence: { kind: 'quota', per_week: 3 } }),
  ]);
  const d = diffContent(before, after);
  d.changed === 1 && d.added === 1 && d.removed === 1 && !d.identical
    ? ok('one changed, one added, one removed — counted separately')
    : bad('diff counts', JSON.stringify(d));
  const lines = diffLines(d);
  lines.some((l) => l.includes('dose 5 g → 10 g')) &&
  lines.some((l) => l.includes('added Zinc')) &&
  lines.some((l) => l.includes('removed Omega-3'))
    ? ok('each change is one line, field-level where a field moved')
    : bad('diff lines', JSON.stringify(lines));

  diffContent(before, before).identical && diffLines(diffContent(before, before)).length === 0
    ? ok('a document against itself is identical and prints nothing')
    : bad('self diff');

  // A version written before schema 2 diffs against one written after it,
  // which is the version the owner will most want to read.
  const legacy = parseProtocolContent(
    JSON.stringify({ items: [{ title: 'Creatine', dose: '5 g' }] })
  );
  const modern = {
    schema: 2,
    phases: [
      {
        id: 'v1-phase',
        title: null,
        duration_days: null,
        items: [
          {
            id: legacy.phases[0].items[0].id,
            title: 'Creatine',
            scheduled_time: null,
            dose: '10 g',
            notes: null,
            cadence: { kind: 'weekdays', days: [1, 3, 5] },
          },
        ],
      },
    ],
  };
  const cross = diffContent(legacy, modern);
  cross.changed === 1 && cross.added === 0 && cross.removed === 0
    ? ok('a v1 version diffs against a v2 one as a CHANGE, not a replacement')
    : bad('cross-schema diff', JSON.stringify(cross));
  diffLines(cross).some((l) => l.includes('cadence daily → Mon,Wed,Fri'))
    ? ok('…and the cadence change is one of the fields it names')
    : bad('cadence diff line', JSON.stringify(diffLines(cross)));

  // Ids are the primary match; titles are the fallback that makes a diff
  // legible when a document was rewritten without carrying them.
  const byTitle = diffContent(
    one([item('y9', 'Creatine', { dose: '5 g' })]),
    one([item('x1', 'Creatine', { dose: '10 g' })])
  );
  byTitle.changed === 1 && byTitle.added === 0
    ? ok('two documents sharing no ids still match by title rather than reading as a wipe')
    : bad('title fallback', JSON.stringify(byTitle));

  // A phase added is a phase added, and it says so.
  const phased = {
    schema: 2,
    phases: [
      { id: 'p', title: 'Loading', duration_days: 28, items: [item('a', 'Creatine')] },
      { id: 'q', title: 'Maintenance', duration_days: null, items: [item('b', 'Creatine')] },
    ],
  };
  const grew = diffContent(one([item('a', 'Creatine')]), phased);
  diffLines(grew).some((l) => l.includes('Maintenance added'))
    ? ok('adding a second phase reads as a phase added, with its length')
    : bad('phase-add line', JSON.stringify(diffLines(grew)));
}

console.log('10f. restoreVersion is a new version, never a rewrite of history');
{
  const { db, raw } = freshDb();
  const id = createProtocolWithVersion(db, { name: 'Stack', type: 'supplement_stack' }, STACK, 'v1');
  const v1 = getCurrentVersion(db, id);
  addVersion(db, id, { items: [{ title: 'Only one' }] }, 'v2 — trimmed');
  addVersion(db, id, { items: [] }, 'v3 — emptied');

  const restored = restoreVersion(db, id, v1.id);
  typeof restored === 'string' && restored !== v1.id
    ? ok('restore returns a NEW version id, not the old one')
    : bad('restore id', String(restored));
  const count = raw
    .prepare('SELECT count(*) c FROM protocol_versions WHERE protocol_id = ?')
    .get(id).c;
  count === 4
    ? ok('every earlier version is still there — restoring appends, it does not delete')
    : bad('version count', String(count));
  const live = getCurrentVersion(db, id);
  live.version_number === 4 &&
  live.created_by === 'user' &&
  live.change_notes === 'Restored v1' &&
  JSON.stringify(parseProtocolContent(live.content)) ===
    JSON.stringify(parseProtocolContent(v1.content))
    ? ok('the new live version carries v1’s content, authored by the user, note auto-filled')
    : bad('restored content', JSON.stringify(live));
  restoreVersion(db, id, 'not-a-version') === null
    ? ok('restoring a version that is not this protocol’s returns null rather than writing')
    : bad('foreign version restored');
}

console.log('10g. started_on — the phase clock, and what NULL means');
{
  const { db, raw } = freshDb();
  const anchor = (pid) => raw.prepare('SELECT started_on FROM protocols WHERE id = ?').get(pid).started_on;
  const id = createProtocolWithVersion(db, { name: 'Clock', type: 'daily_routine' }, STACK);
  anchor(id) === null
    ? ok('a new protocol is UNANCHORED — there is one place a clock starts, and this is not it')
    : bad('created anchored', String(anchor(id)));

  ensureStartedOn(db, '2026-08-01');
  anchor(id) === '2026-08-01'
    ? ok('the first mission generation anchors it to that day')
    : bad('ensureStartedOn did nothing', String(anchor(id)));
  ensureStartedOn(db, '2026-09-01');
  anchor(id) === '2026-08-01'
    ? ok('…and never moves an anchor that already exists')
    : bad('anchor moved', String(anchor(id)));

  setActive(db, id, false, '2026-09-01');
  setActive(db, id, true, '2026-09-01');
  anchor(id) === '2026-08-01'
    ? ok('pausing and resuming does NOT restart a titration the user is weeks into')
    : bad('resume restarted the clock', String(anchor(id)));

  const paused = createProtocol(db, { name: 'Paused', type: 'daily_routine' });
  setActive(db, paused, false);
  ensureStartedOn(db, '2026-09-02');
  anchor(paused) === null
    ? ok('a paused protocol is not anchored by a generation it takes no part in')
    : bad('paused protocol anchored', String(anchor(paused)));
  setActive(db, paused, true, '2026-09-03');
  anchor(paused) === '2026-09-03'
    ? ok('…and resuming an UNANCHORED protocol starts its clock that day')
    : bad('resume did not anchor', String(anchor(paused)));

  setStartedOn(db, id, '2026-07-01');
  listProtocols(db).find((p) => p.id === id).startedOn === '2026-07-01'
    ? ok('the editor can move the clock, and the hub reads it back')
    : bad('setStartedOn', String(anchor(id)));
}

console.log('11. createProtocolWithVersion is one atomic create');
{
  const { db, raw } = freshDb();
  const pid = createProtocolWithVersion(
    db,
    { name: 'Evening Wind-down', type: 'sleep_protocol', description: 'Screens off' },
    STACK,
    'Initial version'
  );
  const p = raw.prepare('SELECT * FROM protocols WHERE id = ?').get(pid);
  const v = getCurrentVersion(db, pid);
  p &&
  v &&
  p.current_version_id === v.id &&
  v.version_number === 1 &&
  v.change_notes === 'Initial version'
    ? ok('protocol + v1 + live pointer land together')
    : bad('atomic create', JSON.stringify({ p, v }));
  throws(() =>
    createProtocolWithVersion(db, { name: 'Broken', type: 'other' }, STACK, null, 'robot')
  )
    ? ok('a bad created_by makes the whole create throw')
    : bad('bad created_by accepted');
  raw.prepare("SELECT count(*) c FROM protocols WHERE name = 'Broken'").get().c === 0
    ? ok('…and the protocol row rolled back with it — no orphan to duplicate on retry')
    : bad('orphan protocol left behind');
}

console.log(
  '12. saveProtocolEdit is one transaction, and the Coach’s shape of it mints no version'
);
{
  const { db, raw } = freshDb();
  const pid = createProtocolWithVersion(
    db,
    { name: 'Morning Stack', type: 'supplement_stack', description: 'with food' },
    STACK
  );
  const row = () => raw.prepare('SELECT * FROM protocols WHERE id = ?').get(pid);
  const versions = () =>
    raw.prepare('SELECT count(*) c FROM protocol_versions WHERE protocol_id = ?').get(pid).c;
  const live = () => parseProtocolContent(getCurrentVersion(db, pid).content);

  // THE COACH'S SHAPE (the protocols domain's `edit_record`, write-domains.ts):
  // the live document as both base and content, the row fields as opened, and
  // only the patched ones changed. The screen's function, so the screen's
  // rules: the changed columns, no version, and never `is_active`.
  const opened = protocolFieldsOf(getProtocol(db, pid));
  const coach = saveProtocolEdit(db, pid, {
    base: live(),
    content: live(),
    changeNotes: null,
    opened,
    fields: { ...opened, name: 'AM Stack', checkoffMode: 'adjusting' },
  });
  const after = row();
  coach.ok &&
  coach.versionId === null &&
  versions() === 1 &&
  JSON.stringify([...coach.wrote].sort()) === JSON.stringify(['checkoffMode', 'name']) &&
  after.name === 'AM Stack' &&
  after.checkoff_mode === 'adjusting' &&
  after.description === 'with food' &&
  after.type === 'supplement_stack' &&
  after.is_active === 1
    ? ok('a rename + policy change with the live document as base writes two columns, no version')
    : bad('coach-shaped save', JSON.stringify({ coach, after }));

  // ONE TRANSACTION: a version write that fails takes the rename with it. The
  // failure is forced with a trigger, since the repository never builds a
  // version row SQLite would refuse on its own.
  raw.exec(
    "CREATE TRIGGER boom BEFORE INSERT ON protocol_versions BEGIN SELECT RAISE(ABORT, 'boom'); END;"
  );
  const reopened = protocolFieldsOf(getProtocol(db, pid));
  throws(() =>
    saveProtocolEdit(db, pid, {
      base: live(),
      content: { ...live(), phases: [{ ...live().phases[0], items: [live().phases[0].items[0]] }] },
      changeNotes: 'Trimmed to creatine only',
      opened: reopened,
      fields: { ...reopened, name: 'Half-saved' },
    })
  )
    ? ok('a failing version write makes the whole save throw')
    : bad('a failed version write was swallowed');
  row().name === 'AM Stack' && versions() === 1
    ? ok('…and the rename rolled back with it — no partial save')
    : bad('partial save persisted', JSON.stringify(row()));
  raw.exec('DROP TRIGGER boom');
}

console.log('12b. the one editor: an untouched form IS the live version, and a save writes only what changed');
{
  const { db, raw } = freshDb();
  const item = (id, title, dose, cadence = { kind: 'daily' }, extra = {}) => ({
    id,
    title,
    scheduled_time: '07:30',
    dose,
    notes: null,
    cadence,
    remind: false,
    ...extra,
  });
  const document = (items) =>
    normalizeContent({ phases: [{ id: 'only', title: null, duration_days: null, items }] });
  const before = document([item('a', 'Creatine', '5 g'), item('b', 'Omega-3', '2 caps')]);
  let key = 0;
  const nextKey = () => ++key;

  // THE RULE the Save button rests on: a form seeded from a document and left
  // alone builds that document byte for byte, so Save is inert at rest and
  // opening the form writes nothing. Pinned on the shapes that could drift: a
  // why-line, a reminder, a titration with an empty phase, and a v1 document
  // with derived ids.
  const rich = normalizeContent({
    phases: [
      {
        id: 'load',
        title: 'Loading',
        duration_days: 7,
        items: [item('c', 'Creatine', '20 g', { kind: 'weekdays', days: [1, 3, 5] }, { notes: 'Saturate first.', remind: true })],
      },
      { id: 'gap', title: null, duration_days: 3, items: [] },
      { id: 'hold', title: 'Hold', duration_days: null, items: [item('d', 'Walk', null, { kind: 'quota', per_week: 3 }, { scheduled_time: null })] },
    ],
  });
  const legacy = parseProtocolContent(JSON.stringify(STACK));
  [before, rich, legacy].every(
    (doc) => JSON.stringify(buildContent(seedPhases(doc, nextKey))) === JSON.stringify(doc)
  )
    ? ok('an untouched form builds the live document byte for byte (why-line, reminder, empty phase, v1)')
    : bad('seed → build drifted', JSON.stringify(buildContent(seedPhases(rich, nextKey))));

  // The same dose change made in the form and made on the document are one
  // document — the byte-identity rule the per-item editor was pinned to, kept
  // for the form that replaced it.
  const form = seedPhases(before, nextKey);
  form[0].items[0].dose = '10 g';
  const viaForm = buildContent(form);
  const direct = document([item('a', 'Creatine', '10 g'), item('b', 'Omega-3', '2 caps')]);
  JSON.stringify(viaForm) === JSON.stringify(direct)
    ? ok('a dose change made in the form is the same document as the change made directly')
    : bad('form document drifted', JSON.stringify(viaForm));
  viaForm.phases[0].items.map((it) => it.id).join() === 'a,b'
    ? ok('…and the edited item keeps its id and its place')
    : bad('form reordered', JSON.stringify(viaForm.phases[0].items.map((i) => i.id)));

  // A blank NEW row is not an item yet and is not written.
  const withBlank = seedPhases(before, nextKey);
  withBlank[0].items.push(blankItem(nextKey(), 'fresh'));
  JSON.stringify(buildContent(withBlank)) === JSON.stringify(before)
    ? ok('a blank row the form added is left out of the document')
    : bad('a blank row was written');
  parseDays('28') === 28 && parseDays('') === null && parseDays('0') === null && parseDays('2.5') === null
    ? ok('a phase length is a whole number of days ≥ 1, or nothing')
    : bad('parseDays');

  // A PHASE MOVE keeps the item: its id, its key and every field. It used to
  // mean removing it and adding it again, which minted a new id — so the diff
  // read "removed / added" and the quota counter lost its history.
  const phasedForm = seedPhases(rich, nextKey);
  const creatine = phasedForm[0].items[0];
  const movedForm = moveToPhase(phasedForm, creatine.key, phasedForm[2].key);
  const landed = movedForm[2].items[movedForm[2].items.length - 1];
  movedForm[0].items.length === 0 &&
  landed === creatine &&
  buildContent(movedForm).phases[2].items.map((it) => it.id).join() === 'd,c'
    ? ok('moving an item between phases keeps its id and fields, at the end of the target')
    : bad('phase move', JSON.stringify(buildContent(movedForm).phases.map((p) => p.items.map((i) => i.id))));
  moveToPhase(movedForm, creatine.key, movedForm[2].key) === movedForm
    ? ok('…and moving it to the phase it is already in changes nothing')
    : bad('a no-op move rebuilt the form');

  // --- the save, against real SQLite --------------------------------------
  const pid = createProtocolWithVersion(
    db,
    {
      name: 'Morning Stack',
      type: 'supplement_stack',
      description: 'The one that matters',
      startedOn: TODAY,
      carryOver: true,
      checkoffMode: 'adjusting',
    },
    before
  );
  const identity = () =>
    raw
      .prepare(
        `SELECT name, type, description, is_active, started_on, carry_over, checkoff_mode
           FROM protocols WHERE id = ?`
      )
      .get(pid);
  const versions = () =>
    raw.prepare('SELECT count(*) c FROM protocol_versions WHERE protocol_id = ?').get(pid).c;
  const opened = () => protocolFieldsOf(getProtocol(db, pid));
  const liveDoc = () => parseProtocolContent(getCurrentVersion(db, pid).content);
  const identityBefore = JSON.stringify(identity());

  // Nothing changed: nothing written, not even a no-op version.
  const idle = saveProtocolEdit(db, pid, {
    base: before,
    content: before,
    changeNotes: null,
    opened: opened(),
    fields: opened(),
  });
  idle.ok && idle.versionId === null && idle.wrote.length === 0 && versions() === 1
    ? ok('a save with nothing changed writes no version and no column')
    : bad('idle save wrote', JSON.stringify(idle));

  // A document-only save: a version, and every row column byte-identical.
  const docOnly = saveProtocolEdit(db, pid, {
    base: before,
    content: direct,
    changeNotes: null,
    opened: opened(),
    fields: opened(),
  });
  docOnly.ok && docOnly.versionId !== null && versions() === 2
    ? ok('a document change writes one version')
    : bad('document save', JSON.stringify(docOnly));
  JSON.stringify(identity()) === identityBefore
    ? ok('…and leaves every identity and policy column byte-identical')
    : bad('identity moved', `${identityBefore} → ${JSON.stringify(identity())}`);

  // A typed note is user data: it forces a version even over an unchanged plan.
  const noted = saveProtocolEdit(db, pid, {
    base: direct,
    content: direct,
    changeNotes: '  Held at 10 g for a month  ',
    opened: opened(),
    fields: opened(),
  });
  noted.ok &&
  noted.versionId !== null &&
  getCurrentVersion(db, pid).change_notes === 'Held at 10 g for a month'
    ? ok('a typed note alone writes a version, trimmed')
    : bad('note-only save', JSON.stringify(noted));

  // A settings-only save: the columns it changed, and NO version.
  const versionsBefore = versions();
  const renamed = saveProtocolEdit(db, pid, {
    base: direct,
    content: direct,
    changeNotes: null,
    opened: opened(),
    fields: { ...opened(), name: 'AM Stack', carryOver: false },
  });
  renamed.ok &&
  renamed.versionId === null &&
  versions() === versionsBefore &&
  JSON.stringify([...renamed.wrote].sort()) === JSON.stringify(['carryOver', 'name']) &&
  identity().name === 'AM Stack' &&
  identity().carry_over === 0 &&
  identity().checkoff_mode === 'adjusting'
    ? ok('a settings-only save writes the two changed columns and mints no version')
    : bad('settings save', JSON.stringify({ renamed, row: identity() }));

  // PAUSE IS NOT A FIELD OF THE FORM: a pause made while the form is open (on
  // the page, or approved on the Coach tab) survives the form's save.
  const openedBeforePause = opened();
  setActive(db, pid, false);
  const afterPause = saveProtocolEdit(db, pid, {
    base: direct,
    content: direct,
    changeNotes: null,
    opened: openedBeforePause,
    fields: { ...openedBeforePause, description: 'Morning, with food' },
  });
  afterPause.ok && identity().is_active === 0 && identity().description === 'Morning, with food'
    ? ok('a settings save never flips is_active back from the value it opened with')
    : bad('the form un-paused the protocol', JSON.stringify(identity()));
  setActive(db, pid, true);

  // A STALE save that does not collide: the Coach added magnesium while the
  // form changed the creatine dose. Both land; nothing is reverted.
  const base = liveDoc();
  addVersion(
    db,
    pid,
    document([item('a', 'Creatine', '10 g'), item('b', 'Omega-3', '2 caps'), item('m', 'Magnesium', '400 mg')]),
    'Added magnesium',
    'ai'
  );
  const merged = saveProtocolEdit(db, pid, {
    base,
    content: document([item('a', 'Creatine', '15 g'), item('b', 'Omega-3', '2 caps')]),
    changeNotes: null,
    opened: opened(),
    fields: opened(),
  });
  const afterMerge = liveDoc().phases[0].items;
  merged.ok &&
  afterMerge.map((it) => `${it.id}:${it.dose}`).join() === 'a:15 g,b:2 caps,m:400 mg'
    ? ok('a save built before a Coach version keeps the Coach’s change and applies its own')
    : bad('stale merge', JSON.stringify({ merged, afterMerge }));

  // A STALE save that DOES collide: both changed the creatine dose. Refused,
  // named, and nothing at all is written — not the version, not the rename.
  const stale = liveDoc();
  addVersion(
    db,
    pid,
    document([item('a', 'Creatine', '20 g'), item('b', 'Omega-3', '2 caps'), item('m', 'Magnesium', '400 mg')]),
    'Loading again',
    'ai'
  );
  const countBefore = versions();
  const rowBefore = JSON.stringify(identity());
  const refused = saveProtocolEdit(db, pid, {
    base: stale,
    content: document([item('a', 'Creatine', '5 g'), item('b', 'Omega-3', '2 caps'), item('m', 'Magnesium', '400 mg')]),
    changeNotes: 'back to 5',
    opened: opened(),
    fields: { ...opened(), name: 'Renamed in the same save' },
  });
  !refused.ok && /"Creatine" was changed elsewhere/.test(refused.refusal)
    ? ok(`a save that collides with a newer version refuses, naming the item ("${refused.refusal}")`)
    : bad('collision not refused', JSON.stringify(refused));
  versions() === countBefore && JSON.stringify(identity()) === rowBefore
    ? ok('…and writes nothing — no version and no column')
    : bad('a refused save wrote something', JSON.stringify(identity()));

  // A phase move made from the form keeps the item's id in the saved version.
  const phasedId = createProtocolWithVersion(
    db,
    { name: 'Titration', type: 'supplement_stack', startedOn: TODAY },
    rich
  );
  const titrationForm = seedPhases(rich, nextKey);
  const moving = titrationForm[0].items[0];
  const saved = saveProtocolEdit(db, phasedId, {
    base: rich,
    content: buildContent(moveToPhase(titrationForm, moving.key, titrationForm[2].key)),
    changeNotes: null,
    opened: protocolFieldsOf(getProtocol(db, phasedId)),
    fields: protocolFieldsOf(getProtocol(db, phasedId)),
  });
  const savedPhases = parseProtocolContent(getCurrentVersion(db, phasedId).content).phases;
  saved.ok &&
  savedPhases[0].items.length === 0 &&
  savedPhases[2].items.some((it) => it.id === 'c' && it.dose === '20 g')
    ? ok('a phase move saved from the form keeps the item’s id in the new version')
    : bad('phase move lost its id', JSON.stringify(savedPhases));

  // A version-LESS protocol reads as one empty open-ended phase, so an item
  // added from *Add an item* writes v1 — exactly as the Coach's tool would.
  const bare = createProtocol(db, { name: 'Bare', type: 'other' });
  const emptyForm = seedPhases(parseProtocolContent(null), nextKey);
  emptyForm[0].items.push({ ...blankItem(nextKey(), 'walk'), title: 'Walk' });
  const firstSave = saveProtocolEdit(db, bare, {
    base: parseProtocolContent(null),
    content: buildContent(emptyForm),
    changeNotes: null,
    opened: protocolFieldsOf(getProtocol(db, bare)),
    fields: protocolFieldsOf(getProtocol(db, bare)),
  });
  const firstVersion = getCurrentVersion(db, bare);
  firstSave.ok &&
  firstVersion.version_number === 1 &&
  allItems(parseProtocolContent(firstVersion.content)).length === 1
    ? ok('adding an item to a version-less protocol writes v1 with one item')
    : bad('version-less add', JSON.stringify(firstVersion));

  // A protocol deleted while the form was open refuses rather than throwing.
  deleteProtocol(db, bare);
  const gone = saveProtocolEdit(db, bare, {
    base: parseProtocolContent(null),
    content: buildContent(emptyForm),
    changeNotes: null,
    opened: protocolFieldsOf({ ...getProtocol(db, pid) }),
    fields: protocolFieldsOf({ ...getProtocol(db, pid) }),
  });
  !gone.ok && gone.refusal === 'This protocol no longer exists.'
    ? ok('a save on a protocol deleted meanwhile refuses in one sentence')
    : bad('deleted-protocol save', JSON.stringify(gone));
}

console.log('12c. the save’s merge: one side’s change wins, agreement wins, a collision refuses');
{
  const it = (id, title, extra = {}) => ({
    id,
    title,
    scheduled_time: null,
    dose: null,
    notes: null,
    cadence: { kind: 'daily' },
    remind: false,
    ...extra,
  });
  const doc = (...phases) =>
    normalizeContent({
      phases: phases.map(([id, items, extra = {}]) => ({ id, title: null, duration_days: null, ...extra, items })),
    });
  const ids = (content) => content.phases.map((p) => p.items.map((i) => i.id).join(',')).join(' | ');
  const base = doc(['p', [it('a', 'A'), it('b', 'B'), it('c', 'C')]]);

  const quiet = rebaseContent(base, doc(['p', [it('a', 'A', { dose: '1' }), it('b', 'B'), it('c', 'C')]]), base);
  quiet.ok && quiet.content.phases[0].items[0].dose === '1'
    ? ok('nothing moved elsewhere: the form’s document is written as it stands')
    : bad('quiet', JSON.stringify(quiet));

  const theirs = doc(['p', [it('a', 'A'), it('b', 'B', { dose: '2' }), it('c', 'C')]]);
  const untouched = rebaseContent(base, base, theirs);
  untouched.ok && JSON.stringify(untouched.content) === JSON.stringify(theirs)
    ? ok('the form changed nothing: the live document stands')
    : bad('untouched', JSON.stringify(untouched));

  // Different items, different sides: both land.
  const both = rebaseContent(
    base,
    doc(['p', [it('a', 'A', { dose: '1' }), it('b', 'B'), it('c', 'C')]]),
    theirs
  );
  both.ok &&
  both.content.phases[0].items[0].dose === '1' &&
  both.content.phases[0].items[1].dose === '2'
    ? ok('a change here and a change there to different items both land')
    : bad('both', JSON.stringify(both));

  // The SAME field of one item changed two ways is a guess — refused, named.
  const clash = rebaseContent(
    base,
    doc(['p', [it('a', 'A', { dose: '1' }), it('b', 'B'), it('c', 'C')]]),
    doc(['p', [it('a', 'A', { dose: '9' }), it('b', 'B'), it('c', 'C')]])
  );
  !clash.ok && clash.refusal === '"A" was changed elsewhere while this form was open.'
    ? ok('the same field of one item changed two ways refuses, naming the item')
    : bad('clash', JSON.stringify(clash));
  // …while two DIFFERENT fields of one item are two facts, and both land.
  const twoFields = rebaseContent(
    base,
    doc(['p', [it('a', 'A', { dose: '1' }), it('b', 'B'), it('c', 'C')]]),
    doc(['p', [it('a', 'A', { notes: 'Why it is here' }), it('b', 'B'), it('c', 'C')]])
  );
  twoFields.ok &&
  twoFields.content.phases[0].items[0].dose === '1' &&
  twoFields.content.phases[0].items[0].notes === 'Why it is here'
    ? ok('a dose changed here and a why-line changed there on the same item both land')
    : bad('two fields', JSON.stringify(twoFields));
  // A reminder is meaningless without a time: kept on here, time cleared
  // there — the merged item cannot store the reminder.
  const remindBase = doc(['p', [it('r', 'R', { scheduled_time: '07:00' })]]);
  const remindMerge = rebaseContent(
    remindBase,
    doc(['p', [it('r', 'R', { scheduled_time: '07:00', remind: true })]]),
    doc(['p', [it('r', 'R', { scheduled_time: null })]])
  );
  remindMerge.ok &&
  remindMerge.content.phases[0].items[0].scheduled_time === null &&
  remindMerge.content.phases[0].items[0].remind === false
    ? ok('a reminder turned on here over a time cleared there is not stored')
    : bad('remind merge', JSON.stringify(remindMerge));
  const agreed = rebaseContent(
    base,
    doc(['p', [it('a', 'A', { dose: '1' }), it('b', 'B'), it('c', 'C')]]),
    doc(['p', [it('a', 'A', { dose: '1' }), it('b', 'B', { dose: '2' }), it('c', 'C')]])
  );
  agreed.ok && agreed.content.phases[0].items[1].dose === '2'
    ? ok('…while the same change made on both sides is no conflict')
    : bad('agreement', JSON.stringify(agreed));

  // Removal against an edit, in both directions.
  const removedHere = rebaseContent(base, doc(['p', [it('a', 'A'), it('c', 'C')]]), theirs);
  !removedHere.ok && /"B" was changed elsewhere while this form removed it/.test(removedHere.refusal)
    ? ok('removing an item someone else just changed refuses')
    : bad('remove vs edit', JSON.stringify(removedHere));
  const removedThere = rebaseContent(
    base,
    doc(['p', [it('a', 'A'), it('b', 'B', { dose: '5' }), it('c', 'C')]]),
    doc(['p', [it('a', 'A'), it('c', 'C')]])
  );
  !removedThere.ok && removedThere.refusal === '"B" is not in the live version any more.'
    ? ok('editing an item someone else removed refuses — the edit would resurrect it')
    : bad('edit vs remove', JSON.stringify(removedThere));
  const cleanRemove = rebaseContent(base, doc(['p', [it('a', 'A'), it('c', 'C')]]), doc(['p', [it('a', 'A', { dose: '3' }), it('b', 'B'), it('c', 'C')]]));
  cleanRemove.ok && ids(cleanRemove.content) === 'a,c' && cleanRemove.content.phases[0].items[0].dose === '3'
    ? ok('removing an item nobody else touched lands beside their change')
    : bad('clean remove', JSON.stringify(cleanRemove));

  // Additions on both sides: each lands where its own side put it.
  const addBoth = rebaseContent(
    base,
    doc(['p', [it('a', 'A'), it('n', 'New here'), it('b', 'B'), it('c', 'C')]]),
    doc(['p', [it('a', 'A'), it('b', 'B'), it('c', 'C'), it('z', 'New there')]])
  );
  addBoth.ok && ids(addBoth.content) === 'a,n,b,c,z'
    ? ok('an item added here and one added there both land, each after its own predecessor')
    : bad('add both', JSON.stringify(addBoth.ok ? ids(addBoth.content) : addBoth));

  // Re-ordering here, adding there.
  const reorder = rebaseContent(
    base,
    doc(['p', [it('c', 'C'), it('a', 'A'), it('b', 'B')]]),
    doc(['p', [it('a', 'A'), it('b', 'B'), it('c', 'C'), it('z', 'Z')]])
  );
  reorder.ok && ids(reorder.content) === 'c,z,a,b'
    ? ok('a re-order here keeps its order, and an item added there follows its predecessor')
    : bad('reorder + add', JSON.stringify(reorder.ok ? ids(reorder.content) : reorder));
  const twoOrders = rebaseContent(
    base,
    doc(['p', [it('c', 'C'), it('a', 'A'), it('b', 'B')]]),
    doc(['p', [it('b', 'B'), it('a', 'A'), it('c', 'C')]])
  );
  !twoOrders.ok && /order of the items/.test(twoOrders.refusal)
    ? ok('two different re-orderings of one phase refuse')
    : bad('two orders', JSON.stringify(twoOrders));

  // Phases. A phase added here while an item changed there: both land.
  const phasedBase = doc(['p1', [it('a', 'A'), it('b', 'B')], { duration_days: 7 }], ['p2', [it('c', 'C')]]);
  const addPhase = rebaseContent(
    phasedBase,
    doc(['p1', [it('a', 'A'), it('b', 'B')], { duration_days: 7 }], ['p2', [it('c', 'C')], { duration_days: 14 }], ['p3', [it('d', 'D')]]),
    doc(['p1', [it('a', 'A', { dose: '4' }), it('b', 'B')], { duration_days: 7 }], ['p2', [it('c', 'C')]])
  );
  addPhase.ok &&
  addPhase.content.phases.length === 3 &&
  addPhase.content.phases[0].items[0].dose === '4'
    ? ok('a phase added here and an item changed there both land')
    : bad('add phase', JSON.stringify(addPhase));
  const twoFrames = rebaseContent(
    phasedBase,
    doc(['p1', [it('a', 'A'), it('b', 'B')], { duration_days: 10 }], ['p2', [it('c', 'C')]]),
    doc(['p1', [it('a', 'A'), it('b', 'B')], { duration_days: 21 }], ['p2', [it('c', 'C')]])
  );
  !twoFrames.ok && twoFrames.refusal === 'The phases were changed elsewhere while this form was open.'
    ? ok('two different re-shapings of the phases refuse')
    : bad('two frames', JSON.stringify(twoFrames));
  const orphan = rebaseContent(
    phasedBase,
    doc(['p1', [it('a', 'A'), it('b', 'B'), it('c', 'C')]]),
    doc(['p1', [it('a', 'A'), it('b', 'B')], { duration_days: 7 }], ['p2', [it('c', 'C'), it('e', 'E')]])
  );
  !orphan.ok && orphan.refusal === '"E" belongs to a phase that is no longer there.'
    ? ok('an item added to a phase this form removed refuses, naming it')
    : bad('orphan', JSON.stringify(orphan));

  // A phase MOVE here and a dose change there are two facts of one item.
  const moveAndDose = rebaseContent(
    phasedBase,
    doc(['p1', [it('a', 'A')], { duration_days: 7 }], ['p2', [it('c', 'C'), it('b', 'B')]]),
    doc(['p1', [it('a', 'A'), it('b', 'B', { dose: '8' })], { duration_days: 7 }], ['p2', [it('c', 'C')]])
  );
  moveAndDose.ok && ids(moveAndDose.content) === 'a | c,b' && moveAndDose.content.phases[1].items[1].dose === '8'
    ? ok('an item moved to another phase here keeps a dose changed there')
    : bad('move and dose', JSON.stringify(moveAndDose.ok ? ids(moveAndDose.content) : moveAndDose));

  // Every result passes the gate the Coach's tool passes, even when nothing
  // moved elsewhere and the form's own document is the whole answer.
  const invalid = rebaseContent(
    phasedBase,
    doc(['p1', [it('a', 'A'), it('b', 'B')]], ['p2', [it('c', 'C')]]),
    phasedBase
  );
  !invalid.ok && /Phase 1 has no length/.test(invalid.refusal)
    ? ok(`a document that breaks the phase rule is refused ("${invalid.refusal.slice(0, 40)}…")`)
    : bad('an invalid document was accepted', JSON.stringify(invalid));
  // …but a save that leaves the document alone is never refused over it: a
  // rename of a protocol whose STORED document breaks the rule (a hand-edited
  // export) writes the rename and none of the document.
  const storedBad = doc(['p1', [it('a', 'A')]], ['p2', [it('c', 'C')]]);
  const untouchedBad = rebaseContent(storedBad, storedBad, storedBad);
  untouchedBad.ok && JSON.stringify(untouchedBad.content) === JSON.stringify(storedBad)
    ? ok('a document this form did not touch is passed through, not re-judged')
    : bad('untouched stored document refused', JSON.stringify(untouchedBad));

  // Row fields: only what the form changed, onto the row as it is now.
  const f = {
    name: 'Stack',
    description: null,
    type: 'supplement_stack',
    startedOn: '2026-09-01',
    carryOver: false,
    checkoffMode: 'strict',
  };
  const renamedThere = { ...f, name: 'Evening stack' };
  const patch = fieldPatch(f, { ...f, carryOver: true }, renamedThere);
  patch.ok && JSON.stringify(patch.patch) === JSON.stringify({ carryOver: true })
    ? ok('a policy change here writes that one field, and a rename made there survives it')
    : bad('field patch', JSON.stringify(patch));
  const fieldClash = fieldPatch(f, { ...f, name: 'Morning stack' }, renamedThere);
  !fieldClash.ok && fieldClash.refusal === 'The name was changed elsewhere while this form was open.'
    ? ok('the same field changed on both sides refuses, naming it')
    : bad('field clash', JSON.stringify(fieldClash));
}

console.log('13. listVersions: newest first, item counts, honest nulls');
{
  const { db, raw } = freshDb();

  // Zero versions — and an id that was never a protocol at all.
  const bare = createProtocol(db, { name: 'No versions yet', type: 'other' });
  const none = listVersions(db, bare);
  Array.isArray(none) && none.length === 0
    ? ok('a protocol with no versions lists as []')
    : bad('empty history', JSON.stringify(none));
  listVersions(db, 'no-such-protocol').length === 0
    ? ok('an unknown protocol id lists as [] rather than throwing')
    : bad('unknown id');

  // One version — every field of the view type, and no content blob on it.
  const solo = createProtocolWithVersion(
    db,
    { name: 'Solo', type: 'supplement_stack' },
    STACK,
    'Initial stack'
  );
  const one = listVersions(db, solo);
  one.length === 1 ? ok('one saved version lists one row') : bad('one-version length', one.length);
  const v1 = one[0];
  v1 &&
  v1.id === getCurrentVersion(db, solo).id &&
  v1.versionNumber === 1 &&
  v1.changeNotes === 'Initial stack' &&
  v1.createdBy === 'user' &&
  typeof v1.createdAt === 'string' &&
  v1.itemCount === 2
    ? ok('row carries id, version number, notes, authorship, stamp and item count')
    : bad('one-version row', JSON.stringify(v1));
  // The blob USED to be withheld here, on the argument that the history screen
  // reads the shape of each version and never its contents. That stopped being
  // true when the screen gained a diff between adjacent versions — which is
  // the whole payoff of keeping history — so it crosses now, once, already
  // normalised into phases.
  v1 && v1.content?.schema === 2 && v1.phaseCount === 1
    ? ok('each row carries its own parsed content, for the diff the screen draws')
    : bad('content missing', JSON.stringify(v1));

  // Many versions, newest first — and the count tracks each version's OWN
  // content, not the live one's.
  const many = createProtocolWithVersion(db, { name: 'Many', type: 'daily_routine' }, STACK, 'v1');
  addVersion(db, many, { items: [STACK.items[0]] }, 'v2 — trimmed');
  addVersion(db, many, { items: [] }, 'v3 — emptied', 'ai');
  const list = listVersions(db, many);
  JSON.stringify(list.map((v) => v.versionNumber)) === JSON.stringify([3, 2, 1])
    ? ok('versions come back newest first')
    : bad('order', JSON.stringify(list.map((v) => v.versionNumber)));
  JSON.stringify(list.map((v) => v.itemCount)) === JSON.stringify([0, 1, 2])
    ? ok('each row counts its own snapshot, not the live version')
    : bad('per-version counts', JSON.stringify(list.map((v) => v.itemCount)));
  list[0] && list[0].createdBy === 'ai' && list[2] && list[2].createdBy === 'user'
    ? ok("authorship is per-version ('ai' on the Coach's, 'user' on yours)")
    : bad('authorship', JSON.stringify(list.map((v) => v.createdBy)));
  list.every((v) => v.id) && new Set(list.map((v) => v.id)).size === 3
    ? ok('every row carries its own version id')
    : bad('ids', JSON.stringify(list.map((v) => v.id)));

  // A version whose content has no items array at all. json_array_length
  // returns NULL there, and NULL must survive the mapping — an absent count is
  // not a count of none, and the screen draws the difference.
  const foreign = createProtocol(db, { name: 'Foreign shape', type: 'other' });
  raw
    .prepare(
      'INSERT INTO protocol_versions (id, protocol_id, version_number, content) VALUES (\'fv1\', ?, 1, \'{"note":"no items key"}\')'
    )
    .run(foreign);
  const noItems = listVersions(db, foreign);
  noItems.length === 1 && noItems[0].itemCount === null
    ? ok('content with no items array yields null, not a fabricated 0')
    : bad('missing items array', JSON.stringify(noItems));
  const emptyArray = createProtocolWithVersion(db, { name: 'Empty', type: 'other' }, { items: [] });
  listVersions(db, emptyArray)[0].itemCount === 0
    ? ok('…while a genuinely empty items array really is 0 — the two stay distinguishable')
    : bad('empty items array', JSON.stringify(listVersions(db, emptyArray)));

  // The history is scoped to its own protocol.
  listVersions(db, solo).length === 1 && listVersions(db, many).length === 3
    ? ok('each protocol sees only its own versions')
    : bad('scoping');
}

console.log('14. the time wheel’s write contract — HH:MM in, HH:MM out');
{
  // The owner, 2026-09-21: "needs a real wheel like a calendar app". The iOS
  // wheel speaks Date; scheduled_time is HH:MM text and the reminder scheduler
  // compares two of them as strings. src/lib/protocols/clock-time.ts converts on
  // both sides, and THIS is where that conversion is held — the wheel is a
  // native view and cannot render under node (the render suite asserts the
  // fallback instead).
  const hhmm = (t) =>
    `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  const at = (h, m, s = 0) => new Date(2000, 0, 1, h, m, s, 0);
  const clockOf = (d) => hhmm(d.getHours() * 60 + d.getMinutes());

  // The parser moved from form-controls.tsx; its behaviour did not change.
  normalizeTime('8:05') === '08:05' &&
  normalizeTime(' 21:30 ') === '21:30' &&
  normalizeTime('24:00') === null &&
  normalizeTime('07:60') === null &&
  normalizeTime('7.30') === null &&
  normalizeTime('') === null
    ? ok('normalizeTime is unchanged by the move into clock-time.ts')
    : bad('normalizeTime');

  // The step is one constant: the picker's minuteInterval and the snap read it.
  MINUTE_STEP === 5 ? ok('the wheel steps in 5 minutes, spelled once') : bad('MINUTE_STEP');

  // HH:MM -> Date: the stored wall-clock time, exactly.
  const opened = timeToDate('21:35');
  opened.getHours() === 21 &&
  opened.getMinutes() === 35 &&
  opened.getSeconds() === 0 &&
  opened.getMilliseconds() === 0
    ? ok('timeToDate opens the wheel on the stored time, to the minute')
    : bad('timeToDate', opened.toString());
  // An off-grid stored value is NOT snapped on read — opening the editor must
  // never retime an item the owner did not touch.
  timeToDate('07:37').getMinutes() === 37
    ? ok('an off-grid stored minute is passed through, not rewritten on open')
    : bad('read snapped', timeToDate('07:37').toString());
  // Pure: the same input is the same instant, so the native view is not handed
  // a fresh value on every render.
  timeToDate('09:10').getTime() === timeToDate('09:10').getTime()
    ? ok('timeToDate is pure — same string, same instant')
    : bad('timeToDate impure');
  // No time parks the wheel; the park is not a value.
  clockOf(timeToDate(NO_TIME)) === PARKED_TIME && clockOf(timeToDate('not a time')) === PARKED_TIME
    ? ok(`an untimed item parks the wheel at ${PARKED_TIME}`)
    : bad('park', clockOf(timeToDate(NO_TIME)));

  // Date -> HH:MM, snapped to the step, never outside the day.
  dateToTime(at(7, 35)) === '07:35' &&
  dateToTime(at(7, 37)) === '07:35' &&
  dateToTime(at(7, 38)) === '07:40' &&
  dateToTime(at(0, 0)) === '00:00' &&
  dateToTime(at(12, 2)) === '12:00' &&
  dateToTime(at(9, 45, 59)) === '09:45'
    ? ok('dateToTime snaps to the nearest 5 minutes and ignores seconds')
    : bad(
        'snap',
        [at(7, 37), at(7, 38), at(12, 2), at(9, 45, 59)].map((d) => dateToTime(d)).join(' ')
      );
  dateToTime(at(23, 58)) === '00:00' && dateToTime(at(23, 57)) === '23:55'
    ? ok('23:58 wraps to 00:00 — never the impossible 24:00')
    : bad('midnight wrap', `${dateToTime(at(23, 58))} ${dateToTime(at(23, 57))}`);
  dateToTime(at(7, 37), 1) === '07:37'
    ? ok('a step of 1 is no snap at all')
    : bad('step 1', dateToTime(at(7, 37), 1));
  dateToTime(new Date(Number.NaN)) === null
    ? ok('an invalid Date is null — the caller writes NOTHING, not "NaN:NaN" or a guess')
    : bad('invalid date', dateToTime(new Date(Number.NaN)));

  // The round trip, over the whole day, in several zones. The Date is pinned to
  // 2000-01-01 because that day has no DST transition in any zone — a local
  // time that does not exist would come back an hour off. Every on-grid minute
  // must survive at MINUTE_STEP, and every minute at all at step 1.
  const zones = [
    process.env.TZ, // whatever this machine is
    'America/New_York',
    'Europe/London',
    'Australia/Lord_Howe', // a 30-minute DST shift
    'America/Sao_Paulo', // southern-hemisphere summer time in 2000
    'Asia/Kolkata', // a half-hour offset
    'Pacific/Chatham', // a 45-minute offset
  ];
  const tzBefore = process.env.TZ;
  const broken = [];
  for (const zone of zones) {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
    for (let t = 0; t < 24 * 60; t++) {
      const time = hhmm(t);
      if (t % MINUTE_STEP === 0 && dateToTime(timeToDate(time)) !== time) {
        broken.push(`${zone ?? 'local'} ${time}`);
      }
      if (dateToTime(timeToDate(time), 1) !== time) broken.push(`${zone ?? 'local'} ${time} (1)`);
    }
  }
  if (tzBefore === undefined) delete process.env.TZ;
  else process.env.TZ = tzBefore;
  broken.length === 0
    ? ok('HH:MM -> Date -> HH:MM is the identity for all 1,440 minutes, in 7 zones')
    : bad('round trip', broken.slice(0, 5).join(', '));

  // What the wheel writes is what the storage boundary keeps, and what the
  // scheduler can compare. normalizeItem is where scheduled_time is decided.
  const everyOutput = [];
  for (let t = 0; t < 24 * 60; t++) everyOutput.push(dateToTime(at(Math.floor(t / 60), t % 60)));
  everyOutput.every((out) => {
    const kept = normalizeItem({ id: 'w', title: 'Wheel', scheduled_time: out, remind: true });
    return /^\d{2}:\d{2}$/.test(out) && kept.scheduled_time === out && kept.remind === true;
  })
    ? ok('every value the wheel can write survives normalizeItem untouched, reminder intact')
    : bad('storage boundary');

  // The clear. A wheel has no empty state, so "no time" is the Clear chip's to
  // say — and it must land as no time AND no reminder.
  const cleared = normalizeItem({ id: 'w', title: 'Wheel', scheduled_time: NO_TIME, remind: true });
  NO_TIME === '' &&
  normalizeTime(NO_TIME) === null &&
  cleared.scheduled_time === null &&
  cleared.remind === false
    ? ok('the clear writes no time, and no time forces the reminder off at storage')
    : bad('clear', JSON.stringify(cleared));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
