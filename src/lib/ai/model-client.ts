/**
 * The direct, on-device Claude Messages API client and its agentic tool loop.
 *
 * This is the ONE online feature (local-first, offline-except-AI — see the
 * 2026-07-24 ADR): the app calls the Messages API directly over streaming
 * fetch, with the user's own key. No SDK — the official JS SDK isn't built for
 * the Hermes/Expo runtime, and the wire format is small; raw HTTP over
 * `expo/fetch` (which streams in React Native) keeps this dependency-free.
 *
 * Deliberately PURE: no expo imports, no database imports. The fetch
 * implementation is injected via {@link ModelClientConfig}, so the exact same
 * code runs on device (expo/fetch, injected by coach-service.ts) and in the
 * headless tests (a mocked fetch — db/model-client.test.mjs). Tool execution
 * is likewise a callback: the loop knows *that* the model called a tool, the
 * caller decides what running it means (repos, confirmation gates).
 *
 * The loop is the standard Messages API tool-use cycle: send messages + tools
 * → stream the reply → if it stops with `tool_use`, execute the calls, append
 * the assistant turn and a `tool_result` user turn, and continue — until the
 * model answers in plain text (`end_turn`) or a guard trips.
 *
 * Model notes (claude-opus-5, the default): thinking is on by default and its
 * blocks stream with empty text; they are accumulated verbatim and echoed back
 * unchanged on tool continuations (required by the API). Sampling params
 * (temperature/top_p/top_k) are not sent — the current models reject them.
 * A `refusal` stop reason is surfaced, never retried. The system prompt and
 * tool list carry prompt-cache breakpoints (buildMessagesRequest) so the large
 * fixed prefix bills at cache-read rates across a turn's round-trips.
 */
import type { CoachStopReason, CoachToolCall, CoachTurnResult } from './types';

// --- Configuration -----------------------------------------------------------

export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

/** The default model — the latest Claude, used until the user picks in Settings. */
export const DEFAULT_MODEL = 'claude-opus-5';

/**
 * The models the Coach may run, chosen in Settings (src/lib/ai/api-key-store.ts
 * persists the pick). The default stays the most capable; Sonnet is flagged
 * because it is near-Opus on this workload at a fraction of the cost (the
 * per-interaction cost analysis in docs/ai-coach.md).
 */
export const COACH_MODELS = [
  { id: 'claude-opus-5', label: 'Opus 5', note: 'Deepest reasoning · highest cost' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', note: 'Near-Opus quality · ~⅓ the cost' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', note: 'Fastest · cheapest' },
] as const;

export type CoachModelId = (typeof COACH_MODELS)[number]['id'];

/** Guard: is `id` a model the Coach is allowed to run? Rejects stale stored ids. */
export function isCoachModel(id: string): id is CoachModelId {
  return COACH_MODELS.some((m) => m.id === id);
}

/**
 * Output cap per model round-trip. On models with default-on thinking this
 * bounds thinking + text together, so it carries headroom beyond chat-sized
 * replies.
 */
const DEFAULT_MAX_TOKENS = 8192;

/** Hard ceiling on model round-trips in one turn — a runaway-loop guard. */
const MAX_MODEL_CALLS_PER_TURN = 8;

/** The subset of the fetch surface the client needs — expo/fetch satisfies it. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<FetchResponseLike>;

export type FetchResponseLike = {
  ok: boolean;
  status: number;
  body: StreamLike | null;
  text(): Promise<string>;
};

type StreamLike = {
  getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> };
};

export type ModelClientConfig = {
  apiKey: string;
  model: string;
  /** expo/fetch on device; a scripted mock in tests. */
  fetchImpl: FetchLike;
  maxTokens?: number;
};

// --- Wire types (the slice of the Messages API this client speaks) -----------

/** An ephemeral prompt-cache breakpoint — everything before it is cached. */
export type CacheControl = { type: 'ephemeral' };

export type WireTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: CacheControl;
};

/** A `system` content block — array form so it can carry a cache breakpoint. */
export type WireSystemBlock = { type: 'text'; text: string; cache_control?: CacheControl };

export type WireTextBlock = { type: 'text'; text: string };
export type WireToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
export type WireToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};
/**
 * Thinking (and any future block kind) is carried opaquely: accumulated off
 * the stream and echoed back unchanged — the API requires thinking blocks to
 * round-trip verbatim on tool continuations.
 */
export type WireOpaqueBlock = { type: string } & Record<string, unknown>;

export type WireContentBlock =
  WireTextBlock | WireToolUseBlock | WireToolResultBlock | WireOpaqueBlock;

export type WireMessage = {
  role: 'user' | 'assistant';
  content: string | WireContentBlock[];
};

