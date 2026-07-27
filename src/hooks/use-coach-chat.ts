import { useCallback, useEffect, useRef, useState } from 'react';

import { humanizeToolName, streamCoachReply } from '@/lib/ai/coach-service';
import { CoachTurnError } from '@/lib/ai/model-client';
import type { CoachToolCall } from '@/lib/ai/types';
import { getDb } from '@/lib/db/client';
import {
  appendMessage,
  getOrCreateActiveConversation,
  listMessages,
  parseToolCalls,
  setConversationTitle,
} from '@/lib/db/repositories/ai-chat';
import type { ChatMessage, PendingWrite } from '@/types/coach';

export type CoachChat = {
  messages: ChatMessage[];
  /** True while a reply is streaming — input is disabled and the dots show. */
  isResponding: boolean;
  /** What the Coach is doing right now ("reading metric series"), or null. */
  activity: string | null;
  /** A write tool call awaiting the user's decision, or null. */
  pendingWrite: PendingWrite | null;
  /**
   * Resolve a pending write — Approve (true) or Decline (false). `id` names
   * WHICH request; a stale id (double-tap racing the next gate) is ignored.
   */
  resolveWrite: (id: number, approved: boolean) => void;
  send: (text: string) => void;
  /** Re-run the last user turn after a failure. */
  retry: () => void;
};

export type CoachChatOptions = {
  /** Fired after a turn fully completes — refresh anything a tool may have written. */
  onTurnComplete?: () => void;
};

/** Monotonic id: timestamp for ordering, counter to break same-millisecond ties. */
function makeId(seq: number): string {
  return `${Date.now()}-${seq}`;
}

/** Load the persisted thread as view-models (conversational roles only). */
function loadThread(conversationId: string): ChatMessage[] {
  return listMessages(getDb(), conversationId)
    .filter((row) => row.role === 'user' || row.role === 'assistant')
    .map((row) => {
      const tools = parseToolCalls(row.tool_calls).map((call) => humanizeToolName(call.name));
      return {
        id: row.id,
        role: row.role as ChatMessage['role'],
        content: row.content,
        createdAt: Date.parse(row.created_at),
        ...(tools.length > 0 ? { tools } : {}),
      };
    });
}

/**
 * Owns the Coach conversation — persisted in `ai_conversations`/`ai_messages`
 * (0008), so a reload resumes the thread. op-sqlite is synchronous, so the
 * initial load runs in the `useState` initializers (no loading state), same
 * pattern as use-log-feed. Turns persist at their edges: the user row on send,
 * the assistant row (with its tool-call record) when the stream completes;
 * failed/aborted replies are not persisted, so retry replays cleanly.
 *
 * Concurrency model: all side effects (id generation, starting a stream,
 * DB writes) run in the event handlers, never inside a `setState` updater.
 * React may invoke an updater more than once (StrictMode dev double-invoke,
 * interrupted concurrent renders), so an updater that started a stream could
 * fire two replies to one message. State is mirrored in `messagesRef` so
 * handlers can read the latest committed thread synchronously, and `busyRef`
 * is a synchronous re-entrancy guard that closes the window between calling
 * `send` and React committing `isResponding`.
 *
 * The write-confirmation gate: when the model calls a write tool, the service
 * awaits `confirmWrite` — surfaced here as `pendingWrite` + `resolveWrite`.
 * The agentic loop stays suspended until the user decides; unmount resolves
 * as declined so nothing runs without an answer.
 */
