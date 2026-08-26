import { fetch as expoFetch } from 'expo/fetch';

import type { ChatMessage } from '@/types/coach';
import { getDb } from '@/lib/db/client';

import { runCoachTurn, type FetchLike } from './model-client';
import { apiKeyStore } from './api-key-store';
import { buildCoachSystemPrompt } from './system-prompt';
import { buildTurnContext } from './turn-context';
import { buildWireHistory } from './history-window';
import {
  COACH_TOOLS,
  humanizeToolName,
  toolByName,
  toWireTools,
  type CoachToolContext,
} from './tools';
import type { CoachTurnResult } from './types';

/**
 * The Coach service seam — the ONE place a model call happens.
 *
 * Two paths behind one function:
 *   - REAL (a session key is set): the full agentic loop against the Messages
 *     API via src/lib/ai/model-client.ts — the model reads and writes the
 *     on-device database through the tool registry, with every write gated on
 *     user confirmation (options.confirmWrite).
 *   - MOCK (no key): the honest preview. It deliberately does NOT fake
 *     intelligence — a coach that confidently makes things up is worse than
 *     one that admits its wiring isn't finished.
 *
 * The key and the chosen model come from the persistent key store
 * (src/lib/ai/api-key-store.ts) — held in the iOS Keychain, hydrated into an
 * in-memory mirror at boot. Everything but the model call itself runs on-device.
 */

/**
 * Whether the Coach is live (a key is set). UI reads this to decide whether to
 * show the "preview" affordances; re-render via useSessionKeySet() so it stays
 * current.
 */
export function isCoachKeyConfigured(): boolean {
  return apiKeyStore.has();
}

/** A write tool call awaiting the user's decision. */
export type WriteConfirmation = {
  tool: string;
  /** The one human line to show: "Log weight 178.0 lb". */
  summary: string;
};

export type StreamOptions = {
  onToken: (chunk: string) => void;
  signal?: AbortSignal;
  /**
   * Consequential-write gate: resolve true to run the tool, false to decline.
   * When absent, every write is declined — reads never ask.
   */
  confirmWrite?: (request: WriteConfirmation) => Promise<boolean>;
  /** Tool activity for the UI ("Reading metric series…"). */
  onToolCall?: (call: { name: string; label: string }) => void;
  /**
   * The thread's rolling summary of turns that have aged out of the window
   * (ai_conversations.summary, 0030) — prepended so a long thread keeps its
   * spine instead of silently losing its first half.
   */
  priorSummary?: string | null;
  /**
   * The turn's clock source. Injectable for the same reason
   * {@link CoachToolContext} takes one — a headless test must be able to place
   * the turn at a chosen instant, and to move that instant between the moment a
   * confirmation card is rendered and the moment the user approves it
   * (db/coach-tools.test.mjs). The app never passes it; on device this is
   * `new Date`.
   *
   * It is a FACTORY, not a fixed `Date`, because a turn is long-lived: reads
   * spread over minutes of streaming and approval latency, and each tool call
   * must run against the wall clock as it is when that call happens, not as it
   * was when the user hit send. What must NOT vary is the clock WITHIN one tool
   * call — see the single read in `executeTool` below.
   */
  now?: () => Date;
};

/**
 * Streams the Coach's reply to the latest user message, emitting text chunks
 * via `onToken` as they arrive, executing tool calls (writes only after
 * confirmation) along the way. Returns the full turn record once complete.
 *
 * @param history  The conversation so far, oldest first, ending in the user
 *                 turn being answered.
 */
