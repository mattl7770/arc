/**
 * Headless test of SAVING AT ONCE (owner's decision, 2026-10-21, against the
 * recommendation; docs/decisions.md "Simple logs save at once, with Undo"):
 * a simple log the user states in chat saves without a card, with an Undo,
 * through the SAME gate a card's approval runs (src/lib/ai/write-gate.ts).
 *
 *   A1  each qualifying tool saves with no card, a receipt and an Undo
 *   A2  everything else still shows a card: edit, delete, protocol, reminder,
 *       backdated, bulk, a figure or a word the model supplied, a time, a
 *       turn past the cap, a repeat
 *   A3  Undo removes exactly that record, once, through delete_record
 *   A4  Undo refuses after the record changed, or once it is gone
 *   A5  the setting OFF puts every write back behind a card
 *   A6  the unattended pass's proposals are never saved at once
 *   A7  phantom-write detection still holds
 *   A8  the registry: exactly five tools qualify, none of it rides the wire
 *   A9  a unit, a metric or a capture type he did not type keeps its card
 *   A10 a retry: what the superseded attempt saved is told, and not saved twice
 *
 * The model is a scripted wire (the SSE shape model-client parses). No
 * network, no API key (a placeholder string only), no model call.
 * Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

import { apiKeyStore } from '../src/lib/ai/api-key-store.ts';
import { shiftISODate, todayISODate } from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { getOrCreateUser } from '../src/lib/db/repositories/user.ts';
import { getCapture } from '../src/lib/db/repositories/logs.ts';
import { getMeal } from '../src/lib/db/repositories/nutrition.ts';
import { createProtocolWithVersion } from '../src/lib/db/repositories/protocols.ts';
import {
  getSaveLogsAtOnce,
  setSaveLogsAtOnce,
} from '../src/lib/db/repositories/coach-autosave-setting.ts';
import * as chatRepo from '../src/lib/db/repositories/ai-chat.ts';
import { claimsCompletedWrite } from '../src/lib/ai/write-claim.ts';
import { COACH_TOOLS, toolByName, toWireTools } from '../src/lib/ai/tools/index.ts';
import { REMOVABLE_DOMAIN_KEYS } from '../src/lib/ai/domains/index.ts';
import { parsePassLines } from '../src/lib/ai/proposal-lines.ts';
import * as proposals from '../src/lib/ai/proposals.ts';
import {
  AUTO_SAVE_TURN_CAP,
  SAVED_AT_ONCE_FIELD,
  autoSaveTurn,
  clearUndoOffers,
  runGatedTool,
  undoKeyFor,
  undoOfferFor,
  undoSavedAtOnce,
  wasSavedAtOnce,
} from '../src/lib/ai/write-gate.ts';

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

// Noon today, so "today" is unambiguous whatever the day boundary.
const NOW = new Date();
NOW.setHours(12, 0, 0, 0);
const TODAY = todayISODate(NOW);
const YESTERDAY = shiftISODate(TODAY, -1);

// --- The REAL call site, coach-service.ts, over a scripted wire --------------
// `expo/fetch` and `@/lib/db/client` are the only stubs (as in
// db/coach-tools.test.mjs §16); the loop, the gate, the registry, the
// repositories and the SQLite writes are the real ones.
const LOADER_HOOK = `
const stub = (source) => ({
  url: 'data:text/javascript,' + encodeURIComponent(source),
  shortCircuit: true,
});
const STUBS = new Map([
  ['expo/fetch', stub('export const fetch = (...args) => globalThis.__ARC_TEST_FETCH__(...args);')],
  ['@/lib/db/client', stub('export const getDb = () => globalThis.__ARC_TEST_DB__;')],
]);
export async function resolve(specifier, context, next) {
  const hit = STUBS.get(specifier);
  if (hit) return hit;
  try {
    return await next(specifier, context);
  } catch (error) {
    if (specifier.startsWith('.')) return next(specifier + '/index.ts', context);
    throw error;
  }
}
`;
register('data:text/javascript,' + encodeURIComponent(LOADER_HOOK), import.meta.url);
const { streamCoachReply } = await import('../src/lib/ai/coach-service.ts');

const sse = (events) =>
  events.map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join('');

const toolUseReply = (name, input, id) =>
  sse([
    { type: 'message_start', message: {} },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id, name, input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ]);

const textReply = (text) =>
  sse([
    { type: 'message_start', message: {} },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]);

const responseOf = (body) => {
  const bytes = new TextEncoder().encode(body);
  let sent = false;
  return {
    ok: true,
    status: 200,
    text: async () => body,
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })),
      }),
    },
  };
};

let seq = 0;
/**
 * One chat turn: the user says `userText`, the model calls each of `calls` in
 * turn ([name, input]), then answers `answer`. Every card shown is recorded;
 * `approve` is the user's answer to each.
 */
