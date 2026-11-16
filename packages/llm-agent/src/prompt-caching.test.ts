import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnthropicApiAdapter } from './api-adapters/anthropic-adapter.js';
import { OpenAiApiAdapter } from './api-adapters/openai-adapter.js';
import { promptCacheOptions } from './prompt-caching.js';

test('validates the boolean cache switch and preserves false and omission', () => {
  assert.deepEqual(promptCacheOptions({}), {});
  assert.deepEqual(promptCacheOptions({ promptCaching: undefined }), {});
  for (const value of [false, true])
    assert.deepEqual(promptCacheOptions({ promptCaching: value }), {
      promptCaching: value,
    });
  for (const value of ['off', '5m', '1h', 'true', 'false', 0, 1, null, [], {}])
    assert.throws(
      () => promptCacheOptions({ promptCaching: value }),
      /promptCaching must be a boolean/,
    );
});

for (const adapter of [new OpenAiApiAdapter(), new AnthropicApiAdapter()]) {
  for (const promptCaching of [undefined, false, true]) {
    test(`${adapter.name} HTTP normalization preserves cache switch ${promptCaching}`, () => {
      const input = {
        messages: [{ role: 'user', content: 'hi' }],
        model: 'test-model',
        max_tokens: 10,
        promptCaching,
        promptCacheKey: 'removed',
        promptCacheRetention: 'removed',
        prompt_cache_key: 'removed',
        prompt_cache_retention: 'removed',
      };
      const result = adapter.normalizeRequest(input);
      assert.equal(result.options?.promptCaching, promptCaching);
      for (const key of [
        'promptCacheKey',
        'promptCacheRetention',
        'prompt_cache_key',
        'prompt_cache_retention',
      ])
        assert.ok(result.options && !(key in result.options));
      for (const value of ['off', '5m', '1h', 'true', 'false', 0, null])
        assert.throws(
          () => adapter.normalizeRequest({ ...input, promptCaching: value }),
          /promptCaching/,
        );
    });
  }
}
