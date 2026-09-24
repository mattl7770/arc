/**
 * Headless test of the Coach DOMAIN REGISTRY and the generic tools over it
 * (src/lib/ai/domains/*, src/lib/ai/tools/record-tools.ts) against real SQLite
 * via node:sqlite. No network, no key, no op-sqlite. Run: npm run db:test.
 *
 * WHAT THIS FILE IS FOR. The registry is the first place in the Coach layer
 * where behaviour is DATA rather than code — a domain declares its fields, its
 * card, its weight and whether a row may be removed, and three generic tools
 * read those declarations. Everything that used to be guaranteed by a tool
 * being its own function now has to be guaranteed by an assertion, which is
 * what is below:
 *
 *   §0 the registry's own shape, and the enums derived from it
 *   §1 agreement with the coverage manifest
 *   §2 the fold is INVISIBLE on the card — six lines, byte for byte
 *   §3 the parser: unknown fields, non-editable fields, refused creates
 *   §4 the seals — what is not registrable, and the shipped pack
 *   §5 retired names still answer as writes, so no receipt is lost
 *   §6 STALENESS: the row moved while the card was open
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { shiftISODate, todayISODate } from '../src/lib/db/date.ts';
import {
  completeExperiment,
  createExperiment,
  getExperiment,
} from '../src/lib/db/repositories/experiments.ts';
import { createReminder } from '../src/lib/db/repositories/reminders.ts';
import { getMeal, logMeal } from '../src/lib/db/repositories/nutrition.ts';
import { getWorkoutDetail, logWorkout } from '../src/lib/db/repositories/exercise.ts';
import { createProtocolWithVersion } from '../src/lib/db/repositories/protocols.ts';
import { rememberFact } from '../src/lib/db/repositories/coach-memory.ts';
import { saveKnowledgeEntry } from '../src/lib/db/repositories/knowledge.ts';
import { insertKnowledgeChunk } from '../src/lib/db/repositories/rag.ts';
import {
  appendMessage,
  landedWriteReceipts,
  createConversation,
} from '../src/lib/db/repositories/ai-chat.ts';
import { isoDaysAgo } from '../src/lib/ai/series.ts';
import {
  COACH_DOMAIN_REGISTRY,
  EDIT_DOMAIN_KEYS,
  QUERY_DOMAIN_KEYS,
  REMOVABLE_DOMAIN_KEYS,
  domainByKey,
  domainSelfEvident,
  retiredCoverageLines,
} from '../src/lib/ai/domains/index.ts';
import {
  COACH_TOOLS,
  PASS_READ_TOOLS,
  READ_TOOLS,
  RETIRED_WRITE_NAMES,
  UNCOVERED_DOMAINS,
  coverageProblems,
  humanizeToolName,
  isRetiredWriteName,
  toolByName,
} from '../src/lib/ai/tools/index.ts';
import { apiKeyStore } from '../src/lib/ai/api-key-store.ts';

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
/** The message a call throws, or null when it did not throw. */
const throwText = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
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

const NOW = new Date();
const TODAY = todayISODate(NOW);
const editRecord = toolByName('edit_record');
const queryRecords = toolByName('query_records');
/** A FRESH context per call — `edit_record` writes its staleness slot into it. */
const card = (db, domain, id, fields) =>
  editRecord.confirmSummary({ domain, id, fields }, db, { now: NOW });
const meta = (db, domain, id, fields) =>
  editRecord.confirmMeta({ domain, id, fields }, db, { now: NOW });
const edit = (db, domain, id, fields) =>
  JSON.parse(editRecord.execute(db, { domain, id, fields }, { now: NOW }));

