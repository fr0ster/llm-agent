import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ISubAgent } from '@mcp-abap-adt/llm-agent';
import {
  LlmFinalizer,
  PassthroughFinalizer,
  SubAgentStateOracle,
  TemplateFinalizer,
} from '@mcp-abap-adt/llm-agent-libs';
import { buildDagCoordinatorDeps } from '../build-dag-coordinator-deps.js';
import { normalizeLlmConfig } from '../config.js';

const stubLlm = {
  name: 'stub',
  async chat() {
    return {
      ok: true as const,
      value: {
        content: '',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      },
    };
  },
};

function makeOracle(name: string): ISubAgent {
  return {
    name,
    description: 'd',
    capabilities: { contextPolicy: 'optional' },
    async run() {
      return { output: 'X' };
    },
  };
}

function makeWorker(name: string): ISubAgent {
  return {
    name,
    description: 'd',
    capabilities: { contextPolicy: 'optional' },
    async run() {
      return { output: 'W' };
    },
  };
}

test('buildDagCoordinatorDeps: default finalizer is PassthroughFinalizer', async () => {
  const registry = new Map<string, ISubAgent>([['w', makeWorker('w')]]);
  const deps = await buildDagCoordinatorDeps({
    coordCfg: { planner: { type: 'llm' } },
    llmMap: normalizeLlmConfig({
      main: { provider: 'deepseek', apiKey: 'k' },
    } as never),
    pipelineFallback: undefined,
    mainLlm: stubLlm as never,
    helperLlm: undefined,
    mainTemp: 0.5,
    registry,
    makeLlm: async () => stubLlm as never,
    warn: () => {},
  });
  assert.ok(deps);
  assert.ok(deps?.finalizer instanceof PassthroughFinalizer);
  assert.equal(deps?.stateOracle, undefined);
  assert.equal(deps?.reviewer, undefined);
  assert.ok(deps?.planner);
  assert.equal(deps?.workers.size, 1);
});

test('buildDagCoordinatorDeps: type=llm finalizer yields LlmFinalizer', async () => {
  const registry = new Map<string, ISubAgent>([['w', makeWorker('w')]]);
  const deps = await buildDagCoordinatorDeps({
    coordCfg: {
      planner: { type: 'llm' },
      finalizer: { type: 'llm' },
    },
    llmMap: normalizeLlmConfig({
      main: { provider: 'deepseek', apiKey: 'k' },
    } as never),
    pipelineFallback: undefined,
    mainLlm: stubLlm as never,
    helperLlm: undefined,
    mainTemp: 0.5,
    registry,
    makeLlm: async () => stubLlm as never,
    warn: () => {},
  });
  assert.ok(
    deps?.finalizer instanceof LlmFinalizer,
    'type=llm yields LlmFinalizer',
  );
});

test('buildDagCoordinatorDeps: type=template finalizer yields TemplateFinalizer', async () => {
  const registry = new Map<string, ISubAgent>([['w', makeWorker('w')]]);
  const deps = await buildDagCoordinatorDeps({
    coordCfg: {
      planner: { type: 'llm' },
      finalizer: { type: 'template' },
    },
    llmMap: normalizeLlmConfig({
      main: { provider: 'deepseek', apiKey: 'k' },
    } as never),
    pipelineFallback: undefined,
    mainLlm: stubLlm as never,
    helperLlm: undefined,
    mainTemp: 0.5,
    registry,
    makeLlm: async () => stubLlm as never,
    warn: () => {},
  });
  assert.ok(deps?.finalizer instanceof TemplateFinalizer);
});

