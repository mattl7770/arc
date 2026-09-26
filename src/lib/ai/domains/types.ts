/**
 * The Coach DOMAIN REGISTRY — the contract behind `query_records`,
 * `edit_record` and `delete_record` (docs/coach-domains.md).
 *
 * ## Why a registry instead of a tool per gap
 *
 * `COACH_TOOLS` bills on every turn: the schemas sit in the cached prefix and
 * the two ceilings in db/coach-eval.test.mjs §6 guard it. A bespoke tool for
 * each of the ~68 things the screens can do and no tool could reach would cost
 * roughly 14,000 tokens at the registry's mean — more than the whole existing
 * toolbox — which is why the audit
 * (docs/spikes/coach-whole-app-access.md §3.2) rejected that shape outright.
 *
 * A registry pays once. Three generic tools carry a `domain` ENUM, and
 * everything that varies per domain — which fields exist, how each is
 * validated, what the confirmation card says, whether a row may be removed at
 * all — lives here in TypeScript, where it costs nothing on the wire and can be
 * tested headlessly against real SQLite.
 *
 * ## The one rule this file exists to enforce
 *
 * **Parity with the screens, through the repositories, never past them.** Every
 * `read`, `edit`, `create` and `remove` below calls the SAME repository
 * function a screen calls. No entry writes SQL. That is what makes the day
 * boundary (src/lib/db/date.ts), unit conversion, tombstones, provenance
 * columns and every CHECK inherited rather than re-implemented — and it is why
 * a change the screens refuse is a change the Coach cannot make either.
 *
 * ## Fail closed, everywhere
 *
 * `selfEvident` defaults to FALSE (the long confirmation card), `remove`
 * defaults to nothing (a domain with no `remove` cannot be deleted from; the
 * suite asserts every domain that holds rows says which), and
 * a field with `editable: false` throws at CARD time rather than being silently
 * dropped. The direction is the pending-write card's own
 * (src/components/coach/pending-write-card.tsx): a needlessly wordy card on a
 * trivial write is an irritation; a silently terse one on a destructive write
 * is a change the owner approved without being told what it cost.
 */
import type { Database } from '@/lib/db/database';
import { todayISODate } from '@/lib/db/date';

import type { CoachToolContext, WriteKind } from '../tools/types';

export type { WriteKind, WriteMeta } from '../tools/types';

/** One writable/readable field of a domain. */
export type DomainField = {
  /**
   * Validate this key out of the model's `fields` object and return the value
   * the repository wants. Throws a plain Error the model can correct from —
   * the same contract as the `parse` helpers in ../tools/types.
   *
   * It takes the whole object and the key (rather than the bare value) so the
   * existing `optString` / `optNumber` / `optPastDate` helpers compose here
   * unchanged, day boundary included.
   */
  parse: (fields: Record<string, unknown>, key: string, context: CoachToolContext) => unknown;
  /**
   * Patchable through `edit_record`. A readable-but-not-writable field is
   * declared here with `editable: false` so the refusal can NAME it, rather
   * than being absent and refused as an unknown key.
   */
  editable: boolean;
  /** Required when `edit_record` is used without an `id` (a create). */
  requiredOnCreate?: boolean;
  /**
   * The vocabulary line `query_records` returns when called with no filter.
   * This is where the field names live INSTEAD of the cached prompt: one warm
   * round trip on the turn it is needed, never a permanent tax
   * (docs/spikes/coach-whole-app-access.md §3.2).
   */
  note: string;
};

/** What `query_records` passes down to a domain's read. */
export type DomainReadArgs = {
  id?: string;
  query?: string;
  from?: string;
  to?: string;
  limit: number;
  /** The turn's clock — every window is resolved against the logical day. */
  now: Date;
};

/**
 * How a domain is read.
 *
 * `bespoke` means a registered tool already reads it — the domain is therefore
 * ABSENT from `query_records`' enum, so the schema itself steers the model to
 * `get_protocols` rather than leaving two paths to one answer and a rule in the
 * prompt about which to prefer.
 *
 * `list` returns ROWS, capped, each carrying the `id` a write will address.
 * `compute` returns ONE typed object with no ids — an aggregate the screens
 * compute rather than store (protocol adherence, per-exercise stats), which is
 * why it requires an `id` and ignores `limit`. Conflating the two is how a
 * model ends up asking for "the third row" of a number.
 */
