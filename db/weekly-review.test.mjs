/**
 * Headless test of the WEEKLY REVIEW (owner's decision, 2026-10-21;
 * docs/ai-coach.md › The weekly review; docs/reports-subapp.md §6b) against
 * real SQLite via node:sqlite, with the model replaced by a scripted wire:
 *
 *   W1 the trigger: Sunday 18:00, a missed Sunday, never twice a week, quiet
 *      hours, a rolled-back clock, the first-sight baseline, a 04:00 day
 *   W2 the report is the self-review's, figure for figure, and is filed
 *   W3 the read keeps only lines whose numbers trace; an invented one is dropped
 *   W4 at most three decisions, drafted not executed, on their own allowance
 *   W5 a SKIP files the report bare; an offline pass files nothing
 *   W6 the doctor pack never carries the read
 *   W7 through the pass store: before the regular pass, deferred behind a tap
 *
 * No network, no API key (a placeholder string only), no model call.
 * Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { setDayStartsAt, shiftISODate, todayISODate } from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { getOrCreateUser } from '../src/lib/db/repositories/user.ts';
import { listActiveReminders } from '../src/lib/db/repositories/reminders.ts';
import { logMeal } from '../src/lib/db/repositories/nutrition.ts';
import { saveNudgeSettings } from '../src/lib/db/repositories/coach-nudges.ts';
import { getReport, getReportSnapshot, readNarrative } from '../src/lib/db/repositories/reports.ts';
import * as chatRepo from '../src/lib/db/repositories/ai-chat.ts';
import * as proposals from '../src/lib/ai/proposals.ts';
import * as weekly from '../src/lib/ai/weekly-review.ts';
import { markPassRan } from '../src/lib/ai/pass-schedule.ts';
import { PASS_MODEL } from '../src/lib/ai/coach-pass.ts';
import { WRITE_TOOLS } from '../src/lib/ai/tools/index.ts';
import { assembleSelfReview } from '../src/lib/reports/assemble-self-review.ts';
import { assembleDoctorPack } from '../src/lib/reports/assemble-doctor-pack.ts';
import { lastCompleteWeek, validateCustomRange } from '../src/lib/reports/period.ts';
import { renderReportHtml } from '../src/lib/reports/render-html.ts';
import { COACH_READ_ATTRIBUTION } from '../src/lib/reports/coach-read.ts';

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
const check = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));

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
  getOrCreateUser(db);
  return db;
}

/** Every row of every table, as JSON — minus the tables named. */
function dump(db, except = []) {
  const tables = db
    .all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .map((r) => r.name)
    .filter((name) => !except.includes(name));
  return JSON.stringify(tables.map((name) => [name, db.all(`SELECT * FROM "${name}" ORDER BY rowid`)]));
}

