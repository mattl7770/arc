/**
 * The offline estimate queue's row half — `pending_estimates` (0057).
 *
 * Owner, backlog C3: the catalog and manual paths work with the network
 * unplugged (they always did — nothing on them calls `fetch`), and an
 * AI-dependent estimate taken offline is **queued, not lost**.
 *
 * ## The placeholder is the feature
 *
 * Queueing a request without showing anything would be worse than the error
 * message it replaces: the user photographs a plate, the screen returns to the
 * Eat tab, and nothing is there. So {@link queueNewMealEstimate} writes the
 * meal and the queue entry in ONE transaction — a placeholder that says what it
 * is, in the day's list, at the right time, with **NULL macros**.
 *
 * NULL rather than 0, and this is the load-bearing choice: 0 is a measurement
 * ("I ate nothing") and would sum into the day's totals as a fact, while NULL
 * is "not recorded" — which the Eat tab already draws as an em-dash and which
 * already, correctly, drops the day out of countdown mode. Energy that is
 * genuinely unknown cannot be subtracted from a target, and
 * `src/lib/nutrition/remaining.ts` says so in an authored sentence rather than
 * by silently guessing.
 *
 * Like every repository this depends only on the {@link Database} interface —
 * never op-sqlite — so the same code runs on device and against node:sqlite in
 * db/nutrition-v2.test.mjs.
 */
import type { Database } from '../database';
import { newId } from '../id';
import type { DateString, TimeString } from '../types';
import {
  pendingEstimateStatus,
  QUEUE_MAX_ATTEMPTS,
  type PendingEstimateStatus,
  type QueueDisposition,
} from '@/lib/nutrition/queue-status';
import type { NewPendingEstimate, PendingEstimateRow } from '@/lib/nutrition/types';

/** What a queued new-meal request needs to stand as a visible placeholder. */
export type PlaceholderMeal = {
  date: DateString;
  time: TimeString | null;
  /** The meal's name until the estimate lands — see {@link placeholderMealName}. */
  name: string;
};

/**
 * The name a placeholder wears until the model answers.
 *
 * The user's own words when there are any — a typed description IS a name, and
 * "Chicken burrito and a beer" in the day's list is better than any label this
 * module could invent. A bare photo has no words, so it gets a plain statement
 * of what it is. Never a conceit noun, never "Untitled", and never a fabricated
 * guess at the food.
 */
