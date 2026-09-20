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

import { readFileSync } from 'node:fs';

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
  allTrips,
  awayDaysIn,
  currentTrip,
  isTimezoneChangedDay,
  observeTimezone,
  recentTimezoneChange,
  timezoneChangedDaysIn,
  timezoneHomeLine,
  timezoneNotesIn,
  tripsIn,
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
import {
  baselineExclusionsIn,
  hasExclusionSource,
} from '../src/lib/home/baseline-exclusions.ts';
import {
  baselineDaysRemaining,
  deriveReadiness,
  nutritionVerdict,
} from '../src/lib/home/readiness.ts';
import {
  classifyOffsetChange,
  dayLengthHours,
  formatDayLength,
  formatOffsetChange,
  formatUtcOffset,
  offsetEastMinutes,
  zoneProbe,
} from '../src/lib/timezone/classify.ts';
import {
  awayDayNumber,
  deriveTrips,
  TRIP_SETTLE_DAYS,
  tripOn,
} from '../src/lib/timezone/trips.ts';

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
  // First as a pure value, through C7's inputs object (landed the same day):
  // a closed day (`expected >= 1`) while maintaining, where a 1.4× day is poor
  // in every direction's band.
  const totals = { kcal: 3220, protein_g: 180, mealCount: 4 };
  const targets = { kcal: 2300, protein_g: 180 };
  const closed = { totals, targets, direction: 'maintain', expected: 1, clock: '21:00' };
  const graded = nutritionVerdict({ ...closed, timezoneChanged: false });
  eq('a 1.4× day normally grades poor', graded.level, 'poor');
  const quiet = nutritionVerdict({ ...closed, timezoneChanged: true });
  eq('… but not on a day that was not 24 hours long', quiet.level, 'unknown');
  quiet.note.includes('timezone changed today — not graded')
    ? ok('… and it says why, without inventing a scaled target')
    : bad('quiet note', quiet.note);
  quiet.note.includes('3,220 / 2,300 kcal')
    ? ok('… while still showing the numbers it declined to judge')
    : bad('progress note dropped', quiet.note);
  // The default is false, so every existing caller is byte-for-byte unchanged.
  eq('the flag defaults to off', nutritionVerdict(closed).level, 'poor');

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
  //
  // The horizon is a claim about the SEAM line, and since 0060 the seam line only
  // has the field once the trip has CLOSED — an open trip prints the away line
  // instead, on every day of it, which §21 is about. So the journey is closed
  // here first: the observed row above left UTC+1 for UTC−8, and this is the leg
  // that comes back. Inserted rather than observed, because the observer's "to"
  // offset is always the host's (see this file's header).
  db.run(
    `INSERT INTO timezone_changes
       (id, changed_at, from_offset_min, to_offset_min, from_local_date, to_local_date,
        zone_jan_offset_min, zone_jul_offset_min)
     VALUES ('tz-return', '2026-01-16T20:00:00.000Z', -480, 60, '2026-01-16', '2026-01-16', 0, 60)`
  );
  const later = buildTurnContext(db, new Date(2026, 0, 18, 9, 0)); // 3 days on
  /Timezone:/.test(later)
    ? ok('three days on it is still there — the body has not finished adjusting')
    : bad('horizon too short');
  !/this day’s readings|this day's readings/.test(later)
    ? ok('… but the baseline clause is gone, because that day is behind us')
    : bad('baseline clause still claimed on a later day');
  !/day \d+ away/.test(later)
    ? ok('… and it is the seam line, not a trip: the trip closed on the return')
    : bad('away line on a closed trip', later);
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

// ===========================================================================
// THE SECOND PASS (0060) — §13 on.
//
// D4 annotated the SEAM. These sections are about the RUN OF DAYS BETWEEN two
// seams: the derived trip, the away days it puts in the baselines' excluded
// set, the reason the copy gives for a paused baseline, the Coach's away line,
// and the migration that makes the close rule read-time independent.
//
// Everything here is seeded by INSERTING rows rather than by observing, for the
// reason this file's header gives: the observer's "to" offset is always the
// host's, and a nine-day journey needs both ends. `seedSeam` is the only way a
// row is made below, so the derivation is exercised over exactly the columns a
// device would carry.
// ===========================================================================

