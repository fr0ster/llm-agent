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

  it('parseConfig rejects a removed planner: key with a migration message', () => {
    const plugin = new ControllerPipelinePlugin();
    assert.throws(
      () =>
        plugin.parseConfig({
          subagents: {
            evaluator: { provider: 'openai' },
            planner: { provider: 'openai' },
            executor: { provider: 'openai' },
          },
          planner: 'adaptive',
        }),
      /planner:.*removed|capability is preset-encoded|controller-weak/,
    );
  });

  it('parseConfig accepts a controller config with no planner key', () => {
    const plugin = new ControllerPipelinePlugin();
    const cfg = plugin.parseConfig({
      subagents: {
        evaluator: { provider: 'openai' },
        planner: { provider: 'openai' },
        executor: { provider: 'openai' },
      },
    });
    // no throw; planner selection is preset-encoded (not on the parsed config)
    assert.ok(!('planner' in cfg));
  });

  it('parseConfig defaults the board-budget knobs', () => {
    const plugin = new ControllerPipelinePlugin();
    const cfg = plugin.parseConfig({
      subagents: {
        evaluator: { provider: 'openai' },
        planner: { provider: 'openai' },
        executor: { provider: 'openai' },
      },
    });
    assert.equal(cfg.budgets.maxDigestChars, 500);
    assert.equal(cfg.budgets.maxBoardChars, 12000);
    assert.equal(cfg.budgets.keepRecentDigests, 8);
  });

  it('parseConfig lets explicit budgets override board defaults', () => {
    const plugin = new ControllerPipelinePlugin();
    const cfg = plugin.parseConfig({
      subagents: {
        evaluator: { provider: 'openai' },
        planner: { provider: 'openai' },
        executor: { provider: 'openai' },
      },
      budgets: { maxBoardChars: 9000 },
    });
    assert.equal(cfg.budgets.maxBoardChars, 9000);
    assert.equal(cfg.budgets.maxDigestChars, 500); // untouched default
  });

  it('parseConfig defaults the wait knobs', () => {
    const plugin = new ControllerPipelinePlugin();
    const cfg = plugin.parseConfig({
      subagents: {
        evaluator: { provider: 'openai' },
        planner: { provider: 'openai' },
        executor: { provider: 'openai' },
      },
    });
    assert.equal(cfg.budgets.maxWaitMs, 600_000);
    assert.equal(cfg.budgets.maxTotalWaitMs, 1_800_000);
  });

  it('parseConfig honours explicit wait knobs', () => {
    const plugin = new ControllerPipelinePlugin();
    const cfg = plugin.parseConfig({
      subagents: {
        evaluator: { provider: 'openai' },
        planner: { provider: 'openai' },
        executor: { provider: 'openai' },
      },
      budgets: { maxWaitMs: 90_000, maxTotalWaitMs: 0 },
    });
    assert.equal(cfg.budgets.maxWaitMs, 90_000);
    assert.equal(cfg.budgets.maxTotalWaitMs, 0);
  });

  for (const bad of ['600000', Number.NaN, -1, 0, 1.5]) {
    it(`parseConfig throws for maxWaitMs=${String(bad)}`, () => {
      const plugin = new ControllerPipelinePlugin();
      assert.throws(
        () =>
          plugin.parseConfig({
            subagents: {
              evaluator: { provider: 'openai' },
              planner: { provider: 'openai' },
              executor: { provider: 'openai' },
            },
            budgets: { maxWaitMs: bad },
          }),
        /maxWaitMs/,
      );
    });
  }

  for (const bad of ['1800000', Number.NaN, -1, 1.5]) {
    it(`parseConfig throws for maxTotalWaitMs=${String(bad)}`, () => {
      const plugin = new ControllerPipelinePlugin();
      assert.throws(
        () =>
          plugin.parseConfig({
            subagents: {
              evaluator: { provider: 'openai' },
              planner: { provider: 'openai' },
              executor: { provider: 'openai' },
            },
            budgets: { maxTotalWaitMs: bad },
          }),
        /maxTotalWaitMs/,
      );
    });
  }

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