const sse = (text) =>
  [
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}`,
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
    '',
    '',
  ].join('\n');
const wire = (text, requests) => async (_url, init) => {
  if (requests) requests.push(JSON.parse(init.body));
  return {
    ok: true,
    status: 200,
    text: async () => '',
    body: {
      getReader() {
        let done = false;
        return {
          async read() {
            if (done) return { done: true };
            done = true;
            return { done: false, value: new TextEncoder().encode(sse(text)) };
          },
        };
      },
    },
  };
};
const offline = async () => {
  throw new Error('offline');
};
const directiveOf = (request) => {
  const last = request.messages[request.messages.length - 1];
  return typeof last.content === 'string' ? last.content : last.content.map((b) => b.text).join('');
};

const { apiKeyStore } = await import('../src/lib/ai/api-key-store.ts');
const { coachPassStore } = await import('../src/lib/ai/pass-store.ts');
const { runWeeklyIfDue } = await import('../src/lib/ai/weekly-runner.ts');
// A placeholder, never a real key: the wire is scripted and nothing leaves the process.
await apiKeyStore.setKey('test-key');
await apiKeyStore.hydrate();

// A fixed week: Monday 12 – Sunday 18 October 2026, local time.
const at = (day, h, m = 0) => new Date(2026, 9, day, h, m, 0, 0);
const MON = '2026-10-12';
const SUN = '2026-10-18';
const PREV_MON = '2026-10-05';
const seedState = (db, lastWeek) => weekly.setWeeklyState(db, { lastWeek, latest: null });
const reminderLine = (title) =>
  `PROPOSE set_reminder {"title":"${title}","time":"19:00"} The week ran late three evenings.`;

console.log('W1. the trigger');
{
  const db = freshDb();
  // The weeks themselves.
  const sunEvening = weekly.reviewWeekFor(at(18, 18, 0));
  const sunAfternoon = weekly.reviewWeekFor(at(18, 17, 59));
  const monday = weekly.reviewWeekFor(at(19, 9, 0));
  check(
    sunEvening.start === MON && sunEvening.end === SUN && sunEvening.includesToday,
    'Sunday 18:00 reviews the week ending today, and says the week reaches today',
    JSON.stringify(sunEvening)
  );
  check(
    sunAfternoon.start === PREV_MON && sunAfternoon.end === '2026-10-11',
    'Sunday 17:59 is still the week before',
    JSON.stringify(sunAfternoon)
  );
  check(
    monday.start === MON && monday.end === SUN && !monday.includesToday,
    'Monday reviews the week that ended Sunday — the same week Sunday evening would have',
    JSON.stringify(monday)
  );

  // First sight: a baseline, no run.
  const first = weekly.dueWeekly(db, at(21, 12));
  check(first?.baseline === true, 'with nothing stored, the first sight is a baseline', JSON.stringify(first));

  seedState(db, PREV_MON);
  check(weekly.dueWeekly(db, at(18, 17, 59)) === null, 'not due at Sunday 17:59');
  const due = weekly.dueWeekly(db, at(18, 18, 0));
  check(due?.baseline === false && due.period.start === MON, 'due at Sunday 18:00', JSON.stringify(due));
  // Quiet hours (default 21:30–07:00): Sunday 22:00 waits, Monday 07:30 fires.
  check(weekly.dueWeekly(db, at(18, 22, 0)) === null, 'a first open inside quiet hours waits them out');
  check(weekly.dueWeekly(db, at(19, 6, 59)) === null, '…still waiting at 06:59 Monday');
  check(weekly.dueWeekly(db, at(19, 7, 30))?.period.start === MON, 'a missed Sunday fires on the next open after quiet hours, for that week');
  check(weekly.dueWeekly(db, at(23, 12))?.period.start === MON, 'a missed Sunday still fires on Friday');

  weekly.markWeekReviewed(db, MON, null);
  check(
    [at(18, 19), at(19, 9), at(21, 12), at(25, 17, 59)].every((d) => weekly.dueWeekly(db, d) === null),
    'never twice for one week: Sunday night, Monday, Wednesday, next Sunday 17:59 are all quiet'
  );
  check(weekly.dueWeekly(db, at(25, 18, 0))?.period.start === '2026-10-19', 'the next Sunday 18:00 is the next week');

  // A clock rolled back behind the stored week cannot re-fire it…
  weekly.markWeekReviewed(db, '2026-10-19', null);
  check(weekly.dueWeekly(db, at(18, 19)) === null, 'a rolled-back clock does not re-fire a reviewed week');
  // …and the cursor only moves forward.
  weekly.markWeekReviewed(db, MON, null);
  check(weekly.getWeeklyState(db).lastWeek === '2026-10-19', 'the week cursor never moves backward');

  // A 04:00 day: Monday 01:00 on the wall is still Sunday evening.
  const late = freshDb();
  seedState(late, PREV_MON);
  saveNudgeSettings(late, { quietStart: '00:00', quietEnd: '00:00' }, at(18, 12));
  setDayStartsAt('04:00');
  try {
    const smallHours = weekly.dueWeekly(late, at(19, 1, 0));
    check(
      smallHours?.period.start === MON && smallHours.period.end === SUN,
      '04:00 boundary: 01:00 Monday is logical Sunday evening, and the week ending that Sunday is due',
      JSON.stringify(smallHours?.period)
    );
    check(
      weekly.dueWeekly(late, at(18, 2, 0)) === null,
      '04:00 boundary: 02:00 Sunday is still logical Saturday — not due'
    );
    check(
      weekly.dueWeekly(late, at(18, 18, 0))?.period.start === MON,
      '04:00 boundary: Sunday 18:00 is due as usual'
    );
  } finally {
    setDayStartsAt('00:00');
  }
}

/** A database with a week of meals, a cursor one week back, and the pass's day already looked at. */
function weekDb(now) {
  const db = freshDb();
  for (let i = 0; i < 7; i++) {
    const date = shiftISODate(MON, i);
    logMeal(db, { date, time: '08:00', name: 'Oats', kcal: 512, protein_g: 31 });
    if (i % 2 === 0) logMeal(db, { date, time: '19:00', name: 'Salmon', kcal: 1433, protein_g: 77 });
  }
  seedState(db, PREV_MON);
  // The regular passes have already looked today, so only the review is due.
  markPassRan(db, now, { evening: true });
  return db;
}

/** A figure the report really prints, as written, worth tracing (>12, not a date). */
function realFigure(data) {
  const json = weekly.reportForModel(data);
  for (const m of json.matchAll(/"value":"([0-9][0-9,.]*)"/g)) {
    if (Number(m[1].replace(/,/g, '')) > 12) return m[1];
  }
  return null;
}

const strip = (data) => ({ ...data, period: { ...data.period, kind: '', label: '' } });

console.log('\nW2–W4. one review, run: the report, the read, the decisions');
{
  const now = at(19, 9, 0); // a missed Sunday: the Monday open
  const db = weekDb(now);
  const expected = assembleSelfReview(db, lastCompleteWeek(now), { now });
  const figure = realFigure(expected);
  check(figure !== null, `the week has a real figure to cite (${figure})`);
  const reply = [
    `Breakfast held all seven days; dinners were logged on four of them.`,
    `Intake read ${figure} on the nutrition line.`,
    'HRV averaged 87.4 ms across the week.',
    '',
    reminderLine('Lights out'),
    reminderLine('Prep lunch'),
    reminderLine('Stretch'),
    reminderLine('Fourth thing'),
  ].join('\n');
  const requests = [];
  const before = dump(db, ['users', 'ai_messages', 'ai_conversations', 'reports']);
  const outcome = await runWeeklyIfDue(db, { now, fetchImpl: wire(reply, requests) });
  check(outcome === 'ran', 'the review ran and spoke', String(outcome));

  // W2 — the report.
  const rows = db.all('SELECT * FROM reports');
  check(rows.length === 1 && rows[0].report_type === 'self_review', 'one self-review row filed');
  const row = rows[0];
  check(row.period_start === MON && row.period_end === SUN, 'filed for 12–18 Oct');
  const stored = getReportSnapshot(db, row.id);
  check(
    JSON.stringify(strip(stored)) === JSON.stringify(strip(expected)),
    'the stored report equals the self-review screen’s Last week for the same week, figure for figure'
  );
  check(stored.period.label === weekly.WEEKLY_PERIOD_LABEL, 'labelled as the weekly review');
  check(
    row.file_name.startsWith('arc-report-self-review-') && row.file_path === `reports/${row.file_name}`,
    'named as a self-review file would be (written on Share again)'
  );

  // W3 — the read.
  const read = row.narrative_text?.split('\n') ?? [];
  check(
    read.length === 2 && read[1] === `Intake read ${figure} on the nutrition line.`,
    'the read is stored in narrative_text, with the traced figure kept',
    JSON.stringify(read)
  );
  check(!row.narrative_text.includes('87.4'), 'the line with an invented number is dropped whole');
  check(!row.data_json.includes('Intake read'), 'the read never enters data_json');
  check(readNarrative(row, COACH_READ_ATTRIBUTION)?.attribution === COACH_READ_ATTRIBUTION, 'it reads back with the Coach’s-read attribution');
  const directive = directiveOf(requests[0]);
  check(
    directive.includes('weekly review of 12 – 18 Oct 2026') &&
      directive.includes(weekly.reportForModel(stored)) &&
      !directive.includes('NUDGE') &&
      !directive.includes('BRIEF'),
    'the pass is told the week and handed the report; no nudges, no brief'
  );
  check(
    requests[0].model === PASS_MODEL &&
      !requests[0].tools.some((t) => WRITE_TOOLS.some((w) => w.name === t.name)),
    'the pass model and the read tools only — no write tool on the wire'
  );

  // W4 — the decisions.
  const all = proposals.listProposals(db, now);
  const mine = proposals.weeklyDrafts(all, MON);
  check(
    mine.length === 3 && mine.every((p) => p.status === 'pending' && p.weekly?.through === '2026-10-20'),
    'three decisions kept, pending, open through tomorrow',
    JSON.stringify(mine.map((p) => [p.summary, p.status, p.weekly]))
  );
  check(
    dump(db, ['users', 'ai_messages', 'ai_conversations', 'reports']) === before &&
      listActiveReminders(db).length === 0,
    'drafted, not executed: no reminder exists, nothing but the preferences, the thread and the report moved'
  );
  const directiveNext = proposals.proposalDirectiveFor(db, now);
  check(
    directiveNext.remaining === 3 && mine.every((p) => directiveNext.pending.includes(p.summary)),
    'the day’s own three are untouched, and the daily pass is told the decisions are waiting'
  );
  check(
    directiveNext.refused.some((r) => r.reason === 'over the 3-decision cap for the weekly review'),
    'the fourth is refused on the weekly cap and told to the next pass'
  );
  check(proposals.draftsForDay(all, todayISODate(now)).length === 0, 'Home’s daily drafts do not repeat them');
  check(weekly.weeklyProposalDirectiveFor(db, now, MON).remaining === 0, 'the week’s allowance is spent');
  // The two-day life.
  check(
    proposals.listProposals(db, at(20, 20)).filter((p) => p.weekly).every((p) => p.status === 'pending') &&
      proposals.listProposals(db, at(21, 9)).filter((p) => p.weekly).every((p) => p.status === 'expired'),
    'still open the next evening, expired the day after'
  );

  // The thread record and Home.
  const thread = chatRepo.listMessages(db, chatRepo.getOrCreateActiveConversation(db).id);
  const last = thread[thread.length - 1];
  check(
    last.content.startsWith(`Your week, 12 – 18 Oct 2026:\n${read[0]}`) &&
      last.content.includes('\n\nDrafted for your approval:\n· ') &&
      !thread.some((m) => /PROPOSE|87\.4/.test(m.content)) &&
      mine.every((p) => p.messageId === last.id),
    'the thread records the read and the decisions, the decisions point at that row, nothing leaks'
  );
  const card = weekly.weeklyCardFor(db, all, now);
  check(
    card?.reportId === row.id && card.read?.length === 2 && card.drafts.length === 3,
    'Home’s “Your week”: the read, the decisions, the report'
  );
  check(weekly.weeklyCardFor(db, all, at(20, 21)) !== null, '…still there the next day');
  check(weekly.weeklyCardFor(db, all, at(21, 9)) === null, '…and gone the day after');

  // Never twice.
  check((await runWeeklyIfDue(db, { now: at(19, 20), fetchImpl: wire(reply) })) === null, 'a second open that week runs nothing');
  check(db.all('SELECT id FROM reports').length === 1, '…and files nothing');

  // Approve runs the chat write path, exactly what the card said.
  const res = await proposals.approveProposal(db, mine[0].id, { now: at(19, 10) });
  check(res.status === 'approved' && listActiveReminders(db).length === 1, 'an approved decision writes through the gate');
}

console.log('\nW2b. Sunday evening: the week ends today, and the report says so');
{
  const now = at(18, 18, 30);
  const db = weekDb(now);
  saveNudgeSettings(db, { enabled: false }, now);
  const outcome = await runWeeklyIfDue(db, { now, fetchImpl: wire('SKIP') });
  const row = db.get('SELECT * FROM reports');
  const stored = getReportSnapshot(db, row.id);
  const screen = validateCustomRange(MON, SUN, now);
  check(outcome === 'silent' && row.narrative_text === null, 'a SKIP files the report with no read');
  check(
    screen.ok && JSON.stringify(strip(stored)) === JSON.stringify(strip(assembleSelfReview(db, screen.period, { now }))),
    'figure for figure the screen’s range ending today'
  );
  check(typeof stored.todayNote === 'string' && stored.todayNote.includes('excludes it'), 'with the today note: accumulating totals stop at Saturday');
  check(weekly.weeklyCardFor(db, [], now)?.read === null, 'Home still shows the week, with no read');
}

console.log('\nW5. offline files nothing and leaves the week due');
{
  const now = at(19, 9);
  const db = weekDb(now);
  const outcome = await runWeeklyIfDue(db, { now, fetchImpl: offline });
  check(outcome === 'offline', 'offline', String(outcome));
  check(db.all('SELECT id FROM reports').length === 0, 'no report filed');
  check(weekly.dueWeekly(db, at(19, 10))?.period.start === MON, 'the week is still due');
}

console.log('\nW6. the doctor pack never carries the read');
{
  const now = at(19, 9);
  const db = weekDb(now);
  const line = 'Breakfast held all seven days.';
  await runWeeklyIfDue(db, { now, fetchImpl: wire(line) });
  const row = db.get('SELECT * FROM reports');
  check(row.narrative_text === line, 'the read is on the self-review');
  const pack = assembleDoctorPack(db, { now });
  const read = { text: row.narrative_text, attribution: COACH_READ_ATTRIBUTION, model: null };
  check(!JSON.stringify(pack).includes(line), 'the doctor pack’s data has no trace of it');
  check(!renderReportHtml(pack, read).includes(line), 'even handed the read, the doctor pack does not render it');
  check(renderReportHtml(getReportSnapshot(db, row.id), read).includes(line), 'the self-review does');
  check(db.all("SELECT id FROM reports WHERE report_type = 'doctor_pack'").length === 0, 'the review files no doctor pack');
}

console.log('\nW7. through the pass store');
{
  const now = at(19, 9);
  const db = weekDb(now);
  coachPassStore.reset();
  const requests = [];
  const outcome = await coachPassStore.maybeRun(db, {
    unlocked: true,
    now,
    fetchImpl: wire('Breakfast held all seven days.', requests),
  });
  check(outcome === 'ran' && requests.length === 1, 'the store runs the review when only it is due', `${outcome} ${requests.length}`);
  check(db.all('SELECT id FROM reports').length === 1, 'and it is filed');

  // Locked: nothing.
  const locked = weekDb(now);
  coachPassStore.reset();
  await coachPassStore.maybeRun(locked, { unlocked: false, now, fetchImpl: wire('x') });
  check(locked.all('SELECT id FROM reports').length === 0, 'behind the app lock, no review');

  // With the day's look due too: the review first, then the day's pass, one open.
  const both = weekDb(now);
  both.run("UPDATE users SET preferences = json_remove(preferences, '$.coachPass')");
  coachPassStore.reset();
  const seen = [];
  await coachPassStore.maybeRun(both, { unlocked: true, now, fetchImpl: wire('SKIP', seen) });
  check(
    seen.length === 2 && directiveOf(seen[0]).startsWith('[Automatic weekly pass') && directiveOf(seen[1]).startsWith('[Automatic daily pass'),
    'review first, then the day’s pass, in one open',
    seen.map((r) => directiveOf(r).slice(0, 30)).join(' | ')
  );

  // A tapped check-in is answered first; the review waits for the wake-up after.
  const tapped = weekDb(now);
  coachPassStore.reset();
  let woke = 0;
  const off = coachPassStore.subscribeRequests(() => woke++);
  coachPassStore.requestCheckin({ kind: 'morning' });
  woke = 0;
  const order = [];
  await coachPassStore.maybeRun(tapped, { unlocked: true, now, fetchImpl: wire('A word.', order) });
  off();
  check(
    order.length === 1 && !directiveOf(order[0]).includes('weekly review') && woke === 1,
    'a waiting check-in goes first, and the runner is woken for the review',
    `${order.length} ${woke}`
  );
  await coachPassStore.maybeRun(tapped, { unlocked: true, now, fetchImpl: wire('A word.', order) });
  check(directiveOf(order[1]).startsWith('[Automatic weekly pass'), 'the next wake-up runs the review');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
