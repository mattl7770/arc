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
  CoachTurnError,
  DEFAULT_MODEL,
  MessageAccumulator,
  ModelRequestError,
  SseParser,
  buildMessagesRequest,
  runCoachTurn,
} from '../src/lib/ai/model-client.ts';

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
  payload.system === 'You are the Coach.' &&
  payload.tools.length === 1
    ? ok('model/stream/max_tokens/system/tools in the body')
    : bad('payload', body);
  !('temperature' in payload) && !('thinking' in payload) && !('top_p' in payload)
    ? ok('no temperature/top_p/thinking (current models reject or default them)')
    : bad('forbidden params present');
  const bare = buildMessagesRequest(CONFIG(null), { ...REQUEST, tools: [] });
  !('tools' in JSON.parse(bare.body))
    ? ok('an empty tool set omits the tools key entirely')
    : bad('empty tools sent');
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
  result.text === 'Checking.\n\nTraining is trending up 12%.'
    ? ok('preamble + separator + final answer')
    : bad('text', JSON.stringify(result.text));
  tokens.join('') === result.text
    ? ok('streamed tokens equal the final text')
    : bad('token parity');
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
    executeTool: async () => ({ content: 'The user declined this action.', declined: true }),
  });
  const declinedBlock = fetchImpl2.calls[1].payload.messages.at(-1).content[0];
  declined.toolCalls[0].declined === true && declinedBlock.is_error === undefined
    ? ok('a decline is recorded but NOT an error (the model must not retry)')
    : bad('declined', JSON.stringify(declined.toolCalls));
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
