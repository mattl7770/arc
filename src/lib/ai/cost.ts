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

/**
 * USD per million tokens, as published on the live pricing page
 * (platform.claude.com/docs/en/about-claude/pricing, read 2026-10-21).
 *
 * `cacheRead` is a price of its own rather than a multiple, because it stopped
 * being one: it is 0.1× input on most models (Sonnet 5.5's $0.20 of $2
 * included) but 0.05× on Opus 5.5 and 0.025× on Fable 5.1. Cache WRITES are
 * still multiples of the input price on every model —
 * 1.25× for the 5-minute cache and 2× for the 1-hour one (same page).
 *
 * `longPrompt` is Haiku 5.5's second rate card: a REQUEST whose prompt (input +
 * cache reads + cache writes) is over the threshold pays it on every token of
 * that request, output included. Each request is priced on its own, which is
 * why the spend ledger prices per round trip (src/lib/ai/spend-ledger.ts) — a
 * turn's summed usage cannot say which of its requests crossed the line.
 */
export type Price = {
  input: number;
  output: number;
  cacheRead: number;
  longPrompt?: { overTokens: number; input: number; output: number; cacheRead: number };
};

/**
 * Every model the app can run. A model missing here prices as null — "not
 * priced" — never as a guess; db/coach-eval.test.mjs pins that every
 * `COACH_MODELS` id has a row, so the picker and this table cannot drift.
 */
export const PRICES: Readonly<Record<string, Price>> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  // $2/$10 was announced as introductory pricing through 2026-08-31. The
  // pricing page now says it "is now the standard price" and that the rise to
  // $3/$15 "will not occur" (checked 2026-10-21), so the 2026-09-01 REVISIT
  // this row used to carry is retired rather than applied.
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    longPrompt: { overTokens: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 },
  },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
};

/** The 5-minute cache write, as a multiple of the input price. */
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
/**
 * The 1-hour cache write. The big prefix (tools + system) is written at the
 * 1-hour TTL (CACHE_TTL in model-client.ts), and a write the API did not break
 * down by TTL is priced at this rate too: quoting 1.25 would understate every
 * cold turn — the exact number the owner is trying to drive down.
 */
const CACHE_WRITE_1H_MULTIPLIER = 2;

/**
 * USD per provider-side web search: $10 per 1,000 on the Claude API (the web
 * search tool's published pricing, checked 2026-10-21), on top of tokens. The
 * same on every model. A search that errors is not billed, and the API leaves
 * it out of `web_search_requests`, which is the count this multiplies.
 */
const WEB_SEARCH_USD = 10 / 1000;

/**
 * Estimated USD for some usage on a given model; null for unknown models.
 *
 * Exact for ONE request. For a sum of requests it is exact on every model but
 * Haiku 5.5, whose rate card is chosen per request by prompt length: a summed
 * turn is judged as if it were one request, which can only overstate it. The
 * Coach caption avoids that by summing per-request estimates instead
 * (`CoachTurnResult.estimatedUsd`, model-client.ts).
 */
export function estimateCost(usage: CoachUsage, model: string): number | null {
  const base = PRICES[model];
  if (!base) return null;
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const rate = base.longPrompt && prompt > base.longPrompt.overTokens ? base.longPrompt : base;
  const perInput = rate.input / 1_000_000;
  // Writes the API broke down by TTL are priced by TTL; the rest at 1 hour.
  const write5m = Math.min(Math.max(usage.cacheWrite5mTokens ?? 0, 0), usage.cacheWriteTokens);
  const write1h = usage.cacheWriteTokens - write5m;
  return (
    usage.inputTokens * perInput +
    (usage.cacheReadTokens * rate.cacheRead) / 1_000_000 +
    write5m * perInput * CACHE_WRITE_5M_MULTIPLIER +
    write1h * perInput * CACHE_WRITE_1H_MULTIPLIER +
    (usage.outputTokens * rate.output) / 1_000_000 +
    (usage.webSearchRequests ?? 0) * WEB_SEARCH_USD
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
 *
 * `estimatedUsd`, when the caller has it, is the turn's cost summed request by
 * request (`CoachTurnResult.estimatedUsd`) and wins over pricing the summed
 * usage — see {@link estimateCost} for the one model where those differ.
 */
export function usageCaption(
  usage: CoachUsage | undefined,
  model: string,
  toolCount: number,
  estimatedUsd?: number | null
): string | null {
  if (!usage || usage.outputTokens + usage.inputTokens + usage.cacheReadTokens === 0) return null;
  const cost = estimatedUsd !== undefined ? estimatedUsd : estimateCost(usage, model);
  const parts: string[] = [];

  if (toolCount > 0) parts.push(`${toolCount} tool call${toolCount === 1 ? '' : 's'}`);
  // A search bills per search, not per token, so it is named on its own.
  const searches = usage.webSearchRequests ?? 0;
  if (searches > 0) parts.push(`${searches} search${searches === 1 ? '' : 'es'}`);
  // Cold writes are the expensive event worth seeing; a warm read is the cheap
  // one worth confirming. Showing whichever happened tells you which you got.
  if (usage.cacheWriteTokens > 0)
    parts.push(`${compactTokens(usage.cacheWriteTokens)} cache write`);
  if (usage.cacheReadTokens > 0) parts.push(`${compactTokens(usage.cacheReadTokens)} cached`);
  if (usage.inputTokens > 0) parts.push(`${compactTokens(usage.inputTokens)} in`);
  if (usage.outputTokens > 0) parts.push(`${compactTokens(usage.outputTokens)} out`);

  if (cost !== null) {
    // Floor the tiny bucket rather than round it: a turn that billed a warm
    // cache read costs a real fraction of a cent, and toFixed(3) would round it
    // to "0.000" — presenting a nonzero cost as exactly zero, the very thing
    // this module exists to avoid. Below the three-decimal floor, say "<$0.001".
    parts.push(
      cost > 0 && cost < 0.0005
        ? '~<$0.001'
        : cost < 0.01
          ? `~$${cost.toFixed(3)}`
          : `~$${(Math.round(cost * 100) / 100).toFixed(2)}`
    );
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}
