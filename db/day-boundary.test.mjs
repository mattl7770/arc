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
  getDayStartsAt,
  localDayUtcRange,
  localWeekRange,
  logicalDate,
  normalizeDayStartsAt,
  setDayStartsAt,
  shiftISODate,
  todayISODate,
} from '../src/lib/db/date.ts';
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
