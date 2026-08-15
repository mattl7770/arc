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
 * A turn's SETTLED text is what the model said after the last tool result, not
 * every text block it emitted along the way — see {@link settledText}. The live
 * `onToken` stream is unchanged and still carries everything, in order.
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

/**
 * The default model until the user picks in Settings.
 *
 * SONNET 5, not Opus (changed 2026-08-10 during first live testing). Sonnet is
 * described by Anthropic as near-Opus on agentic work and currently bills at
 * $2/$10 per MTok on introductory pricing — 2.5× cheaper than Opus 5's $5/$25,
 * and still 1.7× cheaper when it reverts to $3/$15 after 2026-08-31.
 *
 * This is a "measure, then decide" default, not a verdict on quality: the usage
 * captions now record input/cache/output per turn, so the Opus-vs-Sonnet call
 * can be made against real coach transcripts instead of a guess. Opus stays one
 * tap away in Settings.
 */
export const DEFAULT_MODEL = 'claude-sonnet-5';

/**
 * The models the Coach may run, chosen in Settings (src/lib/ai/api-key-store.ts
 * persists the pick).
 *
 * A caution on Haiku: its prompt-cache minimum is 4096 tokens, against 1024 for
 * Sonnet 5 and 512 for Opus 5. A prefix that caches fine on the other two can
 * silently fail to cache on Haiku — no error, just `cache_creation_input_tokens:
 * 0` and full price on every request. Keep an eye on it if the tool list ever
 * shrinks much further.
 */
export const COACH_MODELS = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5', note: 'Near-Opus quality · default' },
  { id: 'claude-opus-5', label: 'Opus 5', note: 'Deepest reasoning · ~2.5× the cost' },
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

/**
 * Cache lifetime for the big stable prefix (tools + system ≈ 10k tokens).
 *
 * ONE HOUR, not the five-minute default, because of how ARC is actually used.
 * A coach conversation is bursty: a question, a minute reading the answer, a
 * follow-up, then nothing until the afternoon. Under the 5-minute TTL almost
 * every *user-initiated* turn arrives cold and pays a 1.25× cache WRITE on the
 * whole prefix — measured at ~12,700 effective tokens per question, which is
 * what made three trivial test queries cost ~48k tokens.
 *
 * The 1-hour TTL writes at 2× instead of 1.25×, so it needs three requests to
 * pay off (2× + 0.2× vs 3× uncached). A single turn already makes 2–3
 * round-trips, so it breaks even inside the first question and every question
 * for the next hour reads at 0.1×.
 */
const CACHE_TTL = '1h' as const;

/** An ephemeral prompt-cache breakpoint — everything before it is cached. */
export type CacheControl = { type: 'ephemeral'; ttl?: '5m' | '1h' };

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
  /** The STABLE system text — personality, doctrine, rails. Carries the cache breakpoint. */
  system: string;
  /**
   * Per-turn facts (date, readiness, mode, mission, experiments — built by
   * src/lib/ai/turn-context.ts). Sent as a second, UNCACHED system block after
   * the breakpoint, so fresh context never busts the cached prefix.
   */
  systemContext?: string;
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
  /**
   * The approved line for a write that actually executed — see
   * `CoachToolCall.receipt`. The loop only carries it through to the record; the
   * caller decides when one is earned, because only the caller knows whether a
   * tool wrote anything.
   */
  receipt?: string;
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
  // STATIC system block caches tools+system together; a second on the last
  // tool keeps the tool list cached even if the system text changes. The
  // per-turn context rides a separate block AFTER the breakpoint, so fresh
  // facts (date, readiness, mission state) never invalidate the cached
  // prefix. Cache reads bill at ~0.1×; the prefix (~10k tokens, of which ~8k
  // is the tool list) clears Opus 5's 512-token minimum many times over.
  // See CACHE_TTL for why this is the one-hour cache, not the default.
  const cache: CacheControl = { type: 'ephemeral', ttl: CACHE_TTL };
  const system: WireSystemBlock[] = [{ type: 'text', text: request.system, cache_control: cache }];
  if (request.systemContext && request.systemContext.trim().length > 0) {
    system.push({ type: 'text', text: request.systemContext });
  }
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
  message?: { usage?: unknown };
  usage?: unknown;
  content_block?: WireOpaqueBlock;
  delta?: (StreamDelta | { stop_reason?: string }) & Record<string, unknown>;
  error?: { type?: string; message?: string };
};

