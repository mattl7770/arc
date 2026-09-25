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
 * Since 0064 (Coach notifications, docs/spikes/coach-notifications.md) it also:
 *
 *   WAITS FOR HEALTH. `settle` is awaited before the pass decides anything, so
 *   the state block it builds has last night's sleep in it (the plan's
 *   correction: the two used to race).
 *
 *   APPLIES THE NUDGES. The pass proposes NUDGE lines; the rules and the write
 *   happen HERE, after it returns, so the pass itself stays read-only by
 *   construction. What changed is recorded in the thread (owner's Q1).
 *
 *   ANSWERS TAPS. A tapped check-in queues a request; the runner answers it
 *   with the Coach speaking first (owner's Q5), once. A tapped nudge puts its
 *   own line into the thread.
 *
 * Same subscribe/getSnapshot idiom as api-key-store and the modes store.
 */
import type { Database } from '@/lib/db/database';
import { todayISODate } from '@/lib/db/date';
import { appendMessage, getOrCreateActiveConversation } from '@/lib/db/repositories/ai-chat';
import {
  applyNudgeReply,
  describeNudgePlan,
  getNudge,
  markNudgeDelivered,
} from '@/lib/db/repositories/coach-nudges';
import { listActiveReminders } from '@/lib/db/repositories/reminders';
import { syncReminderNotifications } from '@/lib/notifications/reminders';

import { apiKeyStore } from './api-key-store';
import { runCoachPass, type PassTrigger } from './coach-pass';
import type { FetchLike } from './model-client';
import {
  checkinAnswered,
  checkinKey,
  duePass,
  getPassState,
  markPassRan,
  recordCheckin,
} from './pass-schedule';

type Listener = () => void;

/** A tap he made that the Coach should answer. */
export type CheckinRequest = { kind: 'morning' } | { kind: 'reminder'; reminderId: string };

/**
 * What became of a tapped check-in — the Coach tab reads this to say what
 * happened when the Coach did NOT answer in the thread.
 *
 *   spoke    the Coach answered; its reply is the thread's latest message.
 *   shown    it had already answered this today (or the morning note exists),
 *            so the thread IS the answer and nothing was paid for twice.
 *   silent   it looked and had nothing to add.
 *   offline  it could not be reached.
 *   no-key   there is no key, so it cannot look at all.
 */
export type CheckinOutcome = {
  request: CheckinRequest;
  result: 'spoke' | 'shown' | 'silent' | 'offline' | 'no-key';
};

let message: string | null = null;
let running = false;
let threadVersion = 0;
let request: CheckinRequest | null = null;
let answering = false;
let outcome: CheckinOutcome | null = null;
const listeners = new Set<Listener>();
const requestListeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

function emitRequest(): void {
  for (const listener of requestListeners) listener();
}

function resolveCheckin(req: CheckinRequest, result: CheckinOutcome['result']): void {
  outcome = { request: req, result };
}

export type MaybeRunOptions = {
  /** The app lock is satisfied (or disabled). False → never run. */
  unlocked: boolean;
  /** Injected in tests. */
  now?: Date;
  /** Injected in tests; on device the pass resolves expo/fetch itself. */
  fetchImpl?: FetchLike;
  /**
   * Resolves once the foreground Health sync has settled (or given up). The
   * root passes `waitForHealthSyncIdle`; tests pass their own, or nothing.
   */
  settle?: () => Promise<unknown>;
};

/** What the next pass is, and what it answers. */
type PassPlan = {
  trigger: PassTrigger;
  /** It stamps the day (markPassRan): it is, or includes, the day's look. */
  consumesDay: boolean;
  request: CheckinRequest | null;
  checkinKey: string | null;
};

/**
 * Pick the pass to run now, taking any waiting request.
 *
 * A tap is answered before a due pass, and FOLDS a due daily into itself — a
 * morning check-in tapped before the day's first look IS that look, and a
 * reminder check-in tapped first says anything else worth a word in the same
 * reply. One call, not two, for one open.
 *
 * The morning check-in after the daily pass already ran: if that pass spoke,
 * its note is in the thread and the tap shows it (plan §4). If it was SILENT,
 * he is still asking — the earlier look may not have seen the night, and he is
 * here, so the money is spent in front of him — and the check-in runs once.
 */
function choosePass(db: Database, now: Date): PassPlan | null {
  const due = duePass(db, now);
  const req = request;
  if (req) {
    request = null;
    const today = todayISODate(now);
    if (req.kind === 'morning') {
      const key = checkinKey('morning', today);
      if (due?.kind === 'daily') {
        return {
          trigger: { kind: 'checkin', part: 'morning' },
          consumesDay: true,
          request: req,
          checkinKey: key,
        };
      }
      if (getPassState(db).lastSpoke === today) {
        resolveCheckin(req, 'shown');
      } else if (checkinAnswered(db, key)) {
        resolveCheckin(req, 'silent');
      } else {
        return {
          trigger: { kind: 'checkin', part: 'morning' },
          consumesDay: true,
          request: req,
          checkinKey: key,
        };
      }
    } else {
      const reminder = listActiveReminders(db).find((r) => r.id === req.reminderId);
      const key = checkinKey({ reminderId: req.reminderId }, today);
      // Gone, or not a check-in: nothing to answer, and the tab still shows
      // the row (if it exists) with "Talk about this".
      if (reminder && reminder.checkin === 1) {
        if (checkinAnswered(db, key)) {
          resolveCheckin(req, 'shown');
        } else {
          const firstLook = due?.kind === 'daily';
          return {
            trigger: { kind: 'topic', title: reminder.title, notes: reminder.notes, firstLook },
            consumesDay: firstLook,
            request: req,
            checkinKey: key,
          };
        }
      }
    }
  }
  return due ? { trigger: due, consumesDay: true, request: null, checkinKey: null } : null;
}

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
  /**
   * Bumped whenever this store writes to the thread (a pass's note, a plan
   * record, a tapped nudge). The Coach tab re-reads its thread when it moves,
   * since a mounted tab loaded its turns once.
   */
  getThreadVersion(): number {
    return threadVersion;
  },
  /** A check-in is waiting to be answered, or being answered now. */
  isAnswering(): boolean {
    return answering || request !== null;
  },
  /** What became of the last tapped check-in, or null. */
  getCheckinOutcome(): CheckinOutcome | null {
    return outcome;
  },
  clearCheckinOutcome(): void {
    if (outcome === null) return;
    outcome = null;
    emit();
  },
  /** Test seam — clears the message, the in-flight guard and every request. */
  reset(): void {
    message = null;
    running = false;
    request = null;
    answering = false;
    outcome = null;
    emit();
  },

  /**
   * He tapped a check-in. Queued, not run: the runner is the one place that
   * knows whether the lock is open and the key is loaded. A second tap before
   * the first is answered replaces it rather than stacking.
   */
  requestCheckin(next: CheckinRequest): void {
    request = next;
    outcome = null;
    emit();
    emitRequest();
  },
  /** The runner's wake-up for a new request. */
  subscribeRequests(listener: Listener): () => void {
    requestListeners.add(listener);
    return () => requestListeners.delete(listener);
  },

  /**
   * He tapped a nudge: its line becomes the Coach's latest message in the
   * thread, so whatever he types next has context, and the row is marked
   * delivered — so the next pass is told it went out and does not repeat it.
   *
   * Once only: a nudge already delivered, cancelled, or not on this phone at
   * all (a restore) adds nothing, and the tab just opens on the thread. The
   * thread is written FIRST and the row second, because appendMessage runs its
   * own transaction and a failure between the two should cost a repeat, not a
   * nudge that vanished from the record.
   */
  deliverNudge(db: Database, id: string): boolean {
    try {
      const row = getNudge(db, id);
      if (!row || row.status !== 'pending') return false;
      appendMessage(db, getOrCreateActiveConversation(db).id, 'assistant', row.body);
      markNudgeDelivered(db, id);
      threadVersion += 1;
      emit();
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Run a pass if one is due, or a check-in is waiting, and it is safe to.
   * Idempotent: concurrent calls (a re-render, a foreground event, and the boot
   * effect all racing) collapse into one.
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
    if (!apiKeyStore.isHydrated()) return 'skipped';
    if (!apiKeyStore.has()) {
      // A tapped check-in cannot be answered without a key. Say so, rather
      // than leave the tab waiting on a reply that will never come.
      if (request) {
        resolveCheckin(request, 'no-key');
        request = null;
        emit();
      }
      return 'skipped';
    }

    running = true;
    let plan: PassPlan | null = null;
    // Wrap the whole body: maybeRun is invoked fire-and-forget from a boot /
    // foreground effect, so any throw here would surface as an unhandled promise
    // rejection. An unexpected failure is treated like an offline morning — the
    // day is left unconsumed so the next foreground event tries again.
    try {
      // Before anything is decided: a Health sync still landing last night's
      // sleep changes both what is due (a new signal) and what the pass reads.
      if (options.settle) await options.settle();
      const now = options.now ?? new Date();

      const hadRequest = request !== null;
      plan = choosePass(db, now);
      if (!plan) {
        // A tap answered without a pass (shown / silent) still has to reach
        // the tab; an ordinary nothing-due call changes nothing to announce.
        if (hadRequest) emit();
        return 'skipped';
      }
      if (plan.request) {
        answering = true;
        emit();
      }

      const result = await runCoachPass(db, {
        trigger: plan.trigger,
        now,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });

      // A pass that never reached the model must NOT consume the day: the user
      // was on a train, and tomorrow's "you haven't had a pass today" is the
      // wrong conclusion to draw from an aeroplane-mode morning.
      if (result.status === 'failed') {
        if (plan.request) resolveCheckin(plan.request, 'offline');
        return 'offline';
      }

      // The nudge lines, through the rules, into rows. See coach-nudges.ts for
      // what a pass's lines do to what is already pending.
      const today = todayISODate(now);
      const applied = applyNudgeReply(db, result.nudges, now);
      const record = describeNudgePlan(applied, today);

      // Persist into the thread BEFORE consuming the day. What the Coach says
      // unprompted is a normal assistant turn: it shows up in the Coach tab in
      // context, survives the app closing, and is auditable like any other. If
      // the write fails (DB locked, transaction error) the observation would be
      // lost — so mark the day ran only after the append succeeds, leaving the
      // day unconsumed on failure so the pass is retried rather than silently
      // dropped for good.
      //
      // The plan record rides the same turn when the Coach spoke, and stands
      // alone when it was silent: a quiet day that planned a nudge still says
      // so in the thread.
      const content = [result.message, record].filter((part): part is string => !!part);
      if (content.length > 0) {
        appendMessage(
          db,
          getOrCreateActiveConversation(db).id,
          'assistant',
          content.join('\n\n'),
          result.toolCalls.length > 0 ? result.toolCalls : null
        );
        threadVersion += 1;
      }

      if (plan.consumesDay) {
        markPassRan(db, now, {
          evening: plan.trigger.kind === 'checkin' && plan.trigger.part === 'evening',
          spoke: result.message !== null,
        });
      }
      if (plan.checkinKey) recordCheckin(db, plan.checkinKey, now);
      if (applied.changed) void syncReminderNotifications(db);

      if (plan.request) resolveCheckin(plan.request, result.message !== null ? 'spoke' : 'silent');
      if (result.message !== null) message = result.message;
      emit();
      return result.message === null ? 'silent' : 'ran';
    } catch {
      if (plan?.request) resolveCheckin(plan.request, 'offline');
      return 'offline';
    } finally {
      running = false;
      if (answering) {
        answering = false;
        emit();
      }
      // A tap that arrived while this pass ran found the runner busy. Wake it
      // again now rather than leave the request for the next foreground.
      if (request) emitRequest();
    }
  },
};
