/**
 * The usage policy — how much the Coach is allowed to do, as one switch
 * (2026-10-21; docs/spikes/chief-of-staff-release.md Track 1, the ADR "A
 * reversible usage policy" in docs/decisions.md).
 *
 * Every limiter that is a question of MONEY lives here, in three frozen
 * profiles, and each module that used to hold its own literal reads the active
 * profile at runtime ({@link activeUsagePolicy}). The owner picks the level on
 * Settings › Coach › Coach usage.
 *
 * ## The three rules that make it reversible
 *
 * 1. **LEAN IS TODAY, EXACTLY.** {@link LEAN_USAGE_POLICY} holds the values
 *    every module ran on before this file existed, and db/usage-policy.test.mjs
 *    pins it to a literal snapshot AND checks each module, under Lean, behaves
 *    on that exact value. "Switch back" is a guarantee of the suite, not of
 *    anyone's memory.
 * 2. **LEAN IS THE FLOOR.** When the setting cannot be read (no source
 *    installed — the headless suites, a module loaded before launch — a store
 *    that throws, a stored value that is not a level), the policy is Lean. A
 *    fresh install, where nothing has been stored yet, gets the owner's chosen
 *    default ({@link DEFAULT_USAGE_LEVEL}, Generous): "missing" there means
 *    "never chosen", not "broken".
 * 3. **THE PROFILE MOVES RUNTIME VALUES, NEVER THE CACHED PREFIX.** No field
 *    here is interpolated into the system prompt or a registry tool's schema,
 *    so switching levels leaves those bytes identical (tested). Three request
 *    PARAMETERS do move with the level, and the cache tiers they touch are
 *    stated rather than hidden: the web search tool's `max_uses` (it renders
 *    after the last registry tool, so the ~8k tool tier still reads and the
 *    system tier re-writes once), `output_config.effort` (invalidates the
 *    messages tier, and on some models more — pinned per call type, so only a
 *    switch moves it), and `max_tokens` (not part of the cache key). The
 *    `query_records` limits are named in that tool's DESCRIPTION, so they are
 *    policy fields with the SAME value at every level — moving them would be a
 *    prompt edit, not a switch.
 *
 * ## The soft daily budget
 *
 * Standard and Generous carry an optional soft budget (USD per logical day,
 * from the spend ledger's `spentToday`). Once today's estimated spend reaches
 * it, the rest of the day runs Lean; the next day starts on the chosen level
 * again. There is no end date and no automatic revert beyond that (owner,
 * 2026-10-21): he switches back himself.
 *
 * ## What is deliberately NOT here
 *
 * Decisions about attention, privacy or quality, not money: the 2 nudges a day
 * and quiet hours, the 3-question cap, the read-only pass, the doctor pack's
 * no-model-prose rule, search queries never carrying health data, the
 * deterministic thread summary, the lab-parse output floor, image downscaling.
 *
 * PURE, like model-client.ts: no expo, no database. The app installs the one
 * place the setting is read from at launch (src/lib/ai/usage-policy-store.ts),
 * the same seam the spend ledger's sink uses.
 */
import type { ModelCallType } from './call-types';

export const USAGE_LEVELS = ['lean', 'standard', 'generous'] as const;
export type UsageLevel = (typeof USAGE_LEVELS)[number];

/** The owner's default for a fresh install (2026-10-21). */
export const DEFAULT_USAGE_LEVEL: UsageLevel = 'generous';

export const USAGE_LEVEL_LABELS: Readonly<Record<UsageLevel, string>> = {
  lean: 'Lean',
  standard: 'Standard',
  generous: 'Generous',
};