export type AgenticRequest = {
  system: string;
  /** The conversation so far, oldest first, ending in the user turn. */
  messages: WireMessage[];
  tools: WireTool[];
};

/** What executing one tool produced — the caller owns semantics (and gating). */
export type ToolExecutionOutcome = {
  /** The tool_result content sent back to the model (JSON or plain text). */
  content: string;
  isError?: boolean;
  /** True when a confirmation gate declined the call (recorded, not an error). */
  declined?: boolean;
};

export type CoachTurnHandlers = {
  /** Called for each streamed text fragment, in order. */
  onToken: (chunk: string) => void;
  /** Called as each tool call starts — drives "checking your data…" UI. */
  onToolCall?: (call: { name: string; input: unknown }) => void;
  /** Execute one tool call. Throwing here becomes an is_error tool result. */
  executeTool: (name: string, input: unknown) => Promise<ToolExecutionOutcome>;
  signal?: AbortSignal;
};

/** A non-2xx API response, with the server's error type/message when present. */
export class ModelRequestError extends Error {
  readonly status: number;
  readonly errorType: string | null;

  constructor(status: number, errorType: string | null, message: string) {
    super(message);
    this.name = 'ModelRequestError';
    this.status = status;
    this.errorType = errorType;
  }
}

/**
 * A turn that failed AFTER tool calls already executed. Tools run against the
 * real database mid-turn, so a later network failure must not lose the record
 * of what was already done — the caller persists `toolCalls` for the audit
 * trail even though the turn errored.
 */
export class CoachTurnError extends Error {
  readonly partialText: string;
  readonly toolCalls: CoachToolCall[];

  constructor(cause: unknown, partialText: string, toolCalls: CoachToolCall[]) {
    super(cause instanceof Error ? cause.message : 'Coach turn failed.');
    this.name = 'CoachTurnError';
    this.partialText = partialText;
    this.toolCalls = toolCalls;
  }
}

// --- Request building (pure, unit-tested) ------------------------------------

export type BuiltRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

/** Build the streaming Messages API request for one model round-trip. */
export function buildMessagesRequest(
  config: ModelClientConfig,
  request: AgenticRequest
): BuiltRequest {
  // Prompt caching (docs/ai-coach.md): the system prompt and the whole tool
  // list are the largest stable prefix, re-sent on every round-trip of every
  // turn. Render order is tools → system → messages, so a breakpoint on the
  // system block caches tools+system together; a second on the last tool keeps
  // the tool list cached across the daily system-prompt date change. Cache
  // reads bill at ~0.1×, and the prefix clears Opus 5's 512-token minimum.
  const cache: CacheControl = { type: 'ephemeral' };
  const system: WireSystemBlock[] = [{ type: 'text', text: request.system, cache_control: cache }];
  const tools =
    request.tools.length > 0
      ? request.tools.map((tool, i) =>
          i === request.tools.length - 1 ? { ...tool, cache_control: cache } : tool
        )
      : undefined;

  return {
    url: ANTHROPIC_MESSAGES_URL,
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-api-key': config.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      system,
      messages: request.messages,
      ...(tools ? { tools } : {}),
    }),
  };
}

// --- SSE parsing (pure, unit-tested) -----------------------------------------

export type SseEvent = { event: string; data: string };

/**
 * Incremental Server-Sent-Events parser. Feed it decoded chunks (which may
 * split lines and events arbitrarily); it yields complete events. Handles
 * multi-line `data:` fields, CRLF, and `:` comment lines.
 */
export class SseParser {
  private buffer = '';
  private eventName = '';
  private dataLines: string[] = [];

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let newlineAt: number;
    while ((newlineAt = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, newlineAt);
      this.buffer = this.buffer.slice(newlineAt + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (line === '') {
        const event = this.takeEvent();
        if (event) events.push(event);
      } else if (line.startsWith('event:')) {
        this.eventName = line.slice(6).trimStart();
      } else if (line.startsWith('data:')) {
        this.dataLines.push(line.slice(5).trimStart());
      }
      // Comment lines (":…") and unknown fields are ignored per the SSE spec.
    }
    return events;
  }

  /** Emit any event left unterminated when the stream closed. */
  flush(): SseEvent[] {
    // A final line may have arrived without its newline — consume it first.
    if (this.buffer.length > 0) {
      let line = this.buffer;
      this.buffer = '';
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.startsWith('event:')) this.eventName = line.slice(6).trimStart();
      else if (line.startsWith('data:')) this.dataLines.push(line.slice(5).trimStart());
    }
    const event = this.takeEvent();
    return event ? [event] : [];
  }

  private takeEvent(): SseEvent | null {
    if (this.dataLines.length === 0) {
      this.eventName = '';
      return null;
    }
    const event = { event: this.eventName, data: this.dataLines.join('\n') };
    this.eventName = '';
    this.dataLines = [];
    return event;
  }
}

