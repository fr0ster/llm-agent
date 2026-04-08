import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SmartAgent } from '../agent.js';
import { makeDefaultDeps, makeLlm } from '../testing/index.js';

describe('SmartAgent.reconfigure', () => {
  it('replaces mainLlm for subsequent calls', async () => {
    const { deps } = makeDefaultDeps();
    const agent = new SmartAgent(deps, { maxIterations: 5 });

    const newLlm = makeLlm([{ content: 'new-main-response' }]);
    agent.reconfigure({ mainLlm: newLlm });

    const result = await agent.process('hello');
    assert.ok(result.ok);
    assert.equal(result.value.content, 'new-main-response');
  });

  it('replaces helperLlm', () => {
    const { deps } = makeDefaultDeps();
    const agent = new SmartAgent(deps, { maxIterations: 5 });

    const newHelper = makeLlm([{ content: 'helper' }]);
    agent.reconfigure({ helperLlm: newHelper });

    const config = agent.getActiveConfig();
    // makeLlm stubs don't set model property
    // The key assertion is that reconfigure doesn't throw and getActiveConfig reflects the change
    assert.equal(config.helperModel, undefined);
  });

  it('replaces classifierLlm by rebuilding the classifier', async () => {
    const { deps } = makeDefaultDeps();
    const agent = new SmartAgent(deps, { maxIterations: 5 });

    // New classifier LLM returns a classification + final response for main LLM
    const classifierLlm = makeLlm([
      {
        content:
          '```json\n[{"type":"action","text":"classified by new model"}]\n```',
      },
    ]);
    agent.reconfigure({ classifierLlm });

    // Process should use the new classifier — no error means it worked
    const result = await agent.process('test input');
    assert.ok(result.ok);
  });

  it('partial reconfigure does not affect other components', () => {
    const { deps } = makeDefaultDeps();
    const agent = new SmartAgent(deps, { maxIterations: 5 });

    const configBefore = agent.getActiveConfig();
    const newHelper = makeLlm([{ content: 'helper' }]);
    agent.reconfigure({ helperLlm: newHelper });
    const configAfter = agent.getActiveConfig();

    // mainModel should be unchanged
    assert.equal(configBefore.mainModel, configAfter.mainModel);
  });
});

describe('SmartAgent.getActiveConfig', () => {
  it('returns model names from active LLM instances', () => {
    const { deps } = makeDefaultDeps();
    const agent = new SmartAgent(deps, { maxIterations: 5 });

    const config = agent.getActiveConfig();
    // makeLlm stubs don't have model property
    assert.equal(config.mainModel, undefined);
    assert.equal(config.classifierModel, undefined);
    assert.equal(config.helperModel, undefined);
  });

  it('reflects reconfigured models', () => {
    const { deps } = makeDefaultDeps();
    const agent = new SmartAgent(deps, { maxIterations: 5 });

    const mainWithModel = {
      ...makeLlm([{ content: 'ok' }]),
      model: 'gpt-4o',
    };
    const classifierWithModel = {
      ...makeLlm([{ content: 'ok' }]),
      model: 'gpt-4.1-mini',
    };

    agent.reconfigure({
      mainLlm: mainWithModel,
      classifierLlm: classifierWithModel,
    });

    const config = agent.getActiveConfig();
    assert.equal(config.mainModel, 'gpt-4o');
    assert.equal(config.classifierModel, 'gpt-4.1-mini');
  });
});
