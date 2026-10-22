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
 * db/coach-proposals.test.mjs).
 */
import type { Database } from '@/lib/db/database';

import type { ToolExecutionOutcome } from './model-client';
import {
  DEFAULT_WRITE_META,
  humanizeToolName,
  type CoachTool,
  type CoachToolContext,
  type WriteKind,
  type WriteMeta,
} from './tools/index';

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

/**
 * Run one tool call: a read runs; a write draws its card, asks `confirm`, and
 * executes only on a yes. With no `confirm`, every write is declined.
 *
 * `confirm` is awaited OUTSIDE any try: a throw from it propagates to the
 * caller rather than being reported as the tool's own error.
 */
export async function runGatedTool(
  db: Database,
  tool: CoachTool,
  input: Record<string, unknown>,
  context: CoachToolContext,
  confirm?: (request: WriteConfirmation) => Promise<boolean>
): Promise<ToolExecutionOutcome> {
  // The line the user approved, held for the receipt below. Stays undefined
  // for reads (nothing to receipt) and for any write that never reached
  // `execute` — which is the entire mechanism: see the return.
  let approvedSummary: string | undefined;

  if (!tool.readOnly) {
    let card: WriteCard;
    try {
      card = drawWriteCard(tool, input, db, context);
    } catch (error) {
      // Invalid input surfaces at summary time — report it, don't gate.
      return { content: errorText(error), isError: true };
    }
    const approved = confirm
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
    const content = await tool.execute(db, input, context);
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
    // afterwards says the same thing the consent said.
    return { content, ...(approvedSummary ? { receipt: approvedSummary } : {}) };
  } catch (error) {
    return { content: errorText(error), isError: true };
  }
}
