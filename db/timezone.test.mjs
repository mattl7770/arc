/**
 * Headless test of automatic timezone handling (backlog **D4**) — the pure
 * classifier (src/lib/timezone/classify.ts), the observer and the day predicate
 * (src/lib/db/repositories/day-meta.ts, migration 0053), and the four consumers
 * that have to agree about a day that was not 24 hours long. Real SQLite via
 * node:sqlite; op-sqlite is never loaded. Run: npm run db:test.
 *
 * §1  the sign — stored offsets are the NEGATION of getTimezoneOffset()
 * §2  the copy — UTC±h labels and the day's length, both hand-rolled (no Intl)
 * §3  classification — eastbound, westbound, the seam that crosses the boundary,
 *     and every way DST must NOT be read as travel
 * §4  the observer — first sample, idempotence, one row per real change, and
 *     ZERO rows for either DST direction
 * §5  the predicate — true for the marked day and for no other
 * §6  the day is EXCUSED, and no mode was set to do it
 * §7  baselines exclude the marked day; the day's own reading still renders
 * §8  the nutrition verdict goes quiet
 * §9  Home's line appears on that day and on no other
 * §10 the Coach's state block carries the fact, and what it costs
 * §11 the B3 interplay — the boundary moves the marked day, and the write
 *     cursor still never rewinds
 * §12 the 0053 schema itself
 *
 * **§1, §4 and §11 pin the timezone.** The classification RULES are all pure
 * over injected offsets and would pass in any zone — that is the whole shape of
 * classify.ts, and the reason `src/lib/db/date.ts` refuses SQLite's `'localtime'`
 * is the same one. But the observer reads the device's real offset, so the only
 * way to exercise the path the app actually runs is to pin a zone that has DST.
 * TZ is set to America/Los_Angeles before any Date is constructed, and §1
 * REFUSES to run rather than pass vacuously if the runtime ignored it — a DST
 * test that silently skipped would be worse than no DST test.
 *
 * The trick that makes §4 deterministic without a fake clock: the observer's
 * "to" offset is always the host's, so a simulated journey is expressed by
 * choosing the CURSOR it starts from. UTC−12 → LA winter is eastbound, UTC+1 →
 * LA winter is westbound, and LA summer → LA winter is the autumn DST change.
 */
process.env.TZ = 'America/Los_Angeles';

import { DatabaseSync } from 'node:sqlite';

