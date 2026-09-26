import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseControllerSettings } from '../../smart-agent/pipeline-settings.js';
import { controllerPlugin, fakeControllerServerCtx } from './fixtures.js';

describe('ControllerPipelinePlugin', () => {
  it('parseControllerSettings defaults budgets/targetState/sessionMemory and requires subagents', () => {
    const cfg = parseControllerSettings({
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

  it('parseControllerSettings merges provided overrides over defaults', () => {
    const cfg = parseControllerSettings({
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

  it('parseControllerSettings rejects missing subagents', () => {
    assert.throws(() => parseControllerSettings({}), /subagents/);
  });

  it('parseControllerSettings rejects a removed planner: key with a migration message', () => {
    assert.throws(
      () =>
        parseControllerSettings({
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

  it('parseControllerSettings accepts a controller config with no planner key', () => {
    const cfg = parseControllerSettings({
      subagents: {
        evaluator: { provider: 'openai' },
        planner: { provider: 'openai' },
        executor: { provider: 'openai' },
      },
    });
    // no throw; planner selection is preset-encoded (not on the parsed config)
    assert.ok(!('planner' in cfg));
  });

  it('parseControllerSettings defaults the board-budget knobs', () => {
    const cfg = parseControllerSettings({
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

  it('parseControllerSettings lets explicit budgets override board defaults', () => {
    const cfg = parseControllerSettings({
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

  it('parseControllerSettings defaults the wait knobs', () => {
    const cfg = parseControllerSettings({
      subagents: {
        evaluator: { provider: 'openai' },
        planner: { provider: 'openai' },
        executor: { provider: 'openai' },
      },
    });
    assert.equal(cfg.budgets.maxWaitMs, 600_000);
    assert.equal(cfg.budgets.maxTotalWaitMs, 1_800_000);
  });

  it('parseControllerSettings honours explicit wait knobs', () => {
    const cfg = parseControllerSettings({
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
    it(`parseControllerSettings throws for maxWaitMs=${String(bad)}`, () => {
      assert.throws(
        () =>
          parseControllerSettings({
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
    it(`parseControllerSettings throws for maxTotalWaitMs=${String(bad)}`, () => {
      assert.throws(
        () =>
          parseControllerSettings({
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
    const inst = await controllerPlugin().build(fakeControllerServerCtx());
    assert.ok(inst.agent);
    assert.equal(typeof inst.close, 'function');
    await inst.close();
  });
});
