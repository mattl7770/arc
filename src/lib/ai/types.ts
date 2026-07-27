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
};

/** Why a Coach turn stopped — the subset of wire stop reasons callers act on. */
export type CoachStopReason = 'end_turn' | 'max_tokens' | 'refusal' | 'tool_use_limit';

/** The full outcome of one Coach turn (possibly many model round-trips). */
export type CoachTurnResult = {
  /** The final assistant text, as streamed. */
  text: string;
  /** Every tool call the turn made, in execution order. */
  toolCalls: CoachToolCall[];
  stopReason: CoachStopReason;
};
