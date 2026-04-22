// src/smart-agent/api-adapters/__tests__/openai-adapter.test.ts

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  LlmStreamChunk,
  OrchestratorError,
  Result,
  SmartAgentResponse,
} from '@mcp-abap-adt/llm-agent';
import type {
  ApiRequestContext,
  ApiSseEvent,
} from '../../interfaces/api-adapter.js';
import { AdapterValidationError } from '../../interfaces/api-adapter.js';
import { OpenAiApiAdapter } from '../openai-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(
  overrides?: Partial<ApiRequestContext>,
): ApiRequestContext {
  return {
    adapterName: 'openai',
    protocol: {
      id: 'chatcmpl-test-id',
      created: 1700000000,
      model: 'test-model',
    },
    ...overrides,
  };
}

type ChunkResult = Result<LlmStreamChunk, OrchestratorError>;

async function collectEvents(
  adapter: OpenAiApiAdapter,
  chunks: ChunkResult[],
  ctx: ApiRequestContext,
): Promise<ApiSseEvent[]> {
  async function* source(): AsyncIterable<ChunkResult> {
    for (const c of chunks) yield c;
  }
  const events: ApiSseEvent[] = [];
  for await (const e of adapter.transformStream(source(), ctx)) {
    events.push(e);
  }
  return events;
}

function ok(value: LlmStreamChunk): ChunkResult {
  return { ok: true, value };
}

function err(message: string, code = 'ORCHESTRATOR_ERROR'): ChunkResult {
  const error = new Error(message) as OrchestratorError;
  error.code = code;
  error.name = 'OrchestratorError';
  return { ok: false, error };
}

function parseData(event: ApiSseEvent): unknown {
  if (event.data === '[DONE]') return '[DONE]';
  return JSON.parse(event.data);
}

// ---------------------------------------------------------------------------
// normalizeRequest
// ---------------------------------------------------------------------------

describe('OpenAiApiAdapter.normalizeRequest', () => {
  const adapter = new OpenAiApiAdapter();

  it('parses a valid request with defaults', () => {
    const result = adapter.normalizeRequest({
      messages: [{ role: 'user', content: 'hello' }],
    });

    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].role, 'user');
    assert.equal(result.stream, false);
    assert.ok(result.context.protocol.id);
    assert.match(result.context.protocol.id as string, /^chatcmpl-/);
    assert.equal(typeof result.context.protocol.created, 'number');
    assert.equal(result.context.adapterName, 'openai');
    // Default model
    assert.equal(result.context.protocol.model, 'smart-agent');
  });

  it('extracts tools into options.externalTools', () => {
    const tools = [
      {
        type: 'function',
        function: { name: 'get_weather', parameters: {} },
      },
    ];
    const result = adapter.normalizeRequest({
      messages: [{ role: 'user', content: 'hi' }],
      tools,
    });

    assert.deepEqual(result.options?.externalTools, tools);
  });

  it('extracts model name into context.protocol', () => {
    const result = adapter.normalizeRequest({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'gpt-4o',
    });

    assert.equal(result.context.protocol.model, 'gpt-4o');
    assert.equal(result.options?.model, 'gpt-4o');
  });

  it('extracts temperature, max_tokens, top_p', () => {
    const result = adapter.normalizeRequest({
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      max_tokens: 1000,
      top_p: 0.9,
    });

    assert.equal(result.options?.temperature, 0.7);
    assert.equal(result.options?.maxTokens, 1000);
    assert.equal(result.options?.topP, 0.9);
  });

  it('sets stream: true when requested', () => {
    const result = adapter.normalizeRequest({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });

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
      () => adapter.normalizeRequest({ model: 'gpt-4' }),
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

describe('OpenAiApiAdapter.formatResult', () => {
  const adapter = new OpenAiApiAdapter();
  const ctx = makeContext();

  it('formats a basic response', () => {
    const response: SmartAgentResponse = {
      content: 'Hello!',
      iterations: 1,
      toolCallCount: 0,
      stopReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };

    const result = adapter.formatResult(response, ctx) as Record<
      string,
      unknown
    >;

    assert.equal(result.id, 'chatcmpl-test-id');
    assert.equal(result.object, 'chat.completion');
    assert.equal(result.created, 1700000000);
    assert.equal(result.model, 'test-model');

    const choices = result.choices as Array<Record<string, unknown>>;
    assert.equal(choices.length, 1);
    assert.equal(choices[0].finish_reason, 'stop');

    const message = choices[0].message as Record<string, unknown>;
    assert.equal(message.role, 'assistant');
    assert.equal(message.content, 'Hello!');

    const usage = result.usage as Record<string, number>;
    assert.equal(usage.prompt_tokens, 10);
    assert.equal(usage.completion_tokens, 5);
    assert.equal(usage.total_tokens, 15);
  });

  it('formats a response with tool_calls', () => {
    const response: SmartAgentResponse = {
      content: '',
      iterations: 1,
      toolCallCount: 1,
      stopReason: 'tool_calls',
      toolCalls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
        },
      ],
    };

    const result = adapter.formatResult(response, ctx) as Record<
      string,
      unknown
    >;
    const choices = result.choices as Array<Record<string, unknown>>;
    assert.equal(choices[0].finish_reason, 'tool_calls');

    const message = choices[0].message as Record<string, unknown>;
    assert.equal(message.content, null);
    assert.ok(Array.isArray(message.tool_calls));
  });

  it('maps iteration_limit to length', () => {
    const response: SmartAgentResponse = {
      content: 'partial',
      iterations: 10,
      toolCallCount: 5,
      stopReason: 'iteration_limit',
    };

    const result = adapter.formatResult(response, ctx) as Record<
      string,
      unknown
    >;
    const choices = result.choices as Array<Record<string, unknown>>;
    assert.equal(choices[0].finish_reason, 'length');
  });

  it('defaults usage to zeros when not provided', () => {
    const response: SmartAgentResponse = {
      content: 'ok',
      iterations: 1,
      toolCallCount: 0,
      stopReason: 'stop',
    };

    const result = adapter.formatResult(response, ctx) as Record<
      string,
      unknown
    >;
    const usage = result.usage as Record<string, number>;
    assert.equal(usage.prompt_tokens, 0);
    assert.equal(usage.completion_tokens, 0);
    assert.equal(usage.total_tokens, 0);
  });
});

