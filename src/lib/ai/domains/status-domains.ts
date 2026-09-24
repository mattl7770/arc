/**
 * The four domains whose whole edit is a STATUS CHANGE — reminders,
 * experiments, durable memories and knowledge entries.
 *
 * These are the fold (docs/spikes/coach-whole-app-access.md §3.2(b)). Six
 * bespoke tools used to live here — `complete_reminder`, `dismiss_reminder`,
 * `complete_experiment`, `abandon_experiment`, `forget`,
 * `retire_knowledge_entry` — measuring **970 tokens of the cached prefix**
 * between them, and every one of them executed a single `UPDATE … SET status`.
 * That is exactly what `edit_record { domain, id, fields: { status } }` says,
 * so they are retired into it and the prefix SHRINKS. No ceiling was raised to
 * pay for the registry; this is what pays for it.
 *
 * ## What the fold must not lose, and how it does not
 *
 * **The cards.** `summarize` below prints the six lines VERBATIM — "Mark
 * reminder "X" done", "Forget: "…"", "Abandon experiment "X" — reason". The
 * user sees the same card with the same lanes; only the tool name beneath it
 * changes, and the receipt (`ai_messages.tool_calls`) keeps the verb either
 * way. db/coach-domains.test.mjs asserts byte-identity against the old text.
 *
 * **The weight.** `retire_knowledge_entry` argued for its own existence on the
 * grounds that "taking something out of the base is not a smaller version of
 * putting something in it, and it deserves its own card" — an argument about
 * the CARD, which `selfEvident: false` keeps exactly.
 *
 * **Two behavioural rails.** `complete_reminder`'s recurring rule and
 * `abandon_experiment`'s abandon-not-conclude rule existed ONLY in those tool
 * descriptions; the system prompt has never carried either and has no room for
 * them. They now ride the READ payloads that hand out the ids — `list_reminders`
 * and `get_experiments`, emitted in the one case where each is true — behind
 * the card-time refusals below, which throw before an Approve tap is spent.
 * Result fields are not in the ceiling budget; descriptions are.
 *
 * **Restore stays the user's.** `restoreMemory` is "an undo for a forget the
 * user regrets" and `retire_knowledge_entry` was deliberately silent about
 * restoring so retiring never read as cheap. Both domains therefore accept
 * `archived` and nothing else: there is no un-archive here, and editing a
 * memory's text is still `forget` then `remember` — two gates on the store the
 * Coach reads itself.
 *
 * **None of the four is removable, and each refusal names the status that ends
 * it.** Reminders and experiments have no delete on any screen. Memories and
 * knowledge entries DO — the permanent delete on their own screens — and are
 * held below parity on purpose (docs/coach-domains.md §7): the Coach's removal
 * is the ARCHIVE, which the user can restore, and giving it the hard delete as
 * well would be two tools for "forget that", the overlap the fold exists to
 * remove.
 */
import { todayISODate } from '@/lib/db/date';
import { forgetMemory, getMemory } from '@/lib/db/repositories/coach-memory';
import {
  abandonExperiment,
  completeExperiment,
  getExperiment,
  type Experiment,
} from '@/lib/db/repositories/experiments';
import {
  archiveKnowledgeEntry,
  getKnowledgeEntry,
  listKnowledgeEntries,
  type KnowledgeEntryRow,
} from '@/lib/db/repositories/knowledge';
import { rederiveMissionFromToday } from '@/lib/db/repositories/mission-generate';
import {
  completeReminder,
  dismissReminder,
  listActiveReminders,
} from '@/lib/db/repositories/reminders';
import type { ReminderRow } from '@/lib/reminders/types';

import { optString, reqString } from '../tools/types';
import { enumField, type CoachDomainEntry, type DomainRow } from './types';

/**
 * The recurring rule, in words, for the two places it is stated: the card-time
 * throw here and the `list_reminders` payload note (../tools/read-tools).
 * One constant so the two can never drift apart.
 */
export const RECURRING_REMINDER_NOTE =
  'A recurring reminder is never completed — doing it today needs no write at all. ' +
  'Dismiss it only to END it.';

/** The abandon-not-conclude rule, shared with `get_experiments`' payload. */
export const EXPERIMENT_ABANDON_NOTE =
  'An experiment with no adherence behind it is abandoned (with a reason), never concluded — ' +
  'a verdict nothing was followed for is worse than no verdict.';

// --- reminders ---------------------------------------------------------------

function reminderRow(reminder: ReminderRow): DomainRow {
  return {
    id: reminder.id,
    name: reminder.title,
    values: { status: reminder.status },
    raw: reminder,
  };
}

