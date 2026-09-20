/**
 * Headless test of the configurable day boundary (B3) — src/lib/db/date.ts, the
 * one place ARC decides which day an instant belongs to, plus the preference
 * behind it and the four subsystems that have to agree on the answer. Real
 * SQLite via node:sqlite; op-sqlite is never loaded. Run: npm run db:test.
 *
 * §1  attribution — 03:59 vs 04:01 against a 04:00 boundary
 * §2  the default is unchanged — "00:00" must be byte-identical to the old
 *     calendar-day behaviour, because it is what every existing install has
 * §3  DST — the spring-forward case a millisecond-subtraction implementation
 *     gets wrong, asserted against the wrong answer as well as the right one
 * §4  mission / nutrition / water / readiness all read the SAME day
 * §5  the source scan — no second "today" may be computed outside date.ts, and
 *     the scan is proved able to fail before it is trusted to pass
 * §6  the preference round-trip
 * §7  the day cursor only ever moves FORWARD — the westbound date-line case
 *     three subsystems each met separately, and the DST change that must not be
 *     mistaken for it
 * §8  the day PICKER (C1) — its bounds are the logical today and the caller's
 *     floor, it clamps a day that is already outside them, and its labels are
 *     the hand-rolled ones Hermes leaves it no choice about
 * §8b the picker looking FORWARD (2026-09-19) — `latest` is now whatever the
 *     caller allows and `today` is a bound of its own, so the words and the way
 *     home stay on the logical today while the arrows reach a horizon
 *
 * **§3 pins the timezone.** The boundary rule is DST-sensitive by nature, so the
 * only way to test it is to run in a zone that has a transition. TZ is set to
 * America/New_York before any Date is constructed, and §3 refuses to run rather
 * than pass vacuously if the runtime ignored it — a DST test that silently
 * skipped would be worse than no DST test.
 */
process.env.TZ = 'America/New_York';

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  DEFAULT_DAY_STARTS_AT,
  formatLocalDate,
  forwardCursor,
  getDayStartsAt,
  localDayUtcRange,
  localWeekRange,
  logicalDate,
  normalizeDayStartsAt,
  setDayStartsAt,
  shiftISODate,
  todayISODate,
} from '../src/lib/db/date.ts';
import {
  boundsToday,
  canStepBack,
  canStepForward,
  dayLabel,
  dayPhrase,
  stepDay,
  weekdayName,
} from '../src/lib/utils/day-cursor.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { deriveReadiness } from '../src/lib/home/readiness.ts';
import { generateMissionForDay } from '../src/lib/db/repositories/mission-generate.ts';
import {
  getOrCreateDailyLog,
  insertMissionItem,
  listMission,
} from '../src/lib/db/repositories/mission.ts';
import { todayTotals } from '../src/lib/db/repositories/nutrition.ts';
import {
  getDayStartsAtPreference,
  getPreferences,
  setDayStartsAtPreference,
  setUnitPreference,
} from '../src/lib/db/repositories/user.ts';
import { listWaterEntries, logWater } from '../src/lib/db/repositories/water.ts';
import { upsertWearableRows } from '../src/lib/db/repositories/wearables.ts';

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
  return { database, executor };
}

function freshDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const { database, executor } = makeDb(raw);
  migrate(executor, MIGRATIONS);
  return database;
}

/**
 * Run `fn` with `new Date()` and `Date.now()` pinned to one instant, so the
 * ambient `todayISODate()` every screen calls can be exercised end to end. Every
 * other Date behaviour (parsing, Date.UTC, component construction) is inherited
 * untouched.
 */
function withFrozenClock(at, fn) {
  const RealDate = Date;
  const fixed = at.getTime();
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() {
      return fixed;
    }
  }
  globalThis.Date = FrozenDate;
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

