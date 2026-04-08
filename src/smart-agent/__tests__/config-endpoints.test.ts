import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SmartAgent } from '../agent.js';
import { makeDefaultDeps } from '../testing/index.js';

describe('SmartAgent.getAgentConfig', () => {
  it('returns only whitelisted fields', () => {
    const { deps } = makeDefaultDeps();
    const agent = new SmartAgent(deps, {
      maxIterations: 10,
      maxToolCalls: 5,
      ragQueryK: 15,
      toolUnavailableTtlMs: 30_000,
      showReasoning: true,
      historyAutoSummarizeLimit: 20,
      classificationEnabled: true,
      ragRetrievalMode: 'auto',
      ragTranslationEnabled: true,
      ragUpsertEnabled: false,
      // These should NOT appear in the output:
      timeoutMs: 5000,
      tokenLimit: 4096,
      smartAgentEnabled: true,
    });

    const config = agent.getAgentConfig();

    assert.deepEqual(config, {
      maxIterations: 10,
      maxToolCalls: 5,
      ragQueryK: 15,
      toolUnavailableTtlMs: 30_000,
      showReasoning: true,
      historyAutoSummarizeLimit: 20,
      classificationEnabled: true,
      ragRetrievalMode: 'auto',
      ragTranslationEnabled: true,
      ragUpsertEnabled: false,
    });
  });

  it('returns defaults for omitted optional fields', () => {
    const { deps } = makeDefaultDeps();
    const agent = new SmartAgent(deps, { maxIterations: 5 });

    const config = agent.getAgentConfig();

    assert.equal(config.maxIterations, 5);
    assert.equal(config.maxToolCalls, undefined);
    assert.equal(config.classificationEnabled, undefined);
  });
});
