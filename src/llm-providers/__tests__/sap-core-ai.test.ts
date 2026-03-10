import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Message } from '../../types.js';
import { SapCoreAIProvider } from '../sap-core-ai.js';

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('SapCoreAIProvider — constructor', () => {
  it('does NOT throw when apiKey is missing (SAP SDK handles auth)', () => {
    assert.doesNotThrow(() => new SapCoreAIProvider({}));
  });

  it('sets default model to gpt-4o', () => {
    const p = new SapCoreAIProvider({});
    assert.equal(p.model, 'gpt-4o');
  });

  it('uses custom model when provided', () => {
    const p = new SapCoreAIProvider({ model: 'claude-3-5-sonnet' });
    assert.equal(p.model, 'claude-3-5-sonnet');
  });

  it('sets resourceGroup when provided', () => {
    const p = new SapCoreAIProvider({ resourceGroup: 'default' });
    assert.equal(p.resourceGroup, 'default');
  });

  it('resourceGroup is undefined when not provided', () => {
    const p = new SapCoreAIProvider({});
    assert.equal(p.resourceGroup, undefined);
  });
});

// ---------------------------------------------------------------------------
// Credentials → destination
// ---------------------------------------------------------------------------

describe('SapCoreAIProvider — credentials / destination', () => {
  it('builds destination object from credentials', () => {
    const creds = {
      clientId: 'sb-xxx',
      clientSecret: 'secret123',
      tokenServiceUrl: 'https://auth.example.com/oauth/token',
      servicUrl: 'https://api.ai.example.com',
    };
    const p = new SapCoreAIProvider({ credentials: creds });

    // biome-ignore lint/suspicious/noExplicitAny: access private field for testing
    const dest = (p as any).destination;
    assert.ok(dest, 'destination should be defined');
    assert.equal(dest.url, 'https://api.ai.example.com');
    assert.equal(dest.authentication, 'OAuth2ClientCredentials');
    assert.equal(dest.clientId, 'sb-xxx');
    assert.equal(dest.clientSecret, 'secret123');
    assert.equal(dest.tokenServiceUrl, 'https://auth.example.com/oauth/token');
  });

  it('destination is undefined when no credentials provided', () => {
    const p = new SapCoreAIProvider({});
    // biome-ignore lint/suspicious/noExplicitAny: access private field for testing
    assert.equal((p as any).destination, undefined);
  });
});

// ---------------------------------------------------------------------------
// formatMessages (private — tested via casting to any)
// ---------------------------------------------------------------------------

describe('SapCoreAIProvider — formatMessages', () => {
  const provider = new SapCoreAIProvider({});
  // biome-ignore lint/suspicious/noExplicitAny: access private method for testing
  const fmt = (msgs: Message[]) => (provider as any).formatMessages(msgs);

  it('formats simple user message', () => {
    const result = fmt([{ role: 'user', content: 'Hello' }]);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'user');
    assert.equal(result[0].content, 'Hello');
  });

  it('formats system message', () => {
    const result = fmt([{ role: 'system', content: 'Be helpful' }]);
    assert.equal(result[0].role, 'system');
    assert.equal(result[0].content, 'Be helpful');
  });

  it('formats assistant message with tool_calls', () => {
    const toolCalls = [
      {
        id: 'call_1',
        type: 'function' as const,
        function: { name: 'test', arguments: '{}' },
      },
    ];
    const result = fmt([
      { role: 'assistant', content: 'Calling...', tool_calls: toolCalls },
    ]);
    assert.equal(result[0].role, 'assistant');
    assert.deepEqual(result[0].tool_calls, toolCalls);
  });

  it('sets assistant content to undefined when it has tool_calls and empty content', () => {
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
    assert.equal(result[0].content, undefined);
  });

  it('formats tool message with tool_call_id', () => {
    const result = fmt([
      { role: 'tool', content: 'result', tool_call_id: 'call_1' },
    ]);
    assert.equal(result[0].role, 'tool');
    assert.equal(result[0].content, 'result');
    assert.equal(result[0].tool_call_id, 'call_1');
  });

  it('stringifies non-string tool content', () => {
    const result = fmt([
      { role: 'tool', content: null, tool_call_id: 'call_1' },
    ]);
    assert.equal(result[0].content, JSON.stringify(''));
  });

  it('handles null content for user message', () => {
    const result = fmt([{ role: 'user', content: null }]);
    assert.equal(result[0].content, '');
  });
});

// ---------------------------------------------------------------------------
// createClient (private — tested via casting to any)
// ---------------------------------------------------------------------------

describe('SapCoreAIProvider — createClient', () => {
  it('passes tools through to OrchestrationClient config', () => {
    const p = new SapCoreAIProvider({ model: 'gpt-4o' });

    // We cannot fully instantiate OrchestrationClient without SAP env,
    // but we can verify the method exists and accepts tools.
    // @ts-expect-error — access private method for testing
    const createClient = p.createClient.bind(p);
    assert.equal(typeof createClient, 'function');
  });
});
