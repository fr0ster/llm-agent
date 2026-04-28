import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
    const headers = p.client.defaults.headers;
    assert.equal(headers.Authorization, 'Bearer sk-test');
  });
  it('sets OpenAI-Organization header when provided', () => {
    const p = new OpenAIProvider({
      apiKey: 'sk-test',
      organization: 'org-abc',
    });
    const headers = p.client.defaults.headers;
    assert.equal(headers['OpenAI-Organization'], 'org-abc');
  });
  it('sets OpenAI-Project header when provided', () => {
    const p = new OpenAIProvider({
      apiKey: 'sk-test',
      project: 'proj-xyz',
    });
    const headers = p.client.defaults.headers;
    assert.equal(headers['OpenAI-Project'], 'proj-xyz');
  });
  it('does not set org/project headers when not provided', () => {
    const p = new OpenAIProvider({ apiKey: 'sk-test' });
    const headers = p.client.defaults.headers;
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
  const fmt = (msgs) => provider.formatMessages(msgs);
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
        type: 'function',
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
        type: 'function',
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
  const param = (model) => {
    const p = new OpenAIProvider({ apiKey: 'sk-test', model });
    // biome-ignore lint/suspicious/noExplicitAny: access private method for testing
    return p.getTokenLimitParam(model, 1024);
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
      (err) => {
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
      (err) => {
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
    let capturedBody = {};
    // @ts-expect-error — stub axios for test
    provider.client.post = async (_url, body) => {
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
    let capturedBody = {};
    // @ts-expect-error — stub axios for test
    provider.client.post = async (_url, body) => {
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
    let capturedBody = {};
    // @ts-expect-error — stub axios for test
    provider.client.post = async (_url, body) => {
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
    let capturedBody = {};
    // @ts-expect-error — stub axios for test
    provider.client.post = async (_url, body) => {
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
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
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
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    });
  });
  it('returns undefined usage when not present', async () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
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
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
    let capturedBody = {};
    // @ts-expect-error — stub axios for test
    provider.client.post = async (_url, body) => {
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
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
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
    const chunks = [];
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
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
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
    const chunks = [];
    for await (const chunk of provider.streamChat([
      { role: 'user', content: 'hi' },
    ])) {
      chunks.push(chunk);
    }
    const usageChunk = chunks.find((c) => c.usage !== undefined);
    assert.ok(usageChunk, 'expected a chunk with usage');
    assert.deepEqual(usageChunk.usage, {
      prompt_tokens: 5,
      completion_tokens: 1,
      total_tokens: 6,
    });
  });
});
//# sourceMappingURL=openai-provider.test.js.map
