/**
 * The GENERIC tools over the domain registry — `edit_record` today,
 * `query_records` and `delete_record` as the later phases land
 * (docs/coach-domains.md; docs/spikes/coach-whole-app-access.md §3.3).
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
  EDIT_DOMAIN_KEYS,
  type CoachDomainEntry,
  type DomainRow,
} from '../domains/index';
import {
  asRecord,
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

  const id = reqString(args, 'id');
  const row = entry.resolve(db, id, context);
  if (!entry.edit) {
    throw new Error(`${entry.label} cannot be edited.`);
  }
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
    'Change ONE existing row: send only the fields that change. Domains and their fields: ' +
    'reminders `status` done (one-offs only) | dismissed; experiments `status` concluded ' +
    '(with `conclusion`) | abandoned (with `reason`); memories and knowledge `status` archived. ' +
    'Get the id from the matching read tool. Prefer a specific tool where one exists.',
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
    const line = plan.entry.summarize({
      op: plan.op,
      row: plan.row,
      patch: plan.patch,
      context,
    });
    // THE STALENESS SLOT, written here and read past the gate. See
    // CoachToolContext.card — the service layer hands `execute` this same
    // object, which is the only reason this works.
    context.card = { domain: plan.entry.key, id: plan.row.id, before: printedBefore(plan) };
    return line;
  },
  confirmMeta: (input, db, context) => {
    const plan = planEdit(db, input, context);
    return {
      kind: plan.op,
      selfEvident: domainSelfEvident(plan.entry, {
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
    }
    plan.entry.edit!(db, plan.row, plan.patch, context);
    return json({
      edited: true,
      domain: plan.entry.key,
      id: plan.row.id,
      title: plan.row.name,
      fields: Object.keys(plan.patch),
    });
  },
};

export const RECORD_READ_TOOLS: CoachTool[] = [];
export const RECORD_WRITE_TOOLS: CoachTool[] = [editRecordTool];
