/**
 * Headless test of COACH PROPOSALS and the MODEL-VOICED BRIEF (owner's
 * decision, 2026-10-21; docs/ai-coach.md › Coach proposals) against real
 * SQLite via node:sqlite, with the model replaced by a scripted wire:
 *
 *   - the PROPOSE / BRIEF grammar: strict lines out, the note left, nothing guessed
 *   - the pass stays read-only: drafted cards, an unchanged database
 *   - the three-a-day cap, the duplicate rule, the refusals told to the next pass
 *   - Approve runs the chat write path and writes exactly what the card said
 *   - a stale draft refuses; a resolved finding refuses; an expired draft refuses
 *   - Decline is recorded as a chat decline, and the next turn is told
 *   - the brief keeps only lines whose numbers the pass read
 *   - the new pass triggers, and quiet hours
 *
 * No network, no API key (a placeholder string only), no model call.
 * Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { shiftISODate, todayISODate } from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { getOrCreateUser } from '../src/lib/db/repositories/user.ts';
import { createReminder, listActiveReminders } from '../src/lib/db/repositories/reminders.ts';
import { getMeal, logMeal, updateMealName } from '../src/lib/db/repositories/nutrition.ts';
import { addAppointment, addScreening } from '../src/lib/db/repositories/screenings.ts';
import { saveNudgeSettings, getNudgeSettings } from '../src/lib/db/repositories/coach-nudges.ts';
import * as chatRepo from '../src/lib/db/repositories/ai-chat.ts';
import { parsePassLines, leadingJsonObject } from '../src/lib/ai/proposal-lines.ts';
import * as proposals from '../src/lib/ai/proposals.ts';
import { passDirective } from '../src/lib/ai/coach-pass.ts';
import { duePass, markPassRan, passSignals, PASS_SIGNAL_SOURCES } from '../src/lib/ai/pass-schedule.ts';
import { buildTurnContext } from '../src/lib/ai/turn-context.ts';
import { runGatedTool } from '../src/lib/ai/write-gate.ts';
import { toolByName } from '../src/lib/ai/tools/index.ts';
import { findingById } from '../src/lib/ai/findings.ts';

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
  return { raw, db };
}

/** Every row of every table, as JSON — minus the tables named. */
function dump(db, except = []) {
  const tables = db
    .all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .map((r) => r.name)
    .filter((name) => !except.includes(name));
  return JSON.stringify(
    tables.map((name) => [name, db.all(`SELECT * FROM "${name}" ORDER BY rowid`)])
  );
}

// Noon today: a pass after 18:00 is the evening pass, and these fixtures want the daily one.
const NOW = new Date();
NOW.setHours(12, 0, 0, 0);
const TODAY = todayISODate(NOW);
const TOMORROW_NOON = new Date(NOW.getTime() + 86_400_000);
const at = (h, m = 0) => {
  const d = new Date(NOW);
  d.setHours(h, m, 0, 0);
  return d;
};

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
const directiveOf = (request) => {
  const last = request.messages[request.messages.length - 1];
  return typeof last.content === 'string' ? last.content : last.content.map((b) => b.text).join('');
};

const { apiKeyStore } = await import('../src/lib/ai/api-key-store.ts');
const { coachPassStore } = await import('../src/lib/ai/pass-store.ts');
const { runCoachPass } = await import('../src/lib/ai/coach-pass.ts');
// A placeholder, never a real key: the wire is scripted and nothing leaves the process.
await apiKeyStore.setKey('test-key');
await apiKeyStore.hydrate();

const reminderLine = (title, time = '19:00') =>
  `PROPOSE set_reminder {"title":"${title}","time":"${time}"} Your last three evenings ran late.`;

