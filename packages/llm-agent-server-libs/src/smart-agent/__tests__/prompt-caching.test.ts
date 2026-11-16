import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INLINE_LLM_CONFIG_FIELDS,
  normalizeLlmConfig,
} from '../llm-config-map.js';
import { resolveLlmSection } from '../resolve-config-sections.js';

for (const map of [false, true]) {
  for (const promptCaching of [undefined, false, true]) {
    test(`cache switch survives YAML resolution map=${map} value=${promptCaching}`, () => {
      const entry = {
        provider: 'anthropic',
        model: 'test-model',
        promptCaching,
      };
      const resolved = normalizeLlmConfig(
        resolveLlmSection({
          llm: map ? { main: entry, helper: entry } : entry,
        }),
      );
      assert.equal(resolved?.main.promptCaching, promptCaching);
      if (map) assert.equal(resolved?.helper.promptCaching, promptCaching);
      assert.ok(INLINE_LLM_CONFIG_FIELDS.includes('promptCaching'));
    });
  }
  test(`non-boolean YAML cache values fail early map=${map}`, () => {
    for (const promptCaching of [
      'off',
      'system',
      'system+tools',
      '5m',
      '1h',
      'true',
      'false',
      0,
      1,
      null,
      [],
      {},
    ]) {
      const entry = { provider: 'anthropic', promptCaching };
      assert.throws(
        () => resolveLlmSection({ llm: map ? { main: entry } : entry }),
        /promptCaching must be a boolean/,
      );
      if (map)
        assert.throws(
          () =>
            resolveLlmSection({
              llm: { main: { provider: 'anthropic' }, helper: entry },
            }),
          /promptCaching must be a boolean/,
        );
    }
  });
}
