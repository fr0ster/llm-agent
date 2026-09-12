import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  gateFor,
  isRateLimitedError,
  type Message,
  resetRateLimitGates,
} from '@mcp-abap-adt/llm-agent';
import { OpenAIProvider } from '../openai-provider.js';

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('OpenAIProvider — constructor', () => {
  it('throws when apiKey is missing', () => {
    assert.throws(
      () => new OpenAIProvider({ apiKey: '' }),
      /API key is required/,
    );
  });

  it('throws when model is missing', () => {
    assert.throws(
      // biome-ignore lint/suspicious/noExplicitAny: intentional missing model for test
      () => new OpenAIProvider({ apiKey: 'sk-test' } as any),
      /model/i,
    );
  });

  it('uses custom model when provided', () => {
    const p = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-4o' });
    assert.equal(p.model, 'gpt-4o');
  });

  it('sets Authorization header', () => {
    const p = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-4o' });
    const headers = p.client.defaults.headers as Record<string, unknown>;
    assert.equal(headers.Authorization, 'Bearer sk-test');
  });

  it('sets OpenAI-Organization header when provided', () => {
    const p = new OpenAIProvider({
      apiKey: 'sk-test',
      model: 'gpt-4o',
      organization: 'org-abc',
    });
    const headers = p.client.defaults.headers as Record<string, unknown>;
    assert.equal(headers['OpenAI-Organization'], 'org-abc');
  });

  it('sets OpenAI-Project header when provided', () => {
    const p = new OpenAIProvider({
      apiKey: 'sk-test',
      model: 'gpt-4o',
      project: 'proj-xyz',
    });
    const headers = p.client.defaults.headers as Record<string, unknown>;
    assert.equal(headers['OpenAI-Project'], 'proj-xyz');
  });

  it('does not set org/project headers when not provided', () => {
    const p = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-4o' });
    const headers = p.client.defaults.headers as Record<string, unknown>;
    assert.equal(headers['OpenAI-Organization'], undefined);
    assert.equal(headers['OpenAI-Project'], undefined);
  });

  it('uses custom baseURL', () => {
    const p = new OpenAIProvider({
      apiKey: 'sk-test',
      model: 'gpt-4o',
      baseURL: 'https://custom.api/v1',
    });
    assert.equal(p.client.defaults.baseURL, 'https://custom.api/v1');
  });
});

// ---------------------------------------------------------------------------
// formatMessages (private — tested via casting to any)
// ---------------------------------------------------------------------------

describe('OpenAIProvider — formatMessages', () => {
  const provider = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-4o' });
  // biome-ignore lint/suspicious/noExplicitAny: access private method for testing
  const fmt = (msgs: Message[]) => (provider as any).formatMessages(msgs);

  it('formats simple user/assistant messages', () => {
    const result = fmt([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]);
    assert.equal(result.length, 2);
    assert.equal(result[0].role, 'user');
    assert.equal(result[0].content, 'Hello');
    assert.equal(result[1].role, 'assistant');
    assert.equal(result[1].content, 'Hi');
  });

  it('skips tool messages without tool_call_id', () => {
    const result = fmt([
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'orphan result' },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'user');
  });

  it('includes tool messages with tool_call_id', () => {
    const result = fmt([
      { role: 'tool', content: 'result', tool_call_id: 'call_1' },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].tool_call_id, 'call_1');
    assert.equal(result[0].content, 'result');
  });

  it('stringifies non-string tool content', () => {
    const result = fmt([
      { role: 'tool', content: null, tool_call_id: 'call_1' },
    ]);
    assert.equal(result[0].content, JSON.stringify(''));
  });

  it('sets content to null for assistant with tool_calls', () => {
    const toolCalls = [
      {
        id: 'call_1',
        type: 'function' as const,
        function: { name: 'test', arguments: '{}' },
      },
    ];
    const result = fmt([
      { role: 'assistant', content: '', tool_calls: toolCalls },
    ]);
    assert.equal(result[0].content, null);
    assert.deepEqual(result[0].tool_calls, toolCalls);
  });

  it('preserves assistant content when present with tool_calls', () => {
    const toolCalls = [
      {
        id: 'call_1',
        type: 'function' as const,
        function: { name: 'test', arguments: '{}' },
      },
    ];
    const result = fmt([
      { role: 'assistant', content: 'Calling tool', tool_calls: toolCalls },
    ]);
    assert.equal(result[0].content, 'Calling tool');
  });

  it('handles null content as empty string for non-tool messages', () => {
    const result = fmt([{ role: 'user', content: null }]);
    assert.equal(result[0].content, '');
  });
});

