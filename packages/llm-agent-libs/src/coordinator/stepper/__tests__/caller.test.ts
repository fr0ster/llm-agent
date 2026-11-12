import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type IStepperInput,
  type RagCaller,
  TokenLedger,
} from '@mcp-abap-adt/llm-agent';
import { Stepper } from '../stepper.js';
import { StepperInterpreter } from '../stepper-interpreter.js';

const caller: RagCaller = {
  sessionId: 'review-session',
  userId: 'user',
  isAdmin: false,
};
const zero = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
function input(): IStepperInput {
  return {
    caller,
    prompt: 'Read',
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
    },
    toolsRag: {
      async query() {
        return [];
      },
      lookup() {
        return undefined;
      },
    },
    budget: { depthRemaining: 2, tokens: new TokenLedger(100) },
    identity: {
      traceId: 'trace',
      turnId: 'turn',
      sessionId: caller.sessionId,
      stepperId: 'root',
    },
  };
}
function fixture() {
  const seen: RagCaller[] = [];
  const child = new Stepper({
    name: 'child',
    planner: {
      name: 'planner',
      async plan() {
        return { nodes: [], createdAt: 0 };
      },
    },
    interpreter: new StepperInterpreter(),
    executor: {
      name: 'executor',
      async execute() {
        return { status: 'ok', usage: zero };
      },
    },
    childSteppers: new Map(),
    reviewer: {
      name: 'reviewer',
      async review(options) {
        seen.push(options.caller);
        assert.equal(options.sessionId, caller.sessionId);
        return { verdict: { pass: true } };
      },
    },
    reviewerAtDepths: new Set([1]),
    depth: 1,
    maxParallelSteps: 1,
    mintStepperId: () => 'child',
  });
  const root = new Stepper({
    name: 'root',
    planner: {
      name: 'planner',
      async plan() {
        return {
          nodes: [{ id: 'work', goal: 'Read', agent: 'child' }],
          createdAt: 0,
        };
      },
    },
    interpreter: new StepperInterpreter(),
    executor: {
      name: 'executor',
      async execute() {
        return { status: 'ok', usage: zero };
      },
    },
    childSteppers: new Map([['child', child]]),
    reviewerAtDepths: new Set(),
    depth: 0,
    maxParallelSteps: 1,
    mintStepperId: () => 'child',
  });
  return { child, root, seen };
}
test('recursive stepper review preserves caller identity', async () => {
  const { root, seen } = fixture();
  const result = await root.run(input());
  assert.equal(result.status, 'ok');
  assert.equal(seen.length, 1);
  assert.strictEqual(seen[0], caller);
});
for (const replacement of [undefined, { ...caller, sessionId: 'other' }]) {
  test(`stepper refuses ${replacement ? 'mismatched' : 'missing'} review caller`, async () => {
    const { child, seen } = fixture();
    await assert.rejects(
      child.run({ ...input(), caller: replacement }),
      /caller|Caller/,
    );
    assert.equal(seen.length, 0);
  });
}
