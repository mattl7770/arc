/**
 * What a Coach turn actually cost.
 *
 * Before this the model client discarded every usage field and nothing in the
 * app counted tokens or dollars — while model-client.ts justified its default
 * with "the per-interaction cost analysis in docs/ai-coach.md", an analysis
 * that did not exist. For an app whose ONLY recurring cost is model tokens,
 * that is the one number the owner needs to make an informed choice between
 * Opus and Sonnet.
 *
 * Prices are USD per million tokens, as published for each model. They are a
 * constant in the app, so they can drift from reality — every rendering says
 * "est." and rounds coarsely, because a precise-looking wrong number is worse
 * than an obviously approximate one.
 *
 * Pure; headless-tested in db/coach-eval.test.mjs.
 */
import type { CoachUsage } from './types';

/** USD per million tokens. Cache reads bill ~0.1×, cache writes ~1.25×. */
type Price = { input: number; output: number };

const PRICES: Record<string, Price> = {
  'claude-opus-5': { input: 5, output: 25 },
  // Sonnet 5 is at INTRODUCTORY pricing ($2/$10) through 2026-08-31; it reverts
  // to $3/$15 after that. The whole point of this module is helping the owner
  // choose between Opus and Sonnet, and quoting the post-intro rate today
  // overstates Sonnet by 50% — i.e. gets the one comparison it exists for
  // wrong. REVISIT 2026-09-01: change to { input: 3, output: 15 }.
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

const CACHE_READ_MULTIPLIER = 0.1;
/**
 * 2× because the client writes the 1-hour cache, not the 5-minute default
 * (see CACHE_TTL in model-client.ts). Quoting 1.25 here would understate every
 * cold turn — the exact number the owner is trying to drive down.
 */
const CACHE_WRITE_MULTIPLIER = 2;

/** Estimated USD for one turn's usage on a given model; null for unknown models. */
export function estimateCost(usage: CoachUsage, model: string): number | null {
  const price = PRICES[model];
  if (!price) return null;
  const perToken = price.input / 1_000_000;
  return (
    usage.inputTokens * perToken +
    usage.cacheReadTokens * perToken * CACHE_READ_MULTIPLIER +
    usage.cacheWriteTokens * perToken * CACHE_WRITE_MULTIPLIER +
    (usage.outputTokens * price.output) / 1_000_000
  );
}

/** "9.1k" / "820" — token counts at a glance, never more precision than is real. */
function compactTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * The muted caption under a reply: "1 tool call · 9.1k cached · 340 out · ~$0.004".
 *
 * It names CACHED tokens separately on purpose. A provider dashboard reports
 * one lump total, so a turn that re-read a warm 9k prefix looks identical to
 * one that paid full price for it — and the first costs a tenth of the second.
 * Without the split, "I burned 10k tokens on one question" is unanswerable:
 * you cannot tell a cache problem from a round-trip problem from a thinking
 * problem. This is the instrument for exactly that.
 *
 * Sub-cent turns get three decimals rather than "<$0.01", because at ~$0.004 a
 * turn the difference between 0.004 and 0.009 is the whole optimisation.
 */
export function usageCaption(
  usage: CoachUsage | undefined,
  model: string,
  toolCount: number
): string | null {
  if (!usage || usage.outputTokens + usage.inputTokens + usage.cacheReadTokens === 0) return null;
  const cost = estimateCost(usage, model);
  const parts: string[] = [];

  if (toolCount > 0) parts.push(`${toolCount} tool call${toolCount === 1 ? '' : 's'}`);
  // Cold writes are the expensive event worth seeing; a warm read is the cheap
  // one worth confirming. Showing whichever happened tells you which you got.
  if (usage.cacheWriteTokens > 0)
    parts.push(`${compactTokens(usage.cacheWriteTokens)} cache write`);
  if (usage.cacheReadTokens > 0) parts.push(`${compactTokens(usage.cacheReadTokens)} cached`);
  if (usage.inputTokens > 0) parts.push(`${compactTokens(usage.inputTokens)} in`);
  if (usage.outputTokens > 0) parts.push(`${compactTokens(usage.outputTokens)} out`);

  if (cost !== null) {
    parts.push(
      cost < 0.01 ? `~$${cost.toFixed(3)}` : `~$${(Math.round(cost * 100) / 100).toFixed(2)}`
    );
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}
