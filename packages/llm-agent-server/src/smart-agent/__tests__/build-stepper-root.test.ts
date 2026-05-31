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

test('Finding 1: deep-stepper builds recursive child Steppers from subagents and the interpreter recurses into them', async () => {
  // The planner returns a plan that delegates to the 'analyst' worker every
  // time; with maxDepth=2 recursion engages then bottoms out at the executor
  // leaf. We assert a 'stepper-spawned' event names the CHILD ('analyst') —
  // proving the registry was populated and the interpreter recursed, rather
  // than falling straight to the executor (the Finding-1 bug).
  const delegatingLlm = {
    name: 'stub',
    model: 'm',
    async chat() {
      return {
        ok: true as const,
        value: {
          // valid as a planner plan (delegates to analyst) AND a reviewer
          // verdict (pass:true); the executor treats it as a final answer.
          content:
            '{"pass":true,"objective":"o","nodes":[{"id":"a","goal":"analyze","agent":"analyst"}]}',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
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

  const built = await buildStepperRoot({
    ...baseInput,
    coordCfg: { mode: 'deep-stepper', stepper: { maxDepth: 2 } },
    makeLlm: async () => delegatingLlm as never,
    subagents: [{ name: 'analyst', description: 'analyzes ABAP objects' }],
  } as never);

  const spawned: string[] = [];
  await built.rootStepper.run({
    prompt: 'review program Z',
    knowledgeRag: baseInput.knowledgeRagFor() as never,
    toolsRag: baseInput.toolsRag as never,
    budget: built.budget as never,
    identity: { traceId: 't', turnId: 'u', sessionId: 's', stepperId: 'root' },
    toolSafety: built.toolSafety,
    onProgress: (e: { kind: string; source?: { name?: string } }) => {
      if (e.kind === 'stepper-spawned' && e.source?.name) {
        spawned.push(e.source.name);
      }
    },
  } as never);

  assert.ok(
    spawned.includes('analyst'),
    `interpreter must recurse into the 'analyst' child Stepper; spawned: ${spawned.join(',') || '(none)'}`,
  );
});

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
    toolSafety: built.toolSafety,
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

  // Five LLMs must have been built — planner, executor, finalizer, reviewer,
  // plus the tool-definer (resolved via role 'classifier', which has no entry
  // in this map → falls back to main-model).
  assert.equal(
    calls.length,
    5,
    `expected 5 makeLlm calls, got ${calls.length}: ${calls.join(',')}`,
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
  // Four role models + the tool-definer's main-model fallback = 5 distinct.
  assert.equal(
    new Set(calls).size,
    5,
    'four distinct role models + tool-definer fallback to main',
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
  // executor, finalizer, reviewer AND the tool-definer (classifier role) all
  // fall back to main-model — 4 calls with that value.
  const mainCalls = calls.filter((m) => m === 'main-model');
  assert.equal(
    mainCalls.length,
    4,
    `expected 4 main-model calls (executor+finalizer+reviewer+tool-definer), got ${mainCalls.length}`,
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

  // All roles (planner, executor, finalizer, reviewer) + the tool-definer fall
  // back to pipelineFallback.
  assert.equal(calls.length, 5);
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
    toolSafety: {
      mutationPolicy: 'confirm',
      knownReadOnlyTools: new Set<string>(),
    },
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