// ---------------------------------------------------------------------------
console.log('1. attribution — a 04:00 boundary moves the small hours to yesterday');
{
  const B = '04:00';
  // 2026-09-14 is a Monday well clear of any DST transition.
  eq('03:59 is yesterday', logicalDate(new Date(2026, 8, 14, 3, 59), B), '2026-09-13');
  eq('04:01 is today', logicalDate(new Date(2026, 8, 14, 4, 1), B), '2026-09-14');
  eq(
    '04:00 exactly is today (the boundary opens the day)',
    logicalDate(new Date(2026, 8, 14, 4, 0), B),
    '2026-09-14'
  );
  eq('00:00 is yesterday', logicalDate(new Date(2026, 8, 14, 0, 0), B), '2026-09-13');
  eq('23:59 is still today', logicalDate(new Date(2026, 8, 14, 23, 59), B), '2026-09-14');

  // Month and year rollover come from the Date constructor, not from arithmetic.
  eq(
    '01:00 on the 1st rolls back a month',
    logicalDate(new Date(2026, 8, 1, 1, 0), B),
    '2026-08-31'
  );
  eq('01:00 on Jan 1 rolls back a year', logicalDate(new Date(2026, 0, 1, 1, 0), B), '2025-12-31');
  eq(
    '01:00 on Mar 1 in a leap year lands on Feb 29',
    logicalDate(new Date(2028, 2, 1, 1, 0), B),
    '2028-02-29'
  );

  // A boundary with minutes, and the two failure modes of a bad one.
  eq('04:30 boundary, 04:15', logicalDate(new Date(2026, 8, 14, 4, 15), '04:30'), '2026-09-13');
  eq('04:30 boundary, 04:45', logicalDate(new Date(2026, 8, 14, 4, 45), '04:30'), '2026-09-14');
  eq(
    'a malformed boundary reads as midnight',
    logicalDate(new Date(2026, 8, 14, 1, 0), '4am'),
    '2026-09-14'
  );
  eq(
    'an out-of-range boundary reads as midnight',
    logicalDate(new Date(2026, 8, 14, 1, 0), '25:00'),
    '2026-09-14'
  );

  eq('normalizeDayStartsAt keeps a good value', normalizeDayStartsAt('04:00'), '04:00');
  eq('normalizeDayStartsAt rejects junk', normalizeDayStartsAt('nope'), DEFAULT_DAY_STARTS_AT);
  eq('normalizeDayStartsAt rejects a non-string', normalizeDayStartsAt(4), DEFAULT_DAY_STARTS_AT);
}

// ---------------------------------------------------------------------------
console.log('\n2. the default is the old behaviour, hour for hour');
{
  // Every hour of a day, plus the edges: with "00:00" the logical day and the
  // plain calendar day must never differ. This is the compatibility contract for
  // every install that never touches the setting.
  let drift = null;
  for (let day = 1; day <= 28 && drift === null; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const at = new Date(2026, 1, day, hour, 30);
      if (todayISODate(at, DEFAULT_DAY_STARTS_AT) !== formatLocalDate(at)) {
        drift = at.toISOString();
        break;
      }
    }
  }
  drift === null
    ? ok('672 instants: "00:00" attribution === the local calendar day')
    : bad('midnight default drifted', drift);

  eq(
    'midnight: 00:00 is its own day',
    logicalDate(new Date(2026, 8, 14, 0, 0), '00:00'),
    '2026-09-14'
  );
  eq('the installed default is 00:00', getDayStartsAt(), DEFAULT_DAY_STARTS_AT);

  // localDayUtcRange under the default is still the plain calendar day.
  const range = localDayUtcRange(new Date(2026, 8, 14, 13, 0), '00:00');
  eq(
    'default range starts at local midnight',
    range.startUtc,
    new Date(2026, 8, 14, 0, 0, 0, 0).toISOString()
  );
  eq(
    'default range ends at the next local midnight',
    range.endUtc,
    new Date(2026, 8, 15, 0, 0, 0, 0).toISOString()
  );
}

