/**
 * The GENERIC tools over the domain registry — `query_records`, `edit_record`
 * and `delete_record` (docs/coach-domains.md;
 * docs/spikes/coach-whole-app-access.md §3.3).
 *
 * The model never sees SQL and never sees a table here. It sees a DOMAIN with
 * fields, and the code behind each is the repository function the matching
 * screen calls — so the day boundary, unit conversion, tombstones, provenance
 * and every CHECK are inherited rather than re-implemented. Whatever the
 * repository refuses, the tool refuses.
 *
 * ## `fields` is the registry's first open schema, and that is deliberate
 *
 * Every other `inputSchema` in this directory ends `additionalProperties:
 * false`. The outer object here keeps it; `fields` alone is a bare
 * `{ type: 'object' }`, because the alternative is 26 domains × ~25 tokens of
 * field vocabulary in a cached prefix with single-digit headroom. The model
 * learns the vocabulary three cheaper ways: from this tool's own description
 * (one field and its values per domain), from `query_records` called with no
 * filter (which returns each domain's `fields`), and from the unknown-field
 * error, which NAMES the set it should have chosen from.
 *
 * ## Prefer the specific tool — enforced here, not only asked for
 *
 * A domain whose create has a bespoke tool declares `createVia`, and
 * `edit_record` without an `id` refuses NAMING that tool. The doctrine bullet
 * in the system prompt is the model's copy of the rule; this parser is the
 * rule.
 */
import type { Database } from '@/lib/db/database';

// Explicit `/index` (not the directory), the convention this whole layer
// follows: db/*.test.mjs imports these modules through Node's ESM resolver,
// which has no bundler directory resolution.
import {
  domainByKey,
  domainSelfEvident,
  domainVocabulary,
  describeDelete,
  EDIT_DOMAIN_KEYS,
  QUERY_DOMAIN_KEYS,
  REMOVABLE_DOMAIN_KEYS,
  type CoachDomainEntry,
  type DomainRow,
} from '../domains/index';
import {
  asRecord,
  optDate,
  optNumber,
  optString,
  reqString,
  type CoachTool,
  type CoachToolContext,
  type WriteKind,
} from './types';

const json = (value: unknown): string => JSON.stringify(value);

/** One `edit_record` call, validated. Built identically at card time and at execute. */
type EditPlan = {
  entry: CoachDomainEntry;
  row: DomainRow;
  patch: Record<string, unknown>;
  op: WriteKind;
};