import { buildTurnContext } from '../src/lib/ai/turn-context.ts';
import {
  forwardCursor,
  logicalDate,
  logicalDateAtOffset,
  setDayStartsAt,
  shiftISODate,
} from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  isTimezoneChangedDay,
  observeTimezone,
  recentTimezoneChange,
  timezoneChangedDaysIn,
  timezoneHomeLine,
  timezoneNotesIn,
} from '../src/lib/db/repositories/day-meta.ts';
import { getActiveMode, setMode } from '../src/lib/db/repositories/day-modes.ts';
import {
  getOrCreateDailyLog,
  insertMissionItem,
  missionBySource,
  missionDailySeries,
  missionOwed,
} from '../src/lib/db/repositories/mission.ts';
import { logMeal, setNutritionTargets } from '../src/lib/db/repositories/nutrition.ts';
import { getTimezoneCursor, setTimezoneCursor } from '../src/lib/db/repositories/user.ts';
import { upsertWearableRows } from '../src/lib/db/repositories/wearables.ts';
import { deriveReadiness, nutritionVerdict } from '../src/lib/home/readiness.ts';
import {
  classifyOffsetChange,
  dayLengthHours,
  formatDayLength,
  formatOffsetChange,
  formatUtcOffset,
  offsetEastMinutes,
  zoneProbe,
} from '../src/lib/timezone/classify.ts';

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
const eq = (name, actual, expected) =>
  actual === expected
    ? ok(name)
    : bad(name, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

function makeDb(raw) {
  const database = {
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
  const executor = {
    exec: (sql) => raw.exec(sql),
    getUserVersion: () => raw.prepare('PRAGMA user_version').get().user_version,
    setUserVersion: (n) => raw.exec(`PRAGMA user_version = ${n}`),
    transaction: database.transaction,
  };
  return { database, executor, raw };
}

function freshDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const { database, executor } = makeDb(raw);
  migrate(executor, MIGRATIONS);
  return { db: database, raw };
}

/** Offsets in minutes EAST of UTC, named the way a human says the zone. */
const UTC_MINUS_12 = -720;
const UTC_MINUS_8 = -480; // Los Angeles, standard
const UTC_MINUS_7 = -420; // Los Angeles, daylight
const UTC_PLUS_1 = 60; // London, daylight
const SYDNEY_JAN = 660; // +11, and it is the DST one — the hemisphere is reversed
const SYDNEY_JUL = 600; // +10, standard

/** A LA-winter instant (host offset −480) and a LA-summer one (−420). */
const WINTER_NOON = new Date(2026, 0, 15, 12, 0, 0);
const SUMMER_NOON = new Date(2026, 6, 15, 12, 0, 0);
/** The probe as the classifier's callers pass it: the DEVICE's own pair. */
const LA_PROBE = { januaryOffsetMin: UTC_MINUS_8, julyOffsetMin: UTC_MINUS_7 };

// ---------------------------------------------------------------------------
console.log('1. the sign — what is stored is the NEGATION of getTimezoneOffset()');
{
  // The zone pin, proved before anything leans on it. A runtime that ignored TZ
  // would make every DST assertion below pass for the wrong reason.
  const probe = zoneProbe(2026);
  if (probe.januaryOffsetMin !== UTC_MINUS_8 || probe.julyOffsetMin !== UTC_MINUS_7) {
    bad(
      'TZ=America/Los_Angeles was not honoured — refusing to run the DST assertions vacuously',
      JSON.stringify(probe)
    );
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  ok('TZ is pinned to America/Los_Angeles, so the probe is a real zone pair');

  // THE TRAP, asserted from both ends. getTimezoneOffset() counts minutes WEST,
  // so UTC−8 is +480 there and −480 here. Same species as the SpO2 percent
  // round-trip in db/health-mapping.test.mjs: one line so nobody "tidies up" the
  // sign later and silently inverts every stored row.
  eq('LA winter reads +480 west …', WINTER_NOON.getTimezoneOffset(), 480);
  eq('… and is stored as −480 east', offsetEastMinutes(WINTER_NOON), UTC_MINUS_8);
  eq('LA summer reads +420 west …', SUMMER_NOON.getTimezoneOffset(), 420);
  eq('… and is stored as −420 east', offsetEastMinutes(SUMMER_NOON), UTC_MINUS_7);
  // …and as a property, which holds in whatever zone a future machine runs in.
  [WINTER_NOON, SUMMER_NOON, new Date(2026, 3, 1, 9, 30)].every(
    (d) => offsetEastMinutes(d) === -d.getTimezoneOffset()
  )
    ? ok('the negation is exact for every instant, not only the two named ones')
    : bad('negation property');
}

// ---------------------------------------------------------------------------
console.log('\n2. the copy — UTC labels and day length, hand-rolled (Hermes has no Intl)');
{
  eq('UTC−8', formatUtcOffset(UTC_MINUS_8), 'UTC−8');
  eq('UTC+1', formatUtcOffset(UTC_PLUS_1), 'UTC+1');
  eq('UTC itself has no sign', formatUtcOffset(0), 'UTC');
  eq('a half-hour zone keeps its minutes', formatUtcOffset(330), 'UTC+5:30');
  eq('… in both directions', formatUtcOffset(-210), 'UTC−3:30');
  // The minus is the typographic U+2212 the app's other signed numbers use
  // (readiness.ts fmtDelta), never an ASCII hyphen.
  formatUtcOffset(UTC_MINUS_8).includes('−')
    ? ok('the minus is U+2212, matching every other signed number in the app')
    : bad('ASCII hyphen in a UTC label');
  eq(
    'the change reads as one phrase',
    formatOffsetChange(UTC_MINUS_8, UTC_PLUS_1),
    'UTC−8 → UTC+1'
  );

  // EAST shortens the day, WEST lengthens it — and the offsets are east-positive,
  // so the sign in the formula is the one that looks wrong at a glance.
  eq('LA → London (9h east) is a 15-hour day', dayLengthHours(UTC_MINUS_8, UTC_PLUS_1), 15);
  eq('the return leg is a 33-hour day', dayLengthHours(UTC_PLUS_1, UTC_MINUS_8), 33);
  eq('London → New York is a 29-hour day', dayLengthHours(UTC_PLUS_1, -240), 29);
  eq('LA → Chicago is a 22-hour day', dayLengthHours(UTC_MINUS_7, -300), 22);
  eq('whole hours print as whole hours', formatDayLength(15), '15 hours');
  eq('a half-hour zone does not print 28.499999', formatDayLength(28.5), '28.5 hours');
}

// ---------------------------------------------------------------------------
console.log('\n3. classification — travel vs DST, and which days a change marks');
{
  // 1. EASTBOUND, MID-DAY. 14:00 in LA is 23:00 in London: same date either way,
  //    so exactly ONE day is marked — and it is the 15-hour one.
  const midday = classifyOffsetChange({
    fromOffsetMin: UTC_MINUS_8,
    toOffsetMin: UTC_PLUS_1,
    at: new Date(Date.UTC(2026, 8, 3, 22, 0)), // 14:00 LA / 23:00 London
    januaryOffsetMin: 0, // the device is in London now
    julyOffsetMin: UTC_PLUS_1,
  });
  eq('eastbound mid-day is travel', midday.kind, 'travel');
  eq('… and marks exactly one day', midday.markedDays.length, 1);
  eq('… the day it happened on', midday.markedDays[0], '2026-09-03');
  eq('… which was 15 hours long', dayLengthHours(UTC_MINUS_8, UTC_PLUS_1), 15);

  // 2. EASTBOUND ACROSS THE BOUNDARY. 23:00 in LA is already 08:00 the NEXT day
  //    in London: the tail of the old day never happened. BOTH are marked.
  const eastSeam = classifyOffsetChange({
    fromOffsetMin: UTC_MINUS_8,
    toOffsetMin: UTC_PLUS_1,
    at: new Date(Date.UTC(2026, 8, 4, 7, 0)), // 23:00 Sep 3 LA / 08:00 Sep 4 London
    januaryOffsetMin: 0,
    julyOffsetMin: UTC_PLUS_1,
  });
  eq('an eastbound seam marks two days', eastSeam.markedDays.length, 2);
  eq('… the day it left', eastSeam.fromLocalDate, '2026-09-03');
  eq('… and the day it arrived in', eastSeam.toLocalDate, '2026-09-04');
  shiftISODate(eastSeam.fromLocalDate, 1) === eastSeam.toLocalDate
    ? ok('… which is the next calendar day, so the old day ended early')
    : bad('eastbound seam adjacency');

  // 3. WESTBOUND ACROSS THE BOUNDARY — the clock steps BACK into yesterday, and
  //    the date is lived twice. This is the case the annotation exists for: the
  //    second pass through a date would otherwise read as data corruption.
  const westSeam = classifyOffsetChange({
    fromOffsetMin: UTC_PLUS_1,
    toOffsetMin: UTC_MINUS_8,
    at: new Date(Date.UTC(2026, 8, 4, 2, 0)), // 03:00 Sep 4 London / 18:00 Sep 3 LA
    ...LA_PROBE,
  });
  eq('a westbound seam marks two days', westSeam.markedDays.length, 2);
  eq('… the day it left', westSeam.fromLocalDate, '2026-09-04');
  eq('… and the EARLIER day it arrived in', westSeam.toLocalDate, '2026-09-03');
  // …and the monotonic clamp still holds over it: reading a past day is free,
  // but the implicit WRITE target only ever advances (date.ts forwardCursor).
  eq(
    'the write cursor does not rewind into the day already finished',
    forwardCursor(westSeam.fromLocalDate, westSeam.toLocalDate),
    '2026-09-04'
  );

  // 4. DST, BOTH DIRECTIONS. Spring forward and its autumn mirror: both offsets
  //    are members of the device's own {January, July} pair, so neither is
  //    travel and neither marks a day.
  const spring = classifyOffsetChange({
    fromOffsetMin: UTC_MINUS_8,
    toOffsetMin: UTC_MINUS_7,
    at: new Date(Date.UTC(2026, 2, 8, 10, 0)),
    ...LA_PROBE,
  });
  eq('spring forward is DST, not travel', spring.kind, 'dst');
  eq('… and marks nothing', spring.markedDays.length, 0);
  const autumn = classifyOffsetChange({
    fromOffsetMin: UTC_MINUS_7,
    toOffsetMin: UTC_MINUS_8,
    at: new Date(Date.UTC(2026, 10, 1, 9, 0)),
    ...LA_PROBE,
  });
  eq('fall back is DST too — direction never matters', autumn.kind, 'dst');
  eq('… and marks nothing either', autumn.markedDays.length, 0);

  // 5. SOUTHERN HEMISPHERE. January is the DST one in Sydney, so a rule that
  //    assumed "January is standard" would call this travel.
  const sydney = classifyOffsetChange({
    fromOffsetMin: SYDNEY_JAN,
    toOffsetMin: SYDNEY_JUL,
    at: new Date(Date.UTC(2026, 3, 4, 16, 0)),
    januaryOffsetMin: SYDNEY_JAN,
    julyOffsetMin: SYDNEY_JUL,
  });
  eq('Sydney’s own shift is DST — the pair is unordered', sydney.kind, 'dst');

  // 6. A ONE-HOUR HOP INTO A ZONE WITH NO DST. The pair degenerates to a single
  //    value, so ANY change is travel. This is the case the naïve "±60 minutes
  //    means DST" rule gets wrong, which is why that rule is not what is built.
  const hop = classifyOffsetChange({
    fromOffsetMin: 480, // Singapore, UTC+8, no DST
    toOffsetMin: 540, // Tokyo, UTC+9, no DST
    at: new Date(Date.UTC(2026, 8, 3, 6, 0)),
    januaryOffsetMin: 540,
    julyOffsetMin: 540,
  });
  eq('a one-hour hop between no-DST zones is travel', hop.kind, 'travel');
  eq('… and marks its day', hop.markedDays.length, 1);

  // 7. The near-miss that is deliberately allowed to be wrong, asserted so the
  //    limit is a known one: a flight between two zones that happen to be
  //    exactly the device's own standard/DST pair reads as DST.
  const unlucky = classifyOffsetChange({
    fromOffsetMin: UTC_MINUS_8,
    toOffsetMin: UTC_MINUS_7,
    at: new Date(Date.UTC(2026, 8, 3, 20, 0)),
    ...LA_PROBE,
  });
  eq('LA → Denver reads as DST — the documented, harmless near-miss', unlucky.kind, 'dst');
}

// ---------------------------------------------------------------------------
console.log('\n4. the observer — one row per real change, and none for DST');
{
  const rows = (db) => db.all('SELECT * FROM timezone_changes ORDER BY changed_at, rowid');

  // FIRST OBSERVATION. The cursor lands, and no row: a change needs a before.
  {
    const { db } = freshDb();
    eq('a fresh install has no cursor', getTimezoneCursor(db), null);
    eq('the first observation reports no change', observeTimezone(db, WINTER_NOON), null);
    eq('… but it does record what it saw', getTimezoneCursor(db), UTC_MINUS_8);
    eq('… and writes no row', rows(db).length, 0);

    // IDEMPOTENCE. The same offset observed again is a no-op, which matters:
    // this runs on every single foreground.
    eq('the second observation is a no-op', observeTimezone(db, WINTER_NOON), null);
    eq('… still no rows', rows(db).length, 0);
  }

  // EASTBOUND. Cursor at UTC−12, device now in LA winter: +4h east, and −720 is
  // not in the device's {−480, −420} pair, so it is travel.
  {
    const { db } = freshDb();
    setTimezoneCursor(db, UTC_MINUS_12);
    const row = observeTimezone(db, WINTER_NOON);
    row !== null ? ok('an eastbound day writes a row') : bad('no eastbound row');
    eq('… exactly one', rows(db).length, 1);
    eq('… from the old offset', row.from_offset_min, UTC_MINUS_12);
    eq('… to the new one', row.to_offset_min, UTC_MINUS_8);
    eq('… on the day it happened', row.from_local_date, '2026-01-15');
    eq('… and the cursor has moved', getTimezoneCursor(db), UTC_MINUS_8);
    eq('… the day was 20 hours long', dayLengthHours(row.from_offset_min, row.to_offset_min), 20);
    // The instant is stored as a real ISO-8601 UTC timestamp, not a local one.
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.changed_at)
      ? ok('… and changed_at is an ISO-8601 UTC instant')
      : bad('changed_at shape', row.changed_at);
    // Observing again from the new cursor changes nothing.
    eq('a second foreground the same day adds nothing', observeTimezone(db, WINTER_NOON), null);
    eq('… still one row', rows(db).length, 1);
  }

  // WESTBOUND. Cursor at UTC+1, device now in LA winter: −9h west.
  {
    const { db } = freshDb();
    setTimezoneCursor(db, UTC_PLUS_1);
    const row = observeTimezone(db, WINTER_NOON);
    row !== null ? ok('a westbound day writes a row') : bad('no westbound row');
    eq('… exactly one', rows(db).length, 1);
    eq(
      '… and the day was 33 hours long',
      dayLengthHours(row.from_offset_min, row.to_offset_min),
      33
    );
  }

  // DST, BOTH DIRECTIONS, THROUGH THE REAL OBSERVER. This is the assertion the
  // whole January/July probe exists for: a DST Sunday must not excuse a day's
  // mission items, and must not drop itself out of the HRV baseline.
  {
    const { db } = freshDb();
    setTimezoneCursor(db, UTC_MINUS_7); // last seen in summer
    eq('fall back writes no row', observeTimezone(db, WINTER_NOON), null);
    eq('… none at all', rows(db).length, 0);
    // The cursor MUST still move, or the same change is re-classified on every
    // foreground for the rest of the season.
    eq('… but the cursor tracks it', getTimezoneCursor(db), UTC_MINUS_8);

    eq('spring forward writes no row either', observeTimezone(db, SUMMER_NOON), null);
    eq('… still none', rows(db).length, 0);
    eq('… and the cursor tracked that too', getTimezoneCursor(db), UTC_MINUS_7);
  }
}

// ---------------------------------------------------------------------------
console.log('\n5. the predicate — true for the marked day, and for no other');
{
  const { db } = freshDb();
  setTimezoneCursor(db, UTC_PLUS_1);
  const row = observeTimezone(db, WINTER_NOON);
  const DAY = row.from_local_date; // 2026-01-15

  eq('the marked day', isTimezoneChangedDay(db, DAY), true);
  eq('the day before is untouched', isTimezoneChangedDay(db, shiftISODate(DAY, -1)), false);
  eq('the day after is untouched', isTimezoneChangedDay(db, shiftISODate(DAY, 1)), false);

  const window = timezoneChangedDaysIn(db, shiftISODate(DAY, -7), shiftISODate(DAY, 7));
  eq('the window form finds exactly one day', window.size, 1);
  eq('… the same one', [...window][0], DAY);
  eq('an empty window is empty', timezoneChangedDaysIn(db, '2025-01-01', '2025-01-31').size, 0);
  eq(
    'an inverted window is empty, not an error',
    timezoneChangedDaysIn(db, DAY, '2020-01-01').size,
    0
  );
  // A change on the far side of a window edge marks only the day inside it.
  eq(
    'a change just outside the window does not leak in',
    timezoneChangedDaysIn(db, shiftISODate(DAY, 1), shiftISODate(DAY, 7)).size,
    0
  );

  const notes = timezoneNotesIn(db, shiftISODate(DAY, -7), shiftISODate(DAY, 7));
  eq('the record states the change', notes.get(DAY), 'Timezone changed (UTC+1 → UTC−8)');
  eq('… and says nothing on any other day', notes.size, 1);
}

// ---------------------------------------------------------------------------
console.log('\n6. the day is EXCUSED — and no mode was set to do it');
{
  const { db } = freshDb();
  // Two days, identical plans, both SETTLED. One of them had a zone change.
  const TODAY = '2026-01-20';
  const TRAVEL_DAY = '2026-01-15';
  const PLAIN_DAY = '2026-01-16';
  for (const date of [TRAVEL_DAY, PLAIN_DAY]) {
    const log = getOrCreateDailyLog(db, date);
    for (const [title, status] of [
      ['Creatine', 'completed'],
      ['Zone 2', 'skipped'],
      ['Magnesium', 'pending'],
    ]) {
      insertMissionItem(db, log.id, 'habit', { id: '', title, status, category: 'Routine' });
    }
  }
  setTimezoneCursor(db, UTC_PLUS_1);
  observeTimezone(db, WINTER_NOON); // marks TRAVEL_DAY

  const series = missionDailySeries(db, 14, TODAY);
  const travel = series.find((p) => p.date === TRAVEL_DAY);
  const plain = series.find((p) => p.date === PLAIN_DAY);

  // THE OWNER'S CALL, mechanically: the skips are forgiven and the MODE IS NOT
  // TOUCHED. ARC cannot tell a flight from a Settings change, and Travel mode
  // would reshape the plan and the Coach's tone — which is the user's decision.
  eq('the timezone day excuses the skip AND the untouched item', travel.excused, 2);
  eq('… so nothing on it is counted as a miss', travel.skipped, 0);
  eq('… the plan itself is untouched — only the denominator moved', travel.planned, 3);
  eq('… leaving one item owed', missionOwed(travel), 1);
  eq('NO mode was set', getActiveMode(db, TRAVEL_DAY), 'normal');
  eq('… and the day still reports itself as Normal', travel.mode, 'normal');

  // The control, one day later, with everything else identical.
  eq('the ordinary day forgives nothing', plain.excused, 0);
  eq('… and its skip is still a miss', plain.skipped, 1);
  eq('… with all three owed', missionOwed(plain), 3);

  // And the same rule reaches "Where it's failing", which is the half of
  // mission-history that names something to go and change.
  const record = missionBySource(db, TRAVEL_DAY, PLAIN_DAY).find((s) => s.name === 'Routine');
  eq('by-source excuses the same two rows', record.excused, 2);
  eq('… and counts the other day’s skip as a skip', record.skipped, 1);
  record.planned - record.completed - record.skipped - record.excused - record.partial === 1
    ? ok('… and the ledger still reconciles (one untouched row left on the plain day)')
    : bad('ledger identity', JSON.stringify(record));

  // A mode that ALSO excuses must not double-count, and must still win the
  // label: the mode is what the user declared, the zone change is what ARC saw.
  setMode(db, { mode: 'sick', startDate: TRAVEL_DAY, endDate: TRAVEL_DAY });
  const both = missionDailySeries(db, 14, TODAY).find((p) => p.date === TRAVEL_DAY);
  eq('a mode on the same day excuses the same two items, not four', both.excused, 2);
  eq('… and the mode is still reported', both.mode, 'sick');
}

// ---------------------------------------------------------------------------
console.log('\n7. baselines EXCLUDE the marked day — and do not delete it');
{
  const TODAY = '2026-01-20';
  const MARKED = '2026-01-15';
  // Thirty days of a flat 50 ms HRV ending yesterday, with ONE day spiked to
  // 200 — the kind of perturbation a travel day's activity actually produces.
  const plant = (db) => {
    const rows = [];
    for (let i = 1; i <= 30; i++) {
      const date = shiftISODate(TODAY, -i);
      rows.push({
        date,
        metricType: 'hrv',
        value: date === MARKED ? 200 : 50,
        unit: 'ms',
        sourceDevice: 'apple_watch',
        sourceRawId: `hk:hrv:${date}`,
        startTime: null,
        endTime: null,
        metadata: {},
      });
    }
    rows.push({
      date: TODAY,
      metricType: 'hrv',
      value: 50,
      unit: 'ms',
      sourceDevice: 'apple_watch',
      sourceRawId: `hk:hrv:${TODAY}`,
      startTime: null,
      endTime: null,
      metadata: {},
    });
    upsertWearableRows(db, rows);
  };

  // Without the mark, the spike drags the baseline up and today reads BELOW it.
  const { db: unmarked } = freshDb();
  plant(unmarked);
  const before = deriveReadiness(unmarked, TODAY, { now: new Date(2026, 0, 20, 9, 0) });
  const hrvBefore = before.metrics.find((m) => m.id === 'hrv');
  hrvBefore.detail.includes('below')
    ? ok('with the odd day in the baseline, a normal HRV reads as below baseline')
    : bad('unmarked baseline', hrvBefore.detail);

  // With it, the baseline is the other 29 days' mean — exactly 50 — so today is
  // AT baseline, and the verdict stops being a fact about a flight.
  const { db: marked } = freshDb();
  plant(marked);
  setTimezoneCursor(marked, UTC_PLUS_1);
  observeTimezone(marked, WINTER_NOON); // marks 2026-01-15
  eq('the day is marked', isTimezoneChangedDay(marked, MARKED), true);
  const after = deriveReadiness(marked, TODAY, { now: new Date(2026, 0, 20, 9, 0) });
  const hrvAfter = after.metrics.find((m) => m.id === 'hrv');
  eq('the excluded baseline is the other 29 days exactly', hrvAfter.detail, 'at baseline');

  // EXCLUDED, NOT DELETED. The day's own reading still renders, and every
  // fixed-length trend window still yields its full count.
  const strip = deriveReadiness(marked, MARKED, { now: new Date(2026, 0, 15, 9, 0) });
  eq(
    'the marked day still shows its own reading',
    strip.metrics.find((m) => m.id === 'hrv').value,
    '200 ms'
  );
}

// ---------------------------------------------------------------------------
console.log('\n8. the nutrition verdict goes QUIET on a marked day');
{
  // First as a pure value — the seam C7 will rework around.
  const totals = { kcal: 3220, protein_g: 180, mealCount: 4 };
  const targets = { kcal: 2300, protein_g: 180 };
  const graded = nutritionVerdict(totals, targets, true, false);
  eq('a 1.4× day normally grades poor', graded.level, 'poor');
  const quiet = nutritionVerdict(totals, targets, true, true);
  eq('… but not on a day that was not 24 hours long', quiet.level, 'unknown');
  quiet.note.includes('timezone changed today — not graded')
    ? ok('… and it says why, without inventing a scaled target')
    : bad('quiet note', quiet.note);
  quiet.note.includes('3,220 / 2,300 kcal')
    ? ok('… while still showing the numbers it declined to judge')
    : bad('progress note dropped', quiet.note);
  // The default is false, so every existing caller is byte-for-byte unchanged.
  eq('the flag defaults to off', nutritionVerdict(totals, targets, true).level, 'poor');

  // Then end to end, through deriveReadiness, which is what Home renders.
  const { db } = freshDb();
  const DAY = '2026-01-15';
  setNutritionTargets(db, { effective_date: '2026-01-01', kcal: 2300, protein_g: 180 });
  logMeal(db, { date: DAY, time: '20:00', name: 'Dinner', kcal: 3220, protein_g: 180 });
  const before = deriveReadiness(db, DAY, { now: new Date(2026, 0, 15, 21, 0) });
  eq(
    'Home grades it before the change is known',
    before.pillars.find((p) => p.label === 'Nutrition').level,
    'poor'
  );

  setTimezoneCursor(db, UTC_PLUS_1);
  observeTimezone(db, WINTER_NOON);
  const after = deriveReadiness(db, DAY, { now: new Date(2026, 0, 15, 21, 0) });
  const pillar = after.pillars.find((p) => p.label === 'Nutrition');
  eq('… and goes quiet once it is', pillar.level, 'unknown');
  pillar.note.includes('not graded')
    ? ok('… with the reason on the pillar itself')
    : bad('pillar note', pillar.note);
}

// ---------------------------------------------------------------------------
console.log('\n9. Home’s line — on that day, and on no other');
{
  const { db } = freshDb();
  setTimezoneCursor(db, UTC_PLUS_1);
  const row = observeTimezone(db, WINTER_NOON);
  const DAY = row.from_local_date;

  eq(
    'the day it happened',
    timezoneHomeLine(db, DAY),
    'Timezone changed (UTC+1 → UTC−8). Today is 33 hours long.'
  );
  eq('the day before: nothing', timezoneHomeLine(db, shiftISODate(DAY, -1)), null);
  eq('the day after: nothing', timezoneHomeLine(db, shiftISODate(DAY, 1)), null);
  eq('a week later: nothing', timezoneHomeLine(db, shiftISODate(DAY, 7)), null);
  eq('a database with no change at all: nothing', timezoneHomeLine(freshDb().db, DAY), null);

  // When the change crossed the day boundary the hours are split between two
  // days and no single number is true of either, so the line stops at the fact.
  const { db: seam } = freshDb();
  seam.run(
    `INSERT INTO timezone_changes
       (id, changed_at, from_offset_min, to_offset_min, from_local_date, to_local_date)
     VALUES ('seam', '2026-09-04T07:00:00.000Z', -480, 60, '2026-09-03', '2026-09-04')`
  );
  eq(
    'a seam day states the fact and claims no length',
    timezoneHomeLine(seam, '2026-09-04'),
    'Timezone changed (UTC−8 → UTC+1).'
  );
  eq(
    '… on both of its days',
    timezoneHomeLine(seam, '2026-09-03'),
    'Timezone changed (UTC−8 → UTC+1).'
  );
}

// ---------------------------------------------------------------------------
console.log('\n10. the Coach’s state block — the fact, its horizon, and its cost');
{
  const { db } = freshDb();
  const NOW = new Date(2026, 0, 15, 9, 0); // LA, the day of the change
  const baseline = buildTurnContext(db, NOW);
  !/Timezone:/.test(baseline)
    ? ok('a database with no change says nothing — most days cost nothing')
    : bad('timezone line present with no change');

  setTimezoneCursor(db, UTC_PLUS_1);
  observeTimezone(db, WINTER_NOON);
  const sameDay = buildTurnContext(db, NOW);
  const line = sameDay.split('\n').find((l) => l.startsWith('Timezone:'));
  line ? ok(`the day of the change: "${line}"`) : bad('no timezone line on the day');
  line.includes('UTC−8') && line.includes('UTC+1')
    ? ok('… it names both offsets, never a zone id (Hermes has no Intl)')
    : bad('offsets missing', line);
  line.includes('9h west')
    ? ok('… and the size and direction of the shift')
    : bad('shift missing', line);
  line.includes('excluded from baselines')
    ? ok('… plus the ONE clause ARC must add, or a flat HRV trend gets explained wrongly')
    : bad('baseline clause missing', line);
  !/melatonin|jet lag protocol|adjust your training/i.test(line)
    ? ok('… and no rule table: the model is handed the fact and decides for itself')
    : bad('the block is prescribing', line);

  // THE COST. The block is the UNCACHED half of every request, so the delta is
  // measured, not assumed. ~2.8 chars/token for dense text is the same rough
  // tokeniser db/coach-eval.test.mjs §6 budgets with.
  const delta = Math.round((sameDay.length - baseline.length) / 2.8);
  delta < 40
    ? ok(`the whole fact costs ~${delta} uncached tokens, on the days it appears`)
    : bad('timezone line over budget', `${delta} tok`);

  // THE HORIZON. Jet lag's practical span is about a day per hour of shift; past
  // that the line is noise on every turn forever, so it stops.
  const later = buildTurnContext(db, new Date(2026, 0, 18, 9, 0)); // 3 days on
  /Timezone:/.test(later)
    ? ok('three days on it is still there — the body has not finished adjusting')
    : bad('horizon too short');
  !/this day’s readings|this day's readings/.test(later)
    ? ok('… but the baseline clause is gone, because that day is behind us')
    : bad('baseline clause still claimed on a later day');
  const wayLater = buildTurnContext(db, new Date(2026, 0, 25, 9, 0)); // 10 days on
  !/Timezone:/.test(wayLater)
    ? ok('ten days on it is gone — the fact stays in the record, not in the prompt')
    : bad('horizon never closes');
  eq(
    'and the horizon is a query, not a render decision',
    recentTimezoneChange(db, '2026-01-25'),
    null
  );
}

// ---------------------------------------------------------------------------
console.log('\n11. the B3 interplay — the boundary moves with the zone');
{
  // THE RULE, stated in date.ts and pinned here: the rollover is a LOCAL
  // wall-clock time, so on a travel day it happens at the DESTINATION's 04:00.
  // There is no catch-up boundary and no double rollover.
  const B = '04:00';
  // 02:00 in London on Sep 4 is 18:00 on Sep 3 in LA. Under a 04:00 boundary
  // London is still on Sep 3's day, and LA plainly is too — so the pair agrees,
  // and the change marks ONE day rather than inventing a seam.
  const at = new Date(Date.UTC(2026, 8, 4, 1, 0));
  eq(
    'under a 04:00 boundary, 02:00 London is still yesterday',
    logicalDateAtOffset(at, UTC_PLUS_1, B),
    '2026-09-03'
  );
  eq('… and 18:00 LA is the same day', logicalDateAtOffset(at, UTC_MINUS_8, B), '2026-09-03');
  const withBoundary = classifyOffsetChange({
    fromOffsetMin: UTC_PLUS_1,
    toOffsetMin: UTC_MINUS_8,
    at,
    ...LA_PROBE,
    dayStartsAt: B,
  });
  eq('so the boundary collapses the seam to one marked day', withBoundary.markedDays.length, 1);
  // …and at midnight it does not: the same instant under the DEFAULT boundary
  // straddles two dates, which is exactly the difference B3 makes.
  const atMidnight = classifyOffsetChange({
    fromOffsetMin: UTC_PLUS_1,
    toOffsetMin: UTC_MINUS_8,
    at,
    ...LA_PROBE,
    dayStartsAt: '00:00',
  });
  eq('at calendar midnight the same change marks two', atMidnight.markedDays.length, 2);

  // The installed boundary is what the app uses when none is passed, and the
  // observer must route through it rather than re-deriving a day of its own.
  setDayStartsAt(B);
  try {
    const { db } = freshDb();
    setTimezoneCursor(db, UTC_PLUS_1);
    // 02:30 local LA — BEFORE the 04:00 boundary, so the day is the 14th.
    const row = observeTimezone(db, new Date(2026, 0, 15, 2, 30));
    eq('the observer files the change under the LOGICAL day', row.to_local_date, '2026-01-14');
    eq(
      '… which is what the predicate then answers about',
      isTimezoneChangedDay(db, '2026-01-14'),
      true
    );
    // The point, stated as the difference the boundary MADE: a calendar-midnight
    // reading of the same instant would have filed it under the 15th and left
    // the 14th unmarked. A second, boundary-blind "local day" inside the
    // observer is exactly how this ships broken, so it is asserted rather than
    // trusted (the source scan in db/day-boundary.test.mjs §5 is the other half).
    eq(
      'a calendar-midnight reading would have filed it a day later',
      logicalDateAtOffset(new Date(2026, 0, 15, 2, 30), UTC_MINUS_8, '00:00'),
      '2026-01-15'
    );
    // The app's one todayISODate and the offset-explicit form agree at the
    // CURRENT offset — which is what makes the observer's two dates comparable
    // to every other day in the database.
    const now = new Date(2026, 0, 15, 2, 30);
    eq(
      'logicalDateAtOffset at the current offset IS logicalDate',
      logicalDateAtOffset(now, offsetEastMinutes(now), B),
      logicalDate(now, B)
    );
  } finally {
    setDayStartsAt('00:00');
  }
}

// ---------------------------------------------------------------------------
console.log('\n12. the 0053 schema itself');
{
  const { db } = freshDb();
  const insert = (values) =>
    db.run(
      `INSERT INTO timezone_changes
         (id, changed_at, from_offset_min, to_offset_min, from_local_date, to_local_date)
       VALUES (${values})`
    );
  const rejects = (name, values) => {
    try {
      insert(values);
      bad(name, 'the row was accepted');
    } catch {
      ok(name);
    }
  };

  rejects(
    'a NULL id is rejected (PRIMARY KEY NOT NULL — SQLite would allow it otherwise)',
    `NULL, '2026-01-15T20:00:00.000Z', -480, 60, '2026-01-15', '2026-01-15'`
  );
  rejects(
    'a change that changed nothing is rejected',
    `'a', '2026-01-15T20:00:00.000Z', 60, 60, '2026-01-15', '2026-01-15'`
  );
  rejects(
    'an impossible offset is rejected (±840 is the real range)',
    `'b', '2026-01-15T20:00:00.000Z', -480, 900, '2026-01-15', '2026-01-15'`
  );
  rejects(
    'a malformed date is rejected by the GLOB',
    `'c', '2026-01-15T20:00:00.000Z', -480, 60, '2026-1-15', '2026-01-15'`
  );

  insert(`'d', '2026-01-15T20:00:00.000Z', -480, 60, '2026-01-15', '2026-01-15'`);
  const row = db.get(`SELECT * FROM timezone_changes WHERE id = 'd'`);
  row.created_at && row.updated_at ? ok('both timestamps default') : bad('timestamps');
  db.run(`UPDATE timezone_changes SET to_offset_min = 120 WHERE id = 'd'`);
  const touched = db.get(`SELECT * FROM timezone_changes WHERE id = 'd'`);
  touched.updated_at >= row.updated_at
    ? ok('the AFTER UPDATE trigger restamps updated_at')
    : bad('trigger', `${row.updated_at} → ${touched.updated_at}`);
  // The two indexes the OR-shaped query needs — SQLite uses neither unless both
  // exist, and this is the query every record row and every Coach turn runs.
  const indexes = db
    .all(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'timezone_changes'`)
    .map((r) => r.name);
  indexes.includes('timezone_changes_from_date_idx') &&
  indexes.includes('timezone_changes_to_date_idx')
    ? ok('both day indexes exist, so the OR can use one')
    : bad('indexes', JSON.stringify(indexes));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
