/**
 * The write gate — ONE function that takes a tool call from input to result,
 * drawing the card, asking, and executing only on a yes.
 *
 * It lived inline in coach-service.ts's `executeTool` until the Coach could
 * draft a change while nobody was watching (Coach proposals, 2026-10-21). An
 * approval tapped on Home hours after the pass drew its card has to run the
 * SAME path a chat approval runs — the same card drawing, the same receipt
 * rule, the same execute — or "Approve executes exactly what the card said"
 * is a claim about two code paths that happen to agree today. So the path
 * moved here, and both callers use it:
 *
 *   chat       coach-service.ts: the card is drawn, the loop suspends on
 *              `confirmWrite`, the user answers.
 *   proposals  proposals.ts: the card was drawn and stored at pass time; at
 *              the tap it is drawn AGAIN through this function, and `confirm`
 *              answers yes only when the redrawn card is the stored one.
 *
 * Pure over the {@link Database} interface and the registry — no fetch, no
 * React — so both are headless-tested (db/coach-tools.test.mjs,
 * db/coach-proposals.test.mjs, db/coach-autosave.test.mjs).
 *
 * ## Saving at once (owner, 2026-10-21 — against the recommendation)
 *
 * *"Simple logs the Coach makes for him in chat save at once, with an Undo."*
 * The gate is also where that happens, so it is the same path and not a
 * second one: the card is still drawn (its line is the receipt), `execute`
 * still runs here, and the receipt is still minted only past it. What changes
 * for a qualifying call is who answers the gate — this file, in code, instead
 * of a tap. A call qualifies only when ALL of these hold:
 *
 *   - the caller passed an {@link AutoSaveState}: the chat does, while
 *     Settings › Coach › "Save simple logs at once" is on; the unattended pass
 *     and an approved proposal never do;
 *   - the tool declares `autoApprove` AND `undoDomain` (the five simple logs);
 *   - its predicate says yes for this input (tools/write-tools.ts "Saving at
 *     once": the logical today, every figure and word the user's own);
 *   - it is not a repeat of a call already saved at once this turn, and fewer
 *     than {@link AUTO_SAVE_TURN_CAP} have been — a batch keeps its cards.
 *
 * Its Undo is that domain's own delete, through this same function
 * ({@link undoSavedAtOnce}), and refuses if the row changed since it saved.
 */
import type { Database } from '@/lib/db/database';

import type { ToolExecutionOutcome } from './model-client';
import {
  DEFAULT_WRITE_META,
  humanizeToolName,
  toolByName,
  type AutoSaveTurn,
  type CoachTool,
  type CoachToolContext,
  type WriteKind,
  type WriteMeta,
} from './tools/index';
import type { CoachToolCall } from './types';

/** A write tool call awaiting the user's decision. */
export type WriteConfirmation = {
  tool: string;
  /** The one human line to show: "Log weight 178.0 lb". */
  summary: string;
  /**
   * What is being approved. Only `'delete'` changes the card's copy today — its
   * fixed "This is written to your on-device record" line is false for a
   * removal — but the card could never tell one write from another by anything
   * except the tool NAME before this existed, which is why it kept a hardcoded
   * allowlist of four names.
   */
  kind: WriteKind;
  /**
   * Whether the summary is already the whole consequence (the SHORT card).
   * Declared by the tool, defaulted to false — the card's own proposal, made
   * real: each tool now says its own weight beside the `confirmSummary` that is
   * the only place that knows what that summary says.
   */
  selfEvident: boolean;
};

/** A drawn card: the line, and its weight. */
export type WriteCard = { summary: string; meta: WriteMeta };

/**
 * Draw a write's card from validated input. THROWS for any knowable failure —
 * invalid input, an id that names nothing, a date in the future — so a write
 * that can only error never costs an Approve tap.
 *
 * `context` is mutated by the generic tools (the staleness slot,
 * `CoachToolContext.card`; `log_workout`'s `trainingRow`), and the SAME object
 * must reach `execute`: that is how the card the user read and the row that
 * lands are computed from one instant and one reading.
 */
