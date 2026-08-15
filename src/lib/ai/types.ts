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
  /** The wire `tool_use` block id. */
  id: string;
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
};

/** The full outcome of one Coach turn (possibly many model round-trips). */
export type CoachTurnResult = {
  /** The final assistant text, as streamed. */
  text: string;
  /** Every tool call the turn made, in execution order. */
  toolCalls: CoachToolCall[];
  stopReason: CoachStopReason;
  /** What the turn cost, summed over its round-trips. */
  usage?: CoachUsage;
};
