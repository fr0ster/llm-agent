import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ILlm,
  type IToolRetriever,
  MODEL_CONTEXT_EXCEEDED,
  SmartAgentError,
  type ToolRetrievalRequest,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../../../builder.js';
import { unwrapBuilderResult } from '../../../builder-types.js';
import { callerIdentityKey } from '../../../policy/caller-identity.js';
import { ToolAvailabilityRegistry } from '../../../policy/tool-availability-registry.js';
import {
  makeClassifier,
  makeDefaultDeps,
  makeLlm,
  makeMcpClient,
  makeRag,
  testCallOptions,
  testRequestAccess,
} from '../../../testing/index.js';
import { DefaultPipeline } from '../../default-pipeline.js';

const tools = ['read', 'search', 'patch', 'write'].map((name) => ({
  name,
  description: name,
  inputSchema: {},
}));

test('builder supplies role-filtered candidates before availability checks and skips RAG selection', async () => {
  const requests: ToolRetrievalRequest[] = [];
  const retriever: IToolRetriever = {
    name: 'injected',
    async retrieve(request) {
      requests.push(request);
      return { ok: true, value: { names: ['read', 'patch'] } };
    },
  };
  const offered: string[][] = [];
  const mainLlm: ILlm = {
    ...makeLlm([]),
    async *streamChat(_messages, offeredTools) {
      offered.push(offeredTools?.map(({ name }) => name) ?? []);
      if (offered.length === 1) {
        yield {
          ok: true,
          value: {
            content: '',
            toolCalls: [{ name: 'read', id: 'read1', arguments: {} }],
            finishReason: 'tool_calls',
          },
        };
      } else {
        yield { ok: true, value: { content: 'done', finishReason: 'stop' } };
      }
    },
  };
  const store = makeRag();
  const handle = await new SmartAgentBuilder({ skipModelValidation: true })
    .withRagAccess(testRequestAccess)
    .withMainLlm(mainLlm)
    .withClassifier(makeClassifier([{ type: 'action', text: 'Read a file' }]))
    .withMcpClients([makeMcpClient(tools)])
    .setToolsRag(store)
    .withToolReselection(true)
    .withToolCandidateFilter(
      (tool, options) => options?.userId === 'reader' && tool.name !== 'write',
    )
    .withToolRetriever(retriever)
    .build()
    .then(unwrapBuilderResult);
  const availability = new ToolAvailabilityRegistry();
  const logged: object[] = [];
  const options = testCallOptions({
    userId: 'reader',
    toolAvailability: availability,
    sessionLogger: {
      logStep(name, data) {
        if (name === 'tools_selected' && data && typeof data === 'object')
          logged.push(data);
      },
    },
  });
  availability.block(callerIdentityKey(options.caller), 'patch', 'Unavailable');
  try {
    const response = await handle.agent.process('Read a file', options);
    assert.equal(response.ok, true);
    assert.deepEqual(requests, [
      { text: 'Read a file', candidates: tools.slice(0, 3) },
    ]);
    assert.deepEqual(offered, [['read'], ['read']]);
    assert.equal(store.queryCount, 0);
    assert.deepEqual(logged, [
      {
        totalMcp: 4,
        selectedCount: 2,
        selectedNames: ['read', 'patch'],
        activeCount: 1,
        retriever: 'injected',
      },
    ]);
  } finally {
    await handle.close();
  }
});

test('selector failures end the stage with their typed error and usage', async () => {
  for (const code of [
    'ABORTED',
    MODEL_CONTEXT_EXCEEDED,
    'TOOL_RETRIEVAL_INVALID',
  ]) {
    const store = makeRag();
    const { deps, llm } = makeDefaultDeps({
      mcpClients: [makeMcpClient(tools)],
    });
    const error = new SmartAgentError('Selector failed', code);
    error.usageCalls = [
      {
        callId: 'selector',
        component: 'tool-retriever',
        model: 'selection-model',
        durationMs: 1,
        promptTokens: 2,
        completionTokens: 1,
        totalTokens: 3,
      },
    ];
    const pipeline = new DefaultPipeline();
    pipeline.initialize({
      mainLlm: deps.mainLlm,
      classifier: deps.classifier,
      mcpClients: deps.mcpClients ?? [],
      ragAccess: deps.ragAccess,
      toolsRag: store,
      toolRetriever: {
        name: 'injected',
        async retrieve() {
          return { ok: false, error };
        },
      },
    });
    const result = await pipeline.execute(
      'Read a file',
      [],
      testCallOptions(),
      () => {},
    );
    assert.equal(result.error, error);
    assert.equal(result.error.usageCalls?.[0].totalTokens, 3);
    assert.equal(store.queryCount, 0);
    assert.equal(llm.callCount, 0);
    assert.deepEqual(
      result.timing.map(({ phase }) => phase),
      ['classify', 'skill-select', 'tool-select'],
    );
  }
});
