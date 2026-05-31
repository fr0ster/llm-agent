import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IExecutor, IStepper, StreamChunk } from '@mcp-abap-adt/llm-agent';
import { TokenLedger } from '@mcp-abap-adt/llm-agent';
import { StepperInterpreter } from '../stepper-interpreter.js';

const ZERO = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function okExecutor(): { exec: IExecutor; calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    exec: {
      name: 'e',
      async execute() {
        calls++;
        return { status: 'ok', usage: ZERO };
      },
    },
  };
}

function spyStepper(name: string): { st: IStepper; runs: number } {
  let runs = 0;
  return {
    get runs() {
      return runs;
    },
    st: {
      name,
      async run() {
        runs++;
        return { status: 'ok', usage: ZERO };
      },
    },
  };
}

let counter = 0;
const baseCtx = (
  over: Partial<Parameters<StepperInterpreter['interpret']>[1]>,
) => ({
  prompt: 'p',
  knowledgeRag: {
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
  } as never,
  toolsRag: {
    async query() {
      return [];
    },
    lookup() {
      return undefined;
    },
  } as never,
  childSteppers: new Map(),
  executor: okExecutor().exec,
  budget: { depthRemaining: 3, tokens: new TokenLedger(100000) },
  identity: { traceId: 't', turnId: 'u', sessionId: 's', stepperId: 'n0' },
  maxParallelSteps: 4,
  mintStepperId: () => `s${counter++}`,
  ...over,
});

test('H.4b depth floor routes subagent node to executor; child.run NOT called; spawned event is the executor virtual ref', async () => {
  counter = 0;
  const child = spyStepper('w');
  const ex = okExecutor();
  const events: StreamChunk[] = [];
  const interp = new StepperInterpreter();
  const res = await interp.interpret(
    {
      objective: 'o',
      nodes: [{ id: 'a', goal: 'g', agent: 'w' }],
      createdAt: 0,
    },
    baseCtx({
      childSteppers: new Map([['w', child.st]]),
      executor: ex.exec,
      budget: { depthRemaining: 0, tokens: new TokenLedger(100000) }, // floor
      onProgress: (e) => events.push(e),
    }),
  );
  assert.equal(res.status, 'ok');
  assert.equal(
    child.runs,
    0,
    'recursion did not happen — child Stepper run() never invoked',
  );
  assert.equal(ex.calls, 1, 'dispatched to executor instead');
  // A stepper-spawned IS emitted, but for the executor virtual ref (name 'executor'), not the subagent 'w'.
  const spawned = events.find((e) => e.kind === 'stepper-spawned');
  assert.ok(spawned && spawned.kind === 'stepper-spawned');
  assert.equal(
    (spawned as { source: { name: string } }).source.name,
    'executor',
  );
});

test('depth > 0 spawns recursive child stepper with parentStepperId set', async () => {
  counter = 0;
  const child = spyStepper('w');
  const events: StreamChunk[] = [];
  const interp = new StepperInterpreter();
  await interp.interpret(
    {
      objective: 'o',
      nodes: [{ id: 'a', goal: 'g', agent: 'w' }],
      createdAt: 0,
    },
    baseCtx({
      childSteppers: new Map([['w', child.st]]),
      budget: { depthRemaining: 2, tokens: new TokenLedger(100000) },
      onProgress: (e) => events.push(e),
    }),
  );
  assert.equal(child.runs, 1, 'recursive child spawned above floor');
  const spawned = events.find((e) => e.kind === 'stepper-spawned');
  assert.ok(
    spawned &&
      spawned.kind === 'stepper-spawned' &&
      spawned.source.parentStepperId === 'n0',
  );
});

test('agentless node goes straight to executor', async () => {
  counter = 0;
  const ex = okExecutor();
  const interp = new StepperInterpreter();
  await interp.interpret(
    { objective: 'o', nodes: [{ id: 'a', goal: 'g' }], createdAt: 0 },
    baseCtx({ executor: ex.exec }),
  );
  assert.equal(ex.calls, 1);
});

test('unknown agent with no executable leaf returns incomplete', async () => {
  counter = 0;
  const interp = new StepperInterpreter();
  const res = await interp.interpret(
    {
      objective: 'o',
      nodes: [{ id: 'a', goal: 'g', agent: 'missing' }],
      createdAt: 0,
    },
    baseCtx({
      childSteppers: new Map(),
      executor: undefined as never,
      budget: { depthRemaining: 2, tokens: new TokenLedger(1) },
    }),
  );
  assert.equal(res.status, 'incomplete');
  assert.ok(res.missing && res.missing.length > 0);
});

test('maxParallelSteps caps concurrency at 2', async () => {
  counter = 0;
  let active = 0;
  let peak = 0;
  const slow: IStepper = {
    name: 'w',
    async run() {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { status: 'ok', usage: ZERO };
    },
  };
  const interp = new StepperInterpreter();
  await interp.interpret(
    {
      objective: 'o',
      nodes: [
        { id: 'a', goal: 'g', agent: 'w' },
        { id: 'b', goal: 'g', agent: 'w' },
        { id: 'c', goal: 'g', agent: 'w' },
        { id: 'd', goal: 'g', agent: 'w' },
      ],
      createdAt: 0,
    },
    baseCtx({
      childSteppers: new Map([['w', slow]]),
      maxParallelSteps: 2,
      budget: { depthRemaining: 2, tokens: new TokenLedger(100000) },
    }),
  );
  assert.ok(peak <= 2, `peak concurrency ${peak} must be ≤ 2`);
});
