// src/smart-agent/api-adapters/__tests__/anthropic-adapter.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AdapterValidationError } from '../../interfaces/api-adapter.js';
import { AnthropicApiAdapter } from '../anthropic-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeContext(overrides) {
  return {
    adapterName: 'anthropic',
    protocol: {
      id: 'msg_test-id',
      model: 'test-model',
    },
    ...overrides,
  };
}
async function collectEvents(adapter, chunks, ctx) {
  async function* source() {
    for (const c of chunks) yield c;
  }
  const events = [];
  for await (const e of adapter.transformStream(source(), ctx)) {
    events.push(e);
  }
  return events;
}
function ok(value) {
  return { ok: true, value };
}
function err(message, code = 'ORCHESTRATOR_ERROR') {
  const error = new Error(message);
  error.code = code;
  error.name = 'OrchestratorError';
  return { ok: false, error };
}
function parseData(event) {
  return JSON.parse(event.data);
}
// ---------------------------------------------------------------------------
// normalizeRequest
// ---------------------------------------------------------------------------
describe('AnthropicApiAdapter.normalizeRequest', () => {
  const adapter = new AnthropicApiAdapter();
  it('parses a basic request', () => {
    const result = adapter.normalizeRequest({
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].role, 'user');
    assert.equal(result.messages[0].content, 'hello');
    assert.equal(result.stream, false);
    assert.ok(result.context.protocol.id);
    assert.match(result.context.protocol.id, /^msg_/);
    assert.equal(result.context.adapterName, 'anthropic');
    assert.equal(result.context.protocol.model, 'smart-agent');
  });
  it('extracts system string as system message', () => {
    const result = adapter.normalizeRequest({
      messages: [{ role: 'user', content: 'hi' }],
      system: 'You are a helpful assistant.',
    });
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0].role, 'system');
    assert.equal(result.messages[0].content, 'You are a helpful assistant.');
    assert.equal(result.messages[1].role, 'user');
  });
  it('extracts system content blocks as system message', () => {
    const result = adapter.normalizeRequest({
      messages: [{ role: 'user', content: 'hi' }],
      system: [
        { type: 'text', text: 'First instruction.' },
        { type: 'text', text: 'Second instruction.' },
      ],
    });
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0].role, 'system');
    assert.equal(
      result.messages[0].content,
      'First instruction.\nSecond instruction.',
    );
  });
  it('handles user content blocks with text', () => {
    const result = adapter.normalizeRequest({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Part one.' },
            { type: 'text', text: 'Part two.' },
          ],
        },
      ],
    });
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].role, 'user');
    assert.equal(result.messages[0].content, 'Part one.\nPart two.');
  });
  it('converts tool_result blocks to tool messages', () => {
    const result = adapter.normalizeRequest({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_123',
              content: 'Result data',
            },
            { type: 'text', text: 'Continue please.' },
          ],
        },
      ],
    });
    assert.equal(result.messages.length, 2);
    // tool_result becomes a tool message
    assert.equal(result.messages[0].role, 'tool');
    assert.equal(result.messages[0].tool_call_id, 'toolu_123');
    assert.equal(result.messages[0].content, 'Result data');
    // text becomes a user message
    assert.equal(result.messages[1].role, 'user');
    assert.equal(result.messages[1].content, 'Continue please.');
  });
  it('converts assistant tool_use blocks', () => {
    const result = adapter.normalizeRequest({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check.' },
            {
              type: 'tool_use',
              id: 'toolu_456',
              name: 'get_weather',
              input: { city: 'NYC' },
            },
          ],
        },
      ],
    });
    assert.equal(result.messages.length, 1);
    const msg = result.messages[0];
    assert.equal(msg.role, 'assistant');
    assert.equal(msg.content, 'Let me check.');
    assert.ok(msg.tool_calls);
    assert.equal(msg.tool_calls?.length, 1);
    assert.equal(msg.tool_calls?.[0].id, 'toolu_456');
    assert.equal(msg.tool_calls?.[0].type, 'function');
    assert.equal(msg.tool_calls?.[0].function.name, 'get_weather');
    assert.equal(
      msg.tool_calls?.[0].function.arguments,
      JSON.stringify({ city: 'NYC' }),
    );
  });
  it('extracts tools into options.externalTools', () => {
    const tools = [
      {
        name: 'get_weather',
        description: 'Get weather',
        input_schema: { type: 'object' },
      },
    ];
    const result = adapter.normalizeRequest({
      messages: [{ role: 'user', content: 'hi' }],
      tools,
    });
    assert.deepEqual(result.options?.externalTools, tools);
  });
  it('extracts model and options', () => {
    const result = adapter.normalizeRequest({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-sonnet-4-20250514',
      temperature: 0.5,
      max_tokens: 2048,
      top_p: 0.9,
      stream: true,
    });
    assert.equal(result.context.protocol.model, 'claude-sonnet-4-20250514');
    assert.equal(result.options?.model, 'claude-sonnet-4-20250514');
    assert.equal(result.options?.temperature, 0.5);
    assert.equal(result.options?.maxTokens, 2048);
    assert.equal(result.options?.topP, 0.9);
    assert.equal(result.stream, true);
  });
  it('throws AdapterValidationError for non-object body', () => {
    assert.throws(
      () => adapter.normalizeRequest('not an object'),
      AdapterValidationError,
    );
  });
  it('throws AdapterValidationError for null body', () => {
    assert.throws(() => adapter.normalizeRequest(null), AdapterValidationError);
  });
  it('throws AdapterValidationError when messages is missing', () => {
    assert.throws(
      () => adapter.normalizeRequest({ model: 'claude-sonnet-4-20250514' }),
      AdapterValidationError,
    );
  });
  it('throws AdapterValidationError when messages is empty', () => {
    assert.throws(
      () => adapter.normalizeRequest({ messages: [] }),
      AdapterValidationError,
    );
  });
});
// ---------------------------------------------------------------------------
// formatResult
// ---------------------------------------------------------------------------
describe('AnthropicApiAdapter.formatResult', () => {
  const adapter = new AnthropicApiAdapter();
  const ctx = makeContext();
  it('formats a text response', () => {
    const response = {
      content: 'Hello!',
      iterations: 1,
      toolCallCount: 0,
      stopReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
    const result = adapter.formatResult(response, ctx);
    assert.equal(result.id, 'msg_test-id');
    assert.equal(result.type, 'message');
    assert.equal(result.role, 'assistant');
    assert.equal(result.model, 'test-model');
    assert.equal(result.stop_reason, 'end_turn');
    const content = result.content;
    assert.equal(content.length, 1);
    assert.equal(content[0].type, 'text');
    assert.equal(content[0].text, 'Hello!');
    const usage = result.usage;
    assert.equal(usage.input_tokens, 10);
    assert.equal(usage.output_tokens, 5);
  });
  it('formats a response with tool_use', () => {
    const response = {
      content: 'Let me check.',
      iterations: 1,
      toolCallCount: 1,
      stopReason: 'tool_calls',
      toolCalls: [
        {
          id: 'toolu_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
        },
      ],
    };
    const result = adapter.formatResult(response, ctx);
    assert.equal(result.stop_reason, 'tool_use');
    const content = result.content;
    assert.equal(content.length, 2);
    assert.equal(content[0].type, 'text');
    assert.equal(content[0].text, 'Let me check.');
    assert.equal(content[1].type, 'tool_use');
    assert.equal(content[1].id, 'toolu_1');
    assert.equal(content[1].name, 'get_weather');
    assert.deepEqual(content[1].input, { city: 'NYC' });
  });
  it('maps iteration_limit to max_tokens', () => {
    const response = {
      content: 'partial',
      iterations: 10,
      toolCallCount: 5,
      stopReason: 'iteration_limit',
    };
    const result = adapter.formatResult(response, ctx);
    assert.equal(result.stop_reason, 'max_tokens');
  });
  it('defaults usage to zeros when not provided', () => {
    const response = {
      content: 'ok',
      iterations: 1,
      toolCallCount: 0,
      stopReason: 'stop',
    };
    const result = adapter.formatResult(response, ctx);
    const usage = result.usage;
    assert.equal(usage.input_tokens, 0);
    assert.equal(usage.output_tokens, 0);
  });
});
// ---------------------------------------------------------------------------
// formatError
// ---------------------------------------------------------------------------
describe('AnthropicApiAdapter.formatError', () => {
  const adapter = new AnthropicApiAdapter();
  const ctx = makeContext();
  it('formats an error in Anthropic format', () => {
    const error = new Error('Something failed');
    error.code = 'ORCHESTRATOR_ERROR';
    error.name = 'OrchestratorError';
    const result = adapter.formatError(error, ctx);
    assert.equal(result.type, 'error');
    const inner = result.error;
    assert.equal(inner.type, 'api_error');
    assert.equal(inner.message, 'Something failed');
  });
});
// ---------------------------------------------------------------------------
// transformStream
// ---------------------------------------------------------------------------
describe('AnthropicApiAdapter.transformStream', () => {
  const adapter = new AnthropicApiAdapter();
  const ctx = makeContext();
  it('emits correct event sequence for text content', async () => {
    const chunks = [
      ok({ content: 'Hello' }),
      ok({ content: ' world' }),
      ok({ content: '', finishReason: 'stop' }),
    ];
    const events = await collectEvents(adapter, chunks, ctx);
    // message_start
    assert.equal(events[0].event, 'message_start');
    const msgStart = parseData(events[0]);
    assert.equal(msgStart.type, 'message_start');
    const message = msgStart.message;
    assert.equal(message.id, 'msg_test-id');
    assert.equal(message.role, 'assistant');
    // content_block_start (text)
    assert.equal(events[1].event, 'content_block_start');
    const blockStart = parseData(events[1]);
    assert.equal(blockStart.index, 0);
    assert.equal(blockStart.content_block.type, 'text');
    // content_block_delta "Hello"
    assert.equal(events[2].event, 'content_block_delta');
    const delta1 = parseData(events[2]);
    assert.equal(delta1.delta.type, 'text_delta');
    assert.equal(delta1.delta.text, 'Hello');
    // content_block_delta " world"
    assert.equal(events[3].event, 'content_block_delta');
    const delta2 = parseData(events[3]);
    assert.equal(delta2.delta.text, ' world');
    // content_block_stop
    assert.equal(events[4].event, 'content_block_stop');
    // message_delta with stop_reason
    assert.equal(events[5].event, 'message_delta');
    const msgDelta = parseData(events[5]);
    assert.equal(msgDelta.delta.stop_reason, 'end_turn');
    // message_stop
    assert.equal(events[6].event, 'message_stop');
    assert.equal(events.length, 7);
  });
  it('skips heartbeat-only chunks', async () => {
    const chunks = [
      ok({ content: 'Hi' }),
      ok({ content: '', heartbeat: { tool: 'search', elapsed: 100 } }),
      ok({ content: '', finishReason: 'stop' }),
    ];
    const events = await collectEvents(adapter, chunks, ctx);
    // Should have: message_start, block_start, text_delta, block_stop, message_delta, message_stop
    assert.equal(events.length, 6);
    // No heartbeat events
    for (const e of events) {
      const data = parseData(e);
      assert.notEqual(data.type, 'heartbeat');
    }
  });
  it('skips timing-only chunks', async () => {
    const chunks = [
      ok({ content: 'Hi' }),
      ok({ content: '', timing: [{ phase: 'llm', duration: 500 }] }),
      ok({ content: '', finishReason: 'stop' }),
    ];
    const events = await collectEvents(adapter, chunks, ctx);
    assert.equal(events.length, 6);
  });
  it('emits tool_use blocks correctly', async () => {
    const chunks = [
      ok({ content: 'Let me search.' }),
      ok({
        content: '',
        toolCalls: [
          { id: 'toolu_1', name: 'search', arguments: { q: 'test' } },
        ],
      }),
      ok({ content: '', finishReason: 'tool_calls' }),
    ];
    const events = await collectEvents(adapter, chunks, ctx);
    // message_start
    assert.equal(events[0].event, 'message_start');
    // text block: start, delta, stop
    assert.equal(events[1].event, 'content_block_start');
    const textBlock = parseData(events[1]);
    assert.equal(textBlock.content_block.type, 'text');
    assert.equal(events[2].event, 'content_block_delta');
    assert.equal(events[3].event, 'content_block_stop');
    // tool_use block: start, delta (input_json), stop
    assert.equal(events[4].event, 'content_block_start');
    const toolBlock = parseData(events[4]);
    assert.equal(toolBlock.content_block.type, 'tool_use');
    assert.equal(toolBlock.content_block.id, 'toolu_1');
    assert.equal(toolBlock.content_block.name, 'search');
    assert.equal(events[5].event, 'content_block_delta');
    const inputDelta = parseData(events[5]);
    assert.equal(inputDelta.delta.type, 'input_json_delta');
    assert.equal(inputDelta.delta.partial_json, JSON.stringify({ q: 'test' }));
    assert.equal(events[6].event, 'content_block_stop');
    // message_delta + message_stop
    assert.equal(events[7].event, 'message_delta');
    const msgDelta = parseData(events[7]);
    assert.equal(msgDelta.delta.stop_reason, 'tool_use');
    assert.equal(events[8].event, 'message_stop');
  });
  it('handles error chunks with closing events', async () => {
    const chunks = [ok({ content: 'Start' }), err('LLM failed')];
    const events = await collectEvents(adapter, chunks, ctx);
    // message_start, block_start, text_delta "Start", block_stop, message_delta, message_stop
    assert.equal(events[0].event, 'message_start');
    assert.equal(events[1].event, 'content_block_start');
    assert.equal(events[2].event, 'content_block_delta');
    assert.equal(events[3].event, 'content_block_stop');
    assert.equal(events[4].event, 'message_delta');
    assert.equal(events[5].event, 'message_stop');
    assert.equal(events.length, 6);
  });
  it('emits closing events when stream ends without finishReason', async () => {
    const chunks = [ok({ content: 'partial' })];
    const events = await collectEvents(adapter, chunks, ctx);
    // message_start, block_start, text_delta, block_stop, message_delta, message_stop
    assert.equal(events.length, 6);
    assert.equal(events[4].event, 'message_delta');
    const msgDelta = parseData(events[4]);
    assert.equal(msgDelta.delta.stop_reason, 'end_turn');
    assert.equal(events[5].event, 'message_stop');
  });
  it('includes usage in message_delta', async () => {
    const chunks = [
      ok({ content: 'Hi' }),
      ok({
        content: '',
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }),
    ];
    const events = await collectEvents(adapter, chunks, ctx);
    // Find message_delta event
    const msgDeltaEvent = events.find((e) => e.event === 'message_delta');
    assert.ok(msgDeltaEvent);
    const msgDelta = parseData(msgDeltaEvent);
    const usage = msgDelta.usage;
    assert.equal(usage.input_tokens, 10);
    assert.equal(usage.output_tokens, 5);
  });
  it('all events have event field set (Anthropic protocol)', async () => {
    const chunks = [ok({ content: 'x', finishReason: 'stop' })];
    const events = await collectEvents(adapter, chunks, ctx);
    for (const e of events) {
      assert.ok(e.event, `Expected event field to be set, got: ${e.event}`);
    }
  });
});
//# sourceMappingURL=anthropic-adapter.test.js.map
