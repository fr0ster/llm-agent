import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IExecutor } from '../executor.js';
import { InsufficientSignal } from '../insufficient-signal.js';
import type { INeedResolver } from '../need-resolver.js';
import { TokenLedger } from '../stepper.js';
import type { IStepperInterpreter } from '../stepper-interpreter.js';
import type { IStepperPlanner } from '../stepper-planner.js';

test('IExecutor return union includes budget-exhausted', async () => {
  const ex: IExecutor = {
    name: 'e',
    async execute() {
      return {
        status: 'budget-exhausted',
        usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
      };
    },
  };
  const r = await ex.execute({
    prompt: 'p',
    tools: [],
    knowledgeRag: {} as never,
    toolsRag: {} as never,
    budget: { depthRemaining: 0, tokens: new TokenLedger(0) },
    identity: { traceId: 't', turnId: 'u', sessionId: 's', stepperId: 'n' },
  });
  assert.equal(r.status, 'budget-exhausted');
});

test('INeedResolver returns augmentation or undefined', async () => {
  const nr: INeedResolver = {
    async resolve(s) {
      return /can.?t|need/i.test(s)
        ? { queryToolsRag: 'read program' }
        : undefined;
    },
  };
  assert.deepEqual(await nr.resolve("I can't read it"), {
    queryToolsRag: 'read program',
  });
  assert.equal(await nr.resolve('done'), undefined);
});

test('InsufficientSignal carries missing[]', () => {
  const sig = new InsufficientSignal(['source code']);
  assert.ok(sig instanceof Error);
  assert.deepEqual(sig.missing, ['source code']);
});

test('planner + interpreter shapes compile', () => {
  const p: IStepperPlanner = {
    name: 'p',
    async plan() {
      return { objective: 'o', nodes: [], createdAt: 0 };
    },
  };
  const i: IStepperInterpreter = {
    name: 'i',
    async interpret() {
      return {
        status: 'ok',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  };
  assert.equal(p.name, 'p');
  assert.equal(i.name, 'i');
});
