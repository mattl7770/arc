import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { streamCoachReply } from '@/lib/ai/coach-service';
import { CoachTurnError } from '@/lib/ai/model-client';
import { humanizeToolName, toolByName } from '@/lib/ai/tools';
import { claimsCompletedWrite } from '@/lib/ai/write-claim';
import type { CoachToolCall } from '@/lib/ai/types';
import { usageCaption } from '@/lib/ai/cost';
import { apiKeyStore } from '@/lib/ai/api-key-store';
import { updateRollingSummary } from '@/lib/ai/thread-summary';
import { getDb } from '@/lib/db/client';
import {
  appendMessage,
  getConversationSummary,
  getOrCreateActiveConversation,
  landedWriteReceipts,
  listRecentMessages,
  markSupersededTurns,
  outcomeForStopReason,
  parseToolCalls,
  setConversationTitle,
} from '@/lib/db/repositories/ai-chat';
import { INCOMPLETE_TURN_OUTCOMES, type AiTurnOutcome } from '@/lib/db/types';
import type { ChatMessage, PendingWrite } from '@/types/coach';

/**
 * A thread turn as this hook models it: the base view-model (src/types/coach.ts)
 * plus what 0028 made knowable — how the turn ended, whether its writes landed,
 * and whether it is part of the durable record.
 *
 * (The extra fields live here rather than in `ChatMessage` by the parallel-work
 * convention; the integrator folds them in.)
 */
export type CoachChatMessage = ChatMessage & {
  /** How the turn ended. Mirrors `ai_messages.turn_outcome`. */
  outcome?: AiTurnOutcome;
  /**
   * True once this turn exists as a row in `ai_messages`. A transport failure
   * that produced no text and ran no tools is NOT persisted — it left no trace
   * in the record, so retry may drop it. Anything persisted is kept forever.
   */
  persisted?: boolean;
  /**
   * RECEIPTS for the writes this turn actually committed — approved, not
   * declined, not errored — each the line the user approved on the card.
   *
   * Two cases depend on it. The older one: a turn cut off at max_tokens after
   * the user approved a write must still say the write landed. The one added
   * 2026-08-14: these print on EVERY turn that wrote, so a real change is
   * visibly a change and prose alone can never look like one.
   */
  writes?: string[];
  /**
   * The turn's prose claims it changed the record, and NOTHING was written.
   *
   * The owner's report ("saying that a recipe has been saved when the tool was
   * not called"). Derived, never stored: both inputs — the text and the tool
   * record — are already persisted, so a reloaded thread reaches the same
   * verdict as the live one.
   */
  phantomWrite?: boolean;
};

/** A turn as it should be rendered — with the retry-superseded mark derived. */
export type CoachChatView = CoachChatMessage & { superseded: boolean };

export type CoachChat = {
  messages: CoachChatView[];
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
  /** Re-run the last user turn after an unfinished reply. */
  retry: () => void;
};

export type CoachChatOptions = {
  /** Fired after a turn fully completes — refresh anything a tool may have written. */
  onTurnComplete?: () => void;
};

/** Outcomes worth re-running. A refusal is final — the model is done, on purpose. */
const RETRYABLE = new Set<AiTurnOutcome>(INCOMPLETE_TURN_OUTCOMES);

export function isRetryableOutcome(outcome: AiTurnOutcome | undefined): boolean {
  return outcome !== undefined && RETRYABLE.has(outcome);
}

/** Monotonic id: timestamp for ordering, counter to break same-millisecond ties. */
function makeId(seq: number): string {
  return `${Date.now()}-${seq}`;
}

/** The registry is the authority on which tools mutate the record. */
function isWriteTool(name: string): boolean {
  return toolByName(name)?.readOnly === false;
}

/** The receipts for the "these changes landed" line; [] for a read-only turn. */
function landedWrites(toolCalls: CoachToolCall[]): string[] {
  return landedWriteReceipts(toolCalls, isWriteTool, humanizeToolName);
}

/**
 * What a finished turn did to the record, and whether its prose agrees.
 *
 * One function so the live path, the failure path and the reload path cannot
 * drift: a phantom write must look the same after a restart as it did when it
 * happened, and the only way to guarantee that is for all three to call this.
 *
 * The claim check runs ONLY when nothing landed. A turn that really wrote is
 * never examined, so no real write can ever be captioned as a phantom one.
 */