test('buildDagCoordinatorDeps: stateOracle name resolves and is wrapped in SubAgentStateOracle', async () => {
  const oracle = makeOracle('inspector');
  const registry = new Map<string, ISubAgent>([
    ['w', makeWorker('w')],
    ['inspector', oracle],
  ]);
  const deps = await buildDagCoordinatorDeps({
    coordCfg: { planner: { type: 'llm' }, stateOracle: 'inspector' },
    llmMap: normalizeLlmConfig({
      main: { provider: 'deepseek', apiKey: 'k' },
    } as never),
    pipelineFallback: undefined,
    mainLlm: stubLlm as never,
    helperLlm: undefined,
    mainTemp: 0.5,
    registry,
    makeLlm: async () => stubLlm as never,
    warn: () => {},
  });
  assert.ok(deps?.stateOracle instanceof SubAgentStateOracle);
  assert.equal(deps?.stateOracle?.name, 'inspector');
  // Oracle MUST be excluded from the workers set passed to the DAG.
  assert.equal(deps?.workers.has('inspector'), false);
  assert.equal(deps?.workers.has('w'), true);
});

test('buildDagCoordinatorDeps: returns undefined when planner block is absent (no coordinator)', async () => {
  const registry = new Map<string, ISubAgent>([['w', makeWorker('w')]]);
  const deps = await buildDagCoordinatorDeps({
    coordCfg: { stateOracle: 'inspector' }, // no planner
    llmMap: normalizeLlmConfig({
      main: { provider: 'deepseek', apiKey: 'k' },
    } as never),
    pipelineFallback: undefined,
    mainLlm: stubLlm as never,
    helperLlm: undefined,
    mainTemp: 0.5,
    registry,
    makeLlm: async () => stubLlm as never,
    warn: () => {},
  });
  assert.equal(deps, undefined);
});