async function turn(
  db,
  userText,
  calls,
  { approve = true, answer = 'Done.', gate = true, superseded } = {}
) {
  globalThis.__ARC_TEST_DB__ = db;
  const replies = [
    ...calls.map(([name, input]) => toolUseReply(name, input, `toolu_${++seq}`)),
    textReply(answer),
  ];
  const requests = [];
  globalThis.__ARC_TEST_FETCH__ = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return responseOf(replies.shift());
  };
  const cards = [];
  const result = await streamCoachReply(
    [{ id: `u${seq}`, role: 'user', content: userText, createdAt: 0 }],
    {
      onToken: () => {},
      now: () => NOW,
      ...(superseded ? { superseded } : {}),
      ...(gate
        ? {
            confirmWrite: async (request) => {
              cards.push(request.summary);
              return approve;
            },
          }
        : {}),
    }
  );
  return { result, cards, calls: result.toolCalls, requests };
}

const resultOf = (call) => JSON.parse(call.result);
const isWrite = (name) => toolByName(name)?.readOnly === false;

await apiKeyStore.setKey('test-key'); // a placeholder ⇒ the REAL loop, over the scripted wire

// =============================================================================
console.log('A1. each qualifying tool saves with no card, a receipt and an Undo');
const { db, raw } = freshDb();
clearUndoOffers();

getSaveLogsAtOnce(db)
  ? ok('the switch reads ON on a fresh install (the owner’s default)')
  : bad('default off');

const QUALIFYING = [
  ['weight', 'weight was 178.4 this morning', 'log_metric', { metric: 'weight', value: 178.4 }],
  ['water', 'drank 500 ml of water', 'log_metric', { metric: 'water', value: 500, unit: 'ml' }],
  ['supplement', 'took 5 g creatine', 'log_capture', { type: 'supplement', title: 'Creatine · 5 g' }],
  ['symptom', 'headache, about 6/10', 'log_symptom', { name: 'Headache', severity: 6 }],
  ['note', 'slept badly, 3am wake', 'log_note', { text: 'Slept badly, 3am wake' }],
  ['meal in words', 'lunch was salmon, rice and broccoli', 'log_meal', { name: 'Salmon, rice, broccoli' }],
  [
    'meal with his own figures',
    'chicken bowl, 640 kcal and 52 g protein',
    'log_meal',
    { name: 'Chicken bowl', kcal: 640, protein_g: 52 },
  ],
  ['dated today', 'weight 177', 'log_metric', { metric: 'weight', value: 177, date: TODAY }],
];
const saved = {};
for (const [label, said, name, input] of QUALIFYING) {
  const { cards, calls } = await turn(db, said, [[name, input]]);
  const call = calls[0];
  const result = call ? resultOf(call) : {};
  const key = call ? undoKeyFor(call) : null;
  const offer = key ? undoOfferFor(key) : undefined;
  cards.length === 0 &&
  typeof call?.receipt === 'string' &&
  call.receipt.length > 0 &&
  wasSavedAtOnce(call) &&
  typeof result[SAVED_AT_ONCE_FIELD] === 'string' &&
  typeof result.id === 'string' &&
  offer?.state === 'open' &&
  offer.receipt === call.receipt
    ? ok(`${label}: no card, receipt "${call.receipt}", Undo open`)
    : bad(`${label} did not save at once`, JSON.stringify({ cards, call }));
  saved[label] = { call, key, id: result.id };
}
getCapture(db, saved.weight.id)?.title?.includes('178.4')
  ? ok('the weight is on the Log tab, as the keypad would file it')
  : bad('weight row', JSON.stringify(getCapture(db, saved.weight.id)));
