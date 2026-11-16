import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INLINE_LLM_CONFIG_FIELDS,
  normalizeLlmConfig,
} from '../llm-config-map.js';
import { resolveLlmSection } from '../resolve-config-sections.js';

for (const map of [false, true]) {
  test(`cache config survives YAML resolution and normalization map=${map}`, () => {
    const knobs = {
      promptCaching: 'off',
      promptCacheKey: 'stable',
      promptCacheRetention: '24h',
    };
    const entry = { provider: 'anthropic', model: 'test-model', ...knobs };
    const resolved = normalizeLlmConfig(
      resolveLlmSection({ llm: map ? { main: entry } : entry }),
    );
    assert.equal(resolved?.main.promptCaching, 'off');
    assert.equal(resolved?.main.promptCacheKey, 'stable');
    assert.equal(resolved?.main.promptCacheRetention, '24h');
    assert.equal(
      normalizeLlmConfig(resolveLlmSection({ llm: { provider: 'anthropic' } }))
        ?.main.promptCaching,
      undefined,
    );
    for (const key of Object.keys(knobs))
      assert.ok(INLINE_LLM_CONFIG_FIELDS.includes(key));
  });
  test(`invalid YAML cache values fail early map=${map}`, () => {
    for (const bad of [
      { promptCaching: 'bad' },
      { promptCacheKey: 3 },
      { promptCacheRetention: '1h' },
    ]) {
      const entry = { provider: 'anthropic', ...bad };
      assert.throws(
        () => resolveLlmSection({ llm: map ? { main: entry } : entry }),
        /promptCach/,
      );
    }
  });
}
