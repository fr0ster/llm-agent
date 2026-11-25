import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import { AnthropicProvider } from '../anthropic-provider.js';

// These request and response shapes pin the direct provider on origin/main.
test('direct Anthropic preserves max_tokens and its existing chat tool call shape', async (t) => {
  const llm = new AnthropicProvider({
    model: 'test',
    maxTokens: 100,
    credential: staticApiKey('test'),
  });
  const raw = {
    content: [
      { type: 'text', text: 'Looking it up.' },
      { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { id: 7 } },
    ],
    stop_reason: 'tool_use',
  };
  const post = t.mock.method(
    llm.client,
    'post',
    async (_path: string, _body: object) => ({ data: raw }),
  );
  assert.deepEqual(await llm.chat([]), {
    content: 'Looking it up.',
    finishReason: 'tool_calls',
    raw,
    toolCalls: [
      { index: 0, id: 'toolu_1', name: 'lookup', arguments: '{"id":7}' },
    ],
    usage: undefined,
  });
  assert.deepEqual(post.mock.calls[0].arguments[1], {
    model: 'test',
    messages: [],
    max_tokens: 100,
    cache_control: { type: 'ephemeral' },
  });
});

test('direct Anthropic preserves the output_tokens reported in each usage chunk', async (t) => {
  const llm = new AnthropicProvider({
    model: 'test',
    maxTokens: 100,
    credential: staticApiKey('test'),
  });
  const start = {
    type: 'message_start',
    message: { usage: { input_tokens: 6, output_tokens: 1 } },
  };
  const delta = {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { input_tokens: 6, output_tokens: 4 },
  };
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        [start, delta]
          .map((raw) => `event: ${raw.type}\ndata: ${JSON.stringify(raw)}\n\n`)
          .join(''),
      ),
  );
  const chunks = [];
  for await (const chunk of llm.streamChat([])) chunks.push(chunk);
  assert.deepEqual(chunks, [
    {
      content: '',
      raw: start,
      usage: { promptTokens: 6, completionTokens: 1, totalTokens: 7 },
    },
    {
      content: '',
      finishReason: 'stop',
      raw: delta,
      usage: { promptTokens: 0, completionTokens: 4, totalTokens: 4 },
    },
  ]);
});
