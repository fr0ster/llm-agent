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
  assert.ok(deps?.finalizer instanceof LlmFinalizer);
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
