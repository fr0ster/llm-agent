import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as libs from '../index.js';

describe('llm-agent-libs no longer dispatches providers', () => {
  for (const name of ['makeLlm', 'makeDefaultLlm', 'DefaultModelResolver']) {
    it(`does not export ${name}`, () => {
      assert.equal(
        (libs as Record<string, unknown>)[name],
        undefined,
        `${name} restated a constructor this package does not own, which is why a ` +
          'secret had to travel through MakeLlmConfig to feed it',
      );
    });
  }

  it('still exports the builder, whose withMainLlm is the seam that replaces them', () => {
    assert.equal(typeof libs.SmartAgentBuilder, 'function');
  });
});