// ---------------------------------------------------------------------------
// getTokenLimitParam — max_tokens vs max_completion_tokens
// ---------------------------------------------------------------------------

describe('OpenAIProvider — getTokenLimitParam', () => {
  const param = (model: string) => {
    const p = new OpenAIProvider({ apiKey: 'sk-test', model });
    // biome-ignore lint/suspicious/noExplicitAny: access private method for testing
    return (p as any).getTokenLimitParam(model, 1024);
  };

  it('returns max_tokens for gpt-4o', () => {
    assert.deepEqual(param('gpt-4o'), { max_tokens: 1024 });
  });

  it('returns max_tokens for gpt-4o-mini', () => {
    assert.deepEqual(param('gpt-4o-mini'), { max_tokens: 1024 });
  });

  it('returns max_completion_tokens for gpt-5', () => {
    assert.deepEqual(param('gpt-5'), { max_completion_tokens: 1024 });
  });

  it('returns max_completion_tokens for gpt-5.2', () => {
    assert.deepEqual(param('gpt-5.2'), { max_completion_tokens: 1024 });
  });

  it('returns max_completion_tokens for gpt-5-mini', () => {
    assert.deepEqual(param('gpt-5-mini'), { max_completion_tokens: 1024 });
  });

  it('returns max_completion_tokens for o1', () => {
    assert.deepEqual(param('o1'), { max_completion_tokens: 1024 });
  });

  it('returns max_completion_tokens for o1-mini', () => {
    assert.deepEqual(param('o1-mini'), { max_completion_tokens: 1024 });
  });

  it('returns max_completion_tokens for o3', () => {
    assert.deepEqual(param('o3'), { max_completion_tokens: 1024 });
  });

  it('returns max_completion_tokens for o3-mini', () => {
    assert.deepEqual(param('o3-mini'), { max_completion_tokens: 1024 });
  });

  it('handles uppercase model names', () => {
    assert.deepEqual(param('GPT-5.2'), { max_completion_tokens: 1024 });
  });
});

// ---------------------------------------------------------------------------
// chat — error handling
// ---------------------------------------------------------------------------

