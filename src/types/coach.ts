/**
 * Chat view-model types for the Coach tab (docs/ai-coach.md).
 *
 * `ChatRole` is a deliberate subset of the `ai_messages.role` enum
 * ('user' | 'assistant' | 'system' | 'tool'): the thread only ever renders the
 * two conversational roles. System prompt and tool calls exist in the wire
 * format, not on screen. When this starts persisting to `ai_messages`, that is
 * a widening, not a redesign.
 */
export type ChatRole = 'user' | 'assistant';

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  /** Assistant message still streaming in. Drives the caret / typing state. */
  streaming?: boolean;
  /** Set when the send failed, so the row can offer a retry. */
  error?: boolean;
  /**
   * Human labels of the tools the turn used ("metric series", "reminder") —
   * the transparency chips under an assistant bubble. Derived from the
   * persisted `ai_messages.tool_calls` record.
   */
  tools?: string[];
};

/** What the service seam reports back as a reply streams in. */
export type CoachStreamHandlers = {
  onToken: (chunk: string) => void;
};

/** A Coach-initiated write awaiting the user's decision, as the UI shows it. */
export type PendingWrite = {
  /**
   * Per-request nonce. Approving must name WHICH request it approves — in a
   * multi-write turn the next gate can appear between a double-tap's first and
   * second press, and a bare approve would grant the new write sight-unseen.
   */
  id: number;
  tool: string;
  /** The one human line: "Log weight 178.0 lb". */
  summary: string;
};
