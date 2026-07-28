/**
 * Headless test of the reminder → OS-notification scheduling logic
 * (src/lib/notifications/reminders.ts). Only the PURE trigger math is exercised
 * — reminderTrigger — plus a check that syncReminderNotifications is a safe
 * no-op when the native `expo-notifications` module is absent (which it is under
 * node). No Expo, no device. Run: npm run db:test.
 */
import { reminderTrigger, syncReminderNotifications } from '../src/lib/notifications/reminders.ts';

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

/** A ReminderRow with sane defaults; override what a case cares about. */
function reminder(overrides = {}) {
  return {
    id: 'r1',
    title: 'Take magnesium',
    time: null,
    date: null,
    repeat: 'once',
    status: 'active',
    created_by: 'ai',
    notes: null,
    created_at: '2026-07-27T00:00:00.000Z',
    updated_at: '2026-07-27T00:00:00.000Z',
    ...overrides,
  };
}

// 2026-07-27 is a Monday, noon local.
const NOW = new Date(2026, 6, 27, 12, 0, 0, 0);

console.log('0. daily and weekly build repeating clock triggers');
{
  const daily = reminderTrigger(reminder({ repeat: 'daily', time: '21:00' }), NOW);
  daily && daily.type === 'daily' && daily.hour === 21 && daily.minute === 0
    ? ok('daily → { daily, 21:00 }')
    : bad('daily', JSON.stringify(daily));

  // Anchor 2026-08-03 is a Monday → expo weekday 2 (Sun=1..Sat=7).
  const weekly = reminderTrigger(
    reminder({ repeat: 'weekly', time: '07:30', date: '2026-08-03' }),
    NOW
  );
  weekly &&
  weekly.type === 'weekly' &&
  weekly.weekday === 2 &&
  weekly.hour === 7 &&
  weekly.minute === 30
    ? ok('weekly anchored on a Monday → weekday 2 at 07:30')
    : bad('weekly', JSON.stringify(weekly));

  reminderTrigger(reminder({ repeat: 'weekly', time: '07:30', date: null }), NOW) === null
    ? ok('weekly without an anchor date → null (unschedulable)')
    : bad('weekly no date');
}

console.log('1. one-offs schedule a future moment, never a past one');
{
  const future = reminderTrigger(
    reminder({ repeat: 'once', time: '08:00', date: '2026-07-28' }),
    NOW
  );
  future &&
  future.type === 'date' &&
  future.date.getTime() === new Date(2026, 6, 28, 8, 0, 0, 0).getTime()
    ? ok('dated future one-off → a date trigger at that local moment')
    : bad('future dated once', JSON.stringify(future));

  reminderTrigger(reminder({ repeat: 'once', time: '08:00', date: '2026-07-20' }), NOW) === null
    ? ok('dated PAST one-off → null (would fire immediately)')
    : bad('past dated once');

  const todayFuture = reminderTrigger(reminder({ repeat: 'once', time: '18:00', date: null }), NOW);
  todayFuture &&
  todayFuture.type === 'date' &&
  todayFuture.date.getTime() === new Date(2026, 6, 27, 18, 0, 0, 0).getTime()
    ? ok('undated one-off, time still ahead today → today at that time')
    : bad('undated future once', JSON.stringify(todayFuture));

  reminderTrigger(reminder({ repeat: 'once', time: '08:00', date: null }), NOW) === null
    ? ok('undated one-off whose time already passed today → null')
    : bad('undated past once');
}

console.log('2. unschedulable reminders return null (in-app only)');
{
  reminderTrigger(reminder({ repeat: 'daily', time: null }), NOW) === null
    ? ok("an untimed reminder → null (can't schedule a clock notification)")
    : bad('untimed');
  reminderTrigger(reminder({ status: 'done', repeat: 'daily', time: '21:00' }), NOW) === null
    ? ok('a non-active reminder → null')
    : bad('inactive');
  reminderTrigger(reminder({ repeat: 'daily', time: '99:99' }), NOW) === null
    ? ok('a malformed time → null')
    : bad('bad time');
}

console.log('3. syncReminderNotifications no-ops safely without the native module');
{
  const fakeDb = { all: () => [], get: () => undefined, run: () => {} };
  let threw = null;
  try {
    await syncReminderNotifications(fakeDb, NOW);
  } catch (e) {
    threw = e;
  }
  threw === null
    ? ok('resolves without throwing when expo-notifications is absent')
    : bad('sync threw', String(threw));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