/** `output_config.effort` values (the claude-api skill, checked 2026-10-21). */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type UsagePolicy = Readonly<{
  level: UsageLevel;

  // --- The model client (model-client.ts) ---
  /** `max_tokens` per round trip when the caller sets none (was DEFAULT_MAX_TOKENS). */
  maxTokensPerCall: number;
  /** Round trips one turn may make (was MAX_MODEL_CALLS_PER_TURN). */
  maxModelCallsPerTurn: number;
  /**
   * Effort sent per call type. A type with no entry sends none (the model's own
   * default); a model that rejects the parameter is never sent it
   * (model-client.ts `acceptsEffort`). Lean sends none at all.
   */
  effort: Readonly<Partial<Record<ModelCallType, EffortLevel>>>;

  // --- Models (api-key-store.ts; an explicit pick always wins) ---
  /** The Coach chat model when he has picked none. */
  chatModel: string;
  /** The one-shot calls' model when he has picked none; null = the chat model. */
  utilityModel: string | null;
  /** The unattended pass's model: an id, or 'chat' for the resolved chat model. */
  passModel: string;
  /** Whether the pass also reads `query_records` (it stays read-only either way). */
  passQueryRecords: boolean;
  /** Whether the pass may run the provider's web search. */
  passWebSearch: boolean;

  // --- Web search (web-search.ts) ---
  /** Searches per Coach turn (chat, and the pass when it may search). */
  coachWebSearchesPerTurn: number;
  /** Searches per estimate, correction or food description. */
  estimatorWebSearchesPerCall: number;

  // --- History (history-window.ts, thread-summary.ts) ---
  /** Messages replayed per turn. The thread summary's window is tied to it. */
  historyMessages: number;
  /** Characters of one replayed tool digest. */
  toolDigestChars: number;

  // --- Context (turn-context.ts, history-search.ts, record-tools.ts) ---
  /** Memories injected into every turn's context. */
  memoriesPerTurn: number;
  /** One search_history excerpt from a conversation or log. */
  historyExcerptChars: number;
  /** One search_history excerpt from a knowledge passage. */
  knowledgeExcerptChars: number;
  /** `query_records` rows by default. SAME at every level — see the header. */
  queryRecordsDefaultLimit: number;
  /** `query_records` rows at most. SAME at every level — see the header. */
  queryRecordsMaxLimit: number;

  // --- The estimators' per-call context (repeats.ts, ratings.ts) ---
  /** His usual foods sent with an estimate. */
  usualFoods: number;
  /** Corrections sent with an estimate… */
  correctionExamples: number;
  /** …and the characters that block may run to. */
  correctionChars: number;

  // --- The soft budget ---
  /** The level's default soft daily budget in USD; null = none. */
  dailyBudgetUsd: number | null;
}>;

/**
 * LEAN — exactly the values ARC ran on before the policy existed (main at
 * 4fa124d). Pinned by a literal snapshot in db/usage-policy.test.mjs. Do not
 * "tune" a number here: change Standard or Generous instead, or Lean stops
 * being the way back.
 */
export const LEAN_USAGE_POLICY: UsagePolicy = Object.freeze({
  level: 'lean',
  maxTokensPerCall: 8192,
  maxModelCallsPerTurn: 8,
  effort: Object.freeze({}),
  chatModel: 'claude-sonnet-5',
  utilityModel: null,
  passModel: 'claude-haiku-4-5',
  passQueryRecords: false,
  passWebSearch: false,
  coachWebSearchesPerTurn: 3,
  estimatorWebSearchesPerCall: 2,
  historyMessages: 30,
  toolDigestChars: 240,
  memoriesPerTurn: 40,
  historyExcerptChars: 300,
  knowledgeExcerptChars: 500,
  queryRecordsDefaultLimit: 10,
  queryRecordsMaxLimit: 25,
  usualFoods: 30,
  correctionExamples: 8,
  correctionChars: 1600,
  dailyBudgetUsd: null,
});

/**
 * STANDARD — the newer Sonnet throughout, and a pass that reads like the chat.
 * Each value sits between Lean and Generous for a stated reason
 * (docs/ai-coach.md §7d carries the table):
 * - Sonnet 5.5 for chat AND one-shot calls: the same per-token price as
 *   today's Sonnet 5, so the level spends more only through the limits below.
 * - 12,288 tokens a round trip: effort is now sent, and thinking shares the cap.
 * - 10 round trips: room for the pass's discovery call plus one more read.
 * - 4 searches a turn; estimates kept at 2, because the estimate is waited on.
 * - History 45 / digests 400, memories 60, excerpts 400 / 650, usual foods 40,
 *   corrections 10 / 2,000: half-way, each a per-call input cost.
 * - Effort: high for chat (Sonnet 5.5's own default, stated rather than
 *   implied), medium for the pass, imports and readings, low where the answer
 *   is a lookup he waits on, high where a misread is costly (lab parse, report).
 * - A $2.50 soft budget: about twice a typical Standard day.
 */
