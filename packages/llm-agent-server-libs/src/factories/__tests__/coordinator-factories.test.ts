import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DagFactory } from '../dag-factory.js';
import { LinearFactory } from '../linear-factory.js';

// ---------------------------------------------------------------------------
// Minimal stubs for DagCoordinatorHandlerDeps
// ---------------------------------------------------------------------------

const stubPlanner = {
  name: 'stub-planner',
  async plan(inp: { prompt: string }) {
    return {
      objective: inp.prompt,
      nodes: [],
      createdAt: 0,
    };
  },
};

const stubInterpreter = {
  async interpret() {
    return { output: 'stub', steps: [] };
  },
};

const dagConfig = {
  planner: stubPlanner as never,
  interpreter: stubInterpreter as never,
  workers: new Map(),
};

// ---------------------------------------------------------------------------
// Minimal stubs for CoordinatorHandlerDeps (LinearFactory)
// ---------------------------------------------------------------------------

const stubPlanningStrategy = {
  async buildInitialPlan(ctx: { inputText: string }) {
    return {
      steps: [],
      source: 'planner-llm' as const,
      clarification: undefined,
      inputText: ctx.inputText,
    };
  },
};

const stubDispatch = {
  async dispatch() {
    return { ok: true, output: '' };
  },
};

const linearConfig = {
  planning: stubPlanningStrategy as never,
  dispatch: stubDispatch as never,
  maxSteps: 5,
  maxRetriesPerStep: 1,
  failPolicy: 'abort' as const,
};

// ---------------------------------------------------------------------------
// Base deps (unused by these factories, required by IPipelineFactory signature)
// ---------------------------------------------------------------------------

const baseDeps = {
  makeRoleLlm: async () => ({}) as never,
  callMcp: async () => '',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('DagFactory: kind=dag, build() returns a coordinator handler', async () => {
  const f = new DagFactory();
  assert.equal(f.kind, 'dag');
  const built = await f.build(dagConfig, baseDeps as never);
  assert.equal(
    typeof built.handler.execute,
    'function',
    'handler is a stage handler',
  );
});

test('LinearFactory: kind=linear, build() returns a coordinator handler', async () => {
  const f = new LinearFactory();
  assert.equal(f.kind, 'linear');
  const built = await f.build(linearConfig, baseDeps as never);
  assert.equal(
    typeof built.handler.execute,
    'function',
    'handler is a stage handler',
  );
});