describe('OpenAIProvider — chat error handling', () => {
  it('wraps API errors with "OpenAI API error:" prefix', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'sk-test',
      model: 'gpt-4o',
      baseURL: 'http://localhost:1',
    });
    await assert.rejects(
      () => provider.chat([{ role: 'user', content: 'hi' }]),
      (err: Error) => {
        assert.ok(err.message.startsWith('OpenAI API error:'));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// streamChat — error handling
// ---------------------------------------------------------------------------

describe('OpenAIProvider — streamChat error handling', () => {
  it('wraps streaming errors with "OpenAI Streaming error:" prefix', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'sk-test',
      model: 'gpt-4o',
      baseURL: 'http://localhost:1',
    });
    await assert.rejects(
      async () => {
        for await (const _chunk of provider.streamChat([
          { role: 'user', content: 'hi' },
        ])) {
          // drain
        }
      },
      (err: Error) => {
        assert.ok(err.message.startsWith('OpenAI Streaming error:'));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// chat() options forwarding
// ---------------------------------------------------------------------------

describe('OpenAIProvider — chat() options forwarding', () => {
  it('uses per-request model override', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      model: 'gpt-4o',
    });
    let capturedBody: Record<string, unknown> = {};
    // @ts-expect-error — stub axios for test
    provider.client.post = async (
      _url: string,
      body: Record<string, unknown>,
    ) => {
      capturedBody = body;
      return {
        data: {
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        },
      };
    };
    await provider.chat([{ role: 'user', content: 'hi' }], undefined, {
      model: 'gpt-5',
      temperature: 0.1,
      maxTokens: 10,
    });
    assert.equal(capturedBody.model, 'gpt-5');
    assert.equal(capturedBody.temperature, 0.1);
    assert.equal(capturedBody.max_completion_tokens, 10);
    assert.equal(capturedBody.max_tokens, undefined);
  });

  it('falls back to config when no options provided', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      model: 'gpt-4o',
      temperature: 0.5,
      maxTokens: 2048,
    });
    let capturedBody: Record<string, unknown> = {};
    // @ts-expect-error — stub axios for test
    provider.client.post = async (
      _url: string,
      body: Record<string, unknown>,
    ) => {
      capturedBody = body;
      return {
        data: {
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        },
      };
    };
    await provider.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(capturedBody.model, 'gpt-4o');
    assert.equal(capturedBody.temperature, 0.5);
    assert.equal(capturedBody.max_tokens, 2048);
  });

  it('forwards topP and stop options', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      model: 'gpt-4o',
    });
    let capturedBody: Record<string, unknown> = {};
    // @ts-expect-error — stub axios for test
    provider.client.post = async (
      _url: string,
      body: Record<string, unknown>,
    ) => {
      capturedBody = body;
      return {
        data: {
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        },
      };
    };
    await provider.chat([{ role: 'user', content: 'hi' }], undefined, {
      topP: 0.9,
      stop: ['\n'],
    });
    assert.equal(capturedBody.top_p, 0.9);
    assert.deepEqual(capturedBody.stop, ['\n']);
  });

  it('does not include topP/stop when not provided', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      model: 'gpt-4o',
    });
    let capturedBody: Record<string, unknown> = {};
    // @ts-expect-error — stub axios for test
    provider.client.post = async (
      _url: string,
      body: Record<string, unknown>,
    ) => {
      capturedBody = body;
      return {
        data: {
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        },
      };
    };
    await provider.chat([{ role: 'user', content: 'hi' }]);
    assert.equal('top_p' in capturedBody, false);
    assert.equal('stop' in capturedBody, false);
  });
});

// ---------------------------------------------------------------------------
// chat() — usage extraction
// ---------------------------------------------------------------------------

describe('OpenAIProvider — chat() usage', () => {
  it('returns usage from response', async () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-4o' });
    // @ts-expect-error — stub axios for test
    provider.client.post = async () => ({
      data: {
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        },
      },
    });
    const result = await provider.chat([{ role: 'user', content: 'hi' }]);
    assert.deepEqual(result.usage, {
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    });
  });

  it('returns undefined usage when not present', async () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-4o' });
    // @ts-expect-error — stub axios for test
    provider.client.post = async () => ({
      data: {
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      },
    });
    const result = await provider.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(result.usage, undefined);
  });
});

// ---------------------------------------------------------------------------
// streamChat() — stream_options and usage chunk
// ---------------------------------------------------------------------------