// ---------------------------------------------------------------------------
console.log('\n3. DST — the case millisecond arithmetic gets wrong');
{
  // 2026-03-08 is the US spring forward (02:00 → 03:00 EST→EDT).
  const springBefore = new Date(2026, 2, 7, 12, 0).getTimezoneOffset();
  const springAfter = new Date(2026, 2, 8, 12, 0).getTimezoneOffset();
  if (springBefore === springAfter) {
    bad(
      'timezone could not be pinned',
      'TZ=America/New_York did not take effect, so the DST assertions would pass vacuously'
    );
  } else {
    const B = '04:00';

    // THE case. Local 04:30 on the change day is past a 04:00 boundary, so it is
    // that day — full stop. Subtracting four hours from the instant instead
    // lands at 23:30 EST the evening before and answers 2026-03-07.
    const springMorning = new Date(2026, 2, 8, 4, 30);
    eq('spring forward, local 04:30 is the new day', logicalDate(springMorning, B), '2026-03-08');
    const naive = formatLocalDate(new Date(springMorning.getTime() - 4 * 3_600_000));
    naive === '2026-03-07'
      ? ok('…and the millisecond-subtraction implementation would have said 2026-03-07')
      : bad('the DST trap did not reproduce', naive);

    eq(
      'spring forward, local 03:30 is still yesterday',
      logicalDate(new Date(2026, 2, 8, 3, 30), B),
      '2026-03-07'
    );
    eq(
      'spring forward, local 01:30 is still yesterday',
      logicalDate(new Date(2026, 2, 8, 1, 30), B),
      '2026-03-07'
    );

    // 2026-11-01 is the fall back (02:00 → 01:00 EDT→EST): 01:30 happens twice.
    // Both occurrences read 01:30 on the wall clock, so both are yesterday —
    // which is the whole point of comparing the clock rather than the instant.
    const fallBack = new Date(2026, 10, 1, 1, 30);
    eq('fall back, local 01:30 is yesterday', logicalDate(fallBack, B), '2026-10-31');
    eq(
      'fall back, local 04:30 is the day itself',
      logicalDate(new Date(2026, 10, 1, 4, 30), B),
      '2026-11-01'
    );

    // The window over a short/long day is 23 or 25 hours, not a hardcoded
    // 86,400,000 ms. Note WHICH logical day that is: under a 04:00 boundary the
    // 02:00 transition falls inside the day that STARTS the afternoon before, so
    // it is 7 Mar 04:00 → 8 Mar 04:00 that loses the hour, not 8 Mar → 9 Mar.
    const shortDay = localDayUtcRange(new Date(2026, 2, 7, 12, 0), B);
    const shortMs = new Date(shortDay.endUtc).getTime() - new Date(shortDay.startUtc).getTime();
    eq('the logical day holding the spring forward is 23 hours', shortMs, 23 * 3_600_000);
    const longDay = localDayUtcRange(new Date(2026, 9, 31, 12, 0), B);
    const longMs = new Date(longDay.endUtc).getTime() - new Date(longDay.startUtc).getTime();
    eq('the logical day holding the fall back is 25 hours', longMs, 25 * 3_600_000);
    // And a day clear of the transition is still exactly 24.
    const plainDay = localDayUtcRange(new Date(2026, 2, 8, 12, 0), B);
    const plainMs = new Date(plainDay.endUtc).getTime() - new Date(plainDay.startUtc).getTime();
    eq('the day after the transition is back to 24 hours', plainMs, 24 * 3_600_000);

    // Calendar arithmetic crosses a transition without gaining or losing a day.
    eq('shiftISODate across spring forward', shiftISODate('2026-03-07', 1), '2026-03-08');
    eq('shiftISODate across fall back', shiftISODate('2026-10-31', 1), '2026-11-01');
  }
}

