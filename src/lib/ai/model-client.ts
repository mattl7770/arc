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
 * A turn returns its text twice: SETTLED (`text`, what the model said after the
 * last tool result — see {@link settledText}) for the callers that parse an
 * answer, and the whole TRANSCRIPT (`transcript`, every round, exactly what
 * `onToken` streamed) for the Coach thread, which must never drop a word the
 * reader already saw.
 *
 * Model notes (claude-opus-5, the default): thinking is on by default and its
 * blocks stream with empty text; they are accumulated verbatim and echoed back
 * unchanged on tool continuations (required by the API). Sampling params
 * (temperature/top_p/top_k) are not sent — the current models reject them.
 * A `refusal` stop reason is surfaced, never retried. The system prompt and
 * tool list carry prompt-cache breakpoints (buildMessagesRequest) so the large
 * fixed prefix bills at cache-read rates across a turn's round-trips, and a
 * turn that can round-trip carries a third on its latest user message, so the
 * per-turn context and the history do too (2026-10-21).
 *
 * THE SPEND LEDGER'S CHOKE POINT (2026-10-21). Every model request ARC makes
 * goes through `streamOnce` below, so that is where usage is reported: once per
 * round trip, to the one sink the app installs at launch
 * (src/lib/ai/spend-store.ts), tagged with the caller's `callType`. Reporting
 * can never fail a call — the sink is wrapped, and a sink that throws is
 * swallowed — and this module stays pure: it knows a sink exists, not where it
 * writes.
 *
 * Web search (2026-10-21, src/lib/ai/web-search.ts) is the provider's SERVER
 * tool: the request may carry it, the provider runs it inside the same call,
 * and its blocks (`server_tool_use`, `web_search_tool_result`, cited text) are
 * accumulated and echoed verbatim like thinking blocks. Two loop paths exist
 * for it: `pause_turn` resumes by re-sending the paused content unchanged, and
 * a search called beside a client tool runs at the start of the next request.
 */
import { isModelCallType, type ModelCallType } from './call-types';
import { estimateCost } from './cost';
import type { CoachStopReason, CoachToolCall, CoachTurnResult } from './types';
import {
  isWebSearchCall,
  WebSearchLedger,
  webSearchTool,
  type WebSearchOptions,
  type WireServerTool,
} from './web-search';

// --- Configuration -----------------------------------------------------------

export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

/**
 * The default model until the user picks in Settings.
 *
 * SONNET 5, not Opus (changed 2026-08-10 during first live testing). Sonnet is
 * described by Anthropic as near-Opus on agentic work and bills at $2/$10 per
 * MTok — 2.5× cheaper than Opus 5's $5/$25. That price was introductory until
 * 2026-08-31 and is now the standard one (the pricing page, checked
 * 2026-10-21); the rise to $3/$15 it was due to revert to will not happen.
 *
 * This is a "measure, then decide" default, not a verdict on quality: the usage
 * captions record input/cache/output per turn and the spend ledger keeps them
 * (src/lib/ai/spend-ledger.ts), so the choice can be made against real spend
 * instead of a guess. It stays where it is until the usage policy decides
 * defaults (docs/spikes/chief-of-staff-release.md, Track 1).
 */
export const DEFAULT_MODEL = 'claude-sonnet-5';

/**
 * The models the Coach may run, chosen in Settings (src/lib/ai/api-key-store.ts
 * persists the pick).
 *
 * THREE TABLES MOVE TOGETHER. Every id here has a price (PRICES, cost.ts) and
 * an explicit web-search decision (TOOL_VERSION_BY_MODEL, web-search.ts — a
 * version, or null for "no search"). db/model-client.test.mjs fails if any id
 * is missing from either, which is how a model used to lose its cost line or
 * its search in silence.
 *
 * The notes compare each model's per-token price with the default's. Cache
 * minimums differ by model, and a prefix under one silently caches nothing:
 * 512 tokens on Opus 5.5, Opus 5, Sonnet 5.5 and Haiku 5.5; 1,024 on Sonnet 5;
 * 4,096 on Haiku 4.5 (the prompt-caching page, checked 2026-10-21). The tools +
 * system prefix (~10k) clears all of them.
 */