/** A value as the staleness message prints it. */
function show(value: unknown): string {
  if (value === null || value === undefined) return 'nothing';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * Validate a call into a plan, resolving the id to a real row.
 *
 * Called TWICE per write — once to build the card, once inside `execute` — and
 * that repetition is the point: the second call is the staleness RE-READ.
 */
function planEdit(
  db: Database,
  input: Record<string, unknown>,
  context: CoachToolContext
): EditPlan {
  const args = asRecord(input);
  const key = reqString(args, 'domain');
  const entry = domainByKey(key);
  if (!entry || (entry.edit === undefined && entry.create === undefined)) {
    throw new Error(`"domain" must be one of: ${EDIT_DOMAIN_KEYS.join(', ')}.`);
  }

  const raw = args['fields'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('"fields" must be an object of the fields to change.');
  }
  const fields = raw as Record<string, unknown>;
  const names = Object.keys(fields);
  if (names.length === 0) {
    throw new Error('"fields" must name at least one field to change.');
  }

  const patch: Record<string, unknown> = {};
  for (const name of names) {
    const field = entry.fields[name];
    if (!field) {
      throw new Error(
        `"${name}" is not a field of ${entry.label}. Its fields are: ` +
          `${Object.keys(entry.fields).join(', ')}.`
      );
    }
    if (!field.editable) {
      throw new Error(`"${name}" is not editable on a ${entry.label}.`);
    }
    patch[name] = field.parse(fields, name, context);
  }

  // `resolve`, `edit` and `summarize` travel together — a domain with one has
  // all three, asserted in db/coach-domains.test.mjs §0. The guard is here so
  // the types stay honest for the read-only domains that have none of them.
  if (!entry.resolve || !entry.edit || !entry.summarize) {
    throw new Error(`${entry.label} is read-only.`);
  }
  const id = reqString(args, 'id');
  const row = entry.resolve(db, id, context);
  // A patch that touches `status` is a STATUS change on the card, which is the
  // one kind whose summary can be the whole consequence.
  return { entry, row, patch, op: 'status' in patch ? 'status' : 'edit' };
}

/** The values the card printed as "was", for the staleness re-read. */
function printedBefore(plan: EditPlan): Record<string, unknown> {
  const before: Record<string, unknown> = {};
  for (const name of Object.keys(plan.patch)) {
    if (name in plan.row.values) before[name] = plan.row.values[name];
  }
  return before;
}

const editRecordTool: CoachTool = {
  name: 'edit_record',
  description:
    // The per-domain FIELD vocabulary is not here: 26 domains of field names
    // would be ~650 tokens of cached prefix, and `query_records` returns them
    // warm. Only the STATUS vocabularies are, because they are the ones whose
    // value set cannot be guessed from the field name — and, since 2026-09-25,
    // the one act that is not a change to ONE row: a combine (`combine_with`),
    // which no model would guess is an edit at all. A planned nudge's
    // `cancelled` joined them the same day (+7): its domain is read by
    // list_reminders, so no discovery call would ever teach it.
    'Change ONE existing row: send only the fields that change, and the card shows each as ' +
    'before → after. Statuses: reminders done (one-offs only) | dismissed; nudges cancelled; ' +
    'experiments concluded (with `conclusion`) | abandoned (with `reason`); memories, ' +
    'knowledge and a custom exercise archived. Meals: `combine_with` [ids] combines those ' +
    'meals with this one. ' +
    'For any other domain call query_records with the domain alone ' +
    'to learn its fields. Get the id from the matching read. Prefer a specific tool where one ' +
    'exists.',
  inputSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string', enum: [...EDIT_DOMAIN_KEYS] },
      id: { type: 'string' },
      fields: { type: 'object' },
    },
    required: ['domain', 'id', 'fields'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input, db, context) => {
    const plan = planEdit(db, input, context);
    const line = plan.entry.summarize!({
      db,
      op: plan.op,
      row: plan.row,
      patch: plan.patch,
      context,
    });
    // THE STALENESS SLOT, written here and read past the gate. See
    // CoachToolContext.card — the service layer hands `execute` this same
    // object, which is the only reason this works. The whole printed line rides
    // with the values since 2026-09-25, as it does on `delete_record`: a
    // combine's card prints four meals' times and figures, none of which is a
    // value of the row being edited.
    context.card = {
      domain: plan.entry.key,
      id: plan.row.id,
      before: printedBefore(plan),
      line,
    };
    return line;
  },
  confirmMeta: (input, db, context) => {
    const plan = planEdit(db, input, context);
    return {
      kind: plan.op,
      selfEvident: domainSelfEvident(plan.entry, {
        db,
        op: plan.op,
        row: plan.row,
        patch: plan.patch,
        context,
      }),
    };
  },
  execute: (db, input, context) => {
    // The RE-READ. `planEdit` resolves the row from the database again, so
    // everything below is judged against the row as it is NOW, not as it was
    // when the card was drawn.
    const plan = planEdit(db, input, context);
    const card = context.card;
    if (card && card.domain === plan.entry.key && card.id === plan.row.id) {
      for (const [name, was] of Object.entries(card.before)) {
        const now = plan.row.values[name];
        if (!Object.is(was, now)) {
          throw new Error(
            `${name} changed while the card was open (was ${show(was)}, now ${show(now)}). ` +
              'Nothing written. Read it again and propose once more.'
          );
        }
      }
      // …and the line itself, redrawn from the row as it is now. Only reached
      // when every value the card printed as "was" still holds, so the value's
      // own message wins wherever there is one.
      if (card.line !== undefined) {
        const line = plan.entry.summarize!({
          db,
          op: plan.op,
          row: plan.row,
          patch: plan.patch,
          context,
        });
        if (line !== card.line) {
          throw new Error(
            `That ${plan.entry.label} changed while the card was open (the card said ` +
              `"${card.line}", it now reads "${line}"). Nothing written. ` +
              'Read it again and propose once more.'
          );
        }
      }
    }
    const made = plan.entry.edit!(db, plan.row, plan.patch, context);
    return json({
      edited: true,
      domain: plan.entry.key,
      id: plan.row.id,
      title: plan.row.name,
      fields: Object.keys(plan.patch),
      ...(made ?? {}),
    });
  },
};