export function useCoachChat(options: CoachChatOptions = {}): CoachChat {
  const [conversationId] = useState<string>(() => getOrCreateActiveConversation(getDb()).id);
  const [messages, setMessagesState] = useState<ChatMessage[]>(() => loadThread(conversationId));
  const [isResponding, setIsResponding] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [pendingWrite, setPendingWrite] = useState<PendingWrite | null>(null);

  // Mirror of `messages`, always current, so handlers never read stale state.
  const messagesRef = useRef<ChatMessage[]>(messages);
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

  // The suspended write-tool gate: resolving false declines, true approves.
  // Keyed by a nonce so a tap can only ever answer the request it was shown.
  const confirmResolverRef = useRef<{ id: number; resolve: (approved: boolean) => void } | null>(
    null
  );
  const pendingSeq = useRef(0);

  // Closed over by `run` — callers keep it referentially stable (useCallback)
  // so send/retry don't churn identity per render.
  const { onTurnComplete } = options;

  // Abort an in-flight stream (and unblock a pending gate) on unmount.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      abortRef.current?.abort();
      confirmResolverRef.current?.resolve(false);
      confirmResolverRef.current = null;
    },
    []
  );

  const resolveWrite = useCallback((id: number, approved: boolean) => {
    const current = confirmResolverRef.current;
    if (!current || current.id !== id) return; // stale tap — a different request is up now
    confirmResolverRef.current = null;
    setPendingWrite(null);
    current.resolve(approved);
  }, []);

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
        onToolCall: ({ label }) => setActivity(label),
        confirmWrite: (request) =>
          new Promise<boolean>((resolve) => {
            const id = ++pendingSeq.current;
            confirmResolverRef.current = { id, resolve };
            setPendingWrite({ id, ...request });
          }),
      })
        .then((result) => {
          const tools = result.toolCalls.map((call: CoachToolCall) => humanizeToolName(call.name));
          patch((m) => ({
            ...m,
            streaming: false,
            content: result.text.length > 0 ? result.text : m.content,
            ...(tools.length > 0 ? { tools } : {}),
          }));
          // Persist the completed turn (its tool record included); failed and
          // aborted turns are deliberately not persisted, so retry is clean.
          if (result.text.trim().length > 0 || result.toolCalls.length > 0) {
            appendMessage(
              getDb(),
              conversationId,
              'assistant',
              result.text,
              result.toolCalls.length > 0 ? result.toolCalls : null
            );
          }
        })
        .catch((err: unknown) => {
          // Tools already executed against the database before the failure —
          // persist the audit record so approved writes are never untraceable,
          // even though the turn shows as errored (and retry may re-ask).
          if (err instanceof CoachTurnError) {
            const tools = err.toolCalls.map((call) => humanizeToolName(call.name));
            appendMessage(getDb(), conversationId, 'assistant', err.partialText, err.toolCalls);
            patch((m) => ({ ...m, streaming: false, error: true, tools }));
            return;
          }
          if (err instanceof Error && err.name === 'AbortError') return; // unmounted; drop it
          patch((m) => ({ ...m, streaming: false, error: true }));
        })
        .finally(() => {
          if (abortRef.current === controller) abortRef.current = null;
          busyRef.current = false;
          setIsResponding(false);
          setActivity(null);
          setPendingWrite(null);
          confirmResolverRef.current = null;
          onTurnComplete?.();
        });
    },
    [conversationId, onTurnComplete, setMessages]
  );

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0 || busyRef.current) return;

      const db = getDb();
      const isFirstMessage = messagesRef.current.length === 0;
      const id = appendMessage(db, conversationId, 'user', trimmed);
      if (isFirstMessage) {
        setConversationTitle(db, conversationId, trimmed.slice(0, 64));
      }

      const userMessage: ChatMessage = {
        id,
        role: 'user',
        content: trimmed,
        createdAt: Date.now(),
      };
      const history = [...messagesRef.current, userMessage];
      setMessages(history);
      run(history);
    },
    [conversationId, run, setMessages]
  );

  const retry = useCallback(() => {
    if (busyRef.current) return;

    // Drop only the trailing failed assistant turn, then replay from the user
    // message before it. Errored bubbles earlier in the thread are left alone.
    // The user row was persisted on send, so no re-write happens here.
    const current = messagesRef.current;
    const last = current[current.length - 1];
    const cleaned = last?.role === 'assistant' && last.error ? current.slice(0, -1) : current;
    if (cleaned[cleaned.length - 1]?.role !== 'user') return;

    setMessages(cleaned);
    run(cleaned);
  }, [run, setMessages]);

  return { messages, isResponding, activity, pendingWrite, resolveWrite, send, retry };
}
