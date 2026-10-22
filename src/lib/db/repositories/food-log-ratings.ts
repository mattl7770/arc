/**
 * Was this estimate right? — the `food_log_ratings` rows (0066, item 86;
 * docs/nutrition-subapp.md §23). One row per meal: a verdict (`good` / `bad`),
 * the one question's answer (`portion` / `item` / `macros`), and for a `bad`
 * the meal's items when he said so (`before_items`) and after his fix
 * (`after_items`).
 *
 * The meal screen is the only writer (app/meal-detail.tsx). The estimator and
 * the Coach read through {@link listMealRatings} — the same function — so what
 * the Coach is told about his corrections is exactly what the estimator learns
 * from (the parity rule, docs/coach-domains.md).
 */
import type { Database } from '../database';
import { newId } from '../id';
import { getMeal, listMealItems } from './nutrition';
import { assembleMealItems } from '@/lib/nutrition/composite';
import { activeUsagePolicy } from '@/lib/ai/usage-policy';
import {
  correctionsContext,
  describeCorrection,
  type EstimateRating,
  parseRatedItems,
  type RatedItem,
  ratedItems,
  type RatingCorrection,
  type RatingIssue,
  sameRatedItems,
  serializeRatedItems,
} from '@/lib/nutrition/ratings';

/** One rating, its snapshots parsed. */
export type MealRating = {
  id: string;
  mealId: string;
  rating: EstimateRating;
  issue: RatingIssue | null;
  before: RatedItem[] | null;
  after: RatedItem[] | null;
  createdAt: string;
  updatedAt: string;
};

type RatingRow = {
  id: string;
  meal_id: string;
  rating: EstimateRating;
  issue: RatingIssue | null;
  before_items: string | null;
  after_items: string | null;
  created_at: string;
  updated_at: string;
};