console.log('0. registry shape, and the three enums derived from it');
{
  const keys = COACH_DOMAIN_REGISTRY.map((d) => d.key);
  new Set(keys).size === keys.length
    ? ok(`domain keys unique (${keys.length} registered: ${keys.join(', ')})`)
    : bad('duplicate domain keys', keys.join(','));
  COACH_DOMAIN_REGISTRY.every(
    (d) =>
      typeof d.key === 'string' &&
      typeof d.label === 'string' &&
      d.read &&
      typeof d.read.kind === 'string' &&
      d.fields &&
      Object.keys(d.fields).length > 0
  )
    ? ok('every domain declares key, label, read and at least one field')
    : bad('domain shape');
  // `resolve` and `summarize` travel with the ABILITY TO WRITE, not with being
  // a domain — a read-only domain has no id to resolve anything FOR and no
  // card to draw. That is the invariant `edit_record` relies on.
  COACH_DOMAIN_REGISTRY.filter((d) => d.edit || d.create || d.remove).every(
    (d) => typeof d.resolve === 'function' && typeof d.summarize === 'function'
  )
    ? ok('every WRITABLE domain resolves an id to a named row and draws a card')
    : bad('a writable domain cannot resolve or summarize');
  COACH_DOMAIN_REGISTRY.filter((d) => !d.edit && !d.create && !d.remove).every(
    (d) => d.resolve === undefined && d.summarize === undefined
  )
    ? ok('…and the read-only domains carry neither, so there is nothing to be wrong')
    : bad('a read-only domain carries write machinery');
  COACH_DOMAIN_REGISTRY.every((d) =>
    Object.values(d.fields).every(
      (f) => typeof f.parse === 'function' && typeof f.editable === 'boolean' && f.note
    )
  )
    ? ok('every field declares a parser, an editable flag and a vocabulary note')
    : bad('field shape');
  // FAIL CLOSED. `selfEvident` absent means the LONG card, never the short one.
  COACH_DOMAIN_REGISTRY.every(
    (d) => d.selfEvident === undefined || typeof d.selfEvident === 'function'
  )
    ? ok('selfEvident is a function or absent — and absent means the long card')
    : bad('selfEvident shape');
  // The DEFAULT itself, resolved — not the shape of the field but the answer a
  // silent domain gets. This is the fail-closed direction, asserted.
  domainSelfEvident({ key: 'x' }, { op: 'edit', patch: {}, context: { now: NOW } }) === false
    ? ok('a domain that declares no weight resolves to the LONG card')
    : bad('the default weight is not false');

  // The three enums are DIFFERENT SUBSETS on purpose.
  const editEnum = editRecord.inputSchema.properties.domain.enum;
  JSON.stringify(editEnum) === JSON.stringify(EDIT_DOMAIN_KEYS)
    ? ok(`edit_record's enum IS the registry's editable set (${editEnum.join(', ')})`)
    : bad('edit enum drift', JSON.stringify(editEnum));
  editEnum.every((k) => domainByKey(k) !== undefined)
    ? ok('every enum value resolves to a registered domain')
    : bad('enum names an unregistered domain');
  // A domain a registered tool already reads is ABSENT from query_records, so
  // the schema itself refuses the second path rather than a prompt rule.
  QUERY_DOMAIN_KEYS.every((k) => domainByKey(k).read.kind !== 'bespoke') &&
  COACH_DOMAIN_REGISTRY.filter((d) => d.read.kind === 'bespoke').every(
    (d) => !QUERY_DOMAIN_KEYS.includes(d.key) && toolByName(d.read.via) !== undefined
  )
    ? ok('domains with a bespoke read are excluded from query_records, and that tool exists')
    : bad('bespoke read excluded wrongly', QUERY_DOMAIN_KEYS.join(','));
  REMOVABLE_DOMAIN_KEYS.every(
    (k) => domainByKey(k).remove && domainByKey(k).remove.mode !== 'refuse'
  )
    ? ok(`the removable set is the smaller one (${REMOVABLE_DOMAIN_KEYS.length} today)`)
    : bad('removable set', REMOVABLE_DOMAIN_KEYS.join(','));

  // The open schema is ONE property, deliberately, and the outer object is
  // still closed — every other inputSchema in the registry ends
  // additionalProperties: false and this one must not be the exception.
  editRecord.inputSchema.additionalProperties === false &&
  JSON.stringify(editRecord.inputSchema.properties.fields) === JSON.stringify({ type: 'object' })
    ? ok('edit_record: the outer object is closed, `fields` alone is open')
    : bad('open schema', JSON.stringify(editRecord.inputSchema));
  editRecord.readOnly === false && typeof editRecord.confirmSummary === 'function'
    ? ok('edit_record is a gated write with a confirmation card')
    : bad('edit_record is not gated');
}

console.log('1. the registry agrees with the coverage manifest');
{
  coverageProblems().length === 0
    ? ok('every registered tool is classified into a domain (and vice versa)')
    : bad('coverage problems', coverageProblems().join('; '));
  // A coverage line that has become FALSE is the worst thing that list can
  // hold. Every line a domain retires must be gone from it.
  const stillClaimed = retiredCoverageLines().filter((line) => UNCOVERED_DOMAINS.includes(line));
  stillClaimed.length === 0
    ? ok(
        `no domain retires a CANNOT line that is still printed (${retiredCoverageLines().length} retired)`
      )
    : bad('a retired coverage line is still claimed', stillClaimed.join('; '));
  // The four folded domains kept their labels, which is why the fold cost the
  // manifest nothing — assert that rather than trusting the arithmetic.
  [
    'experiments',
    'reminders',
    'durable memories',
    'the knowledge base and past conversations',
  ].every(
    (label) =>
      COACH_TOOLS.length > 0 &&
      // the label is still printed somewhere in the manifest
      JSON.stringify(UNCOVERED_DOMAINS).includes(label) === false
  )
    ? ok('the four folded domains are still covered, not uncovered')
    : bad('a folded domain fell onto the CANNOT list');
}

