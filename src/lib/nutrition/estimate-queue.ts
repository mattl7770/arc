/**
 * The offline estimate queue's behaviour — classify a failure, drain the queue
 * when the network returns (0057, backlog C3).
 *
 * The owner's constraint is short: *"AI-dependent estimates queue until back
 * online."* Three decisions carry it.
 *
 * ## 1. What counts as "offline" — and what the drain does with each failure
 *
 * Every failure is classified ONCE, by {@link classifyQueueFailure}, into a
 * code and a disposition (src/lib/nutrition/queue-status.ts has the whole
 * rule and why it exists — the drain used to re-send, and re-bill, a request
 * the API had already refused, on every app open, forever):
 *
 *   - WAIT, nothing was billed: no connection (the model client names a fetch
 *     that never got a response `network_error`), no key, an abort;
 *   - RETRY, counted and backed off by elapsed time, parked at the cap: a
 *     stream that died mid-reply, a 5xx, a 529 overloaded;
 *   - PARK at once, never re-sent by itself: a 401/403, a 429, any other 4xx,
 *     an unreadable reply, a refusal, a failure AFTER the model answered (it
 *     was billed; sending it again would bill it again), and anything this
 *     module cannot name — an unknown failure is not assumed to be free.
 *
 * {@link isQueueableFailure} — what the interactive screens ask before they
 * queue a failed estimate — is narrower than "transient": no connection, or a
 * connection that dropped mid-reply. That is what it always meant, and what the
 * queued screen's "No connection, so the estimate is waiting" says; a 5xx on an
 * interactive estimate still shows its error and a retry. A missing key is
 * answered on the screen, which says where to add one, rather than queued.
 *
 * ## 2. The drain APPLIES; it does not park a second review
 *
 * A queued estimate has already written something — the placeholder meal the
 * user can see. Holding the drained result until he happens to open a review
 * screen would leave that placeholder empty for as long as he does not notice,
 * which is the exact state this feature exists to end. So the drain grounds the
 * estimate against the catalog (the same `groundMealEstimate` the interactive
 * path runs) and writes the items, stamped with the per-item `confidence` and
 * under `source = 'ai_suggested'` — the labelling the owner already accepts for
 * an estimate. It reads as an estimate on every screen, and `Adjust` and the
 * item editor are one tap away, exactly as for an interactively reviewed one.
 *
 * ## 3. A queued revision is re-grounded on what is there NOW
 *
 * The queue stores the CORRECTION, never a snapshot of the items. On drain the
 * meal's current items are read and sent as the "before" — so a hand-edit made
 * while offline is what the correction applies to, rather than something the
 * correction silently overwrites with a day-old picture of the meal.
 *
 * {@link drainEstimateQueue} is pure over the {@link Database} interface plus
 * injected estimators and stores, so db/nutrition-v2.test.mjs drives a whole
 * offline → restart → reconnect cycle with no network and no file system.
 */
import type { Database } from '@/lib/db/database';
import { ModelRequestError, NETWORK_ERROR } from '@/lib/ai/model-client';
import { usualFoodsContextFor } from '@/lib/db/repositories/food-history';
import { correctionsContextFor } from '@/lib/db/repositories/food-log-ratings';
import {
  getMeal,
  listMealItems,
  replaceMealItems,
  updateMealMeta,
} from '@/lib/db/repositories/nutrition';
import {
  listPendingEstimates,
  markPendingEstimateFailed,
  pendingEstimateForMeal,
} from '@/lib/db/repositories/pending-estimates';
import { attachMealPhoto, nativePhotoStore } from '@/lib/media/meal-photo-store';
import {
  clearPendingEstimate,
  nativePendingEstimateStore,
  readPendingEstimatePhoto,
} from '@/lib/media/pending-estimate-store';
import type { PhotoFileStore } from '@/lib/media/photo-file-store';
import { assembleMealItems } from '@/lib/nutrition/composite';
import type { NewMealItem, NewMealItemComponent, PendingEstimateRow } from '@/lib/nutrition/types';

import {
  type EstimateInput,
  estimateMeal,
  groundMealEstimate,
  isCompositeEstimateItem,
  loggedToRevisionItems,
  type MealEstimate,
  type MealEstimateComponent,
  type MealEstimateItem,
  MealEstimateParseError,
  MealEstimateRefusedError,
  MealEstimationUnavailableError,
  type MealRevisionSubject,
  reviseMeal,
} from './estimate';
import {
  composeLastError,
  isParked,
  isPendingEstimateDue,
  type QueueDisposition,
  type QueueFailureCode,
} from './queue-status';