console.log('P1. the grammar: PROPOSE and BRIEF lines out, the note left, nothing guessed');
{
  const parsed = parsePassLines(
    [
      'Sleep has slipped three nights running.',
      '',
      'Drafts:',
      '- **PROPOSE set_reminder {"title":"Lights out","time":"22:15"} — bed by 22:30 three nights running**',
      'PROPOSE until 14:00 finding rec:gap_1 log_note {"text":"under_score kept"} because it fits',
      'PROPOSE Adjust today with a lighter session',
      'PROPOSE set_reminder {"title": broken} why',
      'PROPOSE set_reminder {"title":"No why"}',
      'BRIEF: HRV is 36 ms against a 50 baseline.',
      'BRIEF',
      'Propose a lighter week to him is prose, and stays.',
    ].join('\n')
  );
  parsed.proposals.length === 2 &&
  parsed.proposals[0].tool === 'set_reminder' &&
  parsed.proposals[0].input.title === 'Lights out' &&
  parsed.proposals[0].reason === 'bed by 22:30 three nights running' &&
  parsed.proposals[0].until === null
    ? ok('a bulleted, bold line parses: the tool, the JSON, the reason without its dash')
    : bad('valid line', JSON.stringify(parsed.proposals[0]));
  const second = parsed.proposals[1];
  second &&
  second.until === '14:00' &&
  second.finding === 'rec:gap_1' &&
  second.tool === 'log_note' &&
  second.input.text === 'under_score kept'
    ? ok('until and finding qualifiers parse, and underscores inside JSON survive')
    : bad('qualifiers', JSON.stringify(second));
  JSON.stringify(parsed.malformed.map((m) => m.why)) === '["grammar","json","reason"]'
    ? ok('three malformed lines dropped and counted: no JSON, bad JSON, no reason')
    : bad('malformed', JSON.stringify(parsed.malformed));
  parsed.brief.length === 1 && parsed.brief[0] === 'HRV is 36 ms against a 50 baseline.'
    ? ok('a BRIEF line is cleaned; an empty one is dropped')
    : bad('brief', JSON.stringify(parsed.brief));
  parsed.text === 'Sleep has slipped three nights running.\n\nPropose a lighter week to him is prose, and stays.' &&
  !parsed.text.includes('Drafts:')
    ? ok('the note survives, the label above the lines goes with them, and capitalised prose is not swallowed')
    : bad('text', JSON.stringify(parsed.text));
  parsed.lead === 'Sleep has slipped three nights running.'
    ? ok('the lead is the note before the first line (the SKIP verdict reads it)')
    : bad('lead', JSON.stringify(parsed.lead));
  leadingJsonObject('{"a":"}{"} rest')?.rest === ' rest'
    ? ok('the JSON scanner respects braces inside strings')
    : bad('json scanner');
  const upper = parsePassLines(
    'PROPOSE UNTIL 14:00 FINDING rec:gap_1 log_note {"text":"x"} why\nPROPOSE Until 09:30 log_note {"text":"y"} why'
  );
  upper.proposals.length === 2 &&
  upper.malformed.length === 0 &&
  upper.proposals[0].until === '14:00' &&
  upper.proposals[0].finding === 'rec:gap_1' &&
  upper.proposals[1].until === '09:30'
    ? ok('UNTIL and FINDING parse in any case, as PLAN’s UNTIL does')
    : bad('qualifier case', JSON.stringify(upper));
  const placeholders = parsePassLines('SKIP\nBRIEF NONE\nBRIEF: skip.\nBRIEF None!\nBRIEF None of your sleep data synced.');
  JSON.stringify(placeholders.brief) === '["None of your sleep data synced."]'
    ? ok('BRIEF NONE / BRIEF SKIP is no brief, not a line on Home; a sentence opening "None" is kept')
    : bad('brief placeholder', JSON.stringify(placeholders.brief));
  const fenced = parsePassLines('SKIP\n```\nPROPOSE log_note {"text":"x"} y\n```');
  fenced.text === 'SKIP' && fenced.proposals.length === 1
    ? ok('a fence round the lines goes too, so a SKIP stays bare')
    : bad('fence', JSON.stringify(fenced.text));
}

