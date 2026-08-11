/**
 * Headless test of the reminders data layer — the reminders table
 * (0009_reminders.sql) and its repository (reminders.ts) — against real SQLite
 * via node:sqlite. Mirrors db/nutrition.test.mjs; op-sqlite is never loaded.
 * Run: npm run db:test.
 *
 * Section 6 pins the whole one-off LIFECYCLE across createReminder and
 * reminderTrigger, because the "remind me at 9am" path — a one-off with a time
 * and no date — is where a saved reminder and a scheduled notification most
 * easily diverge. The day is resolved ONCE at creation and stored in `date`,
 * and the trigger never re-resolves it. What the pre-fix code did instead:
 * reminderTrigger resolved an undated one-off to TODAY at its clock time and
 * returned null once that moment had passed — so it fell silent for the rest of
 * that day; it was never rolled forward to tomorrow. The next DAY's first
 * resync (boot, or any Coach turn) re-resolved "today" against the new date,
 * found a fresh future moment and scheduled it again — per-new-day, forever,
 * since nothing marks a one-off done but the user.
 *
 * The two paths are deliberately independent, and §6(i) pins the pairing: the
 * OS trigger lapses the moment a one-off passes, while isDueOn treats its date
 * as a "not before" FLOOR, so an unfinished nudge keeps surfacing in-app.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  completeReminder,
  createReminder,
  dismissReminder,
  isDueOn,
  listActiveReminders,
} from '../src/lib/db/repositories/reminders.ts';
import { reminderTrigger } from '../src/lib/notifications/reminders.ts';

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

console.log('0. migrations: 0009 (reminders) applies');
{
  const { raw } = freshDb();
  const version = raw.prepare('PRAGMA user_version').get().user_version;
  version >= 6 ? ok(`user_version is ${version} (>= 6)`) : bad('user_version', version);
  raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='reminders'`).get()
    ? ok('reminders table exists')
    : bad('reminders table missing');
}

console.log('1. createReminder persists with sane defaults, app-generated v4 id');
{
  const { db, raw } = freshDb();
  // Fixed clock: 2026-07-27 (Mon) 12:00 local, so 21:00 is still ahead → today.
  const NOON = new Date(2026, 6, 27, 12, 0, 0, 0);
  const id = createReminder(db, { title: 'Take magnesium', time: '21:00' }, NOON);
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
    ? ok('returned id is a v4 UUID')
    : bad('id shape', id);
  const row = raw.prepare('SELECT * FROM reminders WHERE id = ?').get(id);
  row &&
  row.title === 'Take magnesium' &&
  row.time === '21:00' &&
  row.date === '2026-07-27' &&
  row.repeat === 'once' &&
  row.status === 'active' &&
  row.created_by === 'user' &&
  row.created_at &&
  row.updated_at
    ? ok('row stored: repeat once, status active, created_by user, day RESOLVED to today')
    : bad('row contents', JSON.stringify(row));

  // Untimed one-offs have no clock to resolve against — they stay undated.
  const untimedId = createReminder(db, { title: 'Book DEXA' }, NOON);
  raw.prepare('SELECT date FROM reminders WHERE id = ?').get(untimedId).date === null
    ? ok('an UNTIMED one-off keeps date null (nothing to resolve)')
    : bad('untimed got a date');

  // A repeat is not a one-off: nothing to pin, so date stays as given (null).
  raw
    .prepare('SELECT date FROM reminders WHERE id = ?')
    .get(createReminder(db, { title: 'Nightly', time: '21:00', repeat: 'daily' }, NOON)).date ===
  null
    ? ok('a DAILY reminder is never date-stamped (it repeats, it does not lapse)')
    : bad('daily got a date');

  // An explicit date always wins — the user named the day, we do not re-pick it.
  raw
    .prepare('SELECT date FROM reminders WHERE id = ?')
    .get(createReminder(db, { title: 'Fasted labs', time: '07:00', date: '2026-09-01' }, NOON))
    .date === '2026-09-01'
    ? ok('an explicit date is preserved verbatim, never overwritten by resolution')
    : bad('explicit date overwritten');

  const aiId = createReminder(db, { title: 'Log weight', repeat: 'daily', createdBy: 'ai' });
  raw.prepare('SELECT created_by FROM reminders WHERE id = ?').get(aiId).created_by === 'ai'
    ? ok('Coach-initiated reminders record created_by = ai')
    : bad('created_by ai');
}

console.log('2. listActiveReminders: timed in clock order, untimed last, inactive gone');
{
  const { db } = freshDb();
  createReminder(db, { title: 'Evening', time: '21:00' });
  createReminder(db, { title: 'Untimed' });
  createReminder(db, { title: 'Morning', time: '07:30' });
  const done = createReminder(db, { title: 'Old one', time: '06:00' });
  completeReminder(db, done);
  const dismissed = createReminder(db, { title: 'Cancelled', time: '06:30' });
  dismissReminder(db, dismissed);

  const titles = listActiveReminders(db).map((r) => r.title);
  JSON.stringify(titles) === JSON.stringify(['Morning', 'Evening', 'Untimed'])
    ? ok('clock order, untimed last; done/dismissed filtered out')
    : bad('order/filter', JSON.stringify(titles));
}

console.log('3. status transitions restamp updated_at via the trigger');
{
  const { db, raw } = freshDb();
  const id = createReminder(db, { title: 'X' });
  raw
    .prepare('UPDATE reminders SET updated_at = ? WHERE id = ?')
    .run('2000-01-01T00:00:00.000Z', id);
  completeReminder(db, id);
  const row = raw.prepare('SELECT status, updated_at FROM reminders WHERE id = ?').get(id);
  row.status === 'done' && row.updated_at !== '2000-01-01T00:00:00.000Z'
    ? ok('completeReminder sets done and restamps updated_at')
    : bad('trigger', JSON.stringify(row));
}

console.log('4. CHECK constraints reject bad data at the DB layer');
{
  const { db, raw } = freshDb();
  throws(() => createReminder(db, { title: 'Bad', time: '9:00' }))
    ? ok('unpadded time rejected by the GLOB check')
    : bad('unpadded time accepted');
  throws(() => createReminder(db, { title: 'Bad', date: '2026-7-1' }))
    ? ok('malformed date rejected by the GLOB check')
    : bad('malformed date accepted');
  throws(() => createReminder(db, { title: 'Bad', repeat: 'hourly' }))
    ? ok('unknown repeat rejected by the enum CHECK')
    : bad('unknown repeat accepted');
  throws(() => createReminder(db, { title: 'Bad', repeat: 'weekly' }))
    ? ok('weekly without an anchor date rejected by the cross-CHECK')
    : bad('anchorless weekly accepted');
  throws(() =>
    raw.prepare(`INSERT INTO reminders (id, title, status) VALUES ('x', 'Bad', 'snoozed')`).run()
  )
    ? ok('unknown status rejected by the enum CHECK')
    : bad('unknown status accepted');
  throws(() => raw.prepare(`INSERT INTO reminders (id) VALUES ('y')`).run())
    ? ok('a reminder with no title rejected (title NOT NULL)')
    : bad('titleless reminder accepted');
}

console.log('5. isDueOn: once/daily/weekly semantics (a one-off date is a NOT-BEFORE floor)');
{
  const { db } = freshDb();
  createReminder(db, { title: 'undated-once' });
  createReminder(db, { title: 'dated-once', date: '2026-07-27' });
  createReminder(db, { title: 'daily', repeat: 'daily' });
  // 2026-07-27 is a Monday; weekly anchored there fires Mondays.
  createReminder(db, { title: 'weekly-mon', repeat: 'weekly', date: '2026-07-27' });
  const byTitle = Object.fromEntries(listActiveReminders(db).map((r) => [r.title, r]));

  isDueOn(byTitle['undated-once'], '2026-07-26') && isDueOn(byTitle['undated-once'], '2026-08-01')
    ? ok('an undated one-off is due any day')
    : bad('undated once');
  // The date is a floor, not an equality: not due BEFORE its day, due on it,
  // and still due after — an unfinished nudge must keep nagging until the user
  // completes or dismisses it, exactly as an undated one always has.
  !isDueOn(byTitle['dated-once'], '2026-07-26') &&
  isDueOn(byTitle['dated-once'], '2026-07-27') &&
  isDueOn(byTitle['dated-once'], '2026-07-28') &&
  isDueOn(byTitle['dated-once'], '2027-03-01')
    ? ok('a dated one-off: not due before its day, due on it, still due long after')
    : bad('dated once');
  isDueOn(byTitle['daily'], '2026-07-26') && isDueOn(byTitle['daily'], '2027-01-01')
    ? ok('daily is due every day')
    : bad('daily');
  isDueOn(byTitle['weekly-mon'], '2026-08-03') && !isDueOn(byTitle['weekly-mon'], '2026-08-04')
    ? ok('weekly fires on the anchor weekday only (Mon 2026-08-03, not Tue)')
    : bad('weekly');

  const dismissed = { ...byTitle['daily'], status: 'dismissed' };
  !isDueOn(dismissed, '2026-07-26') ? ok('non-active is never due') : bad('dismissed due');
}

console.log('6. one-off LIFECYCLE: the day is pinned at creation, then it fires ONCE and lapses');
{
  const { db } = freshDb();
  // 2026-08-07 is a Friday. 22:00 local is the "said at 10pm" case.
  const LATE = new Date(2026, 7, 7, 22, 0, 0, 0);
  const at = (y, m, d, h, min) => new Date(y, m - 1, d, h, min, 0, 0).getTime();
  // Rows are read back out of SQLite so these are real rows, not literals.
  const mk = (fields, now = LATE) => {
    const id = createReminder(db, { title: JSON.stringify(fields), ...fields }, now);
    return listActiveReminders(db).find((r) => r.id === id);
  };
  /** Every later resync — boot, and after every Coach turn — must yield null. */
  const laterResyncs = (row, moments) => moments.every((m) => reminderTrigger(row, m) === null);

  // (a) created when its time has ALREADY PASSED → pinned to TOMORROW, fires
  //     once at that moment, and is dead on every resync after it.
  const passed = mk({ time: '09:00' });
  passed.date === '2026-08-08'
    ? ok('created at 22:00 for "09:00" → row stamped date 2026-08-08 (tomorrow)')
    : bad('passed-time day resolution', JSON.stringify(passed));
  const passedTrigger = reminderTrigger(passed, LATE);
  passedTrigger &&
  passedTrigger.type === 'date' &&
  passedTrigger.date.getTime() === at(2026, 8, 8, 9, 0)
    ? ok('  → schedules exactly once, tomorrow 09:00')
    : bad('passed-time trigger', JSON.stringify(passedTrigger));
  laterResyncs(passed, [
    new Date(2026, 7, 8, 9, 0, 0, 0), // the moment itself: already fired
    new Date(2026, 7, 8, 9, 0, 0, 1), // one ms later
    new Date(2026, 7, 8, 23, 0, 0, 0), // that evening
    new Date(2026, 7, 9, 8, 0, 0, 0), // the NEXT day, before 09:00
    new Date(2026, 7, 15, 8, 0, 0, 0), // a week later
    new Date(2027, 0, 1, 8, 0, 0, 0), // months later
  ])
    ? ok('  → null on EVERY later resync: it lapses instead of resurrecting daily')
    : bad('one-off resurrected on a later resync');

  // (b) created when its time is STILL AHEAD → pinned to TODAY, fires today,
  //     then lapses the same way.
  const ahead = mk({ time: '23:30' });
  ahead.date === '2026-08-07'
    ? ok('created at 22:00 for "23:30" → row stamped date 2026-08-07 (today)')
    : bad('ahead-time day resolution', JSON.stringify(ahead));
  const aheadTrigger = reminderTrigger(ahead, LATE);
  aheadTrigger && aheadTrigger.date.getTime() === at(2026, 8, 7, 23, 30)
    ? ok('  → schedules today 23:30')
    : bad('ahead-time trigger', JSON.stringify(aheadTrigger));
  laterResyncs(ahead, [
    new Date(2026, 7, 7, 23, 30, 0, 0),
    new Date(2026, 7, 8, 23, 0, 0, 0),
    new Date(2026, 7, 9, 12, 0, 0, 0),
  ])
    ? ok('  → null afterwards: fired today, never again')
    : bad('same-day one-off resurrected');

  // (c) EXACTLY now must land tomorrow: pinning the current instant is a
  //     notification the OS fires immediately, not what "at 22:00" means.
  const exact = mk({ time: '22:00' });
  exact.date === '2026-08-08' &&
  reminderTrigger(exact, LATE)?.date.getTime() === at(2026, 8, 8, 22, 0)
    ? ok('time EXACTLY now → tomorrow, never fire-immediately')
    : bad('exactly-now boundary', JSON.stringify(exact));

  // (d) month-end: created 31 Aug 22:00 for 09:00 → 1 Sep, not an invalid 32 Aug.
  const monthEnd = mk({ time: '09:00' }, new Date(2026, 7, 31, 22, 0, 0, 0));
  monthEnd.date === '2026-09-01'
    ? ok('resolution crosses a month boundary (31 Aug 22:00 → 2026-09-01)')
    : bad('month-end resolution', JSON.stringify(monthEnd));
  // …and a year boundary, which is where a naive day+1 would print month 13.
  mk({ time: '09:00' }, new Date(2026, 11, 31, 22, 0, 0, 0)).date === '2027-01-01'
    ? ok('resolution crosses a YEAR boundary (31 Dec 22:00 → 2027-01-01)')
    : bad('year-end resolution');

  // (e) an EXPLICIT date is the user's word, so a past one stays unschedulable
  //     — never silently moved to another day, then or on any later resync.
  const pastDated = mk({ time: '09:00', date: '2026-08-06' });
  pastDated.date === '2026-08-06' &&
  reminderTrigger(pastDated, LATE) === null &&
  laterResyncs(pastDated, [new Date(2026, 7, 8, 8, 0), new Date(2026, 8, 1, 8, 0)])
    ? ok('dated one-off in the PAST → null then and forever (never rescheduled)')
    : bad('past dated once was scheduled');

  const datedFuture = mk({ time: '09:00', date: '2026-08-09' });
  reminderTrigger(datedFuture, LATE)?.date.getTime() === at(2026, 8, 9, 9, 0) &&
  laterResyncs(datedFuture, [new Date(2026, 7, 9, 9, 0), new Date(2026, 7, 10, 8, 0)])
    ? ok('dated FUTURE one-off → exactly that moment, then lapses')
    : bad('future dated once');

  // (f) untimed stays in-app only: no clock to schedule against, no day to pin,
  //     and isDueOn keeps surfacing it every day (that is the in-app contract).
  const untimed = mk({});
  untimed.date === null && reminderTrigger(untimed, LATE) === null && isDueOn(untimed, '2026-08-20')
    ? ok('untimed one-off → undated, unschedulable, still due in-app any day')
    : bad('untimed', JSON.stringify(untimed));

  // (g) a DAILY repeat is untouched by any of this: no date stamped, and it
  //     still repeats even though 09:00 already went by today.
  const dailyRow = mk({ time: '09:00', repeat: 'daily' });
  const daily = reminderTrigger(dailyRow, LATE);
  dailyRow.date === null &&
  daily &&
  daily.type === 'daily' &&
  daily.hour === 9 &&
  daily.minute === 0
    ? ok('a DAILY at an already-passed time still repeats, and is never date-stamped')
    : bad('daily', JSON.stringify(daily));
  // …and it keeps repeating on every later resync — the point of a repeat.
  reminderTrigger(dailyRow, new Date(2027, 0, 1, 12, 0))?.type === 'daily'
    ? ok('  → still a daily trigger months later (repeats do NOT lapse)')
    : bad('daily lapsed');

  // (h) LEGACY: a row written before day-resolution landed — undated, timed,
  //     one-off. Inserted raw to bypass createReminder, exactly as it sits in an
  //     older DB. Deliberate decision (no migration): it goes quiet as an OS
  //     notification rather than resurrecting daily, and still surfaces in-app.
  db.run(
    `INSERT INTO reminders (id, title, time, date, repeat) VALUES ('legacy-1','Legacy nudge','09:00',NULL,'once')`
  );
  const legacy = listActiveReminders(db).find((r) => r.id === 'legacy-1');
  legacy &&
  reminderTrigger(legacy, LATE) === null &&
  laterResyncs(legacy, [
    new Date(2026, 7, 8, 8, 0), // before its time, the next day
    new Date(2026, 7, 8, 10, 0), // after its time, the next day
    new Date(2026, 8, 1, 8, 0),
  ]) &&
  isDueOn(legacy, '2026-08-20')
    ? ok('legacy undated timed one-off → never scheduled again, still surfaces in-app')
    : bad('legacy row', JSON.stringify(legacy));

  // (i) THE PAIRING, which is the whole reason the two paths are separate.
  //     `passed` was pinned to 2026-08-08 and never completed. Long after that
  //     day it must STILL surface in-app — pinning a date to fix the OS bug must
  //     not silently delete an unfinished nudge from every due-today surface —
  //     while the OS trigger stays null across resync after resync, so the
  //     in-app floor can never resurrect the notification.
  const wayLater = [
    new Date(2026, 7, 9, 8, 0, 0, 0),
    new Date(2026, 7, 9, 21, 0, 0, 0),
    new Date(2026, 8, 20, 8, 0, 0, 0),
    new Date(2027, 5, 1, 8, 0, 0, 0),
    new Date(2028, 0, 1, 8, 0, 0, 0),
  ];
  isDueOn(passed, '2026-08-09') &&
  isDueOn(passed, '2026-09-20') &&
  isDueOn(passed, '2028-01-01') &&
  laterResyncs(passed, wayLater)
    ? ok('a long-overdue one-off keeps nagging IN-APP while its OS trigger stays null')
    : bad('overdue one-off: in-app/notification pairing');
  // …and completing it is what actually ends it, on both paths.
  completeReminder(db, passed.id);
  const retired = { ...passed, status: 'done' };
  !isDueOn(retired, '2028-01-01') && reminderTrigger(retired, wayLater[0]) === null
    ? ok('  → completing it is what stops the nagging (status gates both paths)')
    : bad('completed one-off still due');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
