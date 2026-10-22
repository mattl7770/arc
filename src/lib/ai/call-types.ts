/**
 * Every kind of model call ARC makes — the spend ledger's vocabulary
 * (src/lib/ai/spend-ledger.ts, 2026-10-21).
 *
 * Each caller of `runCoachTurn` names its own type in `ModelClientConfig`, and
 * the field is REQUIRED, so a new call site that forgets to say what it is
 * fails the typecheck rather than landing in the ledger as an anonymous cost.
 * db/spend-ledger.test.mjs pins the other direction from the source: every
 * file that calls `runCoachTurn` passes one of these literals.
 *
 * The labels are what Settings › Coach usage prints. They name the feature the
 * owner would recognise, not the function that made the call.
 */
export const MODEL_CALL_TYPES = [
  'chat',
  'pass',
  'meal_estimate',
  'meal_revision',
  'food_estimate',
  'recipe_import',
  'recipe_pricing',
  'recipe_revision',
  'knowledge_import',
  'lab_parse',
  'photo_reading',
  'report_read',
  'exercise_ai',
  'workout_import',
  // Never passed by a call site (the source pin refuses it): it is where a call
  // whose type did not survive to runtime is filed, rather than being dropped.
  'other',
] as const;

export type ModelCallType = (typeof MODEL_CALL_TYPES)[number];

export const MODEL_CALL_LABELS: Readonly<Record<ModelCallType, string>> = {
  chat: 'Coach chat',
  pass: 'Coach passes',
  meal_estimate: 'Meal estimates',
  meal_revision: 'Meal corrections',
  food_estimate: 'Food descriptions',
  recipe_import: 'Recipe imports',
  recipe_pricing: 'Recipe pricing',
  recipe_revision: 'Recipe corrections',
  knowledge_import: 'Knowledge imports',
  lab_parse: 'Lab reports',
  photo_reading: 'Photo readings',
  report_read: 'Report reads',
  exercise_ai: 'Exercise additions',
  workout_import: 'Workout imports',
  other: 'Other calls',
};

/** Guard: is `value` a known call type? A stored ledger is read through it. */
export function isModelCallType(value: unknown): value is ModelCallType {
  return typeof value === 'string' && (MODEL_CALL_TYPES as readonly string[]).includes(value);
}
