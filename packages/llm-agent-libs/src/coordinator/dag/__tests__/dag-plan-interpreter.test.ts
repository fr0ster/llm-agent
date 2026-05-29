import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';
import type {
  DagPlan,
  InterpretContext,
  ISubAgent,
  ISubAgentInput,
} from '@mcp-abap-adt/llm-agent';
import { NeedsDecompositionError } from '@mcp-abap-adt/llm-agent';
import { AbortErrorStrategy } from '../abort-error-strategy.js';
import { DagPlanInterpreter } from '../dag-plan-interpreter.js';
import { ReplanErrorStrategy } from '../replan-error-strategy.js';

function worker(
  name: string,
  run: (i: ISubAgentInput) => Promise<{ output: string }>,
): ISubAgent {
  return {
    name,
    capabilities: {
      contextPolicy: 'optional',
    },
    run: run as ISubAgent['run'],
  } as ISubAgent;
}

function ctx(
  workers: Array<[string, ISubAgent]>,
  errorStrategy: import('@mcp-abap-adt/llm-agent').IErrorStrategy = new AbortErrorStrategy(),
): InterpretContext {
  return {
    inputText: 'RAW',
    workers: new Map(workers),
    sessionId: 't',
    errorStrategy,
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

  it('runs a diamond: parallel middle nodes fan in to a terminal', async () => {
    const order: string[] = [];
    const w = worker('w', async (i) => {
      // tag each node by a unique marker in its goal-derived task
      if (i.task.includes('ROOT')) {
        order.push('a');
        return { output: 'A' };
      }
      if (i.task.includes('LEFT')) {
        order.push('b');
        return { output: 'B' };
      }
      if (i.task.includes('RIGHT')) {
        order.push('c');
        return { output: 'C' };
      }
      // terminal: must see both B and C
      order.push('d');
      return {
        output: `D(${i.task.includes('B') ? 'B' : '?'}+${i.task.includes('C') ? 'C' : '?'})`,
      };
    });
    const r = await I().interpret(
      dag([
        { id: 'a', goal: 'ROOT', agent: 'w' },
        { id: 'b', goal: 'LEFT', agent: 'w', dependsOn: ['a'] },
        { id: 'c', goal: 'RIGHT', agent: 'w', dependsOn: ['a'] },
        { id: 'd', goal: 'merge', agent: 'w', dependsOn: ['b', 'c'] },
      ]),
      ctx([['w', w]]),
    );
    assert.equal(r.ok, true);
    assert.equal(r.nodeResults.b.status, 'done');
    assert.equal(r.nodeResults.c.status, 'done');
    // d's task embedded both dependency outputs (fan-in data-flow)
    assert.equal(r.output, 'D(B+C)');
    // a ran before b/c which ran before d (topological order)
    assert.equal(order[0], 'a');
    assert.equal(order[3], 'd');
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

  it("rejects a worker with contextPolicy='required'", async () => {
    const required = {
      name: 'needy',
      capabilities: {
        contextPolicy: 'required',
      },
      run: async () => ({ output: 'x' }),
    } as unknown as ISubAgent;
    await assert.rejects(
      () =>
        I().interpret(
          dag([{ id: 'a', goal: 'g', agent: 'needy' }]),
          ctx([['needy', required]]),
        ),
      /COORDINATOR_PLAN_INVALID.*contextPolicy='required'/s,
    );
  });

  it('replans a node that throws NeedsDecompositionError into a sub-graph', async () => {
    let calls = 0;
    const big = worker('big', async () => {
      calls++;
      if (calls === 1) throw new NeedsDecompositionError('split me');
      return { output: 'unreachable' };
    });
    const small = worker('small', async () => ({ output: 'done-small' }));
    const planner = {
      name: 'p',
      plan: async () => ({
        plan: {
          nodes: [{ id: 's1', goal: 'small', agent: 'small' }],
          createdAt: 0,
        },
      }),
    };
    const c = ctx(
      [
        ['big', big],
        ['small', small],
      ],
      new ReplanErrorStrategy(planner, 4),
    );
    const r = await I().interpret(
      dag([{ id: 'n1', goal: 'big', agent: 'big' }]),
      c,
    );
    assert.equal(r.ok, true);
    assert.match(r.output, /done-small/);
  });

  it('default AbortErrorStrategy still fails the node (slice-1 behavior)', async () => {
    const big = worker('big', async () => {
      throw new NeedsDecompositionError('split me');
    });
    const r = await I().interpret(
      dag([{ id: 'n1', goal: 'big', agent: 'big' }]),
      ctx([['big', big]]),
    );
    assert.equal(r.ok, false);
  });

  it('stops replanning at the budget (infinite-signal guard)', async () => {
    const big = worker('big', async () => {
      throw new NeedsDecompositionError('always too big');
    });
    const planner = {
      name: 'p',
      plan: async () => ({
        plan: {
          nodes: [{ id: 'again', goal: 'big', agent: 'big' }],
          createdAt: 0,
        },
      }),
    };
    const r = await I().interpret(
      dag([{ id: 'n1', goal: 'big', agent: 'big' }]),
      ctx([['big', big]], new ReplanErrorStrategy(planner, 2)),
    );
    assert.equal(r.ok, false);
  });

  it('gives each interpret() run a fresh replan budget (no cross-call leak)', async () => {
    const big = worker('big', async () => {
      throw new NeedsDecompositionError('split');
    });
    const small = worker('small', async () => ({ output: 'ok' }));
    const planner = {
      name: 'p',
      plan: async () => ({
        plan: {
          nodes: [{ id: 's1', goal: 'small', agent: 'small' }],
          createdAt: 0,
        },
      }),
    };
    // Shared singleton strategy with a 1-replan ceiling; each run needs 1 replan.
    const strat = new ReplanErrorStrategy(planner, 1);
    const make = () =>
      ctx(
        [
          ['big', big],
          ['small', small],
        ],
        strat,
      );
    const r1 = await I().interpret(
      dag([{ id: 'n1', goal: 'big', agent: 'big' }]),
      make(),
    );
    const r2 = await I().interpret(
      dag([{ id: 'n1', goal: 'big', agent: 'big' }]),
      make(),
    );
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true); // would be false if the budget leaked across runs
  });

  it('fails loud (COORDINATOR_PLAN_INVALID) when a replan produces an empty sub-plan', async () => {
    const big = worker('big', async () => {
      throw new NeedsDecompositionError('split');
    });
    const planner = {
      name: 'p',
      plan: async () => ({ plan: { nodes: [], createdAt: 0 } }), // empty sub-plan
    };
    await assert.rejects(
      () =>
        I().interpret(
          dag([{ id: 'n1', goal: 'big', agent: 'big' }]),
          ctx([['big', big]], new ReplanErrorStrategy(planner, 4)),
        ),
      /COORDINATOR_PLAN_INVALID/,
    );
  });

  it('reports failedNodeId and executedPlan on failure', async () => {
    const w = worker('w', async (i) =>
      i.task.includes('boom')
        ? Promise.reject(new Error('boom'))
        : { output: 'ok' },
    );
    const r = await I().interpret(
      dag([{ id: 'a', goal: 'boom', agent: 'w' }]),
      ctx([['w', w]]),
    );
    assert.equal(r.ok, false);
    assert.equal(r.failedNodeId, 'a');
    assert.equal(r.executedPlan?.nodes[0].id, 'a');
  });

  it('applies replans serially for two NeedsDecomposition failures in one wave', async () => {
    const big = worker('big', async () => {
      throw new NeedsDecompositionError('split');
    });
    const small = worker('small', async () => ({ output: 'S' }));
    const planner = {
      name: 'p',
      plan: async () => ({
        plan: {
          nodes: [{ id: 's', goal: 'small', agent: 'small' }],
          createdAt: 0,
        },
      }),
    };
    // A and B are independent roots → same first wave; both throw, both replan.
    const r = await I().interpret(
      dag([
        { id: 'A', goal: 'big', agent: 'big' },
        { id: 'B', goal: 'big', agent: 'big' },
      ]),
      ctx(
        [
          ['big', big],
          ['small', small],
        ],
        new ReplanErrorStrategy(planner, 4),
      ),
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.output, 'S\n\nS'); // both spliced sub-graphs ran
  });
});

test('returns executedPlan + topological executionOrder on success after splice', async () => {
  const replanned = {
    objective: 'patched',
    nodes: [
      { id: 'b1', goal: 'gb1' },
      { id: 'b2', goal: 'gb2', dependsOn: ['b1'] },
    ],
    createdAt: 0,
  };
  let bAttempts = 0;
  const w = {
    name: 'w',
    description: 'd',
    capabilities: { contextPolicy: 'optional' as const },
    async run(input: { task: string }) {
      if (input.task.includes('gb') && bAttempts === 0) {
        bAttempts++;
        throw new Error('boom');
      }
      return { output: `out:${input.task.slice(0, 20)}` };
    },
  };
  const interp = new DagPlanInterpreter();
  const res = await interp.interpret(
    {
      objective: 'orig',
      nodes: [
        { id: 'a', goal: 'ga' },
        { id: 'b', goal: 'gb', dependsOn: ['a'] },
      ],
      createdAt: 0,
    },
    {
      inputText: 'x',
      workers: new Map([['w', w as unknown as ISubAgent]]),
      sessionId: 's',
      errorStrategy: {
        maxReplans: 2,
        async onNodeFailure() {
          return { action: 'replan' as const, subPlan: replanned };
        },
      },
    },
  );
  assert.equal(res.ok, true);
  assert.ok(res.executedPlan, 'executedPlan must be populated on success');
  // spliceSubPlan namespaces sub-plan ids as `${replacedNodeId}:${subId}`
  const ids = (res.executedPlan?.nodes ?? []).map((n) => n.id).sort();
  assert.deepEqual(ids, ['a', 'b:b1', 'b:b2']);
  const order = res.executionOrder ?? [];
  const pos = new Map(order.map((id, i) => [id, i]));
  const byId = new Map(res.executedPlan?.nodes?.map((n) => [n.id, n]) ?? []);
  for (const id of order) {
    for (const d of byId.get(id)?.dependsOn ?? []) {
      assert.ok(
        (pos.get(d) ?? -1) < (pos.get(id) ?? -1),
        `dep ${d} must precede ${id} in executionOrder`,
      );
    }
  }
  assert.equal(order.includes('a'), true);
  assert.equal(order.includes('b:b1'), true);
  assert.equal(order.includes('b:b2'), true);
});

test('returns executionOrder on failure path too', async () => {
  const failWorker = {
    name: 'w',
    description: 'd',
    capabilities: { contextPolicy: 'optional' as const },
    async run() {
      throw new Error('nope');
    },
  };
  const interp = new DagPlanInterpreter();
  const res = await interp.interpret(
    { objective: 'o', nodes: [{ id: 'a', goal: 'ga' }], createdAt: 0 },
    {
      inputText: 'x',
      workers: new Map([['w', failWorker as unknown as ISubAgent]]),
      sessionId: 's',
      errorStrategy: {
        async onNodeFailure() {
          return { action: 'abort' as const };
        },
      },
    },
  );
  assert.equal(res.ok, false);
  assert.ok(Array.isArray(res.executionOrder));
});
