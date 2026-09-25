/**
 * Headless test of the reminder → OS-notification scheduling logic
 * (src/lib/notifications/reminders.ts). Only the PURE trigger math is exercised
 * — reminderTrigger — plus a check that syncReminderNotifications is a safe
 * no-op when the native `expo-notifications` module is absent (which it is under
 * node). No Expo, no device. Run: npm run db:test.
 *
 * Since 0064 (Coach notifications) it also drives the WHOLE sync pass against
 * real SQLite with `expo-notifications` mocked the way the timezone suite does
 * it — a recorder injected as `ReminderSyncDeps` — and reads the schedule back:
 * the Coach's nudges, the morning check-in, the check-in bit on a reminder,
 * quiet hours applying to the Coach alone, and the 64-notification budget.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { shiftISODate } from '../src/lib/db/date.ts';
import { createReminder } from '../src/lib/db/repositories/reminders.ts';
import {
  applyNudgeReply,
  cancelNudge,
  saveNudgeSettings,
  upcomingNudges,
} from '../src/lib/db/repositories/coach-nudges.ts';
import { parseNudgeReply } from '../src/lib/notifications/nudge-plan.ts';
import {
  CHECKIN_TITLE,
  getLastNotificationSync,
  NOTIFICATION_BUDGET,
  NUDGE_TITLE,
  reminderTrigger,
  syncReminderNotifications,
} from '../src/lib/notifications/reminders.ts';

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

console.log('1. one-offs schedule their dated moment, never a past one, never an undated one');
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

  // The day of a timed one-off is resolved ONCE, at creation — createReminder
  // stamps `date` (today if the time is still ahead, else tomorrow). So this
  // function must NOT resolve it again. What the pre-fix code did: it resolved
  // an undated one-off to TODAY at its clock time and returned null once that
  // moment had passed — quiet for the rest of that day, never rolled forward to
  // tomorrow. The bug bit the NEXT day: that day's first resync (boot, or any
  // Coach turn) re-resolved "today" against the new date, found a fresh future
  // moment and scheduled it again — every day, forever, since nothing marks a
  // one-off done but the user. Undated must now be unschedulable on BOTH sides
  // of the clock, which is what these two cases pin.
  reminderTrigger(reminder({ repeat: 'once', time: '18:00', date: null }), NOW) === null
    ? ok('undated one-off, time still AHEAD today → null (no longer resolved to today)')
    : bad('undated once, time ahead');

  reminderTrigger(reminder({ repeat: 'once', time: '08:00', date: null }), NOW) === null
    ? ok('undated one-off whose time already PASSED → null')
    : bad('undated once, time passed');

  // The mechanism itself: the SAME undated row, seen on three consecutive days,
  // each before its clock time — the exact moments the old code handed back a
  // fresh trigger. All null now.
  {
    const legacy = reminder({ repeat: 'once', time: '09:00', date: null });
    [
      new Date(2026, 6, 28, 8, 0, 0, 0),
      new Date(2026, 6, 29, 8, 0, 0, 0),
      new Date(2026, 6, 30, 8, 0, 0, 0),
    ].every((m) => reminderTrigger(legacy, m) === null)
      ? ok('  → and null on each NEW DAY before its time (the per-new-day rescheduling is gone)')
      : bad('undated once rescheduled on a new day');
  }
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

// --- 0064: the whole pass, against real SQLite, with the OS mocked ------------

function freshDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const db = {
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

/** expo-notifications, as the four calls a sync makes — recorded, never native. */
function recorder({ granted = true } = {}) {
  const log = { scheduled: [], cancels: 0 };
  log.deps = {
    available: () => true,
    cancelAll: async () => {
      log.cancels += 1;
      log.scheduled.length = 0;
    },
    ensurePermission: async () => granted,
    schedule: async (request) => {
      log.scheduled.push(request);
    },
  };
  return log;
}

const TODAY = '2026-07-27';
const TOMORROW = shiftISODate(TODAY, 1);
const plan = (db, text) => applyNudgeReply(db, parseNudgeReply(text), NOW, '00:00');

console.log('4. the Coach’s nudges join the one pass, at the ordinary interruption level');
{
  const { db } = freshDb();
  plan(db, `NUDGE ${TOMORROW} 07:30 Leg day. Eat before you lift.`);
  const [nudge] = upcomingNudges(db, NOW, '00:00');
  const os = recorder();
  const result = await syncReminderNotifications(db, NOW, os.deps);
  const sent = os.scheduled.find((r) => r.content.data?.kind === 'nudge');
  sent &&
  sent.content.title === NUDGE_TITLE &&
  sent.content.body === 'Leg day. Eat before you lift.' &&
  sent.content.data.nudgeId === nudge.id &&
  sent.trigger.type === 'date' &&
  sent.trigger.date.getTime() === new Date(2026, 6, 28, 7, 30).getTime()
    ? ok('a pending nudge is one dated notification carrying its row id')
    : bad('nudge request', JSON.stringify(sent));
  sent?.content.interruptionLevel === 'active'
    ? ok('…at the ordinary level, never time-sensitive — the Coach does not break Focus')
    : bad('interruption level', JSON.stringify(sent?.content));
  result.scheduledNudges.length === 1 && result.overBudget === 0
    ? ok('the result reports it, and nothing was left out')
    : bad('result', JSON.stringify(result));
  getLastNotificationSync() === result
    ? ok('the last sync is kept for the Coach tab to read')
    : bad('last sync not kept');

  cancelNudge(db, nudge.id);
  const after = recorder();
  await syncReminderNotifications(db, NOW, after.deps);
  after.scheduled.length === 0 && after.cancels === 1
    ? ok('a cancelled nudge is gone from the phone at the next resync')
    : bad('cancelled nudge scheduled', JSON.stringify(after.scheduled));
}

