import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  type CallOptions,
  RagAccessDeniedError,
  type RagResult,
} from '@mcp-abap-adt/llm-agent';
import { testRagAccess } from '@mcp-abap-adt/llm-agent/testing/rag-access-testing';
import {
  callerA,
  sessionTags,
  sharedStore,
} from '../../rag/__tests__/isolation-fixtures.js';
import {
  makeAssembler,
  makeClassifier,
  makeLlm,
  makeRag,
} from '../../testing/index.js';
import { DefaultPipeline } from '../default-pipeline.js';

for (const options of [
  { sessionId: 'A', caller: callerA },
  { sessionId: 'A' },
  { sessionId: 'A', caller: callerA, ragFilter: { sessionId: 'B' } },
] satisfies CallOptions[]) {
  it(`RagQueryHandler through DefaultPipeline isolates records (${JSON.stringify(options)})`, async () => {
    const store = await sharedStore();
    const pipeline = new DefaultPipeline();
    let retrieved: RagResult[] = [];
    const assembler = makeAssembler();
    assembler.assemble = async (_action, input) => {
      retrieved = Object.values(input.ragResults).flat();
      return { ok: true, value: [{ role: 'user', content: 'record' }] };
    };
    pipeline.initialize({
      mainLlm: makeLlm([{ content: 'done', finishReason: 'stop' }]),
      mcpClients: [],
      classifier: makeClassifier([{ type: 'action', text: 'record' }]),
      assembler,
      historyRag: store.rag,
      ragAccess: testRagAccess(),
      agentConfig: { mode: 'hard', maxIterations: 1 },
    });
    const result = await pipeline.execute('record', [], options, () => {});
    if ('caller' in options && !('ragFilter' in options)) {
      assert.equal(result.error, undefined);
      assert.deepEqual(sessionTags(retrieved), ['A']);
    } else {
      assert.ok(result.error instanceof RagAccessDeniedError);
      assert.deepEqual(retrieved, []);
    }
  });
}

it('DefaultPipeline without options.sessionId refuses; there is no default session', async () => {
  const rag = makeRag([]);
  const pipeline = new DefaultPipeline();
  pipeline.initialize({
    mainLlm: makeLlm([]),
    mcpClients: [],
    historyRag: rag,
  });
  const result = await pipeline.execute('q', [], undefined, () => {});
  assert.equal(result.error?.code, 'RAG_ACCESS_DENIED');
  assert.equal(rag.queryCount, 0);
});

for (const decision of ['deny', 'throw'] as const) {
  it(`RagQueryHandler refuses when the read decision is ${decision} without querying`, async () => {
    const access = testRagAccess();
    access.decision.canRead = async () => {
      if (decision === 'throw') throw new Error('decision unavailable');
      return false;
    };
    const rag = makeRag([]);
    const pipeline = new DefaultPipeline();
    pipeline.initialize({
      mainLlm: makeLlm([]),
      mcpClients: [],
      ragStores: {
        ordinary: {
          name: 'ordinary',
          owner: { scope: 'session', sessionId: 'A' },
          rag,
        },
      },
      ragAccess: access,
      classifier: makeClassifier([{ type: 'action', text: 'record' }]),
      agentConfig: { mode: 'hard', maxIterations: 1 },
    });
    const result = await pipeline.execute(
      'record',
      [],
      { sessionId: 'A', caller: callerA },
      () => {},
    );
    assert.ok(result.error instanceof RagAccessDeniedError);
    assert.equal(rag.queryCount, 0);
  });
}

for (const decision of ['deny', 'throw'] as const) {
  it(`built-in history bypasses a ${decision} decision through RagQueryHandler`, async () => {
    const access = testRagAccess();
    let calls = 0;
    access.decision.canRead = async () => {
      calls++;
      if (decision === 'throw') throw new Error('decision unavailable');
      return false;
    };
    const store = await sharedStore();
    let retrieved: RagResult[] = [];
    const assembler = makeAssembler();
    assembler.assemble = async (_action, input) => {
      retrieved = input.ragResults.history;
      return { ok: true, value: [{ role: 'user', content: 'record' }] };
    };
    const pipeline = new DefaultPipeline();
    pipeline.initialize({
      mainLlm: makeLlm([{ content: 'done', finishReason: 'stop' }]),
      mcpClients: [],
      historyRag: store.rag,
      ragAccess: access,
      assembler,
      classifier: makeClassifier([{ type: 'action', text: 'record' }]),
      agentConfig: { mode: 'hard', maxIterations: 1 },
    });
    const result = await pipeline.execute(
      'record',
      [],
      { sessionId: 'A', caller: callerA },
      () => {},
    );
    assert.equal(result.error, undefined);
    assert.deepEqual(sessionTags(retrieved), ['A']);
    assert.equal(calls, 0);
  });
}
