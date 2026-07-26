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
};

/** What the service seam reports back as a reply streams in. */
export type CoachStreamHandlers = {
  onToken: (chunk: string) => void;
};
