import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Message } from '../../types.js';
import { OpenAIProvider } from '../openai.js';

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

  it('sets default model to gpt-4o-mini', () => {
    const p = new OpenAIProvider({ apiKey: 'sk-test' });
    assert.equal(p.model, 'gpt-4o-mini');
  });

  it('uses custom model when provided', () => {
    const p = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-4o' });
    assert.equal(p.model, 'gpt-4o');
  });

  it('sets Authorization header', () => {
    const p = new OpenAIProvider({ apiKey: 'sk-test' });
    const headers = p.client.defaults.headers as Record<string, unknown>;
    assert.equal(headers.Authorization, 'Bearer sk-test');
  });

  it('sets OpenAI-Organization header when provided', () => {
    const p = new OpenAIProvider({
      apiKey: 'sk-test',
      organization: 'org-abc',
    });
    const headers = p.client.defaults.headers as Record<string, unknown>;
    assert.equal(headers['OpenAI-Organization'], 'org-abc');
  });

  it('sets OpenAI-Project header when provided', () => {
    const p = new OpenAIProvider({
      apiKey: 'sk-test',
      project: 'proj-xyz',
    });
    const headers = p.client.defaults.headers as Record<string, unknown>;
    assert.equal(headers['OpenAI-Project'], 'proj-xyz');
  });

  it('does not set org/project headers when not provided', () => {
    const p = new OpenAIProvider({ apiKey: 'sk-test' });
    const headers = p.client.defaults.headers as Record<string, unknown>;
    assert.equal(headers['OpenAI-Organization'], undefined);
    assert.equal(headers['OpenAI-Project'], undefined);
  });

  it('uses custom baseURL', () => {
    const p = new OpenAIProvider({
      apiKey: 'sk-test',
      baseURL: 'https://custom.api/v1',
    });
    assert.equal(p.client.defaults.baseURL, 'https://custom.api/v1');
  });
});

// ---------------------------------------------------------------------------
// formatMessages (private — tested via casting to any)
// ---------------------------------------------------------------------------

describe('OpenAIProvider — formatMessages', () => {
  const provider = new OpenAIProvider({ apiKey: 'sk-test' });
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
  // biome-ignore lint/suspicious/noExplicitAny: access private method for testing
  const param = (model: string) => {
    const p = new OpenAIProvider({ apiKey: 'sk-test', model });
    return (p as any).getTokenLimitParam(1024);
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
