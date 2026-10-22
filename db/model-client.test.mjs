/**
 * Headless test of the Messages API client + agentic tool loop
 * (src/lib/ai/model-client.ts) with a fully mocked fetch — request building,
 * SSE parsing across chunk boundaries, stream accumulation (text / tool_use /
 * thinking), the execute-and-continue loop, error and refusal handling. No
 * network, no database, no Expo. Run: npm run db:test.
 */
import {
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_VERSION,
  COACH_MODELS,
  CoachTurnError,
  DEFAULT_MODEL,
  MessageAccumulator,
  ModelRequestError,
  NETWORK_ERROR,
  STREAM_ERROR,
  SseParser,
  buildMessagesRequest,
  isCoachModel,
  runCoachTurn,
  setModelUsageSink,
  withConversationBreakpoint,
} from '../src/lib/ai/model-client.ts';
import {
  COACH_WEB_SEARCH_MAX_USES,
  hasWebSearchDecision,
  webSearchTool,
  isWebSearchCall,
  searchedLine,
  WebSearchLedger,
  webSearchesOf,
} from '../src/lib/ai/web-search.ts';
import { deriveRegion, deviceRegion, regionLine, regionOfLocale } from '../src/lib/ai/region.ts';
import { toolDigest } from '../src/lib/ai/history-window.ts';
import { estimateCost, PRICES, usageCaption } from '../src/lib/ai/cost.ts';
import {
  MEAL_ESTIMATION_SYSTEM_PROMPT,
  NO_ESTIMATOR_OPTIONS,
  buildFoodEntryRequest,
  buildMealEstimationRequest,
  buildMealRevisionRequest,
  parseMealEstimate,
} from '../src/lib/nutrition/estimate.ts';
import { WEB_SEARCH_UNAVAILABLE_LINE, apiKeyStore } from '../src/lib/ai/api-key-store.ts';