describe('OpenAIProvider — streamChat() usage', () => {
  it('sends stream_options with include_usage: true', async () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-4o' });
    let capturedBody: Record<string, unknown> = {};
    // @ts-expect-error — stub axios for test
    provider.client.post = async (
      _url: string,
      body: Record<string, unknown>,
    ) => {
      capturedBody = body;
      return {
        data: (async function* () {
          yield Buffer.from('data: [DONE]\n\n');
        })(),
      };
    };
    for await (const _chunk of provider.streamChat([
      { role: 'user', content: 'hi' },
    ])) {
      // drain
    }
    assert.deepEqual(capturedBody.stream_options, { include_usage: true });
  });

  it('forwards tool_calls deltas in normalized form (regression: #119)', async () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-4o' });
    // @ts-expect-error — stub axios for test
    provider.client.post = async () => ({
      data: (async function* () {
        yield Buffer.from(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n\n',
        );
        yield Buffer.from(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]},"finish_reason":null}]}\n\n',
        );
        yield Buffer.from(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Kyiv\\"}"}}]},"finish_reason":null}]}\n\n',
        );
        yield Buffer.from(
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        );
        yield Buffer.from('data: [DONE]\n\n');
      })(),
    });
    const chunks: import('@mcp-abap-adt/llm-agent').LLMResponse[] = [];
    for await (const chunk of provider.streamChat([
      { role: 'user', content: 'hi' },
    ])) {
      chunks.push(chunk);
    }
    const toolChunks = chunks.filter((c) => c.toolCalls);
    assert.equal(toolChunks.length, 3, 'expected 3 chunks carrying toolCalls');
    assert.deepEqual(toolChunks[0].toolCalls, [
      { index: 0, id: 'call_1', name: 'get_weather', arguments: '' },
    ]);
    assert.deepEqual(toolChunks[1].toolCalls, [
      { index: 0, id: undefined, name: undefined, arguments: '{"city":' },
    ]);
    assert.deepEqual(toolChunks[2].toolCalls, [
      { index: 0, id: undefined, name: undefined, arguments: '"Kyiv"}' },
    ]);
  });

  it('yields usage-only chunk at end of stream', async () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-4o' });
    // @ts-expect-error — stub axios for test
    provider.client.post = async () => ({
      data: (async function* () {
        yield Buffer.from(
          'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
        );
        yield Buffer.from(
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        );
        yield Buffer.from(
          'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n',
        );
        yield Buffer.from('data: [DONE]\n\n');
      })(),
    });
    const chunks: import('@mcp-abap-adt/llm-agent').LLMResponse[] = [];
    for await (const chunk of provider.streamChat([
      { role: 'user', content: 'hi' },
    ])) {
      chunks.push(chunk);
    }
    const usageChunk = chunks.find((c) => c.usage !== undefined);
    assert.ok(usageChunk, 'expected a chunk with usage');
    assert.deepEqual(usageChunk.usage, {
      promptTokens: 5,
      completionTokens: 1,
      totalTokens: 6,
    });
  });
});

// ---------------------------------------------------------------------------
// Rate limiting (issue #282)
// ---------------------------------------------------------------------------

const tooManyRequests = (retryAfter?: string) =>
  Object.assign(new Error('Request failed with status code 429'), {
    isAxiosError: true,
    response: {
      status: 429,
      headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
      data: { error: { message: 'rate limit exceeded' } },
    },
  });

describe('OpenAIProvider — rate limiting', () => {
  const fast = { baseDelayMs: 1, maxDelayMs: 2 };

  it('retries a 429 and returns the eventual answer', async () => {
    resetRateLimitGates();
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      model: 'gpt-4o',
      rateLimit: fast,
    });
    let calls = 0;
    // @ts-expect-error — stub axios for test
    provider.client.post = async () => {
      calls += 1;
      if (calls < 3) throw tooManyRequests();
      return {
        data: {
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        },
      };
    };
    const res = await provider.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(res.content, 'ok');
    assert.equal(calls, 3);
  });

  it('keeps the 429 readable as a fact once it gives up', async () => {
    resetRateLimitGates();
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      model: 'gpt-4o',
      rateLimit: { ...fast, maxAttempts: 2 },
    });
    // @ts-expect-error — stub axios for test
    provider.client.post = async () => {
      throw tooManyRequests('3');
    };
    try {
      await provider.chat([{ role: 'user', content: 'hi' }]);
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(isRateLimitedError(e));
      assert.equal(e.attempts, 2);
      assert.equal(e.retryAfterSeconds, 3);
      assert.match((e as Error).message, /OpenAI API error/);
    }
  });

  it('does not retry an ordinary failure', async () => {
    resetRateLimitGates();
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      model: 'gpt-4o',
      rateLimit: fast,
    });
    let calls = 0;
    // @ts-expect-error — stub axios for test
    provider.client.post = async () => {
      calls += 1;
      throw Object.assign(new Error('server exploded'), {
        isAxiosError: true,
        response: { status: 500, headers: {}, data: {} },
      });
    };
    await assert.rejects(
      provider.chat([{ role: 'user', content: 'hi' }]),
      /server exploded/,
    );
    assert.equal(calls, 1);
  });

  it('passes a 429 straight through when the policy is disabled', async () => {
    resetRateLimitGates();
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      model: 'gpt-4o',
      rateLimit: { enabled: false },
    });
    let calls = 0;
    // @ts-expect-error — stub axios for test
    provider.client.post = async () => {
      calls += 1;
      throw tooManyRequests();
    };
    await assert.rejects(provider.chat([{ role: 'user', content: 'hi' }]));
    assert.equal(calls, 1);
  });
});

