import { useCallback, useEffect, useRef, useState } from 'react';

import { streamCoachReply } from '@/lib/ai/coach-service';
import type { ChatMessage } from '@/types/coach';

export type CoachChat = {
  messages: ChatMessage[];
  /** True while a reply is streaming — input is disabled and the dots show. */
  isResponding: boolean;
  send: (text: string) => void;
  /** Re-run the last user turn after a failure. */
  retry: () => void;
};

/** Monotonic id: timestamp for ordering, counter to break same-millisecond ties. */
function makeId(seq: number): string {
  return `${Date.now()}-${seq}`;
}

/**
 * Owns the Coach conversation.
 *
 * In-memory for now — there is no `ai_messages` table yet and the prompt for
 * this build is UX, not persistence. Swapping to the local `ai_messages` table
 * later means loading history here and writing through `send`; the component
 * contract does not change.
 *
 * Concurrency model: all side effects (id generation, starting a stream) run in
 * the event handlers, never inside a `setState` updater. React may invoke an
 * updater more than once (StrictMode dev double-invoke, interrupted concurrent
 * renders), so an updater that started a stream could fire two replies to one
 * message. State is mirrored in `messagesRef` so handlers can read the latest
 * committed thread synchronously without threading it through an updater, and
 * `busyRef` is a synchronous re-entrancy guard that closes the window between
 * calling `send` and React committing `isResponding`.
 */
export function useCoachChat(intro: ChatMessage[] = []): CoachChat {
  const [messages, setMessagesState] = useState<ChatMessage[]>(intro);
  const [isResponding, setIsResponding] = useState(false);

  // Mirror of `messages`, always current, so handlers never read stale state.
  const messagesRef = useRef<ChatMessage[]>(intro);
  const setMessages = useCallback(
    (next: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
      const value = typeof next === 'function' ? next(messagesRef.current) : next;
      messagesRef.current = value;
      setMessagesState(value); // concrete value → the updater React runs stays pure
    },
    []
  );

  const seq = useRef(0);
  const nextId = () => makeId(++seq.current);

  // Synchronous "a reply is in flight" flag. `isResponding` is the UI mirror,
  // but it lags a commit; this guard is what actually prevents a double send.
  const busyRef = useRef(false);

  // Abort an in-flight stream if the screen unmounts mid-reply.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(
    (history: ChatMessage[]) => {
      busyRef.current = true;
      setIsResponding(true);

      const assistantId = nextId();
      setMessages([
        ...history,
        { id: assistantId, role: 'assistant', content: '', createdAt: Date.now(), streaming: true },
      ]);

      const controller = new AbortController();
      abortRef.current = controller;

      const patch = (fn: (m: ChatMessage) => ChatMessage) =>
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? fn(m) : m)));

      streamCoachReply(history, {
        signal: controller.signal,
        onToken: (chunk) => patch((m) => ({ ...m, content: m.content + chunk })),
      })
        .then(() => patch((m) => ({ ...m, streaming: false })))
        .catch((err: unknown) => {
          if (err instanceof Error && err.name === 'AbortError') return; // unmounted; drop it
          patch((m) => ({ ...m, streaming: false, error: true }));
        })
        .finally(() => {
          if (abortRef.current === controller) abortRef.current = null;
          busyRef.current = false;
          setIsResponding(false);
        });
    },
    [setMessages]
  );

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0 || busyRef.current) return;

      const userMessage: ChatMessage = {
        id: nextId(),
        role: 'user',
        content: trimmed,
        createdAt: Date.now(),
      };
      const history = [...messagesRef.current, userMessage];
      setMessages(history);
      run(history);
    },
    [run, setMessages]
  );

  const retry = useCallback(() => {
    if (busyRef.current) return;

    // Drop only the trailing failed assistant turn, then replay from the user
    // message before it. Errored bubbles earlier in the thread are left alone.
    const current = messagesRef.current;
    const last = current[current.length - 1];
    const cleaned = last?.role === 'assistant' && last.error ? current.slice(0, -1) : current;
    if (cleaned[cleaned.length - 1]?.role !== 'user') return;

    setMessages(cleaned);
    run(cleaned);
  }, [run, setMessages]);

  return { messages, isResponding, send, retry };
}
