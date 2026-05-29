import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IStepperInterpreter,
  IStepperPlanner,
} from '@mcp-abap-adt/llm-agent';
import { TokenLedger } from '@mcp-abap-adt/llm-agent';
import { Stepper } from '../stepper.js';

const ZERO = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

const planner: IStepperPlanner = {
  name: 'p',
  async plan() {
    return { objective: 'o', nodes: [{ id: 'a', goal: 'g' }], createdAt: 0 };
  },
};

function spyInterp(): { it: IStepperInterpreter; planSeen: number } {
  let planSeen = 0;
  return {
    get planSeen() {
      return planSeen;
    },
    it: {
      name: 'i',
      async interpret(plan) {
        planSeen = plan.nodes.length;
        return { status: 'ok', usage: ZERO };
      },
    },
  };
}

const input = () => ({
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
  budget: { depthRemaining: 3, tokens: new TokenLedger(100000) },
  identity: { traceId: 't', turnId: 'u', sessionId: 's', stepperId: 'n0' },
  toolSafety: {
    mutationPolicy: 'confirm' as const,
    knownReadOnlyTools: new Set<string>(),
  },
});

test('Stepper runs planner then interpreter; reviewer skipped when depth not in atDepths', async () => {
  const interp = spyInterp();
  let reviewerCalls = 0;
  const st = new Stepper({
    name: 'root',
    planner,
    interpreter: interp.it,
    executor: {
      name: 'e',
      async execute() {
        return { status: 'ok', usage: ZERO };
      },
    },
    childSteppers: new Map(),
    reviewer: {
      name: 'r',
      async review() {
        reviewerCalls++;
        return { verdict: { pass: true } };
      },
    } as never,
    reviewerAtDepths: new Set([0]),
    depth: 2, // not in atDepths → reviewer skipped
    maxParallelSteps: 4,
    mintStepperId: () => 's1',
  });
  const res = await st.run(input());
  assert.equal(res.status, 'ok');
  assert.equal(interp.planSeen, 1);
  assert.equal(reviewerCalls, 0);
});

test('Stepper invokes reviewer when depth is in atDepths', async () => {
  const interp = spyInterp();
  let reviewerCalls = 0;
  const st = new Stepper({
    name: 'root',
    planner,
    interpreter: interp.it,
    executor: {
      name: 'e',
      async execute() {
        return { status: 'ok', usage: ZERO };
      },
    },
    childSteppers: new Map(),
    reviewer: {
      name: 'r',
      async review() {
        reviewerCalls++;
        return { verdict: { pass: true } };
      },
    } as never,
    reviewerAtDepths: new Set([0, 1]),
    depth: 0, // in atDepths → reviewer runs
    maxParallelSteps: 4,
    mintStepperId: () => 's1',
  });
  await st.run(input());
  assert.equal(reviewerCalls, 1);
});