console.log('P2. the directive: the drafts block, how many remain, the signatures, measured');
{
  const { db } = freshDb();
  const extras = { proposals: proposals.proposalDirectiveFor(db, NOW), brief: true };
  const plain = passDirective({ kind: 'daily' }, TODAY);
  const full = passDirective({ kind: 'daily' }, TODAY, null, extras);
  !plain.includes('PROPOSE') && !plain.includes('BRIEF')
    ? ok('without extras the directive is word for word the old one')
    : bad('plain directive changed');
  full.includes('You may draft 3 more today (3 a day)') &&
  full.includes('PROPOSE tool_name {') &&
  full.includes('  set_reminder(title, time?') &&
  full.includes('  edit_record(domain=') &&
  full.includes('3 to 5 lines, each beginning BRIEF')
    ? ok('the block says how many remain, the grammar, every write tool’s inputs, and the brief')
    : bad('full directive', full.slice(plain.length, plain.length + 400));
  full.includes('finding <id>')
    ? ok('the finding qualifier is offered: the record findings are wired at merge')
    : bad('finding qualifier not offered');
  // Measured with db/coach-eval.test.mjs §6's prose proxy. The block rides the
  // pass's own user message: neither chat ceiling moves.
  const proseTok = (s) => Math.round(s.length / 3.6);
  const added = proseTok(full) - proseTok(plain);
  console.log(`       (the drafts + brief block: ~${added} tokens, ${full.length - plain.length} chars)`);
  added > 0 && added < 1100
    ? ok(`the block is bounded (~${added} tok, uncached, the pass alone pays it)`)
    : bad('block size', String(added));
  const noBrief = passDirective({ kind: 'daily' }, TODAY, null, { ...extras, brief: false });
  !noBrief.includes('BRIEF:') && !noBrief.includes('3 to 5 lines')
    ? ok('a pass that is not the first look is not asked for a brief')
    : bad('brief asked twice');
  const used = passDirective({ kind: 'daily' }, TODAY, null, {
    brief: false,
    proposals: { remaining: 0, pending: ['Set reminder "Lights out"'], refused: [{ line: 'PROPOSE x {}', reason: 'x is not a tool' }] },
  });
  used.includes("Today's 3 drafts are used: write no PROPOSE line.") &&
  used.includes('  Set reminder "Lights out"') &&
  used.includes('  PROPOSE x {} (x is not a tool)') &&
  !used.includes('set_reminder(')
    ? ok('at the cap it is told so, shown what is waiting and what was refused, and spared the signatures')
    : bad('cap directive', used.slice(plain.length));
}