export async function streamCoachReply(
  history: ChatMessage[],
  options: StreamOptions
): Promise<CoachTurnResult> {
  const apiKey = apiKeyStore.get();
  if (!apiKey) return mockTurn(history, options);

  const db = getDb();
  // The ONE clock this turn reads. Every `new Date()` that used to be scattered
  // through this function goes through it, so a test can place the turn — and
  // move it mid-turn — deterministically.
  const clock = options.now ?? (() => new Date());
  // Windowing, the leading-assistant shed, and the tool-result digests all live
  // in buildWireHistory (src/lib/ai/history-window.ts) — pure, so the same code
  // is headless-tested. It also folds in the rolling summary of turns that have
  // aged out, which the inline version here could not.
  // The clock also dates the thread: turns are stamped at each calendar
  // boundary so the model can see how old the conversation it is reading is
  // (history-window.ts). Without that every past turn read as "now".
  const messages = buildWireHistory(history, options.priorSummary, clock());

  const result = await runCoachTurn(
    {
      apiKey,
      model: apiKeyStore.getModel(),
      // expo/fetch streams response bodies in React Native (WHATWG fetch there
      // does not), with no native dependency. Structurally a FetchLike; the
      // cast bridges Expo's own response typings.
      fetchImpl: expoFetch as unknown as FetchLike,
    },
    {
      // STATIC, and takes no arguments — it is the cached prefix, so anything
      // per-turn interpolated here would bust the cache on every request.
      system: buildCoachSystemPrompt(),
      // Everything per-turn (date, profile, mode, readiness, today's wearable
      // numbers, mission, experiments, memory, declines, the brief) rides an
      // UNCACHED second system block after the breakpoint. Read at turn start,
      // which is when the prompt is built and sent; a tool call minutes later
      // reads the clock again for itself (below) rather than inheriting this
      // instant.
      systemContext: buildTurnContext(db, clock()),
      messages,
      tools: toWireTools(COACH_TOOLS),
    },
    {
      onToken: options.onToken,
      signal: options.signal,
      onToolCall: ({ name }) => options.onToolCall?.({ name, label: humanizeToolName(name) }),
      executeTool: async (name, input) => {
        const tool = toolByName(name);
        if (!tool) return { content: `Unknown tool: ${name}.`, isError: true };

        // THE turn clock for this tool call — read ONCE, here, above the
        // confirmation gate, and handed to both halves of the call. This is the
        // whole fix: the card the user approves and the row that lands must be
        // computed from the SAME instant.
        //
        // Both halves derive a DAY from it (a bare-time one-off reminder pins to
        // today or tomorrow depending on whether that clock time has gone by; a
        // log without an explicit `date` lands on today). Reading the clock a
        // second time after `await confirmWrite` — which suspends for however
        // long the user takes to decide — lets those two answers disagree
        // whenever the approval straddles a boundary: a card rendered at
        // 08:59:30 for "at 09:00" shows a bare time, and the row written at
        // 09:00:10 is dated tomorrow. One read, one instant, no window.
        //
        // Frozen only for the DURATION OF THIS CALL, deliberately: the user
        // approved what the card said, so the write must be what the card said.
        // The next tool call reads the clock again.
        //
        // The card VALIDATES against this same instant too, so a knowable
        // failure (a log date in the future, a mode window that ends before it
        // begins) throws before the user spends an Approve tap on it.
        const context: CoachToolContext = { now: clock() };

        // The line the user approved, held for the receipt below. Stays
        // undefined for reads (nothing to receipt) and for any write that never
        // reached `execute` — which is the entire mechanism: see the return.
        let approvedSummary: string | undefined;

        if (!tool.readOnly) {
          let summary: string;
          try {
            summary =
              tool.confirmSummary?.(input as Record<string, unknown>, db, context) ??
              humanizeToolName(tool.name);
          } catch (error) {
            // Invalid input surfaces at summary time — report it, don't gate.
            return { content: errorText(error), isError: true };
          }
          const approved = options.confirmWrite
            ? await options.confirmWrite({ tool: name, summary })
            : false;
          if (!approved) {
            return {
              // THE SCOPE OF A DECLINE IS ONE TOOL CALL, NOT THE REQUEST.
              //
              // This used to read "…Do not retry it; acknowledge and move on."
              // Owner report, 2026-08-12: asked to *"come up with a recipe AND
              // add the stuff to my grocery list"*, the Coach proposed
              // save_recipe, had it declined, said "Understood, I won't save
              // it" — and never attempted the grocery half at all. It read
              // "move on" as "move on from the request", which is the wrong
              // scope and the only reading the old sentence supported.
              //
              // Declining one write is a statement about that write. Whatever
              // else the user asked for is still owed, unless it depended on
              // the thing they refused — and only the model can judge that, so
              // the wording says the rule and leaves the judgement where it
              // belongs (the JUDGMENT IS YOURS clause in the system prompt).
              content:
                'The user declined THIS action. Do not retry it and do not re-ask. ' +
                'The decline is about this one write, NOT about their whole request: ' +
                'carry on with any other part of it that does not depend on what they refused.',
              declined: true,
            };
          }
          approvedSummary = summary;
        }

        try {
          // `await` handles both sync tools (a plain string) and async ones
          // (search_knowledge embeds the query on-device); a rejection lands in
          // the catch below exactly like a synchronous throw.
          const content = await tool.execute(db, input as Record<string, unknown>, context);
          // THE RECEIPT, and the one line in this file that makes a claimed
          // write and a real one distinguishable downstream.
          //
          // It is minted HERE and nowhere else, on the far side of `execute`, so
          // it exists only when a tool actually ran to completion against the
          // database. A declined write returned above; a throwing one lands in
          // the catch below; a read never set `approvedSummary`. The model
          // cannot reach this statement by writing a sentence, which is exactly
          // the owner's failure mode ("saying that a recipe has been saved when
          // the tool was not called"). The thread prints receipts, not prose.
          //
          // The text is the card's own summary — the line the user READ and
          // approved — rather than a re-description of the result, so the record
          // afterwards says the same thing the consent said.
          return { content, ...(approvedSummary ? { receipt: approvedSummary } : {}) };
        } catch (error) {
          return { content: errorText(error), isError: true };
        }
      },
    }
  );

  // A refusal can arrive with no text streamed; leave the bubble honest.
  if (result.stopReason === 'refusal' && result.text.trim().length === 0) {
    const line = 'I can’t help with that request.';
    options.onToken(line);
    return { ...result, text: line };
  }
  return result;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Tool execution failed.';
}

