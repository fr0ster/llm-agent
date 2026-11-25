import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import { OpenAIProvider } from '../openai-provider.js';

// These request and response shapes pin the direct provider on origin/main.
test('direct OpenAI preserves token limit selection and returns chat tool calls in raw', async (t) => {
  const raw = {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'lookup', arguments: '{}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  };
  const llm = new OpenAIProvider({
    model: 'o4-mini',
    maxTokens: 100,
    credential: staticApiKey('test'),
  });
  const post = t.mock.method(
    llm.client,
    'post',
    async (_path: string, body: { stream?: boolean }) => ({
      data: body.stream ? Readable.from(['data: [DONE]\n\n']) : raw,
    }),
  );

  for (const [model, tokenField] of [
    ['o4-mini', 'max_tokens'],
    ['gpt-6.1-sol', 'max_tokens'],
    ['gpt-4o', 'max_tokens'],
    ['o1-mini', 'max_completion_tokens'],
    ['O3', 'max_completion_tokens'],
    ['gpt-5.1', 'max_completion_tokens'],
  ]) {
    assert.deepEqual(await llm.chat([], undefined, { model }), {
      content: '',
      finishReason: 'tool_calls',
      raw,
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
    });
    for await (const _chunk of llm.streamChat([], undefined, { model })) {
      assert.fail('The terminal sentinel does not emit a chunk');
    }
    const expected = {
      model,
      messages: [],
      tools: undefined,
      tool_choice: undefined,
      [tokenField]: 100,
    };
    const requests = post.mock.calls.slice(-2);
    assert.deepEqual(requests[0].arguments[1], expected);
    assert.deepEqual(requests[1].arguments[1], {
      ...expected,
      stream: true,
      stream_options: { include_usage: true },
    });
  }
});

for (const finishReason of ['tool_calls', 'length', 'stop']) {
  test(`direct OpenAI preserves empty tool argument handling for ${finishReason}`, async (t) => {
    const llm = new OpenAIProvider({
      model: 'test',
      credential: staticApiKey('test'),
    });
    const start = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                function: { name: 'lookup', arguments: '' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };
    const finish = { choices: [{ delta: {}, finish_reason: finishReason }] };
    t.mock.method(llm.client, 'post', async () => ({
      data: Readable.from(
        [start, finish].map((raw) => `data: ${JSON.stringify(raw)}\n\n`),
      ),
    }));
    const chunks = [];
    for await (const chunk of llm.streamChat([])) chunks.push(chunk);
    assert.deepEqual(chunks, [
      {
        content: '',
        finishReason: null,
        raw: start,
        toolCalls: [{ index: 0, id: 'call_1', name: 'lookup', arguments: '' }],
      },
      {
        content: '',
        finishReason,
        raw: finish,
        ...(finishReason === 'tool_calls'
          ? { toolCalls: [{ index: 0, arguments: '{}' }] }
          : {}),
      },
    ]);
  });
}
