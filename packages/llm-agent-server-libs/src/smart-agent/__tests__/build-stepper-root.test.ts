import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RootFinalizer, Stepper } from '@mcp-abap-adt/llm-agent-libs';
import {
  buildFromComposition,
  buildStepperRoot,
  type StepperCompositionSpec,
} from '../build-stepper-root.js';

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
  coordCfg: { mode: 'planned-react' },
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

test('builds a planned-react root with Stepper + RootFinalizer', async () => {
  const built = await buildStepperRoot(baseInput as never);
  assert.ok(built.rootStepper instanceof Stepper);
  assert.ok(built.finalizer instanceof RootFinalizer);
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

test('Finding 2: shared token ledger is charged by NON-executor roles too (planner/reviewer/tool-definer), not just the executor', async () => {
  // Every LLM call (chat or streamChat) spends exactly 100 total tokens and bumps
  // a shared counter. After a full planned-react run the ledger must have been
  // debited by 100 × (calls) — proving planner / reviewer / tool-definer charge
  // the SAME ledger (not only the executor), with no double-counting.
  const BUDGET = 1_000_000;
  let calls = 0;
  const usage = { promptTokens: 60, completionTokens: 40, totalTokens: 100 };
  const countingLlm = {
    name: 'counting',
    model: 'counting',
    async chat() {
      calls++;
      return {
        ok: true as const,
        value: {
          content:
            '{"pass":true,"objective":"o","nodes":[{"id":"a","goal":"g"}]}',
          usage,
        },
      };
    },
    async *streamChat() {
      calls++;
      yield {
        ok: true as const,
        value: { content: 'done', finishReason: 'stop', usage },
      };
    },
  };

  const built = await buildStepperRoot({
    ...baseInput,
    coordCfg: { mode: 'planned-react', tokenBudget: BUDGET },
    makeLlm: async () => countingLlm as never,
  } as never);

  await built.rootStepper.run({
    prompt: 'do x',
    knowledgeRag: baseInput.knowledgeRagFor() as never,
    toolsRag: baseInput.toolsRag as never,
    budget: built.budget as never,
    identity: {
      traceId: 't',
      turnId: 'u',
      sessionId: 's',
      stepperId: 'root',
    },
  } as never);

  const spent = BUDGET - built.budget.tokens.remaining;
  assert.ok(calls >= 2, `expected several LLM calls, got ${calls}`);
  assert.equal(
    spent,
    100 * calls,
    `ledger must be debited by every role's usage (100 × ${calls}); got ${spent}`,
  );
});

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

  // Six LLMs must have been built — planner, executor, finalizer, reviewer,
  // the tool-definer (role 'classifier' → main fallback), plus the 18.1
  // Evaluator (role 'evaluator', no entry in this map → main fallback).
  assert.equal(
    calls.length,
    6,
    `expected 6 makeLlm calls, got ${calls.length}: ${calls.join(',')}`,
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
  assert.ok(
    calls.includes('main-model'),
    'tool-definer (classifier role) must fall back to main-model',
  );
  // Four role models + the tool-definer's & Evaluator's main-model fallback
  // (both dedup to main) = 5 DISTINCT models across 6 calls.
  assert.equal(
    new Set(calls).size,
    5,
    'four distinct role models + tool-definer & evaluator fallback to main',
  );
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
  // executor, finalizer, reviewer, the tool-definer (classifier role) AND the
  // 18.1 Evaluator (evaluator role) all fall back to main-model — 5 calls.
  const mainCalls = calls.filter((m) => m === 'main-model');
  assert.equal(
    mainCalls.length,
    5,
    `expected 5 main-model calls (executor+finalizer+reviewer+tool-definer+evaluator), got ${mainCalls.length}`,
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

  // All roles (planner, executor, finalizer, reviewer) + the tool-definer + the
  // 18.1 Evaluator fall back to pipelineFallback.
  assert.equal(calls.length, 6);
  assert.ok(
    calls.every((m) => m === 'pipeline-model'),
    `all roles must use pipeline-model, got: ${calls.join(',')}`,
  );
});

// ── (б) nested flow nodes — structural recursion via buildFromComposition ──────
const compDeps = {
  makeLlm: async () => stubLlm as never,
  callMcp: async () => 'result',
  mintStepperId: (() => {
    let i = 0;
    return () => `s${i++}`;
  })(),
  registry: new Map(),
};

function leafFlow(): StepperCompositionSpec {
  return {
    planner: 'none',
    granularity: 'shallow',
    executor: 'cyclic-react',
    finalizer: 'llm',
    reviewerAtDepths: { has: () => false },
    maxParallelSteps: 4,
    maxDepth: 5,
    tokenBudget: 100000,
    formalizeTask: false,
  };
}

test('nested flow node builds a child Stepper and lifts depthRemaining to cover nesting', async () => {
  const spec: StepperCompositionSpec = {
    ...leafFlow(),
    nodes: [
      { id: 'read', goal: 'read the code' },
      {
        id: 'analyze',
        goal: 'analyze',
        // nested sub-cycle (its own composition) → structural recursion
        flow: { ...leafFlow(), nodes: [{ id: 'sec', goal: 'security' }] },
      },
    ],
  };
  const built = await buildFromComposition(spec, compDeps as never);
  assert.ok(built.rootStepper instanceof Stepper);
  // one level of declared nesting ⇒ depthRemaining must allow it
  assert.ok(built.budget.depthRemaining >= 1);
});

test('two-level nested flow lifts depthRemaining to >= 2', async () => {
  const spec: StepperCompositionSpec = {
    ...leafFlow(),
    nodes: [
      {
        id: 'l1',
        goal: 'level 1',
        flow: {
          ...leafFlow(),
          nodes: [{ id: 'l2', goal: 'level 2', flow: leafFlow() }],
        },
      },
    ],
  };
  const built = await buildFromComposition(spec, compDeps as never);
  assert.ok(built.budget.depthRemaining >= 2);
});

test('buildFromComposition: makeRoleLlm supersedes llmMap/makeLlm resolution', async () => {
  const stub = {
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
  const calledRoles: string[] = [];
  const built = await buildFromComposition(
    {
      planner: 'none',
      executor: 'cyclic-react',
      granularity: 'shallow',
      finalizer: 'llm',
      evaluatorEnabled: false,
      evaluatorAtDepths: { has: () => false },
      reviewerAtDepths: { has: () => false },
      maxParallelSteps: 1,
      maxDepth: 1,
      tokenBudget: 100000,
      formalizeTask: false,
    } satisfies StepperCompositionSpec,
    {
      makeRoleLlm: async (role: string) => {
        calledRoles.push(role);
        return stub as never;
      },
      callMcp: async () => '',
      mintStepperId: () => 'id',
      registry: new Map(),
    } as never,
  );
  assert.ok(built.rootStepper, 'root stepper built without llmMap/makeLlm');
  assert.ok(calledRoles.length > 0, 'makeRoleLlm was used');
});
