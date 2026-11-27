/**
 * `llm.reasoningEffort` reaches the provider config, stays unset when omitted
 * and is rejected at load when it names no known level.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveSmartServerConfig } from '../config.js';
import { ConfigValidationError } from '../config-validator.js';
import { normalizeLlmConfig } from '../llm-config-map.js';

function yamlWith(reasoningEffort?: string) {
  return {
    llm: {
      provider: 'ollama',
      model: 'qwen2.5',
      url: 'http://localhost:11434',
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    },
  };
}

describe('llm.reasoningEffort from YAML', () => {
  it('passes a known level through', () => {
    const config = resolveSmartServerConfig({}, yamlWith('high'), {});
    assert.equal(config.llm?.reasoningEffort, 'high');
  });

  it('stays unset when omitted', () => {
    const config = resolveSmartServerConfig({}, yamlWith(), {});
    assert.equal(config.llm?.reasoningEffort, undefined);
  });

  it('rejects an unknown level', () => {
    assert.throws(
      () => resolveSmartServerConfig({}, yamlWith('extreme'), {}),
      (error: Error) =>
        error instanceof ConfigValidationError &&
        error.message.includes('llm.reasoningEffort'),
    );
  });
});

for (const role of ['main', 'helper']) {
  describe(`llm.${role}.reasoningEffort from YAML`, () => {
    function namedYamlWith(reasoningEffort: string) {
      return {
        llm: { main: yamlWith().llm, [role]: yamlWith(reasoningEffort).llm },
      };
    }

    it('passes a known level through', () => {
      const config = resolveSmartServerConfig({}, namedYamlWith('high'), {});
      assert.equal(
        normalizeLlmConfig(config.llm)?.[role].reasoningEffort,
        'high',
      );
    });

    it('rejects an unknown level with the role in the error', () => {
      assert.throws(
        () => resolveSmartServerConfig({}, namedYamlWith('extreme'), {}),
        (error: Error) =>
          error instanceof ConfigValidationError &&
          error.message.includes(`llm.${role}.reasoningEffort`),
      );
    });
  });
}