export type DomainRead =
  | { kind: 'bespoke'; via: string }
  | { kind: 'list'; run: (db: Database, args: DomainReadArgs) => unknown[] }
  | {
      kind: 'compute';
      /** What `id` names here, for the error when it is missing. */
      needs: string;
      run: (db: Database, args: DomainReadArgs & { id: string }) => unknown;
    };

/**
 * Whether a row may be removed, and how. PARITY WITH THE SCREENS, applied to
 * deletion (the owner's call of 2026-09-23, docs/decisions.md).
 *
 *   - `hard` — a screen offers this delete, and `run` is what that screen
 *     calls. A record of a day (a meal, a session, a water entry) is as
 *     removable as an object, because the user can remove it by hand: the
 *     guardrail is the card, never a rule about which rows. Every `hard` domain
 *     is asserted to CASCADE only into its own parts (items, sets, versions),
 *     so a deletion never strands another row's history.
 *   - `refuse` — no screen offers this delete, or an owner call holds the
 *     domain below parity. The refusal NAMES where the row lives and what to
 *     do instead, so the answer is useful rather than merely a no.
 *
 * There is no third mode. `own` (delete only what THIS thread's Coach wrote)
 * was the 2026-09-19 rule, and the owner reversed it: the model's judgment
 * decides WHEN, and the card is where the user decides WHETHER.
 */
export type RemovePolicy =
  | { mode: 'refuse'; because: string }
  | {
      mode: 'hard';
      /**
       * What goes, as the card prints it after the name: the row's date and
       * its figures ("2026-09-22 19:00 · 800 kcal · P 60g · 3 items"). The
       * card is the only guardrail on an irreversible act against the only
       * copy of the data, so a removal is never approved from a bare name. It
       * is also the staleness re-read's second half: re-rendered past the
       * gate, and a line that no longer matches refuses. Throw here for a
       * knowable no-op, before an Approve tap is spent on it.
       */
      gone: (db: Database, row: DomainRow) => string;
      /** The screen's own delete, and whatever that screen runs after it. */
      run: (db: Database, row: DomainRow, context: CoachToolContext) => void;
    };

/**
 * A row as the registry sees it: never a bare id.
 *
 * `values` is the whole staleness mechanism as well as the card's "was X" half
 * — `edit_record` records the entries the card PRINTED before the gate, and
 * re-reads them after it, so a row that moved while the user was deciding
 * refuses instead of minting a receipt for something else.
 */
export type DomainRow = {
  id: string;
  /** What the card calls this row ("Take magnesium", "Magnesium PM"). */
  name: string;
  /** Current values, keyed exactly as `fields` is. */
  values: Record<string, unknown>;
  /** The repository row itself, for a domain's own `summarize` / `selfEvident`. */
  raw: unknown;
};

/** The arguments every card-shaped callback takes. */
export type DomainWriteArgs = {
  /**
   * The database, for a card that must name rows other than the one being
   * edited — a combine prints every meal it folds in (2026-09-25). Optional
   * because no other card reads it.
   */
  db?: Database;
  op: WriteKind;
  /** Absent only on a create. */
  row?: DomainRow;
  /** The validated patch — parsed values, keyed as `fields` is. */
  patch: Record<string, unknown>;
  context: CoachToolContext;
};