// ---------------------------------------------------------------------------
console.log('\n4. mission, nutrition, water and readiness read the same day');
{
  const db = freshDb();
  // 01:30 local — in the small hours, so the boundary is load-bearing. Under a
  // 04:00 start this is still 2026-09-13; under the default it is 2026-09-14.
  const smallHours = new Date(2026, 8, 14, 1, 30);

  setDayStartsAtPreference(db, '04:00');
  setDayStartsAt(getDayStartsAtPreference(db));

  withFrozenClock(smallHours, () => {
    // The exact expression every caller writes: `todayISODate()`, no arguments.
    const today = todayISODate();
    eq('the ambient today is the previous calendar day', today, '2026-09-13');

    generateMissionForDay(db, today);
    insertMissionItem(db, getOrCreateDailyLog(db, today).id, 'habit', {
      id: 'probe',
      title: 'Sunlight',
      status: 'pending',
      category: null,
      dose: null,
      why: null,
      estimatedMinutes: null,
      protocol: null,
      scheduledTime: null,
    });
    db.run(
      `INSERT INTO meals (id, date, name, source, kcal) VALUES ('m1', ?, 'Late plate', 'manual', 700)`,
      [today]
    );
    logWater(db, today, 500);
    upsertWearableRows(db, [
      {
        date: today,
        metricType: 'steps',
        value: 8000,
        unit: 'count',
        sourceDevice: 'apple_health',
        sourceRawId: `hk:steps:${today}`,
        startTime: null,
        endTime: null,
        metadata: {},
      },
    ]);

    const missionDays = db.all(`SELECT DISTINCT date FROM daily_logs`).map((r) => r.date);
    eq('the mission generated for exactly one day', missionDays.length, 1);
    eq('…and it is the logical today', missionDays[0], today);
    listMission(db, today).length > 0
      ? ok('the mission reads back on the logical today')
      : bad('the mission did not read back on the logical today');

    eq('nutrition totals land on the logical today', todayTotals(db, today).kcal, 700);
    eq('water lands on the logical today', listWaterEntries(db, today).length, 1);

    // readiness takes `today = todayISODate()` by DEFAULT — so this call proves
    // the ambient boundary reaches it, not just that it was handed the answer.
    const steps = deriveReadiness(db).metrics.find((m) => m.label === 'Steps');
    eq('readiness found today’s steps through its own default', steps?.detail, 'today');

    // The discriminator: under the midnight default the same call looks at
    // 2026-09-14, where nothing was written.
    setDayStartsAt(DEFAULT_DAY_STARTS_AT);
    eq('the ambient today reverts with the setting', todayISODate(), '2026-09-14');
    const midnightSteps = deriveReadiness(db).metrics.find((m) => m.label === 'Steps');
    eq(
      '…and readiness then finds nothing, so the day really did move',
      midnightSteps?.detail,
      'No data yet'
    );

    // The week and the instant-range windows agree with the same today.
    setDayStartsAt('04:00');
    const week = localWeekRange();
    week.start <= todayISODate() && todayISODate() <= week.end
      ? ok('localWeekRange brackets the logical today')
      : bad('localWeekRange disagrees with the logical today', JSON.stringify(week));
    eq('the week is the one containing 2026-09-13 (Sun)', week.start, '2026-09-07');

    const range = localDayUtcRange();
    const startsAtBoundary = new Date(range.startUtc).getHours() === 4;
    startsAtBoundary
      ? ok('localDayUtcRange opens at the boundary, not at midnight')
      : bad('localDayUtcRange ignored the boundary', range.startUtc);
    new Date(range.startUtc) <= smallHours && smallHours < new Date(range.endUtc)
      ? ok('…and the 01:30 instant falls inside it')
      : bad('the instant fell outside its own logical day', range.startUtc);
  });

  setDayStartsAt(DEFAULT_DAY_STARTS_AT);
}

