import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  DagPlan,
  IInterpreter,
  InterpretContext,
  InterpretResult,
  IPlanner,
  ISubAgent,
  ISubAgentInput,
  ISubAgentResult,
} from '@mcp-abap-adt/llm-agent';
import { AbortErrorStrategy } from '../coordinator/dag/abort-error-strategy.js';
import { DagPlanInterpreter } from '../coordinator/dag/dag-plan-interpreter.js';
import { SessionRequestLogger } from '../logger/session-request-logger.js';
import { DagCoordinatorHandler } from '../pipeline/handlers/dag-coordinator.js';

function worker(
  name: string,
  run: (i: ISubAgentInput) => Promise<Partial<ISubAgentResult>>,
): ISubAgent {
  return {
    name,
    capabilities: { contextPolicy: 'optional' },
    run: run as ISubAgent['run'],
  } as ISubAgent;
}

const dag = (nodes: DagPlan['nodes']): DagPlan => ({ nodes, createdAt: 0 });

describe('externalResults threading (#171, review#7)', () => {
  it('interpret → worker.run: the same map reaches the worker input', async () => {
    const map = new Map<string, string>([['ext:abc', 'RESULT']]);
    let seen: Map<string, string> | undefined;
    const w = worker('w', async (i) => {
      seen = i.externalResults as Map<string, string> | undefined;
      return { output: 'OK', status: 'complete' };
    });
    const ctx: InterpretContext = {
      inputText: 'RAW',
      workers: new Map([['w', w]]),
      sessionId: 't',
      errorStrategy: new AbortErrorStrategy(),
      externalResults: map,
    };
    await new DagPlanInterpreter().interpret(
      dag([{ id: 'a', goal: 'g', agent: 'w' }]),
      ctx,
    );
    assert.equal(seen, map, 'worker received the SAME externalResults map');
    assert.equal(seen?.get('ext:abc'), 'RESULT');
  });

  it('coordinator → interpret: ctx.externalResults reaches the InterpretContext', async () => {
    const map = new Map<string, string>([['ext:xyz', 'R2']]);
    let seenInterpret: Map<string, string> | undefined;
    const planner: IPlanner = {
      name: 'p',
      async plan() {
        return { plan: dag([{ id: 'a', goal: 'g' }]) };
      },
    };
    const interpreter: IInterpreter<DagPlan, InterpretResult> = {
      name: 'i',
      async interpret(p, ictx) {
        seenInterpret = ictx.externalResults as Map<string, string> | undefined;
        return {
          ok: true,
          nodeResults: {
            a: { nodeId: 'a', output: 'X', status: 'done', durationMs: 1 },
          },
          output: 'X',
          executedPlan: p,
          executionOrder: ['a'],
        };
      },
    };
    const w = worker('w', async () => ({ output: 'OK', status: 'complete' }));
    const h = new DagCoordinatorHandler({
      planner,
      interpreter,
      workers: new Map([['w', w]]),
    });
    const logger = new SessionRequestLogger();
    logger.startRequest('t1');
    const ctx = {
      inputText: 'do thing',
      sessionId: 's1',
      history: [],
      requestLogger: logger,
      externalResults: map,
      yield() {},
      options: { trace: { traceId: 't1' } },
    } as never;
    await h.execute(ctx, {}, {} as never);
    assert.equal(
      seenInterpret,
      map,
      'interpret received the same map from ctx',
    );
  });
});
