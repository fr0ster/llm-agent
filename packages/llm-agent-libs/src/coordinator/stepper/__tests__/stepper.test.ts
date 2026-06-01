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

// ── 18.1 Evaluator routing ───────────────────────────────────────────────────

function evaluatorReturning(verdict: {
  route: 'executable' | 'needs-work' | 'needs-consumer';
  missing?: string[];
}) {
  return {
    name: 'eval',
    async evaluate() {
      return { route: verdict.route, missing: verdict.missing ?? [] };
    },
  } as never;
}

function spyPlanner(): {
  p: IStepperPlanner;
  calls: number;
  lastPrompt: string;
} {
  let calls = 0;
  let lastPrompt = '';
  return {
    get calls() {
      return calls;
    },
    get lastPrompt() {
      return lastPrompt;
    },
    p: {
      name: 'p',
      async plan(inp: { prompt: string }) {
        calls++;
        lastPrompt = inp.prompt;
        return {
          objective: 'o',
          nodes: [{ id: 'a', goal: 'g' }],
          createdAt: 0,
        };
      },
    } as IStepperPlanner,
  };
}

const baseDeps = (over: Record<string, unknown>) => ({
  name: 'root',
  interpreter: spyInterp().it,
  executor: {
    name: 'e',
    async execute() {
      return { status: 'ok' as const, usage: ZERO };
    },
  },
  childSteppers: new Map(),
  reviewerAtDepths: new Set<number>(),
  depth: 0,
  maxParallelSteps: 4,
  mintStepperId: () => 's1',
  ...over,
});

test('Evaluator executable → planner is NOT called; a single-node plan runs', async () => {
  const interp = spyInterp();
  const sp = spyPlanner();
  const st = new Stepper(
    baseDeps({
      planner: sp.p,
      interpreter: interp.it,
      evaluator: evaluatorReturning({ route: 'executable' }),
      evaluatorAtDepths: new Set([0]),
    }) as never,
  );
  const res = await st.run(input());
  assert.equal(res.status, 'ok');
  assert.equal(sp.calls, 0, 'planner must be skipped on executable');
  assert.equal(interp.planSeen, 1, 'a trivial single-node plan is interpreted');
});

test('Evaluator needs-work → planner is called with the gaps as prerequisites', async () => {
  const sp = spyPlanner();
  const st = new Stepper(
    baseDeps({
      planner: sp.p,
      evaluator: evaluatorReturning({
        route: 'needs-work',
        missing: ['the include bodies'],
      }),
      evaluatorAtDepths: new Set([0]),
    }) as never,
  );
  await st.run(input());
  assert.equal(sp.calls, 1, 'planner runs on needs-work');
  assert.match(
    sp.lastPrompt,
    /Prerequisites to address FIRST: the include bodies/,
  );
});

test('Evaluator needs-consumer → throws ClarifySignal; planner/interpreter skipped', async () => {
  const interp = spyInterp();
  const sp = spyPlanner();
  const st = new Stepper(
    baseDeps({
      planner: sp.p,
      interpreter: interp.it,
      evaluator: evaluatorReturning({
        route: 'needs-consumer',
        missing: ['which target client?'],
      }),
      evaluatorAtDepths: new Set([0]),
    }) as never,
  );
  await assert.rejects(() => st.run(input()), /which target client\?/);
  assert.equal(sp.calls, 0);
  assert.equal(interp.planSeen, 0);
});

test('Evaluator at a depth NOT in evaluatorAtDepths → skipped (plain plan path)', async () => {
  const sp = spyPlanner();
  let evalCalls = 0;
  const st = new Stepper(
    baseDeps({
      planner: sp.p,
      evaluator: {
        name: 'eval',
        async evaluate() {
          evalCalls++;
          return { route: 'executable', missing: [] };
        },
      } as never,
      evaluatorAtDepths: new Set([0]),
      depth: 2, // not in atDepths
    }) as never,
  );
  await st.run(input());
  assert.equal(evalCalls, 0, 'evaluator skipped below its depths');
  assert.equal(sp.calls, 1, 'falls through to the planner');
});