/** One domain of the app, as the three generic tools see it. */
export type CoachDomainEntry = {
  /** The enum value the model writes. Lowercase snake_case, like a tool name. */
  key: string;
  /** What the user would call it — the noun in every error and card. */
  label: string;
  /**
   * id → the row, THROWING when it is unknown with a message naming the read
   * that hands ids out. A bare id must never reach the user (../tools/types),
   * and an unknown id must never reach a repository.
   *
   * Optional only because a READ-ONLY domain has nothing to resolve an id FOR.
   * The suite asserts that any domain with `edit`, `create` or `remove` has
   * one, which is the invariant that actually matters.
   */
  resolve?: (db: Database, id: string, context: CoachToolContext) => DomainRow;
  fields: Record<string, DomainField>;
  read: DomainRead;
  /**
   * Apply a validated patch. READ-MODIFY-WRITE is the entry's own job: a field
   * the patch omits must be preserved, never cleared. `replaceWorkout` deletes
   * every set and re-inserts the argument, so a literal patch omitting `sets`
   * would wipe a session behind a card that did not say so.
   *
   * It may return facts the model needs about what the write made — a
   * combine's surviving meal id — which `edit_record` adds to its result.
   */
  edit?: (
    db: Database,
    row: DomainRow,
    patch: Record<string, unknown>,
    context: CoachToolContext
  ) => void | Record<string, unknown>;
  /** Create a row and return its id. Absent ⇒ `edit_record` without an `id` errors. */
  create?: (db: Database, patch: Record<string, unknown>, context: CoachToolContext) => string;
  /**
   * The bespoke tool that creates here instead. PREFER THE SPECIFIC TOOL is a
   * parser rule, not only prompt copy: naming the tool here is what makes the
   * refusal actionable.
   */
  createVia?: string;
  /** The one human line the confirmation card shows. Writable domains only. */
  summarize?: (args: DomainWriteArgs) => string;
  /** Defaults to false — see the file header. */
  selfEvident?: (args: DomainWriteArgs) => boolean;
  remove?: RemovePolicy;
  /**
   * The `UNCOVERED_DOMAINS` lines this entry makes FALSE (../tools/index).
   * A line becoming false is the worst thing a coverage claim can be, so the
   * suite asserts every string here is absent from that list.
   */
  retires?: string[];
};

/** The card's weight for one write — fail-closed when the domain says nothing. */
export function domainSelfEvident(entry: CoachDomainEntry, args: DomainWriteArgs): boolean {
  return entry.selfEvident?.(args) ?? false;
}

/**
 * The domain's own vocabulary, as `query_records` returns it on a no-filter
 * call. This is where the field names live INSTEAD of the cached prompt:
 * discovery costs one warm round trip, never a permanent tax on every turn.
 */
export function domainVocabulary(entry: CoachDomainEntry): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, field] of Object.entries(entry.fields)) {
    out[name] = field.editable ? field.note : `${field.note} (read-only)`;
  }
  return out;
}

// --- Shared field parsers ----------------------------------------------------

/**
 * A field whose value must be one of a fixed set — the shape every `status`
 * takes. The error NAMES the set, which is the registry's own pattern for
 * teaching a vocabulary without paying for it in the prefix.
 */
export function enumField(allowed: readonly string[], note: string, editable = true): DomainField {
  return {
    editable,
    note,
    parse: (fields, key) => {
      const value = fields[key];
      if (typeof value !== 'string' || !allowed.includes(value)) {
        throw new Error(`"${key}" must be one of: ${allowed.join(', ')}.`);
      }
      return value;
    },
  };
}

/**
 * A text field. `null` is a real value here — it CLEARS the field — which is
 * the one place the registry deliberately differs from `optString` (which
 * cannot tell an omitted key from an empty one). The patch only ever carries
 * keys the model sent, so "omitted" is already expressed by absence.
 */
export function textField(note: string, options: { requiredOnCreate?: boolean } = {}): DomainField {
  return {
    editable: true,
    note,
    ...(options.requiredOnCreate ? { requiredOnCreate: true } : {}),
    parse: (fields, key) => {
      const value = fields[key];
      if (value === null) return null;
      if (typeof value !== 'string') {
        throw new Error(`"${key}" must be a string, or null to clear.`);
      }
      const trimmed = value.trim();
      return trimmed.length === 0 ? null : trimmed;
    },
  };
}

/** A number field; `null` clears it. Bounds beyond these are the repository's. */
export function numberField(
  note: string,
  options: { requiredOnCreate?: boolean; min?: number; max?: number } = {}
): DomainField {
  return {
    editable: true,
    note,
    ...(options.requiredOnCreate ? { requiredOnCreate: true } : {}),
    parse: (fields, key) => {
      const value = fields[key];
      if (value === null) return null;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`"${key}" must be a finite number, or null to clear.`);
      }
      if (options.min !== undefined && value < options.min) {
        throw new Error(`"${key}" must be at least ${options.min}.`);
      }
      if (options.max !== undefined && value > options.max) {
        throw new Error(`"${key}" must be at most ${options.max}.`);
      }
      return value;
    },
  };
}

