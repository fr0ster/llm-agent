import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnthropicApiAdapter } from './api-adapters/anthropic-adapter.js';
import { OpenAiApiAdapter } from './api-adapters/openai-adapter.js';
import { promptCacheOptions } from './prompt-caching.js';

test('validates optional cache controls and preserves off and omitted values', () => {
  assert.deepEqual(promptCacheOptions({}), {});
  const knobs = {
    promptCaching: 'off',
    promptCacheKey: 'stable',
    promptCacheRetention: '24h',
  };
  assert.deepEqual(promptCacheOptions(knobs), knobs);
  for (const value of ['off', '5m', '1h'])
    assert.equal(
      promptCacheOptions({ promptCaching: value }).promptCaching,
      value,
    );
  for (const bad of [
    { promptCaching: true },
    { promptCaching: '5M' },
    { promptCaching: null },
    { promptCacheKey: 3 },
    { promptCacheRetention: '1h' },
  ])
    assert.throws(() => promptCacheOptions(bad), /promptCach/);
});

for (const adapter of [new OpenAiApiAdapter(), new AnthropicApiAdapter()]) {
  test(`${adapter.name} HTTP normalization forwards cache knobs including OpenAI wire aliases`, () => {
    const input = {
      messages: [{ role: 'user', content: 'hi' }],
      model: 'test-model',
      max_tokens: 10,
      promptCaching: 'off',
      prompt_cache_key: 'stable',
      prompt_cache_retention: '24h',
    };
    const result = adapter.normalizeRequest(input);
    assert.ok(result.options);
    assert.equal(result.options.promptCaching, 'off');
    assert.equal(result.options.promptCacheKey, 'stable');
    assert.equal(result.options.promptCacheRetention, '24h');
    assert.throws(
      () => adapter.normalizeRequest({ ...input, promptCaching: 'bad' }),
      /promptCaching/,
    );
  });
}