export const COACH_MODELS = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5', note: 'Default' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', note: 'Newer Sonnet · same price' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', note: 'Deepest reasoning · ~2× the cost' },
  { id: 'claude-opus-5', label: 'Opus 5', note: 'Previous Opus · ~2.5× the cost' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', note: 'Fastest · ~1/20 the cost · no web search' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', note: 'Previous Haiku · ~half the cost' },
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
  /**
   * What this call is FOR, as the spend ledger files it (src/lib/ai/call-types.ts).
   * Required, so a new call site cannot spend without saying on what.
   */
  callType: ModelCallType;
};

// --- The usage sink (the spend ledger's one entry point) ---------------------

/** One billed round trip, as the client reports it. */
export type ModelCallRecord = {
  callType: ModelCallType;
  model: string;
  /** This request's usage alone — never a turn's sum. */
  usage: Usage;
  /** This request's estimated USD (cost.ts), or null when the model has no price. */
  usd: number | null;
};

let usageSink: ((record: ModelCallRecord) => void) | null = null;

/**
 * Install (or, with null, remove) the one place usage is reported to. The app
 * installs the ledger's writer at launch (src/lib/ai/spend-store.ts); the
 * headless suites install their own. Returns the sink it replaced.
 */
export function setModelUsageSink(
  sink: ((record: ModelCallRecord) => void) | null
): ((record: ModelCallRecord) => void) | null {
  const previous = usageSink;
  usageSink = sink;
  return previous;
}

/**
 * Report one round trip's usage. NEVER throws: a ledger that cannot write must
 * not fail the call whose cost it was recording — the call has already been
 * billed either way, and losing the answer too would be the worse of the two.
 * A request that billed nothing (it never reached the model) reports nothing.
 */
function reportUsage(config: ModelClientConfig, usage: Usage): void {
  if (!usageSink) return;
  if (
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens ===
    0
  ) {
    return;
  }
  try {
    usageSink({
      callType: isModelCallType(config.callType) ? config.callType : 'other',
      model: config.model,
      usage,
      usd: estimateCost(usage, config.model),
    });
  } catch {
    // The ledger's failure is the ledger's problem (see above).
  }
}

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
  /**
   * The provider's web search server tool, capped at `maxUses` per turn
   * (src/lib/ai/web-search.ts). Absent or null sends no search tool. It is also
   * dropped when the configured model has no known tool version, so a model
   * the table does not know degrades to no search rather than a 400.
   */
  webSearch?: WebSearchOptions | null;
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
  /** The card line of a DECLINED write — see `CoachToolCall.declinedSummary`. */
  declinedSummary?: string;
};

export type CoachTurnHandlers = {
  /** Called for each streamed text fragment, in order. */
  onToken: (chunk: string) => void;
  /**
   * Called as each tool call starts — drives "checking your data…" UI. Also
   * fires (name `web_search`) as a provider search starts, which runs nothing
   * here: it only keeps the activity line honest through the search's pause.
   */
  onToolCall?: (call: { name: string; input: unknown }) => void;
  /** Execute one tool call. Throwing here becomes an is_error tool result. */
  executeTool: (name: string, input: unknown) => Promise<ToolExecutionOutcome>;
  signal?: AbortSignal;
  /**
   * Called once when the API refused a request because of the search tool and
   * the same request without it went through (see searchToolRefused). The rest
   * of the turn runs without search; whether later turns do is the caller's
   * call (the app latches it off for the session — api-key-store.ts).
   */
  onWebSearchUnavailable?: () => void;
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
 * Did the API refuse this request in a way the search tool could explain?
 *
 * Web search is ON by default (api-key-store.ts), and a key whose organization
 * has not enabled it in the Console, or an API that refuses a field of the
 * tool, answers EVERY request carrying it with a 400 — every Coach turn and
 * every food estimate, the background queue's drain included, until the owner
 * finds the switch. The error text is the provider's and is not matched on;
 * the test is only "a 400 invalid request, on a request that really carried
 * the tool". The caller proves the rest by retrying without it.
 */
function searchToolRefused(
  error: unknown,
  config: ModelClientConfig,
  webSearch: WebSearchOptions | null
): boolean {
  return (
    error instanceof ModelRequestError &&
    error.status === 400 &&
    (error.errorType === 'invalid_request_error' || error.errorType === null) &&
    webSearch !== null &&
    webSearchTool(config.model, webSearch.maxUses) !== null
  );
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
  const custom = request.tools.map((tool, i) =>
    i === request.tools.length - 1 ? { ...tool, cache_control: cache } : tool
  );
  // The web search server tool goes AFTER the registry, outside the tool
  // breakpoint, so that breakpoint stays where it always was. The system
  // breakpoint still caches it with everything else: its definition only
  // changes when the model or the Settings toggle does.
  const server: WireServerTool | null = request.webSearch
    ? webSearchTool(config.model, request.webSearch.maxUses)
    : null;
  const all: (WireTool | WireServerTool)[] = server ? [...custom, server] : custom;
  const tools = all.length > 0 ? all : undefined;
  // The third breakpoint, on the conversation — only when the turn can round
  // trip (it has client tools). See CONVERSATION_CACHE.
  const messages =
    request.tools.length > 0 ? withConversationBreakpoint(request.messages) : request.messages;

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
      messages,
      ...(tools ? { tools } : {}),
    }),
  };
}

