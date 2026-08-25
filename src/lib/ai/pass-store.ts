/**
 * The coach pass's one runner and its one result.
 *
 * A module-level store rather than hook state, for three reasons the first
 * implementation got wrong:
 *
 *   ONE RUN. The runner is mounted at the root, but Home needs to render what
 *   the pass said. Calling the same hook in both places ran the pass TWICE —
 *   two model calls, two assistant turns in the thread, for one trigger. The
 *   store separates running (root, once) from reading (anywhere).
 *
 *   AFTER HYDRATION. `apiKeyStore.hydrate()` is async and kicked off in the
 *   same boot effect, so a synchronous `has()` check on mount was always false
 *   on a cold start: the daily pass — Phase 4's entire point — could never fire
 *   on app open. The runner now waits for the store to settle.
 *
 *   NOT WHILE LOCKED. The pass reads the user's health data and sends it to the
 *   model API. Behind a Face ID lock, nobody has authenticated yet; a pass that
 *   fires there ships personal data on the say-so of whoever is holding the
 *   phone. The runner is gated on the lock being satisfied.
 *
 * Same subscribe/getSnapshot idiom as api-key-store and the modes store.
 */
import type { Database } from '@/lib/db/database';
import { appendMessage, getOrCreateActiveConversation } from '@/lib/db/repositories/ai-chat';

import { apiKeyStore } from './api-key-store';
import { runCoachPass } from './coach-pass';
import type { FetchLike } from './model-client';
import { duePass, markPassRan } from './pass-schedule';

type Listener = () => void;

let message: string | null = null;
let running = false;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

export type MaybeRunOptions = {
  /** The app lock is satisfied (or disabled). False → never run. */
  unlocked: boolean;
  /** Injected in tests. */
  now?: Date;
  /** Injected in tests; on device the pass resolves expo/fetch itself. */
  fetchImpl?: FetchLike;
};

export const coachPassStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** What the last pass said, or null. Stable reference for useSyncExternalStore. */
  getMessage(): string | null {
    return message;
  },
  dismiss(): void {
    if (message === null) return;
    message = null;
    emit();
  },
  /** Test seam — clears both the message and the in-flight guard. */
  reset(): void {
    message = null;
    running = false;
    emit();
  },

  /**
   * Run a pass if one is due and it is safe to. Idempotent: concurrent calls
   * (a re-render, a foreground event, and the boot effect all racing) collapse
   * into one.
   *
   * Returns what happened, so callers and tests can tell "no key" from
   * "nothing due" from "the Coach chose silence".
   */
  async maybeRun(
    db: Database,
    options: MaybeRunOptions
  ): Promise<'ran' | 'silent' | 'skipped' | 'offline'> {
    if (running) return 'skipped';
    if (!options.unlocked) return 'skipped';
    // Hydration is async; before it settles `has()` lies about a stored key.
    if (!apiKeyStore.isHydrated() || !apiKeyStore.has()) return 'skipped';

    const trigger = duePass(db, options.now);
    if (!trigger) return 'skipped';

    running = true;
    // Wrap the whole body: maybeRun is invoked fire-and-forget from a boot /
    // foreground effect, so any throw here would surface as an unhandled promise
    // rejection. An unexpected failure is treated like an offline morning — the
    // day is left unconsumed so the next foreground event tries again.
    try {
      const result = await runCoachPass(db, {
        trigger,
        ...(options.now ? { now: options.now } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });

      // A pass that never reached the model must NOT consume the day: the user
      // was on a train, and tomorrow's "you haven't had a pass today" is the
      // wrong conclusion to draw from an aeroplane-mode morning.
      if (result.status === 'failed') return 'offline';

      // Silence was a JUDGMENT, so it consumes the day either way — a signal the
      // Coach weighed and set aside must not re-ask an hour later.
      if (result.message === null) {
        markPassRan(db, options.now);
        return 'silent';
      }

      // Persist into the thread BEFORE consuming the day. What the Coach says
      // unprompted is a normal assistant turn: it shows up in the Coach tab in
      // context, survives the app closing, and is auditable like any other. If
      // the write fails (DB locked, transaction error) the observation would be
      // lost — so mark the day ran only after the append succeeds, leaving the
      // day unconsumed on failure so the pass is retried rather than silently
      // dropped for good.
      const conversation = getOrCreateActiveConversation(db);
      appendMessage(
        db,
        conversation.id,
        'assistant',
        result.message,
        result.toolCalls.length > 0 ? result.toolCalls : null
      );

      markPassRan(db, options.now);
      message = result.message;
      emit();
      return 'ran';
    } catch {
      return 'offline';
    } finally {
      running = false;
    }
  },
};