console.log('P3. the pass drafts and executes NOTHING: cards drawn, database unchanged');
{
  const { db } = freshDb();
  const mealId = logMeal(db, { date: TODAY, time: '12:30', name: 'Pasta', kcal: 700 });
  const before = dump(db);
  const result = await runCoachPass(db, {
    trigger: { kind: 'daily' },
    now: NOW,
    fetchImpl: wire(
      [
        'Bedtime has drifted.',
        reminderLine('Lights out'),
        'PROPOSE log_metric {"metric":"weight","value":80,"unit":"kg"} You said 80 this morning.',
        'PROPOSE log_metric {"metric":"mood","value":3} Bad metric.',
        'PROPOSE get_insights {} A read.',
        'PROPOSE launch_rocket {} Not a tool.',
        `PROPOSE edit_record {"domain":"meals","id":"${mealId}","fields":{"name":"Pasta bowl"}} Clearer.`,
        `PROPOSE delete_record {"domain":"meals","id":"${mealId}"} A duplicate.`,
        ,
        ,
      ].join('\n')
    ),
  });
  dump(db) === before
    ? ok('runCoachPass wrote nothing at all — not a row, not a preference')
    : bad('the pass wrote');
  result.message === 'Bedtime has drifted.'
    ? ok('the note is the note, with no PROPOSE line in it')
    : bad('message', JSON.stringify(result.message));
  const drafted = result.proposals.drafted;
  drafted.length === 4 &&
  drafted[0].tool === 'set_reminder' &&
  drafted[3].snapshot.kind === 'delete' &&
  drafted[2].snapshot.card?.id === mealId &&
  drafted[0].summary === toolByName('set_reminder').confirmSummary(drafted[0].input, db, { now: NOW }) &&
  drafted[1].summary === toolByName('log_metric').confirmSummary(drafted[1].input, db, { now: NOW })
    ? ok('four drafts (a reminder, a weight, an edit, a removal), each card drawn by the tool’s own confirmSummary, the edit carrying its staleness slot')
    : bad('drafted', JSON.stringify(drafted.map((d) => d.summary)));
  const reasons = result.proposals.refused.map((r) => r.reason);
  reasons.length === 3 &&
  reasons.some((r) => /metric/.test(r)) &&
  reasons.includes('get_insights is a read, not a change') &&
  reasons.includes('launch_rocket is not a tool')
    ? ok('refused: input the tool’s parser rejects, a read, an unknown name — each in its own words')
    : bad('refused', JSON.stringify(reasons));

  // A workout draft on a day nothing has opened yet: its card reads which
  // Training row it would tick, and drawing it must not arrive the day
  // (log_workout's confirmSummary arrives it in chat; `context.draft` here).
  {
    const { db: wdb } = freshDb();
    const untouched = dump(wdb);
    const drew = await runCoachPass(wdb, {
      trigger: { kind: 'daily' },
      now: NOW,
      fetchImpl: wire('SKIP\nPROPOSE log_workout {"kind":"cardio","duration_min":30} You ran.'),
    });
    dump(wdb) === untouched &&
    wdb.all('SELECT id FROM daily_logs').length === 0 &&
    drew.proposals.drafted.length === 1 &&
    drew.proposals.drafted[0].summary === 'Log workout · 30 min'
      ? ok('a log_workout draft is drawn and the pass still wrote nothing — no daily_logs row')
      : bad('workout draft wrote', JSON.stringify({ days: wdb.all('SELECT date FROM daily_logs'), drafted: drew.proposals.drafted.map((d) => d.summary) }));
    const [kept] = proposals.recordProposals(wdb, drew.proposals.drafted, [], NOW);
    const approved = await proposals.approveProposal(wdb, kept.id, { now: NOW });
    approved.status === 'approved' &&
    wdb.all("SELECT id FROM workouts WHERE kind = 'cardio'").length === 1
      ? ok('  → and his tap, which does arrive the day, redraws the same card and writes it')
      : bad('workout approval', JSON.stringify(approved));
  }

  // The whole path: the store, the cap, the thread.
  coachPassStore.reset();
  const beforeRun = dump(db, ['users', 'ai_messages', 'ai_conversations']);
  const outcome = await coachPassStore.maybeRun(db, {
    unlocked: true,
    now: NOW,
    fetchImpl: wire(['SKIP', reminderLine('Lights out')].join('\n')),
  });
  dump(db, ['users', 'ai_messages', 'ai_conversations']) === beforeRun &&
  listActiveReminders(db).length === 0
    ? ok('after the whole pass, only the preferences and the thread moved: no reminder exists')
    : bad('pass store wrote a record row');
  const pending = proposals.listProposals(db, NOW);
  outcome === 'silent' && pending.length === 1 && pending[0].status === 'pending'
    ? ok('a silent pass may still draft: one pending, stored')
    : bad('store', JSON.stringify({ outcome, pending }));
  const thread = chatRepo.listMessages(db, chatRepo.getOrCreateActiveConversation(db).id);
  const record = thread[thread.length - 1];
  record.content === `Drafted for your approval:\n· ${pending[0].summary}` &&
  pending[0].messageId === record.id &&
  !thread.some((m) => m.content.includes('PROPOSE'))
    ? ok('the thread records the draft, the draft points at that row, and no sentinel leaks')
    : bad('thread record', JSON.stringify(record.content));
  proposals.splitProposalRecord(record.content) === '' &&
  proposals.splitProposalRecord(`A note.\n\n${record.content}`) === 'A note.'
    ? ok('the thread strips the record back off the bubble it draws as cards')
    : bad('split');
}

