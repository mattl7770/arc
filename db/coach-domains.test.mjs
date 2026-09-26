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
 *
 * §4d is DELETION BY PARITY (the owner's 2026-09-23 call): whatever a screen
 * deletes, the Coach may delete through that screen's own function, behind a
 * card that names the row's day and figures — and whatever no screen deletes
 * is refused, naming where the row lives.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { clockFromISO, formatLocalDate, shiftISODate, todayISODate } from '../src/lib/db/date.ts';
import {
  completeExperiment,
  createExperiment,
  getExperiment,
} from '../src/lib/db/repositories/experiments.ts';
import { createReminder } from '../src/lib/db/repositories/reminders.ts';
import {
  deleteMeal,
  getMeal,
  insertMealPhoto,
  listMealItems,
  logMeal,
  logMealWithItems,
  updateMealMeta,
} from '../src/lib/db/repositories/nutrition.ts';
import {
  createCustomExercise,
  getExercise,
  setExerciseLoadBasis,
} from '../src/lib/db/repositories/exercise-catalog.ts';
import { getWorkoutDetail, logWorkout } from '../src/lib/db/repositories/exercise.ts';
import {
  addVersion,
  createProtocolWithVersion,
  getProtocolBySlug,
} from '../src/lib/db/repositories/protocols.ts';
import { listWaterEntries, logWater } from '../src/lib/db/repositories/water.ts';
import { setHealthSyncEnabled, setUnitPreference } from '../src/lib/db/repositories/user.ts';
import { createFood } from '../src/lib/db/repositories/foods.ts';
import { createTemplate } from '../src/lib/db/repositories/meal-templates.ts';
import { createRoutine } from '../src/lib/db/repositories/routines.ts';
import { createRecipe } from '../src/lib/db/repositories/recipes.ts';
import { addGroceryItems } from '../src/lib/db/repositories/grocery.ts';
import { addAppointment, addScreening } from '../src/lib/db/repositories/screenings.ts';
import { setMuscleAnchor } from '../src/lib/db/repositories/muscle-anchors.ts';
import { forgetMemory, getMemory, rememberFact } from '../src/lib/db/repositories/coach-memory.ts';
import {
  archiveKnowledgeEntry,
  getKnowledgeEntry,
  restoreKnowledgeEntry,
  saveKnowledgeEntry,
  updateKnowledgeEntry,
} from '../src/lib/db/repositories/knowledge.ts';
import { listEntriesOn, logCapture, logMetric, logNote } from '../src/lib/db/repositories/logs.ts';
import { removeLogCapture } from '../src/lib/health/publish.ts';
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
  // card to draw. That is the invariant `edit_record` relies on. A `refuse`
  // removal is not a write: it answers before any id is looked up. A domain
  // that can ONLY be removed from (the Log tab's captures, 2026-09-25) resolves
  // but draws no edit card: a removal's card is `describeDelete` over `gone`.
  COACH_DOMAIN_REGISTRY.filter((d) => d.edit || d.create || d.remove?.mode === 'hard').every(
    (d) =>
      typeof d.resolve === 'function' &&
      (typeof d.summarize === 'function' || (!d.edit && !d.create))
  )
    ? ok('every WRITABLE domain resolves an id to a named row, and every editable one draws a card')
    : bad('a writable domain cannot resolve or summarize');
  COACH_DOMAIN_REGISTRY.filter((d) => !d.edit && !d.create).every(
    (d) => d.summarize === undefined && (d.remove?.mode === 'hard' || d.resolve === undefined)
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
  REMOVABLE_DOMAIN_KEYS.every((k) => domainByKey(k).remove?.mode === 'hard')
    ? ok(`the removable set is the \`hard\` one (${REMOVABLE_DOMAIN_KEYS.length} today)`)
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
    return readOnly.editable === false && readOnly.removable === 'refuse';
  })()
    ? ok('…and a wholly read-only domain says it cannot be written, and that removal refuses')
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
  micros.result.date === TODAY &&
  /absence, not a set of zeroes/.test(micros.result.note ?? '') &&
  // Fiber too (2026-09-23): null, not 0 g, when nothing recorded it.
  micros.result.fiber_g === null
    ? ok('…and an empty day is an ABSENCE in words, never a panel of zeroes — fiber null too')
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
  // An ASSISTED movement's figure is help: its heaviest set is its easiest, so
  // the payload must not crown it the way the records grid refuses to.
  const assisted = createCustomExercise(db, {
    name: 'Assisted Pull-Up',
    equipment: 'machine',
    loggingType: 'assisted_bodyweight',
    primaryMuscles: ['lats'],
  });
  logWorkout(db, { date: TODAY, kind: 'strength' }, [
    { exercise: 'Assisted Pull-Up', exerciseId: assisted, reps: 8, weightKg: 35 },
    { exercise: 'Assisted Pull-Up', exerciseId: assisted, reps: 8, weightKg: 15 },
  ]);
  const aStats = query({ domain: 'exercise_stats', id: assisted }).result;
  aStats.loadBasis === 'assisted' &&
  aStats.records.maxWeightKg === null &&
  aStats.records.bestE1rmKg === null &&
  aStats.records.bestReps === 8 &&
  !('repMaxes' in aStats) &&
  !('e1rmSeries' in aStats) &&
  aStats.recentTopSets[0]?.weightKg === 15
    ? ok('assisted: no load records, no rep maxes, no e1RM series — and the top set is the LEAST help')
    : bad('assisted exercise_stats', JSON.stringify(aStats));
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