export const STANDARD_USAGE_POLICY: UsagePolicy = Object.freeze({
  level: 'standard',
  maxTokensPerCall: 12288,
  maxModelCallsPerTurn: 10,
  effort: Object.freeze({
    chat: 'high',
    pass: 'medium',
    meal_estimate: 'low',
    meal_revision: 'low',
    food_estimate: 'low',
    recipe_import: 'medium',
    recipe_pricing: 'low',
    recipe_revision: 'low',
    knowledge_import: 'medium',
    lab_parse: 'high',
    photo_reading: 'medium',
    report_read: 'high',
    exercise_ai: 'medium',
    workout_import: 'medium',
  }),
  chatModel: 'claude-sonnet-5-5',
  utilityModel: 'claude-sonnet-5-5',
  passModel: 'chat',
  passQueryRecords: true,
  passWebSearch: true,
  coachWebSearchesPerTurn: 4,
  estimatorWebSearchesPerCall: 2,
  historyMessages: 45,
  toolDigestChars: 400,
  memoriesPerTurn: 60,
  historyExcerptChars: 400,
  knowledgeExcerptChars: 650,
  queryRecordsDefaultLimit: 10,
  queryRecordsMaxLimit: 25,
  usualFoods: 40,
  correctionExamples: 10,
  correctionChars: 2000,
  dailyBudgetUsd: 2.5,
});

/**
 * GENEROUS — the owner's default (2026-10-21, promotional credits): Opus 5.5
 * for chat, Sonnet 5.5 for one-shot calls, the pass on the chat model with
 * `query_records` and web search, and the widest limits. Effort per call type:
 * high for chat and the pass, xhigh for the lab parse and the report read
 * (correctness over cost), low for the estimators (waited on, lookup-shaped),
 * medium for the imports and readings. $5 soft budget: two to three times a
 * typical Generous day (~$1.50–2.30 at the spike's estimate).
 */
export const GENEROUS_USAGE_POLICY: UsagePolicy = Object.freeze({
  level: 'generous',
  maxTokensPerCall: 16384,
  maxModelCallsPerTurn: 12,
  effort: Object.freeze({
    chat: 'high',
    pass: 'high',
    meal_estimate: 'low',
    meal_revision: 'low',
    food_estimate: 'low',
    recipe_import: 'medium',
    recipe_pricing: 'low',
    recipe_revision: 'low',
    knowledge_import: 'medium',
    lab_parse: 'xhigh',
    photo_reading: 'medium',
    report_read: 'xhigh',
    exercise_ai: 'medium',
    workout_import: 'medium',
  }),
  chatModel: 'claude-opus-5-5',
  utilityModel: 'claude-sonnet-5-5',
  passModel: 'chat',
  passQueryRecords: true,
  passWebSearch: true,
  coachWebSearchesPerTurn: 5,
  estimatorWebSearchesPerCall: 3,
  historyMessages: 60,
  toolDigestChars: 600,
  memoriesPerTurn: 80,
  historyExcerptChars: 500,
  knowledgeExcerptChars: 800,
  queryRecordsDefaultLimit: 10,
  queryRecordsMaxLimit: 25,
  usualFoods: 50,
  correctionExamples: 12,
  correctionChars: 2400,
  dailyBudgetUsd: 5,
});

export const USAGE_POLICIES: Readonly<Record<UsageLevel, UsagePolicy>> = Object.freeze({
  lean: LEAN_USAGE_POLICY,
  standard: STANDARD_USAGE_POLICY,
  generous: GENEROUS_USAGE_POLICY,
});

/** The soft-budget choices the screen offers, in USD; null = off. */
export const DAILY_BUDGET_CHOICES: readonly (number | null)[] = [null, 1, 2.5, 5, 10];

export function isUsageLevel(value: unknown): value is UsageLevel {
  return typeof value === 'string' && (USAGE_LEVELS as readonly string[]).includes(value);
}

/** The thread summary's window — tied to the history window, never set apart. */
export function summaryWindowOf(policy: UsagePolicy): number {
  return policy.historyMessages;
}

/** When the summary starts: ten messages past the window, as it always was (30 → 40). */
export function summaryTriggerOf(policy: UsagePolicy): number {
  return policy.historyMessages + 10;
}

// --- The stored setting, and what it resolves to ------------------------------

/**
 * What the store hands over: the raw stored setting (`undefined` when nothing
 * has ever been stored) and today's estimated spend — or `readable: false`
 * when the setting itself could not be read.
 */
