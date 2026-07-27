/**
 * The AI-assist seam for training recommendations — DESIGNED, NOT WIRED.
 *
 * ARC's training intelligence is rule-based and offline by default (freshness +
 * progression + e1RM — see recommend.ts / training-recommend.ts). This module
 * is the single, isolated place an ONLINE, AI-assisted recommendation would
 * layer on top: given today's rule-based result plus context, the Coach model
 * could reorder, substitute, or annotate — but only as an enhancement, never as
 * a replacement, and only when a key is configured and the network is up.
 *
 * It is deliberately a stub. The Coach's model client + tool layer
 * (src/lib/ai/model-client.ts, src/lib/ai/tools/*) live on a parallel branch not
 * yet merged to main, so importing them here would not compile. When that lands,
 * `enhanceRecommendation` swaps its body to call the SHARED model client — there
 * must be exactly one model path in the app (the Coach's), never a second one
 * opened here. Until then this returns `available: false` and the caller uses
 * the offline recommendation as-is.
 */
import type { Recommendation } from './types';

export type AssistResult = {
  /** True only once the Coach model client is wired AND a key is configured. */
  available: boolean;
  /** The (possibly refined) recommendation to show. */
  recommendation: Recommendation;
  /** Human note when the assist is unavailable/offline. */
  note?: string;
};

/**
 * Returns the offline recommendation unchanged today. The seam: when the Coach
 * model client merges, this becomes an async call that passes the rule-based
 * recommendation + freshness/history context to the model and merges the reply.
 */
export function enhanceRecommendation(offline: Recommendation): AssistResult {
  return {
    available: false,
    recommendation: offline,
    note: 'AI-assisted planning arrives with the Coach; today ARC plans your session on-device.',
  };
}