/** Token counts for one round-trip, as the wire reports them. */
export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export type AccumulatedMessage = {
  /** The reply's content blocks, in order, ready to echo back verbatim. */
  blocks: WireContentBlock[];
  /** The wire stop reason ('end_turn' | 'tool_use' | …), '' if never sent. */
  stopReason: string;
  /** What this round-trip cost, summed from message_start + message_delta. */
  usage: Usage;
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
  // Usage arrives in two places: message_start carries the input side (and the
  // cache read/write split), message_delta the final output count.
  private usage: Usage = { ...ZERO_USAGE };
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
      case 'message_start': {
        this.mergeUsage(data.message?.usage);
        break;
      }
      case 'message_delta': {
        const stop = (data.delta as { stop_reason?: string } | undefined)?.stop_reason;
        if (stop) this.stopReason = stop;
        this.mergeUsage(data.usage);
        break;
      }
      // message_stop / ping carry nothing the loop needs.
      default:
        break;
    }
  }

  /** Fold a wire usage object in; later non-zero counts win (delta over start). */
  private mergeUsage(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const u = raw as Record<string, unknown>;
    const num = (key: string, current: number) =>
      typeof u[key] === 'number' && (u[key] as number) > 0 ? (u[key] as number) : current;
    this.usage = {
      inputTokens: num('input_tokens', this.usage.inputTokens),
      outputTokens: num('output_tokens', this.usage.outputTokens),
      cacheReadTokens: num('cache_read_input_tokens', this.usage.cacheReadTokens),
      cacheWriteTokens: num('cache_creation_input_tokens', this.usage.cacheWriteTokens),
    };
  }

  finish(): AccumulatedMessage {
    // Sparse indices can't happen on a well-formed stream; compact defensively.
    return {
      blocks: this.blocks.filter(Boolean),
      stopReason: this.stopReason,
      usage: this.usage,
    };
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
 * What the turn SETTLES on: the text the model produced after the last tool
 * result, falling back to everything it said earlier when that is empty.
 *
 * ## Why the earlier text is dropped (fixed 2026-08-11)
 *
 * This function used to not exist: the loop concatenated every text block from
 * every round-trip into one string, so a turn that used tools returned the
 * model's *narration of its intent* glued to its actual answer —
 * "I'll read the current state and check for anything worth flagging.\n\nYour
 * protein has been under target all week." That went into the bubble, into
 * `ai_messages.content`, into the rolling thread summary, and back into the
 * next turn's history window. Every tool-using turn in normal chat carried it;
 * it was merely most visible on the unattended pass (src/lib/ai/coach-pass.ts),
 * where the whole reply is two lines and the narration was half of them.
 *
 * The pre-tool text is narration BY CONSTRUCTION, not by heuristic: it was
 * written before the tool results existed, so it cannot contain a conclusion
 * drawn from them. On these models the actual reasoning rides in `thinking`
 * blocks, which never reach `text` at all — what is left in a pre-tool text
 * block is the "let me check X" the model says out loud. The answer is what it
 * says once it has the data.
 *
 * **The fallback is load-bearing.** A turn can legitimately end with no
 * post-tool text: the round-trip cap trips (`tool_use_limit`), or `max_tokens`
 * lands inside a tool call, or the model simply stops after a tool result. In
 * those cases the earlier text is all there is, and returning '' would persist
 * an empty assistant row over a turn that genuinely spoke. So the rule is
 * "prefer the answer", not "discard the narration".
 *
 * The narration is not thrown away in the failure path either — a turn that
 * dies mid-flight carries the whole {@link transcript} out on `CoachTurnError`,
 * because the audit record of a broken turn should be lossless.
 *
 * Nothing legitimately depends on the concatenation: `text` has exactly three
 * consumers (use-coach-chat's bubble/persistence, coach-service's empty-refusal
 * check, coach-pass's sentinel check), and all three want the answer.
 */
function settledText(narration: string, answer: string): string {
  return answer.trim().length > 0 ? answer : narration;
}

/**
 * Everything the model said this turn, in order — the lossless audit fragment
 * carried out on {@link CoachTurnError}. `narration` already carries the seam
 * the loop appended when it parked each round, so this is a plain join and is
 * byte-identical to the single `text` accumulator this pair replaced.
 */
function transcript(narration: string, answer: string): string {
  return narration + answer;
}

/**
 * Run one full Coach turn: stream the model's reply, execute any tool calls it
 * makes (via `handlers.executeTool` — where the caller's confirmation gate
 * lives), feed the results back, and repeat until it answers in text.
 *
 * Returns the settled text ({@link settledText} — the post-tool answer, which
 * is a SUFFIX of what `onToken` streamed rather than all of it), the complete
 * tool-call record for persistence, and why the turn stopped.
 */
export async function runCoachTurn(
  config: ModelClientConfig,
  request: AgenticRequest,
  handlers: CoachTurnHandlers
): Promise<CoachTurnResult> {
  const messages: WireMessage[] = [...request.messages];
  const toolCalls: CoachToolCall[] = [];
  // The reply text, split at the last tool boundary: `answer` is what the model
  // has said SINCE the most recent tool result, `narration` everything it said
  // before that. Only `answer` settles — see settledText.
  let answer = '';
  let narration = '';
  // Summed across every round-trip of the turn — one "how am I doing" can be
  // three calls, and only the total is meaningful to the user.
  let usage: Usage = { ...ZERO_USAGE };

  for (let call = 0; call < MAX_MODEL_CALLS_PER_TURN; call++) {
    if (handlers.signal?.aborted) {
      // Preserve the audit trail if writes already executed this turn — mirror
      // the streamOnce catch below so an unmount mid-turn still persists the
      // tool-call record (use-coach-chat drops a bare AbortError without saving).
      throw toolCalls.length > 0
        ? new CoachTurnError(abortError(), transcript(narration, answer), toolCalls)
        : abortError();
    }

    let reply: AccumulatedMessage;
    try {
      reply = await streamOnce(config, { ...request, messages }, handlers.onToken, handlers.signal);
    } catch (error) {
      // Tool calls already executed against the database — carry their record
      // out with the failure so the caller can persist the audit trail.
      if (toolCalls.length > 0) {
        throw new CoachTurnError(error, transcript(narration, answer), toolCalls);
      }
      throw error;
    }
    usage = addUsage(usage, reply.usage);
    answer += textOf(reply.blocks);

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
      return { text: settledText(narration, answer), toolCalls, stopReason, usage };
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
          ? new CoachTurnError(abortError(), transcript(narration, answer), toolCalls)
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
        ...(outcome.receipt ? { receipt: outcome.receipt } : {}),
      });
      results.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: outcome.content,
        ...(outcome.isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: 'user', content: results });

    // Everything said this round was written before these results arrived, so
    // it is narration: park it and start the answer clean. The LIVE stream is
    // untouched — the reader still watches "checking your training…" arrive and
    // still gets a seam before the continuation — but the text the turn settles
    // on, persists and replays is only what the model says with the data in
    // hand (see settledText).
    if (answer.length > 0) {
      if (!answer.endsWith('\n')) {
        handlers.onToken('\n\n');
        answer += '\n\n';
      }
      narration += answer;
      answer = '';
    }
  }

  return { text: settledText(narration, answer), toolCalls, stopReason: 'tool_use_limit', usage };
}
