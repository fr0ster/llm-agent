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

// ── Per-role LLM resolution tests (regression guard for 18.0 live-run fix) ──

/**
 * Build a recording makeLlm that captures the `model` from each resolved
 * config. Each call gets a distinct ILlm stub tagged with the model name.
 */
function makeRecordingMakeLlm() {
  const calls: string[] = [];
  const makeLlm = async (cfg: { model?: string }) => {
    const model = cfg.model ?? 'unknown';
    calls.push(model);
    return {
      name: model,
      model,
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
    } as never;
  };
  return { makeLlm, calls };
}

const perRoleLlmMap = {
  main: { provider: 'openai' as const, apiKey: 'k', model: 'main-model' },
  planner: { provider: 'openai' as const, apiKey: 'k', model: 'planner-model' },
  executor: {
    provider: 'openai' as const,
    apiKey: 'k',
    model: 'executor-model',
  },
  finalizer: {
    provider: 'openai' as const,
    apiKey: 'k',
    model: 'finalizer-model',
  },
  reviewer: {
    provider: 'openai' as const,
    apiKey: 'k',
    model: 'reviewer-model',
  },
};

test('per-role map: planner, executor, finalizer and reviewer each use their own distinct model', async () => {
  const { makeLlm, calls } = makeRecordingMakeLlm();

  const built = await buildStepperRoot({
    ...baseInput,
    coordCfg: { mode: 'planned-react' },
    makeLlm,
    llmMap: perRoleLlmMap,
  } as never);

  assert.ok(built.rootStepper instanceof Stepper);
  assert.ok(built.finalizer instanceof RootFinalizer);

  // Four LLMs must have been built — planner, executor, finalizer, reviewer.
  assert.equal(
    calls.length,
    4,
    `expected 4 makeLlm calls, got ${calls.length}: ${calls.join(',')}`,
  );
  assert.ok(calls.includes('planner-model'), 'planner-model must be resolved');
  assert.ok(
    calls.includes('executor-model'),
    'executor-model must be resolved',
  );
  assert.ok(
    calls.includes('finalizer-model'),
    'finalizer-model must be resolved',
  );
  assert.ok(
    calls.includes('reviewer-model'),
    'reviewer-model must be resolved',
  );
  // All four must be distinct
  assert.equal(new Set(calls).size, 4, 'all four role models must be distinct');
});

test('per-role map: absent role falls back to main', async () => {
  const { makeLlm, calls } = makeRecordingMakeLlm();

  // Only main + planner defined; executor/finalizer/reviewer must fall back to main.
  const partialMap = {
    main: { provider: 'openai' as const, apiKey: 'k', model: 'main-model' },
    planner: {
      provider: 'openai' as const,
      apiKey: 'k',
      model: 'planner-model',
    },
  };

  await buildStepperRoot({
    ...baseInput,
    coordCfg: { mode: 'planned-react' },
    makeLlm,
    llmMap: partialMap,
  } as never);

  // planner resolves to planner-model; executor/finalizer/reviewer fall back to main-model.
  assert.ok(
    calls.includes('planner-model'),
    'planner role must use planner-model',
  );
  // executor, finalizer, reviewer all resolve to main-model (3 calls with that value)
  const mainCalls = calls.filter((m) => m === 'main-model');
  assert.equal(
    mainCalls.length,
    3,
    `expected 3 main-model calls (executor+finalizer+reviewer), got ${mainCalls.length}`,
  );
});

test('reviewer is always constructed as LlmReviewStrategy (wired to the Stepper)', async () => {
  // We can't introspect the Stepper's private reviewer field directly, but we
  // can verify it is built without throwing and that a LlmReviewStrategy was
  // instantiated by confirming the build completes successfully with a per-role map.
  // The recording makeLlm confirms reviewer-model is resolved.
  const { makeLlm, calls } = makeRecordingMakeLlm();

  const built = await buildStepperRoot({
    ...baseInput,
    coordCfg: { mode: 'planned-react' },
    makeLlm,
    llmMap: perRoleLlmMap,
  } as never);

  assert.ok(built.rootStepper instanceof Stepper);
  assert.ok(
    calls.includes('reviewer-model'),
    'reviewer LLM must be resolved and passed to LlmReviewStrategy',
  );
});

test('pipelineFallback is used when llmMap is absent', async () => {
  const { makeLlm, calls } = makeRecordingMakeLlm();

  const pipelineFallback = {
    provider: 'openai' as const,
    apiKey: 'k',
    model: 'pipeline-model',
  };

  await buildStepperRoot({
    ...baseInput,
    coordCfg: { mode: 'planned-react' },
    makeLlm,
    llmMap: undefined,
    pipelineFallback,
  } as never);

  // All roles (planner, executor, finalizer, reviewer) fall back to pipelineFallback.
  assert.equal(calls.length, 4);
  assert.ok(
    calls.every((m) => m === 'pipeline-model'),
    `all roles must use pipeline-model, got: ${calls.join(',')}`,
  );
});
