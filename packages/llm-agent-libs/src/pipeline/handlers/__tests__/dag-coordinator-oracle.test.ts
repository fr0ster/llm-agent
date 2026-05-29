import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  DagPlan,
  IInterpreter,
  InterpretResult,
  IPlanner,
  IStateOracle,
  ISubAgent,
} from '@mcp-abap-adt/llm-agent';
import { NeedInfoSignal } from '@mcp-abap-adt/llm-agent';
import { SessionRequestLogger } from '../../../logger/session-request-logger.js';
import { DagCoordinatorHandler } from '../dag-coordinator.js';

const worker: ISubAgent = {
  name: 'w',
  description: 'd',
  capabilities: { contextPolicy: 'optional' },
  async run() {
    return { output: 'X' };
  },
};

const interpreter: IInterpreter<DagPlan, InterpretResult> = {
  name: 'i',
  async interpret(p) {
    return {
      ok: true,
      nodeResults: {
        n: { nodeId: 'n', output: 'X', status: 'done', durationMs: 1 },
      },
      output: 'X',
      executedPlan: p,
      executionOrder: ['n'],
    };
  },
};

test('handler routes NeedInfoSignal through IStateOracle.query (not ISubAgent.run)', async () => {
  let plannerCalls = 0;
  const planner: IPlanner = {
    name: 'p',
    async plan() {
      plannerCalls++;
      if (plannerCalls === 1) {
        throw new NeedInfoSignal('is X true?');
      }
      return {
        plan: {
          objective: 'o',
          nodes: [{ id: 'n', goal: 'g' }],
          createdAt: 0,
        },
      };
    },
  };
  const oracleCalls: string[] = [];
  const oracle: IStateOracle = {
    name: 'oracle',
    async query(input) {
      oracleCalls.push(input.query);
      return { answer: 'yes' };
    },
  };
  const h = new DagCoordinatorHandler({
    planner,
    interpreter,
    workers: new Map([['w', worker]]),
    stateOracle: oracle,
  });
  const logger = new SessionRequestLogger();
  logger.startRequest('t1');
  const yields: unknown[] = [];
  const ctx = {
    inputText: 'p',
    sessionId: 's',
    history: [],
    requestLogger: logger,
    yield: (c: unknown) => yields.push(c),
    options: { trace: { traceId: 't1' } },
  } as never;
  await h.execute(ctx, {}, {} as never);
  assert.deepEqual(oracleCalls, ['is X true?']);
  assert.equal(plannerCalls, 2);
});
