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
 *
 * Round 3 (items 59, 75, 89) adds the two halves the scheduler never had: a
 * tapped notification held until the app can show it (./taps.ts, driven with
 * a fake source and a fake gate), and delivered notifications cleared once
 * what they were about is settled (a fake Notification Centre injected as the
 * pass's `delivered` seam).
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { setDayStartsAt, shiftISODate } from '../src/lib/db/date.ts';
import { completeReminder, createReminder } from '../src/lib/db/repositories/reminders.ts';
import {
  applyNudgeReply,
  cancelNudge,
  markNudgeDelivered,
  saveNudgeSettings,
  upcomingNudges,
} from '../src/lib/db/repositories/coach-nudges.ts';
import { removeMissionItem, setMissionStatus } from '../src/lib/db/repositories/mission.ts';
import { generateMissionForDay } from '../src/lib/db/repositories/mission-generate.ts';
import { createProtocolWithVersion } from '../src/lib/db/repositories/protocols.ts';
import { checkinKey, recordCheckin } from '../src/lib/ai/pass-schedule.ts';
import { deliveredInstant, dismissDelivered } from '../src/lib/notifications/delivered.ts';
import { parseNudgeReply } from '../src/lib/notifications/nudge-plan.ts';
import { protocolReminderKey } from '../src/lib/notifications/protocol-reminders.ts';
import {
  cancelOwnedRequests,
  CHECKIN_TITLE,
  getLastNotificationSync,
  NATIVE_REMINDER_DEPS,
  notificationsAvailable,
  NOTIFICATION_BUDGET,
  NUDGE_TITLE,
  reminderTrigger,
  routeForNotification,
  settledDeliveries,
  syncReminderNotifications,
} from '../src/lib/notifications/reminders.ts';
import { buildRestAlert, clearDeliveredRestAlerts } from '../src/lib/notifications/rest-timer.ts';
import {
  appNavigatorMounted,
  createTapLedger,
  restTapTarget,
  routeNotificationTaps,
} from '../src/lib/notifications/taps.ts';

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
  // The morning check-in is on by default since 2026-09-26, so the resync
  // still schedules it; what matters here is that no nudge survives.
  !after.scheduled.some((r) => r.content.data?.kind === 'nudge') && after.cancels === 1
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
  result.scheduledNudges.length === 0 &&
  off.scheduled.filter((r) => r.content.data?.kind !== 'checkin').length === 1 &&
  off.scheduled.some((r) => r.content.title === 'Magnesium')
    ? ok('nudges off: nothing of the Coach’s is scheduled, his reminder still is')
    : bad('off switch', JSON.stringify(off.scheduled.map((r) => r.content)));
  result.checkinScheduled
    ? ok('…and the morning check-in is not a nudge: the nudges switch leaves it on')
    : bad('nudges off took the check-in');
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

console.log('6b. the morning check-in is on by default, just after quiet hours end, and follows them');
{
  const { db } = freshDb();
  const bellOf = async () => {
    const os = recorder();
    const result = await syncReminderNotifications(db, NOW, os.deps);
    const bell = os.scheduled.find((r) => r.content.data?.kind === 'checkin');
    return { result, bell };
  };
  // Nothing set at all: a fresh install, the owner's phone at the next build.
  let { result, bell } = await bellOf();
  result.checkinScheduled &&
  bell?.trigger.type === 'daily' &&
  bell.trigger.hour === 7 &&
  bell.trigger.minute === 5 &&
  bell.content.title === CHECKIN_TITLE
    ? ok('with nothing set, the first resync schedules the check-in daily at 07:05')
    : bad('default doorbell', JSON.stringify(bell));

  saveNudgeSettings(db, { quietEnd: '06:30' }, NOW, '00:00');
  ({ bell } = await bellOf());
  bell?.trigger.hour === 6 && bell.trigger.minute === 35
    ? ok('quiet hours moved to end at 06:30: the next resync moves it to 06:35')
    : bad('followed doorbell', JSON.stringify(bell));

  saveNudgeSettings(db, { checkinTime: '07:45' }, NOW, '00:00');
  saveNudgeSettings(db, { quietEnd: '05:30' }, NOW, '00:00');
  ({ bell } = await bellOf());
  bell?.trigger.hour === 7 && bell.trigger.minute === 45
    ? ok('a time he set stays at 07:45 when quiet hours move again')
    : bad('pinned doorbell', JSON.stringify(bell));

  saveNudgeSettings(db, { checkinFollowsQuiet: true }, NOW, '00:00');
  ({ bell } = await bellOf());
  bell?.trigger.hour === 5 && bell.trigger.minute === 35
    ? ok('“Follow quiet hours” puts it back at 05:35, five minutes after the new end')
    : bad('refollowed doorbell', JSON.stringify(bell));
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

console.log('9. a late day boundary: the small-hours nudge is scheduled for the right night');
{
  // The sync reads the INSTALLED boundary, as it does on the phone, so it is
  // installed here and put back afterwards.
  const { db } = freshDb();
  saveNudgeSettings(db, { quietStart: '00:00', quietEnd: '00:00' }, NOW, '04:00');
  const NIGHT = new Date(2026, 6, 27, 23, 0);
  applyNudgeReply(
    db,
    parseNudgeReply(`NUDGE ${TODAY} 01:30 Screens off, lights out.`),
    NIGHT,
    '04:00'
  );
  setDayStartsAt('04:00');
  try {
    const os = recorder();
    const result = await syncReminderNotifications(db, NIGHT, os.deps);
    const sent = os.scheduled.find((r) => r.content.data?.kind === 'nudge');
    sent?.trigger.date.getTime() === new Date(2026, 6, 28, 1, 30).getTime() &&
    result.scheduledNudges.length === 1
      ? ok('01:30 of the logical 27th is scheduled for 01:30 on the calendar 28th')
      : bad('late-boundary schedule', JSON.stringify(os.scheduled));
    const after = recorder();
    await syncReminderNotifications(db, new Date(2026, 6, 28, 0, 30), after.deps);
    after.scheduled.some((r) => r.content.data?.kind === 'nudge')
      ? ok('a resync after midnight, still the 27th logically, keeps it on the schedule')
      : bad('dropped after midnight');
  } finally {
    setDayStartsAt('00:00');
  }
}

// --- Round 3 (items 59, 75, 89): taps held until the app can show them, and
// --- delivered notifications cleared once what they were about is settled.

/** A fake Notification Centre: `presented` is what has fired; `dismiss` removes it. */
function centre(items, { failOn = null, readFails = false } = {}) {
  const log = { dismissed: [], items: [...items] };
  log.deps = {
    presented: async () => {
      if (readFails) throw new Error('read failed');
      return [...log.items];
    },
    dismiss: async (identifier) => {
      if (identifier === failOn) throw new Error('dismiss failed');
      log.dismissed.push(identifier);
      log.items = log.items.filter((n) => n.identifier !== identifier);
    },
  };
  return log;
}

/** Seconds since the epoch, as iOS reports a delivery. */
const secs = (date) => date.getTime() / 1000;

const protocolDoc = (items) => ({
  schema: 2,
  phases: [{ id: 'p1', title: null, duration_days: null, items }],
});
const protocolItem = (over) => ({
  id: over.id,
  title: over.title,
  scheduled_time: over.time,
  dose: null,
  notes: null,
  cadence: { kind: 'daily' },
  remind: true,
});

console.log('10. a ticked protocol item’s delivered notification comes off the lock screen');
{
  const { db } = freshDb();
  const pid = createProtocolWithVersion(
    db,
    { name: 'Morning stack', type: 'supplement_stack', startedOn: TODAY },
    protocolDoc([
      protocolItem({ id: 'cr', title: 'Creatine', time: '07:00' }),
      protocolItem({ id: 'd3', title: 'Vitamin D3', time: '08:00' }),
    ])
  );
  generateMissionForDay(db, TODAY);
  const fired = new Date(2026, 6, 27, 7, 0);
  const presented = [
    // With the payload's own day (scheduled since round 3)…
    {
      identifier: 'n-cr',
      date: secs(fired),
      data: { protocolItem: protocolReminderKey(pid, 'cr'), protocolId: pid, day: TODAY },
    },
    // …and without it (scheduled before): the day comes from the delivery time.
    {
      identifier: 'n-d3',
      date: secs(new Date(2026, 6, 27, 8, 0)),
      data: { protocolItem: protocolReminderKey(pid, 'd3'), protocolId: pid },
    },
    // A day with no rows yet says nothing — it stays.
    {
      identifier: 'n-tomorrow',
      date: secs(new Date(2026, 6, 28, 7, 0)),
      data: { protocolItem: protocolReminderKey(pid, 'cr'), protocolId: pid, day: TOMORROW },
    },
  ];
  settledDeliveries(db, presented, '00:00').length === 0
    ? ok('nothing is cleared while the items are still pending')
    : bad('cleared a pending item', JSON.stringify(settledDeliveries(db, presented, '00:00')));
  // An item no longer on a COMMITTED day — edited out, or its protocol deleted.
  const goneItem = {
    identifier: 'n-gone',
    date: secs(fired),
    data: { protocolItem: protocolReminderKey(pid, 'edited-out'), protocolId: pid, day: TODAY },
  };
  settledDeliveries(db, [goneItem], '00:00').includes('n-gone')
    ? ok('an item the committed day no longer has is cleared')
    : bad('edited-out item kept');

  const rowOf = (title) =>
    db.get(
      `SELECT e.id FROM log_entries e JOIN daily_logs d ON d.id = e.daily_log_id
        WHERE d.date = ? AND e.title = ?`,
      [TODAY, title]
    ).id;
  setMissionStatus(db, rowOf('Creatine'), 'completed');
  const dl = db.get(`SELECT id FROM daily_logs WHERE date = ?`, [TODAY]).id;
  removeMissionItem(db, dl, rowOf('Vitamin D3'));
  const settled = settledDeliveries(db, presented, '00:00');
  settled.includes('n-cr')
    ? ok('ticked: its delivered notification is picked, matched by the payload’s day')
    : bad('ticked item not picked', JSON.stringify(settled));
  settled.includes('n-d3')
    ? ok('taken off the day: picked too, its day read from the delivery time (seconds)')
    : bad('removed item not picked', JSON.stringify(settled));
  !settled.includes('n-tomorrow')
    ? ok('a delivery for a day with no rows is left alone')
    : bad('cleared on no evidence');

  // The whole pass: the tick's resync clears it, with permission REFUSED — an
  // early return from scheduling must not skip the clearing.
  const os = recorder({ granted: false });
  const nc = centre([
    ...presented,
    { identifier: 'rest', date: secs(fired), data: { kind: 'rest-timer' } },
  ]);
  os.deps.delivered = nc.deps;
  const result = await syncReminderNotifications(db, NOW, os.deps);
  nc.dismissed.includes('n-cr') && nc.dismissed.includes('n-d3') && nc.dismissed.length === 2
    ? ok('the sync dismisses exactly the settled two, even with nothing it may schedule')
    : bad('sync dismissals', JSON.stringify(nc.dismissed));
  result.cleared.length === 2 && result.failed === false
    ? ok('…reports them in `cleared`, and clearing is not a scheduling failure')
    : bad('sync result', JSON.stringify(result));
  nc.items.some((n) => n.identifier === 'rest')
    ? ok('a rest alert is not the sync’s to clear')
    : bad('sync cleared a rest alert');

  const withoutDelivered = recorder();
  const plain = await syncReminderNotifications(db, NOW, withoutDelivered.deps);
  Array.isArray(plain.cleared) && plain.cleared.length === 0
    ? ok('a recorder with no delivered seam (every older suite) clears nothing')
    : bad('cleared with no seam', JSON.stringify(plain.cleared));

  // What is scheduled from now on carries the day it is for.
  const sched = recorder();
  await syncReminderNotifications(db, NOW, sched.deps);
  const tomorrowCr = sched.scheduled.find(
    (r) => r.content.data?.protocolItem === protocolReminderKey(pid, 'cr')
  );
  tomorrowCr && tomorrowCr.content.data.day === TOMORROW
    ? ok('a protocol notification now carries its logical day in the payload')
    : bad('payload day', JSON.stringify(tomorrowCr?.content.data));
}

console.log('11. reminders, check-ins and nudges: cleared once settled, kept until then');
{
  const { db } = freshDb();
  const plainId = createReminder(db, { title: 'Take creatine', time: '15:00' }, NOW);
  const kneeId = createReminder(
    db,
    { title: 'The knee', time: '20:00', repeat: 'daily', checkin: true },
    NOW
  );
  plan(
    db,
    `NUDGE ${TOMORROW} 07:30 Leg day. Eat before you lift.\nNUDGE ${TOMORROW} 18:30 Walk after dinner.`
  );
  const [first, second] = upcomingNudges(db, NOW, '00:00');
  const at = secs(new Date(2026, 6, 27, 9, 0));
  const presented = [
    { identifier: 'r-plain', date: at, data: { reminderId: plainId } },
    { identifier: 'r-knee', date: at, data: { reminderId: kneeId, checkin: true } },
    { identifier: 'r-gone', date: at, data: { reminderId: 'deleted-long-ago' } },
    { identifier: 'c-morning', date: at, data: { kind: 'checkin' } },
    { identifier: 'n-first', date: at, data: { kind: 'nudge', nudgeId: first.id } },
    { identifier: 'n-second', date: at, data: { kind: 'nudge', nudgeId: second.id } },
    { identifier: 'n-gone', date: at, data: { kind: 'nudge', nudgeId: 'no-such-row' } },
    { identifier: 'junk', date: at, data: undefined },
  ];
  const before = settledDeliveries(db, presented, '00:00');
  before.length === 2 && before.includes('r-gone') && before.includes('n-gone')
    ? ok('only what no longer exists is cleared before anything is done')
    : bad('before', JSON.stringify(before));

  completeReminder(db, plainId);
  recordCheckin(db, checkinKey({ reminderId: kneeId }, TODAY), NOW);
  recordCheckin(db, checkinKey('morning', TODAY), NOW);
  markNudgeDelivered(db, first.id);
  cancelNudge(db, second.id);
  const after = settledDeliveries(db, presented, '00:00');
  for (const [id, what] of [
    ['r-plain', 'a completed reminder'],
    ['r-knee', 'a check-in reminder the Coach answered today'],
    ['c-morning', 'the morning check-in once answered'],
    ['n-first', 'a nudge delivered to the thread'],
    ['n-second', 'a cancelled nudge'],
  ]) {
    after.includes(id) ? ok(`cleared: ${what}`) : bad(`kept: ${what}`, JSON.stringify(after));
  }
  !after.includes('junk')
    ? ok('a notification ARC cannot place is never cleared')
    : bad('cleared junk');

  // An answer recorded for TODAY does not settle yesterday's delivery.
  const yesterday = [
    {
      identifier: 'c-yesterday',
      date: secs(new Date(2026, 6, 26, 7, 5)),
      data: { kind: 'checkin' },
    },
  ];
  settledDeliveries(db, yesterday, '00:00').length === 0
    ? ok('a check-in is answered for the day it fired, not any day')
    : bad('yesterday cleared by today');

  const failing = centre(presented, { failOn: 'r-plain' });
  const done = await dismissDelivered(failing.deps, (p) => settledDeliveries(db, p, '00:00'));
  !done.includes('r-plain') && done.includes('r-knee')
    ? ok('one dismissal that throws does not stop the rest')
    : bad('dismiss chain', JSON.stringify(done));
  const unreadable = centre(presented, { readFails: true });
  (await dismissDelivered(unreadable.deps, () => ['r-plain'])).length === 0
    ? ok('an unreadable Notification Centre clears nothing and throws nothing')
    : bad('unreadable centre');
}

console.log('12. delivery instants: iOS seconds and Android milliseconds');
{
  const when = new Date(2026, 6, 27, 7, 0);
  deliveredInstant(when.getTime() / 1000)?.getTime() === when.getTime() &&
  deliveredInstant(when.getTime())?.getTime() === when.getTime()
    ? ok('both units read as the same instant')
    : bad('instant units');
  deliveredInstant(undefined) === null && deliveredInstant(NaN) === null
    ? ok('a missing date is null, never the epoch')
    : bad('missing date');
}

console.log('13. the rest alert clears its own delivered notification');
{
  const nc = centre([
    { identifier: 'rest-1', data: { kind: 'rest-timer' } },
    { identifier: 'mag', data: { reminderId: 'r1' } },
  ]);
  const removed = await clearDeliveredRestAlerts(nc.deps);
  removed.length === 1 && removed[0] === 'rest-1' && nc.items.length === 1
    ? ok('only "Rest complete" goes; nothing else in Notification Centre is touched')
    : bad('rest clear', JSON.stringify(removed));
  (await clearDeliveredRestAlerts(null)).length === 0
    ? ok('a binary without the calls is a no-op')
    : bad('null deps');
  routeForNotification({ kind: 'rest-timer' })?.kind === 'rest'
    ? ok('a tapped rest alert now has somewhere to go')
    : bad('rest route');
}

/** A tap as expo-notifications hands it over. */
const tap = (identifier, data, date = 1785140000) => ({
  notification: { date, request: { identifier, content: { data } } },
});

/** A fake source: a launching tap (or none), and a listener the test fires. */
function tapSource(launching = null) {
  const s = { cleared: 0, listener: null, removed: false };
  s.source = {
    lastResponse: async () => launching,
    clearLastResponse: () => {
      s.cleared += 1;
    },
    onResponse: (listener) => {
      s.listener = listener;
      return () => {
        s.removed = true;
      };
    },
  };
  return s;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

console.log('14. a tap on a locked cold start is held, then delivered once after Face ID');
{
  const launching = tap('morning-req', { kind: 'checkin' });
  const src = tapSource(launching);
  const ledger = createTapLedger();
  let open = false;
  const delivered = [];
  const routing = routeNotificationTaps(
    src.source,
    { isReady: () => open, deliver: (route) => delivered.push(route) },
    ledger
  );
  await settle();
  // The listener hands over the SAME delivery too — the cold start's double.
  src.listener(launching);
  delivered.length === 0 && ledger.waiting.length === 1
    ? ok('locked: nothing is routed, and the tap waits — once, not twice')
    : bad('locked delivery', JSON.stringify({ delivered, waiting: ledger.waiting }));
  src.cleared === 0
    ? ok('…and the launching response is NOT cleared while it waits')
    : bad('cleared before delivery');
  routing.flush();
  delivered.length === 0
    ? ok('a flush while the gate is still shut delivers nothing (the Face ID prompt)')
    : bad('delivered through a shut gate');

  open = true;
  routing.flush();
  delivered.length === 1 && delivered[0].kind === 'checkin'
    ? ok('the gate opens: the tap lands, as the check-in it was')
    : bad('after unlock', JSON.stringify(delivered));
  src.cleared === 1
    ? ok('…and only now is the launching response forgotten')
    : bad('clear count', String(src.cleared));
  routing.flush();
  src.listener(launching);
  delivered.length === 1
    ? ok('handled exactly once: a later flush or a repeat hand-off adds nothing')
    : bad('double delivery', JSON.stringify(delivered));
}

console.log('15. warm taps, repeating requests, failures and remounts');
{
  const src = tapSource(null);
  const ledger = createTapLedger();
  const delivered = [];
  let throwOnce = true;
  const routing = routeNotificationTaps(
    src.source,
    {
      isReady: () => true,
      deliver: (route) => {
        delivered.push(route);
        if (route.kind === 'nudge' && throwOnce) {
          throwOnce = false;
          throw new Error('navigation failed');
        }
      },
    },
    ledger
  );
  await settle();
  src.listener(tap('a', { kind: 'nudge', nudgeId: 'n1' }));
  src.listener(tap('b', { reminderId: 'r1' }));
  delivered.length === 2 && delivered[1].kind === 'reminder'
    ? ok('unlocked: each tap lands at once, and one that throws does not block the next')
    : bad('warm', JSON.stringify(delivered));
  routing.flush();
  delivered.filter((r) => r.kind === 'nudge').length === 1
    ? ok('a tap whose delivery threw is not retried — its side effects already ran')
    : bad('retried a failed delivery');

  // A daily request keeps its identifier; tomorrow's firing is a new tap.
  src.listener(tap('daily', { kind: 'checkin' }, 1785140000));
  src.listener(tap('daily', { kind: 'checkin' }, 1785226400));
  delivered.filter((r) => r.kind === 'checkin').length === 2
    ? ok('two firings of one repeating request are two taps')
    : bad('repeating request swallowed');

  src.listener(tap('nothing', {}));
  delivered.length === 4
    ? ok('a tap ARC has no route for is dropped quietly')
    : bad('unroutable', JSON.stringify(delivered));

  routing.stop();
  src.removed ? ok('stop removes the listener') : bad('listener left behind');
}
{
  // The layout remounts with a tap still waiting: the new registration takes it.
  const ledger = createTapLedger();
  const launching = tap('rest-req', { kind: 'rest-timer' });
  const first = tapSource(launching);
  const gone = routeNotificationTaps(
    first.source,
    { isReady: () => false, deliver: () => {} },
    ledger
  );
  await settle();
  gone.stop();
  const delivered = [];
  const second = tapSource(launching);
  routeNotificationTaps(
    second.source,
    { isReady: () => true, deliver: (route) => delivered.push(route) },
    ledger
  ).flush();
  await settle();
  delivered.length === 1 && delivered[0].kind === 'rest' && second.cleared >= 1
    ? ok('a waiting tap survives a remount and is delivered once by the new layout')
    : bad('remount', JSON.stringify({ delivered, cleared: second.cleared }));
}
{
  const src = tapSource(null);
  const routing = routeNotificationTaps(
    src.source,
    {
      isReady: () => {
        throw new Error('navigation not ready');
      },
      deliver: () => {},
    },
    createTapLedger()
  );
  await settle();
  let threw = false;
  try {
    src.listener(tap('x', { kind: 'checkin' }));
    routing.flush();
  } catch {
    threw = true;
  }
  !threw ? ok('a gate that throws reads as shut, never as a crash') : bad('gate threw');
  const none = routeNotificationTaps(null, { isReady: () => true, deliver: () => {} });
  none.flush();
  none.stop();
  ok('no native module: an empty router, nothing thrown');
}

console.log('16. the gate reads the app’s own Stack, not expo-router’s __root');
{
  const stack = (routes, index = routes.length - 1) => ({ stale: false, index, routes });
  const root = (inner) => ({ stale: false, index: 0, routes: [{ name: '__root', state: inner }] });
  !appNavigatorMounted(root(undefined))
    ? ok('lock screen only: __root exists, the Stack does not — shut')
    : bad('__root alone counted as mounted');
  !appNavigatorMounted(root({ routes: [{ name: '(tabs)' }] }))
    ? ok('a deep link’s partial state before the Stack renders — shut')
    : bad('partial state counted');
  appNavigatorMounted(root(stack([{ name: '(tabs)' }])))
    ? ok('the Stack mounted — open')
    : bad('mounted Stack not seen');
  !appNavigatorMounted(undefined) ? ok('no state at all — shut') : bad('undefined state');

  const t = (inner, stored) => restTapTarget(root(inner), stored);
  t(stack([{ name: '(tabs)' }, { name: 'workout-live', params: { resume: '1' } }]), true).kind ===
  'stay'
    ? ok('rest tap on the logger itself: stay')
    : bad('on logger');
  const back = t(
    stack([
      { name: '(tabs)' },
      { name: 'workout-live', params: { routineId: 'r9' } },
      { name: 'exercise-detail', params: { id: 'e1' } },
    ]),
    true
  );
  back.kind === 'return' && back.params.routineId === 'r9'
    ? ok('logger under another screen: return to it, its params intact')
    : bad('return', JSON.stringify(back));
  t(stack([{ name: '(tabs)' }, { name: 'workout-live', params: { workoutId: 'w1' } }]), true)
    .kind === 'resume'
    ? ok('a logger correcting a SAVED session is not the live one: resume the live one')
    : bad('editing logger taken for live');
  t(stack([{ name: '(tabs)' }]), true).kind === 'resume'
    ? ok('session stored but not on screen: resume it')
    : bad('resume');
  t(stack([{ name: '(tabs)' }]), false).kind === 'stay'
    ? ok('no session left (finished or discarded): stay where the app is')
    : bad('no session');
  restTapTarget(root(undefined), true).kind === 'resume'
    ? ok('no Stack to read: the stored session decides')
    : bad('no stack');
}

console.log('17. a reminder sync leaves a pending "Rest complete" alone (review, 2026-10-21)');
{
  /**
   * A fake pending schedule — the OS's list of requests not yet fired, as the
   * Notification Centre fake above is its list of those that have. `schedule`
   * assigns identifiers as iOS does; `cancelAll` empties it, rest alert and all.
   */
  const pendingCentre = ({ failCancel = null, readFails = false } = {}) => {
    let next = 0;
    const log = { requests: [], cancelAlls: 0 };
    log.deps = {
      available: () => true,
      ensurePermission: async () => true,
      schedule: async (request) => {
        log.requests.push({ identifier: `req-${++next}`, ...request });
      },
      cancelAll: async () => {
        log.cancelAlls += 1;
        log.requests.length = 0;
      },
      pending: {
        scheduled: async () => {
          if (readFails) throw new Error('read failed');
          return log.requests.map((r) => ({ identifier: r.identifier, data: r.content.data }));
        },
        cancel: async (identifier) => {
          if (identifier === failCancel) throw new Error('cancel failed');
          log.requests = log.requests.filter((r) => r.identifier !== identifier);
        },
      },
    };
    return log;
  };
  const rest = (log) => log.requests.filter((r) => r.content.data?.kind === 'rest-timer');
  const reminders = (log, id) => log.requests.filter((r) => r.content.data?.reminderId === id);

  const { db } = freshDb();
  const magnesium = createReminder(db, { title: 'Magnesium', time: '23:00', repeat: 'daily' }, NOW);
  const os = pendingCentre();
  // The logger armed its rest alert, as scheduleRestAlert does…
  os.requests.push({ identifier: 'rest-1', ...buildRestAlert(90) });
  // …and an old request this build no longer schedules is still pending.
  os.requests.push({ identifier: 'stale', content: { title: 'old', data: { reminderId: 'gone' } } });
  // A mission tick mid-rest resyncs — twice, as the training tick then does too.
  await syncReminderNotifications(db, NOW, os.deps);
  const first = await syncReminderNotifications(db, NOW, os.deps);
  rest(os).length === 1 && rest(os)[0].identifier === 'rest-1' && os.cancelAlls === 0
    ? ok('the pending rest alert survives two resyncs, under its own identifier')
    : bad('rest alert cancelled by a resync', JSON.stringify(os.requests.map((r) => r.identifier)));
  reminders(os, magnesium).length === 1 &&
  !os.requests.some((r) => r.identifier === 'stale') &&
  // rest + Magnesium + the morning check-in (on by default since 2026-09-26)
  os.requests.length === 3 &&
  first.scheduledIds.includes(magnesium)
    ? ok('…while the reminders are an exact mirror: one Magnesium, one check-in, the stale request gone')
    : bad('reminder mirror', JSON.stringify(os.requests.map((r) => [r.identifier, r.content.title])));

  // A reminder completed between syncs leaves nothing behind.
  completeReminder(db, magnesium);
  await syncReminderNotifications(db, NOW, os.deps);
  reminders(os, magnesium).length === 0 && rest(os).length === 1
    ? ok('a completed reminder is cancelled on the next sync; the rest alert still waits')
    : bad('completed reminder', JSON.stringify(os.requests.map((r) => r.identifier)));

  // The fallbacks: when the schedule cannot be read, or a cancel fails, the pass
  // cancels everything rather than leave a reminder that would fire twice.
  for (const [why, opts] of [
    ['an unreadable schedule', { readFails: true }],
    ['a cancel that fails', { failCancel: 'stale' }],
  ]) {
    const { db: db2 } = freshDb();
    const id = createReminder(db2, { title: 'Magnesium', time: '23:00', repeat: 'daily' }, NOW);
    const shaky = pendingCentre(opts);
    shaky.requests.push({ identifier: 'rest-1', ...buildRestAlert(90) });
    shaky.requests.push({ identifier: 'stale', content: { title: 'old', data: {} } });
    const result = await syncReminderNotifications(db2, NOW, shaky.deps);
    shaky.cancelAlls === 1 &&
    reminders(shaky, id).length === 1 &&
    !shaky.requests.some((r) => r.identifier === 'stale' || r.identifier === 'rest-1') &&
    result.failed === false
      ? ok(`${why}: the pass falls back to cancel-all — no orphan, at the cost of that buzz`)
      : bad(`fallback: ${why}`, JSON.stringify({ c: shaky.cancelAlls, r: shaky.requests }));
  }

  // The seam itself, on the native shape: everything but the tagged rest alert.
  const direct = pendingCentre();
  direct.requests.push(
    { identifier: 'a', content: { data: { kind: 'rest-timer' } } },
    { identifier: 'b', content: { data: { kind: 'nudge', nudgeId: 'n' } } },
    { identifier: 'c', content: { data: null } },
    { identifier: 'd', content: {} }
  );
  const cancelled = await cancelOwnedRequests(direct.deps);
  JSON.stringify(cancelled) === JSON.stringify(['b', 'c', 'd']) &&
  direct.requests.map((r) => r.identifier).join() === 'a'
    ? ok('cancelOwnedRequests cancels every request but the rest timer’s, payload or none')
    : bad('cancelOwnedRequests', JSON.stringify(cancelled));
  NATIVE_REMINDER_DEPS.pending === null && notificationsAvailable() === false
    ? ok('off-device the native seam has no pending list, so nothing native is touched')
    : bad('native pending seam off-device');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
