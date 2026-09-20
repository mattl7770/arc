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
 * defaults to nothing (a domain with no `remove` cannot be deleted from), and
 * a field with `editable: false` throws at CARD time rather than being silently
 * dropped. The direction is the pending-write card's own
 * (src/components/coach/pending-write-card.tsx): a needlessly wordy card on a
 * trivial write is an irritation; a silently terse one on a destructive write
 * is a change the owner approved without being told what it cost.
 */
import type { Database } from '@/lib/db/database';

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
 * Whether a row may be removed, and how.
 *
 *   - `refuse` — the row is a record of a day. The refusal NAMES the screen, so
 *     the answer is useful rather than merely a no.
 *   - `hard` — an object that is not a day (a recipe, a food, a saved workout).
 *     Every `hard` domain is asserted to have no CASCADE from a log table
 *     pointed at it, so a deletion can never strand history.
 *   - `own` — deletable only when THIS conversation's Coach wrote the row. The
 *     undo, not a licence over history.
 */
export type RemovePolicy =
  | { mode: 'refuse'; because: string }
  | { mode: 'hard'; run: (db: Database, row: DomainRow) => void }
  | { mode: 'own'; run: (db: Database, row: DomainRow) => void };

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
   */
  edit?: (
    db: Database,
    row: DomainRow,
    patch: Record<string, unknown>,
    context: CoachToolContext
  ) => void;
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