/**
 * The conversation's cache breakpoint (2026-10-21): FIVE minutes, on the last
 * block of the latest user message.
 *
 * ## Why
 *
 * The two prefix breakpoints cache tools + the static system text. Everything
 * after them — the per-turn context block (~1.4k tokens: date, readiness,
 * mission, memory) and the whole history — used to be re-sent at full price on
 * EVERY round trip of a turn, and a tool-using turn makes up to eight. Render
 * order is tools → system → messages, so a breakpoint on the last message
 * caches all of it: round trip 2 reads round trip 1's write, round trip 3 reads
 * round trip 2's, and only what each round added bills at the full rate.
 *
 * ## The rules it is placed by (the prompt-caching page, checked 2026-10-21)
 *
 * - At most FOUR breakpoints a request. This is the third (system, last tool,
 *   this), and there is only ever one of it — it moves forward each round trip
 *   rather than accumulating, because the earlier positions stay readable
 *   through the 20-block lookback without a marker of their own.
 * - A longer TTL must come before a shorter one. The prefix is written at one
 *   hour and this at five minutes, after it — the allowed order. (Five, not an
 *   hour: the round trips of one turn are seconds apart, and the next turn's
 *   fresh context block sits ahead of the history anyway, so an hour-long entry
 *   here would be paid for at 2× and never read.)
 * - Thinking blocks and empty text blocks cannot carry `cache_control`; text,
 *   image, document and tool_result blocks in a user turn can. The latest user
 *   message is the turn's own question or a tool_result turn, so its last block
 *   is one of those; anything else is left unmarked rather than guessed at.
 * - The marker is placed on the latest USER message, never on the paused
 *   assistant content a `pause_turn` resume sends back — that goes back
 *   unchanged, as the API requires.
 *
 * Adding, moving or removing `cache_control` is not an edit for the
 * thinking-block history check (the claude-api skill's preserved-thinking
 * guidance), so a marker that moves forward never invalidates a thinking block.
 *
 * Only a request that can round trip carries it: a one-shot call (an estimate,
 * an import) is one request, so a write here would cost 1.25× on its message
 * and never be read.
 *
 * PURE and non-mutating: the loop's own `messages` (echoed verbatim on the next
 * round) are never touched; the marked message is a copy. A string-content
 * message is sent as its single text block, which the API treats as the same
 * content.
 */
const CONVERSATION_CACHE: CacheControl = { type: 'ephemeral', ttl: '5m' };

const CACHEABLE_MESSAGE_BLOCKS = new Set(['text', 'image', 'document', 'tool_result']);

export function withConversationBreakpoint(messages: WireMessage[]): WireMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'user') continue;
    const marked = markLastBlock(message.content);
    if (!marked) return messages;
    const copy = [...messages];
    copy[i] = { ...message, content: marked };
    return copy;
  }
  return messages;
}