// ---------------------------------------------------------------------------
console.log('\n5. source scan — nothing outside date.ts may compute a day of its own');
{
  /**
   * The accumulating lesson: a rule that lives only in a docblock is a rule that
   * gets re-broken. These four patterns are every textual way a `YYYY-MM-DD` has
   * ever been derived in this codebase, so a NEW independent "today" cannot be
   * written without tripping one of them. Deliberately no allowlist — an
   * exception list is how this kind of scan rots.
   */
  const BANNED = [
    {
      name: 'a hand-rolled ${y}-${m}-${d} (getMonth() + 1)',
      re: /getMonth\(\)\s*\+\s*1/,
      fix: 'use formatLocalDate / logicalDate from src/lib/db/date.ts',
    },
    {
      name: 'toISOString().slice(0, …) — the UTC-day trap',
      re: /toISOString\(\)\s*\.\s*(?:slice|substring)\s*\(\s*0/,
      fix: 'a UTC slice is not a local day; use src/lib/db/date.ts',
    },
    {
      name: "toISOString().split('T')",
      re: /toISOString\(\)\s*\.\s*split\s*\(/,
      fix: 'a UTC split is not a local day; use src/lib/db/date.ts',
    },
    {
      name: 'new Date().get… — an ambient clock read componentwise',
      re: /new Date\(\)\s*\.\s*get[A-Z]/,
      fix: 'take `now` as an injectable argument and route it through todayISODate',
    },
  ];

  const ROOT = join(import.meta.dirname, '..');
  const ALLOWED = join('src', 'lib', 'db', 'date.ts');

  const sources = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) sources.push(full);
    }
  };
  walk(join(ROOT, 'src'));
  walk(join(ROOT, 'app'));

  sources.length > 200
    ? ok(`scanned ${sources.length} source files`)
    : bad('the scan found suspiciously few files', String(sources.length));

  const violations = [];
  for (const file of sources) {
    const rel = relative(ROOT, file);
    if (rel === ALLOWED || rel === ALLOWED.split(sep).join('/')) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const rule of BANNED) {
        if (rule.re.test(line)) violations.push(`${rel}:${i + 1} — ${rule.name} (${rule.fix})`);
      }
    });
  }
  violations.length === 0
    ? ok('no second "today" is computed anywhere outside src/lib/db/date.ts')
    : bad(
        `${violations.length} independent day computation(s)`,
        '\n    ' + violations.join('\n    ')
      );

  // A scan nobody has seen fail is a scan nobody should trust. Each rule is run
  // against a line that must trip it, so a regex broken by a later edit is
  // caught here rather than by silently passing forever.
  const PROBES = [
    'const d = `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;',
    'const d = at.toISOString().slice(0, 10);',
    "const d = at.toISOString().split('T')[0];",
    'const day = new Date().getDate();',
  ];
  const missed = BANNED.filter((rule, i) => !rule.re.test(PROBES[i])).map((r) => r.name);
  missed.length === 0
    ? ok('every scan rule was proved able to fail')
    : bad('a scan rule no longer matches its own probe', missed.join(', '));

  // …and proved not to fire on the legitimate neighbours it sits next to.
  const INNOCENT = [
    'const stamp = new Date().toISOString();', // a timestamp, not a day
    'const label = MONTHS[d.getMonth()] ?? "";', // display formatting
    'const [now, setNow] = useState(() => new Date());', // a React clock tick
    'return parsed.getUTCMonth() === m - 1;', // a shape validator
  ];
  const falsePositives = INNOCENT.filter((line) => BANNED.some((r) => r.re.test(line)));
  falsePositives.length === 0
    ? ok('and not to fire on the legitimate uses beside them')
    : bad('the scan flagged innocent code', falsePositives.join(' | '));
}

// ---------------------------------------------------------------------------
console.log('\n6. the preference round-trips and keeps its neighbours');
{
  const db = freshDb();
  eq('a fresh profile starts at midnight', getDayStartsAtPreference(db), DEFAULT_DAY_STARTS_AT);

  setUnitPreference(db, 'weight', 'kg');
  eq('set returns the stored value', setDayStartsAtPreference(db, '04:00'), '04:00');
  eq('…and it reads back', getDayStartsAtPreference(db), '04:00');
  eq('a neighbouring preference survived the write', getPreferences(db).units.weight, 'kg');

  eq('junk is refused, not stored', setDayStartsAtPreference(db, '4am'), DEFAULT_DAY_STARTS_AT);
  eq('…and reads back as the default', getDayStartsAtPreference(db), DEFAULT_DAY_STARTS_AT);

  setDayStartsAtPreference(db, '04:00');
  const raw = db.get('SELECT preferences FROM users LIMIT 1').preferences;
  JSON.parse(raw).day?.startsAt === '04:00'
    ? ok('it lands in the preferences blob under `day.startsAt` — no migration')
    : bad('unexpected storage shape', raw);

  // Changing the setting must not rewrite a single stored date.
  db.run(
    `INSERT INTO meals (id, date, name, source) VALUES ('old', '2026-09-13', 'History', 'manual')`
  );
  setDayStartsAtPreference(db, '06:00');
  eq(
    'an existing row keeps the date it was filed under',
    db.get(`SELECT date FROM meals WHERE id = 'old'`).date,
    '2026-09-13'
  );
}

