import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { it } from 'node:test';
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import { OllamaProvider } from '../ollama-provider.js';

for (const stream of [false, true]) {
  for (const configured of [undefined, false, true]) {
    for (const promptCaching of [undefined, false, true]) {
      it(`preserves compatible cache usage without cache directives stream=${stream} config=${configured} option=${promptCaching}`, async (t) => {
        const provider = new OllamaProvider({
          model: 'test-model',
          promptCaching: configured,
          credential: staticApiKey('test'),
        });
        const usage = {
          prompt_tokens: 100,
          completion_tokens: 4,
          total_tokens: 104,
          prompt_cache_hit_tokens: 60,
        };
        t.mock.method(
          provider.client,
          'post',
          async (_url: string, body: object) => {
            assert.ok(!('prompt_cache_key' in body));
            assert.ok(!('prompt_cache_retention' in body));
            assert.ok(!('cache_control' in body));
            assert.ok(!('promptCaching' in body));
            assert.ok(!('keep_alive' in body));
            return {
              data: stream
                ? Readable.from([
                    `data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`,
                  ])
                : { choices: [{ message: { content: 'ok' } }], usage },
            };
          },
        );
        const opts = { promptCaching };
        if (stream) {
          for await (const chunk of provider.streamChat([], undefined, opts))
            assert.equal(chunk.usage?.cachedInputTokens, 60);
        } else
          assert.equal(
            (await provider.chat([], undefined, opts)).usage?.cachedInputTokens,
            60,
          );
      });
    }
  }
}
