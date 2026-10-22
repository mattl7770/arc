/**
 * Coach proposals — a change the unattended Coach drafted, waiting for his tap.
 *
 * Owner's decision, 2026-10-21: the pass may draft changes for him to approve,
 * at most three a day, shown on Home and in the thread, each one his tap. The
 * plan of record is docs/spikes/chief-of-staff-release.md Track 2 item 2; the
 * account of what was built is docs/ai-coach.md › Coach proposals.
 *
 * ## The three rules this file exists to keep
 *
 *   THE PASS STAYS READ-ONLY. It writes PROPOSE lines (proposal-lines.ts), and
 *   code draws each one's card with the tool's OWN `confirmSummary` — the same
 *   validation, the same id resolution, the same line a chat card would show —
 *   and stores it. Nothing executes at pass time. The only rows a pass touches
 *   are `users.preferences` (this store, as the pass schedule already does) and
 *   the thread.
 *
 *   APPROVE IS A CHAT APPROVAL, LATE. {@link approveProposal} runs the tool
 *   through write-gate.ts's `runGatedTool`, the function coach-service.ts runs
 *   every chat write through. It draws the card AGAIN at the tap, and the gate
 *   says yes only when the redrawn card is the card he was shown: the same
 *   line, the same weight, the same staleness slot (`CoachToolContext.card` —
 *   the "was" values a generic edit printed) and the same Training row a
 *   workout's card named. Any difference refuses, says so, and writes nothing.
 *   Past the gate, the tool's own `execute` re-reads its slot a second time,
 *   exactly as it does in chat.
 *
 *   NOTHING PILES UP. A draft expires at the end of the logical day it was
 *   drafted on, or at its own `until`, whichever is sooner. Three a day, counted
 *   when drafted, whatever becomes of them. A week of resolved drafts is kept
 *   so the thread can still say what became of each one; nothing older.
 *
 * Declines are recorded the way a chat decline is: an assistant row whose tool
 * record says `declined`, so `recentDeclines` (ai-chat.ts) hands it to the next
 * turn's state block and the Coach does not draft it again tomorrow.
 *
 * Also here: the MODEL-VOICED BRIEF's store and its provenance check, since it
 * rides the same pass and the same section of preferences.
 *
 * State lives in `users.preferences.coachProposals` and `.coachBrief` — the
 * unit-preferences pattern, so no migration. Pure over the {@link Database}
 * interface; headless-tested in db/coach-proposals.test.mjs.
 */
import { findingById } from './findings';
import type { Database } from '@/lib/db/database';
import { dayStartMinutes, getDayStartsAt, shiftISODate, todayISODate } from '@/lib/db/date';
import { newId } from '@/lib/db/id';
import { appendMessage, getOrCreateActiveConversation } from '@/lib/db/repositories/ai-chat';
import { getOrCreateUser } from '@/lib/db/repositories/user';
import { clockOf } from '@/lib/notifications/nudge-plan';

import { checkNumberProvenance } from './provenance';
import type { MalformedProposeLine, ProposeLine } from './proposal-lines';
import { toolByName, WRITE_TOOLS, type CoachToolContext, type WriteKind } from './tools/index';
import type { CoachToolCall } from './types';
import { DECLINED_RESULT, drawWriteCard, runGatedTool, type WriteConfirmation } from './write-gate';

/** At most this many drafts a logical day, counted when drafted (owner, 2026-10-21). */
export const PROPOSALS_PER_DAY = 3;
/** How long a resolved draft is kept, so the thread can still say what became of it. */
const KEEP_DAYS = 7;

export type ProposalStatus = 'pending' | 'approved' | 'declined' | 'expired' | 'refused';

/**
 * What the card PRINTED beyond its line — compared whole at the tap. `card` is
 * the generic tools' staleness slot, `trainingRow` the row a workout's card
 * said it would tick. Null where the tool sets neither.
 */
type CardSnapshot = {
  kind: WriteKind;
  selfEvident: boolean;
  card: CoachToolContext['card'] | null;
  trainingRow: CoachToolContext['trainingRow'] | null;
};