export type UsageSourceRead =
  { readable: true; stored: unknown; spentTodayUsd: number } | { readable: false };

/** Why the effective level is what it is — the screen says it in words. */
export type UsageReason = 'chosen' | 'default' | 'budget' | 'unreadable';

export type UsageResolution = {
  /** The level he chose, or the default when he never has; Lean when unreadable. */
  chosen: UsageLevel;
  /** The level running now. */
  effective: UsageLevel;
  why: UsageReason;
  /** The chosen level's soft budget (his override, else the level's own). */
  budgetUsd: number | null;
  /** Today's estimated spend, or null when unreadable. */
  spentTodayUsd: number | null;
  policy: UsagePolicy;
};

const UNREADABLE: UsageResolution = Object.freeze({
  chosen: 'lean',
  effective: 'lean',
  why: 'unreadable',
  budgetUsd: null,
  spentTodayUsd: null,
  policy: LEAN_USAGE_POLICY,
}) as UsageResolution;

function isBudget(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * The budget a level runs under: his stored override (a number, or null for
 * "off") when there is one, else the level's own default. Lean has none — it
 * is the floor, so there is nothing below it to drop to.
 */
export function budgetFor(level: UsageLevel, budgets: unknown): number | null {
  if (level === 'lean') return null;
  if (budgets && typeof budgets === 'object' && !Array.isArray(budgets)) {
    const own = (budgets as Record<string, unknown>)[level];
    if (own === null) return null;
    if (isBudget(own)) return own;
  }
  return USAGE_POLICIES[level].dailyBudgetUsd;
}

/** Resolve a read into the level that runs now. PURE. */
export function resolveUsage(read: UsageSourceRead): UsageResolution {
  if (!read.readable) return UNREADABLE;
  const spent = Number.isFinite(read.spentTodayUsd) ? Math.max(0, read.spentTodayUsd) : 0;
  let chosen: UsageLevel;
  let why: UsageReason;
  let budgets: unknown;
  if (read.stored === undefined) {
    chosen = DEFAULT_USAGE_LEVEL;
    why = 'default';
  } else if (read.stored && typeof read.stored === 'object' && !Array.isArray(read.stored)) {
    const stored = read.stored as Record<string, unknown>;
    budgets = stored.budgets;
    if (stored.level === undefined) {
      // Only a budget was ever saved: the level is still the default.
      chosen = DEFAULT_USAGE_LEVEL;
      why = 'default';
    } else if (isUsageLevel(stored.level)) {
      chosen = stored.level;
      why = 'chosen';
    } else {
      return { ...UNREADABLE, spentTodayUsd: spent };
    }
  } else {
    return { ...UNREADABLE, spentTodayUsd: spent };
  }
  const budgetUsd = budgetFor(chosen, budgets);
  if (budgetUsd !== null && spent >= budgetUsd) {
    return {
      chosen,
      effective: 'lean',
      why: 'budget',
      budgetUsd,
      spentTodayUsd: spent,
      policy: LEAN_USAGE_POLICY,
    };
  }
  return {
    chosen,
    effective: chosen,
    why,
    budgetUsd,
    spentTodayUsd: spent,
    policy: USAGE_POLICIES[chosen],
  };
}

// --- The installed source (the app's, at launch) -----------------------------

let source: (() => UsageSourceRead) | null = null;

/**
 * Install (or, with null, remove) where the setting is read from. The app
 * installs the preferences reader at launch (usage-policy-store.ts); the
 * headless suites install their own. Returns the source it replaced.
 */
export function setUsagePolicySource(
  next: (() => UsageSourceRead) | null
): (() => UsageSourceRead) | null {
  const previous = source;
  source = next;
  return previous;
}

/**
 * The level running now, and why. Never throws: no source, or one that throws,
 * resolves to Lean ("unreadable") — the floor, never a guess upward.
 */
export function activeUsageResolution(): UsageResolution {
  if (!source) return UNREADABLE;
  try {
    return resolveUsage(source());
  } catch {
    return UNREADABLE;
  }
}

/** The profile every module reads at runtime. */
export function activeUsagePolicy(): UsagePolicy {
  return activeUsageResolution().policy;
}

/** The pass's model under `policy`, given the resolved chat model. */
export function passModelFor(policy: UsagePolicy, chatModel: string): string {
  return policy.passModel === 'chat' ? chatModel : policy.passModel;
}
