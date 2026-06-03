import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  DagPlan,
  InterpretContext,
  ISubAgent,
  ISubAgentInput,
  ISubAgentResult,
} from '@mcp-abap-adt/llm-agent';
import { AbortErrorStrategy } from '../abort-error-strategy.js';
import { DagPlanInterpreter } from '../dag-plan-interpreter.js';

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

function ctx(workers: Array<[string, ISubAgent]>): InterpretContext {
  return {
    inputText: 'RAW',
    workers: new Map(workers),
    sessionId: 't',
    errorStrategy: new AbortErrorStrategy(),
  };
}

const dag = (nodes: DagPlan['nodes']): DagPlan => ({ nodes, createdAt: 0 });

describe('DagPlanInterpreter external tool calls (#171)', () => {
  const I = () => new DagPlanInterpreter();

  it('collects pending external calls from two parallel awaiting-external nodes (FIFO topo order)', async () => {
    const w = worker('w', async (i) => {
      const id = i.task.includes('NODE_A') ? 'ext:a' : 'ext:b';
      const tool = i.task.includes('NODE_A') ? 'create_file' : 'rag_add';
      return {
        output: '',
        status: 'awaiting-external',
        pendingExternalToolCalls: [{ id, name: tool, arguments: {} }],
      };
    });
    const r = await I().interpret(
      dag([
        { id: 'a', goal: 'NODE_A', agent: 'w' },
        { id: 'b', goal: 'NODE_B', agent: 'w' },
      ]),
      ctx([['w', w]]),
    );
    assert.equal(r.ok, true);
    assert.equal(r.nodeResults.a.status, 'awaiting-external');
    assert.equal(r.nodeResults.b.status, 'awaiting-external');
    assert.deepEqual(
      r.pendingExternalToolCalls?.map((c) => c.id),
      ['ext:a', 'ext:b'],
    );
  });

  it('mixed: one done + one awaiting-external — settles both, collects the one pending call', async () => {
    const w = worker('w', async (i) => {
      if (i.task.includes('NODE_A')) {
        return { output: 'A-OUTPUT', status: 'complete' };
      }
      return {
        output: '',
        status: 'awaiting-external',
        pendingExternalToolCalls: [
          { id: 'ext:b', name: 'create_file', arguments: {} },
        ],
      };
    });
    const r = await I().interpret(
      dag([
        { id: 'a', goal: 'NODE_A', agent: 'w' },
        { id: 'b', goal: 'NODE_B', agent: 'w' },
      ]),
      ctx([['w', w]]),
    );
    assert.equal(r.ok, true);
    assert.equal(r.nodeResults.a.status, 'done');
    assert.equal(r.nodeResults.a.output, 'A-OUTPUT');
    assert.equal(r.nodeResults.b.status, 'awaiting-external');
    assert.deepEqual(
      r.pendingExternalToolCalls?.map((c) => c.id),
      ['ext:b'],
    );
  });

  it('dedupes pending calls by id', async () => {
    const w = worker('w', async () => ({
      output: '',
      status: 'awaiting-external' as const,
      pendingExternalToolCalls: [
        { id: 'ext:dup', name: 'create_file', arguments: {} },
      ],
    }));
    const r = await I().interpret(
      dag([
        { id: 'a', goal: 'NODE_A', agent: 'w' },
        { id: 'b', goal: 'NODE_B', agent: 'w' },
      ]),
      ctx([['w', w]]),
    );
    assert.equal(r.ok, true);
    assert.deepEqual(
      r.pendingExternalToolCalls?.map((c) => c.id),
      ['ext:dup'],
    );
  });

  it('does not schedule dependents of an awaiting-external node (no real input yet)', async () => {
    const w = worker('w', async (i) => {
      if (i.task.includes('ROOT')) {
        return {
          output: '',
          status: 'awaiting-external',
          pendingExternalToolCalls: [
            { id: 'ext:r', name: 'create_file', arguments: {} },
          ],
        };
      }
      return { output: 'CHILD', status: 'complete' };
    });
    const r = await I().interpret(
      dag([
        { id: 'root', goal: 'ROOT', agent: 'w' },
        { id: 'child', goal: 'CHILD', agent: 'w', dependsOn: ['root'] },
      ]),
      ctx([['w', w]]),
    );
    assert.equal(r.ok, true);
    assert.equal(r.nodeResults.root.status, 'awaiting-external');
    assert.notEqual(r.nodeResults.child.status, 'done');
  });
});
