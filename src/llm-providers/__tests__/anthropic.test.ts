import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Message } from '../../types.js';
import { AnthropicProvider } from '../anthropic.js';

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('AnthropicProvider — constructor', () => {
  it('throws when apiKey is missing', () => {
    assert.throws(
      () => new AnthropicProvider({ apiKey: '' }),
      /API key is required/,
    );
  });

  it('sets default model to claude-3-5-sonnet-20241022', () => {
    const p = new AnthropicProvider({ apiKey: 'sk-test' });
    assert.equal(p.model, 'claude-3-5-sonnet-20241022');
  });

  it('uses custom model when provided', () => {
    const p = new AnthropicProvider({
      apiKey: 'sk-test',
      model: 'claude-3-opus-20240229',
    });
    assert.equal(p.model, 'claude-3-opus-20240229');
  });

  it('sets x-api-key header', () => {
    const p = new AnthropicProvider({ apiKey: 'sk-ant-test' });
    const headers = p.client.defaults.headers as Record<string, unknown>;
    assert.equal(headers['x-api-key'], 'sk-ant-test');
  });

  it('sets anthropic-version header', () => {
    const p = new AnthropicProvider({ apiKey: 'sk-test' });
    const headers = p.client.defaults.headers as Record<string, unknown>;
    assert.equal(headers['anthropic-version'], '2023-06-01');
  });

  it('uses default baseURL', () => {
    const p = new AnthropicProvider({ apiKey: 'sk-test' });
    assert.equal(p.client.defaults.baseURL, 'https://api.anthropic.com/v1');
  });

  it('uses custom baseURL', () => {
    const p = new AnthropicProvider({
      apiKey: 'sk-test',
      baseURL: 'https://proxy.example.com/v1',
    });
    assert.equal(p.client.defaults.baseURL, 'https://proxy.example.com/v1');
  });
});

// ---------------------------------------------------------------------------
// formatMessages (private — tested via casting to any)
// ---------------------------------------------------------------------------

describe('AnthropicProvider — formatMessages', () => {
  const provider = new AnthropicProvider({ apiKey: 'sk-test' });
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
    const provider = new AnthropicProvider({ apiKey: 'sk-test' });
    assert.equal(typeof provider.streamChat, 'function');
  });
});

// ---------------------------------------------------------------------------
// chat() — usage extraction
// ---------------------------------------------------------------------------

describe('AnthropicProvider — chat() usage', () => {
  it('returns usage from response', async () => {
    const provider = new AnthropicProvider({ apiKey: 'sk-test' });
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
      prompt_tokens: 15,
      completion_tokens: 25,
      total_tokens: 40,
    });
  });
});