// ---------------------------------------------------------------------------
console.log('\n7. the day cursor only ever moves FORWARD');
{
  // Three subsystems carry a "last seen day" and compare it to todayISODate().
  // Two of them hand-patched a westbound-travel guard with a comment; the third
  // (use-today-mission.ts) made the same comparison WITHOUT one, so the day the
  // user was looking at could flicker backwards and the next completion could
  // land on a day he had already finished. `forwardCursor` is the one guard.

  // A westbound date-line day, as the device actually experiences it: the wall
  // clock reads 2026-09-15 08:00 in Tokyo, then 2026-09-14 16:00 in Los Angeles
  // for very nearly the same instant. todayISODate reads local components, so
  // these two Dates ARE the two sides of that flight.
  const beforeTakeoff = todayISODate(new Date(2026, 8, 15, 8, 0));
  const afterLanding = todayISODate(new Date(2026, 8, 14, 16, 0));
  eq('westbound: the clock says yesterday after landing', afterLanding, '2026-09-14');
  afterLanding !== beforeTakeoff
    ? ok('…so the UNGUARDED comparison would have switched the day backwards')
    : bad('the westbound case did not reproduce', afterLanding);
  eq(
    'the cursor holds the later day instead of rewinding',
    forwardCursor(beforeTakeoff, afterLanding),
    '2026-09-15'
  );

  // Forward motion is untouched, and a SKIPPED date is allowed: eastbound over
  // the line genuinely misses one, and pretending otherwise would invent a day.
  eq('an ordinary rollover advances', forwardCursor('2026-09-14', '2026-09-15'), '2026-09-15');
  eq('eastbound may skip a date', forwardCursor('2026-09-14', '2026-09-16'), '2026-09-16');
  eq('the same day is a no-op', forwardCursor('2026-09-15', '2026-09-15'), '2026-09-15');
  eq('a first run has nothing stored', forwardCursor(null, '2026-09-15'), '2026-09-15');
  eq('…and undefined reads the same', forwardCursor(undefined, '2026-09-15'), '2026-09-15');

  // The epoch-millisecond form, which is what the backup throttle cursors on.
  eq('milliseconds: a future stamp wins', forwardCursor(2_000, 1_000), 2_000);
  eq('milliseconds: a past stamp does not', forwardCursor(1_000, 2_000), 2_000);

  // DST MUST NOT COUNT. The fall back moves the wall clock backwards by an hour
  // — the same DIRECTION as westbound travel — but it never leaves the calendar
  // day, so the logical day is identical on both sides and the cursor sees
  // nothing at all. Asserted under the default boundary and under the house
  // 04:00 one, because it is the boundary that decides what a day is.
  // 2026-11-01 01:30 happens twice; the second occurrence is an hour later as an
  // INSTANT and identical on the wall clock, which is the clock going backwards.
  const fallBackFirst = new Date(2026, 10, 1, 1, 30); // 01:30 EDT
  const fallBackRepeat = new Date(fallBackFirst.getTime() + 3_600_000); // 01:30 EST
  fallBackRepeat.getHours() === 1 && fallBackRepeat.getMinutes() === 30
    ? ok('fall back: an hour passes and the wall clock still reads 01:30 — the trap is real')
    : bad('DST fall back did not reproduce', 'TZ=America/New_York did not take effect');
  for (const boundary of [DEFAULT_DAY_STARTS_AT, '04:00']) {
    const before = todayISODate(fallBackFirst, boundary);
    const after = todayISODate(fallBackRepeat, boundary);
    before === after && forwardCursor(before, after) === after
      ? ok(`fall back under a ${boundary} boundary is not a day change and holds nothing`)
      : bad(`DST counted as travel under ${boundary}`, `${before} → ${after}`);
  }
  // …and spring forward, the other direction, is equally invisible.
  eq(
    'spring forward does not advance the day either',
    forwardCursor(
      todayISODate(new Date(2026, 2, 8, 1, 30), DEFAULT_DAY_STARTS_AT),
      todayISODate(new Date(2026, 2, 8, 3, 30), DEFAULT_DAY_STARTS_AT)
    ),
    '2026-03-08'
  );

  // And the routing, so the guard cannot be quietly dropped from one of the
  // three again — which is exactly how use-today-mission.ts came to be missing
  // it while its two neighbours carried a comment about it.
  const ROOT = join(import.meta.dirname, '..');
  const missing = [
    join('src', 'hooks', 'use-today-mission.ts'),
    join('src', 'lib', 'ai', 'pass-schedule.ts'),
    join('src', 'lib', 'backup', 'snapshot.ts'),
  ].filter((rel) => !readFileSync(join(ROOT, rel), 'utf8').includes('forwardCursor'));
  missing.length === 0
    ? ok('all three day-cursor sites route through forwardCursor')
    : bad('a cursor site dropped the guard', missing.join(', '));
}