export function drawWriteCard(
  tool: CoachTool,
  input: Record<string, unknown>,
  db: Database,
  context: CoachToolContext
): WriteCard {
  const summary = tool.confirmSummary?.(input, db, context) ?? humanizeToolName(tool.name);
  // AFTER the summary, and against the same `context`: the generic write path
  // writes its staleness slot inside `confirmSummary`, and a tool's weight can
  // depend on what that summary turned out to say. Fail closed — a tool that
  // declares nothing gets the long card.
  const meta = tool.confirmMeta?.(input, db, context) ?? DEFAULT_WRITE_META;
  return { summary, meta };
}

/**
 * What a declined write tells the model.
 *
 * THE SCOPE OF A DECLINE IS ONE TOOL CALL, NOT THE REQUEST.
 *
 * This used to read "…Do not retry it; acknowledge and move on." Owner report,
 * 2026-08-12: asked to *"come up with a recipe AND add the stuff to my grocery
 * list"*, the Coach proposed save_recipe, had it declined, said "Understood, I
 * won't save it" — and never attempted the grocery half at all. It read "move
 * on" as "move on from the request", which is the wrong scope and the only
 * reading the old sentence supported.
 *
 * Declining one write is a statement about that write. Whatever else the user
 * asked for is still owed, unless it depended on the thing they refused — and
 * only the model can judge that, so the wording says the rule and leaves the
 * judgement where it belongs (the JUDGMENT IS YOURS clause in the system
 * prompt).
 */
export const DECLINED_RESULT =
  'The user declined THIS action. Do not retry it and do not re-ask. ' +
  'The decline is about this one write, NOT about their whole request: ' +
  'carry on with any other part of it that does not depend on what they refused.';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Tool execution failed.';
}

// --- Saving at once ----------------------------------------------------------

/**
 * At most this many writes save at once in one turn; the rest show cards.
 * "Creatine, magnesium and D3" is three things he said; a fourth record in one
 * turn is a batch, and a batch is what the card exists for.
 */
export const AUTO_SAVE_TURN_CAP = 3;

/** One chat turn's saving-at-once state: what he typed, and what has saved. */
export type AutoSaveState = AutoSaveTurn & {
  /** How many writes this turn saved at once. */
  saved: number;
  /** tool + input of each one, so a repeat call goes to a card, not twice in. */
  seen: Set<string>;
};

/** A fresh state for a chat turn answering `userText`. */
export function autoSaveTurn(userText: string): AutoSaveState {
  return { userText, saved: 0, seen: new Set() };
}

/**
 * The field a saved-at-once result carries, for the model and for the thread.
 * It rides the tool result (never the schema or the cached prompt), so the
 * model knows no card was shown and that he has an Undo, and the thread knows
 * which receipts were saved without a tap — after a reload too, because the
 * result is persisted in `ai_messages.tool_calls`.
 */
export const SAVED_AT_ONCE_FIELD = 'savedAtOnce';
const SAVED_AT_ONCE_NOTE =
  'No card was shown: a simple log saves at once, and the user has an Undo under your reply.';

/** Does this call save at once? Every rule in the module note, in code. */
function savesAtOnce(
  tool: CoachTool,
  input: Record<string, unknown>,
  db: Database,
  context: CoachToolContext,
  turn: AutoSaveState | undefined
): boolean {
  if (!turn || tool.readOnly || !tool.autoApprove || !tool.undoDomain) return false;
  if (turn.saved >= AUTO_SAVE_TURN_CAP) return false;
  const key = `${tool.name} ${JSON.stringify(input)}`;
  if (turn.seen.has(key)) return false;
  let yes = false;
  try {
    yes = tool.autoApprove(input, db, context, { userText: turn.userText }) === true;
  } catch {
    yes = false; // a predicate that cannot decide is a no
  }
  if (!yes) return false;
  turn.seen.add(key);
  turn.saved += 1;
  return true;
}

/** Where an Undo stands. */
export type UndoState = 'open' | 'undone' | 'refused';

/** One saved-at-once write's Undo, held for the rest of the app session. */
export type UndoOffer = {
  /** `domain` + record id — {@link undoKeyFor}. */
  key: string;
  domain: string;
  id: string;
  /** The receipt: the card line that saved. */
  receipt: string;
  /** The removal card for the row as it saved — the staleness reference. */
  line: string;
  state: UndoState;
  /** For a refusal: why, in a sentence for the thread. */
  note?: string;
};