function writeFidelity(
  content: string,
  toolCalls: CoachToolCall[]
): { writes: string[]; phantomWrite: boolean } {
  const writes = landedWrites(toolCalls);
  return {
    writes,
    phantomWrite: writes.length === 0 && claimsCompletedWrite(content),
  };
}

/**
 * How many turns of a thread the screen holds. The thread is append-only and
 * lives forever, so loading all of it into React state degrades the Coach tab
 * a little more every month. The model's own window is smaller than this, and
 * anything older is carried by the rolling summary (0030).
 */
const THREAD_PAGE_SIZE = 100;

/** Load the persisted thread as view-models (conversational roles only). */
function loadThread(conversationId: string): CoachChatMessage[] {
  return listRecentMessages(getDb(), conversationId, THREAD_PAGE_SIZE)
    .filter((row) => row.role === 'user' || row.role === 'assistant')
    .map((row) => {
      const calls = parseToolCalls(row.tool_calls);
      const tools = calls.map((call) => humanizeToolName(call.name));
      const { writes, phantomWrite } = writeFidelity(row.content, calls);
      return {
        id: row.id,
        role: row.role as ChatMessage['role'],
        content: row.content,
        createdAt: Date.parse(row.created_at),
        outcome: row.turn_outcome,
        persisted: true,
        ...(tools.length > 0 ? { tools } : {}),
        ...(writes.length > 0 ? { writes } : {}),
        ...(row.role === 'assistant' && phantomWrite ? { phantomWrite } : {}),
        // The raw record, kept so the NEXT turn can replay this turn's tool
        // digest (src/lib/ai/history-window.ts) without re-reading the thread.
        // Never rendered — `tools` above is what the chips show.
        ...(calls.length > 0 ? { toolCalls: calls } : {}),
      };
    });
}

