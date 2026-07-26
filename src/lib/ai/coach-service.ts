import type { ChatMessage } from '@/types/coach';

import { buildCoachSystemPrompt } from './system-prompt';

/**
 * The Coach service seam.
 *
 * This is the ONE place a model call happens. Today it returns an honest mock.
 * Per the local-first architecture (docs/decisions.md, 2026-07-24), the real
 * implementation calls a frontier model **directly from the app** using the
 * user's own key held in the iOS Keychain (expo-secure-store), with provider /
 * model / key user-editable in Settings — no server, no backend. On-device RAG +
 * tools run client-side. When that lands (Phase 3), only the body of
 * `streamCoachReply` changes; every caller and component stays the same.
 *
 * It deliberately does NOT fake intelligence. The mock is transparent about
 * being a preview rather than inventing data-grounded answers, because a coach
 * that confidently makes things up is worse than one that admits its wiring
 * isn't finished.
 */

/**
 * Flip to true when the user has configured a provider/model/API key and the
 * direct model call is wired (Phase 3). The UI reads this to decide whether to
 * show the "preview" affordance, so there is a single source of truth for "is
 * the Coach real yet".
 */
export const isCoachKeyConfigured = false;

export type StreamOptions = {
  onToken: (chunk: string) => void;
  signal?: AbortSignal;
};

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

/**
 * Streams the Coach's reply to the latest user message, emitting chunks via
 * `onToken` as they arrive. Returns the full text once complete.
 *
 * @param history  The conversation so far, oldest first, ending in the user
 *                 turn being answered.
 */
export async function streamCoachReply(
  history: ChatMessage[],
  options: StreamOptions
): Promise<string> {
  // Built and discarded so the wiring is real and type-checked today — the
  // direct model call will send exactly this. Grounding is thin until the data
  // layer feeds `summary`.
  void buildCoachSystemPrompt({ date: new Date().toDateString() });

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

  return reply;
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
      "Morning. I'm here, but I should be straight with you: I'm not connected to the " +
      'model or your data yet — this is the chat foundation. Once the model is connected, ' +
      "I'll open each day with a brief grounded in last night's sleep and recovery. What " +
      'would you want me to look at first?'
    );
  }

  if (asksAboutData) {
    return (
      "Good question — and exactly the kind I'm built to answer. I can't yet: I'm not " +
      'reading your labs, wearables, or logs until the data layer is connected. When it ' +
      "is, I'll answer this with your actual numbers and the trend behind them, not a " +
      'generic take. For now, treat me as a preview of the interface, not the intelligence.'
    );
  }

  return (
    "Noted. I'm running as a preview right now — the chat works end to end, but I'm not " +
    "connected to the model or your data yet, so I won't pretend to have answers I " +
    "can't ground. Once the model and your data are connected, this same thread " +
    'becomes the real thing.'
  );
}
