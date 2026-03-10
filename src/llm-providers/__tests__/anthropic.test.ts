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
// streamChat — intentionally throws
// ---------------------------------------------------------------------------

describe('AnthropicProvider — streamChat', () => {
  it('throws "not used directly" error', async () => {
    const provider = new AnthropicProvider({ apiKey: 'sk-test' });
    await assert.rejects(async () => {
      for await (const _chunk of provider.streamChat([
        { role: 'user', content: 'hi' },
      ])) {
        // drain
      }
    }, /not used directly/);
  });
});
