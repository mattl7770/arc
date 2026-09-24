/**
 * The offline estimate queue's behaviour — classify a failure, drain the queue
 * when the network returns (0057, backlog C3).
 *
 * The owner's constraint is short: *"AI-dependent estimates queue until back
 * online."* Three decisions carry it.
 *
 * ## 1. What counts as "offline"
 *
 * Not every failure is worth waiting on. {@link isQueueableFailure} says yes to
 * a TRANSPORT failure — the request never reached the API — and no to
 * everything else:
 *
 *   - an abort (the user left the screen) — there is nothing to retry;
 *   - {@link MealEstimationUnavailableError} — no key, or a binary without
 *     `expo/fetch`; waiting does not add either;
 *   - {@link MealEstimateParseError} — the model answered and the answer was
 *     unusable; the same request will produce the same nonsense;
 *   - a {@link ModelRequestError} carrying an HTTP status — a 400, a 401, a 429
 *     means we DID reach the API. That is a key, a quota or a request problem,
 *     and queueing it would re-bill the same rejection tomorrow.
 *
 * Everything else queues, including a `ModelRequestError` with status 0: that is
 * the code for "no HTTP response" — a stream that died mid-reply — which is
 * what a connection dropping actually looks like from inside the client.
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
import { ModelRequestError } from '@/lib/ai/model-client';
import {
  getMeal,
  listMealItems,
  replaceMealItems,
  updateMealMeta,
} from '@/lib/db/repositories/nutrition';
import {
  listPendingEstimates,
  markPendingEstimateFailed,
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
  MealEstimationUnavailableError,
  type MealRevisionSubject,
  reviseMeal,
} from './estimate';

/** Is this failure worth keeping the request for? See the header. */
export function isQueueableFailure(error: unknown): boolean {
  if (error instanceof MealEstimationUnavailableError) return false;
  if (error instanceof MealEstimateParseError) return false;
  if (error instanceof ModelRequestError) return error.status === 0;
  if (error instanceof Error && error.name === 'AbortError') return false;
  return true;
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
};

export type DrainResult = {
  /** Entries the drainer tried this pass. */
  attempted: number;
  /** Entries whose estimate landed on their meal. */
  applied: number;
  /** Entries still in the queue afterwards. */
  kept: number;
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
      : priced(item)
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
 */
export async function drainEstimateQueue(db: Database, deps: DrainDeps): Promise<DrainResult> {
  const rows = listPendingEstimates(db);
  let applied = 0;
  for (const row of rows) {
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
        const revised = groundMealEstimate(
          db,
          await deps.estimators.revise(
            { name: meal.name, items: loggedToRevisionItems(before) },
            instruction
          )
        );
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

      const grounded = groundMealEstimate(db, await deps.estimators.estimate(input));
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
      markPendingEstimateFailed(db, row.id, failureReason(error));
      // A transport failure means the rest of the queue will fail the same way;
      // stop rather than spend the remaining requests proving it.
      if (isQueueableFailure(error)) break;
    }
  }
  return { attempted: rows.length, applied, kept: listPendingEstimates(db).length };
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
  const idle: DrainResult = { attempted: 0, applied: 0, kept: 0 };
  if (draining) return idle;
  draining = true;
  try {
    if (listPendingEstimates(db).length === 0) return idle;
    return await drainEstimateQueue(db, {
      estimators: {
        estimate: (input) => estimateMeal(input),
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