test('buildDagCoordinatorDeps: reviewer alias plannerLlm emits a warning', async () => {
  const warnings: string[] = [];
  const registry = new Map<string, ISubAgent>([['w', makeWorker('w')]]);
  await buildDagCoordinatorDeps({
    coordCfg: {
      planner: { type: 'llm' },
      reviewer: { type: 'llm', plannerLlm: 'main' },
    },
    llmMap: normalizeLlmConfig({
      main: { provider: 'deepseek', apiKey: 'k' },
    } as never),
    pipelineFallback: undefined,
    mainLlm: stubLlm as never,
    helperLlm: undefined,
    mainTemp: 0.5,
    registry,
    makeLlm: async () => stubLlm as never,
    warn: (m) => warnings.push(m),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /plannerLlm.*deprecated/i);
});

test('buildDagCoordinatorDeps: pipelineFallback enables type=llm finalizer without top-level llm map', async () => {
  const registry = new Map<string, ISubAgent>([['w', makeWorker('w')]]);
  const deps = await buildDagCoordinatorDeps({
    coordCfg: {
      planner: { type: 'llm' },
      finalizer: { type: 'llm' },
    },
    llmMap: undefined, // no top-level llm: block
    pipelineFallback: {
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-x',
    } as never,
    mainLlm: stubLlm as never,
    helperLlm: undefined,
    mainTemp: 0.5,
    registry,
    makeLlm: async () => stubLlm as never,
    warn: () => {},
  });
  assert.ok(deps?.finalizer instanceof LlmFinalizer);
});

test('buildDagCoordinatorDeps: plannerLlm=helper uses helperLlm even when pipeline.llm.main fallback exists', async () => {
  const registry = new Map<string, ISubAgent>([['w', makeWorker('w')]]);
  const helperLlm = { ...stubLlm, name: 'HELPER' } as never;
  let makeLlmCalls = 0;
  const deps = await buildDagCoordinatorDeps({
    coordCfg: { planner: { type: 'llm', plannerLlm: 'helper' } },
    llmMap: undefined,
    pipelineFallback: {
      provider: 'openai',
      apiKey: 'k',
      model: 'GPT-MAIN',
    } as never,
    mainLlm: stubLlm as never,
    helperLlm,
    mainTemp: 0.5,
    registry,
    makeLlm: async () => {
      makeLlmCalls++;
      return stubLlm as never;
    },
    warn: () => {},
  });
  assert.ok(deps);
  // helperLlm must be used directly without going through makeLlm
  assert.equal(makeLlmCalls, 0, 'helperLlm must be reused, not rebuilt');
});

test('buildDagCoordinatorDeps: reviewerLlm=planner alias also routes to helperLlm', async () => {
  const registry = new Map<string, ISubAgent>([['w', makeWorker('w')]]);
  const helperLlm = { ...stubLlm } as never;
  let makeLlmCalls = 0;
  await buildDagCoordinatorDeps({
    coordCfg: {
      planner: { type: 'llm' },
      reviewer: { type: 'llm', reviewerLlm: 'planner' },
    },
    llmMap: undefined,
    pipelineFallback: {
      provider: 'openai',
      apiKey: 'k',
      model: 'GPT',
    } as never,
    mainLlm: stubLlm as never,
    helperLlm,
    mainTemp: 0.5,
    registry,
    makeLlm: async () => {
      makeLlmCalls++;
      return stubLlm as never;
    },
    warn: () => {},
  });
  assert.equal(
    makeLlmCalls,
    0,
    'helperLlm must be reused for reviewer alias too',
  );
});

test('plannerLlm=helper with FLAT llm: still routes to helperLlm (not main)', async () => {
  const registry = new Map<string, ISubAgent>([['w', makeWorker('w')]]);
  const helperLlm = { ...stubLlm, name: 'HELPER' } as never;
  let makeLlmCalls = 0;
  const deps = await buildDagCoordinatorDeps({
    coordCfg: { planner: { type: 'llm', plannerLlm: 'helper' } },
    // Flat top-level llm: present → normalized to { main: flat }
    llmMap: normalizeLlmConfig({
      provider: 'deepseek',
      apiKey: 'k',
      model: 'main-m',
    } as never),
    pipelineFallback: {
      provider: 'openai',
      apiKey: 'k',
      model: 'GPT-MAIN',
    } as never,
    mainLlm: stubLlm as never,
    helperLlm,
    mainTemp: 0.5,
    registry,
    makeLlm: async () => {
      makeLlmCalls++;
      return stubLlm as never;
    },
    warn: () => {},
  });
  assert.ok(deps);
  assert.equal(
    makeLlmCalls,
    0,
    'helperLlm must be reused, not rebuilt from map.main',
  );
});

test('plannerLlm=helper with MAP without explicit helper entry still routes to helperLlm', async () => {
  const registry = new Map<string, ISubAgent>([['w', makeWorker('w')]]);
  const helperLlm = { ...stubLlm } as never;
  let makeLlmCalls = 0;
  await buildDagCoordinatorDeps({
    coordCfg: { planner: { type: 'llm', plannerLlm: 'helper' } },
    llmMap: normalizeLlmConfig({
      main: { provider: 'deepseek', apiKey: 'k', model: 'main-m' },
      // NO 'helper' key — should alias to helperLlm, not silently use main.
    } as never),
    pipelineFallback: undefined,
    mainLlm: stubLlm as never,
    helperLlm,
    mainTemp: 0.5,
    registry,
    makeLlm: async () => {
      makeLlmCalls++;
      return stubLlm as never;
    },
    warn: () => {},
  });
  assert.equal(makeLlmCalls, 0, 'alias must beat map.main fallback');
});

test('explicit map[helper] WINS over alias (advanced users can override)', async () => {
  const registry = new Map<string, ISubAgent>([['w', makeWorker('w')]]);
  const helperLlm = { ...stubLlm } as never;
  let makeLlmCalls = 0;
  let askedFor: string | undefined;
  await buildDagCoordinatorDeps({
    coordCfg: { planner: { type: 'llm', plannerLlm: 'helper' } },
    llmMap: normalizeLlmConfig({
      main: { provider: 'deepseek', apiKey: 'k', model: 'main-m' },
      helper: { provider: 'openai', apiKey: 'k', model: 'EXPLICIT-HELPER' },
    } as never),
    pipelineFallback: undefined,
    mainLlm: stubLlm as never,
    helperLlm,
    mainTemp: 0.5,
    registry,
    makeLlm: async (cfg) => {
      makeLlmCalls++;
      askedFor = (cfg as { model?: string }).model;
      return stubLlm as never;
    },
    warn: () => {},
  });
  assert.equal(makeLlmCalls, 1, 'explicit map entry must build a fresh LLM');
  assert.equal(
    askedFor,
    'EXPLICIT-HELPER',
    'explicit entry beats helperLlm alias',
  );
});
