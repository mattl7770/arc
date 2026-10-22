import { fetch as expoFetch } from 'expo/fetch';

import type { ChatMessage } from '@/types/coach';
import { getDb } from '@/lib/db/client';
import { calendarBlockFor } from '@/lib/calendar/context';

import { runCoachTurn, type FetchLike } from './model-client';
import { apiKeyStore } from './api-key-store';
import { buildCoachSystemPrompt } from './system-prompt';
import { buildTurnContext } from './turn-context';
import { buildWireHistory } from './history-window';
import { deviceRegion, regionLine } from './region';
import { COACH_WEB_SEARCH_MAX_USES } from './web-search';
import {
  COACH_TOOLS,
  humanizeToolName,
  toolByName,
  toWireTools,
  type CoachToolContext,
} from './tools';
import { getSaveLogsAtOnce } from '@/lib/db/repositories/coach-autosave-setting';

import { autoSaveTurn, runGatedTool, type WriteConfirmation } from './write-gate';
import type { CoachTurnResult } from './types';

/**
 * The Coach service seam — the ONE place a model call happens.
 *
 * Two paths behind one function:
 *   - REAL (a session key is set): the full agentic loop against the Messages
 *     API via src/lib/ai/model-client.ts — the model reads and writes the
 *     on-device database through the tool registry, with every write gated on
 *     user confirmation (options.confirmWrite) — except a simple log the user
 *     stated, which saves at once with an Undo while Settings › Coach allows
 *     it (write-gate.ts, "Saving at once").
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

/** A write tool call awaiting the user's decision — defined in write-gate.ts. */
export type { WriteConfirmation } from './write-gate';

export type StreamOptions = {
  onToken: (chunk: string) => void;
  signal?: AbortSignal;
  /**
   * Consequential-write gate: resolve true to run the tool, false to decline.
   * When absent, every write is declined — reads never ask — and nothing
   * saves at once either: a caller with no gate gets no writes at all.
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
  // The calendar section (2026-10-21): null unless the owner turned the switch
  // on in Settings › Coach; read fresh or from a few minutes' memory, never
  // from the database. Never throws and times out on its own.
  const calendar = await calendarBlockFor(db, clock());
  // SAVING AT ONCE (owner, 2026-10-21): the state the gate judges simple logs
  // against — what he typed in THIS turn, and how many have saved. Only when
  // the switch is on and the turn answers a message of his; otherwise every
  // write goes to a card, exactly as before (write-gate.ts module note).
  const latest = history[history.length - 1];
  const autoSave =
    options.confirmWrite && latest?.role === 'user' && getSaveLogsAtOnce(db)
      ? autoSaveTurn(latest.content)
      : undefined;

  const result = await runCoachTurn(
    {
      apiKey,
      model: apiKeyStore.getModel(),
      // expo/fetch streams response bodies in React Native (WHATWG fetch there
      // does not), with no native dependency. Structurally a FetchLike; the
      // cast bridges Expo's own response typings.
      fetchImpl: expoFetch as unknown as FetchLike,
      callType: 'chat',
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
      systemContext: buildTurnContext(db, clock(), {
        region: regionLine(deviceRegion()),
        calendar,
      }),
      messages,
      tools: toWireTools(COACH_TOOLS),
      // The provider's web search, whenever the model judges it helps (the
      // owner's call, 2026-10-21). Off when he turns it off in Settings › Coach,
      // and dropped by the client for a model with no known tool version.
      // Also off for the rest of the session once the API has refused the
      // tool on this key (model-client.ts searchToolRefused).
      webSearch: apiKeyStore.isWebSearchUsable() ? { maxUses: COACH_WEB_SEARCH_MAX_USES } : null,
    },
    {
      onToken: options.onToken,
      signal: options.signal,
      onWebSearchUnavailable: () => apiKeyStore.markWebSearchUnavailable(),
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
        //
        // `clock` rides along for one question only: what has already happened
        // by the approval (a planned notification firing while a cancel card or
        // the off switch's card is open). It never derives a value that is
        // written — no day, no time.
        const context: CoachToolContext = { now: clock(), clock };

        // The card, the gate, the execute and the receipt are write-gate.ts's:
        // ONE path, shared with an approved Coach proposal (proposals.ts), so a
        // tap on Home runs exactly what a tap in this thread runs. The rules
        // that path carries — a decline scoped to one call, a receipt minted
        // only past `execute`, a simple log that saves at once — are
        // documented there.
        return runGatedTool(
          db,
          tool,
          input as Record<string, unknown>,
          context,
          options.confirmWrite,
          autoSave
        );
      },
    }
  );

  // A refusal can arrive with no text streamed; leave the bubble honest.
  if (result.stopReason === 'refusal' && result.text.trim().length === 0) {
    const line = 'I can’t help with that request.';
    options.onToken(line);
    // Both: the transcript is empty exactly when the settled text is.
    return { ...result, text: line, transcript: line };
  }
  return result;
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

  return { text: reply, transcript: reply, toolCalls: [], stopReason: 'end_turn' };
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
      'Morning. No model is connected this session, so this is a preview. Paste an API key ' +
      "in the panel above and I'll answer from your actual data."
    );
  }

  if (asksAboutData) {
    return (
      "I can't answer that in this session: no model is connected, so I won't pretend to " +
      'read your labs, wearables, or logs. Paste an API key in the panel above and ' +
      "I'll answer with your actual numbers."
    );
  }

  return (
    "Noted. I'm running as a preview — no model is connected this session, so I won't " +
    "pretend to have answers I can't ground. Paste an API key in the panel above."
  );
}