console.log('2. the fold is invisible on the card: six lines, byte for byte');
{
  const { db } = freshDb();
  const onceId = createReminder(db, { title: 'Book DEXA', repeat: 'once' }, NOW);
  const dailyId = createReminder(
    db,
    { title: 'Take magnesium', time: '21:00', repeat: 'daily' },
    NOW
  );
  const expId = createExperiment(db, {
    title: 'Magnesium PM',
    hypothesis: 'Better sleep',
    intervention: '400 mg',
    metrics: ['hrv'],
    startDate: isoDaysAgo(NOW, 10),
    durationDays: 14,
  });
  const memId = rememberFact(db, {
    content: 'Magnesium citrate upsets his stomach',
    category: 'constraint',
  });
  const entryId = saveKnowledgeEntry(db, {
    title: 'Zone 2 three times a week',
    topic: 'training',
    section: 'scientific',
    body: 'Three ninety-minute sessions a week, conversational pace.',
  });

  // These six strings are the OLD TOOLS' confirmSummary output, transcribed.
  // If any of them changes, a user who approved one card yesterday is being
  // shown a different one for the same act today.
  const expect = [
    [card(db, 'reminders', onceId, { status: 'done' }), 'Mark reminder "Book DEXA" done'],
    [card(db, 'reminders', dailyId, { status: 'dismissed' }), 'Dismiss reminder "Take magnesium"'],
    [
      card(db, 'experiments', expId, { status: 'concluded', conclusion: 'HRV up 9%' }),
      'Conclude experiment "Magnesium PM"',
    ],
    [
      card(db, 'experiments', expId, { status: 'abandoned', reason: 'got sick' }),
      'Abandon experiment "Magnesium PM" — got sick',
    ],
    [
      card(db, 'memories', memId, { status: 'archived' }),
      'Forget: "Magnesium citrate upsets his stomach"',
    ],
    [
      card(db, 'knowledge', entryId, { status: 'archived' }),
      'Retire entry "Zone 2 three times a week"',
    ],
  ];
  const wrong = expect.filter(([got, want]) => got !== want);
  wrong.length === 0
    ? ok('all six folded cards render exactly as their retired tools did')
    : bad('card drift', wrong.map(([got, want]) => `got "${got}" want "${want}"`).join(' | '));

  // THE WEIGHT, per call rather than per tool — which is the distinction a set
  // of four tool names could not express.
  meta(db, 'reminders', onceId, { status: 'done' }).selfEvident === true &&
  meta(db, 'reminders', onceId, { status: 'done' }).kind === 'status'
    ? ok('marking a ONE-OFF done is self-evident, exactly as complete_reminder was')
    : bad('one-off done weight', JSON.stringify(meta(db, 'reminders', onceId, { status: 'done' })));
  [
    meta(db, 'reminders', dailyId, { status: 'dismissed' }),
    meta(db, 'experiments', expId, { status: 'concluded', conclusion: 'x' }),
    meta(db, 'experiments', expId, { status: 'abandoned', reason: 'x' }),
    meta(db, 'memories', memId, { status: 'archived' }),
    meta(db, 'knowledge', entryId, { status: 'archived' }),
  ].every((m) => m.selfEvident === false)
    ? ok('…and dismissing, concluding, abandoning, forgetting and retiring keep their lanes')
    : bad('a permanent act went brief');

  // The rail that used to live in complete_reminder's DESCRIPTION, refused one
  // Approve tap earlier than that tool refused it.
  const recurring = throwText(() => card(db, 'reminders', dailyId, { status: 'done' }));
  recurring && /repeats daily/.test(recurring) && /never completed/i.test(recurring)
    ? ok('completing a recurring reminder throws at CARD time, naming the rule')
    : bad('recurring rail', String(recurring));
}