/** The content with a breakpoint on its last block, or null when it cannot carry one. */
function markLastBlock(content: string | WireContentBlock[]): WireContentBlock[] | null {
  if (typeof content === 'string') {
    if (content.trim() === '') return null;
    return [{ type: 'text', text: content, cache_control: CONVERSATION_CACHE } as WireContentBlock];
  }
  const last = content[content.length - 1];
  if (!last || !CACHEABLE_MESSAGE_BLOCKS.has(last.type) || 'cache_control' in last) return null;
  if (last.type === 'text' && String((last as WireTextBlock).text ?? '').trim() === '') return null;
  return [
    ...content.slice(0, -1),
    { ...last, cache_control: CONVERSATION_CACHE } as WireContentBlock,
  ];
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
  | { type: 'signature_delta'; signature: string }
  | { type: 'citations_delta'; citation: Record<string, unknown> };

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
  /** The 5-minute part of `cacheWriteTokens` (`usage.cache_creation.ephemeral_5m_input_tokens`). */
  cacheWrite5mTokens?: number;
  /** Provider-side web searches billed (`usage.server_tool_use.web_search_requests`). */
  webSearchRequests?: number;
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
    ...(a.cacheWrite5mTokens || b.cacheWrite5mTokens
      ? { cacheWrite5mTokens: (a.cacheWrite5mTokens ?? 0) + (b.cacheWrite5mTokens ?? 0) }
      : {}),
    ...(a.webSearchRequests || b.webSearchRequests
      ? { webSearchRequests: (a.webSearchRequests ?? 0) + (b.webSearchRequests ?? 0) }
      : {}),
  };
}

export type AccumulatedMessage = {
  /** The reply's content blocks, in order, ready to echo back verbatim. */
  blocks: WireContentBlock[];
  /**
   * The reply's text as the reader got it: every text block in order, joined
   * with '' EXCEPT where a non-text block (a search, its results) sat between
   * them, which carries the same '\n\n' seam `onToken` streamed (see
   * {@link MessageAccumulator}). Never echoed: `blocks` is what goes back.
   */
  text: string;
  /** Where the text stood at the end of this reply — for a `pause_turn` resume. */
  carry: TextCarry;
  /** The wire stop reason ('end_turn' | 'tool_use' | …), '' if never sent. */
  stopReason: string;
  /** What this round-trip cost, summed from message_start + message_delta. */
  usage: Usage;
};

/**
 * Where the turn's text stood when a reply began: its last character, and
 * whether a non-text block has come since. A seam owed across a `pause_turn`
 * resume is still paid — the paused reply can end on a search and the resumed
 * one open on the text after it.
 */
export type TextCarry = { tail: string; afterNonText: boolean };

/** Block kinds that do not break the text into pieces (they carry no prose). */
const SEAMLESS_KINDS = new Set(['text', 'thinking', 'redacted_thinking']);

/**
 * Folds a stream of Messages API SSE events into the final assistant message,
 * emitting text fragments through `onToken` as they arrive. Thinking blocks
 * are kept verbatim (empty text and all) so continuations can echo them.
 *
 * THE SEAM (2026-10-21). A searched reply is several text blocks with the
 * search's `server_tool_use` and `web_search_tool_result` between them, and the
 * sentence the model writes before a search rarely ends in a space: joined with
 * '' the reader got "…when Claude Shannon was born.Based on the search
 * results…" in the bubble, the `ai_messages` row and every later turn's
 * history. So when a text block opens right after a non-text, non-thinking
 * block, and the text so far is non-empty and does not end in whitespace, a
 * '\n\n' goes through `onToken` and into {@link AccumulatedMessage.text} — the
 * seam the loop already pays at a client tool boundary. Two text blocks back
 * to back (one answer split by its citations) still join with ''. The seam
 * lives only in the text: the blocks echoed to the API are never altered.
 */
export class MessageAccumulator {
  private blocks: WireContentBlock[] = [];
  // The seam owed ahead of a text block, by block index (see the class note).
  private seams = new Map<number, string>();
  // The last character of the turn's text so far ('' when none yet), and
  // whether a non-text, non-thinking block has opened since it.
  private tail: string;
  private afterNonText: boolean;
  private partialJson = new Map<number, string>();
  private stopReason = '';
  // Usage arrives in two places: message_start carries the input side (and the
  // cache read/write split), message_delta the final output count.
  private usage: Usage = { ...ZERO_USAGE };
  // Explicit field, not a constructor parameter property — Node's strip-only
  // TS mode (the headless tests) can't erase parameter properties.
  private readonly onToken: (chunk: string) => void;
  // Fired as a server tool block opens (a web search starting), so the UI can
  // say "web search…" through the pause while the provider runs it.
  private readonly onServerTool: ((name: string) => void) | undefined;

