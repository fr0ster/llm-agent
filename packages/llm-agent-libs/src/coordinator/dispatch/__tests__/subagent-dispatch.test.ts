import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ICoordinatorContext,
  ISubAgent,
  ISubAgentInput,
  PlanStep,
} from '@mcp-abap-adt/llm-agent';
import { TextOnlyEmbedding } from '@mcp-abap-adt/llm-agent';
import { testRagAccess } from '@mcp-abap-adt/llm-agent/testing/rag-access-testing';
import {
  callerA,
  sharedStore,
} from '../../../rag/__tests__/isolation-fixtures.js';
import { ownerBoundQuery } from '../../../rag/owner-bound-query.js';
import { makeLlm, testCallOptions } from '../../../testing/index.js';
import { SelfDispatch } from '../self.js';
import { SubAgentDispatch } from '../subagent.js';

it('self dispatch preserves the trusted caller in executor options', async () => {
  const llm = makeLlm([]);
  llm.chat = async (_messages, _tools, options) => {
    assert.equal(options?.caller, callerA);
    return { ok: true, value: { content: 'done' } };
  };
  const result = await new SelfDispatch(llm).dispatch(
    { id: '1', goal: 'execute', status: 'pending' },
    {
      caller: callerA,
      inputText: 'execute',
      registry: new Map(),
      stepResults: {},
      sessionId: callerA.sessionId,
    },
  );
  assert.equal(result.ok, true, result.error);
});

it('nested coordinator dispatch preserves the trusted caller for real RAG retrieval', async () => {
  const access = testRagAccess();
  await access.bindings.bind(callerA.sessionId, callerA.userId);
  const store = await sharedStore();
  const worker: ISubAgent = {
    name: 'worker',
    capabilities: { contextPolicy: 'optional' },
    async run(input) {
      assert.equal(input.caller, callerA);
      const result = await ownerBoundQuery(
        store,
        new TextOnlyEmbedding('record'),
        5,
        { caller: input.caller },
        access,
      );
      assert.ok(result.ok);
      assert.deepEqual(
        result.value.map((row) => row.metadata.sessionId),
        ['A'],
      );
      const foreign = await ownerBoundQuery(
        { ...store, owner: { scope: 'session', sessionId: 'B' } },
        new TextOnlyEmbedding('record'),
        5,
        { caller: input.caller },
        access,
      );
      assert.equal(foreign.ok, false);
      return { output: 'isolated' };
    },
  };
  const ctx: ICoordinatorContext & { caller: typeof callerA } = {
    caller: callerA,
    inputText: 'record',
    registry: new Map([['worker', worker]]),
    stepResults: {},
    sessionId: 'A',
  };
  const result = await new SubAgentDispatch().dispatch(
    { id: '1', agent: 'worker', goal: 'retrieve', status: 'pending' },
    ctx,
  );
  assert.equal(result.ok, true, result.error);
});

describe('SubAgentDispatch task composition', () => {
  it('passes objective + verbatim material in the composed task', async () => {
    const captured: { task?: string } = {};
    const fakeSub: ISubAgent = {
      capabilities: {
        contextPolicy: 'optional',
      },
      run: async (input: ISubAgentInput) => {
        captured.task = input.task;
        return { output: 'done' };
      },
    } as unknown as ISubAgent;

    const ctx = {
      options: testCallOptions({ sessionId: 't' }),
      inputText: 'RELEASE-TASKS-BLOB',
      registry: new Map([['summarizer', fakeSub]]),
      stepResults: {},
      sessionId: 't',
      plan: {
        steps: [],
        objective: 'Ship the release',
        createdAt: 0,
        source: 'planner-llm',
      },
    } as unknown as ICoordinatorContext;

    const step: PlanStep = {
      id: 's1',
      goal: 'Summarize',
      agent: 'summarizer',
      needsInput: true,
      status: 'pending',
    };

    const res = await new SubAgentDispatch().dispatch(step, ctx);
    assert.equal(res.ok, true);
    assert.match(captured.task ?? '', /RELEASE-TASKS-BLOB/);
    assert.match(captured.task ?? '', /Overall objective: Ship the release/);
  });
});