/** One failure, classified — see the header and queue-status.ts. */
export type QueueFailure = {
  code: QueueFailureCode;
  disposition: QueueDisposition;
  /** The rest of the queue would meet the same answer: stop this drain. */
  stopDrain: boolean;
};

const failure = (
  code: QueueFailureCode,
  disposition: QueueDisposition,
  stopDrain: boolean
): QueueFailure => ({ code, disposition, stopDrain });

/**
 * Classify a failure of the MODEL call. A failure after the model answered is
 * not this function's question: the drain files it as `apply_failed` (parked),
 * because that request was billed.
 */
export function classifyQueueFailure(error: unknown): QueueFailure {
  if (error instanceof Error && error.name === 'AbortError')
    return failure('aborted', 'wait', true);
  if (error instanceof MealEstimationUnavailableError) return failure('no_key', 'wait', true);
  if (error instanceof MealEstimateParseError) return failure('unreadable', 'park', false);
  if (error instanceof MealEstimateRefusedError) return failure('refused', 'park', false);
  if (error instanceof ModelRequestError) {
    const { status, errorType } = error;
    // Status 0 is "no HTTP response". The client names the case where the
    // request never left (NETWORK_ERROR): free to retry, so it is not counted.
    if (status === 0 && errorType === NETWORK_ERROR) return failure('offline', 'wait', true);
    // Any other status-0 failure began a reply — a dropped stream, or an error
    // event mid-stream (`overloaded_error`, `api_error`). Transient, but it may
    // have been billed, so it is counted.
    if (status === 0) return failure('interrupted', 'retry', true);
    if (status >= 500 || status === 408) return failure('server', 'retry', true);
    if (status === 401 || status === 403) return failure('auth', 'park', true);
    if (status === 429) return failure('rate_limited', 'park', true);
    return failure('rejected', 'park', false);
  }
  return failure('failed', 'park', false);
}

/**
 * Is this failure worth keeping the request for? What the interactive screens
 * ask: yes for no connection, or one that dropped mid-reply — the cases their
 * "No connection" screen describes — and no for everything else, every code
 * the drain would park included. (A 5xx is retried by the drain, but on an
 * interactive estimate the user is there to retry it himself.)
 */
export function isQueueableFailure(error: unknown): boolean {
  const { code } = classifyQueueFailure(error);
  return code === 'offline' || code === 'interrupted';
}