console.log('3. the parser: unknown fields, non-editable fields, refused creates');
{
  const { db } = freshDb();
  const id = createReminder(db, { title: 'Book DEXA', repeat: 'once' }, NOW);

  const unknown = throwText(() => card(db, 'reminders', id, { colour: 'red' }));
  unknown && /not a field of reminder/.test(unknown) && /status/.test(unknown)
    ? ok('an unknown field is refused with the field set NAMED — the vocabulary, free')
    : bad('unknown field error', String(unknown));
  const badValue = throwText(() => card(db, 'reminders', id, { status: 'snoozed' }));
  badValue && /must be one of: done, dismissed/.test(badValue)
    ? ok('an unknown value is refused with the value set named')
    : bad('bad value error', String(badValue));
  throws(() => card(db, 'reminders', id, {}))
    ? ok('an empty patch is refused — a card with nothing on it is not a proposal')
    : bad('empty patch accepted');
  throws(() => card(db, 'nope', id, { status: 'done' }))
    ? ok('an unregistered domain is refused')
    : bad('unknown domain accepted');

  // PREFER THE SPECIFIC TOOL is a parser rule, not only prompt copy. A domain
  // whose create has a bespoke tool has NO generic create, and names it.
  COACH_DOMAIN_REGISTRY.every((d) => d.create === undefined || d.createVia === undefined)
    ? ok('no domain offers both a generic create and a bespoke one')
    : bad('a domain has two ways to create the same thing');
  ['meals', 'workouts', 'recipes', 'grocery', 'protocols', 'reminders', 'experiments'].every(
    (k) => domainByKey(k).create === undefined && typeof domainByKey(k).createVia === 'string'
  )
    ? ok('…and every domain with a log/save tool routes creates to it, not to edit_record')
    : bad('a bespoke-create domain grew a generic create');
  // Creating is refused BY NAME, which is what makes the refusal actionable.
  (() => {
    const { db } = freshDb();
    const text = throwText(() =>
      editRecord.confirmSummary({ domain: 'meals', fields: { name: 'x' } }, db, { now: NOW })
    );
    return text !== null && /"id" must be/.test(text);
  })()
    ? ok('edit_record with no id is refused — it patches, it never mints')
    : bad('a create slipped through edit_record');
  COACH_DOMAIN_REGISTRY.filter((d) => d.createVia !== undefined).every(
    (d) => toolByName(d.createVia) !== undefined
  )
    ? ok('…and every bespoke create tool a domain names is actually registered')
    : bad('createVia names a tool that does not exist');
  // `id` is REQUIRED in Phase 1 — there is no create arm to reach.
  JSON.stringify(editRecord.inputSchema.required) === JSON.stringify(['domain', 'id', 'fields'])
    ? ok('edit_record requires an id: it patches, it never mints')
    : bad('required keys', JSON.stringify(editRecord.inputSchema.required));
}

console.log('4. the seals: what is not registrable, and the shipped pack');
{
  // §3.5 of the spike, as a predicate over the registry rather than a promise
  // in a comment. None of these is a domain, and none may become one.
  const FORBIDDEN = [
    'api_key',
    'model',
    'backups',
    'app_lock',
    'health_sync',
    'workout_drafts',
    'pending_estimates',
    'timezone_days',
    'conversations',
    'day_modes',
    'mission',
  ];
  const leaked = FORBIDDEN.filter((k) => domainByKey(k) !== undefined);
  leaked.length === 0
    ? ok(
        `${FORBIDDEN.length} sealed subjects are not domains (incl. day modes — retired, not registered)`
      )
    : bad('a sealed subject is registered', leaked.join(', '));

  // THE SHIPPED PACK is not a row the knowledge domain can address, and this
  // is structural rather than a filter: the pack lives in `knowledge_chunks`
  // with `entry_id IS NULL`, and the domain reads `knowledge_entries`. A pack
  // chunk's id is therefore simply an unknown id.
  const { db } = freshDb();
  const chunkId = insertKnowledgeChunk(db, {
    source: 'arc-longevity-v1',
    title: 'ApoB',
    body: 'ApoB counts atherogenic particles.',
    section: null,
    entryId: null,
  });
  const packError = throwText(() => card(db, 'knowledge', chunkId, { status: 'archived' }));
  packError && /No knowledge entry with id/.test(packError)
    ? ok('a shipped pack chunk id is an UNKNOWN id to the knowledge domain')
    : bad('the pack is addressable', String(packError));
  db.get(`SELECT COUNT(*) AS n FROM knowledge_chunks WHERE source = 'arc-longevity-v1'`).n === 1
    ? ok('…and the chunk is still there, untouched')
    : bad('the pack chunk moved');
}