// --- The honest mock (no key set) --------------------------------------------

/** Sleep that rejects promptly if the turn is aborted mid-stream. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(id);
      reject(abortError());
    };
    // Remove the listener on the normal path too, so an N-token stream doesn't
    // accumulate N abort listeners on the signal for the run's lifetime.
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

async function mockTurn(history: ChatMessage[], options: StreamOptions): Promise<CoachTurnResult> {
  const latest = [...history].reverse().find((m) => m.role === 'user');
  const reply = mockReply(latest?.content ?? '');

  // Simulate token streaming so the UX that ships today is the UX that ships
  // with the real model: typing indicator, then words arriving in a cadence.
  const tokens = reply.match(/\S+\s*/g) ?? [reply];
  await delay(280, options.signal); // "thinking" beat before the first token
  for (const token of tokens) {
    options.onToken(token);
    await delay(18 + token.length * 6, options.signal);
  }

  return { text: reply, toolCalls: [], stopReason: 'end_turn' };
}

/**
 * An in-character but honest preview response. It reflects the Coach voice
 * (calm, direct, specific about what it can and cannot yet do) without
 * pretending to have read data it has no access to.
 */
function mockReply(userText: string): string {
  const text = userText.toLowerCase();

  const asksAboutData =
    /\b(hrv|recovery|sleep|steps|strain|lab|biomarker|apo|ldl|weight|protocol|stack)\b/.test(text);
  const isGreeting = /\b(hi|hey|hello|morning|good morning)\b/.test(text.trim());

  if (isGreeting) {
    return (
      "Morning. I'm here, but I should be straight with you: no model is connected this " +
      'session, so this is the chat foundation, not the intelligence. Paste an API key in ' +
      "the panel above and I'll answer from your actual data — trends, today's log, " +
      'reminders, all of it. What would you want me to look at first?'
    );
  }

  if (asksAboutData) {
    return (
      "Good question — and exactly the kind I'm built to answer. I can't yet in this " +
      "session: no model is connected, so I won't pretend to read your labs, wearables, " +
      "or logs. Paste an API key in the panel above and I'll answer this with your " +
      'actual numbers and the trend behind them, not a generic take.'
    );
  }

  return (
    "Noted. I'm running as a preview right now — the chat works end to end, but no model " +
    "is connected this session, so I won't pretend to have answers I can't ground. " +
    'Paste an API key in the panel above and this same thread becomes the real thing.'
  );
}