console.log('4d. removal: parity with the screens, behind a card that names what goes');
{
  const { db, raw } = freshDb();
  const deleteRecord = toolByName('delete_record');
  /** The card alone, on a fresh context — no conversation anywhere. */
  const del = (domain, id) => deleteRecord.confirmSummary({ domain, id }, db, { now: NOW });
  /** Card, then execute, on ONE context: the service's own sequence. */
  const approve = (domain, id) => {
    const context = { now: NOW };
    const line = deleteRecord.confirmSummary({ domain, id }, db, context);
    return { line, result: JSON.parse(deleteRecord.execute(db, { domain, id }, context)) };
  };
  const count = (sql, params) => db.get(sql, params).n;

  // --- THE POLICY, as the registry declares it ------------------------------
  const byMode = (mode) =>
    COACH_DOMAIN_REGISTRY.filter((d) => d.remove?.mode === mode).map((d) => d.key);
  const HARD = [
    'meals',
    'food_catalog',
    'meal_templates',
    'water',
    'saved_workouts',
    'workouts',
    'recipes',
    'grocery',
    'screenings',
    'appointments',
    'muscle_anchors',
    'protocols',
    // 2026-09-25, the owner's answers: memories and knowledge opened, and the
    // Log tab's captures gained a delete — so the Coach has it too.
    'memories',
    'knowledge',
    'captures',
  ];
  JSON.stringify([...byMode('hard')].sort()) === JSON.stringify([...HARD].sort())
    ? ok(
        `${HARD.length} domains are removable — a meal, a session, a protocol, a memory and a capture among them`
      )
    : bad('hard set', byMode('hard').join(','));
  COACH_DOMAIN_REGISTRY.every((d) => !d.remove || ['hard', 'refuse'].includes(d.remove.mode))
    ? ok('there is no third mode: the undo-only `own` rule is gone, not dormant')
    : bad('a domain still declares another removal mode');
  JSON.stringify(deleteRecord.inputSchema.properties.domain.enum) ===
  JSON.stringify(REMOVABLE_DOMAIN_KEYS)
    ? ok('delete_record’s enum IS the hard set, so everything else is refused at zero round trips')
    : bad('delete enum drift', JSON.stringify(deleteRecord.inputSchema.properties.domain.enum));
  // Every domain that HOLDS ROWS says what happens to them — so a domain added
  // later cannot be refused by omission, with no word about where its rows
  // live. Compute domains hold none, and Settings is one row with nothing to
  // remove.
  const silent = COACH_DOMAIN_REGISTRY.filter(
    (d) => d.read.kind !== 'compute' && d.key !== 'settings' && d.remove === undefined
  ).map((d) => d.key);
  silent.length === 0
    ? ok('every domain that holds rows declares whether they can be removed')
    : bad('a domain holding rows says nothing about removal', silent.join(', '));

  // --- WHAT NO SCREEN DELETES IS REFUSED, NAMING WHERE THE ROW LIVES ---------
  // An invented id is used on purpose: the refusal must come BEFORE any lookup,
  // so the answer is about the domain and never "no such row".
  const REFUSED = {
    protocol_versions: /Protocols › the protocol › Versions/,
    lab_reports: /Data › Labs/,
    reminders: /status: "dismissed"/,
    experiments: /edit_record \{ status \}/,
    exercise_catalog: /status: "archived"/,
    progress_photos: /Data › Progress photos/,
    reports: /Data › Reports/,
  };
  const misnamed = Object.entries(REFUSED)
    .filter(([key, where]) => {
      const text = throwText(() => del(key, 'no-such-id'));
      return !(text && where.test(text)) || REMOVABLE_DOMAIN_KEYS.includes(key);
    })
    .map(([key]) => key);
  misnamed.length === 0
    ? ok(
        `a row no screen deletes is refused, naming where it lives and what to do instead (${Object.keys(REFUSED).length} domains)`
      )
    : bad('refusal missing or unnamed', misnamed.join(', '));
  const unknown = throwText(() => del('nope', 'x'));
  unknown && /must be one of/.test(unknown) && /protocols/.test(unknown)
    ? ok('an unregistered domain names the removable set')
    : bad('unknown delete domain', String(unknown));

  // --- HISTORY CANNOT BE STRANDED --------------------------------------------
  // Every CASCADE into a removable domain's table must be that row's OWN PART
  // — its items, its sets, its versions — which is what the card counts. Any
  // other reference is SET NULL (CLAUDE.md §9), so a meal cooked from a deleted
  // recipe keeps its macros and a day lived under a deleted protocol keeps its
  // entries. Walked over EVERY table, so a future CASCADE fails here.
  const TABLE = {
    meals: 'meals',
    food_catalog: 'foods',
    meal_templates: 'meal_templates',
    water: 'wearable_data',
    saved_workouts: 'routines',
    workouts: 'workouts',
    recipes: 'recipes',
    grocery: 'grocery_items',
    screenings: 'screenings',
    appointments: 'appointments',
    muscle_anchors: 'muscle_freshness_anchors',
    protocols: 'protocols',
    memories: 'coach_memories',
    knowledge: 'knowledge_entries',
    // One domain over the Log tab's four capture tables.
    captures: ['log_entries', 'wearable_data', 'body_metrics', 'symptoms'],
  };
  const OWN_PARTS = {
    // the items and photos (both counted on the card) and its pending estimate
    meals: ['meal_items', 'meal_photos', 'pending_estimates'],
    // the sets (counted) and the pairing link — the watch's session itself stays
    workouts: ['workout_sets', 'workout_ingest_links'],
    meal_templates: ['meal_template_items'],
    saved_workouts: ['routine_exercises', 'program_days'],
    recipes: ['recipe_ingredients'],
    protocols: ['protocol_versions'],
    // a link only ever hangs off a WATCH workout's wearable row, never water
    water: ['workout_ingest_links'],
    // its retrievable text; the vectors go first, by id, in deleteKnowledgeEntry
    knowledge: ['knowledge_chunks'],
    // …and never off a manual capture's row either
    captures: ['workout_ingest_links'],
  };
  const tables = db
    .all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .map((r) => r.name);
  const strands = [];
  for (const key of REMOVABLE_DOMAIN_KEYS) {
    if (!TABLE[key]) {
      strands.push(`${key} has no table mapped here`);
      continue;
    }
    for (const child of tables) {
      for (const fk of db.all(`PRAGMA foreign_key_list(${child})`)) {
        if (
          [TABLE[key]].flat().includes(fk.table) &&
          fk.on_delete === 'CASCADE' &&
          !(OWN_PARTS[key] ?? []).includes(child)
        ) {
          strands.push(`${key} → ${child}.${fk.from}`);
        }
      }
    }
  }
  strands.length === 0
    ? ok('a removal CASCADES only into the row’s own parts — every other reference is SET NULL')
    : bad('a removal would strand history', strands.join(', '));

  // --- A MEAL THE USER LOGGED BY HAND ----------------------------------------
  // No conversation exists anywhere in this block: that is the owner's case,
  // "something you logged yourself", which the 2026-09-19 rule refused.
  setUnitPreference(db, 'volume', 'ml');
  const { mealId } = logMealWithItems(db, {
    date: TODAY,
    time: '12:30',
    name: 'Salmon bowl',
    items: [
      { name: 'Salmon', kcal: 400, protein_g: 35, carbs_g: 0, fat_g: 20 },
      { name: 'Rice', kcal: 300, protein_g: 10, carbs_g: 60, fat_g: 0 },
    ],
  });
  insertMealPhoto(db, { meal_id: mealId, file_name: 'bowl.jpg', source: 'camera' });
  const mealCard = del('meals', mealId);
  mealCard ===
  `Delete meal "Salmon bowl" — ${TODAY} 12:30 · 700 kcal · P 45g · C 60g · F 20g · 2 items · 1 photo`
    ? ok(
        `a meal the user logged draws a card naming its day, figures, items and photo ("${mealCard}")`
      )
    : bad('meal card', mealCard);
  const mealMeta = deleteRecord.confirmMeta({ domain: 'meals', id: mealId }, db, { now: NOW });
  mealMeta.kind === 'delete' && mealMeta.selfEvident === false
    ? ok('…on the LONG card, told it is a removal — a deletion is never the brief card')
    : bad('delete meta', JSON.stringify(mealMeta));
  const meal = approve('meals', mealId);
  meal.result.deleted === true &&
  getMeal(db, mealId) === undefined &&
  count('SELECT count(*) n FROM meal_items WHERE meal_id = ?', [mealId]) === 0 &&
  count('SELECT count(*) n FROM meal_photos WHERE meal_id = ?', [mealId]) === 0
    ? ok('…and approving it removes the meal, its items and its photo — exactly what the card said')
    : bad('meal not removed', JSON.stringify(meal.result));

  // --- A SESSION THE USER LOGGED BY HAND -------------------------------------
  const workoutId = logWorkout(
    db,
    { date: TODAY, kind: 'strength', durationMin: 45, notes: null },
    [
      { exercise: 'Bench Press', reps: 8, weightKg: 80, setType: 'normal' },
      { exercise: 'Bench Press', reps: 8, weightKg: 80, setType: 'normal' },
      { exercise: 'Back Squat', reps: 5, weightKg: 120, setType: 'normal' },
    ]
  );
  const movements = [...new Set(getWorkoutDetail(db, workoutId).sets.map((s) => s.exercise))];
  const workoutCard = del('workouts', workoutId);
  workoutCard === `Delete workout "strength on ${TODAY}" — 45 min · 3 sets: ${movements.join(', ')}`
    ? ok(
        `a session the user logged draws a card naming its day, length and sets ("${workoutCard}")`
      )
    : bad('workout card', workoutCard);
  approve('workouts', workoutId);
  getWorkoutDetail(db, workoutId) === undefined &&
  count('SELECT count(*) n FROM workout_sets WHERE workout_id = ?', [workoutId]) === 0
    ? ok('…and approving it removes the session and every set, through the session screen’s delete')
    : bad('workout not removed');

  // --- A WATER ENTRY THE USER LOGGED BY HAND ---------------------------------
  const waterId = logWater(db, TODAY, 500);
  const at = listWaterEntries(db, TODAY).find((e) => e.id === waterId).at;
  const waterCard = del('water', waterId);
  waterCard === `Delete water entry "500 ml on ${TODAY}" — logged at ${clockFromISO(at)}`
    ? ok(`a water entry draws a card naming its day, amount and clock ("${waterCard}")`)
    : bad('water card', waterCard);
  setUnitPreference(db, 'volume', 'oz');
  /— 16\.9 oz, logged at /.test(del('water', waterId))
    ? ok('…and an oz user sees the amount as they entered it')
    : bad('oz water card', del('water', waterId));
  approve('water', waterId);
  listWaterEntries(db, TODAY).some((e) => e.id === waterId) === false
    ? ok('…and approving it removes the entry, through the water screen’s delete')
    : bad('water not removed');

  // --- THE UNDO STILL WORKS: a row the Coach wrote a moment ago --------------
  // Through the real `log_meal` tool and a recorded turn, as the service would.
  // The card is the SAME card a hand-logged meal gets: nothing about removal
  // depends on who wrote the row any more.
  const conversationId = createConversation(db);
  const logged = JSON.parse(
    toolByName('log_meal').execute(
      db,
      { name: 'Chicken and rice', time: '19:00', kcal: 800, protein_g: 60 },
      { now: NOW }
    )
  );
  appendMessage(db, conversationId, 'assistant', 'Logged it.', [
    {
      id: 'toolu_1',
      name: 'log_meal',
      input: {},
      result: JSON.stringify(logged),
      receipt: 'Log meal "Chicken and rice" · 800 kcal, 60 g protein',
    },
  ]);
  const undo = approve('meals', logged.id);
  undo.line === `Delete meal "Chicken and rice" — ${TODAY} 19:00 · 800 kcal · P 60g` &&
  undo.result.deleted === true &&
  getMeal(db, logged.id) === undefined
    ? ok('the undo still works: a meal the Coach just logged goes through the same card')
    : bad('undo', JSON.stringify(undo));

  // --- STALENESS: the row moved while the card was open ----------------------
  // A FIGURE the card printed — the pending-estimate drain landing mid-gate.
  const pastaId = logMeal(db, { date: TODAY, time: '20:00', name: 'Pasta', kcal: 700 });
  const figureCtx = { now: NOW };
  deleteRecord.confirmSummary({ domain: 'meals', id: pastaId }, db, figureCtx);
  db.run('UPDATE meals SET kcal = 640 WHERE id = ?', [pastaId]);
  const figureMoved = throwText(() =>
    deleteRecord.execute(db, { domain: 'meals', id: pastaId }, figureCtx)
  );
  figureMoved &&
  /changed while the card was open/.test(figureMoved) &&
  figureMoved.includes('700 kcal') &&
  figureMoved.includes('640 kcal') &&
  /Nothing deleted/.test(figureMoved) &&
  getMeal(db, pastaId) !== undefined
    ? ok('a figure that moved inside the gate refuses the delete, quoting both lines')
    : bad('figure staleness', String(figureMoved));
  // A FIELD — the user renamed it on its own screen while the card was up.
  const fieldCtx = { now: NOW };
  deleteRecord.confirmSummary({ domain: 'meals', id: pastaId }, db, fieldCtx);
  updateMealMeta(db, pastaId, { name: 'Pasta, large', time: '20:00', notes: null });
  const fieldMoved = throwText(() =>
    deleteRecord.execute(db, { domain: 'meals', id: pastaId }, fieldCtx)
  );
  fieldMoved ===
    'name changed while the card was open (was Pasta, now Pasta, large). ' +
      'Nothing deleted. Read it again and propose once more.' && getMeal(db, pastaId) !== undefined
    ? ok('…and so does a field, in the exact words edit_record uses')
    : bad('field staleness', String(fieldMoved));
  // GONE — deleted on its own screen while the card was up. The Coach must not
  // mint a receipt for a deletion the user made by hand.
  const goneCtx = { now: NOW };
  deleteRecord.confirmSummary({ domain: 'meals', id: pastaId }, db, goneCtx);
  deleteMeal(db, pastaId);
  const alreadyGone = throwText(() =>
    deleteRecord.execute(db, { domain: 'meals', id: pastaId }, goneCtx)
  );
  alreadyGone && /No meal with id/.test(alreadyGone)
    ? ok('…and a row already deleted on its screen refuses rather than claiming the removal')
    : bad('gone staleness', String(alreadyGone));

  // --- A PROTOCOL: the card says what goes AND what stays ---------------------
  createProtocolWithVersion(
    db,
    { name: 'Evening Stack', type: 'supplement_stack' },
    { items: [{ title: 'Magnesium', scheduled_time: '21:00', dose: '400 mg', notes: null }] },
    'seed'
  );
  const protocol = getProtocolBySlug(db, 'evening_stack');
  addVersion(
    db,
    protocol.id,
    { items: [{ title: 'Magnesium', scheduled_time: '21:30', dose: '400 mg', notes: null }] },
    'later'
  );
  // Yesterday was lived under it: a logged entry the deletion must not take.
  raw.prepare(`INSERT INTO daily_logs (id, date) VALUES ('dl-p', ?)`).run(shiftISODate(TODAY, -1));
  raw
    .prepare(
      `INSERT INTO log_entries (id, daily_log_id, type, protocol_id, title)
       VALUES ('le-p', 'dl-p', 'supplement', ?, 'Magnesium')`
    )
    .run(protocol.id);
  const protocolCard = del('protocols', 'evening_stack');
  protocolCard ===
  'Delete protocol "Evening Stack" — active, 1 item; its 2 versions go with it, ' +
    'and logged days keep their entries, unlinked'
    ? ok(`a protocol is deletable now, on a card that names its versions ("${protocolCard}")`)
    : bad('protocol card', protocolCard);
  approve('protocols', 'evening_stack');
  const entry = raw.prepare(`SELECT protocol_id FROM log_entries WHERE id = 'le-p'`).get();
  getProtocolBySlug(db, 'evening_stack') === undefined &&
  count('SELECT count(*) n FROM protocol_versions WHERE protocol_id = ?', [protocol.id]) === 0 &&
  entry !== undefined &&
  entry.protocol_id === null
    ? ok(
        '…and approving it takes the protocol and its versions while yesterday’s entry stays, unlinked'
      )
    : bad('protocol delete', JSON.stringify(entry));

  // --- EVERY REMOVABLE DOMAIN DRAWS A REAL CARD AND REALLY REMOVES -----------
  // One seeded row per remaining domain: the card names something after the
  // row's name, approving it runs the screen's own delete, and the card cannot
  // be drawn a second time because the row is gone.
  const bench = raw.prepare(`SELECT id FROM exercises WHERE name = 'Barbell Bench Press'`).get();
  const seeded = {
    food_catalog: createFood(db, { name: 'Oats', kcal_100g: 379, protein_g_100g: 13 }),
    meal_templates: createTemplate(db, {
      name: 'Protein Oats',
      items: [{ name: 'Oats', kcal: 190, protein_g: 7 }],
    }),
    saved_workouts: createRoutine(db, {
      name: 'Upper A',
      notes: null,
      exercises: [{ exerciseId: bench.id, targetSets: 4, repLow: 5, repHigh: 8, restSec: 180 }],
    }),
    recipes: createRecipe(db, {
      title: 'Adobo',
      servings: 4,
      ingredients: [{ raw_text: '1 kg chicken thighs' }, { raw_text: 'salt to taste' }],
    }),
    grocery: addGroceryItems(db, [{ name: 'Milk', qty_text: '2 L' }])[0],
    screenings: addScreening(db, {
      name: 'Colonoscopy',
      category: 'imaging',
      intervalMonths: 120,
      lastCompleted: '2016-01-01',
    }),
    appointments: addAppointment(db, {
      title: 'Annual physical',
      provider: 'Dr Reyes',
      scheduledAt: '2026-10-01T16:00:00.000Z',
    }),
    muscle_anchors: (setMuscleAnchor(db, 'chest', 70), 'chest'),
  };
  const EXPECT = {
    food_catalog: 'Delete catalog food "Oats" — per 100 g: 379 kcal · P 13g',
    meal_templates: 'Delete meal template "Protein Oats" — 1 item · 190 kcal · P 7g',
    saved_workouts: 'Delete saved workout "Upper A" — 4 sets of 1 exercise: Barbell Bench Press',
    recipes: 'Delete recipe "Adobo" — serves 4 · 2 ingredients',
    grocery: 'Delete grocery item "Milk" — 2 L · on the list',
    screenings:
      'Delete screening "Colonoscopy" — every 120 months · next due 2026-01-01 · ' +
      'last done 2016-01-01 · its appointments stay',
    appointments:
      `Delete appointment "Annual physical" — 2026-10-01 ${clockFromISO('2026-10-01T16:00:00.000Z')}` +
      ' · with Dr Reyes · scheduled',
    // Slop pass 4 (docs/ai-slop-candidates-2026-09.md §11.E): "the engine" is
    // the code's word for the training model, never the card reader's. The
    // app says "ARC's reading" for a derived value (the exercise screen's load
    // basis), and the exact match here fails if the old word comes back.
    muscle_anchors: 'Delete muscle anchor "chest" — freshness 70; ARC’s own reading returns',
  };
  const smoke = Object.entries(seeded).filter(([key, id]) => {
    const { line, result } = approve(key, id);
    return line !== EXPECT[key] || result.deleted !== true || !throws(() => del(key, id));
  });
  smoke.length === 0
    ? ok(
        `the other ${Object.keys(seeded).length} removable domains each draw their card and really remove`
      )
    : bad(
        'a removable domain drew the wrong card or did not remove',
        smoke
          .map(([key, id]) => `${key}: ${String(throwText(() => del(key, id)) ?? del(key, id))}`)
          .join(' | ')
      );
  // A clear of nothing is a knowable no-op, refused before the gate.
  const nothing = throwText(() => del('muscle_anchors', 'chest'));
  nothing && /nothing to clear/.test(nothing)
    ? ok('clearing an anchor that is not set is refused at card time')
    : bad('anchor no-op', String(nothing));
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

// THE REAL SERVICE SEAM, shared by §6 and §7: the Coach service with a stubbed
// fetch and database, so a turn runs the real card → gate → execute sequence.
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
        read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })),
      }),
    },
  };
};