/** A failure reason short enough for `pending_estimates.last_error`. */
export function failureReason(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** The two model calls the drainer needs, injected so the queue is testable
 *  without a network. */
export type QueueEstimators = {
  estimate: (input: EstimateInput) => Promise<MealEstimate>;
  revise: (meal: MealRevisionSubject, instruction: string) => Promise<MealEstimate>;
};

export type DrainDeps = {
  estimators: QueueEstimators;
  /** Where queued JPEGs live; null runs the queue in words only. */
  pendingStore: PhotoFileStore | null;
  /** Where a drained photo is moved to, so it lands on the meal exactly as an
   *  interactive capture does (0033's retention included). */
  mealPhotoStore: PhotoFileStore | null;
  /** The clock the backoff is read against (ms since the epoch); the tests
   *  move it forward instead of waiting. */
  now?: () => number;
};

export type DrainResult = {
  /** Entries the drainer tried this pass (due ones only — a parked or
   *  backing-off row is not tried). */
  attempted: number;
  /** Entries whose estimate landed on their meal. */
  applied: number;
  /** Entries still in the queue afterwards, parked ones included. */
  kept: number;
  /** Of those, entries parked — waiting on the user, not on the network. */
  parked: number;
};

/** The estimator items, as `meal_items` rows. One place, so a queued estimate
 *  and a reviewed one write the identical shape — the composite tree (0058)
 *  included, so a pizza drained from the queue is a pizza. */
function toMealItems(estimate: MealEstimate): NewMealItem[] {
  const priced = (item: MealEstimateItem | MealEstimateComponent): NewMealItemComponent => ({
    food_id: item.foodId,
    name: item.name,
    amount: item.amount != null && item.amount > 0 ? item.amount : null,
    unit: item.unit,
    serving_qty: null,
    // A part never carries the pair — a slice is not a fraction of the cheese
    // (0059). Stated rather than defaulted, so the rule is legible here.
    piece_name: null,
    kcal: item.kcal,
    protein_g: item.protein_g,
    carbs_g: item.carbs_g,
    fat_g: item.fat_g,
    fiber_g: item.fiber_g,
    confidence: item.confidence,
    micros: item.micros,
  });
  return estimate.items.map((item) =>
    isCompositeEstimateItem(item)
      ? // The header's own numbers are null by construction; sending them would
        // suggest they mean something. Its COUNT of pieces is not one of them
        // (0059) — nothing sums it, and it is a fact about the whole dish.
        {
          name: item.name,
          unit: item.unit,
          serving_qty: item.pieces?.count ?? null,
          piece_name: item.pieces?.name ?? null,
          components: (item.components ?? []).map(priced),
        }
      : // A plain item keeps its own count of pieces (2026-09-25) — `2 eggs`,
        // the pair whole, as the review's Save writes it.
        {
          ...priced(item),
          serving_qty: item.pieces?.count ?? null,
          piece_name: item.pieces?.name ?? null,
        }
  );
}

/** The request a queued row represents, or null when it cannot be reconstructed
 *  (a photo row whose file is gone AND which carried no words). */
function toEstimateInput(row: PendingEstimateRow, base64Jpeg: string | null): EstimateInput | null {
  if (row.kind === 'photo' && base64Jpeg) {
    return {
      kind: 'photo',
      base64Jpeg,
      mediaType: 'image/jpeg',
      description: row.description?.trim() || undefined,
    };
  }
  // A photo whose file vanished DEGRADES to its typed context rather than
  // failing: the words are still a request, and the alternative is telling the
  // user his meal is gone because of a missing JPEG.
  const words = row.description?.trim() ?? '';
  return words === '' ? null : { kind: 'text', description: words };
}

/**
 * Work the queue once, oldest first. Never throws: this runs on app open and on
 * every foreground, and a queue that can take the app down with it is worse
 * than the failure it was built for.
 *
 * Only DUE rows are sent (queue-status.ts `isPendingEstimateDue`): a parked row
 * waits for the user, and a row backing off waits out its time, however often
 * the app is opened. That, with the classification above, is the whole fix for
 * the re-billing loop.
 */
export async function drainEstimateQueue(db: Database, deps: DrainDeps): Promise<DrainResult> {
  const nowMs = (deps.now ?? Date.now)();
  const rows = listPendingEstimates(db).filter((row) => isPendingEstimateDue(row, nowMs));
  let applied = 0;
  for (const row of rows) {
    // Set the moment the model call returns. A failure after it is a failure
    // of a request that was BILLED — never the network's — so it is parked
    // rather than sent (and billed) again.
    let answered = false;
    try {
      const meal = getMeal(db, row.meal_id);
      if (!meal) {
        // The FK CASCADE should have taken this row with the meal; if a row
        // outlives its meal anyway, it has nothing to fill in.
        clearPendingEstimate(db, row, deps.pendingStore);
        continue;
      }

      if (row.kind === 'revise') {
        const instruction = row.description?.trim() ?? '';
        if (instruction === '') {
          clearPendingEstimate(db, row, deps.pendingStore);
          continue;
        }
        // Read the items NOW — see the header. A hand-edit made while offline is
        // the "before" this correction applies to.
        // The TREE (0058), so a composite goes to the model as one dish — and
        // through the Adjust screen's own builder, so a counted composite stays
        // counted (0059) and every item's fiber and micros are shown, whether
        // or not the phone was online when the correction was typed.
        const before = assembleMealItems(listMealItems(db, row.meal_id));
        const reply = await deps.estimators.revise(
          { name: meal.name, items: loggedToRevisionItems(before) },
          instruction
        );
        answered = true;
        const revised = groundMealEstimate(db, reply);
        // A revision touches the items and nothing else — the meal's date,
        // time, name and notes are the user's (replaceMealItems' own rule).
        replaceMealItems(db, row.meal_id, toMealItems(revised));
        clearPendingEstimate(db, row, deps.pendingStore);
        applied++;
        continue;
      }

      const base64Jpeg = readPendingEstimatePhoto(row.file_name, deps.pendingStore);
      const input = toEstimateInput(row, base64Jpeg);
      if (!input) {
        // Neither bytes nor words: nothing to send, ever. The placeholder stays
        // — it is the user's record that he ate something — and the queue entry
        // goes rather than retrying an empty request on every foreground.
        clearPendingEstimate(db, row, deps.pendingStore);
        continue;
      }

      const reply = await deps.estimators.estimate(input);
      answered = true;
      const grounded = groundMealEstimate(db, reply);
      // The placeholder's name was always provisional — the user's typed words,
      // or a plain statement that it was photographed. The model's title
      // replaces it, and the model's caveat becomes the meal's note, which is
      // what the interactive path writes too.
      updateMealMeta(db, row.meal_id, {
        name: grounded.title,
        time: meal.time,
        notes: grounded.notes,
      });
      replaceMealItems(db, row.meal_id, toMealItems(grounded));
      // The photo moves into the meal-photo directory through the ONE writer
      // (0033), so a queued capture ends up exactly where an interactive one
      // does, retention and all. It cannot fail the drain.
      if (base64Jpeg) {
        attachMealPhoto(
          db,
          row.meal_id,
          {
            base64Jpeg,
            width: row.width,
            height: row.height,
            source: 'camera',
          },
          deps.mealPhotoStore
        );
      }
      clearPendingEstimate(db, row, deps.pendingStore);
      applied++;
    } catch (error) {
      const failed: QueueFailure = answered
        ? { code: 'apply_failed', disposition: 'park', stopDrain: false }
        : classifyQueueFailure(error);
      try {
        markPendingEstimateFailed(
          db,
          row.id,
          composeLastError(failed.code, failureReason(error)),
          failed.disposition
        );
      } catch {
        // The row could not be updated either. Stop: a drain that cannot record
        // a failure must not go on sending requests it cannot account for.
        break;
      }
      // No connection, no key, a key the API refuses, a server that is down:
      // the rest of the queue would meet the same answer, so stop rather than
      // spend the remaining requests proving it.
      if (failed.stopDrain) break;
    }
  }
  const left = listPendingEstimates(db);
  return {
    attempted: rows.length,
    applied,
    kept: left.length,
    parked: left.filter(isParked).length,
  };
}

/**
 * Enter by hand: the user stops waiting on the model for this meal. The queued
 * request goes; NOTHING ELSE does. A queued photo moves onto the meal through
 * the one writer (0033), exactly as a drained one would, so the plate he
 * photographed is still there to look at while he types what was on it; the
 * meal keeps its name (his own words, when he typed any) and its NULL macros,
 * which the meal screen draws as "fill it in". A queued correction leaves the
 * meal's items as they stand. Returns whether there was a request to drop.
 */
export function enterPendingEstimateByHand(
  db: Database,
  mealId: string,
  stores: { pendingStore: PhotoFileStore | null; mealPhotoStore: PhotoFileStore | null } = {
    pendingStore: nativePendingEstimateStore(),
    mealPhotoStore: nativePhotoStore(),
  }
): boolean {
  const row = pendingEstimateForMeal(db, mealId);
  if (!row) return false;
  const base64Jpeg = readPendingEstimatePhoto(row.file_name, stores.pendingStore);
  if (base64Jpeg && row.kind === 'photo') {
    attachMealPhoto(
      db,
      mealId,
      { base64Jpeg, width: row.width, height: row.height, source: 'camera' },
      stores.mealPhotoStore
    );
  }
  clearPendingEstimate(db, row, stores.pendingStore);
  return true;
}

/** One drain at a time. The app-open pass and the foreground listener can both
 *  fire within a frame of each other, and two drains would race on the same
 *  rows — the second would re-send a request the first has in flight. */
let draining = false;

/**
 * The app's own drain: the real estimators, the real directories, and a no-op
 * whenever there is nothing to do. Called on app open and on every foreground —
 * "back online" has no event in React Native without a netinfo dependency, and
 * returning to the app is the moment that matters anyway (a drain nobody is
 * present for helps nobody).
 */
export async function runEstimateQueueDrain(db: Database): Promise<DrainResult> {
  const idle: DrainResult = { attempted: 0, applied: 0, kept: 0, parked: 0 };
  if (draining) return idle;
  draining = true;
  try {
    if (listPendingEstimates(db).length === 0) return idle;
    return await drainEstimateQueue(db, {
      estimators: {
        // His usual foods and his last corrections ride the user turn here too
        // (items 73 and 86).
        estimate: (input) =>
          estimateMeal({
            ...input,
            usual: usualFoodsContextFor(db),
            corrections: correctionsContextFor(db),
          }),
        revise: (meal, instruction) => reviseMeal(meal, instruction),
      },
      pendingStore: nativePendingEstimateStore(),
      mealPhotoStore: nativePhotoStore(),
    });
  } catch {
    return idle;
  } finally {
    draining = false;
  }
}