getMeal(db, saved['meal in words'].id)?.name === 'Salmon, rice, broccoli' &&
getMeal(db, saved['meal in words'].id)?.kcal === null
  ? ok('the meal in words is on the Eat tab, with no figures it was never given')
  : bad('meal row');
resultOf(saved.weight.call)[SAVED_AT_ONCE_FIELD].includes('Undo')
  ? ok('the model is told no card was shown and that he has an Undo (a tool RESULT, not a schema)')
  : bad('result note');

// =============================================================================
console.log('A2. everything else still shows a card');
const protocolId = createProtocolWithVersion(
  db,
  { name: 'Evening Stack', type: 'supplement_stack' },
  { items: [{ title: 'Magnesium Glycinate', scheduled_time: '21:00', dose: '200 mg', notes: null }] },
  'seed'
);
const slug = raw.prepare('SELECT slug FROM protocols WHERE id = ?').get(protocolId).slug;

const CARDED = [
  [
    'an edit',
    'make the note say slept badly, 3am wake, back up at 5',
    'edit_record',
    { domain: 'captures', id: saved.note.id, fields: { text: 'Slept badly, 3am wake, back up at 5' } },
  ],
  [
    'a delete',
    'delete that salmon lunch',
    'delete_record',
    { domain: 'meals', id: saved['meal in words'].id },
  ],
  [
    'a protocol change',
    'add zinc 15 mg to my evening stack',
    'update_protocol',
    {
      protocol_slug: slug,
      phases: [
        {
          items: [
            { title: 'Magnesium Glycinate', scheduled_time: '21:00', dose: '200 mg' },
            { title: 'Zinc', scheduled_time: '21:00', dose: '15 mg' },
          ],
        },
      ],
      change_notes: 'added zinc',
    },
  ],
  [
    'a reminder',
    'remind me to take creatine at 21:00',
    'set_reminder',
    { title: 'Take creatine', time: '21:00', repeat: 'once' },
  ],
  [
    'a backdate',
    'my weight yesterday was 178',
    'log_metric',
    { metric: 'weight', value: 178, date: YESTERDAY },
  ],
  [
    'a bulk write',
    'add milk and eggs to the grocery list',
    'add_grocery_items',
    { items: [{ name: 'Milk' }, { name: 'Eggs' }] },
  ],
  ['a model-estimated macro', 'had a chicken bowl for lunch', 'log_meal', { name: 'Chicken bowl', kcal: 650 }],
  ['a dose read off his protocol', 'took my creatine', 'log_capture', { type: 'supplement', title: 'Creatine · 5 g' }],
  ['a word he never said', 'took my evening stack', 'log_capture', { type: 'supplement', title: 'Magnesium' }],
  ['a glass turned into ml', 'had a glass of water', 'log_metric', { metric: 'water', value: 250, unit: 'ml' }],
  ['a unit he never typed', 'weight 80 today', 'log_metric', { metric: 'weight', value: 80, unit: 'kg' }],
  ['a converted figure', 'weighed 80 kg', 'log_metric', { metric: 'weight', value: 176.4 }],
  ['a paraphrased note', 'ugh, terrible night, woke at 3', 'log_note', { text: 'Poor sleep, woke at 3' }],
  ['a time', 'headache at 2pm, 6/10', 'log_symptom', { name: 'Headache', severity: 6, time: '14:00' }],
];
for (const [label, said, name, input] of CARDED) {
  const { cards, calls } = await turn(db, said, [[name, input]]);
  const call = calls[0];
  cards.length === 1 && call && !wasSavedAtOnce(call) && !String(call.result).includes(SAVED_AT_ONCE_FIELD)
    ? ok(`${label} (${name}): a card — "${cards[0]}"`)
    : bad(`${label} skipped its card`, JSON.stringify({ cards, call }));
}