const remindersDomain: CoachDomainEntry = {
  key: 'reminders',
  label: 'reminder',
  resolve: (db, id) => {
    const match = listActiveReminders(db).find((r) => r.id === id);
    // The exact message `complete_reminder` and `dismiss_reminder` both used.
    if (!match) throw new Error(`No active reminder with id ${id}. Call list_reminders first.`);
    return reminderRow(match);
  },
  fields: {
    status: enumField(
      ['done', 'dismissed'],
      'done = the user did it (ONE-OFFS only); dismissed = turn it off permanently'
    ),
  },
  read: { kind: 'bespoke', via: 'list_reminders' },
  createVia: 'set_reminder',
  summarize: ({ row, patch }) => {
    const reminder = row!.raw as ReminderRow;
    // THE CARD-TIME REFUSAL. `complete_reminder` threw this at EXECUTE, which
    // is one Approve tap too late: the user had already answered a gate for a
    // write that could only error. Moving it to `summarize` is the registry's
    // rule (a knowable failure throws before the card) applied to the rail the
    // fold took out of a description.
    if (patch.status === 'done' && reminder.repeat !== 'once') {
      throw new Error(
        `"${reminder.title}" repeats ${reminder.repeat} — completing would end it permanently. ` +
          RECURRING_REMINDER_NOTE
      );
    }
    return patch.status === 'done'
      ? `Mark reminder "${row!.name}" done`
      : `Dismiss reminder "${row!.name}"`;
  },
  // Verbatim from SELF_EVIDENT_WRITES: `complete_reminder` was on the list and
  // `dismiss_reminder` was deliberately off it — ending a recurring nudge
  // PERMANENTLY is exactly the consequence a summary cannot carry on its own.
  selfEvident: ({ patch }) => patch.status === 'done',
  edit: (db, row, patch) => {
    const reminder = row.raw as ReminderRow;
    if (patch.status === 'done') {
      // Belt as well as braces: the card refused this above, but a caller that
      // reaches execute another way must not end a recurring reminder.
      if (reminder.repeat !== 'once') {
        throw new Error(
          `"${reminder.title}" repeats ${reminder.repeat}. ${RECURRING_REMINDER_NOTE}`
        );
      }
      completeReminder(db, row.id);
      return;
    }
    dismissReminder(db, row.id);
  },
  remove: {
    mode: 'refuse',
    because:
      'No screen deletes a reminder: it ends by dismissal, ' +
      'edit_record { status: "dismissed" }.',
  },
};

// --- experiments -------------------------------------------------------------

function experimentRow(exp: Experiment): DomainRow {
  return { id: exp.id, name: exp.title, values: { status: exp.status }, raw: exp };
}

const experimentsDomain: CoachDomainEntry = {
  key: 'experiments',
  label: 'experiment',
  resolve: (db, id) => {
    const exp = getExperiment(db, id);
    if (!exp) throw new Error(`No experiment with id ${id}. Call get_experiments first.`);
    return experimentRow(exp);
  },
  fields: {
    status: enumField(
      ['concluded', 'abandoned'],
      'concluded needs "conclusion" (+ optional "outcome_notes"); abandoned needs "reason"'
    ),
    conclusion: {
      editable: true,
      note: 'The verdict, one line — required with status concluded',
      parse: (fields, key) => reqString(fields, key),
    },
    outcome_notes: {
      editable: true,
      note: 'How the watched metrics moved, the readout',
      parse: (fields, key) => optString(fields, key) ?? null,
    },
    reason: {
      editable: true,
      note: 'Why it cannot be read out — required with status abandoned',
      parse: (fields, key) => reqString(fields, key),
    },
  },
  read: { kind: 'bespoke', via: 'get_experiments' },
  createVia: 'create_experiment',
  summarize: ({ row, patch }) => {
    const exp = row!.raw as Experiment;
    if (exp.status !== 'active') {
      throw new Error(`Experiment "${exp.title}" is already ${exp.status}.`);
    }
    // A status patch's COMPANIONS are required in code, not in the schema: the
    // schema cannot express "conclusion when concluded, reason when abandoned"
    // without becoming two tools again, which is the shape the fold removed.
    if (patch.status === 'concluded') {
      if (typeof patch.conclusion !== 'string') {
        throw new Error('Concluding an experiment needs a "conclusion" — the verdict, one line.');
      }
      return `Conclude experiment "${row!.name}"`;
    }
    if (typeof patch.reason !== 'string') {
      throw new Error(`Abandoning an experiment needs a "reason". ${EXPERIMENT_ABANDON_NOTE}`);
    }
    return `Abandon experiment "${row!.name}" — ${patch.reason}`;
  },
  edit: (db, row, patch, context) => {
    const exp = row.raw as Experiment;
    if (exp.status !== 'active') {
      throw new Error(`Experiment "${exp.title}" is already ${exp.status}.`);
    }
    if (patch.status === 'concluded') {
      completeExperiment(db, exp.id, {
        conclusion: patch.conclusion as string,
        outcomeNotes: (patch.outcome_notes as string | null) ?? null,
      });
      // The mirror of create_experiment's call, kept exactly as
      // `complete_experiment` had it: a concluded experiment stops being a
      // running one, so its intervention must come OFF today and off every day
      // already committed ahead rather than lingering with nothing to measure.
      rederiveMissionFromToday(db, todayISODate(context.now));
      return;
    }
    abandonExperiment(db, exp.id, patch.reason as string);
  },
  remove: {
    mode: 'refuse',
    because:
      'No screen deletes an experiment: it ends concluded or abandoned, ' +
      'through edit_record { status }. Experiments lists it either way.',
  },
};

