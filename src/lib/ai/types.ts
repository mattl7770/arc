/**
 * Types for the AI/Coach slice — row shapes mirroring db/migrations/
 * 0008_ai_chat.sql plus the agentic-loop records shared between the model
 * client, the repositories, and the chat view-model.
 *
 * Row types live here (not in src/lib/db/types.ts) by the parallel-work
 * convention (see src/lib/exercise/types.ts): slices keep their schema types
 * beside the feature and the integrator reconciles the shared file afterwards.
 * Keep the `Row` types in lockstep with the migration.
 */
import type { Timestamp } from '@/lib/db/types';

/** ai_messages.role — text + CHECK in the schema. Wider than the UI's two. */
export type AiMessageRole = 'user' | 'assistant' | 'system' | 'tool';

/** One `ai_conversations` row, as a SELECT returns it. */
export type AiConversationRow = {
  id: string;
  title: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/** One `ai_messages` row, as a SELECT returns it. Append-only: no updated_at. */
export type AiMessageRow = {
  id: string;
  conversation_id: string;
  role: AiMessageRole;
  content: string;
  /** JSON array of {@link CoachToolCall}, or NULL for a plain turn. */
  tool_calls: string | null;
  created_at: Timestamp;
};

/**
 * The durable record of one tool invocation inside a turn — what the model
 * asked for and what actually happened. Persisted (as a JSON array) in
 * `ai_messages.tool_calls`, so a transcript replays honestly: the numbers the
 * Coach cited trace back to the tool results it actually read.
 */
export type CoachToolCall = {
  /** The wire `tool_use` block id (`srvtoolu_…` for a web search). */
  id: string;
  /**
   * A registry tool's name, or `web_search` for a provider-side search
   * (src/lib/ai/web-search.ts), whose `result` is the JSON of its query and
   * the domains it found and cited. A search reads the web, never the record.
   */
  name: string;
  /** The model-supplied input, exactly as parsed off the wire. */
  input: unknown;
  /** The JSON string the tool returned (or the error text when isError). */
  result: string;
  isError?: boolean;
  /** True when the user declined the write at the confirmation gate. */
  declined?: boolean;
  /**
   * THE RECEIPT: the human line the user approved on the confirmation card
   * ("Save recipe "Chicken bowl" — 6 ingredients, 4 servings"), recorded ONLY
   * after `execute` returned without throwing (coach-service.ts).
   *
   * Its whole value is what it cannot do. A receipt is unforgeable by prose:
   * the model writes text, the service writes this, and the thread prints this.
   * So a turn that claims a save without calling the tool has no receipt to
   * show, and the owner's report — "saying that a recipe has been saved when
   * the tool was not called" — stops being invisible.
   *
   * Absent on reads (nothing to receipt), on declines and on errors (nothing
   * landed). Rides the existing `tool_calls` JSON, so it needed no migration
   * and old rows simply have none.
   */
  receipt?: string;
  /**
   * The line the confirmation card showed for a write the user DECLINED: the
   * mirror of {@link receipt}, set only alongside `declined` (coach-service.ts).
   *
   * Added 2026-10-21 with the whole-turn fix (owner: *"after you approve
   * something coach's message gets overridden, can lose info"*). The card is
   * docked above the composer and vanishes the moment it is answered, so an
   * approved write left its line in the thread as the receipt while a declined
   * one left nothing but a tool chip. Rides the `tool_calls` JSON like the
   * receipt; rows written before it fall back to the tool's name.
   */
  declinedSummary?: string;
};

/** Why a Coach turn stopped — the subset of wire stop reasons callers act on. */
export type CoachStopReason = 'end_turn' | 'max_tokens' | 'refusal' | 'tool_use_limit';

/**
 * Sentinel entry appended to a persisted turn's `tool_calls` when the reply
 * stopped early (max_tokens / the round-trip cap), so truncation survives a
 * reload without a schema migration. Never a real tool: the UI strips it from
 * the transparency chips and maps it to ChatMessage.truncated instead.
 */
export const TRUNCATION_MARKER = '__truncated__';

/**
 * Token counts for a whole turn, summed across its round-trips. Surfaced to
 * the user as a muted per-reply caption so the cost of the Coach is visible
 * rather than a black box (docs/coach-intelligence-review.md §4 #23).
 */
export type CoachUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * The part of `cacheWriteTokens` written at the 5-minute TTL
   * (`usage.cache_creation.ephemeral_5m_input_tokens`), which bills at 1.25×
   * rather than the 1-hour cache's 2×. Absent when the API sent no breakdown;
   * src/lib/ai/cost.ts then prices every write at the 1-hour rate.
   */
  cacheWrite5mTokens?: number;
  /**
   * Provider-side web searches the turn ran (2026-10-21), billed per search on
   * top of tokens. Absent on a turn that searched nothing, and on every row
   * written before search existed.
   */
  webSearchRequests?: number;
};

/** The full outcome of one Coach turn (possibly many model round-trips). */
export type CoachTurnResult = {
  /**
   * The SETTLED text: what the model said after its last tool result, falling
   * back to the earlier text when that is empty (model-client.ts
   * `settledText`). The answer only, for the callers that PARSE it: the coach
   * pass's sentinel, and every extraction that rides `runCoachTurn`.
   */
  text: string;
  /**
   * EVERYTHING the model wrote this turn, every round in order, joined by the
   * same seam the live stream used: what `onToken` delivered, minus trailing
   * whitespace.
   *
   * This is what the Coach THREAD keeps (use-coach-chat.ts): the bubble, the
   * `ai_messages` row, and so the history replayed to the model on later
   * turns. Settling the thread on `text` instead replaced a drafted entry with
   * "Saved." the moment it was approved (owner report, 2026-10-21).
   */
  transcript: string;
  /** Every tool call the turn made, in execution order. */
  toolCalls: CoachToolCall[];
  stopReason: CoachStopReason;
  /** What the turn cost, summed over its round-trips. */
  usage?: CoachUsage;
  /**
   * The turn's estimated USD, priced request by request and summed
   * (src/lib/ai/cost.ts) — null when the model has no price. Not the same as
   * pricing `usage`: Haiku 5.5's rate card is chosen per request.
   */
  estimatedUsd?: number | null;
};