// ---------------------------------------------------------------------------
console.log('\n8. the day picker — bounded by the LOGICAL today, never the calendar');
{
  // C1's picker (src/components/ui/day-picker.tsx) is the first control in the
  // app that lets the user aim at a day OTHER than today, so it is the first
  // thing that could offer a day the rest of ARC says has not started. Its
  // arithmetic lives in src/lib/utils/day-cursor.ts and is all shiftISODate;
  // what is tested here is the CLAMP and the words.
  const today = '2026-09-14'; // a Monday
  const open = { latest: today };
  const floored = { latest: today, earliest: '2026-09-10' };

  // The forward bound. Both halves: the arrow must know it is dead AND the
  // step must refuse — a clamp alone leaves a live-looking arrow that does
  // nothing, and a disabled arrow alone leaves another path free to step past.
  eq('the forward arrow is dead on today', canStepForward(today, open), false);
  eq('stepping forward from today stays on today', stepDay(today, 1, open), today);
  eq('…and ten steps forward is still today', stepDay(today, 10, open), today);
  eq('the forward arrow is live in the past', canStepForward('2026-09-13', open), true);
  eq('stepping forward from yesterday lands on today', stepDay('2026-09-13', 1, open), today);

  // The back bound is the caller's floor (the first meal ever logged).
  eq('the back arrow is dead on the floor', canStepBack('2026-09-10', floored), false);
  eq('stepping back from the floor stays put', stepDay('2026-09-10', -1, floored), '2026-09-10');
  eq('the back arrow is live above the floor', canStepBack('2026-09-11', floored), true);
  eq('with no floor the back arrow is always live', canStepBack('2019-01-01', open), true);

  // A day that is ALREADY out of bounds is pulled back inside rather than kept
  // there — a `?date=` param from a stale link, or a screen left open across
  // midnight, must not become a way to select tomorrow.
  eq('an out-of-bounds day clamps forward-bound', stepDay('2026-12-25', 0, open), today);
  eq('an out-of-bounds day clamps to the floor', stepDay('2020-01-01', 0, floored), '2026-09-10');

  // Month ends and leap days fall out of shiftISODate; asserted here because
  // the picker is where a user actually walks across one.
  eq(
    'stepping back across a month end',
    stepDay('2026-03-01', -1, { latest: today }),
    '2026-02-28'
  );
  eq('…and across a leap day', stepDay('2024-03-01', -1, { latest: '2026-12-31' }), '2024-02-29');

  // THE BOUND IS THE LOGICAL TODAY, which is the whole reason this section sits
  // in the boundary suite. Under a 04:00 boundary, 01:00 on Tuesday the 15th is
  // still Monday the 14th — so a picker bounded by todayISODate() refuses to
  // step onto the 15th, and a picker bounded by the calendar would have allowed
  // it. Asserted against the wrong answer too, so the test cannot pass by
  // coincidence.
  {
    const smallHours = new Date(2026, 8, 15, 1, 0, 0); // local 01:00, Tue 15 Sep
    const logical = todayISODate(smallHours, '04:00');
    eq('under a 04:00 boundary, 01:00 Tuesday is still Monday', logical, '2026-09-14');
    eq(
      'and the picker cannot step onto the calendar day that has not started',
      stepDay(logical, 1, { latest: logical }),
      '2026-09-14'
    );
    eq(
      'the calendar day is NOT the bound (the wrong answer, pinned)',
      todayISODate(smallHours, DEFAULT_DAY_STARTS_AT),
      '2026-09-15'
    );
  }

  // The words. Hermes has no Intl, so these are hand-rolled tables; a screen
  // reading "Nothing logged on undefined" is the failure they guard.
  eq('the chin names today', dayLabel(today, today), 'Today');
  eq('…and yesterday', dayLabel('2026-09-13', today), 'Yesterday');
  eq('…and anything older by weekday AND date', dayLabel('2026-09-08', today), 'Tue 8 Sep');
  eq('the weekday is the real one', weekdayName('2026-09-08'), 'Tuesday');
  eq('…across a month end too', weekdayName('2026-03-01'), 'Sunday');

  // The sentence form, which is what an empty day is authored with.
  eq('a sentence says today', dayPhrase(today, today), 'today');
  eq('…and yesterday', dayPhrase('2026-09-13', today), 'yesterday');
  eq('…and names the weekday inside the week', dayPhrase('2026-09-09', today), 'on Wednesday');
  // Past a week a bare weekday is ambiguous (there are two Tuesdays in play),
  // so it degrades to the form that identifies exactly one day.
  eq('…and degrades past a week', dayPhrase('2026-09-01', today), 'on Tue 1 Sep');
  eq('the seventh day back is already ambiguous', dayPhrase('2026-09-07', today), 'on Mon 7 Sep');

  // And the screen actually composes it — "Nothing logged on Wednesday.", never
  // "Nothing logged on 2026-09-09." or a bare weekday for a day three weeks back.
  const historySource = readFileSync(
    join(import.meta.dirname, '..', 'app', 'nutrition-history.tsx'),
    'utf8'
  );
  historySource.includes('Nothing logged ${dayPhrase(day, today)}')
    ? ok('the history screen authors its empty day through dayPhrase')
    : bad('the empty-day sentence no longer routes through dayPhrase');
}

