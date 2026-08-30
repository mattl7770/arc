import { useCallback, useEffect, useRef, useState } from 'react';

import { humanizeToolName, streamCoachReply } from '@/lib/ai/coach-service';
import { CoachTurnError } from '@/lib/ai/model-client';
import { toolByName } from '@/lib/ai/tools';
import type { CoachStopReason, CoachToolCall } from '@/lib/ai/types';
import { getDb } from '@/lib/db/client';
import {
  appendMessage,
  getOrCreateActiveConversation,
  listThread,
  markTurnStatus,
  parseToolCalls,
  setConversationTitle,
  type TurnStatus,
} from '@/lib/db/repositories/ai-chat';
import type { ChatMessage, PendingWrite } from '@/types/coach';

/**
 * A rendered turn, plus what the persistence layer knows about it that the bare
 * view model does not: whether it actually finished, whether it changed data,
 * and which `ai_messages` row it is (so a later marker can name it).
 */
export type CoachChatMessage = ChatMessage & {
  /** Set when this turn is NOT a finished answer — drives the honest chip. */
  incomplete?: TurnStatus;
  /** True when a write tool ran (approved, not declined, no error). */
  wrote?: boolean;
  /** The `ai_messages.id` of this turn once persisted. */
  dbId?: string;
};

export type CoachChat = {
  messages: CoachChatMessage[];
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
 * Did this turn change data? Declined and errored calls did not, and read tools
 * never do — so this is exactly "writes landed", the thing the user must be
 * told about when a turn stops early. An unknown name (a tool retired since the
 * turn was recorded) is treated as a write: over-warning is the safe direction.
 */
function didWrite(calls: CoachToolCall[]): boolean {
  return calls.some(
    (call) => !call.declined && !call.isError && toolByName(call.name)?.readOnly !== true
  );
}

/**
 * Map a turn's stop reason to a status, or null when it finished honestly.
 * `refusal` is a complete turn — coach-service already substitutes the text.
 */
function statusOf(stopReason: CoachStopReason): TurnStatus | null {
  if (stopReason === 'max_tokens') return 'max_tokens';
  if (stopReason === 'tool_use_limit') return 'tool_use_limit';
  return null;
}

/** Load the persisted thread as view-models (conversational roles only). */
function loadThread(conversationId: string): CoachChatMessage[] {
  return listThread(getDb(), conversationId).map(({ message: row, status }) => {
    const calls = parseToolCalls(row.tool_calls);
    const tools = calls.map((call) => humanizeToolName(call.name));
    return {
      id: row.id,
      dbId: row.id,
      role: row.role as ChatMessage['role'],
      content: row.content,
      createdAt: Date.parse(row.created_at),
      ...(tools.length > 0 ? { tools } : {}),
      // A turn marked incomplete must never come back looking like an answer.
      ...(status ? { incomplete: status, wrote: didWrite(calls) } : {}),
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
 * Honesty about unfinished turns: a turn can stop without finishing — cut off
 * at the token cap, out of tool round-trips after approved writes already
 * landed, or failed mid-loop. Such a turn is persisted (its tool-call record is
 * the audit trail of real writes to the owner's health data) and then MARKED
 * via markTurnStatus, never presented as a completed answer and never quietly
 * deleted. Retry marks the abandoned fragment `superseded` rather than erasing
 * it, and leaves it on screen so the thread matches the database exactly.
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
  const [messages, setMessagesState] = useState<CoachChatMessage[]>(() =>
    loadThread(conversationId)
  );
  const [isResponding, setIsResponding] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [pendingWrite, setPendingWrite] = useState<PendingWrite | null>(null);

  // Mirror of `messages`, always current, so handlers never read stale state.
  const messagesRef = useRef<CoachChatMessage[]>(messages);
  const setMessages = useCallback(
    (next: CoachChatMessage[] | ((prev: CoachChatMessage[]) => CoachChatMessage[])) => {
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
    // `history` is what the model is asked to continue; `rendered` is what the
    // thread shows. They diverge on retry: an abandoned fragment stays on
    // screen (and in the record) but must not be replayed to the model.
    (history: CoachChatMessage[], rendered: CoachChatMessage[] = history) => {
      busyRef.current = true;
      setIsResponding(true);

      const assistantId = nextId();
      setMessages([
        ...rendered,
        { id: assistantId, role: 'assistant', content: '', createdAt: Date.now(), streaming: true },
      ]);

      const controller = new AbortController();
      abortRef.current = controller;

      const patch = (fn: (m: CoachChatMessage) => CoachChatMessage) =>
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
          // A turn can end without finishing: cut off at the token cap, or out
          // of tool round-trips AFTER approved writes already landed. Neither
          // may render as a completed answer.
          const status = statusOf(result.stopReason);
          const wrote = didWrite(result.toolCalls);

          // Persist the turn (its tool record included), then mark it if it
          // didn't finish — so a reload tells the same story this screen does.
          let dbId: string | undefined;
          if (result.text.trim().length > 0 || result.toolCalls.length > 0) {
            const db = getDb();
            dbId = appendMessage(
              db,
              conversationId,
              'assistant',
              result.text,
              result.toolCalls.length > 0 ? result.toolCalls : null
            );
            if (status) markTurnStatus(db, conversationId, dbId, status);
          }

          patch((m) => ({
            ...m,
            streaming: false,
            content: result.text.length > 0 ? result.text : m.content,
            ...(tools.length > 0 ? { tools } : {}),
            ...(dbId ? { dbId } : {}),
            ...(status ? { incomplete: status, wrote } : {}),
          }));
        })
        .catch((err: unknown) => {
          // Tools already executed against the database before the failure —
          // persist the audit record so approved writes are never untraceable,
          // and mark the row `failed` so the fragment can never come back from
          // a reload wearing the face of a finished answer.
          if (err instanceof CoachTurnError) {
            const tools = err.toolCalls.map((call) => humanizeToolName(call.name));
            const db = getDb();
            const dbId = appendMessage(
              db,
              conversationId,
              'assistant',
              err.partialText,
              err.toolCalls
            );
            markTurnStatus(db, conversationId, dbId, 'failed');
            patch((m) => ({
              ...m,
              streaming: false,
              error: true,
              tools,
              dbId,
              incomplete: 'failed',
              wrote: didWrite(err.toolCalls),
            }));
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

      const userMessage: CoachChatMessage = {
        id,
        dbId: id,
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

    // Replay from the user message before the failed turn. The failed turn is
    // NOT replayed to the model — but it is NOT erased either: its row holds
    // the audit record of any writes that already landed, and ai_messages is
    // append-only. So it stays on screen, marked `superseded`, and the record
    // gets a marker saying the same thing. Screen and database agree; the
    // fragment can never resurface looking like a real answer.
    const current = messagesRef.current;
    const last = current[current.length - 1];
    const abandoned = last?.role === 'assistant' && last.error ? last : null;
    const history = abandoned ? current.slice(0, -1) : current;
    if (history[history.length - 1]?.role !== 'user') return;

    // A failure with nothing persisted (no tool calls ran) leaves no record to
    // reconcile — that bubble is simply dropped, as before.
    let rendered = history;
    if (abandoned?.dbId) {
      markTurnStatus(getDb(), conversationId, abandoned.dbId, 'superseded');
      rendered = [...history, { ...abandoned, error: false, incomplete: 'superseded' as const }];
    }

    setMessages(rendered);
    run(history, rendered);
  }, [conversationId, run, setMessages]);

  return { messages, isResponding, activity, pendingWrite, resolveWrite, send, retry };
}