// A batch: four things in one turn — three save at once, the fourth waits.
{
  const four = ['Creatine', 'Magnesium', 'Zinc', 'Fish oil'].map((title) => [
    'log_capture',
    { type: 'supplement', title },
  ]);
  const { cards, calls } = await turn(db, 'took creatine, magnesium, zinc and fish oil', four);
  const atOnce = calls.filter(wasSavedAtOnce);
  atOnce.length === AUTO_SAVE_TURN_CAP && cards.length === 1 && cards[0].includes('Fish oil')
    ? ok(`past ${AUTO_SAVE_TURN_CAP} in one turn is a batch: the fourth gets a card`)
    : bad('turn cap', JSON.stringify({ atOnce: atOnce.length, cards }));
}
// A repeat: the same call twice in one turn saves once.
{
  const call = ['log_capture', { type: 'supplement', title: 'Creatine' }];
  const { cards, calls } = await turn(db, 'took creatine', [call, call]);
  calls.filter(wasSavedAtOnce).length === 1 && cards.length === 1
    ? ok('the same log twice in one turn: once at once, the repeat on a card')
    : bad('repeat', JSON.stringify({ cards }));
}
// No gate at all: nothing saves, at once or otherwise.
{
  const before = raw.prepare('SELECT COUNT(*) AS n FROM log_entries').get().n;
  const { calls } = await turn(db, 'took creatine', [['log_capture', { type: 'supplement', title: 'Creatine' }]], {
    gate: false,
  });
  calls[0]?.declined === true && raw.prepare('SELECT COUNT(*) AS n FROM log_entries').get().n === before
    ? ok('a turn with no confirmation gate writes nothing, not even a simple log')
    : bad('no gate', JSON.stringify(calls));
}

// =============================================================================
console.log('A3. Undo removes exactly that record, through delete_record, once');
{
  const { id, key } = saved.supplement;
  const otherBefore = getCapture(db, saved.symptom.id);
  const undone = await undoSavedAtOnce(db, key, NOW);
  undone?.state === 'undone' && getCapture(db, id) === undefined
    ? ok('Undo: the creatine entry is gone from the record')
    : bad('undo', JSON.stringify({ undone, row: getCapture(db, id) }));
  JSON.stringify(getCapture(db, saved.symptom.id)) === JSON.stringify(otherBefore)
    ? ok('  → and only it: the symptom saved beside it is untouched')
    : bad('undo touched another row');
  const again = await undoSavedAtOnce(db, key, NOW);
  again?.state === 'undone'
    ? ok('  → a second tap does nothing more')
    : bad('second undo', JSON.stringify(again));

  const weight = await undoSavedAtOnce(db, saved.weight.key, NOW);
  const [rowId] = saved.weight.id.split(':');
  weight?.state === 'undone' &&
  raw.prepare('SELECT weight_kg FROM body_metrics WHERE id = ?').get(rowId)?.weight_kg == null
    ? ok('Undo of a weight takes the reading out of body_metrics (the Log tab’s own removal)')
    : bad('weight undo', JSON.stringify(weight));

  // Concurrency: two taps at once remove it once and report undone.
  const [a, b] = await Promise.all([
    undoSavedAtOnce(db, saved.water.key, NOW),
    undoSavedAtOnce(db, saved.water.key, NOW),
  ]);
  undoOfferFor(saved.water.key)?.state === 'undone' && getCapture(db, saved.water.id) === undefined
    ? ok('two taps racing: removed once, and it reads undone')
    : bad('race', JSON.stringify({ a, b }));
}

