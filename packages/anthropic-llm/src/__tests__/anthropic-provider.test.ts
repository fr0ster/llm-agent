import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Message, resetRateLimitGates } from '@mcp-abap-adt/llm-agent';
import { AnthropicProvider } from '../anthropic-provider.js';

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('AnthropicProvider — constructor', () => {
  it('throws when apiKey is missing', () => {
    assert.throws(
      () =>
        new AnthropicProvider({
          apiKey: '',
          model: 'claude-3-5-sonnet-20241022',
        }),
      /API key is required/,
    );
  });

  it('throws when model is missing', () => {
    assert.throws(
      // biome-ignore lint/suspicious/noExplicitAny: intentional missing model for test
      () => new AnthropicProvider({ apiKey: 'sk-test' } as any),
      /model/i,
    );
  });

  it('uses custom model when provided', () => {
    const p = new AnthropicProvider({
      apiKey: 'sk-test',
      model: 'claude-3-opus-20240229',
    });
    assert.equal(p.model, 'claude-3-opus-20240229');
  });

  it('sets x-api-key header', () => {
    const p = new AnthropicProvider({
      apiKey: 'sk-ant-test',
      model: 'claude-3-5-sonnet-20241022',
    });
    const headers = p.client.defaults.headers as Record<string, unknown>;
    assert.equal(headers['x-api-key'], 'sk-ant-test');
  });

  it('sets anthropic-version header', () => {
    const p = new AnthropicProvider({
      apiKey: 'sk-test',
      model: 'claude-3-5-sonnet-20241022',
    });
    const headers = p.client.defaults.headers as Record<string, unknown>;
    assert.equal(headers['anthropic-version'], '2023-06-01');
  });

  it('uses default baseURL', () => {
    const p = new AnthropicProvider({
      apiKey: 'sk-test',
      model: 'claude-3-5-sonnet-20241022',
    });
    assert.equal(p.client.defaults.baseURL, 'https://api.anthropic.com/v1');
  });

  it('uses custom baseURL', () => {
    const p = new AnthropicProvider({
      apiKey: 'sk-test',
      model: 'claude-3-5-sonnet-20241022',
      baseURL: 'https://proxy.example.com/v1',
    });
    assert.equal(p.client.defaults.baseURL, 'https://proxy.example.com/v1');
  });
});

// ---------------------------------------------------------------------------
// formatMessages (private — tested via casting to any)
// ---------------------------------------------------------------------------

describe('AnthropicProvider — formatMessages', () => {
  const provider = new AnthropicProvider({
    apiKey: 'sk-test',
    model: 'claude-3-5-sonnet-20241022',
  });
  // biome-ignore lint/suspicious/noExplicitAny: access private method for testing
  const fmt = (msgs: Message[]) => (provider as any).formatMessages(msgs);

  it('maps user messages to user role', () => {
    const result = fmt([{ role: 'user', content: 'Hello' }]);
    assert.equal(result[0].role, 'user');
    assert.equal(result[0].content, 'Hello');
  });

  it('maps assistant messages to assistant role', () => {
    const result = fmt([{ role: 'assistant', content: 'Hi' }]);
    assert.equal(result[0].role, 'assistant');
  });

  it('maps tool messages to user role', () => {
    const result = fmt([
      { role: 'tool', content: 'result', tool_call_id: 'call_1' },
    ]);
    assert.equal(result[0].role, 'user');
  });

  it('maps system messages to user role (non-assistant fallback)', () => {
    const result = fmt([{ role: 'system', content: 'You are helpful' }]);
    assert.equal(result[0].role, 'user');
  });
});

// ---------------------------------------------------------------------------
// chat — error handling
// ---------------------------------------------------------------------------

describe('AnthropicProvider — chat error handling', () => {
  it('wraps API errors with "Anthropic API error:" prefix', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'sk-test',
      model: 'claude-3-5-sonnet-20241022',
      baseURL: 'http://localhost:1',
    });
    await assert.rejects(
      () => provider.chat([{ role: 'user', content: 'hi' }]),
      (err: Error) => {
        assert.ok(err.message.startsWith('Anthropic API error:'));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// chat() — options forwarding
// ---------------------------------------------------------------------------

describe('AnthropicProvider — chat() options forwarding', () => {
  it('uses per-request overrides', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-3-5-sonnet-20241022',
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
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
        },
      };
    };
    await provider.chat([{ role: 'user', content: 'hi' }], undefined, {
      model: 'claude-4-sonnet',
      temperature: 0.1,
      maxTokens: 10,
    });
    assert.equal(capturedBody.model, 'claude-4-sonnet');
    assert.equal(capturedBody.temperature, 0.1);
    assert.equal(capturedBody.max_tokens, 10);
  });

  it('forwards tools to the request body', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-3-5-sonnet-20241022',
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
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
        },
      };
    };
    const tools = [{ name: 'get_weather', description: 'Get weather' }];
    await provider.chat([{ role: 'user', content: 'hi' }], tools);
    assert.deepEqual(capturedBody.tools, tools);
  });

  it('forwards topP and stop options', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-3-5-sonnet-20241022',
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
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
        },
      };
    };
    await provider.chat([{ role: 'user', content: 'hi' }], undefined, {
      topP: 0.9,
      stop: ['END'],
    });
    assert.equal(capturedBody.top_p, 0.9);
    assert.deepEqual(capturedBody.stop_sequences, ['END']);
  });

  it('handles multi-block response (text + tool_use)', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-3-5-sonnet-20241022',
    });
    // @ts-expect-error — stub axios for test
    provider.client.post = async () => ({
      data: {
        content: [
          { type: 'text', text: 'Sure, let me ' },
          { type: 'text', text: 'check that.' },
          { type: 'tool_use', id: 'call_1', name: 'search', input: {} },
        ],
        stop_reason: 'tool_use',
      },
    });
    const result = await provider.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(result.content, 'Sure, let me check that.');
    assert.equal(result.finishReason, 'tool_use');
  });

  it('extracts system message from messages array', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-3-5-sonnet-20241022',
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
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
        },
      };
    };
    await provider.chat([
      { role: 'system', content: 'You are a bot' },
      { role: 'user', content: 'hi' },
    ]);
    assert.equal(capturedBody.system, 'You are a bot');
    const msgs = capturedBody.messages as Array<{ role: string }>;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, 'user');
  });
});