console.log('P4. three a day, counted when drafted; a repeat is the same draft twice');
{
  const { db } = freshDb();
  const one = await runCoachPass(db, {
    trigger: { kind: 'daily' },
    now: NOW,
    fetchImpl: wire(['A', 'B', 'C', 'D'].map((t) => reminderLine(t)).join('\n')),
  });
  const kept = proposals.recordProposals(db, one.proposals.drafted, one.proposals.refused, NOW);
  const state = proposals.proposalDirectiveFor(db, NOW);
  kept.length === 3 &&
  state.remaining === 0 &&
  state.refused.some((r) => r.reason === 'over the 3-a-day cap')
    ? ok('four valid lines: three kept, the fourth refused over the cap, and the next pass is told 0 remain')
    : bad('cap', JSON.stringify({ kept: kept.length, state }));
  proposals.declineProposal(db, kept[0].id, NOW);
  proposals.proposalDirectiveFor(db, NOW).remaining === 0
    ? ok('a decline does not buy another draft')
    : bad('decline refunded the cap');

  const { db: db2 } = freshDb();
  const a = await runCoachPass(db2, { trigger: { kind: 'daily' }, now: NOW, fetchImpl: wire(reminderLine('Same')) });
  proposals.recordProposals(db2, a.proposals.drafted, [], NOW);
  const again = proposals.recordProposals(db2, a.proposals.drafted, [], NOW);
  again.length === 0 &&
  proposals.proposalDirectiveFor(db2, NOW).refused[0]?.reason === 'already waiting on him'
    ? ok('a draft whose card is already pending is dropped, and the pass is told why')
    : bad('duplicate');
  const tomorrow = proposals.proposalDirectiveFor(db, TOMORROW_NOON);
  tomorrow.remaining === 3 && tomorrow.pending.length === 0
    ? ok('the next day starts at three, with nothing carried over')
    : bad('next day', JSON.stringify(tomorrow));
}

/** Draft one line through a real pass and store it; returns the stored draft. */
async function draftOne(db, line, now = NOW) {
  const result = await runCoachPass(db, { trigger: { kind: 'daily' }, now, fetchImpl: wire(line) });
  return proposals.recordProposals(db, result.proposals.drafted, result.proposals.refused, now)[0];
}

console.log('P5. Approve runs the chat write path and writes exactly what the card said');
{
  const { db } = freshDb();
  const draft = await draftOne(db, reminderLine('Lights out', '22:15'));
  const result = await proposals.approveProposal(db, draft.id, { now: at(13) });
  const rows = listActiveReminders(db);
  result.status === 'approved' &&
  result.line === draft.summary &&
  rows.length === 1 &&
  rows[0].title === 'Lights out' &&
  rows[0].time === '22:15'
    ? ok('the reminder exists, as the card described it, and the receipt IS the card line')
    : bad('approve', JSON.stringify({ result, rows }));
  const thread = chatRepo.listMessages(db, chatRepo.getOrCreateActiveConversation(db).id);
  const last = thread[thread.length - 1];
  const calls = chatRepo.parseToolCalls(last.tool_calls);
  calls.length === 1 && calls[0].receipt === draft.summary && calls[0].name === 'set_reminder'
    ? ok('the thread carries the receipt, so it prints "Saved to your record" like a chat approval')
    : bad('receipt', JSON.stringify(calls));
  proposals.listProposals(db, at(13))[0].status === 'approved'
    ? ok('the draft reads approved on Home and in the thread')
    : bad('status');
  const twice = await proposals.approveProposal(db, draft.id, { now: at(13) });
  twice.status === 'gone' && listActiveReminders(db).length === 1
    ? ok('a second Approve writes nothing more')
    : bad('double approve', JSON.stringify(twice));

  // Parity: the same gate refuses without a yes, writing nothing — the chat
  // path's own rule, now one function.
  const { db: db2 } = freshDb();
  const tool = toolByName('set_reminder');
  const declined = await runGatedTool(db2, tool, { title: 'X', time: '20:00' }, { now: NOW }, async () => false);
  declined.declined === true && listActiveReminders(db2).length === 0
    ? ok('runGatedTool with no yes declines and writes nothing (chat and proposals share it)')
    : bad('gate', JSON.stringify(declined));
}