describe('OpenAIProvider — the quota a per-request model spends', () => {
  it('gates an override model apart from the configured one', async () => {
    resetRateLimitGates();
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      model: 'gpt-4o',
      rateLimit: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 2 },
    });
    // @ts-expect-error — stub axios for test
    provider.client.post = async () => {
      throw tooManyRequests('5');
    };
    await assert.rejects(
      provider.chat([{ role: 'user', content: 'hi' }], undefined, {
        model: 'gpt-5',
      }),
    );
    const keyOf = (m: string) =>
      // @ts-expect-error — protected hook, read for test
      provider.rateLimitKey(m) as string;
    assert.ok(
      gateFor(keyOf('gpt-5')).remaining() > 0,
      'the throttled model is held',
    );
    assert.equal(
      gateFor(keyOf('gpt-4o')).remaining(),
      0,
      'a model that was never called must not be held',
    );
  });
});

describe('OpenAIProvider — one quota per account and endpoint', () => {
  // @ts-expect-error — protected hook, read for test
  const keyOf = (p: OpenAIProvider) => p.rateLimitKey() as string;

  it('separates two API keys on the same endpoint', () => {
    const a = new OpenAIProvider({ apiKey: 'sk-a', model: 'gpt-4o' });
    const b = new OpenAIProvider({ apiKey: 'sk-b', model: 'gpt-4o' });
    assert.notEqual(keyOf(a), keyOf(b));
  });

  it('separates two endpoints on the same key', () => {
    const a = new OpenAIProvider({
      apiKey: 'sk-a',
      model: 'gpt-4o',
      baseURL: 'https://api.openai.com/v1',
    });
    const b = new OpenAIProvider({
      apiKey: 'sk-a',
      model: 'gpt-4o',
      baseURL: 'https://my-gateway.internal/v1',
    });
    assert.notEqual(keyOf(a), keyOf(b));
  });

  it('separates organizations and projects, which is how OpenAI meters', () => {
    const base = { apiKey: 'sk-a', model: 'gpt-4o' };
    const one = new OpenAIProvider({ ...base, organization: 'org-1' });
    const two = new OpenAIProvider({ ...base, organization: 'org-2' });
    const proj = new OpenAIProvider({
      ...base,
      organization: 'org-1',
      project: 'p',
    });
    assert.notEqual(keyOf(one), keyOf(two));
    assert.notEqual(keyOf(one), keyOf(proj));
  });

  it('treats an omitted endpoint and the explicit default as one quota', () => {
    const implicit = new OpenAIProvider({ apiKey: 'sk-a', model: 'gpt-4o' });
    const explicit = new OpenAIProvider({
      apiKey: 'sk-a',
      model: 'gpt-4o',
      baseURL: 'https://api.openai.com/v1',
    });
    assert.equal(
      keyOf(implicit),
      keyOf(explicit),
      'the same server metered as two quotas would stop coordinating',
    );
  });

  it('gives the same account the same key, so the pause is actually shared', () => {
    const a = new OpenAIProvider({ apiKey: 'sk-a', model: 'gpt-4o' });
    const b = new OpenAIProvider({ apiKey: 'sk-a', model: 'gpt-4o' });
    assert.equal(keyOf(a), keyOf(b));
  });

  it('never puts the credential itself in the key', () => {
    const p = new OpenAIProvider({
      apiKey: 'sk-secret-value',
      model: 'gpt-4o',
    });
    assert.ok(!keyOf(p).includes('sk-secret-value'));
  });
});
