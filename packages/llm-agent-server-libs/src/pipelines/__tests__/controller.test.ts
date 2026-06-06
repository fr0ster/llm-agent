import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ControllerPipelinePlugin } from '../controller.js';
import { fakeControllerServerCtx } from './fixtures.js';

describe('ControllerPipelinePlugin', () => {
  it('parseConfig defaults budgets/targetState/sessionMemory and requires subagents', () => {
    const plugin = new ControllerPipelinePlugin();
    const cfg = plugin.parseConfig({
      subagents: {
        evaluator: { provider: 'openai' },
        planner: { provider: 'openai' },
        executor: { provider: 'openai' },
      },
    });
    assert.equal(cfg.budgets.maxSteps, 20);
    assert.equal(cfg.budgets.maxToolCalls, 10);
    assert.equal(cfg.targetState.strategy, 'auto');
    assert.equal(cfg.targetState.distanceThreshold, 0.25);
    assert.equal(cfg.sessionMemory.collection, 'session-memory');
  });

  it('parseConfig merges provided overrides over defaults', () => {
    const plugin = new ControllerPipelinePlugin();
    const cfg = plugin.parseConfig({
      subagents: {
        evaluator: { provider: 'openai' },
        planner: { provider: 'openai' },
        executor: { provider: 'openai' },
      },
      budgets: { maxSteps: 5 },
      targetState: { strategy: 'semantic-distance' },
    });
    assert.equal(cfg.budgets.maxSteps, 5);
    assert.equal(cfg.budgets.maxRetries, 3);
    assert.equal(cfg.targetState.strategy, 'semantic-distance');
  });

  it('parseConfig rejects missing subagents', () => {
    assert.throws(
      () => new ControllerPipelinePlugin().parseConfig({}),
      /subagents/,
    );
  });

  it('build returns an instance with agent + close', async () => {
    const plugin = new ControllerPipelinePlugin();
    const cfg = plugin.parseConfig({
      subagents: {
        evaluator: { provider: 'openai' },
        planner: { provider: 'openai' },
        executor: { provider: 'openai' },
      },
    });
    const inst = await plugin.build(cfg, fakeControllerServerCtx());
    assert.ok(inst.agent);
    assert.equal(typeof inst.close, 'function');
    await inst.close();
  });
});