let pass = 0;
let fail = 0;
const ok = (n) => {
  pass++;
  console.log(`  ok   ${n}`);
};
const bad = (n, e) => {
  fail++;
  console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`);
};

// --- Wire fixtures -----------------------------------------------------------

/** Serialize events into SSE text (the exact wire shape the API streams). */
const sseText = (events) =>
  events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

/** A minimal streamed text reply, optionally ending in another stop reason. */
function textReplyEvents(text, stopReason = 'end_turn') {
  const half = Math.ceil(text.length / 2);
  return [
    { event: 'message_start', data: { type: 'message_start', message: {} } },
    { event: 'ping', data: { type: 'ping' } },
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: text.slice(0, half) },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: text.slice(half) },
      },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stopReason } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
}

/** A reply that thinks, speaks a preamble, then calls one tool. */
function toolUseReplyEvents({ toolName = 'get_insights', toolId = 'toolu_1', inputJson = '{}' }) {
  return [
    { event: 'message_start', data: { type: 'message_start', message: {} } },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig-abc' },
      },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'Checking.' },
      },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: inputJson.slice(0, 3) },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: inputJson.slice(3) },
      },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 2 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
}

/** Wrap SSE text chunks in the minimal streaming Response the client needs. */
function streamResponse(chunks, { ok: okFlag = true, status = 200 } = {}) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: okFlag,
    status,
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length ? { done: false, value: encoder.encode(chunks[i++]) } : { done: true },
      }),
    },
    text: async () => chunks.join(''),
  };
}

/** A fetch mock that serves scripted responses and records every request. */
function scriptedFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, payload: JSON.parse(init.body) });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return typeof next === 'function' ? next() : next;
  };
  impl.calls = calls;
  return impl;
}

const CONFIG = (fetchImpl) => ({ apiKey: 'sk-test', model: DEFAULT_MODEL, fetchImpl });
const REQUEST = {
  system: 'You are the Coach.',
  messages: [{ role: 'user', content: 'How is my training?' }],
  tools: [{ name: 'get_insights', description: 'd', input_schema: { type: 'object' } }],
};

console.log('0. buildMessagesRequest: exact wire shape, no sampling params');
{
  const { url, headers, body } = buildMessagesRequest(CONFIG(null), REQUEST);
  url === ANTHROPIC_MESSAGES_URL ? ok('URL is the Messages endpoint') : bad('url', url);
  headers['x-api-key'] === 'sk-test' &&
  headers['anthropic-version'] === ANTHROPIC_VERSION &&
  headers['content-type'] === 'application/json'
    ? ok('key, version, and content-type headers set')
    : bad('headers', JSON.stringify(headers));
  const payload = JSON.parse(body);
  payload.model === DEFAULT_MODEL &&
  payload.stream === true &&
  payload.max_tokens === 8192 &&
  Array.isArray(payload.system) &&
  payload.system[0].type === 'text' &&
  payload.system[0].text === 'You are the Coach.' &&
  payload.tools.length === 1
    ? ok('model/stream/max_tokens/system(block)/tools in the body')
    : bad('payload', body);
  payload.system[0].cache_control?.type === 'ephemeral' &&
  payload.tools[payload.tools.length - 1].cache_control?.type === 'ephemeral'
    ? ok('prompt-cache breakpoints on the system block and the last tool')
    : bad('cache_control missing', body);
  // The TTL is load-bearing, not a default worth drifting back to. Coach use is
  // bursty (a question, a pause to read, a follow-up), so under the 5-minute
  // default nearly every question arrives cold and re-pays a WRITE on the whole
  // ~10k-token prefix. That is what made three trivial queries cost ~48k tokens.
  payload.system[0].cache_control?.ttl === '1h' &&
  payload.tools[payload.tools.length - 1].cache_control?.ttl === '1h'
    ? ok('…both at the 1-hour TTL, so a bursty session reads instead of rewriting')
    : bad('cache TTL is not 1h', JSON.stringify(payload.system[0].cache_control));
  !('temperature' in payload) && !('thinking' in payload) && !('top_p' in payload)
    ? ok('no temperature/top_p/thinking (current models reject or default them)')
    : bad('forbidden params present');
  const bare = buildMessagesRequest(CONFIG(null), { ...REQUEST, tools: [] });
  const bareBody = JSON.parse(bare.body);
  !('tools' in bareBody)
    ? ok('an empty tool set omits the tools key entirely')
    : bad('empty tools sent');
  Array.isArray(bareBody.system) && bareBody.system[0].cache_control?.type === 'ephemeral'
    ? ok('the system block stays cached even when no tools are sent')
    : bad('bare system not cached', bare.body);
}

console.log('1. SseParser: chunk boundaries, CRLF, comments, multi-line data, flush');
{
  const parser = new SseParser();
  const wire =
    'event: message_start\r\ndata: {"a":1}\n\n: keepalive comment\n\nevent: x\ndata: line1\ndata: line2\n\n';
  const events = [];
  // Feed one character at a time — worst-case chunking.
  for (const ch of wire) events.push(...parser.push(ch));
  events.length === 2
    ? ok('comment-only event dropped; two real events')
    : bad('count', events.length);
  events[0].event === 'message_start' && events[0].data === '{"a":1}'
    ? ok('CRLF line endings handled')
    : bad('event 0', JSON.stringify(events[0]));
  events[1].data === 'line1\nline2'
    ? ok('multi-line data joined with newline')
    : bad('event 1', JSON.stringify(events[1]));

  const tail = new SseParser();
  tail.push('event: end\ndata: {"z":1}');
  const flushed = tail.flush();
  flushed.length === 1 && flushed[0].data === '{"z":1}'
    ? ok('flush() emits an event the stream closed without terminating')
    : bad('flush', JSON.stringify(flushed));
}

console.log('2. MessageAccumulator: text, tool input, thinking, stop reason');
{
  const tokens = [];
  const acc = new MessageAccumulator((t) => tokens.push(t));
  for (const e of toolUseReplyEvents({ inputJson: '{"days":30}' })) {
    acc.consume({ event: e.event, data: JSON.stringify(e.data) });
  }
  const { blocks, stopReason } = acc.finish();
  stopReason === 'tool_use' ? ok('stop reason captured') : bad('stop', stopReason);
  tokens.join('') === 'Checking.'
    ? ok('onToken saw exactly the text deltas')
    : bad('tokens', tokens.join(''));
  blocks[0].type === 'thinking' && blocks[0].signature === 'sig-abc'
    ? ok('thinking block kept verbatim with its signature (empty text and all)')
    : bad('thinking block', JSON.stringify(blocks[0]));
  blocks[2].type === 'tool_use' && JSON.stringify(blocks[2].input) === '{"days":30}'
    ? ok('tool input JSON reassembled across deltas')
    : bad('tool input', JSON.stringify(blocks[2]));

  const err = new MessageAccumulator(() => {});
  let threw = null;
  try {
    err.consume({
      event: 'error',
      data: JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }),
    });
  } catch (e) {
    threw = e;
  }
  threw instanceof ModelRequestError && threw.errorType === 'overloaded_error'
    ? ok('an in-stream error event throws a typed ModelRequestError')
    : bad('stream error', String(threw));
}

console.log('3. runCoachTurn: plain text turn, one round-trip');
{
  const fetchImpl = scriptedFetch([streamResponse([sseText(textReplyEvents('All good.'))])]);
  const tokens = [];
  const result = await runCoachTurn(CONFIG(fetchImpl), REQUEST, {
    onToken: (t) => tokens.push(t),
    executeTool: async () => ({ content: '{}' }),
  });
  result.text === 'All good.' && result.stopReason === 'end_turn' && result.toolCalls.length === 0
    ? ok('text, stop reason, empty tool record')
    : bad('result', JSON.stringify(result));
  tokens.join('') === result.text
    ? ok('returned text equals the streamed tokens')
    : bad('token parity');
  fetchImpl.calls.length === 1
    ? ok('exactly one model call')
    : bad('calls', fetchImpl.calls.length);
}

console.log('4. runCoachTurn: full tool loop — execute, echo, continue');
{
  const fetchImpl = scriptedFetch([
    streamResponse([sseText(toolUseReplyEvents({ inputJson: '{"days":30}' }))]),
    streamResponse([sseText(textReplyEvents('Training is trending up 12%.'))]),
  ]);
  const tokens = [];
  const seenCalls = [];
  const result = await runCoachTurn(CONFIG(fetchImpl), REQUEST, {
    onToken: (t) => tokens.push(t),
    onToolCall: (c) => seenCalls.push(c.name),
    executeTool: async (name, input) => ({
      content: JSON.stringify({ ranTool: name, got: input }),
    }),
  });

  fetchImpl.calls.length === 2
    ? ok('two model calls (tool round + answer)')
    : bad('calls', fetchImpl.calls.length);
  seenCalls.join(',') === 'get_insights'
    ? ok('onToolCall fired for the call')
    : bad('onToolCall', seenCalls);

  const second = fetchImpl.calls[1].payload.messages;
  const assistantTurn = second[second.length - 2];
  const resultTurn = second[second.length - 1];
  assistantTurn.role === 'assistant' &&
  assistantTurn.content[0].type === 'thinking' &&
  assistantTurn.content[0].signature === 'sig-abc' &&
  assistantTurn.content[2].type === 'tool_use'
    ? ok('assistant turn echoed verbatim — thinking block included')
    : bad('assistant echo', JSON.stringify(assistantTurn));
  resultTurn.role === 'user' &&
  resultTurn.content.length === 1 &&
  resultTurn.content[0].type === 'tool_result' &&
  resultTurn.content[0].tool_use_id === 'toolu_1' &&
  resultTurn.content[0].content.includes('ranTool')
    ? ok('tool_result answered in a single user turn with the matching id')
    : bad('tool result turn', JSON.stringify(resultTurn));

  result.toolCalls.length === 1 &&
  result.toolCalls[0].name === 'get_insights' &&
  JSON.stringify(result.toolCalls[0].input) === '{"days":30}' &&
  result.toolCalls[0].isError === undefined
    ? ok('turn record captured name/input/result')
    : bad('tool record', JSON.stringify(result.toolCalls));
  // THE TURN SETTLES ON ITS POST-TOOL TEXT (fixed 2026-08-11). This used to
  // assert `'Checking.\n\nTraining is trending up 12%.'` — every text block from
  // every round-trip concatenated — which meant the model's narration of its own
  // intent was glued onto the front of the answer on EVERY tool-using turn, then
  // shown in the bubble, persisted to ai_messages, folded into the rolling
  // summary and replayed to the next turn. "Checking." was written before the
  // tool result existed, so it cannot be part of the answer.
  result.text === 'Training is trending up 12%.'
    ? ok('the settled text is the post-tool answer, not the preamble glued to it')
    : bad('text', JSON.stringify(result.text));
  // The LIVE stream is deliberately unchanged: the reader still watches the
  // narration arrive, and still gets a seam before the continuation. Only the
  // text the turn settles on — the one that is persisted and replayed — drops it.
  tokens.join('') === 'Checking.\n\nTraining is trending up 12%.'
    ? ok('…while onToken still streamed narration + separator + answer, in order')
    : bad('token stream', JSON.stringify(tokens.join('')));
  // …and the TRANSCRIPT is that stream, verbatim (2026-10-21). The Coach thread
  // settles on it, because the pre-tool text of a write is the draft being
  // approved (owner: "after you approve something coach's message gets
  // overridden, can lose info"). `text` above stays the answer for parsers.
  result.transcript === tokens.join('')
    ? ok('the transcript is exactly what streamed: every round, with the seam')
    : bad('transcript', JSON.stringify(result.transcript));
}

console.log('4a. two tool rounds: the transcript keeps both, the settled text keeps the answer');
{
  const fetchImpl = scriptedFetch([
    streamResponse([sseText(toolUseReplyEvents({}))]),
    streamResponse([sseText(toolUseReplyEvents({}))]),
    streamResponse([sseText(textReplyEvents('Both saved.'))]),
  ]);
  const tokens = [];
  const result = await runCoachTurn(CONFIG(fetchImpl), REQUEST, {
    onToken: (t) => tokens.push(t),
    executeTool: async () => ({ content: '{"ok":true}' }),
  });
  result.transcript === 'Checking.\n\nChecking.\n\nBoth saved.' &&
  result.transcript === tokens.join('') &&
  result.text === 'Both saved.' &&
  result.toolCalls.length === 2
    ? ok('round one, round two and the answer, in order; `text` is still the answer alone')
    : bad('two rounds', JSON.stringify({ transcript: result.transcript, text: result.text }));
}

console.log('4b. …but narration is kept when nothing follows it');
{
  // The round-trip guard trips with the model still mid-tool-loop: the text it
  // managed to say is all there is, and settling on '' would persist an empty
  // assistant row over a turn that genuinely spoke.
  const fetchImpl = scriptedFetch(
    Array.from({ length: 8 }, () => streamResponse([sseText(toolUseReplyEvents({}))]))
  );
  const result = await runCoachTurn(CONFIG(fetchImpl), REQUEST, {
    onToken: () => {},
    executeTool: async () => ({ content: '{"ok":true}' }),
  });
  result.stopReason === 'tool_use_limit'
    ? ok('the round-trip guard trips')
    : bad('stop reason', result.stopReason);
  result.text.startsWith('Checking.')
    ? ok('…and the turn falls back to what it did say rather than settling on nothing')
    : bad('lost narration', JSON.stringify(result.text));
  // Eight rounds of "Checking." with the loop's seam after each; the trailing
  // seam is the loop's, not the model's, so it is trimmed off the transcript.
  result.transcript === Array.from({ length: 8 }, () => 'Checking.').join('\n\n')
    ? ok('…and the transcript holds every round, without a dangling seam')
    : bad('capped transcript', JSON.stringify(result.transcript));
}

console.log('5. tool failures and declines round-trip honestly');
{
  const fetchImpl = scriptedFetch([
    streamResponse([sseText(toolUseReplyEvents({}))]),
    streamResponse([sseText(textReplyEvents('Understood.'))]),
  ]);
  const result = await runCoachTurn(CONFIG(fetchImpl), REQUEST, {
    onToken: () => {},
    executeTool: async () => {
      throw new Error('db exploded');
    },
  });
  const resultBlock = fetchImpl.calls[1].payload.messages.at(-1).content[0];
  resultBlock.is_error === true && resultBlock.content === 'db exploded'
    ? ok('a throwing executor becomes an is_error tool_result')
    : bad('is_error', JSON.stringify(resultBlock));
  result.toolCalls[0].isError === true
    ? ok('recorded as isError in the turn record')
    : bad('record');

  const fetchImpl2 = scriptedFetch([
    streamResponse([sseText(toolUseReplyEvents({}))]),
    streamResponse([sseText(textReplyEvents('Okay, skipped.'))]),
  ]);
  const declined = await runCoachTurn(CONFIG(fetchImpl2), REQUEST, {
    onToken: () => {},
    executeTool: async () => ({
      content: 'The user declined this action.',
      declined: true,
      declinedSummary: 'Log weight 178 lb',
    }),
  });
  const declinedBlock = fetchImpl2.calls[1].payload.messages.at(-1).content[0];
  declined.toolCalls[0].declined === true && declinedBlock.is_error === undefined
    ? ok('a decline is recorded but NOT an error (the model must not retry)')
    : bad('declined', JSON.stringify(declined.toolCalls));
  declined.toolCalls[0].declinedSummary === 'Log weight 178 lb' &&
  declined.toolCalls[0].receipt === undefined &&
  !JSON.stringify(declinedBlock).includes('178')
    ? ok('…its card line rides the record for the thread, and never the wire')
    : bad('declined summary', JSON.stringify(declined.toolCalls[0]));
}

console.log('6. HTTP errors, refusal, and the runaway-loop guard');
{
  const fetchImpl = scriptedFetch([
    streamResponse(
      ['{"type":"error","error":{"type":"authentication_error","message":"bad key"}}'],
      {
        ok: false,
        status: 401,
      }
    ),
  ]);
  let threw = null;
  try {
    await runCoachTurn(CONFIG(fetchImpl), REQUEST, {
      onToken: () => {},
      executeTool: async () => ({ content: '' }),
    });
  } catch (e) {
    threw = e;
  }
  threw instanceof ModelRequestError &&
  threw.status === 401 &&
  threw.errorType === 'authentication_error'
    ? ok('non-2xx throws a typed error with the server message')
    : bad('http error', String(threw));

  const refusal = await runCoachTurn(
    CONFIG(scriptedFetch([streamResponse([sseText(textReplyEvents('', 'refusal'))])])),
    REQUEST,
    { onToken: () => {}, executeTool: async () => ({ content: '' }) }
  );
  refusal.stopReason === 'refusal'
    ? ok('refusal stop reason surfaces')
    : bad('refusal', refusal.stopReason);

  // A thunk, so every round-trip gets a FRESH stream (a stream reads once).
  const loopFetch = scriptedFetch([() => streamResponse([sseText(toolUseReplyEvents({}))])]);
  const capped = await runCoachTurn(CONFIG(loopFetch), REQUEST, {
    onToken: () => {},
    executeTool: async () => ({ content: '{}' }),
  });
  capped.stopReason === 'tool_use_limit' && loopFetch.calls.length === 8
    ? ok('a model that never stops calling tools is capped at 8 round-trips')
    : bad('loop guard', `${capped.stopReason} after ${loopFetch.calls.length} calls`);
}

console.log('8. truncation resilience: capped tool input and dropped stream tails');
{
  // max_tokens hit mid tool call: the input JSON is cut mid-document. The turn
  // must degrade to the max_tokens path, never crash on JSON.parse.
  const events = toolUseReplyEvents({ inputJson: '{"days":' });
  events[events.length - 2] = {
    event: 'message_delta',
    data: { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
  };
  let executed = 0;
  const result = await runCoachTurn(
    CONFIG(scriptedFetch([streamResponse([sseText(events)])])),
    REQUEST,
    {
      onToken: () => {},
      executeTool: async () => {
        executed++;
        return { content: '{}' };
      },
    }
  );
  result.stopReason === 'max_tokens' && executed === 0
    ? ok('truncated tool input resolves as max_tokens; the half-call never executes')
    : bad('truncated input', JSON.stringify(result));

  // A stream that ends without message_delta is a dropped connection — it must
  // surface as an error, not as a "complete" reply the caller would persist.
  const dropped = textReplyEvents('Half a rep').slice(0, -2); // no message_delta/stop
  let threw = null;
  try {
    await runCoachTurn(CONFIG(scriptedFetch([streamResponse([sseText(dropped)])])), REQUEST, {
      onToken: () => {},
      executeTool: async () => ({ content: '' }),
    });
  } catch (e) {
    threw = e;
  }
  threw instanceof ModelRequestError
    ? ok('a stream with no stop reason throws instead of faking end_turn')
    : bad('dropped stream', String(threw));

  // Context-window exhaustion is truncation, not completion.
  const ctx = await runCoachTurn(
    CONFIG(
      scriptedFetch([
        streamResponse([sseText(textReplyEvents('…', 'model_context_window_exceeded'))]),
      ])
    ),
    REQUEST,
    { onToken: () => {}, executeTool: async () => ({ content: '' }) }
  );
  ctx.stopReason === 'max_tokens'
    ? ok('model_context_window_exceeded maps to max_tokens, not end_turn')
    : bad('context window', ctx.stopReason);
}

console.log('9. a failure after executed tools carries the audit record out');
{
  const fetchImpl = scriptedFetch([
    streamResponse([sseText(toolUseReplyEvents({}))]),
    streamResponse(['{"type":"error","error":{"type":"api_error","message":"boom"}}'], {
      ok: false,
      status: 500,
    }),
  ]);
  let threw = null;
  try {
    await runCoachTurn(CONFIG(fetchImpl), REQUEST, {
      onToken: () => {},
      executeTool: async () => ({ content: '{"ok":true}' }),
    });
  } catch (e) {
    threw = e;
  }
  threw instanceof CoachTurnError &&
  threw.toolCalls.length === 1 &&
  threw.toolCalls[0].name === 'get_insights' &&
  threw.partialText.startsWith('Checking.')
    ? ok('CoachTurnError preserves the executed tool calls and partial text')
    : bad('turn error', String(threw));
}

console.log('10. abort: a pre-aborted signal never reaches the network');
{
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = scriptedFetch([streamResponse([sseText(textReplyEvents('hi'))])]);
  let threw = null;
  try {
    await runCoachTurn(CONFIG(fetchImpl), REQUEST, {
      onToken: () => {},
      executeTool: async () => ({ content: '' }),
      signal: controller.signal,
    });
  } catch (e) {
    threw = e;
  }
  threw && threw.name === 'AbortError' && fetchImpl.calls.length === 0
    ? ok('AbortError before any fetch')
    : bad('abort', `${String(threw)} calls=${fetchImpl.calls.length}`);
}

console.log('11. systemContext rides as a second, UNCACHED system block');
{
  const built = buildMessagesRequest(CONFIG(null), {
    ...REQUEST,
    systemContext: 'Current state: readiness caution, 3 of 9 done.',
  });
  const payload = JSON.parse(built.body);
  payload.system.length === 2 &&
  payload.system[0].cache_control?.type === 'ephemeral' &&
  payload.system[1].text === 'Current state: readiness caution, 3 of 9 done.' &&
  payload.system[1].cache_control === undefined
    ? ok('two blocks: static cached, per-turn context uncached after the breakpoint')
    : bad('two-block system', built.body);

  const without = JSON.parse(buildMessagesRequest(CONFIG(null), REQUEST).body);
  without.system.length === 1
    ? ok('omitted systemContext → single block (labs parser path unchanged)')
    : bad('single block', JSON.stringify(without.system));

  const blank = JSON.parse(
    buildMessagesRequest(CONFIG(null), { ...REQUEST, systemContext: '   ' }).body
  );
  blank.system.length === 1
    ? ok('blank systemContext never ships an empty block')
    : bad('blank block', JSON.stringify(blank.system));
}

console.log('12. the model picker states each option; it does not sell one');
{
  // Slop pass 3 (docs/ai-slop-candidates-2026-09.md §10). The list's §8 cut
  // "near-Opus quality for a fraction of the cost" from the margin on Settings ›
  // Coach; the same claim survived just above it, in the picker row's own
  // note — built HERE, so the walk of app/ never read it. A note is a fact about
  // the option (the default, a cost multiple, speed), never a comparison that
  // flatters one product against another.
  // Since the usage policy (2026-10-21) the default depends on the level, so
  // Sonnet 5's note names whose default it is (Lean's), and nothing more.
  const sonnet = COACH_MODELS.find((m) => m.id === DEFAULT_MODEL);
  sonnet?.note === 'Lean’s default'
    ? ok('the default model is marked as Lean’s default, and nothing more')
    : bad('default note', sonnet?.note);
  COACH_MODELS.every((m) => !/near-|quality/i.test(m.note))
    ? ok('no note borrows another model’s name to describe itself')
    : bad('comparative note', COACH_MODELS.map((m) => m.note).join(' | '));
  COACH_MODELS.find((m) => m.id === 'claude-opus-5')?.note.includes('~2.5× the cost')
    ? ok('Opus keeps its cost multiple — the figure is the decision aid')
    : bad('opus note', JSON.stringify(COACH_MODELS));
}

// --- Provider-side web search (2026-10-21, items 62 and 91) -------------------
//
// Every fixture below is the DOCUMENTED wire shape (the web search tool page and
// the server-tools page, read through the claude-api skill): `server_tool_use`
// streamed by input_json_delta, `web_search_tool_result` complete in one
// content_block_start, citations as `citations_delta`, the count in
// `usage.server_tool_use.web_search_requests`. No network: scripted streams.

const ev = (event, data) => ({ event, data: { type: event, ...data } });

/** Blocks for one search: the call, its input in two fragments, its result. */
function searchEvents(
  index,
  { id = 'srvtoolu_1', query = 'big mac nutrition new zealand', result } = {}
) {
  const json = JSON.stringify({ query });
  return [
    ev('content_block_start', {
      index,
      content_block: { type: 'server_tool_use', id, name: 'web_search', input: {} },
    }),
    ev('content_block_delta', {
      index,
      delta: { type: 'input_json_delta', partial_json: json.slice(0, 5) },
    }),
    ev('content_block_delta', {
      index,
      delta: { type: 'input_json_delta', partial_json: json.slice(5) },
    }),
    ev('content_block_stop', { index }),
    ...(result === undefined
      ? []
      : [
          ev('content_block_start', {
            index: index + 1,
            content_block: { type: 'web_search_tool_result', tool_use_id: id, content: result },
          }),
          ev('content_block_stop', { index: index + 1 }),
        ]),
  ];
}

const MENU_RESULTS = [
  {
    type: 'web_search_result',
    url: 'https://www.mcdonalds.co.nz/menu/big-mac',
    title: 'Big Mac | McDonald’s NZ',
    encrypted_content: 'EqgfCioIARgBIiQ3YTAw-opaque-1',
    page_age: 'April 30, 2026',
  },
  {
    type: 'web_search_result',
    url: 'https://fatsecret.co.nz/calories-nutrition/mcdonalds/big-mac',
    title: 'Big Mac nutrition',
    encrypted_content: 'EqgfCioIARgBIiQ3YTAw-opaque-2',
    page_age: null,
  },
];

const CITATION = {
  type: 'web_search_result_location',
  url: 'https://www.mcdonalds.co.nz/menu/big-mac',
  title: 'Big Mac | McDonald’s NZ',
  encrypted_index: 'Eo8BCioIAhgBIiQyYjQ0-opaque-index',
  cited_text: 'Big Mac 2,060 kJ (492 kcal)',
};

/** A text block at `index`, optionally carrying one citation via citations_delta. */
function textEvents(index, text, citation) {
  return [
    ev('content_block_start', { index, content_block: { type: 'text', text: '' } }),
    ev('content_block_delta', { index, delta: { type: 'text_delta', text } }),
    ...(citation
      ? [ev('content_block_delta', { index, delta: { type: 'citations_delta', citation } })]
      : []),
    ev('content_block_stop', { index }),
  ];
}

const finish = (stop_reason, usage = {}) => [
  ev('message_delta', { delta: { stop_reason }, usage }),
  ev('message_stop', {}),
];

const START = [ev('message_start', { message: { usage: { input_tokens: 900 } } })];

const reply = (events) => streamResponse([sseText(events)]);

console.log('13. the request carries the search tool only when asked, on a model that has one');
{
  const searchConfig = (model) => ({ apiKey: 'sk-test', model, fetchImpl: null });
  const withSearch = { ...REQUEST, webSearch: { maxUses: COACH_WEB_SEARCH_MAX_USES } };

  const sonnet = JSON.parse(buildMessagesRequest(searchConfig('claude-sonnet-5'), withSearch).body);
  const last = sonnet.tools[sonnet.tools.length - 1];
  sonnet.tools.length === 2 &&
  last.type === 'web_search_20260209' &&
  last.name === 'web_search' &&
  last.max_uses === 3 &&
  JSON.stringify(Object.keys(last).sort()) === '["max_uses","name","type"]'
    ? ok('Sonnet 5: web_search_20260209 as documented (type, name, max_uses 3), after the registry')
    : bad('sonnet search tool', JSON.stringify(sonnet.tools));
  last.cache_control === undefined && sonnet.tools[0].cache_control?.ttl === '1h'
    ? ok('…and the tool breakpoint stays on the last REGISTRY tool, where it always was')
    : bad('cache breakpoint moved', JSON.stringify(sonnet.tools));

  const opus = JSON.parse(buildMessagesRequest(searchConfig('claude-opus-5'), withSearch).body);
  opus.tools.at(-1).type === 'web_search_20260209'
    ? ok('Opus 5 takes the same version')
    : bad('opus', JSON.stringify(opus.tools));

  const haiku = JSON.parse(buildMessagesRequest(searchConfig('claude-haiku-4-5'), withSearch).body);
  haiku.tools.at(-1).type === 'web_search_20250305' && !('allowed_callers' in haiku.tools.at(-1))
    ? ok('Haiku 4.5 takes the basic web_search_20250305 (no dynamic-filtering field)')
    : bad('haiku', JSON.stringify(haiku.tools));

  const unknown = JSON.parse(
    buildMessagesRequest(searchConfig('some-other-provider-model'), withSearch).body
  );
  unknown.tools.length === 1 && unknown.tools.every((t) => t.name !== 'web_search')
    ? ok('a model the table does not know gets NO search, never a guessed version (a 400)')
    : bad('unknown model searched', JSON.stringify(unknown.tools));

  const off = JSON.parse(
    buildMessagesRequest(searchConfig('claude-sonnet-5'), { ...REQUEST, webSearch: null }).body
  );
  const absent = JSON.parse(buildMessagesRequest(searchConfig('claude-sonnet-5'), REQUEST).body);
  off.tools.length === 1 && absent.tools.length === 1
    ? ok('the switch off (null) or no option at all sends no search tool')
    : bad('search sent while off', JSON.stringify(off.tools));

  // The estimators: no registry tools, so the server tool is the whole list.
  const estimator = buildMealEstimationRequest(
    { kind: 'text', description: 'a Big Mac and medium fries' },
    { webSearch: true, region: 'Region: NZ (time zone Pacific/Auckland)' }
  );
  const wire = JSON.parse(
    buildMessagesRequest(searchConfig('claude-sonnet-5'), {
      system: estimator.system,
      systemContext: estimator.systemContext,
      messages: estimator.messages,
      tools: [],
      webSearch: estimator.webSearch,
    }).body
  );
  wire.tools.length === 1 &&
  wire.tools[0].type === 'web_search_20260209' &&
  wire.tools[0].max_uses === 2
    ? ok('an estimate carries the search tool alone, capped at 2')
    : bad('estimator tools', JSON.stringify(wire.tools));
  wire.system.length === 2 &&
  wire.system[1].text.includes('Region: NZ') &&
  wire.system[1].text.includes("that country's menu") &&
  wire.system[1].text.includes('never anything about the person') &&
  wire.system[1].cache_control === undefined &&
  wire.system[0].text === MEAL_ESTIMATION_SYSTEM_PROMPT
    ? ok('…the region and the privacy rule ride the UNCACHED context block, the prompt untouched')
    : bad('estimator context', JSON.stringify(wire.system));

  const estimatorOff = buildMealEstimationRequest(
    { kind: 'text', description: 'a Big Mac' },
    NO_ESTIMATOR_OPTIONS
  );
  !('webSearch' in estimatorOff) && !('systemContext' in estimatorOff)
    ? ok('with search off and no region, the estimate request is byte-identical to before')
    : bad('estimator off', JSON.stringify(Object.keys(estimatorOff)));
  const revision = buildMealRevisionRequest({ name: 'Lunch', items: [] }, 'it was a Big Mac', {
    webSearch: true,
    region: null,
  });
  const entry = buildFoodEntryRequest('Whittaker’s dark chocolate', {
    webSearch: true,
    region: null,
  });
  revision.webSearch?.maxUses === 2 && entry.webSearch?.maxUses === 2
    ? ok('the revision and the food description carry it too, the same way')
    : bad('revision/entry', JSON.stringify([revision.webSearch, entry.webSearch]));
}

console.log('14. a searched reply parses: query, results, citations, the billed count');
{
  const events = [
    ...START,
    // No trailing space, as the model actually writes it: this fixture used to
    // end the sentence with one, which is the only reason the glue
    // ("…menu.A Big Mac…") never showed here.
    ...textEvents(0, 'Checking the NZ menu.'),
    ...searchEvents(1, { result: MENU_RESULTS }),
    ...textEvents(3, 'A Big Mac is 492 kcal.', CITATION),
    ...finish('end_turn', { output_tokens: 60, server_tool_use: { web_search_requests: 1 } }),
  ];
  const fetchImpl = scriptedFetch([reply(events)]);
  const tokens = [];
  const activity = [];
  const executed = [];
  const result = await runCoachTurn(
    { apiKey: 'sk-test', model: 'claude-sonnet-5', fetchImpl },
    { ...REQUEST, webSearch: { maxUses: 3 } },
    {
      onToken: (t) => tokens.push(t),
      onToolCall: (c) => activity.push(c.name),
      executeTool: async (name) => (executed.push(name), { content: '{}' }),
    }
  );
  activity.join(',') === 'web_search' && executed.length === 0 && fetchImpl.calls.length === 1
    ? ok(
        'the search drives the activity line, executes nothing on the phone, and costs one request'
      )
    : bad('activity', JSON.stringify({ activity, executed, calls: fetchImpl.calls.length }));

  result.transcript === 'Checking the NZ menu.\n\nA Big Mac is 492 kcal.' &&
  tokens.join('') === result.transcript &&
  result.text === result.transcript &&
  result.stopReason === 'end_turn'
    ? ok('the text around a search streams and settles as one reply, a seam where the search was')
    : bad('text', JSON.stringify(result.transcript));
  const search = result.toolCalls.find((c) => c.name === 'web_search');
  const record = search ? JSON.parse(search.result) : null;
  search?.id === 'srvtoolu_1' &&
  search.input.query === 'big mac nutrition new zealand' &&
  record.query === 'big mac nutrition new zealand' &&
  JSON.stringify(record.found) === '["mcdonalds.co.nz","fatsecret.co.nz"]' &&
  JSON.stringify(record.cited) === '["mcdonalds.co.nz"]' &&
  search.isError === undefined
    ? ok('the search is recorded: its query, the domains found, the domain the answer cited')
    : bad('search record', JSON.stringify(search));
  !search.result.includes('opaque')
    ? ok('…and nothing encrypted is kept in the record (it is for the screen, not the API)')
    : bad('encrypted content leaked into the record', search.result);
  result.usage.webSearchRequests === 1
    ? ok('usage carries the billed search count from server_tool_use.web_search_requests')
    : bad('usage', JSON.stringify(result.usage));

  // The accumulator, directly: blocks kept whole for a verbatim echo.
  const acc = new MessageAccumulator(() => {});
  for (const e of events) acc.consume({ event: e.event, data: JSON.stringify(e.data) });
  const blocks = acc.finish().blocks;
  blocks[0].text === 'Checking the NZ menu.' &&
  blocks[1].type === 'server_tool_use' &&
  blocks[1].input.query === 'big mac nutrition new zealand' &&
  blocks[2].type === 'web_search_tool_result' &&
  blocks[2].content[0].encrypted_content === 'EqgfCioIARgBIiQ3YTAw-opaque-1' &&
  blocks[3].citations?.[0]?.encrypted_index === 'Eo8BCioIAhgBIiQyYjQ0-opaque-index'
    ? ok(
        'the accumulator keeps server_tool_use input, encrypted_content and encrypted_index intact'
      )
    : bad('accumulated blocks', JSON.stringify(blocks));

  const summaries = webSearchesOf(result.toolCalls);
  summaries.length === 1 &&
  searchedLine(summaries[0]) === 'Searched “big mac nutrition new zealand” · mcdonalds.co.nz'
    ? ok(`the bubble line reads: ${searchedLine(summaries[0])}`)
    : bad('searched line', JSON.stringify(summaries));
}

console.log('15. round-trip: a search beside a client tool echoes verbatim and resumes');
{
  // Reply 1: a search WITH its result, a cited sentence, then a client tool call.
  const first = [
    ...START,
    ...searchEvents(0, { result: MENU_RESULTS }),
    ...textEvents(2, 'NZ lists it at 492 kcal. ', CITATION),
    ev('content_block_start', {
      index: 3,
      content_block: { type: 'tool_use', id: 'toolu_9', name: 'get_insights', input: {} },
    }),
    ev('content_block_delta', {
      index: 3,
      delta: { type: 'input_json_delta', partial_json: '{}' },
    }),
    ev('content_block_stop', { index: 3 }),
    ...finish('tool_use', { server_tool_use: { web_search_requests: 1 } }),
  ];
  const second = [...START, ...textEvents(0, 'Logged against today.'), ...finish('end_turn')];
  const fetchImpl = scriptedFetch([reply(first), reply(second)]);
  const result = await runCoachTurn(
    { apiKey: 'sk-test', model: 'claude-sonnet-5', fetchImpl },
    { ...REQUEST, webSearch: { maxUses: 3 } },
    { onToken: () => {}, executeTool: async () => ({ content: '{"ok":true}' }) }
  );

  const msgs = fetchImpl.calls[1].payload.messages;
  const echoed = msgs[msgs.length - 2];
  const results = msgs[msgs.length - 1];
  echoed.role === 'assistant' &&
  echoed.content[0].type === 'server_tool_use' &&
  echoed.content[0].input.query === 'big mac nutrition new zealand' &&
  echoed.content[1].content[1].encrypted_content === 'EqgfCioIARgBIiQ3YTAw-opaque-2' &&
  echoed.content[2].citations[0].encrypted_index === 'Eo8BCioIAhgBIiQyYjQ0-opaque-index'
    ? ok('the continuation echoes the search, its encrypted results and the citation unchanged')
    : bad('echo', JSON.stringify(echoed));
  results.role === 'user' &&
  results.content.length === 1 &&
  results.content.every((b) => b.type === 'tool_result' && b.tool_use_id === 'toolu_9')
    ? ok('…and the follow-up holds ONLY the client tool_result (no result for a server tool)')
    : bad('follow-up', JSON.stringify(results));
  JSON.stringify(fetchImpl.calls[1].payload.tools) ===
  JSON.stringify(fetchImpl.calls[0].payload.tools)
    ? ok('…with the same tools array, search tool included')
    : bad('tools changed between rounds');
  result.toolCalls.map((c) => c.name).join(',') === 'web_search,get_insights'
    ? ok('the record lists the search, then the tool, in the order they were made')
    : bad('order', result.toolCalls.map((c) => c.name).join(','));

  // The DEFERRED shape: a search called beside a client tool has no result in
  // reply 1; the API runs it at the start of the next request, whose first
  // block is the result.
  const deferred1 = [
    ...START,
    ...searchEvents(0, { id: 'srvtoolu_d', query: 'subway nz menu' }),
    ev('content_block_start', {
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_d', name: 'get_insights', input: {} },
    }),
    ev('content_block_stop', { index: 1 }),
    ...finish('tool_use'),
  ];
  const deferred2 = [
    ...START,
    ev('content_block_start', {
      index: 0,
      content_block: {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_d',
        content: MENU_RESULTS,
      },
    }),
    ev('content_block_stop', { index: 0 }),
    ...textEvents(1, 'Done.'),
    ...finish('end_turn', { server_tool_use: { web_search_requests: 1 } }),
  ];
  const fetch2 = scriptedFetch([reply(deferred1), reply(deferred2)]);
  const deferred = await runCoachTurn(
    { apiKey: 'sk-test', model: 'claude-sonnet-5', fetchImpl: fetch2 },
    { ...REQUEST, webSearch: { maxUses: 3 } },
    { onToken: () => {}, executeTool: async () => ({ content: '{}' }) }
  );
  const pending = fetch2.calls[1].payload.messages.at(-2).content[0];
  const record = JSON.parse(deferred.toolCalls.find((c) => c.id === 'srvtoolu_d').result);
  pending.type === 'server_tool_use' &&
  pending.id === 'srvtoolu_d' &&
  record.found.length === 2 &&
  record.error === undefined
    ? ok('a deferred search pairs with the result that opens the NEXT reply, by tool_use_id')
    : bad('deferred', JSON.stringify(record));

  // History across turns: the record survives JSON (the ai_messages column)
  // and the next turn's digest names what was searched.
  const stored = JSON.parse(JSON.stringify(result.toolCalls));
  JSON.stringify(webSearchesOf(stored)) === JSON.stringify(webSearchesOf(result.toolCalls)) &&
  toolDigest(stored).includes('web_search →') &&
  toolDigest(stored).includes('big mac nutrition new zealand')
    ? ok('a reloaded row draws the same Searched line, and the next turn’s digest names the query')
    : bad('replay', toolDigest(stored));
}

console.log('16. pause_turn: the paused content goes back unchanged, and the turn continues');
{
  const paused = [
    ...START,
    ...textEvents(0, 'Looking at three menus. '),
    ...searchEvents(1, { result: MENU_RESULTS }),
    ...finish('pause_turn', { server_tool_use: { web_search_requests: 1 } }),
  ];
  const resumed = [
    ...START,
    ...textEvents(0, 'The NZ Big Mac is 492 kcal.'),
    ...finish('end_turn', { server_tool_use: { web_search_requests: 1 } }),
  ];
  const fetchImpl = scriptedFetch([reply(paused), reply(resumed)]);
  const executed = [];
  const result = await runCoachTurn(
    { apiKey: 'sk-test', model: 'claude-sonnet-5', fetchImpl },
    { ...REQUEST, webSearch: { maxUses: 3 } },
    { onToken: () => {}, executeTool: async (name) => (executed.push(name), { content: '{}' }) }
  );
  const msgs = fetchImpl.calls[1].payload.messages;
  fetchImpl.calls.length === 2 &&
  msgs.length === REQUEST.messages.length + 1 &&
  msgs.at(-1).role === 'assistant' &&
  msgs.at(-1).content[1].type === 'server_tool_use' &&
  msgs.at(-1).content[2].content[0].encrypted_content === 'EqgfCioIARgBIiQ3YTAw-opaque-1'
    ? ok('the resume sends the paused assistant content back as-is, with no added user message')
    : bad('resume request', JSON.stringify(msgs));
  JSON.stringify(fetchImpl.calls[1].payload.tools) ===
  JSON.stringify(fetchImpl.calls[0].payload.tools)
    ? ok('…and the same tools (a pending server tool must still be defined)')
    : bad('tools changed on resume');
  result.stopReason === 'end_turn' &&
  result.transcript === 'Looking at three menus. The NZ Big Mac is 492 kcal.' &&
  executed.length === 0
    ? ok('the turn ends normally, one reply across the pause, no client tool run')
    : bad('paused turn', JSON.stringify(result));
  result.usage.webSearchRequests === 2
    ? ok('searches are summed across the paused and resumed requests')
    : bad('pause usage', JSON.stringify(result.usage));

  const always = scriptedFetch([() => reply(paused)]);
  const capped = await runCoachTurn(
    { apiKey: 'sk-test', model: 'claude-sonnet-5', fetchImpl: always },
    { ...REQUEST, webSearch: { maxUses: 3 } },
    { onToken: () => {}, executeTool: async () => ({ content: '{}' }) }
  );
  capped.stopReason === 'tool_use_limit' && always.calls.length === 8
    ? ok('a turn that never stops pausing is capped by the round-trip guard, not looped forever')
    : bad('pause cap', `${capped.stopReason} after ${always.calls.length}`);
}

console.log('17. a failed or unfinished search says so');
{
  const failed = [
    ...START,
    ...searchEvents(0, {
      result: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' },
    }),
    ...textEvents(2, 'I could not look it up; estimating from typical values.'),
    ...finish('end_turn'),
  ];
  const r1 = await runCoachTurn(
    { apiKey: 'sk-test', model: 'claude-sonnet-5', fetchImpl: scriptedFetch([reply(failed)]) },
    { ...REQUEST, webSearch: { maxUses: 3 } },
    { onToken: () => {}, executeTool: async () => ({ content: '{}' }) }
  );
  const s1 = r1.toolCalls[0];
  s1.isError === true &&
  JSON.parse(s1.result).error === 'max_uses_exceeded' &&
  searchedLine(webSearchesOf(r1.toolCalls)[0]).endsWith('· no result')
    ? ok('an error OBJECT (not a list) is recorded as a failed search, and drawn as one')
    : bad('error result', JSON.stringify(s1));

  const cut = [...START, ...searchEvents(0, {}), ...finish('max_tokens')];
  const r2 = await runCoachTurn(
    { apiKey: 'sk-test', model: 'claude-sonnet-5', fetchImpl: scriptedFetch([reply(cut)]) },
    { ...REQUEST, webSearch: { maxUses: 3 } },
    { onToken: () => {}, executeTool: async () => ({ content: '{}' }) }
  );
  r2.toolCalls[0].isError === true && JSON.parse(r2.toolCalls[0].result).error === 'no_result'
    ? ok('a search the turn stopped before running is sealed as "no result", not an empty success')
    : bad('unresolved', JSON.stringify(r2.toolCalls));

  // Cost: $10 per 1,000 searches, on top of tokens, named in the caption.
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const plain = estimateCost({ ...usage, outputTokens: 100 }, 'claude-sonnet-5');
  const searched = estimateCost(
    { ...usage, outputTokens: 100, webSearchRequests: 2 },
    'claude-sonnet-5'
  );
  Math.abs(searched - plain - 0.02) < 1e-9 &&
  usageCaption(
    { ...usage, outputTokens: 100, webSearchRequests: 2 },
    'claude-sonnet-5',
    0
  ).startsWith('2 searches · ')
    ? ok('two searches add $0.02 to the estimate, and the caption names them')
    : bad('search cost', `${plain} → ${searched}`);
  isWebSearchCall({ name: 'web_search' }) && !isWebSearchCall({ name: 'get_insights' })
    ? ok('isWebSearchCall tells a search from a registry tool')
    : bad('isWebSearchCall');

  // A search is not a write: a transport failure after only searches is the
  // plain error (nothing to persist), never the audit-carrying CoachTurnError.
  const pausedOnly = [
    ...START,
    ...searchEvents(0, { result: MENU_RESULTS }),
    ...finish('pause_turn'),
  ];
  const failing = scriptedFetch([
    reply(pausedOnly),
    streamResponse(['{"error":{"type":"overloaded_error","message":"busy"}}'], {
      ok: false,
      status: 529,
    }),
  ]);
  let thrown = null;
  try {
    await runCoachTurn(
      { apiKey: 'sk-test', model: 'claude-sonnet-5', fetchImpl: failing },
      { ...REQUEST, webSearch: { maxUses: 3 } },
      { onToken: () => {}, executeTool: async () => ({ content: '{}' }) }
    );
  } catch (e) {
    thrown = e;
  }
  thrown instanceof ModelRequestError && !(thrown instanceof CoachTurnError)
    ? ok('a failure after searches alone is the plain error: a search is not an audit-worthy write')
    : bad('search-only failure', String(thrown?.name));
}

console.log('18. the region comes from the phone’s time zone, then its region setting');
{
  const nz = deriveRegion({ locale: 'en-NZ', timeZone: 'Pacific/Auckland' });
  nz.country === 'NZ' && regionLine(nz) === 'Region: NZ (time zone Pacific/Auckland)'
    ? ok(`en-NZ in Auckland → "${regionLine(nz)}"`)
    : bad('nz', JSON.stringify(nz));
  const trip = deriveRegion({ locale: 'en-NZ', timeZone: 'Asia/Tokyo' });
  trip.country === 'JP' && regionLine(trip) === 'Region: JP (time zone Asia/Tokyo; phone region NZ)'
    ? ok('a New Zealander in Tokyo is priced from the Japanese menu, and the line shows both')
    : bad('trip', JSON.stringify(trip));
  deriveRegion({ locale: 'en-US', timeZone: 'Australia/Sydney' }).country === 'AU' &&
  deriveRegion({ locale: 'en-US', timeZone: 'America/Indiana/Indianapolis' }).country === 'US' &&
  deriveRegion({ locale: 'en-GB', timeZone: 'Europe/London' }).country === 'GB' &&
  deriveRegion({ locale: 'hi-IN', timeZone: 'Asia/Calcutta' }).country === 'IN'
    ? ok('zone families and legacy aliases map (Australia/*, America/Indiana/*, Asia/Calcutta)')
    : bad('zone map');
  deriveRegion({ locale: 'en_GB', timeZone: 'UTC' }).country === 'GB' &&
  deriveRegion({ locale: 'zh-Hant-TW', timeZone: 'Etc/GMT+3' }).country === 'TW'
    ? ok('an unmapped zone falls back to the locale’s region (underscores and scripts parsed)')
    : bad('locale fallback');
  const none = deriveRegion({ locale: 'es-419', timeZone: 'Etc/UTC' });
  none.country === null && regionLine(none) === 'Region: unknown (time zone Etc/UTC)'
    ? ok('a numeric UN area (es-419) is not a country: the line says unknown, never a guess')
    : bad('es-419', JSON.stringify(none));
  regionOfLocale('en-u-ca-gregory') === null && regionOfLocale('en') === null
    ? ok('no region subtag, or only an extension, gives none')
    : bad('regionOfLocale');
  regionLine(deriveRegion({})) === null
    ? ok('nothing known → no line at all')
    : bad('empty region line');

  // The device read never throws, even with no Intl at all (the Hermes case).
  const saved = globalThis.Intl;
  let fromNoIntl;
  try {
    globalThis.Intl = undefined;
    fromNoIntl = deviceRegion();
  } finally {
    globalThis.Intl = saved;
  }
  fromNoIntl && fromNoIntl.country === null && fromNoIntl.timeZone === null
    ? ok('with Intl absent, deviceRegion() returns an empty region instead of throwing')
    : bad('no Intl', JSON.stringify(fromNoIntl));
  const live = deviceRegion();
  typeof live.timeZone === 'string'
    ? ok(`with Intl present it reads this machine: ${regionLine(live)}`)
    : bad('live region', JSON.stringify(live));
}

console.log('19. the seam: text either side of a search never glues, and the echo is untouched');
{
  const SEARCH = { apiKey: 'sk-test', model: 'claude-sonnet-5' };
  const WITH = { ...REQUEST, webSearch: { maxUses: 3 } };
  const noTools = async () => ({ content: '{}' });

  // The review's repro (glue.mjs), cited fragments and all.
  const SHANNON = {
    ...CITATION,
    url: 'https://en.wikipedia.org/wiki/Claude_Shannon',
    cited_text: 'born April 30, 1916',
  };
  const shannon = [
    ...START,
    ...textEvents(0, "I'll search for when Claude Shannon was born."),
    ...searchEvents(1, {
      query: 'claude shannon birth date',
      result: [{ ...MENU_RESULTS[0], url: SHANNON.url }],
    }),
    ...textEvents(3, 'Based on the search results, '),
    ...textEvents(4, 'Claude Shannon was born on April 30, 1916', SHANNON),
    ...textEvents(5, '.'),
    ...finish('end_turn', { server_tool_use: { web_search_requests: 1 } }),
  ];
  const tokens = [];
  const r1 = await runCoachTurn({ ...SEARCH, fetchImpl: scriptedFetch([reply(shannon)]) }, WITH, {
    onToken: (t) => tokens.push(t),
    executeTool: noTools,
  });
  const expected =
    "I'll search for when Claude Shannon was born.\n\nBased on the search results, Claude Shannon was born on April 30, 1916.";
  r1.transcript === expected && tokens.join('') === expected
    ? ok('"…was born.Based on…" is now "…was born.\\n\\nBased on…", streamed and settled alike')
    : bad('shannon', JSON.stringify({ transcript: r1.transcript, streamed: tokens.join('') }));
  r1.transcript.endsWith('results, Claude Shannon was born on April 30, 1916.')
    ? ok('…while the cited fragments of one answer still join with nothing between them')
    : bad('citation fragments', JSON.stringify(r1.transcript));

  // The echo: the seam must never reach the blocks sent back to the API.
  const searchedThenTool = [
    ...START,
    ...textEvents(0, 'Checking.'),
    ...searchEvents(1, { result: MENU_RESULTS }),
    ...textEvents(3, 'Found it.'),
    ev('content_block_start', {
      index: 4,
      content_block: { type: 'tool_use', id: 'toolu_s', name: 'get_insights', input: {} },
    }),
    ev('content_block_stop', { index: 4 }),
    ...finish('tool_use', { server_tool_use: { web_search_requests: 1 } }),
  ];
  const echoFetch = scriptedFetch([
    reply(searchedThenTool),
    reply([...START, ...textEvents(0, 'Done.'), ...finish('end_turn')]),
  ]);
  const r2 = await runCoachTurn({ ...SEARCH, fetchImpl: echoFetch }, WITH, {
    onToken: () => {},
    executeTool: noTools,
  });
  const echoed = echoFetch.calls[1].payload.messages.at(-2).content;
  const echoedText = echoed.filter((b) => b.type === 'text').map((b) => b.text);
  JSON.stringify(echoedText) === '["Checking.","Found it."]'
    ? ok('the continuation echoes the text blocks byte for byte: no seam in what goes back')
    : bad('echo altered', JSON.stringify(echoed));
  r2.transcript === 'Checking.\n\nFound it.\n\nDone.'
    ? ok('…and the transcript has one seam at the search and the usual one at the tool')
    : bad('mixed transcript', JSON.stringify(r2.transcript));

  // pause_turn: the seam is owed across the resume when the pause fell on a
  // search, and NOT when it fell mid-text.
  const pausedOnSearch = [
    ...START,
    ...textEvents(0, 'Looking at three menus.'),
    ...searchEvents(1, { result: MENU_RESULTS }),
    ...finish('pause_turn'),
  ];
  const r3 = await runCoachTurn(
    {
      ...SEARCH,
      fetchImpl: scriptedFetch([
        reply(pausedOnSearch),
        reply([...START, ...textEvents(0, 'The NZ Big Mac is 492 kcal.'), ...finish('end_turn')]),
      ]),
    },
    WITH,
    { onToken: () => {}, executeTool: noTools }
  );
  r3.transcript === 'Looking at three menus.\n\nThe NZ Big Mac is 492 kcal.'
    ? ok('a pause on a search still pays the seam when the resumed reply speaks')
    : bad('pause seam', JSON.stringify(r3.transcript));
  const pausedMidText = [
    ...START,
    ...searchEvents(0, { result: MENU_RESULTS }),
    ...textEvents(2, 'NZ lists'),
    ...finish('pause_turn'),
  ];
  const r4 = await runCoachTurn(
    {
      ...SEARCH,
      fetchImpl: scriptedFetch([
        reply(pausedMidText),
        reply([...START, ...textEvents(0, ' it at 492 kcal.'), ...finish('end_turn')]),
      ]),
    },
    WITH,
    { onToken: () => {}, executeTool: noTools }
  );
  r4.transcript === 'NZ lists it at 492 kcal.'
    ? ok(
        '…a pause mid-sentence resumes the same sentence, no seam (and none before the first word)'
      )
    : bad('mid-text pause', JSON.stringify(r4.transcript));

  // Thinking carries no prose, so it never splits text; whitespace already there is enough.
  const acc = new MessageAccumulator(() => {});
  for (const e of [
    ...START,
    ...textEvents(0, 'First.'),
    ev('content_block_start', {
      index: 1,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    }),
    ev('content_block_stop', { index: 1 }),
    ...textEvents(2, ' Second, then a search:\n'),
    ...searchEvents(3, { result: MENU_RESULTS }),
    ...textEvents(5, 'Third.'),
    ...finish('end_turn'),
  ]) {
    acc.consume({ event: e.event, data: JSON.stringify(e.data) });
  }
  acc.finish().text === 'First. Second, then a search:\nThird.'
    ? ok('a thinking block adds no seam, and text already ending in whitespace needs none')
    : bad('accumulator seams', JSON.stringify(acc.finish().text));

  // The estimators read the STREAMED text and slice the JSON out of it: a seam
  // ahead of the object must leave the parse exactly what it was.
  const JSON_REPLY =
    '{"title":"Big Mac","items":[{"name":"Big Mac","amount":1,"unit":"piece","kcal":492,' +
    '"protein_g":26,"carbs_g":40,"fat_g":25,"confidence":"high"}],"notes":null}';
  let streamed = '';
  await runCoachTurn(
    {
      ...SEARCH,
      fetchImpl: scriptedFetch([
        reply([
          ...START,
          ...textEvents(0, 'Looking up the NZ menu.'),
          ...searchEvents(1, { result: MENU_RESULTS }),
          ...textEvents(3, JSON_REPLY),
          ...finish('end_turn'),
        ]),
      ]),
    },
    {
      system: 's',
      messages: [{ role: 'user', content: 'a Big Mac' }],
      tools: [],
      webSearch: { maxUses: 2 },
    },
    { onToken: (t) => (streamed += t), executeTool: noTools }
  );
  streamed.includes('menu.\n\n{') &&
  JSON.stringify(parseMealEstimate(streamed)) ===
    JSON.stringify(parseMealEstimate(`Looking up the NZ menu.${JSON_REPLY}`))
    ? ok('an estimator reply parses to the same estimate with the seam as without it')
    : bad('estimator slice', streamed);
}

console.log('20. a key that cannot search: one retry without the tool, then off for the session');
{
  const SEARCH = { apiKey: 'sk-test', model: 'claude-sonnet-5' };
  const WITH = { ...REQUEST, webSearch: { maxUses: 3 } };
  const refused = () =>
    streamResponse(
      [
        '{"type":"error","error":{"type":"invalid_request_error","message":"web search is not enabled for this organization"}}',
      ],
      { ok: false, status: 400 }
    );
  const hasSearch = (call) => (call.payload.tools ?? []).some((t) => t.name === 'web_search');
  const noTools = async () => ({ content: '{}' });
  await apiKeyStore.setWebSearch(true);
  let unavailable = 0;
  const handlers = {
    onToken: () => {},
    executeTool: noTools,
    onWebSearchUnavailable: () => {
      unavailable++;
      apiKeyStore.markWebSearchUnavailable();
    },
  };

  const f1 = scriptedFetch([
    refused(),
    reply([...START, ...textEvents(0, 'Answered without it.'), ...finish('end_turn')]),
  ]);
  const r1 = await runCoachTurn({ ...SEARCH, fetchImpl: f1 }, WITH, handlers);
  f1.calls.length === 2 && hasSearch(f1.calls[0]) && !hasSearch(f1.calls[1])
    ? ok('a 400 on a request carrying the search tool is retried ONCE, without the tool')
    : bad('retry shape', JSON.stringify(f1.calls.map(hasSearch)));
  r1.transcript === 'Answered without it.' && r1.stopReason === 'end_turn' && unavailable === 1
    ? ok('…the turn answers instead of failing, and the caller is told once')
    : bad('retry result', JSON.stringify({ r1, unavailable }));
  JSON.stringify(f1.calls[1].payload.messages) === JSON.stringify(f1.calls[0].payload.messages)
    ? ok('…with the same messages: only the tool is dropped')
    : bad('retry changed messages');

  // The session latch (api-key-store.ts): the stored switch is untouched.
  apiKeyStore.isWebSearchOn() === true && apiKeyStore.isWebSearchUsable() === false
    ? ok('latched off for the session in memory; the Settings switch still reads ON')
    : bad('latch', `${apiKeyStore.isWebSearchOn()} ${apiKeyStore.isWebSearchUsable()}`);
  const first = apiKeyStore.takeWebSearchNotice();
  apiKeyStore.markWebSearchUnavailable();
  first === WEB_SEARCH_UNAVAILABLE_LINE &&
  first.startsWith("Web search isn't available on this API key") &&
  apiKeyStore.takeWebSearchNotice() === null
    ? ok(`one quiet line, once: "${first}"`)
    : bad('notice', String(first));
  await apiKeyStore.setWebSearch(true);
  apiKeyStore.isWebSearchUsable() === true && apiKeyStore.takeWebSearchNotice() === null
    ? ok('touching the switch clears the latch, so search is tried again')
    : bad('latch reset');
  // fix4: the refusal belonged to one key on one model. A new key, a cleared
  // key or a model choice tries search again, and owes no stale line.
  {
    const wasModel = apiKeyStore.getChatModel();
    const relatch = () => {
      apiKeyStore.markWebSearchUnavailable();
      return apiKeyStore.isWebSearchUsable() === false;
    };
    const cleared = async (act) => {
      if (!relatch()) return false;
      await act();
      return apiKeyStore.isWebSearchUsable() === true && apiKeyStore.takeWebSearchNotice() === null;
    };
    const results = {
      setKey: await cleared(() => apiKeyStore.setKey('sk-other-test')),
      clearKey: await cleared(() => apiKeyStore.clearKey()),
      setModel: await cleared(() => apiKeyStore.setModel(wasModel)),
    };
    await apiKeyStore.clearKey();
    Object.values(results).every(Boolean)
      ? ok('a new key, a cleared key and a model choice each clear the latch and its pending line')
      : bad('latch survives a setter', JSON.stringify(results));
  }

  // Within the turn the tool stays off: a tool round's next request goes without it.
  const f2 = scriptedFetch([
    refused(),
    streamResponse([sseText(toolUseReplyEvents({}))]),
    reply([...START, ...textEvents(0, 'Done.'), ...finish('end_turn')]),
  ]);
  unavailable = 0;
  await runCoachTurn({ ...SEARCH, fetchImpl: f2 }, WITH, handlers);
  f2.calls.length === 3 && !hasSearch(f2.calls[1]) && !hasSearch(f2.calls[2]) && unavailable === 1
    ? ok('…and the rest of that turn does not send it again')
    : bad('turn latch', JSON.stringify(f2.calls.map(hasSearch)));
  await apiKeyStore.setWebSearch(true);

  // When the plain request fails too, it was not the tool: its error, no latch.
  unavailable = 0;
  const f3 = scriptedFetch([refused(), refused()]);
  let thrown = null;
  try {
    await runCoachTurn({ ...SEARCH, fetchImpl: f3 }, WITH, handlers);
  } catch (e) {
    thrown = e;
  }
  thrown instanceof ModelRequestError &&
  thrown.status === 400 &&
  f3.calls.length === 2 &&
  unavailable === 0 &&
  apiKeyStore.isWebSearchUsable()
    ? ok('a retry that fails as well throws, and latches nothing')
    : bad('double failure', JSON.stringify({ thrown: String(thrown), calls: f3.calls.length }));

  // What is NOT retried.
  const once = async (config, request, response) => {
    const f = scriptedFetch([
      response,
      reply([...START, ...textEvents(0, 'x'), ...finish('end_turn')]),
    ]);
    try {
      await runCoachTurn({ ...config, fetchImpl: f }, request, handlers);
    } catch {
      // expected
    }
    return f.calls.length;
  };
  unavailable = 0;
  const auth = await once(
    SEARCH,
    WITH,
    streamResponse(['{"error":{"type":"authentication_error","message":"bad key"}}'], {
      ok: false,
      status: 401,
    })
  );
  const noSearch = await once(SEARCH, REQUEST, refused());
  const unknownModel = await once({ ...SEARCH, model: 'some-other-model' }, WITH, refused());
  auth === 1 && noSearch === 1 && unknownModel === 1 && unavailable === 0
    ? ok('not retried: a 401, a 400 on a request without search, a model that sent no tool')
    : bad('over-retry', JSON.stringify({ auth, noSearch, unknownModel }));

  // A search that already RAN this turn proves the tool is accepted.
  const f4 = scriptedFetch([
    reply([...START, ...searchEvents(0, { result: MENU_RESULTS }), ...finish('pause_turn')]),
    refused(),
    reply([...START, ...textEvents(0, 'x'), ...finish('end_turn')]),
  ]);
  try {
    await runCoachTurn({ ...SEARCH, fetchImpl: f4 }, WITH, handlers);
  } catch {
    // expected
  }
  f4.calls.length === 2 && unavailable === 0
    ? ok('…nor a 400 after a search ran in the same turn (its blocks are in the history)')
    : bad('post-search 400', String(f4.calls.length));

  // fix4: "a search ran" is the ledger OR the API's own count. A search block
  // the ledger did not read (a server tool it cannot name, never answered by a
  // search result) still shows in usage.server_tool_use.web_search_requests,
  // and its blocks are just as much in the history.
  const f5 = scriptedFetch([
    reply([
      ...START,
      ev('content_block_start', {
        index: 0,
        content_block: { type: 'server_tool_use', id: 'srvtoolu_x', name: 'unlisted_tool', input: {} },
      }),
      ev('content_block_stop', { index: 0 }),
      ...finish('pause_turn', { server_tool_use: { web_search_requests: 1 } }),
    ]),
    refused(),
    reply([...START, ...textEvents(0, 'x'), ...finish('end_turn')]),
  ]);
  unavailable = 0;
  try {
    await runCoachTurn({ ...SEARCH, fetchImpl: f5 }, WITH, handlers);
  } catch {
    // expected
  }
  f5.calls.length === 2 && unavailable === 0 && apiKeyStore.isWebSearchUsable()
    ? ok('…nor a 400 after the API COUNTED a search this turn, even one the ledger did not record')
    : bad('usage-counted search retried', String(f5.calls.length));
}

console.log('21. a search input that arrives whole, and a search block not named exactly web_search (fix4)');
{
  // The input complete in content_block_start, no input_json_delta: the
  // accumulator used to overwrite it with {} at block stop, altering the block
  // that goes back verbatim and recording a search with no query.
  const whole = [
    ...START,
    ev('content_block_start', {
      index: 0,
      content_block: {
        type: 'server_tool_use',
        id: 'srvtoolu_w',
        name: 'web_search',
        input: { query: 'whittakers dark chocolate kcal' },
      },
    }),
    ev('content_block_stop', { index: 0 }),
    ev('content_block_start', {
      index: 1,
      content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_w', content: MENU_RESULTS },
    }),
    ev('content_block_stop', { index: 1 }),
    ...textEvents(2, 'About 550 kcal per 100 g.'),
    ...finish('end_turn', { server_tool_use: { web_search_requests: 1 } }),
  ];
  const acc = new MessageAccumulator(() => {});
  for (const e of whole) acc.consume({ event: e.event, data: JSON.stringify(e.data) });
  const blocks = acc.finish().blocks;
  const run = await runCoachTurn(
    { apiKey: 'sk-test', model: 'claude-sonnet-5', fetchImpl: scriptedFetch([reply(whole)]) },
    { ...REQUEST, webSearch: { maxUses: 3 } },
    { onToken: () => {}, executeTool: async () => ({ content: '{}' }) }
  );
  const recorded = run.toolCalls.find((c) => c.name === 'web_search');
  blocks[0].input?.query === 'whittakers dark chocolate kcal' &&
  recorded?.input.query === 'whittakers dark chocolate kcal' &&
  JSON.parse(recorded.result).query === 'whittakers dark chocolate kcal'
    ? ok('an input given whole in content_block_start is kept: the echoed block and the record keep the query')
    : bad('whole input lost', JSON.stringify({ input: blocks[0].input, recorded }));
  // A client tool_use with no deltas still reads as {} (nothing to keep).
  const bare = new MessageAccumulator(() => {});
  for (const e of [
    ev('content_block_start', {
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_b', name: 'get_insights' },
    }),
    ev('content_block_stop', { index: 0 }),
  ]) {
    bare.consume({ event: e.event, data: JSON.stringify(e.data) });
  }
  JSON.stringify(bare.finish().blocks[0].input) === '{}'
    ? ok('…and a block with no input at all still reads as {}')
    : bad('bare input', JSON.stringify(bare.finish().blocks));

  // The ledger: a search is what a web_search_tool_result answers, whatever
  // its server_tool_use was named; a name starting web_search reads as one at
  // once; any other server tool is never passed off as a search.
  const ledger = new WebSearchLedger();
  const early = ledger.observe([
    { type: 'server_tool_use', id: 'srv_a', name: 'web_search_v2', input: { query: 'a' } },
    { type: 'server_tool_use', id: 'srv_b', name: 'renamed_search', input: { query: 'b' } },
    { type: 'server_tool_use', id: 'srv_c', name: 'code_execution', input: { code: 'x' } },
  ]);
  const late = ledger.observe([
    { type: 'web_search_tool_result', tool_use_id: 'srv_a', content: MENU_RESULTS },
    { type: 'web_search_tool_result', tool_use_id: 'srv_b', content: MENU_RESULTS },
  ]);
  const all = ledger.finish();
  early.map((c) => c.id).join(',') === 'srv_a' &&
  late.map((c) => c.id).join(',') === 'srv_b' &&
  all.map((c) => `${c.id}:${c.input.query}`).join(',') === 'srv_a:a,srv_b:b' &&
  all.every((c) => c.name === 'web_search' && c.isError === undefined) &&
  JSON.parse(all[1].result).found.length === 2
    ? ok('the ledger records a search by its result as well as by its name, and never a code tool')
    : bad('ledger tolerance', JSON.stringify(all));
}

// --- Track 0, 2026-10-21: current models, the conversation cache, the sink ----

console.log('22. three tables move together: every model has a price and a search decision');
{
  // The drift this pins: a model added to the picker without a PRICES row lost
  // its cost line in silence, and one without a TOOL_VERSION_BY_MODEL row lost
  // web search in silence. Each id must have both — a search "decision" may be
  // an explicit null, never an absence.
  const unpriced = COACH_MODELS.filter((m) => !PRICES[m.id]).map((m) => m.id);
  unpriced.length === 0
    ? ok(`every one of the ${COACH_MODELS.length} COACH_MODELS ids has a PRICES row`)
    : bad('model without a price', unpriced.join(', '));
  const undecided = COACH_MODELS.filter((m) => !hasWebSearchDecision(m.id)).map((m) => m.id);
  undecided.length === 0
    ? ok('…and an explicit web-search decision (a version, or a deliberate null)')
    : bad('model without a search decision', undecided.join(', '));
  ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].every((id) => isCoachModel(id))
    ? ok('Opus 5.5, Sonnet 5.5 and Haiku 5.5 are selectable')
    : bad('5.5 models missing', JSON.stringify(COACH_MODELS.map((m) => m.id)));
  DEFAULT_MODEL === 'claude-sonnet-5'
    ? ok('DEFAULT_MODEL is still Sonnet 5 — Lean’s chat model (the usage policy decides per level)')
    : bad('default moved', DEFAULT_MODEL);

  // The prices, as the live pricing page listed them on 2026-10-21.
  const p = (id) => PRICES[id];
  p('claude-opus-5-5').input === 4 &&
  p('claude-opus-5-5').output === 20 &&
  p('claude-opus-5-5').cacheRead === 0.2 &&
  p('claude-sonnet-5-5').input === 2 &&
  p('claude-sonnet-5-5').output === 10 &&
  p('claude-sonnet-5-5').cacheRead === 0.2 &&
  p('claude-haiku-5-5').input === 0.1 &&
  p('claude-haiku-5-5').output === 0.5 &&
  p('claude-haiku-5-5').cacheRead === 0.01 &&
  p('claude-haiku-5-5').longPrompt?.overTokens === 100_000 &&
  p('claude-haiku-5-5').longPrompt?.input === 0.5 &&
  p('claude-sonnet-5').input === 2 &&
  p('claude-sonnet-5').cacheRead === 0.2
    ? ok('prices: Opus 5.5 $4/$20 (reads $0.20), Sonnet 5.5 $2/$10 (reads $0.10), Haiku 5.5 $0.10/$0.50, tiered past 100k')
    : bad('price table', JSON.stringify(PRICES));

  // Search: a version where the docs say so, null where they do not.
  webSearchTool('claude-opus-5-5', 3)?.type === 'web_search_20260209' &&
  webSearchTool('claude-sonnet-5-5', 3)?.type === 'web_search_20260209' &&
  webSearchTool('claude-haiku-5-5', 3) === null &&
  hasWebSearchDecision('claude-haiku-5-5')
    ? ok('search: the 5.5 Opus and Sonnet take web_search_20260209; Haiku 5.5 is a deliberate no')
    : bad('search versions');
  const haikuNote = COACH_MODELS.find((m) => m.id === 'claude-haiku-5-5')?.note ?? '';
  haikuNote.includes('no web search')
    ? ok('…and the picker says so on Haiku 5.5, rather than leaving a switch that does nothing')
    : bad('haiku note', haikuNote);
}

console.log('23. cost: per-model cache reads, 5-minute writes, and the Haiku 5.5 long-prompt card');
{
  // Opus 5.5 reads at 0.05× input — a multiple this module used to assume was 0.1×.
  const warm = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 10_000, cacheWriteTokens: 0 };
  // 1000×4/M + 10000×0.20/M + 100×20/M = 0.004 + 0.002 + 0.002
  Math.abs(estimateCost(warm, 'claude-opus-5-5') - 0.008) < 1e-9
    ? ok('Opus 5.5: cache reads at $0.20/M, not 0.1× of $4')
    : bad('opus 5.5 cost', String(estimateCost(warm, 'claude-opus-5-5')));
  // Writes split by TTL: 2,000 at 5 minutes (1.25×), 8,000 at an hour (2×).
  const cold = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 10_000,
    cacheWrite5mTokens: 2_000,
  };
  // Sonnet 5: 2000×2/M×1.25 + 8000×2/M×2 = 0.005 + 0.032
  Math.abs(estimateCost(cold, 'claude-sonnet-5') - 0.037) < 1e-9 &&
  Math.abs(
    estimateCost({ ...cold, cacheWrite5mTokens: undefined }, 'claude-sonnet-5') - 0.04
  ) < 1e-9
    ? ok('a write broken down by TTL is priced by TTL; one with no breakdown at the hour rate')
    : bad('ttl write cost', String(estimateCost(cold, 'claude-sonnet-5')));
  // Haiku 5.5's card is chosen per REQUEST by prompt size.
  const small = { inputTokens: 60_000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const big = { ...small, inputTokens: 120_000 };
  Math.abs(estimateCost(small, 'claude-haiku-5-5') - (60_000 * 0.1 + 1000 * 0.5) / 1e6) < 1e-12 &&
  Math.abs(estimateCost(big, 'claude-haiku-5-5') - (120_000 * 0.5 + 1000 * 2.5) / 1e6) < 1e-12
    ? ok('Haiku 5.5: a 60k prompt at $0.10/$0.50, a 120k prompt at $0.50/$2.50 on every token')
    : bad('haiku tiers');
}

console.log('24. the conversation cache: a third breakpoint on the latest user message');
{
  const countMarks = (payload) => {
    let n = 0;
    const walk = (v) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        if (v.cache_control) n++;
        Object.values(v).forEach(walk);
      }
    };
    walk(payload.system);
    walk(payload.tools ?? []);
    walk(payload.messages);
    return n;
  };
  // The rendered order of every breakpoint's TTL: tools → system → messages.
  const ttlOrder = (payload) => {
    const ttls = [];
    const take = (b) => b?.cache_control && ttls.push(b.cache_control.ttl ?? '5m');
    (payload.tools ?? []).forEach(take);
    payload.system.forEach(take);
    for (const m of payload.messages) if (Array.isArray(m.content)) m.content.forEach(take);
    return ttls;
  };
  /** Messages with every cache marker removed and a single text block read as a string. */
  const stripped = (messages) =>
    messages.map((m) => {
      if (!Array.isArray(m.content)) return m;
      const content = m.content.map(({ cache_control, ...rest }) => rest);
      return content.length === 1 && content[0].type === 'text' && Object.keys(content[0]).length === 2
        ? { ...m, content: content[0].text }
        : { ...m, content };
    });

  // a. A turn that can round trip marks its latest user message — and only it.
  const history = [
    { role: 'user', content: 'Earlier question' },
    { role: 'assistant', content: 'Earlier answer' },
    { role: 'user', content: 'How is my training?' },
  ];
  const input = JSON.stringify(history);
  const payload = JSON.parse(buildMessagesRequest(CONFIG(null), { ...REQUEST, messages: history }).body);
  const last = payload.messages.at(-1);
  Array.isArray(last.content) &&
  last.content.length === 1 &&
  last.content[0].type === 'text' &&
  last.content[0].text === 'How is my training?' &&
  last.content[0].cache_control?.type === 'ephemeral' &&
  last.content[0].cache_control?.ttl === '5m'
    ? ok('the latest user message carries a 5-minute breakpoint on its (only) text block')
    : bad('no conversation breakpoint', JSON.stringify(last));
  payload.messages[0].content === 'Earlier question' && payload.messages[1].content === 'Earlier answer'
    ? ok('…and nothing else in the history is marked or reshaped')
    : bad('history touched', JSON.stringify(payload.messages));
  countMarks(payload) === 3
    ? ok('three breakpoints in all (system, last tool, conversation) — inside the API’s four')
    : bad('breakpoint count', String(countMarks(payload)));
  ttlOrder(payload).join(',') === '1h,1h,5m'
    ? ok('rendered 1h, 1h, 5m: no 5-minute entry ahead of an hour-long one')
    : bad('ttl order', ttlOrder(payload).join(','));
  JSON.stringify(stripped(payload.messages)) === input && JSON.stringify(history) === input
    ? ok('minus the marker the history is byte-identical, and the caller’s array is untouched')
    : bad('history changed', JSON.stringify(payload.messages));

  // b. A one-shot call (no client tools) is one request: no write it could read.
  const oneShot = JSON.parse(
    buildMessagesRequest(CONFIG(null), { ...REQUEST, tools: [], messages: history }).body
  );
  oneShot.messages.at(-1).content === 'How is my training?' && countMarks(oneShot) === 1
    ? ok('a one-shot request (no tools) adds no conversation breakpoint')
    : bad('one-shot marked', JSON.stringify(oneShot.messages.at(-1)));

  // c. Across a tool round trip the marker MOVES forward; it never accumulates.
  const fetchImpl = scriptedFetch([
    streamResponse([sseText(toolUseReplyEvents({}))]),
    streamResponse([sseText(textReplyEvents('Training is on track.'))]),
  ]);
  await runCoachTurn(CONFIG(fetchImpl), REQUEST, {
    onToken: () => {},
    executeTool: async () => ({ content: '{"ok":true}' }),
  });
  const second = fetchImpl.calls[1].payload;
  const tail = second.messages.at(-1);
  const echoed = second.messages.at(-2);
  tail.role === 'user' &&
  tail.content.at(-1).type === 'tool_result' &&
  tail.content.at(-1).cache_control?.ttl === '5m' &&
  second.messages[0].content === 'How is my training?' &&
  countMarks(second) === 3
    ? ok('round trip 2: the marker is on the tool_result turn; the first question is plain again')
    : bad('round-trip marker', JSON.stringify(second.messages));
  echoed.role === 'assistant' &&
  echoed.content[0].type === 'thinking' &&
  echoed.content[0].signature === 'sig-abc' &&
  echoed.content.at(-1).type === 'tool_use'
    ? ok('…and the assistant turn between them is echoed as it streamed (thinking included)')
    : bad('assistant echo altered', JSON.stringify(echoed));
  echoed.content.every((b) => !('cache_control' in b))
    ? ok('…carrying no marker: a thinking block can never be given one')
    : bad('assistant block marked');

  // d. A pause_turn resume sends the paused assistant content back UNCHANGED:
  // the marker stays on the latest USER message instead.
  const paused = [
    ...START,
    ...textEvents(0, 'Looking at menus. '),
    ...searchEvents(1, { result: MENU_RESULTS }),
    ...finish('pause_turn', { server_tool_use: { web_search_requests: 1 } }),
  ];
  const resumed = [...START, ...textEvents(0, 'Done.'), ...finish('end_turn')];
  const pauseFetch = scriptedFetch([reply(paused), reply(resumed)]);
  await runCoachTurn(
    { apiKey: 'sk-test', model: 'claude-sonnet-5', fetchImpl: pauseFetch },
    { ...REQUEST, webSearch: { maxUses: 3 } },
    { onToken: () => {}, executeTool: async () => ({ content: '{}' }) }
  );
  const resumeMsgs = pauseFetch.calls[1].payload.messages;
  resumeMsgs.at(-1).role === 'assistant' &&
  resumeMsgs.at(-1).content.every((b) => !('cache_control' in b)) &&
  resumeMsgs[0].content[0].cache_control?.ttl === '5m' &&
  countMarks(pauseFetch.calls[1].payload) === 3
    ? ok('pause_turn: the paused assistant content goes back unmarked; the user turn holds the marker')
    : bad('pause marker', JSON.stringify(resumeMsgs));

  // e. A block that cannot carry a marker is left alone, never guessed at.
  withConversationBreakpoint([{ role: 'user', content: '   ' }])[0].content === '   ' &&
  JSON.stringify(
    withConversationBreakpoint([
      { role: 'user', content: [{ type: 'thinking', thinking: '', signature: 's' }] },
    ])
  ) === JSON.stringify([{ role: 'user', content: [{ type: 'thinking', thinking: '', signature: 's' }] }])
    ? ok('an empty text or a thinking block gets no marker')
    : bad('unmarkable block marked');

  // f. The estimate accounts for the cache: a warm second round trip is
  // priced at the read rate, and the turn's total is the sum of its requests.
  const usage1 = { input_tokens: 1400, cache_read_input_tokens: 9000, cache_creation_input_tokens: 1500, cache_creation: { ephemeral_5m_input_tokens: 1500 } };
  const usage2 = { input_tokens: 120, cache_read_input_tokens: 10_500 };
  const withUsage = (events, usage, out) =>
    events.map((e) =>
      e.data.type === 'message_start'
        ? { ...e, data: { ...e.data, message: { usage } } }
        : e.data.type === 'message_delta'
          ? { ...e, data: { ...e.data, usage: { output_tokens: out } } }
          : e
    );
  const priced = scriptedFetch([
    streamResponse([sseText(withUsage(toolUseReplyEvents({}), usage1, 40))]),
    streamResponse([sseText(withUsage(textReplyEvents('ok'), usage2, 60))]),
  ]);
  const turn = await runCoachTurn(CONFIG(priced), REQUEST, {
    onToken: () => {},
    executeTool: async () => ({ content: '{}' }),
  });
  const r1 = { inputTokens: 1400, outputTokens: 40, cacheReadTokens: 9000, cacheWriteTokens: 1500, cacheWrite5mTokens: 1500 };
  const r2 = { inputTokens: 120, outputTokens: 60, cacheReadTokens: 10_500, cacheWriteTokens: 0 };
  const expected = estimateCost(r1, DEFAULT_MODEL) + estimateCost(r2, DEFAULT_MODEL);
  turn.usage.cacheReadTokens === 19_500 &&
  turn.usage.cacheWrite5mTokens === 1500 &&
  Math.abs(turn.estimatedUsd - expected) < 1e-12
    ? ok('the turn’s estimate sums its requests: cache reads at the read rate, the 5m write at 1.25×')
    : bad('turn cost', JSON.stringify({ usage: turn.usage, usd: turn.estimatedUsd, expected }));
  // Haiku 5.5: two 60k requests are two small-card requests, not one 120k one.
  const h1 = { inputTokens: 60_000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const big = scriptedFetch([
    streamResponse([sseText(withUsage(toolUseReplyEvents({}), { input_tokens: 60_000 }, 10))]),
    streamResponse([sseText(withUsage(textReplyEvents('ok'), { input_tokens: 60_000 }, 10))]),
  ]);
  const haikuTurn = await runCoachTurn(
    { apiKey: 'sk-test', model: 'claude-haiku-5-5', fetchImpl: big, callType: 'chat' },
    REQUEST,
    { onToken: () => {}, executeTool: async () => ({ content: '{}' }) }
  );
  Math.abs(haikuTurn.estimatedUsd - 2 * estimateCost(h1, 'claude-haiku-5-5')) < 1e-12 &&
  haikuTurn.estimatedUsd < estimateCost(haikuTurn.usage, 'claude-haiku-5-5')
    ? ok('Haiku 5.5: a turn is priced request by request — pricing the sum would overstate it')
    : bad('haiku per-request', JSON.stringify(haikuTurn));
}

console.log('25. the usage sink: every billed round trip is reported, and a sink cannot break a call');
{
  const records = [];
  const previous = setModelUsageSink((r) => records.push(r));
  const fetchImpl = scriptedFetch([
    streamResponse([sseText(toolUseReplyEvents({}))]),
    streamResponse([sseText(textReplyEvents('Training is on track.'))]),
  ]);
  // Usage on both replies, so both are billed round trips.
  const billed = (events, input, out) =>
    events.map((e) =>
      e.data.type === 'message_start'
        ? { ...e, data: { ...e.data, message: { usage: { input_tokens: input } } } }
        : e.data.type === 'message_delta'
          ? { ...e, data: { ...e.data, usage: { output_tokens: out } } }
          : e
    );
  const twoTrips = scriptedFetch([
    streamResponse([sseText(billed(toolUseReplyEvents({}), 500, 20))]),
    streamResponse([sseText(billed(textReplyEvents('Fine.'), 700, 30))]),
  ]);
  await runCoachTurn({ ...CONFIG(twoTrips), callType: 'pass' }, REQUEST, {
    onToken: () => {},
    executeTool: async () => ({ content: '{}' }),
  });
  records.length === 2 &&
  records.every((r) => r.callType === 'pass' && r.model === DEFAULT_MODEL) &&
  records[0].usage.inputTokens === 500 &&
  records[1].usage.inputTokens === 700 &&
  Math.abs(records[1].usd - estimateCost(records[1].usage, DEFAULT_MODEL)) < 1e-12
    ? ok('two round trips → two records, each with its OWN usage, call type, model and price')
    : bad('sink records', JSON.stringify(records));
  void fetchImpl;

  // A call site that lost its type at runtime is filed as 'other', not dropped.
  records.length = 0;
  await runCoachTurn(CONFIG(scriptedFetch([streamResponse([sseText(billed(textReplyEvents('x'), 10, 1))])])), { ...REQUEST, tools: [] }, {
    onToken: () => {},
    executeTool: async () => ({ content: '' }),
  });
  records.length === 1 && records[0].callType === 'other'
    ? ok('a call with no call type is recorded under "other", never silently skipped')
    : bad('untyped call', JSON.stringify(records));

  // An HTTP error was not billed: nothing reported.
  records.length = 0;
  try {
    await runCoachTurn(
      { ...CONFIG(scriptedFetch([streamResponse(['{"error":{"type":"invalid_request_error","message":"bad"}}'], { ok: false, status: 400 })])), callType: 'chat' },
      REQUEST,
      { onToken: () => {}, executeTool: async () => ({ content: '' }) }
    );
  } catch {
    // expected
  }
  records.length === 0
    ? ok('a refused request (HTTP 400) reports nothing — it billed nothing')
    : bad('400 reported', JSON.stringify(records));

  // A stream that dies mid-reply WAS billed for what it streamed: reported,
  // and the failure still thrown.
  records.length = 0;
  const dying = {
    ok: true,
    status: 200,
    body: {
      getReader: () => {
        let sent = false;
        return {
          read: async () => {
            if (!sent) {
              sent = true;
              return {
                done: false,
                value: new TextEncoder().encode(
                  sseText([{ event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 900 } } } }])
                ),
              };
            }
            throw new TypeError('The network connection was lost.');
          },
        };
      },
    },
    text: async () => '',
  };
  let thrown = null;
  try {
    await runCoachTurn({ ...CONFIG(async () => dying), callType: 'meal_estimate' }, { ...REQUEST, tools: [] }, {
      onToken: () => {},
      executeTool: async () => ({ content: '' }),
    });
  } catch (error) {
    thrown = error;
  }
  records.length === 1 &&
  records[0].usage.inputTokens === 900 &&
  thrown instanceof ModelRequestError &&
  thrown.status === 0 &&
  thrown.errorType === STREAM_ERROR &&
  thrown.message === 'The network connection was lost.'
    ? ok('a stream that dies mid-reply is reported (it was billed) and fails as a named stream_error')
    : bad('dying stream', JSON.stringify({ records, thrown: String(thrown), type: thrown?.errorType }));

  // A fetch that never got a response is a named network_error, not billed.
  records.length = 0;
  let offline = null;
  try {
    await runCoachTurn(
      { ...CONFIG(async () => Promise.reject(new TypeError('Network request failed'))), callType: 'chat' },
      REQUEST,
      { onToken: () => {}, executeTool: async () => ({ content: '' }) }
    );
  } catch (error) {
    offline = error;
  }
  offline instanceof ModelRequestError &&
  offline.status === 0 &&
  offline.errorType === NETWORK_ERROR &&
  offline.message === 'Network request failed' &&
  records.length === 0
    ? ok('a fetch that rejects becomes ModelRequestError(0, network_error), message kept, nothing reported')
    : bad('network error shape', String(offline));
  // An abort stays an abort.
  const controller = new AbortController();
  let abortErr = null;
  try {
    await runCoachTurn(
      {
        ...CONFIG(async () => {
          controller.abort();
          const e = new Error('aborted');
          e.name = 'AbortError';
          throw e;
        }),
        callType: 'chat',
      },
      REQUEST,
      { onToken: () => {}, executeTool: async () => ({ content: '' }), signal: controller.signal }
    );
  } catch (error) {
    abortErr = error;
  }
  abortErr?.name === 'AbortError' && !(abortErr instanceof ModelRequestError)
    ? ok('…and an abort is still an AbortError, not a network failure')
    : bad('abort wrapped', String(abortErr));

  // THE FAILURE PATH: a sink that throws never fails the call.
  setModelUsageSink(() => {
    throw new Error('ledger is broken');
  });
  const survived = await runCoachTurn(
    { ...CONFIG(scriptedFetch([streamResponse([sseText(billed(textReplyEvents('Still here.'), 10, 2))])])), callType: 'chat' },
    { ...REQUEST, tools: [] },
    { onToken: () => {}, executeTool: async () => ({ content: '' }) }
  );
  survived.text === 'Still here.' && survived.stopReason === 'end_turn'
    ? ok('a sink that throws is swallowed: the call returns its answer')
    : bad('sink broke the call', JSON.stringify(survived));
  setModelUsageSink(previous);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