console.log('5. quiet hours bind the Coach, never his own reminders');
{
  const { db } = freshDb();
  createReminder(db, { title: 'Magnesium', time: '23:00', repeat: 'daily' }, NOW);
  plan(db, `NUDGE ${TODAY} 23:00 Lights out soon.\nNUDGE ${TOMORROW} 08:00 Walk after breakfast.`);
  const os = recorder();
  await syncReminderNotifications(db, NOW, os.deps);
  const nudges = os.scheduled.filter((r) => r.content.data?.kind === 'nudge');
  os.scheduled.some((r) => r.content.title === 'Magnesium') &&
  nudges.length === 1 &&
  nudges[0].content.body === 'Walk after breakfast.'
    ? ok('his 23:00 reminder buzzes; the Coach’s 23:00 nudge was never planned')
    : bad('quiet hours', JSON.stringify(os.scheduled.map((r) => r.content)));

  saveNudgeSettings(db, { enabled: false }, NOW, '00:00');
  const off = recorder();
  const result = await syncReminderNotifications(db, NOW, off.deps);
  result.scheduledNudges.length === 0 && off.scheduled.length === 1
    ? ok('nudges off: nothing of the Coach’s is scheduled, his reminder still is')
    : bad('off switch', JSON.stringify(off.scheduled.map((r) => r.content)));
}

console.log('6. the morning check-in and the check-in bit ride the payload');
{
  const { db } = freshDb();
  saveNudgeSettings(db, { checkinTime: '07:15' }, NOW, '00:00');
  const knee = createReminder(db, { title: 'The knee', time: '20:00', checkin: true }, NOW);
  const creatine = createReminder(db, { title: 'Take creatine', time: '15:00' }, NOW);
  const os = recorder();
  const result = await syncReminderNotifications(db, NOW, os.deps);
  const bell = os.scheduled.find((r) => r.content.data?.kind === 'checkin');
  bell &&
  bell.content.title === CHECKIN_TITLE &&
  bell.content.body === undefined &&
  bell.trigger.type === 'daily' &&
  bell.trigger.hour === 7 &&
  bell.trigger.minute === 15 &&
  result.checkinScheduled
    ? ok('the morning check-in is one daily notification with no health content')
    : bad('doorbell', JSON.stringify(bell));
  const kneeReq = os.scheduled.find((r) => r.content.data?.reminderId === knee);
  const creatineReq = os.scheduled.find((r) => r.content.data?.reminderId === creatine);
  kneeReq?.content.data.checkin === true && !('checkin' in (creatineReq?.content.data ?? {}))
    ? ok('a check-in reminder says so in its payload; a plain one carries nothing new')
    : bad('checkin payload', JSON.stringify([kneeReq, creatineReq]));

  saveNudgeSettings(db, { checkinTime: null }, NOW, '00:00');
  const off = recorder();
  await syncReminderNotifications(db, NOW, off.deps);
  !off.scheduled.some((r) => r.content.data?.kind === 'checkin')
    ? ok('turned off, the morning check-in is gone at the next resync')
    : bad('doorbell survived');
}

console.log(`7. the 64 cap: every sync fits ${NOTIFICATION_BUDGET}, and says what it left out`);
{
  const { db } = freshDb();
  for (let i = 0; i < NOTIFICATION_BUDGET + 5; i++) {
    const hh = String(Math.floor(i / 4)).padStart(2, '0');
    const mm = String((i % 4) * 15).padStart(2, '0');
    createReminder(db, { title: `Reminder ${i}`, time: `${hh}:${mm}`, repeat: 'daily' }, NOW);
  }
  saveNudgeSettings(db, { checkinTime: '07:15' }, NOW, '00:00');
  plan(db, `NUDGE ${TOMORROW} 08:00 Walk after breakfast.`);
  const os = recorder();
  const result = await syncReminderNotifications(db, NOW, os.deps);
  os.scheduled.length === NOTIFICATION_BUDGET &&
  result.overBudget === 5 + 1 + 1 &&
  !result.checkinScheduled &&
  result.scheduledNudges.length === 0
    ? ok(`${NOTIFICATION_BUDGET} scheduled, 7 counted as left out — nothing handed to iOS to drop`)
    : bad('budget', `${os.scheduled.length} scheduled, overBudget ${result.overBudget}`);

  const { db: small } = freshDb();
  createReminder(small, { title: 'Magnesium', time: '21:00', repeat: 'daily' }, NOW);
  plan(small, `NUDGE ${TOMORROW} 08:00 Walk after breakfast.\nNUDGE ${TODAY} 15:00 Stretch.`);
  const few = recorder();
  const fewResult = await syncReminderNotifications(small, NOW, few.deps);
  const order = few.scheduled.filter((r) => r.trigger.type === 'date').map((r) => r.content.body);
  fewResult.overBudget === 0 && order.join(' | ') === 'Stretch. | Walk after breakfast.'
    ? ok('on an ordinary phone nothing is left out, and dated ones go soonest first')
    : bad('ordinary sync', JSON.stringify({ order, over: fewResult.overBudget }));
}

console.log('8. permission refused: nothing is scheduled, and the result says so');
{
  const { db } = freshDb();
  plan(db, `NUDGE ${TOMORROW} 08:00 Walk after breakfast.`);
  const os = recorder({ granted: false });
  const result = await syncReminderNotifications(db, NOW, os.deps);
  os.scheduled.length === 0 &&
  result.permissionGranted === false &&
  getLastNotificationSync()?.permissionGranted === false
    ? ok('the Coach tab can say its list will not reach the lock screen')
    : bad('permission refused', JSON.stringify(result));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