/**
 * Owns the Coach conversation — persisted in `ai_conversations`/`ai_messages`
 * (0008, + turn_outcome in 0028), so a reload resumes the thread. op-sqlite is
 * synchronous, so the initial load runs in the `useState` initializers (no
 * loading state), same pattern as use-log-feed. Turns persist at their edges:
 * the user row on send, the assistant row (with its tool-call record and its
 * outcome) when the stream settles.
 *
 * What a turn's OUTCOME buys: the model's stop reason is carried all the way to
 * the row, so a reply cut off at max_tokens is never redisplayed as a finished
 * answer — and, critically, a turn truncated after the user approved a write
 * still reports that the write landed. A turn that failed with tool calls
 * already executed is persisted too (the writes are real); one that failed
 * before producing anything is not (nothing happened).
 *
 * Retry does NOT delete the fragment it replaces. `ai_messages` is append-only,
 * so retry appends and the old fragment stays, marked superseded — derived from
 * row adjacency by `markSupersededTurns`, the same rule the DB read uses, so a
 * live thread and a reloaded one show the same thing. (The only turns retry
 * drops are ones that were never persisted; they are not part of the record.)
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

  /**
   * @param history what the model is given — ends at the user turn being answered.
   * @param display what stays on screen underneath the new bubble. Identical to
   *   `history` on send; on retry it also carries the persisted fragments this
   *   attempt supersedes, because the database still holds them.
   */
  const run = useCallback(
    (history: CoachChatMessage[], display: CoachChatMessage[] = history) => {
      busyRef.current = true;
      setIsResponding(true);

      const assistantId = nextId();
      setMessages([
        ...display,
        { id: assistantId, role: 'assistant', content: '', createdAt: Date.now(), streaming: true },
      ]);

      const controller = new AbortController();
      abortRef.current = controller;

      const patch = (fn: (m: CoachChatMessage) => CoachChatMessage) =>
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? fn(m) : m)));

      streamCoachReply(history, {
        signal: controller.signal,
        // Everything older than the model's window, as a précis. Without it a
        // long thread silently loses its first half — including whatever set it
        // up ("my knee has been sore since March").
        priorSummary: getConversationSummary(getDb(), conversationId),
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
          // The stop reason is the whole point: 'max_tokens' means the reply was
          // CUT OFF, and a cut-off reply must never be stored or shown as a
          // finished one — least of all when it already wrote to the record.
          const outcome = outcomeForStopReason(result.stopReason);
          const tools = result.toolCalls.map((call: CoachToolCall) => humanizeToolName(call.name));
          const { writes, phantomWrite } = writeFidelity(result.text, result.toolCalls);
          const persisted = result.text.trim().length > 0 || result.toolCalls.length > 0;
          // What the turn cost, broken into cache writes / cache reads / output
          // (src/lib/ai/cost.ts). A single lump token total cannot distinguish a
          // warm prefix re-read from paying full price for it, and those differ
          // by 20×.
          const caption = usageCaption(
            result.usage,
            apiKeyStore.getModel(),
            result.toolCalls.length
          );
          patch((m) => ({
            ...m,
            streaming: false,
            content: result.text.length > 0 ? result.text : m.content,
            outcome,
            persisted,
            ...(tools.length > 0 ? { tools } : {}),
            ...(writes.length > 0 ? { writes } : {}),
            ...(phantomWrite ? { phantomWrite } : {}),
            ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
            ...(caption ? { usageCaption: caption } : {}),
          }));
          if (persisted) {
            appendMessage(
              getDb(),
              conversationId,
              'assistant',
              result.text,
              result.toolCalls.length > 0 ? result.toolCalls : null,
              outcome
            );
            // Fold anything that has aged out of the model's window into the
            // thread's rolling summary, so a long conversation degrades into a
            // précis instead of silently losing its first half.
            updateRollingSummary(getDb(), conversationId);
          }
        })
        .catch((err: unknown) => {
          // Tools already executed against the database before the failure —
          // persist the audit record so approved writes are never untraceable.
          // Retry appends alongside this row; it is never deleted.
          if (err instanceof CoachTurnError) {
            const tools = err.toolCalls.map((call) => humanizeToolName(call.name));
            const { writes, phantomWrite } = writeFidelity(err.partialText, err.toolCalls);
            appendMessage(
              getDb(),
              conversationId,
              'assistant',
              err.partialText,
              err.toolCalls,
              'failed'
            );
            patch((m) => ({
              ...m,
              streaming: false,
              error: true,
              outcome: 'failed',
              persisted: true,
              tools,
              ...(writes.length > 0 ? { writes } : {}),
              ...(phantomWrite ? { phantomWrite } : {}),
            }));
            return;
          }
          if (err instanceof Error && err.name === 'AbortError') return; // unmounted; drop it
          // Nothing ran and nothing was said — no row, so nothing to supersede.
          patch((m) => ({
            ...m,
            streaming: false,
            error: true,
            outcome: 'failed',
            persisted: false,
          }));
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
        role: 'user',
        content: trimmed,
        createdAt: Date.now(),
        outcome: 'complete',
        persisted: true,
      };
      const history = [...messagesRef.current, userMessage];
      setMessages(history);
      run(history);
    },
    [conversationId, run, setMessages]
  );

  const retry = useCallback(() => {
    if (busyRef.current) return;

    const current = messagesRef.current;
    const last = current[current.length - 1];
    if (!last || last.role !== 'assistant' || !isRetryableOutcome(last.outcome)) return;

    // Walk back over every trailing assistant turn — the original unfinished
    // reply plus any retries that also fell short — to the user turn they were
    // all answering. That user row was persisted on send; nothing is re-written.
    let userIndex = current.length - 1;
    while (userIndex >= 0 && current[userIndex]!.role === 'assistant') userIndex--;
    if (userIndex < 0 || current[userIndex]!.role !== 'user') return;

    // The model re-answers from the user turn: the fragments are not replayed
    // to it (a trailing assistant turn would read as a prefill to continue).
    const history = current.slice(0, userIndex + 1);
    // The SCREEN keeps every fragment the database kept. Only turns that were
    // never persisted are dropped — they are not part of the record, so keeping
    // them would be the thread disagreeing with the DB in the other direction.
    const kept = current
      .slice(userIndex + 1)
      .filter((m) => m.persisted)
      .map((m) => ({ ...m, streaming: false }));

    run(history, [...history, ...kept]);
  }, [run]);

  // Superseded is derived, never stored — the same adjacency rule the DB read
  // uses (markSupersededTurns), so the live thread and a reloaded one agree.
  const view = useMemo(() => markSupersededTurns(messages), [messages]);

  return { messages: view, isResponding, activity, pendingWrite, resolveWrite, send, retry };
}