  constructor(
    onToken: (chunk: string) => void,
    onServerTool?: (name: string) => void,
    carry?: TextCarry
  ) {
    this.onToken = onToken;
    this.onServerTool = onServerTool;
    this.tail = carry?.tail.slice(-1) ?? '';
    this.afterNonText = carry?.afterNonText ?? false;
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
        // A web search's `server_tool_use` streams its input exactly like a
        // client `tool_use` does: input_json_delta fragments, parsed at stop.
        const kind = this.blocks[index]!.type;
        if (kind === 'text') {
          if (this.afterNonText && this.tail !== '' && !/\s/.test(this.tail)) {
            this.seams.set(index, '\n\n');
            this.onToken('\n\n');
            this.tail = '\n';
          }
          this.afterNonText = false;
          const initial = (this.blocks[index] as WireTextBlock).text;
          if (typeof initial === 'string' && initial !== '') this.tail = initial.slice(-1);
        } else if (!SEAMLESS_KINDS.has(kind)) {
          this.afterNonText = true;
        }
        if (kind === 'tool_use' || kind === 'server_tool_use') {
          this.partialJson.set(index, '');
        }
        if (kind === 'server_tool_use') {
          const name = (this.blocks[index] as { name?: unknown }).name;
          if (typeof name === 'string') this.onServerTool?.(name);
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
          if (delta.text !== '') this.tail = delta.text.slice(-1);
          this.onToken(delta.text);
        } else if (delta.type === 'input_json_delta') {
          this.partialJson.set(index, (this.partialJson.get(index) ?? '') + delta.partial_json);
        } else if (delta.type === 'thinking_delta') {
          const b = block as WireOpaqueBlock & { thinking?: string };
          b.thinking = (b.thinking ?? '') + delta.thinking;
        } else if (delta.type === 'signature_delta') {
          (block as WireOpaqueBlock & { signature?: string }).signature = delta.signature;
        } else if (delta.type === 'citations_delta') {
          // One citation per delta, appended to the text block's list. Kept
          // whole: a web citation's `encrypted_index` must go back unchanged on
          // a continuation of this turn.
          const b = block as WireOpaqueBlock & { citations?: unknown };
          b.citations = [...(Array.isArray(b.citations) ? b.citations : []), delta.citation];
        }
        break;
      }
      case 'content_block_stop': {
        const index = data.index ?? 0;
        const block = this.blocks[index];
        if (block && (block.type === 'tool_use' || block.type === 'server_tool_use')) {
          const raw = this.partialJson.get(index) ?? '';
          const target = block as WireToolUseBlock;
          if (raw.trim() !== '') {
            let input: unknown = {};
            try {
              input = JSON.parse(raw);
            } catch {
              // Truncated tool input (max_tokens hit mid tool call) — leave {}
              // so the turn degrades to the max_tokens path instead of a raw
              // SyntaxError discarding the streamed text.
            }
            target.input = input;
          } else {
            // No deltas: the input arrived whole in content_block_start (or is
            // absent). Keep it — overwriting it with {} would alter a block
            // that goes back verbatim and record a search with no query.
            const given: unknown = target.input;
            target.input = given !== null && typeof given === 'object' ? given : {};
          }
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
    // Search counts ride a nested object, cumulative like the rest.
    const server = u.server_tool_use as Record<string, unknown> | undefined;
    const searches =
      server && typeof server.web_search_requests === 'number' && server.web_search_requests > 0
        ? server.web_search_requests
        : (this.usage.webSearchRequests ?? 0);
    // The write split by TTL rides a nested object too (`cache_creation`); the
    // cost estimate prices the 5-minute part at 1.25× and the rest at 2×.
    const creation = u.cache_creation as Record<string, unknown> | undefined;
    const write5m =
      creation &&
      typeof creation.ephemeral_5m_input_tokens === 'number' &&
      creation.ephemeral_5m_input_tokens > 0
        ? creation.ephemeral_5m_input_tokens
        : (this.usage.cacheWrite5mTokens ?? 0);
    this.usage = {
      inputTokens: num('input_tokens', this.usage.inputTokens),
      outputTokens: num('output_tokens', this.usage.outputTokens),
      cacheReadTokens: num('cache_read_input_tokens', this.usage.cacheReadTokens),
      cacheWriteTokens: num('cache_creation_input_tokens', this.usage.cacheWriteTokens),
      ...(write5m > 0 ? { cacheWrite5mTokens: write5m } : {}),
      ...(searches > 0 ? { webSearchRequests: searches } : {}),
    };
  }

  finish(): AccumulatedMessage {
    let text = '';
    this.blocks.forEach((block, index) => {
      if (block?.type !== 'text') return;
      text += (this.seams.get(index) ?? '') + (block as WireTextBlock).text;
    });
    // Sparse indices can't happen on a well-formed stream; compact defensively.
    return {
      blocks: this.blocks.filter(Boolean),
      text,
      carry: { tail: this.tail, afterNonText: this.afterNonText },
      stopReason: this.stopReason,
      usage: this.usage,
    };
  }
}

// --- One streamed round-trip -------------------------------------------------

/**
 * `ModelRequestError.errorType` for a request that never reached the API — the
 * fetch itself rejected. Status 0, like every "no HTTP response" failure; the
 * type is what tells it from a stream that died after the model started.
 */
export const NETWORK_ERROR = 'network_error';
/** `errorType` for a connection that died while the reply was streaming. */
export const STREAM_ERROR = 'stream_error';

/**
 * A transport failure as a {@link ModelRequestError} (status 0), keeping the
 * underlying message so nothing a screen prints changes. An abort stays an
 * abort: the user leaving a screen is not a network failure.
 */
function transportError(error: unknown, signal: AbortSignal | undefined, type: string): unknown {
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) return error;
  if (error instanceof ModelRequestError) return error;
  const message =
    error instanceof Error && error.message ? error.message : 'Network request failed.';
  return new ModelRequestError(0, type, message);
}