// =============================================================================
console.log('A4. Undo refuses after the record changed, or once it is gone');
{
  // The note was corrected through edit_record (approved card) in A2.
  const before = getCapture(db, saved.note.id);
  const refused = await undoSavedAtOnce(db, saved.note.key, NOW);
  refused?.state === 'refused' &&
  /changed after it was saved/.test(refused.note ?? '') &&
  JSON.stringify(getCapture(db, saved.note.id)) === JSON.stringify(before)
    ? ok('a note edited since it saved: Undo refuses, and the edited note stays')
    : bad('changed undo', JSON.stringify(refused));

  // The salmon lunch was deleted through delete_record (approved card) in A2.
  const gone = await undoSavedAtOnce(db, saved['meal in words'].key, NOW);
  gone?.state === 'refused' && /no longer in your record/.test(gone.note ?? '')
    ? ok('a meal already removed: Undo refuses with nothing to undo')
    : bad('gone undo', JSON.stringify(gone));

  // A change made by hand on the Log tab (the repository, not the Coach).
  const { editLogCapture } = await import('../src/lib/health/publish.ts');
  editLogCapture(db, saved.symptom.id, { severity: 3 });
  const symptom = await undoSavedAtOnce(db, saved.symptom.key, NOW);
  symptom?.state === 'refused' && getCapture(db, saved.symptom.id) !== undefined
    ? ok('a symptom re-rated by hand: Undo refuses, the row stays')
    : bad('hand edit undo', JSON.stringify(symptom));

  (await undoSavedAtOnce(db, 'captures no-such-id', NOW)) === undefined
    ? ok('a key this session never minted offers nothing')
    : bad('unknown key');
}

// =============================================================================
console.log('A5. the setting OFF puts every write back behind a card');
{
  setSaveLogsAtOnce(db, false);
  getSaveLogsAtOnce(db) === false ? ok('the switch stores OFF') : bad('off not stored');
  const before = raw.prepare('SELECT COUNT(*) AS n FROM log_entries').get().n;
  for (const [label, said, name, input] of QUALIFYING.slice(2, 5)) {
    const { cards, calls } = await turn(db, said, [[name, input]], { approve: false });
    cards.length === 1 && calls[0]?.declined === true && !wasSavedAtOnce(calls[0])
      ? ok(`OFF: the ${label} shows a card, and a decline writes nothing`)
      : bad(`OFF ${label}`, JSON.stringify({ cards, calls }));
  }
  raw.prepare('SELECT COUNT(*) AS n FROM log_entries').get().n === before
    ? ok('  → no row was added while it was off and every card was declined')
    : bad('rows written while off');
  setSaveLogsAtOnce(db, true);
  const prefs = JSON.parse(getOrCreateUser(db).preferences);
  getSaveLogsAtOnce(db) && prefs.coachSaveAtOnce?.simpleLogs === true
    ? ok('back ON, in the preferences blob (no migration)')
    : bad('back on', JSON.stringify(prefs));
}

// =============================================================================
console.log('A6. the unattended pass’s proposals are never saved at once');
{
  const { db: pdb, raw: praw } = freshDb();
  const parsed = parsePassLines('PROPOSE log_note {"text":"Slept badly"} He said so at 07:00.');
  const { drafted } = proposals.draftProposals(pdb, parsed.proposals, parsed.malformed, NOW);
  const [kept] = proposals.recordProposals(pdb, drafted, [], NOW);
  kept?.status === 'pending' &&
  praw.prepare("SELECT COUNT(*) AS n FROM log_entries WHERE type = 'note'").get().n === 0
    ? ok('a drafted simple log waits, pending, with nothing written')
    : bad('draft wrote', JSON.stringify(kept));
  const approved = await proposals.approveProposal(pdb, kept.id, { now: NOW });
  const thread = chatRepo.listMessages(pdb, chatRepo.getOrCreateActiveConversation(pdb).id);
  const recorded = chatRepo.parseToolCalls(thread[thread.length - 1].tool_calls)[0];
  approved.status === 'approved' && recorded && !wasSavedAtOnce(recorded) && undoKeyFor(recorded) === null
    ? ok('  → only his tap writes it, as an approval, never as a save-at-once')
    : bad('proposal approval', JSON.stringify({ approved, recorded }));

  // The gate itself: no AutoSaveState, no save at once — whatever the input.
  const tool = toolByName('log_note');
  const declined = await runGatedTool(pdb, tool, { text: 'Slept badly' }, { now: NOW });
  const viaState = await runGatedTool(
    pdb,
    tool,
    { text: 'Slept badly' },
    { now: NOW },
    undefined,
    autoSaveTurn('slept badly')
  );
  declined.declined === true && viaState.receipt && viaState.content.includes(SAVED_AT_ONCE_FIELD)
    ? ok('runGatedTool saves at once only for a caller that passes the turn (the chat)')
    : bad('gate', JSON.stringify({ declined, viaState }));
}

