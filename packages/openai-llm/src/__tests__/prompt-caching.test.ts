import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { it } from 'node:test';
import { staticApiKey, type UsageInput } from '@mcp-abap-adt/llm-agent';
import { OpenAIProvider } from '../openai-provider.js';

for (const stream of [false, true]) {
  for (const configured of [undefined, false, true]) {
    for (const override of [undefined, false, true]) {
      it(`OpenAI cache options and usage stream=${stream} config=${configured} override=${override}`, async (t) => {
        const records: UsageInput[] = [];
        const provider = new OpenAIProvider({
          model: 'test-model',
          credential: staticApiKey('test'),
          promptCaching: configured,
          usage: {
            record: (r) => {
              records.push(r);
            },
            with() {
              return this;
            },
          },
        });
        let body: object = {};
        const usage = {
          prompt_tokens: 100,
          completion_tokens: 4,
          total_tokens: 104,
          prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 20 },
        };
        t.mock.method(
          provider.client,
          'post',
          async (_url: string, value: typeof body) => {
            body = value;
            return {
              data: stream
                ? Readable.from([
                    `data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`,
                  ])
                : {
                    choices: [
                      { message: { content: 'ok' }, finish_reason: 'stop' },
                    ],
                    usage,
                  },
            };
          },
        );
        const options = { promptCaching: override };
        if (stream) {
          for await (const chunk of provider.streamChat(
            [],
            undefined,
            options,
          )) {
            assert.equal(chunk.usage?.cachedInputTokens, 60);
            assert.equal(chunk.usage?.cacheCreationInputTokens, 20);
          }
        } else {
          const result = await provider.chat([], undefined, options);
          assert.equal(result.usage?.cachedInputTokens, 60);
          assert.equal(result.usage?.cacheCreationInputTokens, 20);
        }
        assert.ok(!('prompt_cache_key' in body));
        assert.ok(!('prompt_cache_retention' in body));
        assert.ok(!('cache_control' in body));
        assert.ok(!('promptCaching' in body));
        const record = records[0];
        if (record.kind !== 'llm.call') assert.fail('expected llm.call');
        assert.equal(record.cachedInputTokens, 60);
        assert.equal(record.cacheCreationInputTokens, 20);
        assert.equal(record.inputTokens, 100);
      });
    }
  }
}

it('leaves unset OpenAI cache options and absent cache counters absent', async (t) => {
  const provider = new OpenAIProvider({
    model: 'test-model',
    credential: staticApiKey('test'),
  });
  t.mock.method(provider.client, 'post', async (_url: string, body: object) => {
    assert.ok(!('prompt_cache_key' in body));
    assert.ok(!('prompt_cache_retention' in body));
    return {
      data: {
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      },
    };
  });
  assert.deepEqual((await provider.chat([])).usage, {
    promptTokens: 2,
    completionTokens: 1,
    totalTokens: 3,
  });
});