console.log('6. staleness: the row moved while the card was open');
{
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

  // THE SAME GUARD ON A DELETE, through the same real seam. The meal was
  // logged by hand — the owner's case — and a figure the card printed moves
  // while the gate is up.
  const lunchId = logMeal(db, { date: TODAY, time: '12:30', name: 'Salmon bowl', kcal: 700 });
  const deleteTurn = () => [
    toolUseReply('delete_record', { domain: 'meals', id: lunchId }),
    textReply('Understood.'),
  ];
  let deleteReplies = deleteTurn();
  globalThis.__ARC_TEST_FETCH__ = async () => responseOf(deleteReplies.shift());
  await apiKeyStore.setKey('test-key');
  let deleteRequest = null;
  const staleDelete = await streamCoachReply(
    [{ id: 'u2', role: 'user', content: 'delete that lunch', createdAt: 0 }],
    {
      onToken: () => {},
      now: () => NOW,
      confirmWrite: async (request) => {
        deleteRequest = request;
        // The pending-estimate drain lands while the card is open.
        db.run('UPDATE meals SET kcal = 640 WHERE id = ?', [lunchId]);
        return true;
      },
    }
  );
  deleteRequest?.summary === `Delete meal "Salmon bowl" — ${TODAY} 12:30 · 700 kcal` &&
  deleteRequest.kind === 'delete' &&
  deleteRequest.selfEvident === false
    ? ok('a delete reaches the real gate naming the day and the figure, on the long card')
    : bad('delete gate request', JSON.stringify(deleteRequest));
  const staleCall = staleDelete.toolCalls[0];
  staleCall.isError === true &&
  /changed while the card was open/.test(staleCall.result) &&
  /Nothing deleted/.test(staleCall.result) &&
  staleCall.receipt === undefined &&
  getMeal(db, lunchId)?.kcal === 640
    ? ok('…and the figure moving inside the gate refused it: no receipt, the meal still there')
    : bad('stale delete', JSON.stringify(staleCall));

  // NEVER AUTO-APPROVED. A seam with no gate declines every write, deletes
  // included — there is no path where a removal runs unanswered.
  deleteReplies = deleteTurn();
  const ungated = await streamCoachReply(
    [{ id: 'u3', role: 'user', content: 'delete that lunch', createdAt: 0 }],
    { onToken: () => {}, now: () => NOW }
  );
  await apiKeyStore.clearKey();
  ungated.toolCalls[0]?.declined === true && getMeal(db, lunchId) !== undefined
    ? ok('with no gate to answer it, a delete is declined and the meal stays')
    : bad('an ungated delete ran', JSON.stringify(ungated.toolCalls[0]));
}

