/**
 * Headless test of the screenings data layer — the screenings + appointments
 * tables (0007_screenings.sql) and their repository (screenings.ts) — against
 * real SQLite via node:sqlite. Mirrors db/nutrition.test.mjs; op-sqlite is
 * never loaded. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { todayISODate } from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  addAppointment,
  addDaysISO,
  addMonthsClamped,
  addScreening,
  completeAppointment,
  deleteAppointment,
  deleteScreening,
  dueScreenings,
  getAppointment,
  getScreening,
  listScreenings,
  markScreeningDone,
  pastScheduledAppointments,
  setAppointmentStatus,
  updateAppointment,
  updateScreening,
  upcomingAppointments,
} from '../src/lib/db/repositories/screenings.ts';

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

// Fixed local calendar day — every due computation takes `today` explicitly,
// so nothing here depends on the wall clock.
const TODAY = '2026-07-26';

console.log('0. migration 0007 creates both tables (user_version jumps the 0005/0006 gap)');
{
  const { raw } = freshDb();
  const names = raw
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('screenings','appointments') ORDER BY name"
    )
    .all()
    .map((r) => r.name);
  JSON.stringify(names) === JSON.stringify(['appointments', 'screenings'])
    ? ok('screenings + appointments tables exist')
    : bad('tables missing', JSON.stringify(names));
  const v = raw.prepare('PRAGMA user_version').get().user_version;
  v === 7
    ? ok('user_version = 7 (runner tolerates the reserved 0005/0006 gap)')
    : bad('user_version', v);
}

console.log('1. addScreening derives next_due from last_completed + interval_months');
{
  const { db } = freshDb();
  const id = addScreening(db, {
    name: 'Colonoscopy',
    category: 'imaging',
    intervalMonths: 120,
    lastCompleted: '2020-05-12',
    notes: 'GI clinic',
  });
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
    ? ok('returned id is a v4 UUID')
    : bad('id shape', id);
  const row = getScreening(db, id);
  row &&
  row.name === 'Colonoscopy' &&
  row.category === 'imaging' &&
  row.interval_months === 120 &&
  row.last_completed === '2020-05-12' &&
  row.next_due === '2030-05-12' &&
  row.notes === 'GI clinic'
    ? ok('row stored, next_due = last + 120 months')
    : bad('row contents', JSON.stringify(row));
}

console.log('2. explicit next_due wins; no cadence info stores NULLs (untracked)');
{
  const { db } = freshDb();
  const withOverride = addScreening(db, {
    name: 'Skin check',
    category: 'derm',
    intervalMonths: 12,
    lastCompleted: '2026-01-10',
    nextDue: '2026-09-01',
  });
  getScreening(db, withOverride)?.next_due === '2026-09-01'
    ? ok('doctor-told-you date overrides the derivation')
    : bad('override lost', JSON.stringify(getScreening(db, withOverride)));
  const untracked = addScreening(db, { name: 'DEXA', category: 'imaging' });
  const row = getScreening(db, untracked);
  row && row.interval_months === null && row.last_completed === null && row.next_due === null
    ? ok('cadence-less screening stores NULLs, not defaults')
    : bad('untracked storage', JSON.stringify(row));
}

console.log('3. month arithmetic clamps to the target month-end');
{
  addMonthsClamped('2026-01-31', 1) === '2026-02-28'
    ? ok('Jan 31 + 1 mo = Feb 28 (no roll-over to Mar 3)')
    : bad('clamp', addMonthsClamped('2026-01-31', 1));
  addMonthsClamped('2024-01-31', 1) === '2024-02-29'
    ? ok('leap year clamps to Feb 29')
    : bad('leap clamp', addMonthsClamped('2024-01-31', 1));
  addMonthsClamped('2026-11-15', 3) === '2027-02-15'
    ? ok('year boundary carries')
    : bad('year carry', addMonthsClamped('2026-11-15', 3));
  addDaysISO('2026-07-26', 30) === '2026-08-25'
    ? ok('addDaysISO crosses the month boundary')
    : bad('addDaysISO', addDaysISO('2026-07-26', 30));
}

console.log('4. markScreeningDone stamps last_completed and rolls the cadence');
{
  const { db } = freshDb();
  const dental = addScreening(db, {
    name: 'Dental cleaning',
    category: 'dental',
    intervalMonths: 6,
    lastCompleted: '2025-12-01',
  });
  markScreeningDone(db, dental, TODAY);
  const row = getScreening(db, dental);
  row && row.last_completed === TODAY && row.next_due === '2027-01-26'
    ? ok('done today -> next_due rolls 6 months forward')
    : bad('cadence roll', JSON.stringify(row));

  const oneOff = addScreening(db, { name: 'Calcium score', category: 'cardio', nextDue: TODAY });
  markScreeningDone(db, oneOff, TODAY);
  const offRow = getScreening(db, oneOff);
  offRow && offRow.last_completed === TODAY && offRow.next_due === null
    ? ok('one-off done -> next_due clears (nothing left to track)')
    : bad('one-off roll', JSON.stringify(offRow));
}

console.log('5. dueScreenings splits overdue vs due inside the horizon, soonest first');
{
  const { db } = freshDb();
  dueScreenings(db, TODAY).length === 0
    ? ok('fresh database reports nothing due')
    : bad('not empty');
  addScreening(db, { name: 'Skin check', category: 'derm', nextDue: '2026-06-01' }); // overdue
  addScreening(db, { name: 'Eye exam', category: 'vision', nextDue: TODAY }); // due today
  addScreening(db, { name: 'Dental', category: 'dental', nextDue: '2026-08-10' }); // due in horizon
  addScreening(db, { name: 'Colonoscopy', category: 'imaging', nextDue: '2030-05-12' }); // far future
  addScreening(db, { name: 'DEXA', category: 'imaging' }); // untracked
  const due = dueScreenings(db, TODAY);
  JSON.stringify(due.map((s) => s.name)) === JSON.stringify(['Skin check', 'Eye exam', 'Dental'])
    ? ok('overdue + horizon rows only, ordered by next_due')
    : bad('due list', JSON.stringify(due.map((s) => s.name)));
  JSON.stringify(due.map((s) => s.dueStatus)) === JSON.stringify(['overdue', 'due', 'due'])
    ? ok('dueStatus: before today = overdue, today/within horizon = due')
    : bad('dueStatus', JSON.stringify(due.map((s) => s.dueStatus)));
  const wide = dueScreenings(db, TODAY, 3650);
  wide.some((s) => s.name === 'Colonoscopy') && !wide.some((s) => s.name === 'DEXA')
    ? ok('wider horizon pulls the far-future row in; untracked never appears')
    : bad('horizon widen', JSON.stringify(wide.map((s) => s.name)));
}

console.log('6. screenings CHECKs reject bad data at the DB layer');
{
  const { db } = freshDb();
  throws(() => addScreening(db, { name: 'Bad', category: 'chiropody' }))
    ? ok('unknown category rejected')
    : bad('category accepted');
  throws(() => addScreening(db, { name: 'Bad', category: 'exam', intervalMonths: 0 }))
    ? ok('interval_months 0 rejected (> 0)')
    : bad('interval 0 accepted');
  throws(() => addScreening(db, { name: 'Bad', category: 'exam', lastCompleted: '2026-7-1' }))
    ? ok('malformed last_completed rejected by the GLOB check')
    : bad('malformed date accepted');
  throws(() => addScreening(db, { name: 'Bad', category: 'exam', nextDue: 'soonish' }))
    ? ok('malformed next_due rejected by the GLOB check')
    : bad('malformed next_due accepted');
  throws(() =>
    addScreening(db, {
      name: 'Bad',
      category: 'exam',
      lastCompleted: '2026-01-10',
      nextDue: '2025-09-01',
    })
  )
    ? ok('next_due before last_completed rejected (cross-column CHECK)')
    : bad('impossible next_due accepted');
}

console.log('7. appointments persist with default status scheduled');
{
  const { db } = freshDb();
  const id = addAppointment(db, {
    title: 'Dermatology skin check',
    provider: 'Dr. Osei',
    scheduledAt: '2026-08-12T18:30:00.000Z',
    location: 'Downtown clinic',
  });
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
    ? ok('returned id is a v4 UUID')
    : bad('id shape', id);
  const row = getAppointment(db, id);
  row &&
  row.title === 'Dermatology skin check' &&
  row.provider === 'Dr. Osei' &&
  row.scheduled_at === '2026-08-12T18:30:00.000Z' &&
  row.location === 'Downtown clinic' &&
  row.status === 'scheduled' &&
  row.screening_id === null
    ? ok('row stored with every field, status defaults to scheduled')
    : bad('row contents', JSON.stringify(row));
}

console.log('8. appointment status: CHECK vocabulary + plain setter');
{
  const { db, raw } = freshDb();
  const id = addAppointment(db, { title: 'Eye exam', scheduledAt: '2026-08-01T15:00:00.000Z' });
  throws(() => raw.prepare('UPDATE appointments SET status = ? WHERE id = ?').run('no_show', id))
    ? ok('status outside scheduled|completed|cancelled rejected')
    : bad('bad status accepted');
  setAppointmentStatus(db, id, 'cancelled');
  getAppointment(db, id)?.status === 'cancelled'
    ? ok('setAppointmentStatus flips to cancelled')
    : bad('cancel', JSON.stringify(getAppointment(db, id)));
}

console.log('9. upcomingAppointments: from-filter, order, status filter, joined name');
{
  const { db } = freshDb();
  const FROM = '2026-07-26T00:00:00.000Z';
  upcomingAppointments(db, FROM).length === 0
    ? ok('fresh database reports an empty calendar')
    : bad('not empty');
  const derm = addScreening(db, { name: 'Skin check', category: 'derm', intervalMonths: 12 });
  const old = addAppointment(db, {
    title: 'Old physical',
    scheduledAt: '2026-06-01T15:00:00.000Z',
  }); // past
  addAppointment(db, {
    title: 'Derm visit',
    scheduledAt: '2026-08-12T18:30:00.000Z',
    screeningId: derm,
  });
  addAppointment(db, { title: 'Dentist', scheduledAt: '2026-07-30T16:00:00.000Z' });
  // Exactly the `from` instant — pins the >= boundary (a midnight booking must
  // stay on today's calendar, not vanish).
  addAppointment(db, { title: 'Midnight labs', scheduledAt: FROM });
  const cancelled = addAppointment(db, {
    title: 'Cancelled consult',
    scheduledAt: '2026-08-01T15:00:00.000Z',
  });
  setAppointmentStatus(db, cancelled, 'cancelled');
  const done = addAppointment(db, {
    title: 'Done physical',
    scheduledAt: '2026-08-05T15:00:00.000Z',
  });
  setAppointmentStatus(db, done, 'completed');
  const upcoming = upcomingAppointments(db, FROM);
  JSON.stringify(upcoming.map((a) => a.title)) ===
  JSON.stringify(['Midnight labs', 'Dentist', 'Derm visit'])
    ? ok('past + cancelled + completed drop out; boundary row stays; soonest first')
    : bad('upcoming list', JSON.stringify(upcoming.map((a) => a.title)));
  upcoming[2].screening_name === 'Skin check' && upcoming[0].screening_name === null
    ? ok('linked screening name rides along; unlinked is NULL')
    : bad('joined name', JSON.stringify(upcoming));

  // The past still-'scheduled' booking is not lost — it surfaces for closure.
  const past = pastScheduledAppointments(db, FROM);
  JSON.stringify(past.map((a) => a.title)) === JSON.stringify(['Old physical'])
    ? ok("pastScheduledAppointments returns only the stranded 'scheduled' booking")
    : bad('past list', JSON.stringify(past.map((a) => a.title)));
  completeAppointment(db, old);
  pastScheduledAppointments(db, FROM).length === 0
    ? ok('closing it clears the awaiting-outcome list')
    : bad('past not cleared');
}

console.log('10. appointment -> screening FK: enforced, and SET NULL on delete');
{
  const { db } = freshDb();
  throws(() =>
    addAppointment(db, {
      title: 'Ghost link',
      scheduledAt: '2026-08-01T15:00:00.000Z',
      screeningId: 'not-a-real-screening-id-000000000000',
    })
  )
    ? ok('unknown screening_id rejected (PRAGMA foreign_keys = ON)')
    : bad('dangling FK accepted');
  const derm = addScreening(db, { name: 'Skin check', category: 'derm' });
  const appt = addAppointment(db, {
    title: 'Derm visit',
    scheduledAt: '2026-08-12T18:30:00.000Z',
    screeningId: derm,
  });
  deleteScreening(db, derm);
  const row = getAppointment(db, appt);
  row && row.screening_id === null && row.title === 'Derm visit'
    ? ok('deleting the screening keeps the appointment, screening_id SET NULL')
    : bad('SET NULL', JSON.stringify(row));
}

console.log('11. completeAppointment stamps the linked screening done in one transaction');
{
  const { db } = freshDb();
  const derm = addScreening(db, {
    name: 'Skin check',
    category: 'derm',
    intervalMonths: 12,
    lastCompleted: '2025-07-01',
  });
  const appt = addAppointment(db, {
    title: 'Derm visit',
    scheduledAt: '2026-07-20T18:30:00.000Z',
    screeningId: derm,
  });
  completeAppointment(db, appt);
  getAppointment(db, appt)?.status === 'completed'
    ? ok('appointment marked completed')
    : bad('status', JSON.stringify(getAppointment(db, appt)));
  // Default completion day is the VISIT's local calendar day (from
  // scheduled_at), not the day of the tap — computed here the same way the
  // repo does so the assertion is timezone-deterministic.
  const visitDay = todayISODate(new Date('2026-07-20T18:30:00.000Z'));
  const screening = getScreening(db, derm);
  screening &&
  screening.last_completed === visitDay &&
  screening.next_due === addMonthsClamped(visitDay, 12)
    ? ok('linked screening stamped done as of the visit day, cadence rolled from it')
    : bad('screening roll', JSON.stringify(screening));

  const eye = addScreening(db, { name: 'Eye exam', category: 'vision', intervalMonths: 24 });
  const eyeAppt = addAppointment(db, {
    title: 'Eye visit',
    scheduledAt: '2026-07-01T15:00:00.000Z',
    screeningId: eye,
  });
  completeAppointment(db, eyeAppt, TODAY);
  getScreening(db, eye)?.last_completed === TODAY
    ? ok('explicit completedOn still overrides the visit-day default')
    : bad('override', JSON.stringify(getScreening(db, eye)));

  const solo = addAppointment(db, {
    title: 'One-off consult',
    scheduledAt: '2026-07-21T15:00:00.000Z',
  });
  completeAppointment(db, solo, TODAY);
  getAppointment(db, solo)?.status === 'completed'
    ? ok('unlinked appointment completes without side effects')
    : bad('solo complete', JSON.stringify(getAppointment(db, solo)));
}

console.log('12. full updates re-derive next_due; updated_at trigger restamps');
{
  const { db, raw } = freshDb();
  const id = addScreening(db, {
    name: 'Dental cleaning',
    category: 'dental',
    intervalMonths: 6,
    lastCompleted: '2026-01-10',
  });
  raw
    .prepare('UPDATE screenings SET updated_at = ? WHERE id = ?')
    .run('2000-01-01T00:00:00.000Z', id);
  updateScreening(db, id, {
    name: 'Dental cleaning',
    category: 'dental',
    intervalMonths: 12,
    lastCompleted: '2026-01-10',
  });
  const row = getScreening(db, id);
  row && row.interval_months === 12 && row.next_due === '2027-01-10'
    ? ok('cadence edit re-derives next_due')
    : bad('re-derive', JSON.stringify(row));
  row && row.updated_at !== '2000-01-01T00:00:00.000Z'
    ? ok('updating a screening restamps updated_at (recursive_triggers OFF)')
    : bad('updated_at trigger', JSON.stringify(row));
}

console.log('13. appointment update + delete round-trip; listScreenings ordering');
{
  const { db } = freshDb();
  const id = addAppointment(db, { title: 'Eye exam', scheduledAt: '2026-08-01T15:00:00.000Z' });
  updateAppointment(db, id, {
    title: 'Eye exam (moved)',
    scheduledAt: '2026-08-08T15:00:00.000Z',
    provider: 'VisionOne',
  });
  const row = getAppointment(db, id);
  row &&
  row.title === 'Eye exam (moved)' &&
  row.scheduled_at === '2026-08-08T15:00:00.000Z' &&
  row.provider === 'VisionOne'
    ? ok('updateAppointment rewrites the editable fields (positional order pinned)')
    : bad('update', JSON.stringify(row));
  deleteAppointment(db, id);
  getAppointment(db, id) === undefined ? ok('deleteAppointment removes the row') : bad('delete');

  addScreening(db, { name: 'Zeta exam', category: 'exam' }); // untracked -> last
  addScreening(db, { name: 'Beta scan', category: 'imaging', nextDue: '2026-09-01' });
  addScreening(db, { name: 'Alpha scan', category: 'imaging', nextDue: '2026-08-01' });
  const names = listScreenings(db).map((s) => s.name);
  JSON.stringify(names) === JSON.stringify(['Alpha scan', 'Beta scan', 'Zeta exam'])
    ? ok('listScreenings: dated soonest first, untracked last')
    : bad('ordering', JSON.stringify(names));
}

console.log('14. updateAppointment screening link: relink, clear-on-omit, FK on UPDATE');
{
  const { db } = freshDb();
  const a = addScreening(db, { name: 'Skin check', category: 'derm' });
  const b = addScreening(db, { name: 'Eye exam', category: 'vision' });
  const fields = { title: 'Visit', scheduledAt: '2026-08-01T15:00:00.000Z' };
  const appt = addAppointment(db, { ...fields, screeningId: a });
  updateAppointment(db, appt, { ...fields, screeningId: b });
  getAppointment(db, appt)?.screening_id === b
    ? ok('relinking to another screening persists')
    : bad('relink', JSON.stringify(getAppointment(db, appt)));
  updateAppointment(db, appt, fields);
  getAppointment(db, appt)?.screening_id === null
    ? ok('full-update contract: omitted screeningId clears the link (the unlink flow)')
    : bad('clear-on-omit', JSON.stringify(getAppointment(db, appt)));
  throws(() => updateAppointment(db, appt, { ...fields, screeningId: 'bogus-screening-id-0000' }))
    ? ok('unknown screening_id rejected on UPDATE too')
    : bad('dangling FK accepted on update');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
