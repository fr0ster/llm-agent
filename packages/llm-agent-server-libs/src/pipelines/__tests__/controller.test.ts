import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseControllerSettings } from '../../smart-agent/pipeline-settings.js';
import { controllerPlugin, fakeControllerServerCtx } from './fixtures.js';

const LLM_KEYS = new Set(['main']);
const MIN_SUBAGENTS = { evaluator: {}, planner: {}, executor: {} };

describe('ControllerPipelinePlugin', () => {
  it('parseControllerSettings defaults budgets/targetState/sessionMemory and requires subagents', () => {
    const cfg = parseControllerSettings({ subagents: MIN_SUBAGENTS }, LLM_KEYS);
    assert.equal(cfg.budgets.maxSteps, 20);
    assert.equal(cfg.budgets.maxToolCalls, 10);
    assert.equal(cfg.targetState.strategy, 'auto');
    assert.equal(cfg.targetState.distanceThreshold, 0.25);
    assert.equal(cfg.sessionMemory.collection, 'session-memory');
  });

  it('parseControllerSettings merges provided overrides over defaults', () => {
    const cfg = parseControllerSettings(
      {
        subagents: MIN_SUBAGENTS,
        budgets: { maxSteps: 5 },
        targetState: { strategy: 'semantic-distance' },
      },
      LLM_KEYS,
    );
    assert.equal(cfg.budgets.maxSteps, 5);
    assert.equal(cfg.budgets.maxRetries, 3);
    assert.equal(cfg.targetState.strategy, 'semantic-distance');
  });

  it('parseControllerSettings rejects missing subagents', () => {
    assert.throws(() => parseControllerSettings({}, LLM_KEYS), /subagents/);
  });

  it('parseControllerSettings rejects a removed planner: key with a migration message', () => {
    assert.throws(
      () =>
        parseControllerSettings(
          {
            subagents: MIN_SUBAGENTS,
            planner: 'adaptive',
          },
          LLM_KEYS,
        ),
      /planner:.*removed|capability is preset-encoded|controller-weak/,
    );
  });

  it('parseControllerSettings accepts a controller config with no planner key', () => {
    const cfg = parseControllerSettings({ subagents: MIN_SUBAGENTS }, LLM_KEYS);
    // no throw; planner selection is preset-encoded (not on the parsed config)
    assert.ok(!('planner' in cfg));
  });

  it('parseControllerSettings defaults the board-budget knobs', () => {
    const cfg = parseControllerSettings({ subagents: MIN_SUBAGENTS }, LLM_KEYS);
    assert.equal(cfg.budgets.maxDigestChars, 500);
    assert.equal(cfg.budgets.maxBoardChars, 12000);
    assert.equal(cfg.budgets.keepRecentDigests, 8);
  });

  it('parseControllerSettings lets explicit budgets override board defaults', () => {
    const cfg = parseControllerSettings(
      {
        subagents: MIN_SUBAGENTS,
        budgets: { maxBoardChars: 9000 },
      },
      LLM_KEYS,
    );
    assert.equal(cfg.budgets.maxBoardChars, 9000);
    assert.equal(cfg.budgets.maxDigestChars, 500); // untouched default
  });

  it('parseControllerSettings defaults the wait knobs', () => {
    const cfg = parseControllerSettings({ subagents: MIN_SUBAGENTS }, LLM_KEYS);
    assert.equal(cfg.budgets.maxWaitMs, 600_000);
    assert.equal(cfg.budgets.maxTotalWaitMs, 1_800_000);
  });

  it('parseControllerSettings honours explicit wait knobs', () => {
    const cfg = parseControllerSettings(
      {
        subagents: MIN_SUBAGENTS,
        budgets: { maxWaitMs: 90_000, maxTotalWaitMs: 0 },
      },
      LLM_KEYS,
    );
    assert.equal(cfg.budgets.maxWaitMs, 90_000);
    assert.equal(cfg.budgets.maxTotalWaitMs, 0);
  });

  for (const bad of ['600000', Number.NaN, -1, 0, 1.5]) {
    it(`parseControllerSettings throws for maxWaitMs=${String(bad)}`, () => {
      assert.throws(
        () =>
          parseControllerSettings(
            {
              subagents: MIN_SUBAGENTS,
              budgets: { maxWaitMs: bad },
            },
            LLM_KEYS,
          ),
        /maxWaitMs/,
      );
    });
  }

  for (const bad of ['1800000', Number.NaN, -1, 1.5]) {
    it(`parseControllerSettings throws for maxTotalWaitMs=${String(bad)}`, () => {
      assert.throws(
        () =>
          parseControllerSettings(
            {
              subagents: MIN_SUBAGENTS,
              budgets: { maxTotalWaitMs: bad },
            },
            LLM_KEYS,
          ),
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