/** Minutes east, by the city the plan keeps naming. */
const LONDON_WINTER = 0;
const LONDON_SUMMER = 60;
const PARIS_SUMMER = 120;
const CHICAGO_WINTER = -360;
const CHICAGO_SUMMER = -300;
const PHOENIX = -420; // …all year. Arizona does not observe DST, and that matters below.

/** The probe pairs those zones would have returned at the arrival instant. */
const PAIR_LONDON = [LONDON_WINTER, LONDON_SUMMER];
const PAIR_PARIS = [LONDON_SUMMER, PARIS_SUMMER];
const PAIR_LA = [UTC_MINUS_8, UTC_MINUS_7];
const PAIR_CHICAGO = [CHICAGO_WINTER, CHICAGO_SUMMER];
const PAIR_PHOENIX = [PHOENIX, PHOENIX]; // jan === jul: no DST, so equality is the whole test.

let seamSeq = 0;
/**
 * Insert one observed change exactly as `observeTimezone` would have written it.
 *
 * `pair` omitted means a 0053 row — one written before migration 0060, which
 * can never answer the seasonal question and must therefore close on exact
 * equality alone.
 */
function seedSeam(db, { day, from, to, fromDay, toDay, pair, id }) {
  const rowId = id ?? `tz-${++seamSeq}`;
  db.run(
    `INSERT INTO timezone_changes
       (id, changed_at, from_offset_min, to_offset_min, from_local_date, to_local_date,
        zone_jan_offset_min, zone_jul_offset_min)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      rowId,
      `${day}T20:00:00.000Z`,
      from,
      to,
      fromDay ?? day,
      toDay ?? day,
      pair ? pair[0] : null,
      pair ? pair[1] : null,
    ]
  );
  return rowId;
}

// ---------------------------------------------------------------------------
console.log('\n13. trips — the run of days between two seams, and how it closes');
{
  // (a) OUT AND BACK. The plan's opening example: out on the 12th, back on the
  // 21st, and the eight days in between are what D4 could not see.
  {
    const { db } = freshDb();
    seedSeam(db, { day: '2026-09-12', from: UTC_MINUS_8, to: LONDON_SUMMER, pair: PAIR_LONDON });
    seedSeam(db, { day: '2026-09-21', from: LONDON_SUMMER, to: UTC_MINUS_8, pair: PAIR_LA });
    const trips = allTrips(db, '2026-09-30');
    eq('out and back is ONE trip', trips.length, 1);
    eq('… closed by the return row', trips[0].closedBy, 'return');
    eq('… which left on the 12th', trips[0].startedOn, '2026-09-12');
    eq('… and stopped being a trip on the 21st', trips[0].closedOn, '2026-09-21');
    eq('… so its away days are the eight days between the seams', trips[0].awayDays.length, 8);
    eq('… beginning the morning after the flight', trips[0].awayDays[0], '2026-09-13');
    eq('… and ending the day before the return', trips[0].awayDays[7], '2026-09-20');
    eq('the seam days are NOT away days — they are the bounds', tripOn(trips, '2026-09-12'), null);
    eq('… at either end', tripOn(trips, '2026-09-21'), null);
    eq('and the home offset is the one it left from', trips[0].homeOffsetMin, UTC_MINUS_8);
  }

  // (b) OUT, LEG, BACK. A connecting hop does not end the trip and does not
  // restart the "how long have I been away" count.
  {
    const { db } = freshDb();
    seedSeam(db, { day: '2026-09-12', from: UTC_MINUS_8, to: LONDON_SUMMER, pair: PAIR_LONDON });
    seedSeam(db, { day: '2026-09-15', from: LONDON_SUMMER, to: PARIS_SUMMER, pair: PAIR_PARIS });
    seedSeam(db, { day: '2026-09-21', from: PARIS_SUMMER, to: UTC_MINUS_8, pair: PAIR_LA });
    const trips = allTrips(db, '2026-09-30');
    eq('a leg keeps it one trip', trips.length, 1);
    eq('… still eight away days', trips[0].awayDays.length, 8);
    eq('… the settle clock moved to the leg', trips[0].latestSeamOn, '2026-09-15');
    eq('… but the day count still runs from the departure', awayDayNumber(trips[0], '2026-09-16'), 4);
    eq('… and the body is under the leg’s offset', trips[0].offsetMin, PARIS_SUMMER);
  }

  // (c) THE STORED PAIR. LA in winter → London → LA in SUMMER. The return
  // arrives on −420 and the trip left −480, so exact equality says "not home"
  // and the trip would hang open for another three weeks. The arrival zone's own
  // pair is what says otherwise, and it is on the row.
  {
    const { db } = freshDb();
    seedSeam(db, { day: '2026-03-01', from: UTC_MINUS_8, to: LONDON_WINTER, pair: PAIR_LONDON });
    seedSeam(db, { day: '2026-03-20', from: LONDON_WINTER, to: UTC_MINUS_7, pair: PAIR_LA });
    const trips = allTrips(db, '2026-04-10');
    eq('a trip that left in PST and returned in PDT has come home', trips[0].closedBy, 'return');
    eq('… on the return row’s own day', trips[0].closedOn, '2026-03-20');

    // …and the same journey with a 0053 row does NOT close there. A NULL pair
    // means "this row cannot answer that question", and the fallback is the
    // behaviour 0053 already had.
    const { db: old } = freshDb();
    seedSeam(old, { day: '2026-03-01', from: UTC_MINUS_8, to: LONDON_WINTER, pair: PAIR_LONDON });
    seedSeam(old, { day: '2026-03-20', from: LONDON_WINTER, to: UTC_MINUS_7 });
    // Read from far enough out to see the stillness close land: the return row
    // became a LEG, so the settle clock runs from the 20th and the trip is still
    // open on 10 April. That lateness IS the cost of a missing pair.
    eq('a NULL pair leaves the trip open on the day the pair would have closed it',
      allTrips(old, '2026-04-10')[0].closedOn, null);
    const oldTrips = allTrips(old, '2026-04-15');
    eq('a NULL pair closes on equality only', oldTrips[0].closedBy, 'settled');
    eq('… three weeks after the last seam, not on the return', oldTrips[0].closedOn, '2026-04-11');
  }

  // (d) LA → CHICAGO STAYS OPEN, AND THE ANSWER DOES NOT MOVE WITH THE READER.
  // Chicago's pair is {−360, −300} and home is −480, so neither test matches.
  // The point of the case is the SECOND assertion: the same rows through the
  // pure derivation, with no database, no clock and no zone, give the same trip.
  {
    const { db } = freshDb();
    const rowId = seedSeam(db, {
      day: '2026-09-12',
      from: UTC_MINUS_8,
      to: CHICAGO_WINTER,
      pair: PAIR_CHICAGO,
    });
    const trips = allTrips(db, '2026-09-20');
    eq('a domestic hop with no way home in its pair stays open', trips[0].closedOn, null);
    eq('… and every day since is an away day', trips[0].awayDays.length, 8);

    const pure = deriveTrips({
      rows: [
        {
          id: rowId,
          from_offset_min: UTC_MINUS_8,
          to_offset_min: CHICAGO_WINTER,
          from_local_date: '2026-09-12',
          to_local_date: '2026-09-12',
          zone_jan_offset_min: CHICAGO_WINTER,
          zone_jul_offset_min: CHICAGO_SUMMER,
        },
      ],
      travelWindows: [],
      today: '2026-09-20',
    });
    eq('the derivation reads no probe, so the answer is the same anywhere', pure[0].closedOn, null);
    eq('… down to the away-day count', pure[0].awayDays.length, 8);
  }

  // (e) MARCH ACROSS DST, THEN JUNE. Two trips, and the June one is measured
  // against the offset the March one came home to.
  {
    const { db } = freshDb();
    seedSeam(db, { day: '2026-03-05', from: UTC_MINUS_8, to: LONDON_WINTER, pair: PAIR_LONDON });
    seedSeam(db, { day: '2026-03-20', from: LONDON_WINTER, to: UTC_MINUS_7, pair: PAIR_LA });
    seedSeam(db, { day: '2026-06-10', from: UTC_MINUS_7, to: LONDON_SUMMER, pair: PAIR_LONDON });
    seedSeam(db, { day: '2026-06-20', from: LONDON_SUMMER, to: UTC_MINUS_7, pair: PAIR_LA });
    const trips = allTrips(db, '2026-07-01');
    eq('March and June are two trips, not one that never ended', trips.length, 2);
    eq('… both closed on their return', trips[1].closedBy, 'return');
    eq('… and June is measured from PDT, the offset March came home to', trips[1].homeOffsetMin, UTC_MINUS_7);
  }

  // (f) A FIRST-EVER ROW THAT IS INBOUND. `observeTimezone` writes the cursor and
  // no row on its first observation, so a build first launched abroad — or a
  // database restored abroad — makes its first row a RETURN leg. Without the
  // settle rule that opens a trip whose home is London and never closes.
  {
    const { db } = freshDb();
    seedSeam(db, { day: '2026-09-01', from: LONDON_SUMMER, to: UTC_MINUS_8, pair: PAIR_LA });
    const trips = allTrips(db, '2026-10-01');
    eq('an inbound first row opens a trip against the wrong home', trips[0].homeOffsetMin, LONDON_SUMMER);
    eq('… and three weeks of stillness is what closes it', trips[0].closedBy, 'settled');
    eq('… on day 22', trips[0].closedOn, '2026-09-23');
    eq('… having called 21 days away', trips[0].awayDays.length, TRIP_SETTLE_DAYS);
    eq('day 22 is home again', tripOn(trips, '2026-09-23'), null);

    // …and the NEXT trip opens against the offset the settle left ARC sitting in.
    seedSeam(db, { day: '2026-10-10', from: UTC_MINUS_8, to: LONDON_SUMMER, pair: PAIR_LONDON });
    const healed = allTrips(db, '2026-10-15');
    eq('the next trip opens against the re-seated home', healed[1].homeOffsetMin, UTC_MINUS_8);
  }

  // (g) A RELOCATION, THEN A LATER TRIP. Same self-heal, the other way round:
  // the move opens a trip that settles, and the trip taken from the new city is
  // measured against the new city.
  {
    const { db } = freshDb();
    seedSeam(db, { day: '2026-01-05', from: UTC_MINUS_8, to: LONDON_WINTER, pair: PAIR_LONDON });
    seedSeam(db, { day: '2026-06-01', from: LONDON_SUMMER, to: PARIS_SUMMER, pair: PAIR_PARIS });
    seedSeam(db, { day: '2026-06-05', from: PARIS_SUMMER, to: LONDON_SUMMER, pair: PAIR_LONDON });
    const trips = allTrips(db, '2026-06-30');
    eq('the move settles rather than swallowing every later trip', trips[0].closedBy, 'settled');
    eq('the trip from the new city is its own', trips.length, 2);
    eq('… measured against the new home', trips[1].homeOffsetMin, LONDON_SUMMER);
    eq('… and closed by its return', trips[1].closedBy, 'return');
  }

  // (h) THE DECLARATION. A Traveling window you set closes an open trip the day
  // after it ends — the immediate correction for both cases above.
  {
    const { db } = freshDb();
    seedSeam(db, { day: '2026-09-12', from: UTC_MINUS_8, to: LONDON_SUMMER, pair: PAIR_LONDON });
    setMode(db, { mode: 'travel', startDate: '2026-09-12', endDate: '2026-09-20' });
    const trips = allTrips(db, '2026-09-30');
    eq('“I am back” closes the trip', trips[0].closedBy, 'declaration');
    eq('… the day after the window ends', trips[0].closedOn, '2026-09-21');
    eq('… so the window’s own last day is still an away day', trips[0].awayDays.at(-1), '2026-09-20');
  }

  // (i) WHERE THEY DISAGREE, THE EARLIER CLOSE WINS. A return row is a fact; a
  // later `until` simply ran over.
  {
    const { db: early } = freshDb();
    seedSeam(early, { day: '2026-09-12', from: UTC_MINUS_8, to: LONDON_SUMMER, pair: PAIR_LONDON });
    seedSeam(early, { day: '2026-09-25', from: LONDON_SUMMER, to: UTC_MINUS_8, pair: PAIR_LA });
    setMode(early, { mode: 'travel', startDate: '2026-09-12', endDate: '2026-09-18' });
    eq('a window that ends first wins', allTrips(early, '2026-09-30')[0].closedBy, 'declaration');

    const { db: late } = freshDb();
    seedSeam(late, { day: '2026-09-12', from: UTC_MINUS_8, to: LONDON_SUMMER, pair: PAIR_LONDON });
    seedSeam(late, { day: '2026-09-25', from: LONDON_SUMMER, to: UTC_MINUS_8, pair: PAIR_LA });
    setMode(late, { mode: 'travel', startDate: '2026-09-12', endDate: '2026-09-30' });
    eq('a return row that lands first wins', allTrips(late, '2026-10-05')[0].closedBy, 'return');
  }

  // (j) A WINDOW WITH NO ROW OPENS NOTHING. Los Angeles → Seattle is a real
  // trip and not an "away" one: the body is under the same offset, which is what
  // readiness's exclusion is about. The declaration closes trips; it never opens.
  {
    const { db } = freshDb();
    setMode(db, { mode: 'travel', startDate: '2026-09-12', endDate: '2026-09-20' });
    eq('a declared trip with no zone change is no trip here', allTrips(db, '2026-09-30').length, 0);
    eq('… and contributes no away days', awayDaysIn(db, '2026-09-01', '2026-09-30').size, 0);
  }

  // (k) A TRIP THAT OPENED BEFORE THE WINDOW IS STILL SEEN. The walk is
  // unbounded for exactly this: a windowed read would report the middle of a
  // journey as home.
  {
    const { db } = freshDb();
    seedSeam(db, { day: '2026-09-12', from: UTC_MINUS_8, to: LONDON_SUMMER, pair: PAIR_LONDON });
    seedSeam(db, { day: '2026-09-21', from: LONDON_SUMMER, to: UTC_MINUS_8, pair: PAIR_LA });
    eq('a two-day window in the middle still finds the trip', tripsIn(db, '2026-09-18', '2026-09-19').length, 1);
    const days = awayDaysIn(db, '2026-09-18', '2026-09-19');
    days.size === 2 && days.has('2026-09-18') && days.has('2026-09-19')
      ? ok('… and reports exactly the away days inside it')
      : bad('windowed away days', JSON.stringify([...days]));
  }

  // (l) THE CLOSE RULE, PROVED AGAINST ITS OWN OUTBOUND LEG.
  //
  // This is the assertion the seasonal leniency exists to survive. Phoenix does
  // not observe DST, so a trip that leaves it has home = −420; Los Angeles in
  // winter is −480 and its pair is {−480, −420}, which CONTAINS that home
  // offset. Tested as a close, the outbound flight would shut the trip it just
  // opened and no day of the journey would ever be away.
  {
    const { db } = freshDb();
    seedSeam(db, { day: '2026-01-10', from: PHOENIX, to: UTC_MINUS_8, pair: PAIR_LA });
    PAIR_LA.includes(PHOENIX)
      ? ok('the outbound row’s own arrival pair CONTAINS the home offset — the trap is live')
      : bad('the fixture does not reproduce the trap', JSON.stringify(PAIR_LA));
    const trips = allTrips(db, '2026-01-20');
    eq('…and the trip is open anyway: the opening row is never its own close', trips[0].closedOn, null);
    eq('… so the days since are away', trips[0].awayDays.length, 10);
    eq('… against Phoenix, the offset it left', trips[0].homeOffsetMin, PHOENIX);

    // The return does close it, on plain equality, because Phoenix's pair
    // degenerates to a single value and the leniency has nothing to add.
    seedSeam(db, { day: '2026-01-20', from: UTC_MINUS_8, to: PHOENIX, pair: PAIR_PHOENIX });
    const closed = allTrips(db, '2026-01-25');
    eq('the return closes it on exact equality', closed[0].closedBy, 'return');
    eq('… on the 20th', closed[0].closedOn, '2026-01-20');
  }

  // (m) A SEAM THAT CROSSED THE DAY BOUNDARY. The trip's bounds are the ARRIVAL
  // day at the start and the DEPARTURE day at the end, so a two-day seam never
  // steals a day from the run or gives one to it.
  {
    const { db } = freshDb();
    seedSeam(db, {
      day: '2026-09-12',
      fromDay: '2026-09-12',
      toDay: '2026-09-13',
      from: UTC_MINUS_8,
      to: LONDON_SUMMER,
      pair: PAIR_LONDON,
    });
    seedSeam(db, {
      day: '2026-09-21',
      fromDay: '2026-09-20',
      toDay: '2026-09-21',
      from: LONDON_SUMMER,
      to: UTC_MINUS_8,
      pair: PAIR_LA,
    });
    const trip = allTrips(db, '2026-09-30')[0];
    eq('the run starts after the arrival day', trip.awayDays[0], '2026-09-14');
    eq('… and ends before the departure day', trip.awayDays.at(-1), '2026-09-19');
    eq('… so both marked days of both seams stay seams', trip.awayDays.length, 6);
  }
}

// ---------------------------------------------------------------------------
console.log('\n14. the baselines exclude away days — one list, two sources');
{
  const TODAY = '2026-09-25';
  // A flat 50 ms at home; 20 ms on the days abroad, which is what a nine-day
  // trip actually does to HRV and exactly the shape that drags a 30-day mean
  // down for a month after the return.
  const AWAY = new Set([
    '2026-09-13',
    '2026-09-14',
    '2026-09-15',
    '2026-09-16',
    '2026-09-17',
    '2026-09-18',
    '2026-09-19',
    '2026-09-20',
  ]);
  const plant = (db, end) => {
    const rows = [];
    for (let i = 0; i <= 40; i++) {
      const date = shiftISODate(end, -i);
      rows.push({
        date,
        metricType: 'hrv',
        value: AWAY.has(date) ? 20 : 50,
        unit: 'ms',
        sourceDevice: 'apple_watch',
        sourceRawId: `hk:hrv:${date}`,
        startTime: null,
        endTime: null,
        metadata: {},
      });
    }
    upsertWearableRows(db, rows);
  };
  const flight = (db) => {
    seedSeam(db, { day: '2026-09-12', from: UTC_MINUS_8, to: LONDON_SUMMER, pair: PAIR_LONDON });
    seedSeam(db, { day: '2026-09-21', from: LONDON_SUMMER, to: UTC_MINUS_8, pair: PAIR_LA });
  };

  // Without the trip, the eight low days sit unmarked in the window and a normal
  // 50 ms morning reads as ABOVE a baseline they pulled down. That is the silent
  // failure this whole section exists for.
  const { db: unmarked } = freshDb();
  plant(unmarked, TODAY);
  const before = deriveReadiness(unmarked, TODAY, { now: new Date(2026, 8, 25, 9, 0) });
  /above your 30-day baseline/.test(before.readiness.detail)
    ? ok('with the away days counted, a normal morning reads as above baseline')
    : bad('unmarked post-trip baseline', before.readiness.detail);

  const { db } = freshDb();
  plant(db, TODAY);
  flight(db);
  const after = deriveReadiness(db, TODAY, { now: new Date(2026, 8, 25, 9, 0) });
  eq(
    'excluded, the baseline is the home days exactly — and says so',
    after.readiness.detail,
    'HRV 50 ms · at your 30-day baseline (home days)'
  );

  // THE EXCLUDED SET, AND ITS SOURCES. One list; a seam day and an away day are
  // in it for different reasons and the helper can still tell them apart. This
  // is the contract the day-statuses build extends.
  const exclusions = baselineExclusionsIn(db, '2026-08-25', TODAY, TODAY);
  exclusions.days.has('2026-09-12') && exclusions.days.has('2026-09-16')
    ? ok('the seam day and an away day are both in the one excluded list')
    : bad('excluded set', JSON.stringify([...exclusions.days]));
  hasExclusionSource(exclusions, 'timezone-change') && hasExclusionSource(exclusions, 'away')
    ? ok('… and each is still attributable to the source that put it there')
    : bad('sources not nameable', JSON.stringify([...exclusions.bySource.keys()]));
  eq(
    'the seam day is named by the seam source, not the trip',
    exclusions.bySource.get('away').has('2026-09-12'),
    false
  );

  // EXCLUDED, NOT DELETED. An away day still renders its own reading.
  const awayDay = deriveReadiness(db, '2026-09-16', { now: new Date(2026, 8, 16, 9, 0) });
  eq(
    'an away day still shows what the body actually did',
    awayDay.metrics.find((m) => m.id === 'hrv').value,
    '20 ms'
  );

  // POST-RETURN. The morning after landing grades against pre-trip home days,
  // not against the fortnight it just lived through.
  const { db: back } = freshDb();
  plant(back, '2026-09-22');
  flight(back);
  const landed = deriveReadiness(back, '2026-09-22', { now: new Date(2026, 8, 22, 9, 0) });
  eq(
    'the morning after landing grades against pre-trip home days',
    landed.readiness.detail,
    'HRV 50 ms · at your 30-day baseline (home days)'
  );

  // …AND ONLY WHILE AN AWAY DAY IS IN THE WINDOW. Once the trip has aged out of
  // the 30 days, the cohort clause goes: a distinction that made no difference
  // is noise about a distinction.
  const { db: settled } = freshDb();
  plant(settled, '2026-11-01');
  flight(settled);
  const long = deriveReadiness(settled, '2026-11-01', { now: new Date(2026, 10, 1, 9, 0) });
  !/home days/.test(long.readiness.detail)
    ? ok('once the trip is out of the window the cohort clause goes quiet')
    : bad('cohort clause outstayed the trip', long.readiness.detail);

  // THE NAMED EXCEPTION. `setsBaseline` is computed from days that were TRAINED,
  // which is already the right population — a travel week's sessions were real
  // sessions — so it takes no excluded set, and this is a claim about the source
  // rather than about one fixture.
  const source = readFileSync(new URL('../src/lib/home/readiness.ts', import.meta.url), 'utf8');
  const setsBlock = source.slice(source.indexOf('const setsBaseline ='), source.indexOf('const stepsToday'));
  !setsBlock.includes('oddDays')
    ? ok('the sets baseline takes no excluded set — the exception is in the code, not just the docs')
    : bad('setsBaseline started filtering', setsBlock);
}

// ---------------------------------------------------------------------------
console.log('\n15. a paused baseline says why it is paused');
{
  // Four home days of HRV, then a flight. The gate needs five, so the verdict is
  // still `unknown` — and the number it reports will not move for as long as the
  // trip lasts, because the days arriving do not count. A reader watching "1 more
  // day" hold at 1 for a fortnight is owed the reason.
  const plant = (db, dates) =>
    upsertWearableRows(
      db,
      dates.map((date) => ({
        date,
        metricType: 'hrv',
        value: 50,
        unit: 'ms',
        sourceDevice: 'apple_watch',
        sourceRawId: `hk:hrv:${date}`,
        startTime: null,
        endTime: null,
        metadata: {},
      }))
    );
  const HOME = ['2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];

  const { db } = freshDb();
  plant(db, [...HOME, '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16']);
  seedSeam(db, { day: '2026-09-12', from: UTC_MINUS_8, to: LONDON_SUMMER, pair: PAIR_LONDON });
  const away = deriveReadiness(db, '2026-09-16', { now: new Date(2026, 8, 16, 9, 0) });
  const note = away.pillars.find((p) => p.label === 'Recovery').note;
  eq(
    'the wait names the cohort and the reason, not just a number',
    note,
    '1 more home day of HRV or resting heart rate before a baseline — paused while away from UTC−8'
  );
  eq('… and it is still an honest count', baselineDaysRemaining(
    [...HOME, '2026-09-13', '2026-09-14', '2026-09-15'].map((date) => ({ date, value: 50 })),
    '2026-09-16',
    baselineExclusionsIn(db, '2026-08-16', '2026-09-16', '2026-09-16').days
  ), 1);

  // DAY 22. The trip settles, the pause is over, and the wait goes back to the
  // plain sentence — ARC has stopped calling this place away.
  const { db: settled } = freshDb();
  plant(settled, [...HOME, '2026-10-04']);
  seedSeam(settled, { day: '2026-09-12', from: UTC_MINUS_8, to: LONDON_SUMMER, pair: PAIR_LONDON });
  const home = deriveReadiness(settled, '2026-10-04', { now: new Date(2026, 9, 4, 9, 0) });
  const settledNote = home.pillars.find((p) => p.label === 'Recovery').note;
  !/paused/.test(settledNote)
    ? ok('on day 22 the pause clause is gone — ARC calls this place home')
    : bad('still paused past the settle', settledNote);
  eq('and no trip is open to pause it', currentTrip(settled, '2026-10-04'), null);
}

// ---------------------------------------------------------------------------
console.log('\n21. the Coach’s line during a trip — one shape or the other, never both');
{
  const { db } = freshDb();
  seedSeam(db, { day: '2026-09-12', from: UTC_MINUS_8, to: LONDON_SUMMER, pair: PAIR_LONDON });
  const lineOn = (y, m, d) =>
    buildTurnContext(db, new Date(y, m, d, 9, 0))
      .split('\n')
      .find((l) => l.startsWith('Timezone:')) ?? null;

  const seam = lineOn(2026, 8, 12);
  seam && seam.includes('changed today') && !/day \d+ away/.test(seam)
    ? ok(`the seam day prints the seam line: "${seam}"`)
    : bad('seam day', seam);

  const day1 = lineOn(2026, 8, 13);
  eq(
    'the first morning abroad prints the trip',
    day1,
    'Timezone: UTC+1 — day 1 away from UTC−8 (left 2026-09-12, 9h east); readiness baseline is home days only'
  );

  // DAY 4 IS INSIDE THE SHIPPED FIVE-DAY TAIL, and the trip still wins: the away
  // line carries the seam fact itself, so the tail would add nothing.
  const day4 = lineOn(2026, 8, 16);
  day4.includes('day 4 away') && !day4.includes('changed')
    ? ok('inside the five-day tail the trip line wins — never both')
    : bad('precedence inside the tail', day4);

  // THE COST. Uncached, on every away-day turn, so it is measured.
  const bare = buildTurnContext(freshDb().db, new Date(2026, 8, 16, 9, 0));
  const withTrip = buildTurnContext(db, new Date(2026, 8, 16, 9, 0));
  const delta = Math.round((withTrip.length - bare.length) / 2.8);
  delta < 45
    ? ok(`the away line costs ~${delta} uncached tokens, and only while a trip is open`)
    : bad('away line over budget', `${delta} tok`);

  // DAY 22. The trip has settled; nothing is said, because there is nothing
  // standing to say.
  eq('day 22 says nothing at all', lineOn(2026, 9, 4), null);

  // THE RETURN SEAM, AND THE TAIL AFTER IT.
  const { db: home } = freshDb();
  seedSeam(home, { day: '2026-09-12', from: UTC_MINUS_8, to: LONDON_SUMMER, pair: PAIR_LONDON });
  seedSeam(home, { day: '2026-09-21', from: LONDON_SUMMER, to: UTC_MINUS_8, pair: PAIR_LA });
  const homeLineOn = (y, m, d) =>
    buildTurnContext(home, new Date(y, m, d, 9, 0))
      .split('\n')
      .find((l) => l.startsWith('Timezone:')) ?? null;
  const returned = homeLineOn(2026, 8, 21);
  returned.includes('changed today') && !/day \d+ away/.test(returned)
    ? ok('the return seam prints the seam line, not a trip')
    : bad('return seam', returned);
  const tail = homeLineOn(2026, 8, 24);
  tail.includes('changed 2026-09-21') && !/day \d+ away/.test(tail)
    ? ok('and the five-day tail prints only after the trip has closed')
    : bad('tail after close', tail);
}

// ---------------------------------------------------------------------------
console.log('\n23. the 0060 columns, and what the observer now writes into them');
{
  const { db, raw } = freshDb();
  // THE OBSERVER WRITES THE PROBE. Host TZ is America/Los_Angeles, so the pair
  // the observer has in hand at this instant is LA's own {−480, −420} — the
  // ARRIVAL zone, which is the one whose seasons the close rule asks about.
  setTimezoneCursor(db, UTC_PLUS_1);
  const row = observeTimezone(db, WINTER_NOON);
  eq('the arrival zone’s January offset is kept', row.zone_jan_offset_min, UTC_MINUS_8);
  eq('… and its July one', row.zone_jul_offset_min, UTC_MINUS_7);
  eq('… beside the offsets 0053 already stored', row.to_offset_min, UTC_MINUS_8);

  // A RESTORED CURSOR PRODUCES EXACTLY ONE ROW. The cursor rides inside the
  // ARCB1 snapshot, so a database restored in another zone synthesises one row
  // on the next launch's observation — one, not one per foreground.
  eq('a second observation at the same offset writes nothing', observeTimezone(db, WINTER_NOON), null);
  eq(
    'so the restore is one row, not one per foreground',
    raw.prepare('SELECT count(*) c FROM timezone_changes').get().c,
    1
  );

  // THE CHECKS. Nullable, so a 0053 row stays valid; ±840 is the real range.
  const insert = (id, jan, jul) =>
    raw.exec(
      `INSERT INTO timezone_changes
         (id, changed_at, from_offset_min, to_offset_min, from_local_date, to_local_date,
          zone_jan_offset_min, zone_jul_offset_min)
       VALUES ('${id}', '2026-02-01T20:00:00.000Z', -480, 60, '2026-02-01', '2026-02-01', ${jan}, ${jul})`
    );
  let nullOk = true;
  try {
    insert('pair-null', 'NULL', 'NULL');
  } catch {
    nullOk = false;
  }
  nullOk ? ok('a NULL pair is accepted — every 0053 row is still a valid row') : bad('NULL pair rejected');
  let refused = false;
  try {
    insert('pair-bad', '0', '841');
  } catch {
    refused = true;
  }
  refused ? ok('±841 is refused, as the two offset columns already are') : bad('841 accepted');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