console.log('P6. a stale draft refuses: the row moved since the card was drawn');
{
  const { db } = freshDb();
  const mealId = logMeal(db, { date: TODAY, time: '12:30', name: 'Pasta', kcal: 700 });
  const draft = await draftOne(
    db,
    `PROPOSE edit_record {"domain":"meals","id":"${mealId}","fields":{"name":"Pasta bowl"}} The name says what it was.`
  );
  draft ? ok(`drafted: ${draft.summary}`) : bad('edit draft not drawn');
  updateMealName(db, mealId, 'Soup');
  const result = await proposals.approveProposal(db, draft.id, { now: at(13) });
  result.status === 'refused' && /now reads/.test(result.line) && getMeal(db, mealId).name === 'Soup'
    ? ok('refused, quoting both cards, and the hand edit stands')
    : bad('stale', JSON.stringify({ result, name: getMeal(db, mealId)?.name }));
  const thread = chatRepo.listMessages(db, chatRepo.getOrCreateActiveConversation(db).id);
  const calls = chatRepo.parseToolCalls(thread[thread.length - 1].tool_calls);
  calls[0]?.isError === true && !calls[0].receipt
    ? ok('the thread records the refusal with no receipt')
    : bad('refusal record', JSON.stringify(calls));

  // A draft whose row is gone cannot be redrawn at all.
  const { db: db2 } = freshDb();
  const id = createReminder(db2, { title: 'Stretch', time: '18:00' }, NOW);
  const dismiss = await draftOne(
    db2,
    `PROPOSE edit_record {"domain":"reminders","id":"${id}","fields":{"status":"dismissed"}} Not done in two weeks.`
  );
  db2.run(`UPDATE reminders SET status = 'done' WHERE id = ?`, [id]);
  const gone = await proposals.approveProposal(db2, dismiss.id, { now: at(13) });
  gone.status === 'refused' && /No active reminder/.test(gone.line)
    ? ok('a row closed by hand meanwhile refuses in the tool’s own words')
    : bad('gone row', JSON.stringify(gone));
}

console.log('P7. Decline is recorded as a chat decline, and the next turn is told');
{
  const { db } = freshDb();
  const draft = await draftOne(db, reminderLine('Lights out'));
  const result = proposals.declineProposal(db, draft.id, at(13));
  result.status === 'declined' && listActiveReminders(db).length === 0
    ? ok('declined, nothing written')
    : bad('decline', JSON.stringify(result));
  const declines = chatRepo.recentDeclines(db, { now: at(13) });
  declines.some((line) => line.startsWith('set_reminder "Lights out"'))
    ? ok('recentDeclines sees it, as it sees a refused chat card')
    : bad('recentDeclines', JSON.stringify(declines));
  buildTurnContext(db, at(13)).includes('Recently declined by the user')
    ? ok('…so the next turn’s state block (the chat Coach’s and the pass’s) carries it')
    : bad('turn context');
  const thread = chatRepo.listMessages(db, chatRepo.getOrCreateActiveConversation(db).id);
  chatRepo.declinedWriteLines(chatRepo.parseToolCalls(thread[thread.length - 1].tool_calls), (n) => n)[0] ===
  draft.summary
    ? ok('the thread prints "Declined, not saved" with the card’s line')
    : bad('declined line');
  (await proposals.approveProposal(db, draft.id, { now: at(13) })).status === 'gone'
    ? ok('a declined draft cannot then be approved')
    : bad('approve after decline');
}

console.log('P8. expiry: the end of the day, or the draft’s own until');
{
  const { db } = freshDb();
  const draft = await draftOne(db, reminderLine('Lights out'));
  const late = await proposals.approveProposal(db, draft.id, { now: TOMORROW_NOON });
  late.status === 'expired' && listActiveReminders(db).length === 0
    ? ok('approved the next day: expired, nothing written')
    : bad('day expiry', JSON.stringify(late));
  proposals.listProposals(db, TOMORROW_NOON)[0].status === 'expired'
    ? ok('and it reads expired from then on')
    : bad('expired status');

  const { db: db2 } = freshDb();
  const until = await draftOne(db2, `PROPOSE until 13:00 log_note {"text":"Skipped the walk"} Before lunch ends.`);
  until?.until === '13:00' ? ok('a draft carries its until') : bad('until not stored');
  (await proposals.approveProposal(db2, until.id, { now: at(13, 30) })).status === 'expired'
    ? ok('approved after its until: expired')
    : bad('until expiry');
  const past = await runCoachPass(db2, {
    trigger: { kind: 'daily' },
    now: NOW,
    fetchImpl: wire('PROPOSE until 09:00 log_note {"text":"x"} Too late.'),
  });
  past.proposals.drafted.length === 0 && past.proposals.refused[0]?.reason === '09:00 has already gone by'
    ? ok('an until already gone by is refused when drafted')
    : bad('past until', JSON.stringify(past.proposals));

  // A week of answered drafts is kept, nothing older.
  const { db: db3 } = freshDb();
  await draftOne(db3, reminderLine('Old'));
  const later = new Date(NOW.getTime() + 8 * 86_400_000);
  proposals.recordProposals(db3, [], [], later);
  proposals.listProposals(db3, later).length === 0
    ? ok('drafts older than a week are dropped: nothing piles up')
    : bad('pile up');
}