/** A boolean field. `null` is not a value — a flag is on or off. */
export function boolField(note: string): DomainField {
  return {
    editable: true,
    note,
    parse: (fields, key) => {
      const value = fields[key];
      if (typeof value !== 'boolean') throw new Error(`"${key}" must be true or false.`);
      return value;
    },
  };
}

/** `"HH:MM"`, 24-hour, with real clock values; `null` clears it. */
export function timeField(note: string): DomainField {
  return {
    editable: true,
    note,
    parse: (fields, key) => {
      const value = fields[key];
      if (value === null) return null;
      if (typeof value !== 'string') {
        throw new Error(`"${key}" must be "HH:MM", or null to clear.`);
      }
      const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
      if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
        throw new Error(`"${key}" must be a 24-hour "HH:MM" time, e.g. "21:00".`);
      }
      return value.trim();
    },
  };
}

/**
 * A `"YYYY-MM-DD"` calendar day. `kind: 'past'` refuses a future one, which is
 * the log tools' own rule — a mis-parsed "next Tuesday" poisons every trend
 * window it lands in — judged against the turn's clock so tests stay
 * deterministic.
 */
export function dateField(
  note: string,
  kind: 'past' | 'any' = 'any',
  options: { requiredOnCreate?: boolean } = {}
): DomainField {
  return {
    editable: true,
    note,
    ...(options.requiredOnCreate ? { requiredOnCreate: true } : {}),
    parse: (fields, key, context) => {
      const value = fields[key];
      if (typeof value !== 'string') throw new Error(`"${key}" must be a "YYYY-MM-DD" date.`);
      const shaped = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
      const y = Number(shaped?.[1]);
      const m = Number(shaped?.[2]);
      const d = Number(shaped?.[3]);
      const parsed = new Date(Date.UTC(y, m - 1, d));
      const roundTrips =
        shaped !== null &&
        !Number.isNaN(parsed.getTime()) &&
        parsed.getUTCFullYear() === y &&
        parsed.getUTCMonth() === m - 1 &&
        parsed.getUTCDate() === d;
      if (!roundTrips) throw new Error(`"${key}" must be a real "YYYY-MM-DD" calendar date.`);
      const day = value.trim();
      if (kind === 'past' && day > todayISODate(context.now)) {
        throw new Error(
          `"${key}" (${day}) is in the future — a record is of what already happened. ` +
            `Today is ${todayISODate(context.now)}.`
        );
      }
      return day;
    },
  };
}

// --- The generic card --------------------------------------------------------

/** One value, as a card prints it. */
function printed(value: unknown): string {
  if (value === null || value === undefined) return 'nothing';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string') return value.length === 0 ? 'nothing' : value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  return JSON.stringify(value);
}

/**
 * The BEFORE → AFTER card, built from the ROW rather than from the request.
 *
 * "Edit meal" says nothing a user can refuse. What they are being asked about
 * is the change, so every field the patch touches is printed as it reads now
 * and as it would read — and a field whose new value equals the old one is
 * DROPPED, because a card listing a change that is not a change trains the
 * reader to stop reading it. A patch that changes nothing throws instead of
 * costing an Approve tap.
 */
export function describeEdit(
  label: string,
  row: DomainRow,
  patch: Record<string, unknown>
): string {
  const changes: string[] = [];
  for (const [name, next] of Object.entries(patch)) {
    const before = row.values[name];
    if (Object.is(before, next)) continue;
    changes.push(`${name} ${printed(before)} → ${printed(next)}`);
  }
  if (changes.length === 0) {
    throw new Error('Nothing would change — every field you sent already reads that way.');
  }
  return `Edit ${label} "${row.name}" — ${changes.join(', ')}`;
}

/**
 * The removal card: the row's name, then what goes with it — its date and its
 * figures (`RemovePolicy.gone`). A deletion is worded as one, never as an edit.
 */
export function describeDelete(label: string, row: DomainRow, gone: string): string {
  return `Delete ${label} "${row.name}" — ${gone}`;
}

/** "1 set", "12 sets" — a removal card counts what goes with the row. */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** "Bench Press, Back Squat, Row +2 more" — enough names to recognise a row by. */
export function listed(names: readonly string[], max = 3): string {
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown} +${names.length - max} more` : shown;
}

/** A page's opening words, for a removal card (src/lib/utils/excerpt.ts). */
export { excerpt } from '@/lib/utils/excerpt';