// --- Stream accumulation (pure, unit-tested) ---------------------------------

type StreamDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'signature_delta'; signature: string };

type StreamEventData = {
  type: string;
  index?: number;
  content_block?: WireOpaqueBlock;
  delta?: (StreamDelta | { stop_reason?: string }) & Record<string, unknown>;
  error?: { type?: string; message?: string };
};

export type AccumulatedMessage = {
  /** The reply's content blocks, in order, ready to echo back verbatim. */
  blocks: WireContentBlock[];
  /** The wire stop reason ('end_turn' | 'tool_use' | …), '' if never sent. */
  stopReason: string;
};

/**
 * Folds a stream of Messages API SSE events into the final assistant message,
 * emitting text fragments through `onToken` as they arrive. Thinking blocks
 * are kept verbatim (empty text and all) so continuations can echo them.
 */
export class MessageAccumulator {
  private blocks: WireContentBlock[] = [];
  private partialJson = new Map<number, string>();
  private stopReason = '';
  // Explicit field, not a constructor parameter property — Node's strip-only
  // TS mode (the headless tests) can't erase parameter properties.
  private readonly onToken: (chunk: string) => void;

  constructor(onToken: (chunk: string) => void) {
    this.onToken = onToken;
  }

  consume(event: SseEvent): void {
    if (event.data === '') return;
    const data = JSON.parse(event.data) as StreamEventData;

    switch (data.type) {
      case 'error': {
        const err = data.error ?? {};
        throw new ModelRequestError(0, err.type ?? null, err.message ?? 'stream error');
      }
      case 'content_block_start': {
        const index = data.index ?? this.blocks.length;
        // Copy so accumulation never mutates the parsed event.
        this.blocks[index] = { ...(data.content_block ?? { type: 'text', text: '' }) };
        if ((this.blocks[index] as WireToolUseBlock).type === 'tool_use') {
          this.partialJson.set(index, '');
        }
        break;
      }
      case 'content_block_delta': {
        const index = data.index ?? 0;
        const block = this.blocks[index];
        const delta = data.delta as StreamDelta | undefined;
        if (!block || !delta) break;
        if (delta.type === 'text_delta') {
          (block as WireTextBlock).text = ((block as WireTextBlock).text ?? '') + delta.text;
          this.onToken(delta.text);
        } else if (delta.type === 'input_json_delta') {
          this.partialJson.set(index, (this.partialJson.get(index) ?? '') + delta.partial_json);
        } else if (delta.type === 'thinking_delta') {
          const b = block as WireOpaqueBlock & { thinking?: string };
          b.thinking = (b.thinking ?? '') + delta.thinking;
        } else if (delta.type === 'signature_delta') {
          (block as WireOpaqueBlock & { signature?: string }).signature = delta.signature;
        }
        break;
      }
      case 'content_block_stop': {
        const index = data.index ?? 0;
        const block = this.blocks[index];
        if (block && block.type === 'tool_use') {
          const raw = this.partialJson.get(index) ?? '';
          let input: unknown = {};
          if (raw.trim() !== '') {
            try {
              input = JSON.parse(raw);
            } catch {
              // Truncated tool input (max_tokens hit mid tool call) — leave {}
              // so the turn degrades to the max_tokens path instead of a raw
              // SyntaxError discarding the streamed text.
            }
          }
          (block as WireToolUseBlock).input = input;
        }
        break;
      }
      case 'message_delta': {
        const stop = (data.delta as { stop_reason?: string } | undefined)?.stop_reason;
        if (stop) this.stopReason = stop;
        break;
      }
      // message_start / message_stop / ping carry nothing the loop needs.
      default:
        break;
    }
  }

  finish(): AccumulatedMessage {
    // Sparse indices can't happen on a well-formed stream; compact defensively.
    return { blocks: this.blocks.filter(Boolean), stopReason: this.stopReason };
  }
}

// --- One streamed round-trip -------------------------------------------------

