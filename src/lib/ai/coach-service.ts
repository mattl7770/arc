import { fetch as expoFetch } from 'expo/fetch';

import type { ChatMessage } from '@/types/coach';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';

import { runCoachTurn, type FetchLike, type WireMessage } from './model-client';
import { apiKeyStore } from './api-key-store';
import { buildCoachSystemPrompt } from './system-prompt';
import { COACH_TOOLS, toolByName, toWireTools } from './tools';
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
};

/** Bound the request: the model doesn't need the whole thread forever. */
const MAX_HISTORY_MESSAGES = 30;

/** "get_metric_series" → "metric series" — the caption chips' vocabulary. */
export function humanizeToolName(name: string): string {
  return name.replace(/^(get|list|log|set|complete|dismiss)_/, '').replace(/_/g, ' ');
}

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
  const windowed = history.slice(-MAX_HISTORY_MESSAGES).filter((m) => m.content.trim().length > 0);
  // The API requires the first message to be a user turn — the window boundary
  // can land mid-pair, so shed any leading assistant turns.
  while (windowed.length > 0 && windowed[0]!.role !== 'user') windowed.shift();
  const messages: WireMessage[] = windowed.map((m) => ({ role: m.role, content: m.content }));

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
      system: buildCoachSystemPrompt({ date: todayISODate() }),
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

        if (!tool.readOnly) {
          let summary: string;
          try {
            summary =
              tool.confirmSummary?.(input as Record<string, unknown>, db) ??
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
              content: 'The user declined this action. Do not retry it; acknowledge and move on.',
              declined: true,
            };
          }
        }

        try {
          // `await` handles both sync tools (a plain string) and async ones
          // (search_knowledge embeds the query on-device); a rejection lands in
          // the catch below exactly like a synchronous throw.
          return {
            content: await tool.execute(db, input as Record<string, unknown>, { now: new Date() }),
          };
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