// =============================================================================
console.log('A7. phantom-write detection still holds');
{
  const claim = 'I’ve logged your weight.';
  const { calls } = await turn(db, 'weight 178', [], { answer: claim });
  const writes = chatRepo.landedWriteReceipts(calls, isWrite, (n) => n);
  calls.length === 0 && writes.length === 0 && claimsCompletedWrite(claim)
    ? ok('a claim with no tool call is still a phantom write')
    : bad('phantom', JSON.stringify(calls));

  const real = await turn(db, 'weight 176.2', [['log_metric', { metric: 'weight', value: 176.2 }]], {
    answer: claim,
  });
  chatRepo.landedWriteReceipts(real.calls, isWrite, (n) => n).length === 1
    ? ok('a write saved at once has a receipt, so its turn is never captioned "Nothing saved"')
    : bad('saved-at-once receipt', JSON.stringify(real.calls));

  // A simple log that fails at its card (out of range) mints no receipt.
  const broken = await turn(db, 'weight 9000', [['log_metric', { metric: 'weight', value: 9000 }]], {
    answer: claim,
  });
  broken.cards.length === 0 &&
  broken.calls[0]?.isError === true &&
  chatRepo.landedWriteReceipts(broken.calls, isWrite, (n) => n).length === 0
    ? ok('a log that errors saves nothing and mints no receipt, so the phantom caption can still fire')
    : bad('errored log', JSON.stringify(broken.calls));
}

// =============================================================================
console.log('A8. the registry: exactly five tools may save at once, and none of it rides the wire');
{
  const declared = COACH_TOOLS.filter((t) => t.autoApprove).map((t) => t.name).sort();
  JSON.stringify(declared) ===
  JSON.stringify(['log_capture', 'log_meal', 'log_metric', 'log_note', 'log_symptom'])
    ? ok(`only ${declared.join(', ')} declare autoApprove`)
    : bad('declared set', JSON.stringify(declared));
  COACH_TOOLS.filter((t) => t.autoApprove).every(
    (t) => !t.readOnly && t.undoDomain && REMOVABLE_DOMAIN_KEYS.includes(t.undoDomain)
  )
    ? ok('each has an Undo through a delete_record domain')
    : bad('undo domains');
  const wire = JSON.stringify(toWireTools(COACH_TOOLS));
  !wire.includes('autoApprove') && !wire.includes('undoDomain') && !wire.includes(SAVED_AT_ONCE_FIELD)
    ? ok('the wire schemas carry none of it (the §6 ceilings cannot move)')
    : bad('wire leak');
}

// =============================================================================
console.log('A9. a unit, a metric or a capture type he did not type keeps its card');
{
  const { db: udb } = freshDb();
  clearUndoOffers();
  // The reviewer's five (2026-10-21): each figure is his, so the figure rule
  // alone said yes — and saved something he never said.
  const MISREAD = [
    ['his kg saved in pounds', 'weight 80kg', 'log_metric', { metric: 'weight', value: 80 }],
    ['his ml saved in ounces', 'drank 500 ml water', 'log_metric', { metric: 'water', value: 500 }],
    ['his g titled mg', 'creatine 5 g', 'log_capture', { type: 'supplement', title: 'Creatine · 5 mg' }],
    ['resting HR saved as HRV', 'resting hr 52', 'log_metric', { metric: 'hrv', value: 52 }],
    ['a type he never named', 'creatine 5 g', 'log_capture', { type: 'medication', title: 'Creatine · 5 g' }],
  ];
  for (const [label, said, name, input] of MISREAD) {
    const { cards, calls } = await turn(udb, said, [[name, input]], { approve: false });
    cards.length === 1 && calls[0]?.declined === true && !wasSavedAtOnce(calls[0])
      ? ok(`${label}: a card — "${cards[0]}"`)
      : bad(`${label} saved at once`, JSON.stringify({ cards, call: calls[0] }));
  }
  // …and his own figures, units, metric and type still save at once.
  const HIS = [
    ['his kg, in kg', 'weight 80kg', 'log_metric', { metric: 'weight', value: 80, unit: 'kg' }],
    ['his resting HR', 'resting hr 52', 'log_metric', { metric: 'rhr', value: 52 }],
    ['his g, in g', 'creatine 5 g', 'log_capture', { type: 'supplement', title: 'Creatine · 5 g' }],
    ['grams spelled out', 'took 5 grams of creatine', 'log_capture', { type: 'supplement', title: 'Creatine · 5 g' }],
    ['a medication he named', 'took my meds, metformin 500 mg', 'log_capture', { type: 'medication', title: 'Metformin · 500 mg' }],
  ];
  for (const [label, said, name, input] of HIS) {
    const { cards, calls } = await turn(udb, said, [[name, input]]);
    cards.length === 0 && calls[0] && wasSavedAtOnce(calls[0])
      ? ok(`${label}: saved at once — "${calls[0].receipt}"`)
      : bad(`${label} lost its save-at-once`, JSON.stringify({ cards, call: calls[0] }));
  }
  // A supplement is not inferred over a type he DID name.
  const { cards } = await turn(udb, 'took my meds, 500 mg', [
    ['log_capture', { type: 'supplement', title: 'Meds · 500 mg' }],
  ], { approve: false });
  cards.length === 1
    ? ok('he said meds, the call says supplement: a card')
    : bad('supplement over meds', JSON.stringify(cards));
}