export function placeholderMealName(description: string | null | undefined): string {
  const words = (description ?? '').trim().replace(/\s+/g, ' ');
  if (words === '') return 'Photographed meal';
  // The Eat-tab row is one line at phone width; a paragraph typed into the
  // describe field is truncated at a word boundary rather than mid-syllable.
  if (words.length <= 60) return words;
  const cut = words.slice(0, 60);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 24 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function insertPending(db: Database, mealId: string, request: NewPendingEstimate): string {
  const id = newId(db);
  db.run(
    `INSERT INTO pending_estimates (id, meal_id, kind, description, file_name, width, height)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (meal_id) DO UPDATE SET
       kind        = excluded.kind,
       description = excluded.description,
       file_name   = excluded.file_name,
       width       = excluded.width,
       height      = excluded.height,
       attempts    = 0,
       last_error  = NULL`,
    [
      id,
      mealId,
      request.kind,
      request.description ?? null,
      request.file_name ?? null,
      request.width ?? null,
      request.height ?? null,
    ]
  );
  return id;
}

/**
 * Queue a photo/describe estimate that has no meal yet: write the placeholder
 * and the queue entry together, so neither can exist without the other.
 *
 * `source` is `'ai_suggested'` from the first instant — the row's provenance is
 * decided by what made it, not by whether the answer has arrived — which also
 * means `relogMeal` and the export treat a drained placeholder exactly as they
 * treat an interactively reviewed estimate.
 */
export function queueNewMealEstimate(
  db: Database,
  meal: PlaceholderMeal,
  request: NewPendingEstimate
): { mealId: string; pendingId: string } {
  const mealId = newId(db);
  let pendingId = '';
  db.transaction(() => {
    db.run(
      `INSERT INTO meals (id, date, time, name, kcal, protein_g, carbs_g, fat_g, source, notes)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, 'ai_suggested', NULL)`,
      [mealId, meal.date, meal.time, meal.name]
    );
    pendingId = insertPending(db, mealId, request);
  });
  return { mealId, pendingId };
}

/**
 * Queue a plain-English revision of a meal that already exists. No placeholder:
 * the meal keeps the items it has, which stay correct and countable until the
 * correction can actually be made.
 */
export function queueMealRevision(db: Database, mealId: string, instruction: string): string {
  return insertPending(db, mealId, { kind: 'revise', description: instruction });
}

/** The queue, oldest first — the order the drainer works in, so a meal logged
 *  on the plane lands before the one logged in the taxi. */
export function listPendingEstimates(db: Database): PendingEstimateRow[] {
  return db.all<PendingEstimateRow>('SELECT * FROM pending_estimates ORDER BY created_at, rowid');
}

/** The queued entry for one meal, or undefined. */
export function pendingEstimateForMeal(
  db: Database,
  mealId: string
): PendingEstimateRow | undefined {
  return db.get<PendingEstimateRow>('SELECT * FROM pending_estimates WHERE meal_id = ?', [mealId]);
}

/**
 * Which of one day's meals are still waiting on a model — what the Eat tab
 * reads so a placeholder says "Estimate pending" instead of wearing the
 * "Nothing recorded — tap to fill it in" line, which would be advice the user
 * cannot act on.
 */
export function pendingEstimateMealIds(db: Database, date: string): Set<string> {
  const rows = db.all<{ meal_id: string }>(
    `SELECT pe.meal_id AS meal_id
     FROM pending_estimates pe
     JOIN meals m ON m.id = pe.meal_id
     WHERE m.date = ?`,
    [date]
  );
  return new Set(rows.map((r) => r.meal_id));
}

/**
 * The same day's waiting meals with WHERE each stands — what the Eat tab's row
 * line reads, so a parked estimate says it is paused rather than "offline"
 * (2026-10-21). Keyed by meal id; the keys are exactly
 * {@link pendingEstimateMealIds}.
 */
export function pendingEstimateStatuses(
  db: Database,
  date: string
): Map<string, PendingEstimateStatus> {
  const rows = db.all<Pick<PendingEstimateRow, 'meal_id' | 'attempts' | 'last_error'>>(
    `SELECT pe.meal_id AS meal_id, pe.attempts AS attempts, pe.last_error AS last_error
     FROM pending_estimates pe
     JOIN meals m ON m.id = pe.meal_id
     WHERE m.date = ?`,
    [date]
  );
  return new Map(rows.map((r) => [r.meal_id, pendingEstimateStatus(r)]));
}

/** Every queued file name — the pending directory's reconcile set, so a file
 *  whose row has gone (the meal was deleted) is reclaimed. */
export function pendingEstimateFileNames(db: Database): string[] {
  return db
    .all<{ file_name: string }>(
      'SELECT file_name FROM pending_estimates WHERE file_name IS NOT NULL'
    )
    .map((r) => r.file_name);
}

/**
 * Record a failed attempt, as the drain classified it (src/lib/nutrition/
 * queue-status.ts says what each disposition means):
 *
 *   - `wait`  — nothing was sent: the reason is recorded, `attempts` is not;
 *   - `retry` — one more counted attempt, which also starts its backoff (the
 *     row's trigger stamps `updated_at`, the clock the backoff reads);
 *   - `park`  — `attempts` goes straight to the cap, which is what "parked" is.
 *
 * The row STAYS in every case — nothing here expires a queue entry. It holds
 * the user's photo or words, and deleting his meal on his behalf fixes nothing.
 * The ways out are his: Try again ({@link retryPendingEstimate}), Enter by hand
 * (estimate-queue.ts `enterPendingEstimateByHand`), or deleting the
 * placeholder, which CASCADEs this row away.
 */
export function markPendingEstimateFailed(
  db: Database,
  id: string,
  lastError: string,
  disposition: QueueDisposition
): void {
  const attempts =
    disposition === 'wait'
      ? 'attempts'
      : disposition === 'retry'
        ? 'attempts + 1'
        : `MAX(attempts, ${QUEUE_MAX_ATTEMPTS})`;
  db.run(`UPDATE pending_estimates SET attempts = ${attempts}, last_error = ? WHERE id = ?`, [
    lastError.slice(0, 400),
    id,
  ]);
}

/**
 * Try again: a parked (or backing-off) request becomes a fresh one — attempts
 * back to 0, the reason cleared — so the next drain sends it at once. The
 * caller starts that drain. Returns whether a row was there to reset.
 */
export function retryPendingEstimate(db: Database, mealId: string): boolean {
  const before = pendingEstimateForMeal(db, mealId);
  if (!before) return false;
  db.run('UPDATE pending_estimates SET attempts = 0, last_error = NULL WHERE id = ?', [before.id]);
  return true;
}

/** Drop one queue entry — what a successful drain does, and what the user's own
 *  Enter by hand does. The caller removes the file afterwards; the orphan pass
 *  covers it if that fails. */
export function deletePendingEstimate(db: Database, id: string): void {
  db.run('DELETE FROM pending_estimates WHERE id = ?', [id]);
}
