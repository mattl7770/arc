/**
 * The AI meal-estimation seam: photo → itemized macros, description → itemized
 * macros. This is the nutrition sub-app's ONE model touchpoint, and it is a
 * SEAM today, not a call — exactly like coach-service.ts before Phase 3.
 *
 * DEPENDENCY (flagged in docs/nutrition-subapp.md §6): the real implementation
 * reuses the Coach's on-device model client (being built in a parallel window:
 * direct provider call, key in the iOS Keychain, expo/fetch streaming). ARC has
 * ONE model path; this module must never grow its own. When that client merges,
 * only the body of {@link estimateMeal} and {@link isMealEstimationAvailable}
 * change — every caller is written against this contract now.
 *
 * The planned call (research: docs/nutrition-subapp.md §1 "Camera + vision"):
 *   1. photo → ~1024 px JPEG at ~0.65 quality (expo-image-manipulator) →
 *      base64 image block before a "visual estimation" prompt (itemize the
 *      plate; portions in grams from visual cues; per-item confidence;
 *      JSON-only output matching MealEstimate; call out hidden-fat
 *      uncertainty). ≈1,369 vision tokens ≈ $0.001–0.004 per photo.
 *   2. Ground, don't trust: returned item names are matched against the local
 *      catalog + the user's recents (searchFoods / listRecentFoods); a hit
 *      swaps in known per-100 g macros scaled to the estimated grams
 *      (foodId set). Peer-reviewed MAPE for raw LLM photo estimation is ~36%,
 *      portion-dominated — which is also why results ALWAYS land in an
 *      editable review screen and are saved with source='ai_suggested' and
 *      per-item confidence, never auto-committed.
 *   3. Describe-in-words is the same pipeline minus the image block.
 */
import type { EstimateConfidence } from './types';

export type EstimateInput =
  | { kind: 'text'; description: string }
  | { kind: 'photo'; base64Jpeg: string; mediaType: 'image/jpeg'; description?: string };

export type MealEstimateItem = {
  name: string;
  /** Estimated portion in grams; null when the model can only price energy. */
  grams: number | null;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number | null;
  confidence: EstimateConfidence;
  /** Set when the item was grounded to a catalog food (macros re-priced from
   * its per-100 g values); null means raw model numbers. */
  foodId: string | null;
};

export type MealEstimate = {
  /** A short meal title, e.g. "Salmon, rice and greens". */
  title: string;
  items: MealEstimateItem[];
  /** Model-stated caveats worth showing in review ("dressing not visible"). */
  notes: string | null;
};

/** Thrown while the Coach model client hasn't landed (or has no key). */
export class MealEstimationUnavailableError extends Error {
  constructor() {
    super('Meal estimation needs the on-device model (Coach, Phase 3) — not wired yet.');
    this.name = 'MealEstimationUnavailableError';
  }
}

/**
 * Whether the estimation path can run. Mirrors isCoachKeyConfigured — the UI
 * reads this to keep the "Describe or snap" affordance honest. Flips when the
 * Coach model client merges and a provider key is configured.
 */
export function isMealEstimationAvailable(): boolean {
  return false;
}

/**
 * Estimate a meal from a photo or a description. Today: always throws
 * {@link MealEstimationUnavailableError}; the contract is what ships. The UI
 * treats the error as "arrives with the Coach", identical to the mock Coach's
 * honesty rule — a nutrition number ARC invented would be worse than none.
 */
export async function estimateMeal(_input: EstimateInput): Promise<MealEstimate> {
  throw new MealEstimationUnavailableError();
}