// ---------------------------------------------------------------------------
console.log('\n8b. the picker looking FORWARD — `latest` stops being a synonym for today');
{
  // The mission's Plan screen (2026-09-19) is the first caller whose forward
  // bound is not today: a day ahead is a PLAN, and looking at one writes
  // nothing. `bounds.today` is what keeps the WORDS and the way home honest
  // once the two have come apart.
  const today = '2026-09-14'; // a Monday
  const horizon = { latest: '2026-09-20', today, earliest: '2026-09-01' };

  eq(
    'the forward arrow is live ON today when the caller allows a horizon',
    canStepForward(today, horizon),
    true
  );
  eq('stepping forward from today lands on tomorrow', stepDay(today, 1, horizon), '2026-09-15');
  eq('…and six steps reach the horizon', stepDay(today, 6, horizon), '2026-09-20');
  eq('…and the seventh does not', stepDay(today, 7, horizon), '2026-09-20');
  eq('the forward arrow is dead at the horizon', canStepForward('2026-09-20', horizon), false);
  // A `?date=` past the horizon is pulled back to it, exactly as a stale past
  // param is pulled up to the floor.
  eq('a day past the horizon clamps to it', stepDay('2026-12-25', 0, horizon), '2026-09-20');

  // THE WORDS. `dayLabel` names the three adjacent days and gives everything
  // else a weekday AND a date — a bare weekday is ambiguous read forwards too.
  eq('the chin names tomorrow', dayLabel('2026-09-15', today), 'Tomorrow');
  eq('…and still names today and yesterday', dayLabel(today, today), 'Today');
  eq('…and yesterday', dayLabel('2026-09-13', today), 'Yesterday');
  eq(
    '…and the day after tomorrow by weekday and date',
    dayLabel('2026-09-16', today),
    'Wed 16 Sep'
  );

  // THE WAY HOME. The failure this separation exists to prevent is a "Back to
  // today" that lands on the far end of the horizon, so it is asserted as the
  // value the control is given rather than as a property of the bounds.
  eq('the way home targets TODAY, never the forward bound', boundsToday(horizon), today);
  eq(
    '…and with no `today` it is the bound, which is what keeps a past-only caller unchanged',
    boundsToday({ latest: today }),
    today
  );

  // The past-only caller: §8's bounds, byte for byte, through the new type.
  const open = { latest: today };
  eq(
    'with no `today`, the forward arrow is dead on today as before',
    canStepForward(today, open),
    false
  );
  eq('…and the step still clamps', stepDay(today, 10, open), today);
  // dayPhrase deliberately grew NO forward form — its weekday register is
  // ambiguous read forwards, and its one caller never passes a future day.
  eq('dayPhrase is untouched on today', dayPhrase(today, today), 'today');
  eq('…and on a past weekday', dayPhrase('2026-09-09', today), 'on Wednesday');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