async function streamOnce(
  config: ModelClientConfig,
  request: AgenticRequest,
  onToken: (chunk: string) => void,
  signal?: AbortSignal
): Promise<AccumulatedMessage> {
  const { url, headers, body } = buildMessagesRequest(config, request);
  const response = await config.fetchImpl(url, { method: 'POST', headers, body, signal });

  if (!response.ok) {
    let errorType: string | null = null;
    let message = `Model request failed (HTTP ${response.status}).`;
    try {
      const parsed = JSON.parse(await response.text()) as {
        error?: { type?: string; message?: string };
      };
      errorType = parsed.error?.type ?? null;
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // Non-JSON error body; keep the status message.
    }
    throw new ModelRequestError(response.status, errorType, message);
  }
  if (!response.body) {
    throw new ModelRequestError(response.status, null, 'Model response had no stream body.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const accumulator = new MessageAccumulator(onToken);

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    for (const event of parser.push(decoder.decode(value, { stream: true }))) {
      accumulator.consume(event);
    }
  }
  for (const event of parser.flush()) accumulator.consume(event);

  const message = accumulator.finish();
  // message_delta (with stop_reason) always precedes a well-formed stream's
  // end — an empty stop reason means the connection dropped mid-reply. Surface
  // it as an error so a truncated reply is never persisted as complete.
  if (message.stopReason === '') {
    throw new ModelRequestError(0, null, 'Model stream ended before the reply completed.');
  }
  return message;
}

// --- The agentic loop --------------------------------------------------------

function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

const textOf = (blocks: WireContentBlock[]): string =>
  blocks
    .filter((b): b is WireTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

/**
 * Run one full Coach turn: stream the model's reply, execute any tool calls it
 * makes (via `handlers.executeTool` — where the caller's confirmation gate
 * lives), feed the results back, and repeat until it answers in text.
 *
 * Returns the final text (identical to what `onToken` streamed), the complete
 * tool-call record for persistence, and why the turn stopped.
 */
export async function runCoachTurn(
  config: ModelClientConfig,
  request: AgenticRequest,
  handlers: CoachTurnHandlers
): Promise<CoachTurnResult> {
  const messages: WireMessage[] = [...request.messages];
  const toolCalls: CoachToolCall[] = [];
  let text = '';

  for (let call = 0; call < MAX_MODEL_CALLS_PER_TURN; call++) {
    if (handlers.signal?.aborted) {
      // Preserve the audit trail if writes already executed this turn — mirror
      // the streamOnce catch below so an unmount mid-turn still persists the
      // tool-call record (use-coach-chat drops a bare AbortError without saving).
      throw toolCalls.length > 0 ? new CoachTurnError(abortError(), text, toolCalls) : abortError();
    }

    let reply: AccumulatedMessage;
    try {
      reply = await streamOnce(config, { ...request, messages }, handlers.onToken, handlers.signal);
    } catch (error) {
      // Tool calls already executed against the database — carry their record
      // out with the failure so the caller can persist the audit trail.
      if (toolCalls.length > 0) throw new CoachTurnError(error, text, toolCalls);
      throw error;
    }
    text += textOf(reply.blocks);

    // A tool_use stop with no tool_use blocks would send an empty tool_result
    // turn (a 400) — treat that malformed shape as a normal end of turn too.
    const hasToolUse = reply.blocks.some((b) => b.type === 'tool_use');
    if (reply.stopReason !== 'tool_use' || !hasToolUse) {
      const stopReason: CoachStopReason =
        reply.stopReason === 'refusal'
          ? 'refusal'
          : // Context-window exhaustion is truncation too — don't present a
            // cut-off reply as a normally completed one.
            reply.stopReason === 'max_tokens' ||
              reply.stopReason === 'model_context_window_exceeded'
            ? 'max_tokens'
            : 'end_turn';
      return { text, toolCalls, stopReason };
    }

    // Tool round: echo the assistant turn verbatim (thinking blocks included),
    // run every requested tool, and answer with their results in ONE user turn.
    messages.push({ role: 'assistant', content: reply.blocks });

    const results: WireToolResultBlock[] = [];
    for (const block of reply.blocks) {
      if (block.type !== 'tool_use') continue;
      const toolUse = block as WireToolUseBlock;
      if (handlers.signal?.aborted) {
        // Preserve the audit trail if writes already executed this turn — mirror
        // the streamOnce catch below so an unmount mid-turn still persists the
        // tool-call record (use-coach-chat drops a bare AbortError without saving).
        throw toolCalls.length > 0
          ? new CoachTurnError(abortError(), text, toolCalls)
          : abortError();
      }
      handlers.onToolCall?.({ name: toolUse.name, input: toolUse.input });

      let outcome: ToolExecutionOutcome;
      try {
        outcome = await handlers.executeTool(toolUse.name, toolUse.input);
      } catch (error) {
        outcome = {
          content: error instanceof Error ? error.message : 'Tool execution failed.',
          isError: true,
        };
      }
      toolCalls.push({
        id: toolUse.id,
        name: toolUse.name,
        input: toolUse.input,
        result: outcome.content,
        ...(outcome.isError ? { isError: true } : {}),
        ...(outcome.declined ? { declined: true } : {}),
      });
      results.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: outcome.content,
        ...(outcome.isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: 'user', content: results });

    // Visual seam between a spoken preamble and the post-tool continuation.
    if (text.length > 0 && !text.endsWith('\n')) {
      handlers.onToken('\n\n');
      text += '\n\n';
    }
  }

  return { text, toolCalls, stopReason: 'tool_use_limit' };
}