async function streamOnce(
  config: ModelClientConfig,
  request: AgenticRequest,
  onToken: (chunk: string) => void,
  signal?: AbortSignal,
  onServerTool?: (name: string) => void,
  carry?: TextCarry
): Promise<AccumulatedMessage> {
  const { url, headers, body } = buildMessagesRequest(config, request);
  let response: FetchResponseLike;
  try {
    response = await config.fetchImpl(url, { method: 'POST', headers, body, signal });
  } catch (error) {
    // The request never reached the API (offline, DNS, TLS, a dropped socket).
    // Named, so a caller can tell "nothing was sent, nothing was billed" from
    // every other failure — the estimate queue retries this one for free.
    throw transportError(error, signal, NETWORK_ERROR);
  }

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
  const accumulator = new MessageAccumulator(onToken, onServerTool, carry);

  let failure: unknown = null;
  try {
    for (;;) {
      let chunk: { done: boolean; value?: Uint8Array };
      try {
        chunk = await reader.read();
      } catch (error) {
        // The connection died mid-reply: the request DID reach the model.
        throw transportError(error, signal, STREAM_ERROR);
      }
      if (chunk.done) break;
      if (!chunk.value) continue;
      for (const event of parser.push(decoder.decode(chunk.value, { stream: true }))) {
        accumulator.consume(event);
      }
    }
    for (const event of parser.flush()) accumulator.consume(event);
  } catch (error) {
    failure = error;
  }

  const message = accumulator.finish();
  // Reported BEFORE any failure is rethrown: a reply that streamed half-way
  // was billed for what it streamed, and the ledger is the record of what was
  // billed, not of what succeeded.
  reportUsage(config, message.usage);
  if (failure !== null) throw failure;
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
 * ## …but the Coach THREAD keeps everything (2026-10-21)
 *
 * The premise above is false for a WRITE, and the system prompt is what makes
 * it false: it tells the Coach to "Present the drafted entry in full BEFORE
 * calling" (system-prompt.ts), so the text ahead of a write call is the very
 * thing the user is approving, not throat-clearing. Settling the thread on the
 * answer turned a full drafted entry into "Saved." the instant the card was
 * approved: the bubble, the `ai_messages` row, and every later turn's history
 * lost the draft. Owner, verbatim: *"after you approve something coach's
 * message gets overridden, can lose info"*.
 *
 * It is not safe for reads either. Nothing stops the model writing a plan and
 * then calling a read to check one number in it, and no heuristic can tell
 * that plan from "let me check" — dropping content is unrecoverable, while
 * keeping narration costs a sentence. So the result carries BOTH:
 * `text` (this function — the answer, which the coach pass's sentinel check and
 * every JSON extraction riding this client need) and `transcript` (everything,
 * which use-coach-chat renders, persists and replays). The refusal check in
 * coach-service reads either; they are empty together.
 */
function settledText(narration: string, answer: string): string {
  return answer.trim().length > 0 ? answer : narration;
}

/**
 * Everything the model said this turn, in order: the lossless audit fragment
 * carried out on {@link CoachTurnError}, and (trailing whitespace trimmed) the
 * `transcript` a turn returns. `narration` already carries the seam the loop
 * appended when it parked each round, so this is a plain join and is
 * byte-identical to what `onToken` streamed.
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
 * is a SUFFIX of what `onToken` streamed rather than all of it), the whole
 * transcript (all of it), the complete tool-call record for persistence, and
 * why the turn stopped.
 */
export async function runCoachTurn(
  config: ModelClientConfig,
  request: AgenticRequest,
  handlers: CoachTurnHandlers
): Promise<CoachTurnResult> {
  const messages: WireMessage[] = [...request.messages];
  const toolCalls: CoachToolCall[] = [];
  // The turn's web searches (src/lib/ai/web-search.ts). Their records join
  // `toolCalls` in the order the searches were made, so they persist and replay
  // with everything else — but a search is not a write, so whether a failure
  // carries an audit record out is still decided by the CLIENT calls alone.
  const searches = new WebSearchLedger();
  const ranClientTools = () => toolCalls.some((call) => !isWebSearchCall(call));
  const sealed = () => {
    searches.finish();
    return toolCalls;
  };
  // The reply text, split at the last tool boundary: `answer` is what the model
  // has said SINCE the most recent tool result, `narration` everything it said
  // before that. Only `answer` settles — see settledText.
  let answer = '';
  let narration = '';
  // Summed across every round-trip of the turn — one "how am I doing" can be
  // three calls, and only the total is meaningful to the user.
  let usage: Usage = { ...ZERO_USAGE };
  // …and priced the same way: request by request, then summed (cost.ts says
  // why that is not the same as pricing the sum). Null once any request has no
  // price — a partial dollar figure would read as the whole.
  let estimatedUsd: number | null = 0;
  // The search tool this turn sends. Dropped for the rest of the turn when the
  // API refuses it (see searchToolRefused).
  let webSearch = request.webSearch ?? null;
  // Whether the last reply ended on a non-text block — with the text's tail,
  // the seam state handed to the next reply (MessageAccumulator).
  let afterNonText = false;

  for (let call = 0; call < MAX_MODEL_CALLS_PER_TURN; call++) {
    if (handlers.signal?.aborted) {
      // Preserve the audit trail if writes already executed this turn — mirror
      // the streamOnce catch below so an unmount mid-turn still persists the
      // tool-call record (use-coach-chat drops a bare AbortError without saving).
      throw ranClientTools()
        ? new CoachTurnError(abortError(), transcript(narration, answer), sealed())
        : abortError();
    }

    const carry: TextCarry = { tail: (narration + answer).slice(-1), afterNonText };
    const send = (search: WebSearchOptions | null) =>
      streamOnce(
        config,
        { ...request, messages, webSearch: search },
        handlers.onToken,
        handlers.signal,
        // A search starting drives the same activity line a tool call does
        // ("web search…"): the stream stalls while the provider runs it, and
        // a silent stall reads as a hang. Nothing executes here.
        (name) => handlers.onToolCall?.({ name, input: {} }),
        carry
      );
    let reply: AccumulatedMessage;
    try {
      try {
        reply = await send(webSearch);
      } catch (error) {
        // A refused search tool is retried ONCE without it. Only a request
        // that actually carried the tool, and only before any search ran this
        // turn (a search that ran proves the tool is accepted, and its blocks
        // in the history would not survive the tool's removal). "Ran" is the
        // ledger OR the API's own count: a search block the ledger did not
        // read still counts in `server_tool_use.web_search_requests`.
        const searched = searches.calls().length > 0 || (usage.webSearchRequests ?? 0) > 0;
        if (!searchToolRefused(error, config, webSearch) || searched) {
          throw error;
        }
        reply = await send(null);
        // The plain request went through, so it WAS the tool: stop sending it.
        // A retry that fails too throws its own error above — the request was
        // bad for some other reason, and nothing is latched.
        webSearch = null;
        handlers.onWebSearchUnavailable?.();
      }
    } catch (error) {
      // Tool calls already executed against the database — carry their record
      // out with the failure so the caller can persist the audit trail.
      if (ranClientTools()) {
        throw new CoachTurnError(error, transcript(narration, answer), sealed());
      }
      throw error;
    }
    usage = addUsage(usage, reply.usage);
    const replyUsd = estimateCost(reply.usage, config.model);
    estimatedUsd = estimatedUsd === null || replyUsd === null ? null : estimatedUsd + replyUsd;
    answer += reply.text;
    afterNonText = reply.carry.afterNonText;
    // Searches first: in a mixed round they were requested alongside (and
    // recorded before) the client tools run below.
    toolCalls.push(...searches.observe(reply.blocks));

    // PAUSE_TURN: the provider paused its own server-side loop (a long search
    // turn). The documented continuation is the paused assistant content sent
    // back UNCHANGED, with no new user message and the same tools; the API
    // resumes where it stopped, and a resumed turn can pause again. Each resume
    // spends one of MAX_MODEL_CALLS_PER_TURN, which is the cap on that loop.
    // The loop adds no seam: a reply paused mid-text finishes the same
    // sentence, and one paused on a search pays the accumulator's seam when
    // its text resumes (the carry above).
    if (reply.stopReason === 'pause_turn') {
      messages.push({ role: 'assistant', content: reply.blocks });
      continue;
    }

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
      return {
        text: settledText(narration, answer),
        transcript: transcript(narration, answer).trimEnd(),
        toolCalls: sealed(),
        stopReason,
        usage,
        estimatedUsd,
      };
    }

    // Tool round: echo the assistant turn verbatim (thinking blocks included),
    // run every requested tool, and answer with their results in ONE user turn.
    // A web search called in the same group as a client tool has NOT run yet
    // (its `server_tool_use` has no result): the API runs it at the start of
    // the next request, which is why the follow-up must hold only tool_result
    // blocks and the same tools. Both already hold here.
    messages.push({ role: 'assistant', content: reply.blocks });

    const results: WireToolResultBlock[] = [];
    for (const block of reply.blocks) {
      if (block.type !== 'tool_use') continue;
      const toolUse = block as WireToolUseBlock;
      if (handlers.signal?.aborted) {
        // Preserve the audit trail if writes already executed this turn — mirror
        // the streamOnce catch below so an unmount mid-turn still persists the
        // tool-call record (use-coach-chat drops a bare AbortError without saving).
        throw ranClientTools()
          ? new CoachTurnError(abortError(), transcript(narration, answer), sealed())
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
        ...(outcome.declined && outcome.declinedSummary
          ? { declinedSummary: outcome.declinedSummary }
          : {}),
      });
      results.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: outcome.content,
        ...(outcome.isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: 'user', content: results });

    // Everything said this round was written before these results arrived:
    // park it and start the answer clean. The LIVE stream is untouched — the
    // reader still watches it arrive and still gets a seam before the
    // continuation — and the transcript keeps it with that same seam. Only the
    // SETTLED `text` (the answer parsers want) leaves it out; see settledText.
    if (answer.length > 0) {
      if (!answer.endsWith('\n')) {
        handlers.onToken('\n\n');
        answer += '\n\n';
      }
      narration += answer;
      answer = '';
    }
  }

  return {
    text: settledText(narration, answer),
    transcript: transcript(narration, answer).trimEnd(),
    toolCalls: sealed(),
    stopReason: 'tool_use_limit',
    usage,
    estimatedUsd,
  };
}
