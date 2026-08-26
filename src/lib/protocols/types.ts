/**
 * Types for the Protocols domain. The row shapes themselves (ProtocolRow,
 * ProtocolVersionRow) mirror the 0001 tables (plus `started_on` from 0043) and
 * live in src/lib/db/types.ts; this file adds the version-content shape and the
 * view types the screens consume, following the same feature-local pattern as
 * src/lib/nutrition/types.ts.
 *
 * ## content schema 2 — phases and cadence
 *
 * v1 content was `{ items: [{title, scheduled_time, dose, notes}] }` and carried
 * NO frequency at all, so every item of every active protocol landed on every
 * day: "creatine daily", "3× a week lower body" and "8-week course, then stop"
 * were one shape and all three ran seven days a week.
 *
 * Schema 2 adds the two things that were missing, and nothing else:
 *
 *   - **cadence per item** — the full vocabulary the owner settled on
 *     (2026-08-25): daily · specific weekdays · every-N-days · an N-per-week
 *     flexible quota;
 *   - **ordered phases per protocol** — each with its own items and a duration,
 *     so titration ("2 caps for 4 weeks, then 4") and a block that changes at
 *     week 5 are expressible. The generator picks the phase by date from
 *     `protocols.started_on`.
 *
 * **Storage does not change shape:** content is still versioned JSON inside
 * immutable `protocol_versions`, so this needed no change to that table. What
 * DID need care is the read path — every version already on the owner's device
 * is v1 and immutable, so `parseProtocolContent` normalises v1 into one
 * open-ended phase of daily items with DETERMINISTIC ids, and old versions
 * render, diff and restore exactly like new ones.
 *
 * There is deliberately only ONE in-memory content type. A v1 document is
 * normalised at the parse boundary and never travels further as itself, so no
 * screen, repository or tool has to know which schema a version was written in.
 */
import type { ProtocolType, TimeString, Timestamp } from '@/lib/db/types';

/**
 * How often one item comes round. All four kinds are evaluated in LOCAL
 * calendar dates (`YYYY-MM-DD` text) — see src/lib/protocols/cadence.ts, which
 * owns the arithmetic and hand-rolls the weekday because Hermes ships no `Intl`.
 *
 * `weekdays` uses ISO numbering, 1 = Monday … 7 = Sunday — the same Monday-start
 * week `localWeekRange` and `get_training_summary.thisWeek` already use, so a
 * "3 of 7 days" quota and a "Mon/Wed/Fri" list agree about where a week begins.
 */
export type Cadence =
  | { kind: 'daily' }
  | { kind: 'weekdays'; days: number[] }
  | { kind: 'every_n_days'; n: number }
  | { kind: 'quota'; per_week: number };

/** The four cadence kinds, in the order the editor's control presents them. */
export type CadenceKind = Cadence['kind'];

/**
 * One line of a protocol version — a supplement in a stack, a step in a
 * routine, a meal in a template. Field names are snake_case like the columns
 * they generate (`log_entries.scheduled_time`), since this shape is stored
 * verbatim in `protocol_versions.content`.
 */
export type ProtocolItem = {
  /**
   * Stable identity across versions, so the version diff can say "this item
   * changed" rather than "one was removed and another added", and so the
   * generator can stamp it on the row it creates and count completions per item
   * without joining on a title string that an edit may have changed.
   *
   * Generated at authoring from src/lib/db/id.ts. Items normalised out of a v1
   * document get a DERIVED id instead (a hash of index + title), so the same
   * stored v1 content always yields the same ids — otherwise every read of an
   * immutable old version would invent new identities and the diff between two
   * v1 versions would read as "everything changed".
   */
  id: string;
  title: string;
  /** Wall-clock 'HH:MM' the item is anchored to, or null for "any time". */
  scheduled_time: TimeString | null;
  /** Dose or short how-to ("2 caps", "with food", "4×8 @ RPE 7"). */
  dose: string | null;
  /** Longer context — the rationale line the mission renders as `why`. */
  notes: string | null;
  cadence: Cadence;
};

/**
 * One ordered stretch of a protocol. A protocol with no titration is exactly
 * one phase: `title: null`, `duration_days: null`, which is what the editor
 * creates by default so the simple case costs no extra taps.
 */
export type ProtocolPhase = {
  /** Stable across versions, like {@link ProtocolItem.id}. */
  id: string;
  /** "Loading", "Week 5–8". Null for a single-phase protocol. */
  title: string | null;
  /**
   * How many days this phase runs. **Null means open-ended**, and is only legal
   * on the LAST phase — an open-ended phase in the middle would make every
   * phase after it unreachable. `validateContent` rejects that; the generator
   * treats such a phase as terminal so a hand-edited document degrades
   * predictably rather than silently skipping the rest.
   *
   * A bounded LAST phase is the "8-week course, then stop" case: once its days
   * run out the protocol has ENDED and generates nothing.
   */
  duration_days: number | null;
  items: ProtocolItem[];
};

/**
 * The `protocol_versions.content` JSON document, schema 2.
 *
 * `schema` is written on every new version and is what tells a reader which
 * shape it holds; its ABSENCE is what identifies a v1 document, since v1 never
 * wrote the key.
 */
export type ProtocolContent = {
  schema: 2;
  /** Ordered, at least one. */
  phases: ProtocolPhase[];
};

/** What the app supplies to create a protocol; slug/id/flags are repo-owned. */
export type NewProtocol = {
  name: string;
  type: ProtocolType;
  description?: string | null;
  /**
   * The day the phase clock starts. Omitted, it is left UNANCHORED and the
   * first mission generation stamps it (`ensureStartedOn`), so phase 1 begins
   * on the first day the protocol actually plans something. Only the editor
   * passes one, and only for a protocol with more than one phase — see the
   * header of db/migrations/0043_protocol_started_on.sql.
   */
  startedOn?: string | null;
};

/** One row of the Protocols hub — protocol + its live version's stats. */
export type ProtocolListItem = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  type: ProtocolType;
  isActive: boolean;
  /** Live version number, or null while the protocol has no version yet. */
  versionNumber: number | null;
  /** Items in the live version across ALL phases — 0 when there is no version. */
  itemCount: number;
  /** Phases in the live version — 0 when there is no version. */
  phaseCount: number;
  /** The day the phase clock starts. Null on a protocol never activated. */
  startedOn: string | null;
  updatedAt: Timestamp;
};