export type StoredProposal = {
  id: string;
  /** The logical day it was drafted on — and the last day it can be approved. */
  day: string;
  /** ISO instant it was drafted. */
  createdAt: string;
  /** "HH:MM" it expires at, or null for the end of the day. */
  until: string | null;
  /** The record finding it answers, or null. Older rows lack the field: read as null. */
  finding: string | null;
  tool: string;
  input: Record<string, unknown>;
  /** The card line, drawn by the tool at pass time. What he approves. */
  summary: string;
  snapshot: CardSnapshot;
  /** The model's one line of why, shown under the card. */
  reason: string;
  status: ProposalStatus;
  /** The receipt (approved) or the refusal (refused); null otherwise. */
  outcome: string | null;
  resolvedAt: string | null;
  /** The thread row that recorded the draft, once written. */
  messageId: string | null;
  /**
   * Drafted by the WEEKLY review (weekly-review.ts), or absent for the pass's
   * own drafts. A weekly decision has its own allowance — three per reviewed
   * week, never the day's three — and a two-day life: `through` is the last
   * logical day it can be approved (the day after it landed). Older rows lack
   * the field: read as a daily draft.
   */
  weekly?: { week: string; through: string };
};

/** A draft code would not keep, and why — told to the next pass. */
export type RefusedProposal = { line: string; reason: string };

type ProposalState = { items: StoredProposal[]; refused: RefusedProposal[] };

/** A drafted card, before the cap: what {@link draftProposals} hands back. */
export type DraftedProposal = Omit<
  StoredProposal,
  'id' | 'day' | 'createdAt' | 'status' | 'outcome' | 'resolvedAt' | 'messageId'
>;

// --- The store ------------------------------------------------------------------

type Listener = () => void;
const listeners = new Set<Listener>();
let version = 0;