console.log('4b. query_records: list, compute, windows and the discovery call');
{
  const { db } = freshDb();
  const query = (args) => JSON.parse(queryRecords.execute(db, args, { now: NOW }));

  // THE DISCOVERY CALL — the domain alone. This is where the field vocabulary
  // lives INSTEAD of the cached prompt: one warm round trip on the turn it is
  // needed, never a permanent tax on every turn forever.
  const bare = query({ domain: 'saved_workouts' });
  bare.fields &&
  Object.keys(bare.fields).length > 0 &&
  bare.editable === true &&
  bare.removable === 'hard'
    ? ok('the domain alone returns its fields, and says how it can be written')
    : bad('discovery call', JSON.stringify(bare));
  // A READ-ONLY field SAYS SO, so the model never proposes an edit the parser
  // would refuse a round trip later — and an editable one does not, so the
  // marking means something.
  /read-only/.test(bare.fields.exercises) && !/read-only/.test(bare.fields.name)
    ? ok('…and a read-only field is marked while an editable one is not')
    : bad('read-only marking wrong', JSON.stringify(bare.fields));
  (() => {
    const readOnly = query({ domain: 'lab_reports' });
    return readOnly.editable === false && readOnly.removable === 'no';
  })()
    ? ok('…and a wholly read-only domain says it cannot be written or removed from')
    : bad('lab_reports looks writable');
  query({ domain: 'saved_workouts', query: 'nothing' }).fields === undefined
    ? ok('a FILTERED call omits the vocabulary — it is discovery, not a header')
    : bad('vocabulary billed on every call');

  // A domain a bespoke tool already reads is not in the enum, and the refusal
  // NAMES that tool rather than leaving the model to guess.
  queryRecords.inputSchema.properties.domain.enum.includes('reminders') === false
    ? ok('reminders are absent from the enum — list_reminders reads them')
    : bad('a bespoke-read domain is in the query enum');
  const steered = throwText(() => query({ domain: 'reminders' }));
  steered && /list_reminders/.test(steered)
    ? ok('…and asking anyway is refused by name, at zero further round trips')
    : bad('no steer', String(steered));
  const unknown = throwText(() => query({ domain: 'nope' }));
  unknown && /must be one of/.test(unknown)
    ? ok('an unknown domain is refused with the whole set named')
    : bad('unknown domain', String(unknown));

  // COMPUTE domains are not lists, and saying so is the point: a model must
  // not go looking for "the third row" of a number.
  const computed = throwText(() => query({ domain: 'micronutrients' }));
  computed && /computed, not listed/.test(computed) && /YYYY-MM-DD/.test(computed)
    ? ok('a compute domain with no id errors, naming what it needs')
    : bad('compute without id', String(computed));
  const micros = query({ domain: 'micronutrients', id: TODAY });
  micros.result.date === TODAY && /absence, not a set of zeroes/.test(micros.result.note ?? '')
    ? ok('…and an empty day is an ABSENCE in words, never a panel of zeroes')
    : bad('micros', JSON.stringify(micros));

  // The cap, and ids on every row of a list domain.
  createReminder(db, { title: 'x', repeat: 'once' }, NOW);
  for (let i = 0; i < 30; i++) {
    logMeal(db, { date: TODAY, time: null, name: `meal ${i}`, kcal: 100 });
  }
  const capped = query({ domain: 'meals', limit: 999 });
  capped.count === 25 && capped.rows.every((r) => typeof r.id === 'string' && r.id.length > 0)
    ? ok('a list domain caps at 25 and carries an id on every row')
    : bad('cap or ids', JSON.stringify({ count: capped.count }));
  query({ domain: 'meals' }).count === 10
    ? ok('…and defaults to 10')
    : bad('default limit', String(query({ domain: 'meals' }).count));

  // The WINDOW respects the logical day: a meal logged for yesterday is not in
  // today's read, and is in a window that includes it.
  const yesterday = shiftISODate(TODAY, -1);
  logMeal(db, { date: yesterday, time: '12:30', name: 'yesterday lunch', kcal: 620 });
  query({ domain: 'meals', limit: 25 }).rows.every((r) => r.date === TODAY) &&
  query({ domain: 'meals', from: yesterday, to: yesterday, limit: 25 }).rows.some(
    (r) => r.name === 'yesterday lunch'
  )
    ? ok('a from/to window reads a PAST day back — which no tool could do before')
    : bad('window');

  // WHAT A WEIGHT COUNTS (0062). The Coach reads a dumbbell's 30 kg as 30 kg —
  // one dumbbell — only if the payload says so; nothing in the number does.
  // Payload, never schema: coach-eval §6's ceilings are untouched by this.
  logWorkout(db, { date: TODAY, kind: 'strength' }, [
    { exercise: 'DB Bench', exerciseId: 'dumbbell-bench-press', reps: 8, weightKg: 30 },
    { exercise: 'DB Bench', exerciseId: 'dumbbell-bench-press', reps: 6, weightKg: 32 },
  ]);
  const dbStats = query({ domain: 'exercise_stats', id: 'dumbbell-bench-press' }).result;
  dbStats.loadBasis === 'per_hand' &&
  dbStats.records.maxWeightKg === 32 &&
  Array.isArray(dbStats.repMaxes) &&
  dbStats.repMaxes.length === 2
    ? ok('exercise_stats says per_hand beside UNDOUBLED records, with the rep-max table')
    : bad('exercise_stats basis', JSON.stringify(dbStats));
  dbStats.recentTopSets.every((t) => !('workoutId' in t))
    ? ok('…and leaves the screen’s join key (a UUID per row) out of the payload')
    : bad('workoutId leaked', JSON.stringify(dbStats.recentTopSets));
  const catalogRows = query({ domain: 'exercise_catalog', query: 'bench', limit: 25 }).rows;
  const byId = new Map(catalogRows.map((r) => [r.id, r]));
  byId.get('dumbbell-bench-press')?.loadBasis === 'per_hand' &&
  byId.get('barbell-bench-press')?.loadBasis === 'total'
    ? ok('exercise_catalog rows carry loadBasis: per_hand for the dumbbell, total for the bar')
    : bad('catalog basis', JSON.stringify(catalogRows));
  const plankRow = query({ domain: 'exercise_catalog', query: 'plank' }).rows.find(
    (r) => r.id === 'plank'
  );
  plankRow && !('loadBasis' in plankRow)
    ? ok('…and a plank carries none: no weight figure, nothing to describe')
    : bad('plank basis', JSON.stringify(plankRow));
  /per_hand/.test(query({ domain: 'exercise_catalog' }).fields.loadBasis ?? '')
    ? ok('the vocabulary is on the discovery call, where field notes live instead of the prompt')
    : bad('basis vocabulary');

  // THE PASS. query_records is held back from the unattended Haiku pass, and
  // no write has ever been in it.
  PASS_READ_TOOLS.every((t) => t.readOnly && t.name !== 'query_records') &&
  PASS_READ_TOOLS.length === READ_TOOLS.length - 1
    ? ok('the unattended pass gets every read EXCEPT query_records, and no write')
    : bad('pass tool set', PASS_READ_TOOLS.map((t) => t.name).join(','));
}

