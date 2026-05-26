import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  DagPlan,
  InterpretContext,
  ISubAgent,
  ISubAgentInput,
} from '@mcp-abap-adt/llm-agent';
import { DagPlanInterpreter } from '../dag-plan-interpreter.js';

function worker(
  name: string,
  run: (i: ISubAgentInput) => Promise<{ output: string }>,
): ISubAgent {
  return {
    name,
    capabilities: {
      kind: 'constrained',
      canDispatchChildren: false,
      contextPolicy: 'optional',
    },
    run: run as ISubAgent['run'],
  } as ISubAgent;
}

function ctx(workers: Array<[string, ISubAgent]>): InterpretContext {
  return {
    inputText: 'RAW',
    workers: new Map(workers),
    sessionId: 't',
    layer: 0,
  };
}

const dag = (nodes: DagPlan['nodes'], objective?: string): DagPlan => ({
  nodes,
  objective,
  createdAt: 0,
});

describe('DagPlanInterpreter', () => {
  const I = () => new DagPlanInterpreter();

  it('runs a single-node plan and returns its raw output', async () => {
    const w = worker('w', async () => ({ output: '42' }));
    const r = await I().interpret(
      dag([{ id: 'n1', goal: 'g', agent: 'w' }]),
      ctx([['w', w]]),
    );
    assert.equal(r.ok, true);
    assert.equal(r.output, '42');
  });

  it('runs a dependency chain in order, feeding outputs forward', async () => {
    const seen: Record<string, string> = {};
    const w = worker('w', async (i) => {
      const tag = i.task.includes('Input from a') ? 'b' : 'a';
      seen[tag] = i.task;
      return { output: tag === 'a' ? 'A' : 'B' };
    });
    const r = await I().interpret(
      dag([
        { id: 'a', goal: 'first', agent: 'w' },
        { id: 'b', goal: 'second', agent: 'w', dependsOn: ['a'] },
      ]),
      ctx([['w', w]]),
    );
    assert.equal(r.ok, true);
    assert.match(seen.b, /Input from a:\n---\nA\n---/);
    assert.equal(r.output, 'B');
  });

  it('resolves an absent agent to the sole worker', async () => {
    const w = worker('only', async () => ({ output: 'ok' }));
    const r = await I().interpret(
      dag([{ id: 'n1', goal: 'g' }]),
      ctx([['only', w]]),
    );
    assert.equal(r.ok, true);
    assert.equal(r.output, 'ok');
  });

  it('marks a failed node and skips its dependents (ok=false)', async () => {
    const w = worker('w', async (i) =>
      i.task.includes('boom')
        ? Promise.reject(new Error('boom'))
        : { output: 'ok' },
    );
    const r = await I().interpret(
      dag([
        { id: 'a', goal: 'boom', agent: 'w' },
        { id: 'b', goal: 'after', agent: 'w', dependsOn: ['a'] },
      ]),
      ctx([['w', w]]),
    );
    assert.equal(r.ok, false);
    assert.equal(r.nodeResults.a.status, 'failed');
    assert.equal(r.nodeResults.b.status, 'skipped');
  });

  it('treats an epicfail worker result as a failed node (ok=false)', async () => {
    const w = worker(
      'w',
      async () =>
        ({ output: '', errorClass: 'epicfail' }) as unknown as {
          output: string;
        },
    );
    const r = await new DagPlanInterpreter().interpret(
      dag([{ id: 'n1', goal: 'g', agent: 'w' }]),
      ctx([['w', w]]),
    );
    assert.equal(r.ok, false);
    assert.equal(r.nodeResults.n1.status, 'failed');
    assert.equal(r.nodeResults.n1.error, 'epicfail');
  });

  it('throws COORDINATOR_PLAN_INVALID on empty / duplicate / missing-dep / cycle / unresolvable-agent', async () => {
    const w = worker('w', async () => ({ output: 'ok' }));
    const c = ctx([
      ['w', w],
      ['w2', w],
    ]);
    await assert.rejects(
      () => I().interpret(dag([]), c),
      /COORDINATOR_PLAN_INVALID/,
    );
    await assert.rejects(
      () =>
        I().interpret(
          dag([
            { id: 'x', goal: 'g', agent: 'w' },
            { id: 'x', goal: 'g', agent: 'w' },
          ]),
          c,
        ),
      /COORDINATOR_PLAN_INVALID/,
    );
    await assert.rejects(
      () =>
        I().interpret(
          dag([{ id: 'a', goal: 'g', agent: 'w', dependsOn: ['zzz'] }]),
          c,
        ),
      /COORDINATOR_PLAN_INVALID/,
    );
    await assert.rejects(
      () =>
        I().interpret(
          dag([
            { id: 'a', goal: 'g', agent: 'w', dependsOn: ['b'] },
            { id: 'b', goal: 'g', agent: 'w', dependsOn: ['a'] },
          ]),
          c,
        ),
      /COORDINATOR_PLAN_INVALID/,
    );
    await assert.rejects(
      () => I().interpret(dag([{ id: 'a', goal: 'g' }]), c),
      /COORDINATOR_PLAN_INVALID/,
    );
  });
});