// =============================================================================
console.log('A10. a retry: what the superseded attempt saved is told, and not saved twice');
{
  const { db: rdb, raw: rraw } = freshDb();
  clearUndoOffers();
  const said = 'took 5 g creatine';
  const log = ['log_capture', { type: 'supplement', title: 'Creatine · 5 g' }];
  const count = () =>
    rraw.prepare("SELECT COUNT(*) AS n FROM log_entries WHERE title LIKE 'Creatine%'").get().n;
  // The first attempt saved at once, then (say) the stream died before the reply.
  const first = await turn(rdb, said, [log]);
  const superseded = first.calls;
  first.cards.length === 0 && wasSavedAtOnce(superseded[0]) && count() === 1
    ? ok('the failed attempt saved the creatine at once')
    : bad('first attempt', JSON.stringify(first.calls));

  // Retry re-answers the same message; the model logs it again.
  const retry = await turn(rdb, said, [log], { superseded, approve: false });
  retry.cards.length === 1 && retry.calls[0]?.declined === true && count() === 1
    ? ok('the retry’s repeat goes to a card, and a decline leaves one row, not two')
    : bad('retry re-saved', JSON.stringify({ cards: retry.cards, call: retry.calls[0], rows: count() }));
  const system = JSON.stringify(retry.requests[0]?.system ?? '');
  system.includes('Retry:') && system.includes(superseded[0].receipt)
    ? ok('the retry’s turn context names what already saved')
    : bad('retry note missing', system.slice(-400));
  // The cached prefix does not move: the first system block and the tools are
  // the plain turn's, byte for byte.
  JSON.stringify(retry.requests[0].system[0]) === JSON.stringify(first.requests[0].system[0]) &&
  JSON.stringify(retry.requests[0].tools) === JSON.stringify(first.requests[0].tools) &&
  !JSON.stringify(first.requests[0].system).includes('Retry:')
    ? ok('the note rides the uncached block only: prompt and schemas unchanged, a plain turn has none')
    : bad('cached prefix moved');

  // Another tool in the retry still saves at once; a tool that only errored
  // or was declined in the superseded attempt does not count as landed.
  const other = await turn(rdb, 'took 5 g creatine, slept badly', [
    ['log_note', { text: 'Slept badly' }],
  ], { superseded: [...superseded, ...retry.calls] });
  other.cards.length === 0 && wasSavedAtOnce(other.calls[0])
    ? ok('a write the superseded attempt never made still saves at once')
    : bad('other tool', JSON.stringify(other.calls));
  const state = autoSaveTurn(said, superseded);
  state.saved === 1 && state.landedTools.has('log_capture') && autoSaveTurn(said, retry.calls).landedTools.size === 0
    ? ok('what saved at once there counts toward the cap; a declined call is not a landed one')
    : bad('seeded state', JSON.stringify({ saved: state.saved, tools: [...state.landedTools] }));
}

await apiKeyStore.clearKey();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