// ---------------------------------------------------------------------------
// formatError
// ---------------------------------------------------------------------------

describe('OpenAiApiAdapter.formatError', () => {
  const adapter = new OpenAiApiAdapter();
  const ctx = makeContext();

  it('formats an error', () => {
    const error = new Error('Something failed') as OrchestratorError;
    error.code = 'ORCHESTRATOR_ERROR';
    error.name = 'OrchestratorError';

    const result = adapter.formatError(error, ctx) as Record<string, unknown>;
    const inner = result.error as Record<string, unknown>;

    assert.equal(inner.message, 'Something failed');
    assert.equal(inner.type, 'server_error');
    assert.equal(inner.code, 'ORCHESTRATOR_ERROR');
  });
});

// ---------------------------------------------------------------------------
// transformStream
// ---------------------------------------------------------------------------

describe('OpenAiApiAdapter.transformStream', () => {
  const adapter = new OpenAiApiAdapter();
  const ctx = makeContext();

  it('emits correct chunk sequence with [DONE]', async () => {
    const chunks: ChunkResult[] = [
      ok({ content: 'Hello' }),
      ok({ content: ' world' }),
      ok({ content: '', finishReason: 'stop' }),
    ];

    const events = await collectEvents(adapter, chunks, ctx);

    // First chunk has role: 'assistant'
    const first = parseData(events[0]) as Record<string, unknown>;
    const firstChoices = first.choices as Array<Record<string, unknown>>;
    const firstDelta = firstChoices[0].delta as Record<string, unknown>;
    assert.equal(firstDelta.role, 'assistant');
    assert.equal(firstDelta.content, 'Hello');
    assert.equal(firstChoices[0].finish_reason, null);

    // Second chunk — regular content delta
    const second = parseData(events[1]) as Record<string, unknown>;
    const secondChoices = second.choices as Array<Record<string, unknown>>;
    const secondDelta = secondChoices[0].delta as Record<string, unknown>;
    assert.equal(secondDelta.content, ' world');
    assert.equal(secondDelta.role, undefined);

    // Third chunk — finish_reason
    const third = parseData(events[2]) as Record<string, unknown>;
    const thirdChoices = third.choices as Array<Record<string, unknown>>;
    assert.equal(thirdChoices[0].finish_reason, 'stop');

    // Last event is [DONE]
    assert.equal(events[events.length - 1].data, '[DONE]');
  });

  it('skips heartbeat-only chunks', async () => {
    const chunks: ChunkResult[] = [
      ok({ content: 'Hi' }),
      ok({ content: '', heartbeat: { tool: 'search', elapsed: 100 } }),
      ok({ content: '', finishReason: 'stop' }),
    ];

    const events = await collectEvents(adapter, chunks, ctx);

    // Should have: first content, finish_reason, [DONE]
    // Heartbeat is skipped
    assert.equal(events.length, 3);
    assert.equal(events[events.length - 1].data, '[DONE]');
  });

  it('skips timing-only chunks', async () => {
    const chunks: ChunkResult[] = [
      ok({ content: 'Hi' }),
      ok({ content: '', timing: [{ phase: 'llm', duration: 500 }] }),
      ok({ content: '', finishReason: 'stop' }),
    ];

    const events = await collectEvents(adapter, chunks, ctx);
    assert.equal(events.length, 3);
  });

  it('emits usage chunk before [DONE]', async () => {
    const chunks: ChunkResult[] = [
      ok({ content: 'Hi' }),
      ok({
        content: '',
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }),
    ];

    const events = await collectEvents(adapter, chunks, ctx);

    // Last is [DONE]
    assert.equal(events[events.length - 1].data, '[DONE]');

    // Second to last is usage chunk
    const usageEvent = parseData(events[events.length - 2]) as Record<
      string,
      unknown
    >;
    const usage = usageEvent.usage as Record<string, number>;
    assert.equal(usage.prompt_tokens, 10);
    assert.equal(usage.completion_tokens, 5);
    assert.equal(usage.total_tokens, 15);
    assert.deepEqual(usageEvent.choices, []);
  });

  it('handles error chunks with finish_reason stop', async () => {
    const chunks: ChunkResult[] = [ok({ content: 'Start' }), err('LLM failed')];

    const events = await collectEvents(adapter, chunks, ctx);

    // First chunk — content
    const first = parseData(events[0]) as Record<string, unknown>;
    const firstChoices = first.choices as Array<Record<string, unknown>>;
    assert.equal(
      (firstChoices[0].delta as Record<string, unknown>).content,
      'Start',
    );

    // Error chunk has finish_reason: 'stop'
    const errorEvent = parseData(events[1]) as Record<string, unknown>;
    const errorChoices = errorEvent.choices as Array<Record<string, unknown>>;
    assert.equal(errorChoices[0].finish_reason, 'stop');
    assert.ok(
      (
        (errorChoices[0].delta as Record<string, unknown>).content as string
      ).includes('LLM failed'),
    );

    // [DONE] at the end
    assert.equal(events[events.length - 1].data, '[DONE]');
  });

  it('emits tool_calls delta in first chunk', async () => {
    const chunks: ChunkResult[] = [
      ok({
        content: '',
        toolCalls: [{ id: 'call_1', name: 'search', arguments: { q: 'test' } }],
      }),
      ok({ content: '', finishReason: 'tool_calls' }),
    ];

    const events = await collectEvents(adapter, chunks, ctx);

    const first = parseData(events[0]) as Record<string, unknown>;
    const firstChoices = first.choices as Array<Record<string, unknown>>;
    const delta = firstChoices[0].delta as Record<string, unknown>;
    assert.equal(delta.role, 'assistant');
    assert.ok(Array.isArray(delta.tool_calls));

    const tc = (delta.tool_calls as Array<Record<string, unknown>>)[0];
    assert.equal(tc.id, 'call_1');
    assert.equal(tc.type, 'function');
    assert.equal((tc.function as Record<string, unknown>).name, 'search');
  });

  it('ApiSseEvent.event is undefined (no event field for OpenAI)', async () => {
    const chunks: ChunkResult[] = [ok({ content: 'x', finishReason: 'stop' })];

    const events = await collectEvents(adapter, chunks, ctx);
    for (const e of events) {
      assert.equal(e.event, undefined);
    }
  });

  it('emits default finish_reason stop when stream has no finishReason', async () => {
    const chunks: ChunkResult[] = [ok({ content: 'partial' })];

    const events = await collectEvents(adapter, chunks, ctx);

    // Should have: first content, default finish_reason, [DONE]
    assert.equal(events.length, 3);

    const finishEvent = parseData(events[1]) as Record<string, unknown>;
    const choices = finishEvent.choices as Array<Record<string, unknown>>;
    assert.equal(choices[0].finish_reason, 'stop');
  });
});