// --- durable memories --------------------------------------------------------

const memoriesDomain: CoachDomainEntry = {
  key: 'memories',
  label: 'memory',
  resolve: (db, id) => {
    const memory = getMemory(db, id);
    if (!memory) throw new Error(`No memory with id ${id}. Call get_memories first.`);
    return {
      id: memory.id,
      name: memory.content,
      values: { status: memory.archived_at === null ? 'active' : 'archived' },
      raw: memory,
    };
  },
  fields: {
    // `archived` and nothing else. Restoring is the user's undo for a forget
    // they regret, and a model that can un-archive can quietly reinstate a
    // fact the user asked it to drop.
    status: enumField(['archived'], 'archived = forget it (the user can still restore it)'),
  },
  read: { kind: 'bespoke', via: 'get_memories' },
  createVia: 'remember',
  summarize: ({ row }) => `Forget: "${row!.name}"`,
  edit: (db, row) => {
    forgetMemory(db, row.id);
  },
  remove: {
    mode: 'refuse',
    because:
      'Forget it with edit_record { status: "archived" }, which the user can restore. ' +
      'The permanent delete is theirs, on the memory’s own screen in Data › Knowledge base.',
  },
};

// --- knowledge entries -------------------------------------------------------

function knowledgeRow(entry: KnowledgeEntryRow): DomainRow {
  return {
    id: entry.id,
    name: entry.title,
    values: { status: entry.archived_at === null ? 'active' : 'archived' },
    raw: entry,
  };
}

const knowledgeDomain: CoachDomainEntry = {
  key: 'knowledge',
  label: 'knowledge entry',
  resolve: (db, id) => {
    // A SHIPPED PACK CHUNK IS NOT ADDRESSABLE HERE, and this is the whole
    // mechanism rather than a filter: the pack lives in `knowledge_chunks`
    // WHERE source = 'arc-longevity-v1' AND entry_id IS NULL, and this domain
    // reads and writes `knowledge_entries` only — so a pack id is simply an
    // unknown id, refused by the same line an invented one is.
    const entry = getKnowledgeEntry(db, id);
    if (!entry) throw new Error(`No knowledge entry with id ${id}. Find it with search_history.`);
    return knowledgeRow(entry);
  },
  fields: {
    status: enumField(['archived'], 'archived = retire it; it leaves every search'),
  },
  // The BROWSE the base never had: `search_history` finds an entry by keyword,
  // and nothing could list what is in there. Titles, topics and sections only —
  // the body is what `search_history` returns, and duplicating it here would
  // make a list of twelve entries cost more than the answer.
  read: {
    kind: 'list',
    run: (db, args) =>
      listKnowledgeEntries(db, { query: args.query, limit: args.limit }).map((e) => ({
        id: e.id,
        title: e.title,
        topic: e.topic,
        section: e.section,
        source: e.source,
        updatedAt: e.updated_at,
      })),
  },
  createVia: 'save_knowledge_entry',
  summarize: ({ row }) => `Retire entry "${row!.name}"`,
  edit: (db, row) => {
    archiveKnowledgeEntry(db, row.id);
  },
  remove: {
    mode: 'refuse',
    because:
      'Retire it with edit_record { status: "archived" }. The permanent delete is the ' +
      'user’s, on the Archived list in Data › Knowledge base.',
  },
  retires: [],
};

export const STATUS_DOMAINS: CoachDomainEntry[] = [
  remindersDomain,
  experimentsDomain,
  memoriesDomain,
  knowledgeDomain,
];