console.log("water parity: the Coach edits and deletes through the screen's Health-aware functions");
{
  // Two-way water (2026-09-23) moved the water screen's edit and delete, and
  // the Log tab's Undo, onto editWaterCapture / removeWaterCapture so a change
  // reaches Apple Health. The parity rule (docs/coach-domains.md) says the
  // Coach calls what the screen calls — a bare repository call would leave the
  // old glass in the Health app behind a card that said it was gone.
  const src = readFileSync(
    new URL('../src/lib/ai/domains/read-domains.ts', import.meta.url),
    'utf8'
  );
  src.includes('removeWaterCapture(db, row.id)') && src.includes('editWaterCapture(db, row.id,')
    ? ok('the water domain deletes and edits through the Health-aware functions')
    : bad('the water domain does not call removeWaterCapture / editWaterCapture');
  !/\b(deleteWaterEntry|updateWaterEntry)\(/.test(src)
    ? ok('…and never calls the bare repository write that skips Apple Health')
    : bad('the water domain still calls a bare repository write');
}

// ---------------------------------------------------------------------------
// 7. The owner's parity answers (2026-09-25). Each new act is proved three
// ways: the card as drawn from real rows, the approved write through the
// function the screen calls, and the REAL service seam — a row that moves
// while the card is open refuses, and a declined card writes nothing.
console.log('7. 2026-09-25 — memories, knowledge, captures, a load basis and a combine');
{
  const deleteRecord = toolByName('delete_record');
  /** Card, then execute, on ONE context: the service's own sequence. */
  const approveDelete = (db, domain, id) => {
    const context = { now: NOW };
    const line = deleteRecord.confirmSummary({ domain, id }, db, context);
    return { line, result: JSON.parse(deleteRecord.execute(db, { domain, id }, context)) };
  };
  const approveEdit = (db, domain, id, fields) => {
    const context = { now: NOW };
    const line = editRecord.confirmSummary({ domain, id, fields }, db, context);
    return { line, result: JSON.parse(editRecord.execute(db, { domain, id, fields }, context)) };
  };
  /**
   * One Coach turn through `streamCoachReply`: the model proposes `input` to
   * `name`, and `gate` answers the card — mutating the database first when the
   * test is about a row that moved.
   */
  const serviceTurn = async (db, name, input, gate) => {
    globalThis.__ARC_TEST_DB__ = db;
    const replies = [toolUseReply(name, input), textReply('Understood.')];
    globalThis.__ARC_TEST_FETCH__ = async () => responseOf(replies.shift());
    await apiKeyStore.setKey('test-key');
    let request = null;
    const result = await streamCoachReply(
      [{ id: 'u7', role: 'user', content: 'go ahead', createdAt: 0 }],
      {
        onToken: () => {},
        now: () => NOW,
        confirmWrite: async (req) => {
          request = req;
          return gate(req);
        },
      }
    );
    await apiKeyStore.clearKey();
    return { request, call: result.toolCalls[0] };
  };
  const refusedStale = (call, verb) =>
    call?.isError === true &&
    /changed while the card was open/.test(call.result) &&
    new RegExp(`Nothing ${verb}`).test(call.result) &&
    call.receipt === undefined;
  const declined = (call) => call?.declined === true && call.receipt === undefined;

  // --- 7a. A MEMORY, deleted through the memory screen's own function --------
  {
    const { db } = freshDb();
    const id = rememberFact(db, {
      content: 'Magnesium citrate upsets his stomach',
      category: 'constraint',
    });
    const saved = formatLocalDate(new Date(getMemory(db, id).created_at));
    const line = deleteRecord.confirmSummary({ domain: 'memories', id }, db, { now: NOW });
    line === `Delete memory "Magnesium citrate upsets his stomach" — constraint · saved ${saved}`
      ? ok(`a memory's card names what it says, its kind and the day it was saved ("${line}")`)
      : bad('memory card', line);
    forgetMemory(db, id);
    /· forgotten \d{4}-\d{2}-\d{2}$/.test(
      deleteRecord.confirmSummary({ domain: 'memories', id }, db, { now: NOW })
    )
      ? ok('…and a forgotten one says it was already forgotten, and when')
      : bad('forgotten memory card');
    approveDelete(db, 'memories', id);
    getMemory(db, id) === undefined
      ? ok('…and approving it removes the row, through deleteMemory')
      : bad('memory not removed');

    const moving = rememberFact(db, { content: 'Trains fasted before 9am', category: 'context' });
    const stale = await serviceTurn(db, 'delete_record', { domain: 'memories', id: moving }, () => {
      forgetMemory(db, moving); // forgotten on its own screen while the card was up
      return true;
    });
    stale.request?.kind === 'delete' &&
    refusedStale(stale.call, 'deleted') &&
    getMemory(db, moving) !== undefined
      ? ok('a memory forgotten while the card was open refuses the delete — the row stays')
      : bad('memory staleness', JSON.stringify(stale.call));
    const kept = rememberFact(db, { content: 'Prefers morning training', category: 'preference' });
    const no = await serviceTurn(
      db,
      'delete_record',
      { domain: 'memories', id: kept },
      () => false
    );
    declined(no.call) && getMemory(db, kept) !== undefined
      ? ok('…and a declined card deletes nothing')
      : bad('declined memory delete', JSON.stringify(no.call));
  }

  // --- 7b. A KNOWLEDGE ENTRY, and its chunks ---------------------------------
  {
    const { db } = freshDb();
    const id = saveKnowledgeEntry(db, {
      title: 'Zone 2 three times a week',
      topic: 'training',
      section: 'scientific',
      body: 'Three ninety-minute sessions a week, at a pace you can still hold a conversation at, for mitochondrial density.',
    });
    const packId = insertKnowledgeChunk(db, {
      source: 'arc-longevity-v1',
      title: 'ApoB',
      body: 'ApoB counts atherogenic particles.',
      section: null,
      entryId: null,
    });
    const saved = formatLocalDate(new Date(getKnowledgeEntry(db, id).created_at));
    // PARITY, both acts: the screen deletes from the Archived list only, so an
    // entry still in every search refuses at CARD time and names the archive.
    const active = throwText(() =>
      deleteRecord.confirmSummary({ domain: 'knowledge', id }, db, { now: NOW })
    );
    active !== null &&
    /still in every search/.test(active) &&
    /status: "archived"/.test(active) &&
    active.includes(id) &&
    /Nothing deleted/.test(active) &&
    getKnowledgeEntry(db, id) !== undefined
      ? ok(
          'an ACTIVE knowledge entry refuses at card time and names the archive — as its screen does'
        )
      : bad('active knowledge entry', String(active));
    const activeTurn = await serviceTurn(db, 'delete_record', { domain: 'knowledge', id }, () => {
      throw new Error('no card should be drawn for an active entry');
    });
    activeTurn.request === null &&
    activeTurn.call?.isError === true &&
    getKnowledgeEntry(db, id) !== undefined
      ? ok('…through the service too: no card is drawn, and the entry stays')
      : bad('active knowledge service', JSON.stringify(activeTurn));

    archiveKnowledgeEntry(db, id);
    const archivedOn = formatLocalDate(new Date(getKnowledgeEntry(db, id).archived_at));
    const line = deleteRecord.confirmSummary({ domain: 'knowledge', id }, db, { now: NOW });
    line ===
    `Delete knowledge entry "Zone 2 three times a week" — scientific · training · saved ${saved} · ` +
      `archived ${archivedOn} · "Three ninety-minute sessions a week, at a pace you can still…"`
      ? ok(`an archived entry's card names its section, topic, both days and its opening words`)
      : bad('knowledge card', line);
    approveDelete(db, 'knowledge', id);
    const chunks = db.get('SELECT count(*) n FROM knowledge_chunks WHERE entry_id = ?', [id]).n;
    getKnowledgeEntry(db, id) === undefined &&
    chunks === 0 &&
    db.get('SELECT count(*) n FROM knowledge_chunks WHERE id = ?', [packId]).n === 1
      ? ok('…and approving it removes the entry, and never the shipped pack')
      : bad('knowledge not removed', String(chunks));

    const moving = saveKnowledgeEntry(db, { title: 'Sauna', topic: 'heat', body: 'Four rounds.' });
    archiveKnowledgeEntry(db, moving);
    const stale = await serviceTurn(
      db,
      'delete_record',
      { domain: 'knowledge', id: moving },
      () => {
        updateKnowledgeEntry(db, moving, { body: 'Five rounds, then a cold plunge.' });
        return true;
      }
    );
    stale.request?.kind === 'delete' &&
    refusedStale(stale.call, 'deleted') &&
    getKnowledgeEntry(db, moving) !== undefined
      ? ok('an archived entry rewritten while the card was open refuses the delete')
      : bad('knowledge staleness', JSON.stringify(stale.call));
    const restored = await serviceTurn(
      db,
      'delete_record',
      { domain: 'knowledge', id: moving },
      () => {
        restoreKnowledgeEntry(db, moving); // back in every search on its own screen
        return true;
      }
    );
    restored.request?.kind === 'delete' &&
    restored.call?.isError === true &&
    /still in every search/.test(restored.call.result) &&
    /Nothing deleted/.test(restored.call.result) &&
    restored.call.receipt === undefined &&
    getKnowledgeEntry(db, moving) !== undefined
      ? ok('…and one restored while the card was open refuses, because it is active again')
      : bad('knowledge restored mid-card', JSON.stringify(restored.call));
    archiveKnowledgeEntry(db, moving);
    const no = await serviceTurn(
      db,
      'delete_record',
      { domain: 'knowledge', id: moving },
      () => false
    );
    declined(no.call) && getKnowledgeEntry(db, moving) !== undefined
      ? ok('…and a declined card deletes nothing')
      : bad('declined knowledge delete', JSON.stringify(no.call));
  }

  // --- 7c. A CAPTURE from the Log tab, through the Log tab's own removal -----
  {
    const { db } = freshDb();
    const query = (args) => JSON.parse(queryRecords.execute(db, args, { now: NOW }));
    logCapture(db, TODAY, 'supplement', 'Creatine · 5 g');
    logNote(db, TODAY, 'Slept badly, 3am wake');
    logMetric(db, TODAY, 'weight', 80);
    const rows = query({ domain: 'captures', limit: 25 }).rows;
    const creatine = rows.find((r) => r.title === 'Creatine · 5 g');
    const weight = rows.find((r) => r.category === 'Weight');
    const line = deleteRecord.confirmSummary({ domain: 'captures', id: creatine.id }, db, {
      now: NOW,
    });
    line === `Delete logged entry "Creatine · 5 g" — ${TODAY} ${creatine.time} · Supplements`
      ? ok(`a capture's card names the day, the time and what it was ("${line}")`)
      : bad('capture card', line);
    const meta = deleteRecord.confirmMeta({ domain: 'captures', id: creatine.id }, db, {
      now: NOW,
    });
    meta.kind === 'delete' && meta.selfEvident === false
      ? ok('…on the long delete card')
      : bad('capture meta', JSON.stringify(meta));
    approveDelete(db, 'captures', creatine.id);
    !listEntriesOn(db, TODAY).some((e) => e.id === creatine.id)
      ? ok('…and approving it takes the row off the Log tab')
      : bad('capture not removed');

    // A published kind says its Apple Health copy goes too — only while sync
    // is on, because with it off ARC touches nothing in Health.
    const weightLine = deleteRecord.confirmSummary({ domain: 'captures', id: weight.id }, db, {
      now: NOW,
    });
    setHealthSyncEnabled(db, true);
    const syncedLine = deleteRecord.confirmSummary({ domain: 'captures', id: weight.id }, db, {
      now: NOW,
    });
    setHealthSyncEnabled(db, false);
    !/Apple Health/.test(weightLine) &&
    syncedLine === `${weightLine} · and any copy in Apple Health`
      ? ok('a weight names its Apple Health copy on the card, only while sync is on')
      : bad('weight health line', `${weightLine} | ${syncedLine}`);

    // MOVED: the unit changes while the card is open, so the line the card
    // printed ("176.4 lb") is not the line the row reads now.
    const stale = await serviceTurn(
      db,
      'delete_record',
      { domain: 'captures', id: weight.id },
      () => {
        setUnitPreference(db, 'weight', 'kg');
        return true;
      }
    );
    refusedStale(stale.call, 'deleted') && listEntriesOn(db, TODAY).some((e) => e.id === weight.id)
      ? ok('a capture whose line moved while the card was open refuses the delete')
      : bad('capture staleness', JSON.stringify(stale.call));
    // GONE: removed on the Log tab while the card was open.
    const note = rows.find((r) => r.category === 'Note');
    const gone = await serviceTurn(db, 'delete_record', { domain: 'captures', id: note.id }, () => {
      removeLogCapture(db, note.id);
      return true;
    });
    gone.call?.isError === true && /No logged entry with id/.test(gone.call.result)
      ? ok('…and one already removed by hand refuses rather than claiming the removal')
      : bad('capture gone staleness', JSON.stringify(gone.call));
    const no = await serviceTurn(
      db,
      'delete_record',
      { domain: 'captures', id: weight.id },
      () => false
    );
    declined(no.call) && listEntriesOn(db, TODAY).some((e) => e.id === weight.id)
      ? ok('…and a declined card deletes nothing')
      : bad('declined capture delete', JSON.stringify(no.call));

    // The Coach calls what the Log tab calls — the Health-aware removal, never
    // a bare DELETE (a weight's sample would stay in Apple Health).
    const src = readFileSync(
      new URL('../src/lib/ai/domains/read-domains.ts', import.meta.url),
      'utf8'
    );
    const tab = readFileSync(new URL('../src/lib/log/capture-undo.ts', import.meta.url), 'utf8');
    src.includes('removeLogCapture(db, row.id)') && tab.includes('removeLogCapture(db, feedId)')
      ? ok('the captures domain and the Log tab remove through the one function, removeLogCapture')
      : bad('captures parity');
  }

  // --- 7d. A LOAD BASIS, corrected through the chooser's own function --------
  {
    const { db } = freshDb();
    const line = card(db, 'exercise_catalog', 'leg-press', { loadBasis: 'per_side' });
    line ===
    'Change what the weight on "Leg Press" counts: on the stack → per side. ' +
      'Changing it relabels every set already logged. No number changes.'
      ? ok(`the load-basis card says old → new in words, and the chooser's consequence ("${line}")`)
      : bad('load basis card', line);
    meta(db, 'exercise_catalog', 'leg-press', { loadBasis: 'per_side' }).kind === 'edit'
      ? ok('…on an edit card, not a status change')
      : bad('load basis meta');
    const noLoad = throwText(() => card(db, 'exercise_catalog', 'plank', { loadBasis: 'total' }));
    const same = throwText(() => card(db, 'exercise_catalog', 'leg-press', { loadBasis: 'stack' }));
    const both = throwText(() =>
      card(db, 'exercise_catalog', 'leg-press', { loadBasis: 'total', status: 'archived' })
    );
    const bogus = throwText(() => card(db, 'exercise_catalog', 'leg-press', { loadBasis: 'kg' }));
    /records no weight/.test(noLoad ?? '') &&
    /Nothing would change/.test(same ?? '') &&
    /two cards/.test(both ?? '') &&
    /must be one of: total, per_hand, per_side, stack, bodyweight_plus, assisted/.test(bogus ?? '')
      ? ok('a plank, a no-op, a retire-and-relabel and an unknown basis are refused at card time')
      : bad('load basis refusals', [noLoad, same, both, bogus].join(' | '));
    approveEdit(db, 'exercise_catalog', 'leg-press', { loadBasis: 'per_side' });
    const pressed = getExercise(db, 'leg-press');
    pressed.loadBasis === 'per_side' && pressed.loadBasisSetByOwner === true
      ? ok(
          '…and approving it sets the basis through setExerciseLoadBasis, as the owner’s correction'
        )
      : bad('load basis not set', JSON.stringify(pressed));

    const moved = await serviceTurn(
      db,
      'edit_record',
      { domain: 'exercise_catalog', id: 'dumbbell-bench-press', fields: { loadBasis: 'total' } },
      () => {
        setExerciseLoadBasis(db, 'dumbbell-bench-press', 'per_side'); // changed on its screen
        return true;
      }
    );
    refusedStale(moved.call, 'written') &&
    moved.call.result.startsWith(
      'loadBasis changed while the card was open (was per_hand, now per_side)'
    ) &&
    getExercise(db, 'dumbbell-bench-press').loadBasis === 'per_side'
      ? ok('a basis changed on its screen while the card was open refuses the Coach’s')
      : bad('load basis staleness', JSON.stringify(moved.call));
    const no = await serviceTurn(
      db,
      'edit_record',
      { domain: 'exercise_catalog', id: 'barbell-bench-press', fields: { loadBasis: 'per_side' } },
      () => false
    );
    declined(no.call) && getExercise(db, 'barbell-bench-press').loadBasis === 'total'
      ? ok('…and a declined card writes nothing')
      : bad('declined load basis', JSON.stringify(no.call));
  }

  // --- 7e. A COMBINE, through the Eat tab's own function ---------------------
  {
    const { db } = freshDb();
    const { mealId: porridge } = logMealWithItems(db, {
      date: TODAY,
      time: '07:40',
      name: 'Porridge',
      items: [{ name: 'Oats', amount: 60, kcal: 228, protein_g: 8 }],
    });
    const coffee = logMeal(db, { date: TODAY, time: '07:55', name: 'Coffee', kcal: 40 });
    // The model names the LATER meal and folds the earlier into it: the plan
    // still keeps the earliest, as the Eat tab's does.
    const fields = { combine_with: [porridge], name: 'Breakfast' };
    const line = card(db, 'meals', coffee, fields);
    line ===
    `Combine 2 meals on ${TODAY} into "Breakfast" — 07:40 Porridge, 228 kcal; 07:55 Coffee, 40 kcal. ` +
      'One meal at 07:40, 268 kcal, so the day’s total does not change; their items and photos ' +
      'move into it and the other meals are deleted. There is no undo.'
      ? ok(
          `a combine card lists the meals, their times and the combined name, and says the ` +
            `Coach's combine has no undo, unlike the Eat tab's ("${line}")`
        )
      : bad('combine card', line);
    const lone = throwText(() => card(db, 'meals', coffee, { combine_with: [coffee] }));
    const extra = throwText(() =>
      card(db, 'meals', coffee, { combine_with: [porridge], time: '08:00' })
    );
    const yesterday = logMeal(db, {
      date: shiftISODate(TODAY, -1),
      time: '20:00',
      name: 'Tapas',
      kcal: 480,
    });
    const crossDay = throwText(() => card(db, 'meals', coffee, { combine_with: [yesterday] }));
    /OTHER meal/.test(lone ?? '') &&
    /takes "name" and nothing else/.test(extra ?? '') &&
    crossDay === 'These were logged on different days, and a meal belongs to one day.'
      ? ok(
          'a combine of one meal, one with a rename riding along, and one across days are refused at card time'
        )
      : bad('combine refusals', [lone, extra, crossDay].join(' | '));

    const { result } = approveEdit(db, 'meals', coffee, fields);
    const kept = getMeal(db, porridge);
    result.combined?.keptId === porridge &&
    getMeal(db, coffee) === undefined &&
    kept.name === 'Breakfast' &&
    kept.kcal === 268 &&
    listMealItems(db, porridge).some((i) => i.name === 'Coffee (as logged)')
      ? ok(
          '…and approving it combines them with combineMeals — the earliest survives, the result names it'
        )
      : bad('combine', JSON.stringify({ result, kept }));

    // MOVED: the OTHER meal is re-portioned while the card is open. Nothing
    // about the row being edited changed, so only the redrawn line can see it.
    const lunch = logMeal(db, { date: TODAY, time: '12:30', name: 'Salad', kcal: 400 });
    const soup = logMeal(db, { date: TODAY, time: '12:45', name: 'Soup', kcal: 150 });
    const stale = await serviceTurn(
      db,
      'edit_record',
      { domain: 'meals', id: lunch, fields: { combine_with: [soup] } },
      () => {
        db.run('UPDATE meals SET kcal = 210 WHERE id = ?', [soup]);
        return true;
      }
    );
    stale.request?.kind === 'edit' &&
    refusedStale(stale.call, 'written') &&
    stale.call.result.includes('12:45 Soup, 150 kcal') &&
    stale.call.result.includes('12:45 Soup, 210 kcal') &&
    getMeal(db, lunch) !== undefined &&
    getMeal(db, soup) !== undefined
      ? ok('a meal that moved while the combine card was open refuses it, quoting both lines')
      : bad('combine staleness', JSON.stringify(stale.call));
    const no = await serviceTurn(
      db,
      'edit_record',
      { domain: 'meals', id: lunch, fields: { combine_with: [soup] } },
      () => false
    );
    declined(no.call) && getMeal(db, lunch) !== undefined && getMeal(db, soup) !== undefined
      ? ok('…and a declined card combines nothing')
      : bad('declined combine', JSON.stringify(no.call));
    /combine_with/.test(
      JSON.stringify(JSON.parse(queryRecords.execute(db, { domain: 'meals' }, { now: NOW })).fields)
    )
      ? ok('combine_with is on the meals discovery call, where field vocabulary lives')
      : bad('combine vocabulary');
  }

  // --- 7f. A CATALOG FOOD: the card says what the screen says ----------------
  {
    const { db } = freshDb();
    const oats = createFood(db, { name: 'Oats', kcal_100g: 379, protein_g_100g: 13 });
    logMealWithItems(db, {
      date: TODAY,
      time: '07:40',
      name: 'Porridge',
      items: [{ name: 'Oats', food_id: oats, amount: 60, kcal: 228, protein_g: 8 }],
    });
    const line = deleteRecord.confirmSummary({ domain: 'food_catalog', id: oats }, db, {
      now: NOW,
    });
    line ===
    'Delete catalog food "Oats" — per 100 g: 379 kcal · P 13g; used by 1 meal, which keeps its own numbers'
      ? ok(`a used food's card says what keeps its numbers, as Add food's line does ("${line}")`)
      : bad('food usage card', line);
    // An item counted in the food's serving reads its noun through a live join,
    // so the card says that item will show its amount without the count.
    const eggs = createFood(db, {
      name: 'Eggs',
      serving_name: '1 egg',
      serving_amount: 50,
      kcal_100g: 143,
    });
    logMealWithItems(db, {
      date: TODAY,
      time: '09:00',
      name: 'Fry-up',
      items: [{ name: 'Eggs', food_id: eggs, amount: 100, serving_qty: 2, kcal: 143 }],
    });
    const eggLine = deleteRecord.confirmSummary({ domain: 'food_catalog', id: eggs }, db, {
      now: NOW,
    });
    eggLine.endsWith(
      '; used by 1 meal, which keeps its own numbers; 1 item counted in its serving will show ' +
        'its amount without the count'
    )
      ? ok(
          `…and a food counted by its serving says the count leaves that item's label ("${eggLine}")`
        )
      : bad('counted food card', eggLine);
    const tab = readFileSync(new URL('../app/food-search.tsx', import.meta.url), 'utf8');
    const offers = readFileSync(
      new URL('../src/lib/nutrition/undo-offers.ts', import.meta.url),
      'utf8'
    );
    const foods = readFileSync(
      new URL('../src/lib/db/repositories/foods.ts', import.meta.url),
      'utf8'
    );
    tab.includes('deleteFoodWithUndo(getDb(), food.id)') &&
    offers.includes('takeFood(db, foodId)') &&
    /export function takeFood[\s\S]*?deleteFood\(db, id\)/.test(foods)
      ? ok('parity both ways: Add food deletes through takeFood → deleteFood, the Coach’s function')
      : bad('food parity');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