/**
 * THE UNDO LEDGER — in memory, for the app session, on purpose.
 *
 * An Undo is for a slip caught while the reply is in front of him, so it lives
 * as long as the thread he is reading does: a restart clears it, and the
 * receipt stays without one. After that the row is undone where every row is,
 * on its own screen (the Log tab's ×, the meal screen's Delete), or by asking.
 * Nothing about it is persisted, so a reloaded thread can never offer an Undo
 * for a row it no longer knows the shape of.
 */
const undoOffers = new Map<string, UndoOffer>();

function undoKey(domain: string, id: string): string {
  return `${domain} ${id}`;
}

/** Keys with an Undo in flight. */
const undoing = new Set<string>();

/** What a refused Undo says when the row moved after it saved. */
const UNDO_CHANGED_NOTE =
  'It changed after it was saved, so it was not removed. Change or remove it on its own screen.';

/** Drop every Undo (tests; the ledger is otherwise the session's). */
export function clearUndoOffers(): void {
  undoOffers.clear();
}

/** The parsed result object of a tool call, or null. */
function resultObject(result: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(result);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Was this recorded call a write that saved at once? Read off the stored record. */
export function wasSavedAtOnce(call: CoachToolCall): boolean {
  if (!call.receipt || call.isError || call.declined) return false;
  return typeof resultObject(call.result)?.[SAVED_AT_ONCE_FIELD] === 'string';
}

/** The Undo key of a recorded call, or null when it did not save at once. */
export function undoKeyFor(call: CoachToolCall): string | null {
  if (!wasSavedAtOnce(call)) return null;
  const domain = toolByName(call.name)?.undoDomain;
  const id = resultObject(call.result)?.id;
  return domain && typeof id === 'string' ? undoKey(domain, id) : null;
}

/** The Undo for a key, if this session minted one. */
export function undoOfferFor(key: string): Readonly<UndoOffer> | undefined {
  return undoOffers.get(key);
}

/**
 * After a saved-at-once write: mark its result, and hold its Undo. The removal
 * card is drawn NOW, against the row as it landed, so a later Undo can tell
 * the row it would remove from the one that saved. A row whose card cannot be
 * drawn gets no Undo — the receipt still stands.
 */
function holdUndo(
  db: Database,
  tool: CoachTool,
  content: string,
  receipt: string,
  now: Date
): string {
  const result = resultObject(content);
  if (!result) return content;
  const id = result.id;
  const remover = toolByName('delete_record');
  if (typeof id === 'string' && tool.undoDomain && remover) {
    try {
      const card = drawWriteCard(remover, { domain: tool.undoDomain, id }, db, { now });
      const key = undoKey(tool.undoDomain, id);
      undoOffers.set(key, {
        key,
        domain: tool.undoDomain,
        id,
        receipt,
        line: card.summary,
        state: 'open',
      });
    } catch {
      // No removal card, no Undo. The save itself is done and receipted.
    }
  }
  return JSON.stringify({ ...result, [SAVED_AT_ONCE_FIELD]: SAVED_AT_ONCE_NOTE });
}

/**
 * Undo a write that saved at once: remove exactly that row through
 * `delete_record` — the same delete its own screen runs — through
 * {@link runGatedTool}, whose `confirm` answers yes only while the removal card
 * drawn now is the one drawn at the save. A row edited since (a new figure, a
 * photo added to the meal) or already removed refuses, and nothing is deleted.
 *
 * Returns the offer as it now stands (undefined when this session minted none).
 */
export async function undoSavedAtOnce(
  db: Database,
  key: string,
  now: Date = new Date()
): Promise<Readonly<UndoOffer> | undefined> {
  const offer = undoOffers.get(key);
  // One Undo at a time per row: a double tap must not run a second removal
  // that would find the row gone and overwrite "undone" with a refusal.
  if (!offer || offer.state !== 'open' || undoing.has(key)) return offer;
  undoing.add(key);
  try {
    return await undoOpen(db, offer, now);
  } finally {
    undoing.delete(key);
  }
}

async function undoOpen(db: Database, offer: UndoOffer, now: Date): Promise<UndoOffer> {
  const settle = (state: UndoState, note?: string) => {
    const next: UndoOffer = { ...offer, state, ...(note ? { note } : {}) };
    undoOffers.set(offer.key, next);
    return next;
  };
  const remover = toolByName('delete_record');
  if (!remover) return settle('refused', 'Undo is not available in this build.');
  const input = { domain: offer.domain, id: offer.id };

  let current: string;
  try {
    current = drawWriteCard(remover, input, db, { now }).summary;
  } catch {
    return settle('refused', 'It is no longer in your record, so there was nothing to undo.');
  }
  if (current !== offer.line) return settle('refused', UNDO_CHANGED_NOTE);
  const outcome = await runGatedTool(
    db,
    remover,
    input,
    { now },
    async (card) => card.summary === offer.line
  );
  if (outcome.receipt) return settle('undone');
  if (outcome.declined) return settle('refused', UNDO_CHANGED_NOTE);
  // The delete's own refusal (its staleness re-read, a repository refusal) is
  // worded for the model; the thread gets the user's sentence.
  return settle('refused', 'It could not be removed here. Remove it on its own screen.');
}

/**
 * Run one tool call: a read runs; a write draws its card, asks `confirm`, and
 * executes only on a yes. With no `confirm`, every write is declined.
 *
 * With `autoSave` (the chat, setting on), a write that qualifies answers its
 * own gate yes in code and is never put to `confirm`; everything after — the
 * execute, the receipt — is the same statement as an approved card's. Its
 * result gains {@link SAVED_AT_ONCE_FIELD} and its Undo is held.
 *
 * `confirm` is awaited OUTSIDE any try: a throw from it propagates to the
 * caller rather than being reported as the tool's own error.
 */
export async function runGatedTool(
  db: Database,
  tool: CoachTool,
  input: Record<string, unknown>,
  context: CoachToolContext,
  confirm?: (request: WriteConfirmation) => Promise<boolean>,
  autoSave?: AutoSaveState
): Promise<ToolExecutionOutcome> {
  // The line the user approved, held for the receipt below. Stays undefined
  // for reads (nothing to receipt) and for any write that never reached
  // `execute` — which is the entire mechanism: see the return.
  let approvedSummary: string | undefined;
  // True only for a write this gate answered itself (the module note).
  let atOnce = false;

  if (!tool.readOnly) {
    let card: WriteCard;
    try {
      card = drawWriteCard(tool, input, db, context);
    } catch (error) {
      // Invalid input surfaces at summary time — report it, don't gate.
      return { content: errorText(error), isError: true };
    }
    // Judged AFTER the card is drawn and against the same `context`, so a
    // call that can only error has already been refused above.
    atOnce = savesAtOnce(tool, input, db, context, autoSave);
    const approved = atOnce
      ? true
      : confirm
        ? await confirm({
            tool: tool.name,
            summary: card.summary,
            kind: card.meta.kind,
            selfEvident: card.meta.selfEvident,
          })
        : false;
    if (!approved) {
      return {
        content: DECLINED_RESULT,
        declined: true,
        // What the card said, so the thread can show what was refused once the
        // card is gone (CoachToolCall.declinedSummary).
        declinedSummary: card.summary,
      };
    }
    approvedSummary = card.summary;
  }

  try {
    // `await` handles both sync tools (a plain string) and async ones
    // (search_knowledge embeds the query on-device); a rejection lands in the
    // catch below exactly like a synchronous throw.
    const executed = await tool.execute(db, input, context);
    // Saved at once: the same receipt below, plus the marker and the Undo.
    // Past `execute` for the reason the receipt is — a write that threw holds
    // no Undo for a row that does not exist.
    const content =
      atOnce && approvedSummary
        ? holdUndo(db, tool, executed, approvedSummary, context.now)
        : executed;
    // THE RECEIPT, and the one line that makes a claimed write and a real one
    // distinguishable downstream.
    //
    // It is minted HERE and nowhere else, on the far side of `execute`, so it
    // exists only when a tool actually ran to completion against the database.
    // A declined write returned above; a throwing one lands in the catch
    // below; a read never set `approvedSummary`. The model cannot reach this
    // statement by writing a sentence, which is exactly the owner's failure
    // mode ("saying that a recipe has been saved when the tool was not
    // called"). The thread prints receipts, not prose.
    //
    // The text is the card's own summary — the line the user READ and
    // approved — rather than a re-description of the result, so the record
    // afterwards says the same thing the consent said. For a write that saved
    // at once it is the line the card WOULD have shown, which is what the
    // thread prints beside its Undo.
    return { content, ...(approvedSummary ? { receipt: approvedSummary } : {}) };
  } catch (error) {
    return { content: errorText(error), isError: true };
  }
}