// ---------------------------------------------------------------------------
// streamChat — is callable (real streaming requires network)
// ---------------------------------------------------------------------------

describe('AnthropicProvider — streamChat', () => {
  it('is a callable function (no longer throws)', () => {
    const provider = new AnthropicProvider({
      apiKey: 'sk-test',
      model: 'claude-3-5-sonnet-20241022',
    });
    assert.equal(typeof provider.streamChat, 'function');
  });
});

// ---------------------------------------------------------------------------
// chat() — usage extraction
// ---------------------------------------------------------------------------

describe('AnthropicProvider — chat() usage', () => {
  it('returns usage from response', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'sk-test',
      model: 'claude-3-5-sonnet-20241022',
    });
    // @ts-expect-error — stub axios for test
    provider.client.post = async () => ({
      data: {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 15,
          output_tokens: 25,
        },
      },
    });
    const result = await provider.chat([{ role: 'user', content: 'hi' }]);
    assert.deepEqual(result.usage, {
      promptTokens: 15,
      completionTokens: 25,
      totalTokens: 40,
    });
  });
});

// ---------------------------------------------------------------------------
// Rate limiting (issue #282)
// ---------------------------------------------------------------------------

describe('AnthropicProvider — rate limiting', () => {
  const fast = { baseDelayMs: 1, maxDelayMs: 2 };

  it('retries a 429 on chat() and returns the eventual answer', async () => {
    resetRateLimitGates();
    const provider = new AnthropicProvider({
      apiKey: 'sk-test',
      model: 'claude-3-5-sonnet-20241022',
      rateLimit: fast,
    });
    let calls = 0;
    // @ts-expect-error — stub axios for test
    provider.client.post = async () => {
      calls += 1;
      if (calls < 2) {
        throw Object.assign(new Error('429'), {
          isAxiosError: true,
          response: { status: 429, headers: {}, data: {} },
        });
      }
      return {
        data: {
          content: [{ type: 'text', text: 'hello' }],
          stop_reason: 'end_turn',
        },
      };
    };
    const res = await provider.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(res.content, 'hello');
    assert.equal(calls, 2);
  });

  it('retries a 429 on the streaming path, which runs on fetch', async () => {
    resetRateLimitGates();
    const provider = new AnthropicProvider({
      apiKey: 'sk-test',
      model: 'claude-3-5-sonnet-20241022',
      rateLimit: fast,
    });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls < 2) {
        return new Response('slow down', {
          status: 429,
          headers: { 'retry-after': '0.01' },
        });
      }
      const body = [
        'event: content_block_delta',
        'data: {"delta":{"type":"text_delta","text":"hi"}}',
        '',
        '',
      ].join('\n');
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    try {
      const chunks: string[] = [];
      for await (const c of provider.streamChat([
        { role: 'user', content: 'hi' },
      ])) {
        if (c.content) chunks.push(c.content);
      }
      assert.deepEqual(chunks, ['hi']);
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('AnthropicProvider — one quota per account and endpoint', () => {
  // @ts-expect-error — protected hook, read for test
  const keyOf = (p: AnthropicProvider) => p.rateLimitKey() as string;
  const model = 'claude-3-5-sonnet-20241022';

  it('treats an omitted endpoint and the explicit default as one quota', () => {
    const implicit = new AnthropicProvider({ apiKey: 'sk-a', model });
    const explicit = new AnthropicProvider({
      apiKey: 'sk-a',
      model,
      baseURL: 'https://api.anthropic.com/v1',
    });
    assert.equal(keyOf(implicit), keyOf(explicit));
  });

  it('separates two API keys', () => {
    assert.notEqual(
      keyOf(new AnthropicProvider({ apiKey: 'sk-a', model })),
      keyOf(new AnthropicProvider({ apiKey: 'sk-b', model })),
    );
  });

  it('never puts the credential itself in the key', () => {
    const p = new AnthropicProvider({ apiKey: 'sk-secret-value', model });
    assert.ok(!keyOf(p).includes('sk-secret-value'));
  });
});