// --- query_records -----------------------------------------------------------

/** The read cap, matching the registry's other capped read (read-tools.ts). */
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

const queryRecordsTool: CoachTool = {
  name: 'query_records',
  description:
    // The enum below IS the list of domains, so naming them here again would be
    // the description-recites-its-own-schema class (db/coach-eval.test.mjs §6)
    // at 15 × ~5 tokens. What the description has to carry is what the enum
    // cannot: the filters, the cap, and the discovery call.
    'Read a domain the specific tools do not cover. Filter with "id", "query" or a from/to day ' +
    'window; 10 rows by default, 25 at most. The domain ALONE returns that domain’s fields and ' +
    'whether it can be written — ask once, then filter.',
  inputSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string', enum: [...QUERY_DOMAIN_KEYS] },
      id: { type: 'string' },
      query: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      limit: { type: 'number' },
    },
    required: ['domain'],
    additionalProperties: false,
  },
  readOnly: true,
  execute: (db, input, context) => {
    const args = asRecord(input);
    const key = reqString(args, 'domain');
    const entry = domainByKey(key);
    if (!entry) throw new Error(`"domain" must be one of: ${QUERY_DOMAIN_KEYS.join(', ')}.`);
    // A domain a registered tool already reads is not in the enum, and the
    // error NAMES that tool — one round trip, and the model learns the right
    // habit instead of the generic one.
    if (entry.read.kind === 'bespoke') {
      throw new Error(`${entry.label}s are read by ${entry.read.via}. Call that instead.`);
    }

    const id = optString(args, 'id');
    const query = optString(args, 'query');
    const from = optDate(args, 'from');
    const to = optDate(args, 'to');
    const rawLimit = optNumber(args, 'limit');
    if (rawLimit !== undefined && (!Number.isInteger(rawLimit) || rawLimit < 1)) {
      throw new Error('"limit" must be a positive integer.');
    }
    const limit = Math.min(rawLimit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const readArgs = { id, query, from, to, limit, now: context.now };

    // THE DISCOVERY CALL: domain alone. This is where the field vocabulary
    // lives instead of the cached prompt — one warm round trip on the turn it
    // is needed, never a permanent tax on every turn forever.
    const bare = id === undefined && query === undefined && from === undefined && to === undefined;
    const vocabulary = bare
      ? {
          fields: domainVocabulary(entry),
          editable: entry.edit !== undefined,
          ...(entry.createVia ? { createWith: entry.createVia } : {}),
          removable: entry.remove?.mode ?? 'no',
        }
      : {};

    if (entry.read.kind === 'compute') {
      if (id === undefined) {
        // Not a list, and saying so is the point: the model must not go looking
        // for "the third row" of a number.
        throw new Error(`${entry.label} is computed, not listed — pass "id": ${entry.read.needs}.`);
      }
      return json({ domain: key, ...vocabulary, result: entry.read.run(db, { ...readArgs, id }) });
    }

    // The cap is applied HERE as well as inside each domain's read. A domain
    // that folds several days together (meals, water, captures) can overshoot
    // its own slice, and "≤ limit" has to be a property of the tool rather than
    // a promise fourteen separate functions keep.
    const rows = entry.read.run(db, readArgs).slice(0, limit);
    return json({ domain: key, ...vocabulary, count: rows.length, rows });
  },
};

// --- delete_record -----------------------------------------------------------

