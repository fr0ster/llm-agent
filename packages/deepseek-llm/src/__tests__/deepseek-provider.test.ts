import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Message, staticApiKey } from '@mcp-abap-adt/llm-agent';
import { DeepSeekProvider } from '../deepseek-provider.js';

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('DeepSeekProvider — constructor', () => {
  it('throws when credential is missing', () => {
    // B1 removed `LLMProviderConfig.apiKey`, so there is no longer a field to
    // leave empty; `credential` is required (forwarded to `OpenAIProvider`,
    // which enforces it) and its absence is normally a compile error. This
    // asserts the runtime fallback for a caller that bypasses the type
    // (plain JS, or `as any`) still refuses to construct.
    assert.throws(
      // biome-ignore lint/suspicious/noExplicitAny: intentional missing credential for test
      () => new DeepSeekProvider({ model: 'deepseek-chat' } as any),
      /credential/i,
    );
  });

  it('throws when model is missing', () => {
    assert.throws(
      () =>
        // biome-ignore lint/suspicious/noExplicitAny: intentional missing model for test
        new DeepSeekProvider({ credential: staticApiKey('sk-test') } as any),
      /model/i,
    );
  });

  it('uses custom model when provided', () => {
    const p = new DeepSeekProvider({
      credential: staticApiKey('sk-test'),
      model: 'deepseek-coder',
    });
    assert.equal(p.model, 'deepseek-coder');
  });

  it('sends a Bearer Authorization header, resolved per request', async () => {
    // Task B3: the credential is no longer baked into `client.defaults.headers`
    // at construction — a secret resolved once there would be frozen for the
    // object's lifetime. It is asked for fresh on each request instead; see
    // credential.test.ts for the "asked twice, differs twice" case.
    const p = new DeepSeekProvider({
      credential: staticApiKey('sk-deep'),
      model: 'deepseek-chat',
    });
    let capturedHeaders: Record<string, unknown> | undefined;
    // @ts-expect-error — stub axios for test
    p.client.post = async (
      _url: string,
      _body: unknown,
      config?: { headers?: Record<string, unknown> },
    ) => {
      capturedHeaders = config?.headers;
      return {
        data: {
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        },
      };
    };
    await p.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(capturedHeaders?.Authorization, 'Bearer sk-deep');
  });

  it('uses default baseURL', () => {
    const p = new DeepSeekProvider({
      credential: staticApiKey('sk-test'),
      model: 'deepseek-chat',
    });
    assert.equal(p.client.defaults.baseURL, 'https://api.deepseek.com/v1');
  });
});

// ---------------------------------------------------------------------------
// formatMessages (private — tested via casting to any)
// ---------------------------------------------------------------------------

describe('DeepSeekProvider — formatMessages', () => {
  const provider = new DeepSeekProvider({
    credential: staticApiKey('sk-test'),
    model: 'deepseek-chat',
  });
  // biome-ignore lint/suspicious/noExplicitAny: access private method for testing
  const fmt = (msgs: Message[]) => (provider as any).formatMessages(msgs);

  it('formats simple user message', () => {
    const result = fmt([{ role: 'user', content: 'Hello' }]);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'user');
    assert.equal(result[0].content, 'Hello');
  });

  it('tracks tool call IDs from assistant messages', () => {
    const toolCalls = [
      {
        id: 'call_1',
        type: 'function' as const,
        function: { name: 'test', arguments: '{}' },
      },
    ];
    const result = fmt([
      { role: 'assistant', content: '', tool_calls: toolCalls },
      { role: 'tool', content: 'result', tool_call_id: 'call_1' },
    ]);
    assert.equal(result.length, 2);
    assert.equal(result[1].tool_call_id, 'call_1');
  });

  it('drops orphaned tool messages (no matching tool_call_id)', () => {
    const result = fmt([
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'orphan', tool_call_id: 'call_unknown' },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'user');
  });

  it('drops tool messages without tool_call_id', () => {
    const result = fmt([
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'no id' },
    ]);
    assert.equal(result.length, 1);
  });

  it('sets content to null for assistant with tool_calls', () => {
    const toolCalls = [
      {
        id: 'call_1',
        type: 'function' as const,
        function: { name: 'fn', arguments: '{}' },
      },
    ];
    const result = fmt([
      { role: 'assistant', content: '', tool_calls: toolCalls },
    ]);
    assert.equal(result[0].content, null);
    assert.deepEqual(result[0].tool_calls, toolCalls);
  });

  it('stringifies non-string tool content', () => {
    const toolCalls = [
      {
        id: 'call_1',
        type: 'function' as const,
        function: { name: 'fn', arguments: '{}' },
      },
    ];
    const result = fmt([
      { role: 'assistant', content: '', tool_calls: toolCalls },
      { role: 'tool', content: null, tool_call_id: 'call_1' },
    ]);
    assert.equal(result[1].content, JSON.stringify(''));
  });

  it('ensures non-assistant roles have string content (not null)', () => {
    const result = fmt([{ role: 'user', content: null }]);
    assert.equal(result[0].content, '');
  });
});

// ---------------------------------------------------------------------------
// chat — error handling
// ---------------------------------------------------------------------------

describe('DeepSeekProvider — chat error handling', () => {
  it('wraps API errors with "DeepSeek API error:" prefix', async () => {
    const provider = new DeepSeekProvider({
      credential: staticApiKey('sk-test'),
      model: 'deepseek-chat',
      baseURL: 'http://localhost:1',
    });
    await assert.rejects(
      () => provider.chat([{ role: 'user', content: 'hi' }]),
      (err: Error) => {
        assert.ok(err.message.startsWith('DeepSeek API error:'));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// streamChat — error handling
// ---------------------------------------------------------------------------

describe('DeepSeekProvider — streamChat error handling', () => {
  it('wraps streaming errors with "DeepSeek Streaming error:" prefix', async () => {
    const provider = new DeepSeekProvider({
      credential: staticApiKey('sk-test'),
      model: 'deepseek-chat',
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
        assert.ok(err.message.startsWith('DeepSeek Streaming error:'));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// chat() options forwarding
// ---------------------------------------------------------------------------

describe('chat() options forwarding', () => {
  it('uses per-request overrides', async () => {
    const provider = new DeepSeekProvider({
      credential: staticApiKey('test-key'),
      model: 'deepseek-chat',
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
      model: 'deepseek-reasoner',
      temperature: 0.2,
      maxTokens: 100,
    });
    assert.equal(capturedBody.model, 'deepseek-reasoner');
    assert.equal(capturedBody.temperature, 0.2);
    assert.equal(capturedBody.max_tokens, 100);
  });

  it('non-streaming chat does NOT include stream_options', async () => {
    const provider = new DeepSeekProvider({
      credential: staticApiKey('test-key'),
      model: 'deepseek-chat',
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
    assert.equal(capturedBody.stream, undefined);
    assert.equal(capturedBody.stream_options, undefined);
  });
});

// ---------------------------------------------------------------------------
// streamChat() — inherits stream_options from OpenAI
// ---------------------------------------------------------------------------

describe('DeepSeekProvider — streamChat() inherits usage', () => {
  it('sends stream_options with include_usage: true', async () => {
    const provider = new DeepSeekProvider({
      credential: staticApiKey('sk-test'),
      model: 'deepseek-chat',
    });
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
});