console.log('4c. READ-MODIFY-WRITE: a patch never erases what it did not mention');
{
  const { db } = freshDb();

  // THE C10 CLASS, and the sharpest instance in the registry. `replaceWorkout`
  // DELETES every set and re-inserts its argument, so a literal patch of one
  // field would empty the session — every rep, every load, every PR the engine
  // computes from those rows — behind a card that named the duration.
  const workoutId = logWorkout(
    db,
    { date: TODAY, kind: 'strength', durationMin: 45, notes: 'felt good' },
    [
      { exercise: 'Bench Press', reps: 8, weightKg: 80, setType: 'normal' },
      { exercise: 'Bench Press', reps: 8, weightKg: 82.5, setType: 'normal' },
    ]
  );
  const before = JSON.stringify(getWorkoutDetail(db, workoutId).sets);
  edit(db, 'workouts', workoutId, { duration_min: 50 });
  const after = getWorkoutDetail(db, workoutId);
  JSON.stringify(after.sets.map(({ id: _id, ...s }) => s)) ===
  JSON.stringify(JSON.parse(before).map(({ id: _id, ...s }) => s))
    ? ok('patching a workout’s duration leaves every set byte-identical')
    : bad('sets lost', JSON.stringify(after.sets));
  after.durationMin === 50 && after.notes === 'felt good' && after.kind === 'strength'
    ? ok('…and the fields the patch never mentioned are untouched')
    : bad('workout fields', JSON.stringify(after));
  // `sets` is not a field the model can send AT ALL.
  throws(() => card(db, 'workouts', workoutId, { sets: [] }))
    ? ok('“sets” is refused as a field — the session screen owns them')
    : bad('sets patched through the generic path');

  // `updateMealMeta` rewrites name, time AND notes in one statement.
  const mealId = logMeal(db, {
    date: TODAY,
    time: '12:30',
    name: 'Salmon bowl',
    kcal: 700,
    notes: 'with extra rice',
  });
  const line = card(db, 'meals', mealId, { name: 'Salmon bowl, large' });
  line === 'Edit meal "Salmon bowl" — name Salmon bowl → Salmon bowl, large'
    ? ok(`the card is before → after, resolved from the row ("${line}")`)
    : bad('meal card', line);
  edit(db, 'meals', mealId, { name: 'Salmon bowl, large' });
  const meal = getMeal(db, mealId);
  meal.name === 'Salmon bowl, large' && meal.notes === 'with extra rice' && meal.time === '12:30'
    ? ok('renaming a meal keeps its notes and its clock')
    : bad('meal fields', JSON.stringify(meal));
  // A patch that changes nothing costs no Approve tap.
  throws(() => card(db, 'meals', mealId, { name: 'Salmon bowl, large' }))
    ? ok('a patch that changes nothing throws instead of drawing a card')
    : bad('no-op card drawn');
  // The macros are READ-ONLY through this path — parity with the Eat screen.
  throws(() => card(db, 'meals', mealId, { kcal: 640 }))
    ? ok('a meal’s macros are not patchable — an itemized total would disagree with its items')
    : bad('macros patched');
  // A future date is refused at CARD time, the log tools' own rule.
  throws(() => card(db, 'meals', mealId, { date: shiftISODate(TODAY, 3) }))
    ? ok('a future date is refused before the gate, not after it')
    : bad('future date accepted');

  // `content` is not a field of the protocol domain, for the same reason.
  createProtocolWithVersion(
    db,
    { name: 'Evening Stack', type: 'supplement_stack' },
    { phases: [{ title: null, duration_days: null, items: [] }] },
    'seed'
  );
  throws(() => card(db, 'protocols', 'evening_stack', { content: {} }))
    ? ok('a protocol’s document is refused — update_protocol takes the complete set')
    : bad('protocol content patched');
  card(db, 'protocols', 'evening_stack', { is_active: false }).startsWith('Edit protocol')
    ? ok('…while its identity and policy are patchable')
    : bad('protocol policy not editable');
}

