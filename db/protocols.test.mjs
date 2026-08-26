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
  restoreVersion,
  reviseProtocol,
  setActive,
  setStartedOn,
  updateProtocolMeta,
} from '../src/lib/db/repositories/protocols.ts';
import { cadenceText, parseCadenceText } from '../src/lib/protocols/cadence.ts';
import {
  emptyContent,
  legacyItemId,
  normalizeCadence,
  parseProtocolContent,
  validateContent,
} from '../src/lib/protocols/content.ts';
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

console.log('12. reviseProtocol applies meta + active + version in one transaction');
{
  const { db, raw } = freshDb();
  const pid = createProtocolWithVersion(
    db,
    { name: 'Morning Stack', type: 'supplement_stack' },
    STACK
  );
  const v2 = reviseProtocol(db, pid, {
    name: 'AM Stack',
    type: 'daily_routine',
    description: 'renamed',
    active: false,
    content: { items: [STACK.items[0]] },
    changeNotes: 'Trimmed to creatine only',
  });
  const p = raw.prepare('SELECT * FROM protocols WHERE id = ?').get(pid);
  const v = getCurrentVersion(db, pid);
  p && p.name === 'AM Stack' && p.type === 'daily_routine' && p.is_active === 0
    ? ok('identity + paused state updated')
    : bad('revise meta', JSON.stringify(p));
  v && v.id === v2 && v.version_number === 2 && v.change_notes === 'Trimmed to creatine only'
    ? ok('new version written and live')
    : bad('revise version', JSON.stringify(v));
  const noVersion = reviseProtocol(db, pid, {
    name: 'AM Stack',
    type: 'daily_routine',
    description: null,
    active: true,
    content: null,
  });
  noVersion === null &&
  raw.prepare('SELECT count(*) c FROM protocol_versions WHERE protocol_id = ?').get(pid).c === 2
    ? ok('content: null updates the row without minting a version')
    : bad('meta-only revise', JSON.stringify(noVersion));
  throws(() =>
    reviseProtocol(db, pid, {
      name: 'Half-saved',
      type: 'daily_routine',
      description: null,
      active: true,
      content: STACK,
      createdBy: 'robot',
    })
  )
    ? ok('a failing version write makes the whole revision throw')
    : bad('bad revise accepted');
  raw.prepare('SELECT name FROM protocols WHERE id = ?').get(pid).name === 'AM Stack'
    ? ok('…and the rename rolled back with it — no partial save')
    : bad('partial revise persisted');
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