console.log('P9. a draft that cites a finding refuses once the finding is resolved');
{
  const { db } = freshDb();
  proposals.setFindingLookup(null); // the unwired state, to prove it fails closed
  const line = 'PROPOSE finding f-1 log_note {"text":"Fill the gap"} Three days unlogged.';
  const closed = await runCoachPass(db, { trigger: { kind: 'daily' }, now: NOW, fetchImpl: wire(line) });
  closed.proposals.drafted.length === 0 &&
  closed.proposals.refused[0]?.reason === 'finding f-1 cannot be checked in this build'
    ? ok('with no finding lookup wired, a citing draft FAILS CLOSED')
    : bad('fail closed', JSON.stringify(closed.proposals));
  let open = true;
  proposals.setFindingLookup((_db, id) => id === 'f-1' && open);
  passDirective({ kind: 'daily' }, TODAY, null, {
    brief: false,
    proposals: proposals.proposalDirectiveFor(db, NOW),
  }).includes('finding <id>')
    ? ok('once wired, the directive offers the qualifier')
    : bad('qualifier not offered');
  const draft = await draftOne(db, line);
  draft?.finding === 'f-1' ? ok('an open finding: drafted, citing it') : bad('not drafted');
  open = false;
  const result = await proposals.approveProposal(db, draft.id, { now: at(13) });
  result.status === 'refused' && /finding f-1 is resolved/.test(result.line)
    ? ok('resolved before the tap: refused, nothing written')
    : bad('resolved finding', JSON.stringify(result));
  // Back to the real wiring the app runs with.
  proposals.setFindingLookup((d, id, now) => findingById(d, id, now) !== null);
}

console.log('P10. the brief: first look only, every number traced to what the pass read');
{
  const { db } = freshDb();
  createReminder(db, { title: 'Creatine', time: '08:00' }, NOW);
  const context = buildTurnContext(db, NOW);
  const cited = (context.match(/\b(\d{2,4})\b/g) ?? []).find((n) => Number(n) > 12 && !(Number(n) >= 1900 && Number(n) <= 2100));
  const traced = cited ? `Your state block shows ${cited} today.` : null;
  const invented = 'Your ApoB is 78 mg/dL, so the creatine stays.';
  coachPassStore.reset();
  const requests = [];
  await coachPassStore.maybeRun(db, {
    unlocked: true,
    now: NOW,
    fetchImpl: wire(
      ['SKIP', `BRIEF ${traced ?? 'Creatine at eight.'}`, `BRIEF ${invented}`, 'BRIEF Creatine at eight, as always.'].join('\n'),
      requests
    ),
  });
  directiveOf(requests[0]).includes('3 to 5 lines, each beginning BRIEF')
    ? ok('the first look of the day is asked for the brief')
    : bad('brief not asked');
  const brief = proposals.getBrief(db, NOW);
  brief &&
  !brief.includes(invented) &&
  brief.includes('Creatine at eight, as always.') &&
  (traced === null || brief.includes(traced))
    ? ok(`kept the lines whose numbers trace (${traced ? `"${cited}" from the state block` : 'no figure'}), dropped the invented ApoB`)
    : bad('brief vet', JSON.stringify(brief));
  const thread = chatRepo.listMessages(db, chatRepo.getOrCreateActiveConversation(db).id);
  !thread.some((m) => m.content.includes('BRIEF') || m.content.includes('ApoB'))
    ? ok('no BRIEF line reaches the thread')
    : bad('brief in thread');
  proposals.getBrief(db, TOMORROW_NOON) === null
    ? ok('tomorrow there is no brief until tomorrow’s first look writes one')
    : bad('stale brief');

  // A later pass the same day is not asked, and lines it writes anyway are ignored.
  createReminder(db, { title: 'x', time: '09:00' }, NOW);
  db.run(`INSERT INTO wearable_data (id, date, metric_type, value, source_device) VALUES ('w1', ?, 'hrv', 30, 'manual')`, [TODAY]);
  const later = await runCoachPass(db, {
    trigger: { kind: 'signal', detail: 'x' },
    now: at(14),
    fetchImpl: wire('SKIP\nBRIEF Something else.'),
  });
  later.brief === null && later.status === 'silent'
    ? ok('a pass not asked for a brief strips the lines and keeps none')
    : bad('unasked brief', JSON.stringify(later));
  const vet = proposals.vetBrief(['HRV 48 ms.', 'HRV 52 ms.'], ['{"hrv":47.6}']);
  vet.kept.length === 1 && vet.dropped[0] === 'HRV 52 ms.'
    ? ok('vetBrief uses the provenance harness: 47.6 may be written 48, nothing may be written 52')
    : bad('vetBrief', JSON.stringify(vet));
}

