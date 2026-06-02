import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CyclicFactory } from '../cyclic-factory.js';
import { DeepStepperFactory } from '../deep-stepper-factory.js';
import { PlannedFactory } from '../planned-factory.js';

const stubLlm = {
  name: 'stub',
  model: 'stub',
  async chat() {
    return {
      ok: true as const,
      value: {
        content: 'ok',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    };
  },
};

const deps = {
  makeRoleLlm: async () => stubLlm as never,
  callMcp: async () => '',
  knowledgeRagFor: async () => ({}) as never,
  toolsRag: {} as never,
  mintStepperId: () => 'sid',
  mintTurnId: () => 'tid',
  registry: new Map(),
};

// All required StepperCompositionSpec fields EXCEPT planner/executor.
const cfg = {
  granularity: 'shallow',
  finalizer: 'llm',
  evaluatorEnabled: false,
  evaluatorAtDepths: { has: () => false },
  reviewerAtDepths: { has: () => false },
  maxParallelSteps: 1,
  maxDepth: 2,
  tokenBudget: 100000,
  formalizeTask: false,
} as never;

test('CyclicFactory: kind=cyclic, build() returns a coordinator handler', async () => {
  const f = new CyclicFactory();
  assert.equal(f.kind, 'cyclic');
  const built = await f.build(cfg, deps as never);
  assert.equal(
    typeof built.handler.execute,
    'function',
    'handler is a stage handler',
  );
});

test('PlannedFactory: kind=planned, build() returns a coordinator handler', async () => {
  const f = new PlannedFactory();
  assert.equal(f.kind, 'planned');
  const built = await f.build(cfg, deps as never);
  assert.equal(
    typeof built.handler.execute,
    'function',
    'handler is a stage handler',
  );
});

test('DeepStepperFactory: kind=deep-stepper, build() returns a coordinator handler', async () => {
  const f = new DeepStepperFactory();
  assert.equal(f.kind, 'deep-stepper');
  const built = await f.build(cfg, deps as never);
  assert.equal(
    typeof built.handler.execute,
    'function',
    'handler is a stage handler',
  );
});
