import { useCallback, useEffect, useRef, useState } from 'react';

import { humanizeToolName, streamCoachReply } from '@/lib/ai/coach-service';
import { CoachTurnError } from '@/lib/ai/model-client';
import type { CoachStopReason, CoachToolCall } from '@/lib/ai/types';
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

/**
 * The transparency chip for one tool call. A declined write and a failed call
 * must never read like one that ran: the chips are the only claim the UI makes
 * about what a turn did to the user's data, and a bare tool name under a write
 * the user *declined* asserts a change that never happened. The persisted
 * record (`ai_messages.tool_calls`) already carries the flags — this is the
 * view layer catching up to it.
 */
function chipLabel(call: CoachToolCall): string {
  const outcome = call.declined ? ' (declined)' : call.isError ? ' (failed)' : '';
  return `${humanizeToolName(call.name)}${outcome}`;
}

/**
 * The honest tail for a turn that stopped short. `runCoachTurn` RESOLVES on
 * both of these, so without a suffix they render as finished answers:
 *  - `max_tokens` — the per-round-trip cap bounds thinking + visible text
 *    TOGETHER on a default-thinking-on model, so a deep-reasoning turn can be
 *    cut off mid-sentence;
 *  - `tool_use_limit` — the agentic loop burned all its round-trips, and if the
 *    model never spoke on any of them the bubble would otherwise be empty.
 */
function stoppedShortNote(stopReason: CoachStopReason): string | null {
  switch (stopReason) {
    case 'max_tokens':
      return 'That reply was cut off before I finished — ask me to continue.';
    case 'tool_use_limit':
      return 'I ran out of steps before I could answer that — ask me again.';
    default:
      return null;
  }
}

/**
 * The tail for a turn that died mid-flight *after* its tools had already run.
 * Worded to cover an abort too: {@link CoachTurnError} is also what unmounting
 * throws once a tool has executed, and "failed" would be a lie about a turn the
 * user themselves walked away from.
 */
const INTERRUPTED_NOTE = 'That turn stopped before I finished — ask me again.';

/** Join a turn's spoken text with its trailing note; either side may be empty. */
function withNote(text: string, note: string | null): string {
  if (!note) return text;
  return text.trim().length > 0 ? `${text}\n\n${note}` : note;
}

/** Load the persisted thread as view-models (conversational roles only). */
function loadThread(conversationId: string): ChatMessage[] {
  return listMessages(getDb(), conversationId)
    .filter((row) => row.role === 'user' || row.role === 'assistant')
    .map((row) => {
      const tools = parseToolCalls(row.tool_calls).map(chipLabel);
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
 * the assistant row (with its tool-call record) when the stream completes.
 *
 * The persistence invariant `retry()` depends on: `error` is set ONLY on a turn
 * that was NOT written to `ai_messages`. `retry()` drops the trailing errored
 * bubble from the VIEW and replays — it has no way to delete a row — so
 * flagging a persisted turn forks the thread: `ai_messages` keeps an assistant
 * turn the user can no longer see, a reopened thread shows a phantom extra
 * reply, and the next request replays both it and its replacement. So a turn
 * that left something durable behind — text, a truncation, or tool calls that
 * already hit the database — is persisted and tells its own story in its text
 * (see stoppedShortNote / INTERRUPTED_NOTE); only a turn that left nothing
 * behind is errored and retryable.
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

      // Everything `onToken` has delivered to the bubble so far. On the failure
      // path this is the fuller record: the turn accumulates its text per
      // completed round-trip, so tokens streamed during the round-trip that
      // threw are on screen but not in `err.partialText`.
      const streamedSoFar = () =>
        messagesRef.current.find((m) => m.id === assistantId)?.content ?? '';

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
          const tools = result.toolCalls.map(chipLabel);
          // A turn that stopped short still RESOLVES, so fold the reason into
          // the bubble's text — otherwise a reply cut off mid-sentence reads as
          // a finished answer. It is NOT flagged `error`: `max_tokens` is
          // routine on a default-thinking-on model, and a Retry pill on a turn
          // this branch is about to persist would fork the thread (see the
          // invariant on the hook). The note tells the user to ask for the rest,
          // which replays the truncated turn as context instead of hiding it.
          const spoken = result.text.length > 0 ? result.text : streamedSoFar();
          const content = withNote(spoken, stoppedShortNote(result.stopReason));
          patch((m) => ({
            ...m,
            streaming: false,
            content,
            ...(tools.length > 0 ? { tools } : {}),
          }));
          // Persist exactly what was shown, note and all, so a reloaded thread
          // tells the same story — and the model sees that it was cut off when
          // the user asks it to continue.
          if (content.trim().length > 0 || result.toolCalls.length > 0) {
            appendMessage(
              getDb(),
              conversationId,
              'assistant',
              content,
              result.toolCalls.length > 0 ? result.toolCalls : null
            );
          }
        })
        .catch((err: unknown) => {
          // Tools already executed against the database before the failure —
          // persist the audit record so approved writes are never untraceable.
          // Persisted means NOT `error` (see the invariant on the hook): the
          // note in the text is what tells the user it stopped, because a Retry
          // pill here would drop this turn from the view while its row — and
          // the writes it records — stayed in `ai_messages`.
          if (err instanceof CoachTurnError) {
            const tools = err.toolCalls.map(chipLabel);
            const content = withNote(streamedSoFar() || err.partialText, INTERRUPTED_NOTE);
            appendMessage(getDb(), conversationId, 'assistant', content, err.toolCalls);
            patch((m) => ({ ...m, streaming: false, content, tools }));
            return;
          }
          if (err instanceof Error && err.name === 'AbortError') return; // unmounted; drop it
          // Nothing durable happened — no row, no tool ran — so this one is
          // errored and retryable: dropping the bubble leaves nothing orphaned.
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
    // The user row was persisted on send, so no re-write happens here — and by
    // the invariant on the hook, an `error` bubble has no `ai_messages` row, so
    // dropping it from the view drops it everywhere. Never set `error` on a
    // persisted turn without giving this a way to delete the row.
    const current = messagesRef.current;
    const last = current[current.length - 1];
    const cleaned = last?.role === 'assistant' && last.error ? current.slice(0, -1) : current;
    if (cleaned[cleaned.length - 1]?.role !== 'user') return;

    setMessages(cleaned);
    run(cleaned);
  }, [run, setMessages]);

  return { messages, isResponding, activity, pendingWrite, resolveWrite, send, retry };
}