console.log('4d. removal: refuse, hard, and undo-only');
{
  const { db } = freshDb();
  const deleteRecord = toolByName('delete_record');
  const del = (domain, id, conversationId) =>
    deleteRecord.confirmSummary({ domain, id }, db, { now: NOW, conversationId });

  // The three policies, as the registry declares them.
  const byMode = (mode) =>
    COACH_DOMAIN_REGISTRY.filter((d) => d.remove?.mode === mode).map((d) => d.key);
  JSON.stringify(byMode('own')) === JSON.stringify(['meals', 'workouts'])
    ? ok('only a meal and a workout are UNDO-deletable — the two the Coach logs and owns')
    : bad('own set', byMode('own').join(','));
  byMode('refuse').includes('protocols')
    ? ok('a protocol refuses removal — its versions are what past days were lived under')
    : bad('protocols removable');
  // `refuse` domains are absent from delete_record's enum entirely, so the
  // schema turns them down at zero round trips.
  deleteRecord.inputSchema.properties.domain.enum.includes('protocols') === false
    ? ok('…and it is not in the enum at all, so the schema refuses it for free')
    : bad('a refuse domain is in the delete enum');
  // …and asking anyway gets the SCREEN, not just a no. A refusal that only
  // says "you cannot" leaves the user with nowhere to go.
  const refused = throwText(() => del('protocols', 'x'));
  refused && /Pause it with/.test(refused) && /delete it on Protocols/.test(refused)
    ? ok('asking anyway names the affordance and the screen, not just a refusal')
    : bad('refusal text', String(refused));
  const unknown = throwText(() => del('nope', 'x'));
  unknown && /must be one of/.test(unknown)
    ? ok('an unregistered domain names the removable set')
    : bad('unknown delete domain', String(unknown));

  // HARD, and it must not strand history: `PRAGMA foreign_key_list` on every
  // table pointing at a `hard` domain's table must be SET NULL, never CASCADE,
  // from anything that is a log.
  const HARD_TABLES = {
    food_catalog: 'foods',
    meal_templates: 'meal_templates',
    saved_workouts: 'routines',
    recipes: 'recipes',
    screenings: 'screenings',
  };
  const strands = [];
  for (const [key, table] of Object.entries(HARD_TABLES)) {
    for (const child of ['meals', 'meal_items', 'workouts', 'grocery_items', 'appointments']) {
      for (const fk of db.all(`PRAGMA foreign_key_list(${child})`)) {
        if (fk.table === table && fk.on_delete === 'CASCADE') strands.push(`${key}: ${child}`);
      }
    }
  }
  strands.length === 0
    ? ok('no `hard` domain cascades into a log table — history cannot be stranded')
    : bad('a hard delete would strand history', strands.join(', '));

  // THE UNDO. A meal the Coach did not log is refused AT CARD TIME, so the
  // user never answers a gate for it.
  const mealId = logMeal(db, { date: TODAY, time: '12:30', name: 'Salmon bowl', kcal: 700 });
  const conversationId = createConversation(db);
  const notMine = throwText(() => del('meals', mealId, conversationId));
  notMine && /not one you logged in this conversation/.test(notMine)
    ? ok('deleting a meal the Coach did not log is refused before the gate')
    : bad('undo check', String(notMine));
  // …and with no thread at all, nothing counts as the Coach's own write.
  throws(() => del('meals', mealId, undefined))
    ? ok('…and with no conversation, nothing counts as its own write (fail closed)')
    : bad('no-conversation delete allowed');

  // Now record a turn in which the Coach logged one, exactly as the service
  // layer would: the tool RESULT carries the new id.
  const mineId = logMeal(db, { date: TODAY, time: '19:00', name: 'Chicken and rice', kcal: 800 });
  appendMessage(db, conversationId, 'assistant', 'Logged it.', [
    {
      id: 'toolu_1',
      name: 'log_meal',
      input: {},
      result: JSON.stringify({ logged: true, id: mineId }),
      receipt: 'Log meal "Chicken and rice" · 800 kcal',
    },
  ]);
  del('meals', mineId, conversationId) === 'Delete meal "Chicken and rice"'
    ? ok('a meal THIS thread’s Coach logged can be undone, and the card says Delete')
    : bad('undo card', del('meals', mineId, conversationId));
  toolByName('delete_record').confirmMeta({}, db, { now: NOW }).kind === 'delete'
    ? ok('…and the card is told it is a removal, so its lanes can word one')
    : bad('delete kind');
  JSON.parse(
    deleteRecord.execute(db, { domain: 'meals', id: mineId }, { now: NOW, conversationId })
  ).deleted === true && getMeal(db, mineId) === undefined
    ? ok('…and the row is gone')
    : bad('undo did not delete');
  getMeal(db, mealId) !== undefined
    ? ok('…while the meal it did not log is still there')
    : bad('the wrong meal was deleted');
}