const toRating = (row: RatingRow): MealRating => ({
  id: row.id,
  mealId: row.meal_id,
  rating: row.rating,
  issue: row.issue,
  before: parseRatedItems(row.before_items),
  after: parseRatedItems(row.after_items),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** The meal's items as they stand, as a snapshot (a dish as its parts' sum). */
function snapshot(db: Database, mealId: string): string {
  return serializeRatedItems(ratedItems(assembleMealItems(listMealItems(db, mealId))));
}

function ratingRow(db: Database, mealId: string): RatingRow | undefined {
  return db.get<RatingRow>('SELECT * FROM food_log_ratings WHERE meal_id = ?', [mealId]);
}

/** The meal's rating, if it has one. */
export function getMealRating(db: Database, mealId: string): MealRating | undefined {
  const row = ratingRow(db, mealId);
  return row ? toRating(row) : undefined;
}

/**
 * Rate a meal. **Good** replaces whatever was there with a bare verdict — no
 * issue, no snapshots, so a correction he has taken back stops being an
 * example. **Off** records the verdict and the items as they stand NOW, as the
 * `before` his fix is measured from; an Off already recorded is kept as it is
 * (its `before` is the estimate he first called off, not what it has become).
 * The row's id is stable across a changed mind. Throws when the meal is gone.
 */
export function rateMeal(db: Database, mealId: string, rating: EstimateRating): MealRating {
  if (!getMeal(db, mealId)) throw new Error('rateMeal: that meal is no longer logged.');
  const existing = ratingRow(db, mealId);
  if (rating === 'good') {
    if (existing) {
      db.run(
        `UPDATE food_log_ratings
         SET rating = 'good', issue = NULL, before_items = NULL, after_items = NULL
         WHERE id = ?`,
        [existing.id]
      );
    } else {
      db.run(`INSERT INTO food_log_ratings (id, meal_id, rating) VALUES (?, ?, 'good')`, [
        newId(db),
        mealId,
      ]);
    }
  } else if (!existing) {
    db.run(
      `INSERT INTO food_log_ratings (id, meal_id, rating, before_items) VALUES (?, ?, 'bad', ?)`,
      [newId(db), mealId, snapshot(db, mealId)]
    );
  } else if (existing.rating === 'good') {
    db.run(`UPDATE food_log_ratings SET rating = 'bad', before_items = ? WHERE id = ?`, [
      snapshot(db, mealId),
      existing.id,
    ]);
  }
  return getMealRating(db, mealId)!;
}

/** The one question's answer, on a meal already rated off. Throws otherwise. */
export function setRatingIssue(db: Database, mealId: string, issue: RatingIssue): MealRating {
  const existing = ratingRow(db, mealId);
  if (!existing || existing.rating !== 'bad') {
    throw new Error('setRatingIssue: only a meal rated off has something that was off.');
  }
  if (existing.issue !== issue) {
    db.run('UPDATE food_log_ratings SET issue = ? WHERE id = ?', [issue, existing.id]);
  }
  return getMealRating(db, mealId)!;
}

/**
 * Record what the fix made of the meal: `after_items` becomes the items as they
 * stand, or NULL when they are back to exactly `before`. Writes only when that
 * changes something, so a re-read with nothing new leaves `updated_at` alone.
 * A no-op on a meal that is not rated off. The meal screen calls it while its
 * correction window is open (app/meal-detail.tsx).
 *
 * "The same" is the same ITEMS in any order (`sameRatedItems`): a combine
 * appends a joined meal's items to the snapshots, and the order the meal lists
 * them in is not something he corrected.
 */
export function settleMealRating(db: Database, mealId: string): void {
  const existing = ratingRow(db, mealId);
  if (!existing || existing.rating !== 'bad' || existing.before_items === null) return;
  const now = snapshot(db, mealId);
  const after = sameRatedItems(now, existing.before_items) ? null : now;
  if (!sameRatedItems(after, existing.after_items)) {
    db.run('UPDATE food_log_ratings SET after_items = ? WHERE id = ?', [after, existing.id]);
  }
}

/** A rating as the Coach and the estimator read it. */
export type MealRatingListing = MealRating & {
  date: string;
  mealName: string;
  /** The example line the estimator is shown for it, or null when it shows none. */
  correction: string | null;
};

/** Every rating, the latest change first, with its meal's day and name. */
export function listMealRatings(
  db: Database,
  options: { limit?: number; correctedOnly?: boolean } = {}
): MealRatingListing[] {
  const rows = db.all<RatingRow & { date: string; meal_name: string }>(
    `SELECT r.*, m.date AS date, m.name AS meal_name
     FROM food_log_ratings r JOIN meals m ON m.id = r.meal_id
     ${options.correctedOnly ? "WHERE r.rating = 'bad' AND r.after_items IS NOT NULL" : ''}
     ORDER BY r.updated_at DESC, r.rowid DESC
     LIMIT ?`,
    [options.limit ?? 50]
  );
  return rows.map((row) => {
    const rating = toRating(row);
    return {
      ...rating,
      date: row.date,
      mealName: row.meal_name,
      correction:
        rating.rating === 'bad' && rating.before && rating.after
          ? describeCorrection({ issue: rating.issue, before: rating.before, after: rating.after })
          : null,
    };
  });
}

/** The latest corrections the estimator learns from, newest first. Read past
 *  the cap, because a correction below the printed digits shows no line. */
export function ratingCorrections(
  db: Database,
  limit: number = activeUsagePolicy().correctionExamples
): RatingCorrection[] {
  return listMealRatings(db, { limit: limit * 3, correctedOnly: true })
    .filter((r) => r.correction !== null)
    .slice(0, limit)
    .map((r) => ({ issue: r.issue, before: r.before!, after: r.after! }));
}

/**
 * The block the photo and describe estimators append to the user turn, or null
 * when nothing has been corrected. Never throws: an estimate must not fail
 * because a read of the ratings did.
 */
export function correctionsContextFor(db: Database): string | null {
  try {
    return correctionsContext(ratingCorrections(db));
  } catch (error) {
    console.warn('[food-log-ratings] corrections unavailable', error);
    return null;
  }
}
