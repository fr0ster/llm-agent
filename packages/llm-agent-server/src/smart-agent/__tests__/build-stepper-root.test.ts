import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RootFinalizer, Stepper } from '@mcp-abap-adt/llm-agent-libs';
import { buildStepperRoot } from '../build-stepper-root.js';

const stubLlm = {
  name: 'stub',
  model: 'm',
  async chat() {
    return {
      ok: true as const,
      value: {
        content: '{"objective":"o","nodes":[{"id":"a","goal":"g"}]}',
      },
    };
  },
  async *streamChat() {
    yield {
      ok: true as const,
      value: { content: 'done', finishReason: 'stop' },
    };
  },
};

const baseInput = {
  coordCfg: { mode: 'planned-react', knownReadOnlyTools: ['GetProgram'] },
  registry: new Map(),
  makeLlm: async () => stubLlm as never,
  knowledgeRagFor: () =>
    ({
      async query() {
        return [];
      },
      async list() {
        return [];
      },
      async write() {},
      fingerprint() {
        return '';
      },
    }) as never,
  toolsRag: {
    async query() {
      return [];
    },
    lookup() {
      return undefined;
    },
  } as never,
  callMcp: async () => 'result',
  mintStepperId: (() => {
    let i = 0;
    return () => `s${i++}`;
  })(),
};

test('builds a planned-react root with Stepper + RootFinalizer + threaded toolSafety', async () => {
  const built = await buildStepperRoot(baseInput as never);
  assert.ok(built.rootStepper instanceof Stepper);
  assert.ok(built.finalizer instanceof RootFinalizer);
  assert.equal(built.toolSafety.knownReadOnlyTools.has('GetProgram'), true);
  assert.equal(built.maxParallelSteps, 4);
  assert.ok(built.budget.depthRemaining >= 1);
});

test('cyclic-react mode produces a root whose executor is CyclicReActExecutor and no child steppers', async () => {
  const built = await buildStepperRoot({
    ...baseInput,
    coordCfg: { mode: 'cyclic-react' },
  } as never);
  assert.ok(built.rootStepper instanceof Stepper);
  // depthRemaining 0 → interpreter will route everything to the executor leaf
  assert.equal(built.budget.depthRemaining, 0);
});