console.log('5. retired names still answer as writes, so no receipt is lost');
{
  RETIRED_WRITE_NAMES.size === 6
    ? ok('six names retired into edit_record')
    : bad('retired count', String(RETIRED_WRITE_NAMES.size));
  [...RETIRED_WRITE_NAMES].every((n) => toolByName(n) === undefined)
    ? ok('…none of them is still registered')
    : bad('a retired tool is still on the wire');
  [...RETIRED_WRITE_NAMES].every((n) => isRetiredWriteName(n))
    ? ok('…and each still answers isRetiredWriteName')
    : bad('retired predicate');

  // The exact composition src/hooks/use-coach-chat.ts uses. Without the second
  // clause a persisted `complete_reminder` call reads as a READ and silently
  // drops out of the "these changes landed" line — in a thread where that line
  // is the only record the change happened at all.
  const isWrite = (name) => toolByName(name)?.readOnly === false || isRetiredWriteName(name);
  const stored = [
    {
      id: 't1',
      name: 'complete_reminder',
      input: {},
      result: '{}',
      receipt: 'Mark reminder "Book DEXA" done',
    },
    { id: 't2', name: 'forget', input: {}, result: '{}' },
    { id: 't3', name: 'get_today_snapshot', input: {}, result: '{}' },
  ];
  const receipts = landedWriteReceipts(stored, isWrite, humanizeToolName);
  JSON.stringify(receipts) === JSON.stringify(['Mark reminder "Book DEXA" done', 'forget'])
    ? ok('a stored call naming a RETIRED tool still yields its receipt (and its fallback)')
    : bad('retired receipts lost', JSON.stringify(receipts));
  landedWriteReceipts(stored, (n) => toolByName(n)?.readOnly === false, humanizeToolName).length ===
  0
    ? ok('…and the registry ALONE would have lost both, which is why the set exists')
    : bad('the test is not proving anything');
}

console.log('6. staleness: the row moved while the card was open');
{
  // The card is built BEFORE `await confirmWrite` and the row can move inside
  // that window — a Health sync, the pending-estimate drain, a carry-over
  // re-derive, or the user editing the same row on its own screen. This drives
  // the REAL service seam, with the mutation happening inside the gate.
  const { register } = await import('node:module');
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
  const toolUseReply = (name, input) =>
    sse([
      { type: 'message_start', message: {} },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_stale', name, input: {} },
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
          read: async () =>
            sent ? { done: true } : ((sent = true), { done: false, value: bytes }),
        }),
      },
    };
  };

  const { db } = freshDb();
  globalThis.__ARC_TEST_DB__ = db;
  const expId = createExperiment(db, {
    title: 'Magnesium PM',
    hypothesis: 'Better sleep',
    intervention: '400 mg',
    metrics: ['hrv'],
    startDate: isoDaysAgo(NOW, 20),
    durationDays: 14,
  });
  const replies = [
    toolUseReply('edit_record', {
      domain: 'experiments',
      id: expId,
      fields: { status: 'concluded', conclusion: 'the Coach verdict' },
    }),
    textReply('Understood.'),
  ];
  globalThis.__ARC_TEST_FETCH__ = async () => responseOf(replies.shift());
  await apiKeyStore.setKey('test-key');

  let cardLine = null;
  const result = await streamCoachReply(
    [{ id: 'u1', role: 'user', content: 'close the magnesium trial', createdAt: 0 }],
    {
      onToken: () => {},
      now: () => NOW,
      confirmWrite: async (request) => {
        cardLine = request.summary;
        // The row moves WHILE the gate is up — the user concluded it on the
        // experiment screen with a different verdict.
        completeExperiment(db, expId, {
          conclusion: 'the verdict he typed himself',
          outcomeNotes: null,
        });
        return true;
      },
    }
  );
  await apiKeyStore.clearKey();

  cardLine === 'Conclude experiment "Magnesium PM"'
    ? ok('the card was drawn from the row as it was')
    : bad('card', String(cardLine));
  const call = result.toolCalls[0];
  call.isError === true &&
  call.result ===
    'status changed while the card was open (was active, now completed). ' +
      'Nothing written. Read it again and propose once more.'
    ? ok('execute re-read the row and refused, in the exact words the spike specifies')
    : bad('staleness text', JSON.stringify(call.result));
  call.receipt === undefined
    ? ok('…so NO receipt was minted — receipts live past execute, and execute threw')
    : bad('a receipt was minted for a refused write', String(call.receipt));
  const isWrite = (name) => toolByName(name)?.readOnly === false || isRetiredWriteName(name);
  landedWriteReceipts(result.toolCalls, isWrite, humanizeToolName).length === 0
    ? ok('…and the thread reports nothing landed')
    : bad('a refused write was reported as landed');
  getExperiment(db, expId).conclusion === 'the verdict he typed himself'
    ? ok('the user’s own verdict stands — the Coach’s never reached the row')
    : bad('the stale write landed anyway', getExperiment(db, expId).conclusion);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