function bump(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/**
 * Something outside this store changed what Home's Coach card reads — the
 * weekly review filed its report (weekly-runner.ts) — so its readers re-read.
 */
export function noteProposalsChanged(): void {
  bump();
}

/** Re-render seam for Home and the thread (useSyncExternalStore). */
export function subscribeProposals(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getProposalsVersion(): number {
  return version;
}

function parsePreferences(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function writeSection(db: Database, key: string, value: unknown): void {
  const user = getOrCreateUser(db);
  const preferences = parsePreferences(user.preferences);
  preferences[key] = value;
  db.run('UPDATE users SET preferences = ? WHERE id = ?', [JSON.stringify(preferences), user.id]);
}

function readSection(db: Database, key: string): unknown {
  return parsePreferences(getOrCreateUser(db).preferences)[key];
}

/** A stored item is trusted only as far as its shape is checked. */
function isStoredProposal(value: unknown): value is StoredProposal {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === 'string' &&
    typeof p.day === 'string' &&
    typeof p.tool === 'string' &&
    typeof p.summary === 'string' &&
    typeof p.status === 'string' &&
    !!p.input &&
    typeof p.input === 'object' &&
    !!p.snapshot &&
    typeof p.snapshot === 'object'
  );
}

function readState(db: Database): ProposalState {
  const section = readSection(db, 'coachProposals');
  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    return { items: [], refused: [] };
  }
  const record = section as Record<string, unknown>;
  const items = Array.isArray(record.items) ? record.items.filter(isStoredProposal) : [];
  const refused = Array.isArray(record.refused)
    ? record.refused.filter(
        (r): r is RefusedProposal =>
          !!r &&
          typeof (r as RefusedProposal).line === 'string' &&
          typeof (r as RefusedProposal).reason === 'string'
      )
    : [];
  return { items, refused };
}

function writeState(db: Database, state: ProposalState): void {
  writeSection(db, 'coachProposals', state);
  bump();
}

/** Minutes past the day boundary — so an `until` compares within a late-boundary day. */
function intoDay(clock: string, dayStartsAt: string): number {
  const [h, m] = clock.split(':').map(Number);
  return (h! * 60 + m! - dayStartMinutes(dayStartsAt) + 1440) % 1440;
}

/**
 * Is this draft past its life? Its last day is over (the day it was drafted
 * on, or a weekly decision's `through`), or its `until` has gone by. A clock
 * rolled back before the drafted day expires it too. An `until` binds the
 * drafted day.
 */
export function isExpired(
  proposal: Pick<StoredProposal, 'day' | 'until' | 'weekly'>,
  now: Date,
  dayStartsAt: string = getDayStartsAt()
): boolean {
  const today = todayISODate(now, dayStartsAt);
  if (today < proposal.day || today > (proposal.weekly?.through ?? proposal.day)) return true;
  if (proposal.until === null) return false;
  if (today > proposal.day) return true;
  return intoDay(clockOf(now), dayStartsAt) >= intoDay(proposal.until, dayStartsAt);
}

/** The status as of `now`: a pending draft past its life reads as expired. */
function effective(p: StoredProposal, now: Date, dayStartsAt: string): StoredProposal {
  return p.status === 'pending' && isExpired(p, now, dayStartsAt) ? { ...p, status: 'expired' } : p;
}

/** Expire what is past its life and drop what is older than a week. */
function sweep(state: ProposalState, now: Date, dayStartsAt: string): ProposalState {
  const today = todayISODate(now, dayStartsAt);
  const oldest = shiftISODate(today, -(KEEP_DAYS - 1));
  return {
    ...state,
    items: state.items
      .filter((p) => p.day >= oldest)
      .map((p) => {
        const e = effective(p, now, dayStartsAt);
        return e.status === p.status ? p : { ...e, resolvedAt: now.toISOString() };
      }),
  };
}

/** Every kept draft, statuses as of `now`, oldest first. Writes nothing. */
export function listProposals(db: Database, now: Date = new Date()): StoredProposal[] {
  const dayStartsAt = getDayStartsAt();
  return readState(db).items.map((p) => effective(p, now, dayStartsAt));
}

/** Pending first, then answered, each in drafted order. */
function pendingFirst(mine: StoredProposal[]): StoredProposal[] {
  return [
    ...mine.filter((p) => p.status === 'pending'),
    ...mine.filter((p) => p.status !== 'pending'),
  ];
}

/**
 * One day's drafts from the pass, pending first then answered, each in drafted
 * order. The weekly review's decisions are not among them: Home draws those
 * under "Your week" ({@link weeklyDrafts}).
 */
export function draftsForDay(items: StoredProposal[], day: string): StoredProposal[] {
  return pendingFirst(items.filter((p) => p.day === day && !p.weekly));
}

/** One reviewed week's decisions (`week` is its Monday), pending first. */
export function weeklyDrafts(items: StoredProposal[], week: string): StoredProposal[] {
  return pendingFirst(items.filter((p) => p.weekly?.week === week));
}

// --- Findings ---------------------------------------------------------------------

/**
 * Is record finding `id` still open? A draft may cite the finding it answers
 * (`PROPOSE finding <id> …`); it is refused when drafted if the finding is not
 * open, and refused at the tap if it was resolved meanwhile — fixing a gap
 * he already filled by hand would be a second fix for one fault.
 *
 * A seam rather than an import because the findings module is the hygiene
 * work's (src/lib/ai/findings.ts, `findingById`), and the two land
 * separately. Wired at the merge with one line:
 *
 *   setFindingLookup((db, id) => findingById(db, id) !== null);
 *
 * Until then no lookup is set, and a draft citing a finding FAILS CLOSED: it
 * is refused, never kept on a claim nothing can check.
 */
export type FindingLookup = (db: Database, id: string, now: Date) => boolean;
// Wired at the merge that brought both modules together (2026-10-21): a
// finding is open while findingById still derives it.
let findingLookup: FindingLookup | null = (db, id, now) => findingById(db, id, now) !== null;

export function setFindingLookup(lookup: FindingLookup | null): void {
  findingLookup = lookup;
}

/** Can a draft cite a finding in this build? The directive says so only if it can. */
export function findingsCitable(): boolean {
  return findingLookup !== null;
}

/** Null when the finding is open; otherwise why the draft cannot stand. */
function findingProblem(db: Database, id: string, now: Date): string | null {
  if (!findingLookup) return `finding ${id} cannot be checked in this build`;
  let open = false;
  try {
    open = findingLookup(db, id, now);
  } catch {
    open = false;
  }
  return open ? null : `finding ${id} is resolved`;
}

// --- The pass side --------------------------------------------------------------

/** What the pass is told about drafts (coach-pass.ts's proposals block). */
export type ProposalDirective = {
  /** How many more it may draft today. */
  remaining: number;
  /** Card lines still waiting on him. */
  pending: string[];
  /** What code dropped from the last pass, and why. */
  refused: RefusedProposal[];
};

export function proposalDirectiveFor(db: Database, now: Date = new Date()): ProposalDirective {
  const today = todayISODate(now);
  const all = listProposals(db, now);
  // The weekly review's decisions have their own allowance, so they do not
  // spend the day's three — but they are waiting on him like any other draft,
  // so the pass is told about them and does not draft them again.
  const made = all.filter((p) => p.day === today && !p.weekly).length;
  return {
    remaining: Math.max(0, PROPOSALS_PER_DAY - made),
    pending: all.filter((p) => p.status === 'pending').map((p) => p.summary),
    refused: readState(db).refused,
  };
}

/**
 * The write tools as one-line signatures — `name(field, optional?, kind=a|b)`
 * — derived from each tool's own `inputSchema`, so the list cannot fall behind
 * the registry.
 *
 * The pass is offered READ tools only (that is what keeps it read-only by
 * construction), so without this it would be drafting inputs for tools it has
 * never seen. The signatures ride the pass's own user message, outside both
 * chat ceilings in db/coach-eval.test.mjs §6, and are measured in
 * db/coach-proposals.test.mjs. Strings are the default and unmarked; an array
 * of objects shows its item fields one level down.
 */
export function writeToolSignatures(): string[] {
  type Schema = {
    type?: string | string[];
    enum?: unknown[];
    properties?: Record<string, Schema>;
    required?: string[];
    items?: Schema;
  };
  const field = (name: string, schema: Schema, required: Set<string>): string => {
    const opt = required.has(name) ? '' : '?';
    if (schema.enum && schema.enum.length <= 30) return `${name}${opt}=${schema.enum.join('|')}`;
    if (schema.type === 'array' && schema.items?.type === 'object' && schema.items.properties) {
      return `${name}${opt}:[${fields(schema.items)}]`;
    }
    if (schema.type === 'array') return `${name}${opt}:[]`;
    if (schema.type === 'number' || schema.type === 'integer') return `${name}${opt}:n`;
    if (schema.type === 'boolean') return `${name}${opt}:bool`;
    if (schema.type === 'object') return `${name}${opt}:{}`;
    return `${name}${opt}`;
  };
  const fields = (schema: Schema): string => {
    const required = new Set(schema.required ?? []);
    return Object.entries(schema.properties ?? {})
      .map(([name, sub]) => field(name, sub, required))
      .join(', ');
  };
  return WRITE_TOOLS.map((tool) => `${tool.name}(${fields(tool.inputSchema as Schema)})`);
}

/** The card's weight and slots, as compared at the tap. */
function snapshotOf(card: WriteConfirmation, context: CoachToolContext): CardSnapshot {
  return {
    kind: card.kind,
    selfEvident: card.selfEvident,
    card: context.card ?? null,
    trainingRow: context.trainingRow ?? null,
  };
}

const MALFORMED_WORDS: Record<MalformedProposeLine['why'], string> = {
  grammar: 'not PROPOSE tool_name {json} reason',
  json: 'the input was not one JSON object',
  reason: 'no reason after the JSON',
};

/** A line short enough to hand back to the model. */
function shortLine(line: string): string {
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

/**
 * Draw each PROPOSE line's card, at pass time, with the tool's own
 * `confirmSummary` — exactly as chat draws one before its gate. A tool that
 * is not a registered write, input its parser refuses, an id that names
 * nothing, an `until` already gone by: refused, with the tool's own words.
 *
 * Executes nothing. `drawWriteCard` reads; the only state it touches is the
 * per-call context object, which is captured into the snapshot and dropped.
 */
export function draftProposals(
  db: Database,
  lines: ProposeLine[],
  malformed: MalformedProposeLine[],
  now: Date
): { drafted: DraftedProposal[]; refused: RefusedProposal[] } {
  const dayStartsAt = getDayStartsAt();
  const today = todayISODate(now, dayStartsAt);
  const drafted: DraftedProposal[] = [];
  const refused: RefusedProposal[] = malformed.map((m) => ({
    line: shortLine(m.line),
    reason: MALFORMED_WORDS[m.why],
  }));
  for (const line of lines) {
    const tool = toolByName(line.tool);
    if (!tool) {
      refused.push({ line: shortLine(line.line), reason: `${line.tool} is not a tool` });
      continue;
    }
    if (tool.readOnly) {
      refused.push({ line: shortLine(line.line), reason: `${line.tool} is a read, not a change` });
      continue;
    }
    if (line.until !== null && isExpired({ day: today, until: line.until }, now, dayStartsAt)) {
      refused.push({ line: shortLine(line.line), reason: `${line.until} has already gone by` });
      continue;
    }
    const findingIssue = line.finding !== null ? findingProblem(db, line.finding, now) : null;
    if (findingIssue !== null) {
      refused.push({ line: shortLine(line.line), reason: findingIssue });
      continue;
    }
    const context: CoachToolContext = { now, clock: () => now };
    try {
      const card = drawWriteCard(tool, line.input, db, context);
      drafted.push({
        tool: tool.name,
        input: line.input,
        summary: card.summary,
        snapshot: snapshotOf({ tool: tool.name, summary: card.summary, ...card.meta }, context),
        reason: line.reason,
        until: line.until,
        finding: line.finding,
      });
    } catch (error) {
      refused.push({
        line: shortLine(line.line),
        reason: error instanceof Error ? error.message : 'its card could not be drawn',
      });
    }
  }
  return { drafted, refused };
}

/**
 * Keep the drafts the rules allow and write them, pending. The cap counts every
 * draft made today, whatever became of it, so a decline does not buy another;
 * a draft whose card matches one still pending is the same draft twice. What
 * is dropped joins the refusals the NEXT pass is told about — this pass's list
 * replaces the last one's.
 *
 * Returns the kept drafts, in order.
 */
export function recordProposals(
  db: Database,
  drafted: DraftedProposal[],
  refused: RefusedProposal[],
  now: Date,
  /**
   * The weekly review's drafts: counted against `allowance` for `week` (its
   * Monday) instead of the day's three, and open through `through`.
   */
  options: { weekly?: { week: string; through: string; allowance: number } } = {}
): StoredProposal[] {
  const dayStartsAt = getDayStartsAt();
  const today = todayISODate(now, dayStartsAt);
  const state = sweep(readState(db), now, dayStartsAt);
  const weekly = options.weekly ?? null;
  const made = weekly
    ? state.items.filter((p) => p.weekly?.week === weekly.week).length
    : state.items.filter((p) => p.day === today && !p.weekly).length;
  const cap = weekly ? weekly.allowance : PROPOSALS_PER_DAY;
  const remaining = Math.max(0, cap - made);
  const key = (p: { tool: string; summary: string }) => `${p.tool}\u0000${p.summary}`;
  // After the sweep every draft still pending is live — today's, or a weekly
  // decision inside its two days — so the duplicate rule spans both.
  const pending = new Set(state.items.filter((p) => p.status === 'pending').map(key));
  const kept: StoredProposal[] = [];
  const dropped = [...refused];
  for (const draft of drafted) {
    if (pending.has(key(draft))) {
      dropped.push({ line: draft.summary, reason: 'already waiting on him' });
      continue;
    }
    if (kept.length >= remaining) {
      dropped.push({
        line: draft.summary,
        reason: weekly
          ? `over the ${cap}-decision cap for the weekly review`
          : `over the ${PROPOSALS_PER_DAY}-a-day cap`,
      });
      continue;
    }
    pending.add(key(draft));
    kept.push({
      ...draft,
      id: newId(db),
      day: today,
      createdAt: now.toISOString(),
      status: 'pending',
      outcome: null,
      resolvedAt: null,
      messageId: null,
      ...(weekly ? { weekly: { week: weekly.week, through: weekly.through } } : {}),
    });
  }
  writeState(db, { items: [...state.items, ...kept], refused: dropped });
  return kept;
}

/** Point kept drafts at the thread row that recorded them. */
export function linkProposalsToMessage(db: Database, ids: string[], messageId: string): void {
  if (ids.length === 0) return;
  const wanted = new Set(ids);
  const state = readState(db);
  writeState(db, {
    ...state,
    items: state.items.map((p) => (wanted.has(p.id) ? { ...p, messageId } : p)),
  });
}

/**
 * The line that opens a draft record in the thread. The thread draws the
 * drafts themselves as cards under it, so it strips the record back off a
 * bubble that has them ({@link splitProposalRecord}); the text stays in the row
 * so the model's history, and the record after the store forgets, still say
 * what was drafted.
 */
export const PROPOSAL_RECORD_HEAD = 'Drafted for your approval:';

export function describeProposalRecord(kept: StoredProposal[]): string | null {
  if (kept.length === 0) return null;
  return [PROPOSAL_RECORD_HEAD, ...kept.map((p) => `· ${p.summary}`)].join('\n');
}

/** A thread row's text without its trailing draft record. */
export function splitProposalRecord(content: string): string {
  if (content.startsWith(PROPOSAL_RECORD_HEAD)) return '';
  const at = content.lastIndexOf(`\n\n${PROPOSAL_RECORD_HEAD}`);
  return at === -1 ? content : content.slice(0, at).trim();
}

// --- The tap ------------------------------------------------------------------

export type ProposalResolution = {
  status: 'approved' | 'declined' | 'refused' | 'expired' | 'gone';
  /** The receipt, the refusal, or a short reason. */
  line: string;
};

/** Taps in flight — a double tap must not run a write twice. */
const inFlight = new Set<string>();

/** One resolved draft, written back. Re-reads the store: an await came between. */
function resolve(
  db: Database,
  id: string,
  status: ProposalStatus,
  outcome: string | null,
  now: Date
): void {
  const state = readState(db);
  writeState(db, {
    ...state,
    items: state.items.map((p) =>
      p.id === id ? { ...p, status, outcome, resolvedAt: now.toISOString() } : p
    ),
  });
}

/** The draft's own record row in the thread — a receipt, a decline or a refusal. */
function recordInThread(db: Database, content: string, call: CoachToolCall): void {
  appendMessage(db, getOrCreateActiveConversation(db).id, 'assistant', content, [call]);
}

/** Find a draft that can still be answered, or say why not. */
function answerable(
  db: Database,
  id: string,
  now: Date
): { proposal: StoredProposal } | { resolution: ProposalResolution } {
  const dayStartsAt = getDayStartsAt();
  const stored = readState(db).items.find((p) => p.id === id);
  if (!stored) return { resolution: { status: 'gone', line: 'That draft is no longer here.' } };
  const proposal = effective(stored, now, dayStartsAt);
  if (proposal.status === 'expired') {
    if (stored.status === 'pending') resolve(db, id, 'expired', null, now);
    return { resolution: { status: 'expired', line: 'That draft has expired. Nothing written.' } };
  }
  if (proposal.status !== 'pending') {
    return { resolution: { status: 'gone', line: 'That draft was already answered.' } };
  }
  return { proposal };
}

/**
 * He tapped Approve. The tool runs through `runGatedTool` — the chat write path
 * — with a `confirm` that answers yes only if the card drawn NOW is the card he
 * was shown. Refusals write nothing and say why, in the thread and on the card.
 */
export async function approveProposal(
  db: Database,
  id: string,
  options: { now?: Date; clock?: () => Date } = {}
): Promise<ProposalResolution> {
  if (inFlight.has(id)) return { status: 'gone', line: 'Already being answered.' };
  const now = options.now ?? new Date();
  const found = answerable(db, id, now);
  if ('resolution' in found) return found.resolution;
  const p = found.proposal;

  const refuse = (reason: string, result: string): ProposalResolution => {
    resolve(db, id, 'refused', reason, now);
    recordInThread(db, `The Coach’s draft was not written: ${reason}`, {
      id: `proposal-${p.id}`,
      name: p.tool,
      input: p.input,
      result,
      isError: true,
    });
    return { status: 'refused', line: reason };
  };

  const tool = toolByName(p.tool);
  if (!tool || tool.readOnly) {
    return refuse(`${p.tool} is not a change ARC can make any more.`, 'Unknown write tool.');
  }
  // The finding it answered, re-read before anything else: resolved since
  // (by hand, or by an earlier draft) means this one fixes nothing.
  const finding = p.finding ?? null;
  const findingIssue = finding !== null ? findingProblem(db, finding, now) : null;
  if (findingIssue !== null) {
    return refuse(
      `${findingIssue} since the Coach drafted this. Nothing written.`,
      'Refused at approval: the finding it answered is no longer open.'
    );
  }

  inFlight.add(id);
  try {
    // The approval's clock, exactly as a chat turn's: one instant for the card
    // and the write, and the live clock for "has it already happened".
    const context: CoachToolContext = { now, clock: options.clock ?? (() => new Date()) };
    // A holder, not a let: TypeScript does not see an assignment made inside
    // the callback, and would narrow a bare variable to null.
    const stale: { reason: string | null } = { reason: null };
    const outcome = await runGatedTool(db, tool, p.input, context, async (card) => {
      const fresh = snapshotOf(card, context);
      if (card.summary === p.summary && JSON.stringify(fresh) === JSON.stringify(p.snapshot)) {
        return true;
      }
      stale.reason =
        card.summary === p.summary
          ? `the record behind "${p.summary}" changed since the Coach drafted it`
          : `the card said "${p.summary}", it now reads "${card.summary}"`;
      return false;
    });

    if (stale.reason !== null) {
      return refuse(
        `${stale.reason}. Nothing written. Ask the Coach to look again.`,
        'Refused at approval: the card no longer matched what the user was shown.'
      );
    }
    if (outcome.isError) {
      return refuse(`${outcome.content.replace(/\s+$/, '')}`, outcome.content);
    }
    const receipt = outcome.receipt ?? p.summary;
    resolve(db, id, 'approved', receipt, now);
    recordInThread(db, 'You approved the Coach’s draft.', {
      id: `proposal-${p.id}`,
      name: p.tool,
      input: p.input,
      result: outcome.content,
      receipt,
    });
    return { status: 'approved', line: receipt };
  } finally {
    inFlight.delete(id);
  }
}

/**
 * He tapped Decline. Recorded as a chat decline is — a tool record marked
 * `declined` with the card's line — so the thread prints "Declined, not saved"
 * and the next turn is told not to draft it again.
 */
export function declineProposal(
  db: Database,
  id: string,
  now: Date = new Date()
): ProposalResolution {
  if (inFlight.has(id)) return { status: 'gone', line: 'Already being answered.' };
  const found = answerable(db, id, now);
  if ('resolution' in found) return found.resolution;
  const p = found.proposal;
  resolve(db, id, 'declined', null, now);
  recordInThread(db, 'You declined the Coach’s draft.', {
    id: `proposal-${p.id}`,
    name: p.tool,
    input: p.input,
    result: DECLINED_RESULT,
    declined: true,
    declinedSummary: p.summary,
  });
  return { status: 'declined', line: p.summary };
}

// --- The model-voiced brief ---------------------------------------------------------

/** The brief on Home is three to five lines; more is cut, fewer is allowed. */
export const BRIEF_MAX_LINES = 5;

/**
 * Keep the brief lines whose every number traces to something the pass READ —
 * the state block and its tool results — by the harness the eval suite already
 * trusts (provenance.ts). A line carrying a figure from nowhere is dropped,
 * whole: a brief is the first thing he reads, and a wrong number there costs
 * more than a missing line. What survives is capped at five.
 */
export function vetBrief(
  lines: string[],
  sources: string[]
): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const line of lines) {
    if (checkNumberProvenance(line, sources).unsourced.length === 0) kept.push(line);
    else dropped.push(line);
  }
  return { kept: kept.slice(0, BRIEF_MAX_LINES), dropped };
}

export function saveBrief(db: Database, lines: string[], now: Date = new Date()): void {
  writeSection(db, 'coachBrief', {
    day: todayISODate(now),
    lines,
    at: now.toISOString(),
  });
  bump();
}

/** Today's model-voiced brief, or null — Home then shows the deterministic one. */
export function getBrief(db: Database, now: Date = new Date()): string[] | null {
  const section = readSection(db, 'coachBrief');
  if (!section || typeof section !== 'object' || Array.isArray(section)) return null;
  const record = section as Record<string, unknown>;
  if (record.day !== todayISODate(now) || !Array.isArray(record.lines)) return null;
  const lines = record.lines.filter((l): l is string => typeof l === 'string' && l.length > 0);
  return lines.length > 0 ? lines : null;
}