console.log('P11. the triggers: a lab import, a screening due, an appointment within a week');
{
  const { db } = freshDb();
  markPassRan(db, NOW);
  duePass(db, NOW) === null ? ok('a quiet day after the daily pass stays quiet') : bad('spurious');

  const soon = new Date(NOW.getTime() + 3 * 86_400_000).toISOString();
  const far = new Date(NOW.getTime() + 20 * 86_400_000).toISOString();
  addAppointment(db, { title: 'Dermatology', scheduledAt: soon });
  addAppointment(db, { title: 'Dentist', scheduledAt: far });
  const due = duePass(db, NOW);
  due?.kind === 'signal' && due.detail.includes('appointment "Dermatology"') && !due.detail.includes('Dentist')
    ? ok('an appointment within 7 days wakes a pass, named in words; one 20 days out does not')
    : bad('appointment trigger', JSON.stringify(due));
  markPassRan(db, NOW);
  duePass(db, NOW) === null ? ok('…once') : bad('re-fired');

  addScreening(db, { name: 'Colonoscopy', category: 'imaging', nextDue: shiftISODate(TODAY, 10) });
  duePass(db, NOW)?.detail.includes('screening "Colonoscopy" is coming due')
    ? ok('a screening coming due wakes one')
    : bad('screening trigger');
  markPassRan(db, NOW);

  db.run(`INSERT INTO lab_reports (id, collected_at) VALUES ('lab-1', ?)`, [shiftISODate(TODAY, -2)]);
  duePass(db, NOW)?.detail.includes('a lab report was imported')
    ? ok('a lab import wakes one')
    : bad('lab trigger');
  markPassRan(db, NOW);

  // Quiet hours: a new appointment found at 23:00 waits for morning.
  saveNudgeSettings(db, { ...getNudgeSettings(db), quietStart: '21:30', quietEnd: '07:00' }, NOW);
  const night = at(23);
  const nightDb = freshDb().db;
  saveNudgeSettings(nightDb, { ...getNudgeSettings(nightDb), enabled: false, quietStart: '21:30', quietEnd: '07:00' }, NOW);
  markPassRan(nightDb, night);
  addAppointment(nightDb, { title: 'Cardiology', scheduledAt: new Date(night.getTime() + 2 * 86_400_000).toISOString() });
  duePass(nightDb, night) === null &&
  passSignals(nightDb, night).some((s) => s.id.startsWith('appointment:'))
    ? ok('inside quiet hours the new trigger does not wake a pass, though it is current')
    : bad('quiet hours', JSON.stringify(duePass(nightDb, night)));
  const morning = new Date(night.getTime() + 9 * 3_600_000); // 08:00 next day
  duePass(nightDb, morning)?.kind === 'daily'
    ? ok('…and the next morning’s daily pass is the look that sees it')
    : bad('morning');

  PASS_SIGNAL_SOURCES.map((s) => s.name).join(',') ===
  'record finding,watch insight,timezone landing,lab import,screening due,appointment ahead'
    ? ok('the trigger list is a list: the findings source joins as one entry')
    : bad('sources');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