/**
 * Removal is its own tool, over its own smaller enum.
 *
 * It is NOT a `status: 'deleted'` value on `edit_record`, and the reason is the
 * same one that kept `retire_knowledge_entry` separate from
 * `save_knowledge_entry`: a removal must never be a VALUE the model can set in
 * passing, alongside three other fields, on a card that opens with "Edit". Its
 * own tool means its own enum (so the schema refuses what no screen deletes at
 * zero round trips), its own chip, its own receipt verb, and a card whose fixed
 * consequence line says a row LEAVES the record rather than that one is written
 * to it.
 *
 * ## What it may remove: what a screen may remove (the owner, 2026-09-23)
 *
 * *"coach should actually be able to delete both. guardrails of needing
 * approval should be in place but the coach should just be intelligent enough
 * to only delete the right things when it is supposed to."* So the enum is
 * the `hard` domains, and each one's `run` is the delete its own screen calls —
 * a meal or a session the user logged by hand included. (The one exception is
 * declared where it lives, in src/lib/ai/domains/: progress photos and reports,
 * which an owner call holds below parity. Since 2026-09-25 parity holds both
 * ways for the catalog food — Add food deletes one too — and memories,
 * knowledge entries and the Log tab's captures are open.) There is no rule
 * here about WHICH rows or WHEN:
 * that is the model's judgment, and the user's Approve. What this file owns is
 * that the card is TRUE: it names the row's date and figures, it is drawn from
 * the row as it is now, and the re-read past the gate refuses a row that moved.
 */
function planDelete(db: Database, input: Record<string, unknown>, context: CoachToolContext) {
  const args = asRecord(input);
  const key = reqString(args, 'domain');
  const entry = domainByKey(key);
  if (!entry || !entry.remove || entry.remove.mode === 'refuse' || !entry.resolve) {
    // The refusal NAMES where the row lives, so the answer is useful rather
    // than merely a no.
    if (entry?.remove?.mode === 'refuse') throw new Error(entry.remove.because);
    throw new Error(`"domain" must be one of: ${REMOVABLE_DOMAIN_KEYS.join(', ')}.`);
  }
  const remove = entry.remove;
  const row = entry.resolve(db, reqString(args, 'id'), context);
  // Built from the row as it is NOW, so the same call is the card at card time
  // and the re-read past the gate.
  const line = describeDelete(entry.label, row, remove.gone(db, row));
  return { entry, row, remove, line };
}

const deleteRecordTool: CoachTool = {
  name: 'delete_record',
  description:
    // What the tool DOES, never when to use it: WHEN is judgment (the owner's
    // 2026-09-23 call), and the enum already says WHERE.
    'Remove ONE row permanently, the same delete its own screen offers. The card shows the ' +
    'user its date, name and figures first. There is no undo.',
  inputSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string', enum: [...REMOVABLE_DOMAIN_KEYS] },
      id: { type: 'string' },
    },
    required: ['domain', 'id'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input, db, context) => {
    const plan = planDelete(db, input, context);
    // THE STALENESS SLOT, both halves: every value the row held, and the whole
    // line the card printed — its date and figures included.
    context.card = {
      domain: plan.entry.key,
      id: plan.row.id,
      before: { ...plan.row.values },
      line: plan.line,
    };
    return plan.line;
  },
  // Always the LONG card: a removal is never self-evident, and it is never
  // approved on anyone's behalf — one call, one row, one gate.
  confirmMeta: () => ({ kind: 'delete', selfEvident: false }),
  execute: (db, input, context) => {
    const plan = planDelete(db, input, context);
    // The same re-read `edit_record` does, plus the printed line. A row that
    // changed between the card and the approval is not the row the user agreed
    // to remove — least of all when what changed is a figure the card showed.
    const card = context.card;
    if (card && card.domain === plan.entry.key && card.id === plan.row.id) {
      for (const [name, was] of Object.entries(card.before)) {
        const now = plan.row.values[name];
        if (!Object.is(was, now)) {
          throw new Error(
            `${name} changed while the card was open (was ${show(was)}, now ${show(now)}). ` +
              'Nothing deleted. Read it again and propose once more.'
          );
        }
      }
      if (card.line !== undefined && card.line !== plan.line) {
        throw new Error(
          `That ${plan.entry.label} changed while the card was open (the card said ` +
            `"${card.line}", it now reads "${plan.line}"). Nothing deleted. ` +
            'Read it again and propose once more.'
        );
      }
    }
    plan.remove.run(db, plan.row, context);
    return json({ deleted: true, domain: plan.entry.key, id: plan.row.id, title: plan.row.name });
  },
};

export const RECORD_READ_TOOLS: CoachTool[] = [queryRecordsTool];
export const RECORD_WRITE_TOOLS: CoachTool[] = [editRecordTool, deleteRecordTool];
