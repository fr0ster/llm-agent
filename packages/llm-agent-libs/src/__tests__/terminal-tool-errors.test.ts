import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import {
  buildRagCollectionToolEntries,
  DirectEditStrategy,
  EMBEDDING_CONTEXT_EXCEEDED,
  GlobalUniqueIdStrategy,
  type ICoordinatorContext,
  type ILlm,
  InMemoryRag,
  IntentEnricher,
  LlmError,
  McpError,
  type Message,
  MODEL_CONTEXT_EXCEEDED,
  RagError,
  SimpleRagRegistry,
  symmetricEmbedder,
  TokenLedger,
  type ToolRound,
  VectorRag,
} from '@mcp-abap-adt/llm-agent';
import {
  MCPClientWrapper,
  McpClientAdapter,
} from '@mcp-abap-adt/llm-agent-mcp';
import { SmartAgent } from '../agent.js';
import { LlmClassifier } from '../classifier/llm-classifier.js';
import { ContextAssembler } from '../context/context-assembler.js';
import { SelfDispatch } from '../coordinator/dispatch/self.js';
import { CyclicReActExecutor } from '../coordinator/stepper/cyclic-react-executor.js';
import { DefaultRequestLogger } from '../logger/default-request-logger.js';
import { LegacyAccumulateContextStrategy } from '../pipeline/context/tool-loop-context/index.js';
import { DefaultPipeline } from '../pipeline/default-pipeline.js';
import { LlmReranker } from '../reranker/llm-reranker.js';
import {
  makeDefaultDeps,
  makeRag,
  testCallOptions,
  testRequestAccess,
} from '../testing/index.js';

const tool = { name: 'Work', description: 'Work', inputSchema: {} };

for (const pipeline of [false, true]) {
  for (const scenario of [
    'terminal',
    'embedding',
    'SDK embedding',
    'mixed',
    'mixed abort',
    'ordinary',
  ]) {
    test(`${pipeline ? 'pipeline' : 'direct'} handles ${scenario} rag_add failures through embedded MCP`, async (t) => {
      const mixed = scenario === 'mixed' || scenario === 'mixed abort';
      const externalTools = mixed ? [tool] : [];
      const options = { ...testCallOptions(), externalTools };
      const failure = new LlmError(
        'Prompt is too long',
        MODEL_CONTEXT_EXCEEDED,
      );
      const abort = new Error('Cancelled', { cause: failure });
      abort.name = 'AbortError';
      const ordinary = new RagError('Write failed');
      const enricher: ILlm = {
        async chat() {
          if (scenario === 'mixed abort') throw abort;
          return { ok: false, error: failure };
        },
        async *streamChat() {},
      };
      const embeddingOverflow = new RagError(
        'Embedding input is too long',
        EMBEDDING_CONTEXT_EXCEEDED,
        { status: 400 },
      );
      const embeddingFailure =
        scenario === 'SDK embedding'
          ? Object.assign(new Error('input too long'), { status: 400 })
          : embeddingOverflow;
      const documentEmbedding =
        scenario === 'embedding' || scenario === 'SDK embedding';
      let embeddingCalls = 0;
      const rag = documentEmbedding
        ? new VectorRag(
            symmetricEmbedder({
              async embed() {
                embeddingCalls++;
                throw embeddingFailure;
              },
            }),
          )
        : new InMemoryRag({
            documentEnrichers: [new IntentEnricher(enricher)],
          });
      const writer = rag.writer();
      const registry = new SimpleRagRegistry();
      registry.register(
        'notes',
        rag,
        new DirectEditStrategy(
          scenario === 'ordinary'
            ? {
                ...writer,
                upsertRaw: async () => ({ ok: false, error: ordinary }),
              }
            : writer,
          new GlobalUniqueIdStrategy(),
        ),
        { displayName: 'Notes', scope: 'user', userId: options.caller.userId },
      );
      const entry = buildRagCollectionToolEntries({
        registry,
        caller: options.caller,
        access: testRequestAccess,
      }).find((entry) => entry.toolDefinition.name === 'rag_add');
      assert.ok(entry);
      const { name, description } = entry.toolDefinition;
      const args = {
        collection: 'notes',
        text: 'New entry',
        canonicalKey: 'note',
      };
      const wrapper = new MCPClientWrapper({
        transport: 'embedded',
        listToolsHandler: async () => [{ name, description, inputSchema: {} }],
        async callToolHandler(toolName, toolArgs) {
          assert.equal(toolName, name);
          assert.deepEqual(toolArgs, args);
          return entry.handler({}, args);
        },
      });
      await wrapper.connect();
      t.after(() => wrapper.disconnect());
      const { deps, llm } = makeDefaultDeps({
        assembler: new ContextAssembler(),
        mcpClients: [new McpClientAdapter(wrapper)],
        llmResponses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'add', name, arguments: args },
              ...externalTools.map(({ name }) => ({
                id: 'external',
                name,
                arguments: {},
              })),
            ],
          },
          { content: 'Second main LLM response' },
        ],
      });
      const inputs: Message[][] = [];
      const stream = llm.streamChat.bind(llm);
      llm.streamChat = (messages, tools, opts) => {
        inputs.push(messages);
        return stream(messages, tools, opts);
      };
      const config = { refreshToolsPerIteration: false };
      if (pipeline) {
        const flow = new DefaultPipeline();
        flow.initialize({ ...deps, agentConfig: config });
        deps.pipeline = flow;
      }
      const agent = new SmartAgent(deps, config);
      let result = await agent.process('Add an entry to notes', options);
      if (mixed) {
        assert.ok(result.ok);
        const externalCall = result.value.toolCalls?.[0];
        assert.ok(externalCall);
        result = await agent.process([], {
          ...options,
          externalResults: new Map([[externalCall.id, 'External response']]),
        });
      }
      if (scenario === 'ordinary') {
        assert.ok(result.ok);
        assert.equal(result.value.content, 'Second main LLM response');
        assert.equal(llm.callCount, 2);
        const toolResult = inputs[1].find((message) => message.role === 'tool');
        assert.equal(
          toolResult?.content,
          JSON.stringify({ ok: false, error: ordinary.message }),
        );
      } else {
        assert.ok(!result.ok);
        const expected = documentEmbedding ? embeddingOverflow : failure;
        assert.equal(
          result.error.code,
          scenario === 'mixed abort' ? 'ABORTED' : expected.code,
        );
        if (scenario === 'mixed abort') {
          assert.equal(result.error.message, abort.message);
        } else if (scenario === 'SDK embedding') {
          assert.equal(result.error.cause, embeddingFailure);
          assert.equal(result.error.status, 400);
        } else {
          assert.equal(result.error.cause, expected);
        }
        assert.equal(llm.callCount, 1);
        assert.equal(embeddingCalls, documentEmbedding ? 1 : 0);
      }
    });
  }

  for (const scenario of ['terminal-first', 'terminal-last', 'ordinary']) {
    const mode = pipeline ? 'pipeline' : 'direct';
    const name =
      scenario === 'ordinary'
        ? `${mode} surfaces the first ordinary RAG failure`
        : `${mode} aggregates RAG queries with ${scenario} failures`;
    test(name, async () => {
      const first = new RagError('First query failed', 'QUERY_ERROR');
      const last = new RagError('Last query failed', 'QUERY_ERROR');
      const terminal = new RagError(
        'Prompt is too long',
        MODEL_CONTEXT_EXCEEDED,
      );
      const queries: string[] = [];
      const { deps, llm } = makeDefaultDeps({
        ragStores: {
          first: {
            ...makeRag(),
            async query() {
              queries.push('first');
              return {
                ok: false,
                error: scenario === 'terminal-first' ? terminal : first,
              };
            },
          },
          last: {
            ...makeRag(),
            async query() {
              queries.push('last');
              await setImmediate();
              return {
                ok: false,
                error: scenario === 'terminal-last' ? terminal : last,
              };
            },
          },
        },
      });
      if (pipeline) {
        const flow = new DefaultPipeline();
        flow.initialize(deps);
        deps.pipeline = flow;
      }
      const errors: Error[] = [];
      for await (const chunk of new SmartAgent(deps, {}).streamProcess(
        'Find notes',
        testCallOptions(),
      )) {
        if (!chunk.ok) errors.push(chunk.error);
      }
      assert.equal(errors.length, 1);
      assert.equal(errors[0], scenario === 'ordinary' ? first : terminal);
      assert.deepEqual(queries, ['first', 'last']);
      assert.equal(llm.callCount, 0);
    });
  }
}

for (const pipeline of [false, true]) {
  test(`${pipeline ? 'pipeline' : 'direct'} propagates a returned reranker abort before reusing candidates`, async () => {
    const abort = new Error('Cancelled', {
      cause: new LlmError('Prompt too long', MODEL_CONTEXT_EXCEEDED),
    });
    abort.name = 'AbortError';
    const error = new RagError('Reranker failed', 'RERANK_ERROR', {
      cause: abort,
    });
    const { deps, llm } = makeDefaultDeps({
      ragStores: { docs: makeRag([{ text: 'doc', metadata: {}, score: 1 }]) },
      reranker: {
        async rerank() {
          return { ok: false, error };
        },
      },
    });
    if (pipeline) {
      const flow = new DefaultPipeline();
      flow.initialize(deps);
      deps.pipeline = flow;
    }
    const result = await new SmartAgent(deps, {}).process(
      'Find the documentation',
      testCallOptions(),
    );
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'ABORTED');
    assert.equal(llm.callCount, 0);
  });

  for (const stage of ['classifier', 'translation', 'reranker']) {
    test(`${pipeline ? 'pipeline' : 'direct'} surfaces context overflow from the ${stage}`, async () => {
      const error = new LlmError('Prompt is too long', MODEL_CONTEXT_EXCEEDED);
      const failingLlm: ILlm = {
        async chat() {
          if (stage === 'classifier') throw error;
          return { ok: false, error };
        },
        async *streamChat() {},
      };
      const { deps, llm } = makeDefaultDeps({
        classifier:
          stage === 'classifier' ? new LlmClassifier(failingLlm) : undefined,
        ragStores: { docs: makeRag([{ text: 'doc', metadata: {}, score: 1 }]) },
        reranker:
          stage === 'reranker' ? new LlmReranker(failingLlm) : undefined,
      });
      if (stage === 'translation') {
        deps.helperLlm = failingLlm;
        deps.translateQueryStores = new Set(['docs']);
      }
      const config = { classificationEnabled: stage === 'classifier' };
      if (pipeline) {
        const flow = new DefaultPipeline();
        flow.initialize({ ...deps, agentConfig: config });
        deps.pipeline = flow;
      }
      const input =
        stage === 'translation'
          ? 'Find the résumé for the program'
          : 'Find the documentation';
      const result = await new SmartAgent(deps, config).process(
        input,
        testCallOptions(),
      );
      assert.ok(!result.ok);
      assert.equal(result.error, error);
      assert.equal(llm.callCount, 0);
    });
  }
}

test('self: a terminal exception stops the step after one LLM call', async () => {
  const failure = new McpError('TERMINAL_SENTINEL', 'MCP_NOT_CONNECTED');
  const executed: string[] = [];
  let calls = 0;
  const llm: ILlm = {
    streamChat() {
      assert.fail('Expected chat');
    },
    async chat() {
      calls++;
      return {
        ok: true,
        value:
          calls === 1
            ? {
                content: '',
                finishReason: 'tool_calls',
                toolCalls: ['Fail', 'Later'].map((name) => ({
                  id: name,
                  name,
                  arguments: {},
                })),
              }
            : { content: 'INCORRECT_SUCCESS', finishReason: 'stop' },
      };
    },
  };
  const ctx: ICoordinatorContext = {
    ...testCallOptions(),
    inputText: 'work',
    registry: new Map(),
    stepResults: {},
    selectedTools: [tool],
    async callTool(name) {
      executed.push(name);
      if (name === 'Fail') throw failure;
      return 'SIDE_EFFECT';
    },
  };
  const result = await new SelfDispatch(llm).dispatch(
    { id: 's1', goal: 'work', status: 'pending' },
    ctx,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, failure.message);
  assert.equal(result.output, '');
  assert.equal(calls, 1);
  assert.deepEqual(executed, ['Fail']);
  assert.equal(ctx.toolCallCount, 1);
});

for (const pipeline of [false, true]) {
  for (const heartbeatIntervalMs of [0, 60_000]) {
    test(`${pipeline ? 'pipeline' : 'direct'}: terminal throw does not wait for a never-resolving sibling (heartbeat=${heartbeatIntervalMs})`, async () => {
      const failure = new McpError('TERMINAL_SENTINEL', 'MCP_NOT_CONNECTED');
      const executed: string[] = [];
      const signal = new AbortController().signal;
      const { deps, llm } = makeDefaultDeps({
        assembler: new ContextAssembler(),
        llmResponses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: ['Fail', 'Hang'].map((name) => ({
              id: name,
              name,
              arguments: {},
            })),
          },
        ],
        mcpClients: [
          {
            async listTools() {
              return {
                ok: true,
                value: ['Fail', 'Hang'].map((name) => ({ ...tool, name })),
              };
            },
            async callTool(name, _args, options) {
              assert.equal(options?.signal, signal);
              executed.push(name);
              if (name === 'Fail') throw failure;
              return new Promise<never>(() => {});
            },
          },
        ],
      });
      const config = { refreshToolsPerIteration: false, heartbeatIntervalMs };
      if (pipeline) {
        const flow = new DefaultPipeline();
        flow.initialize({ ...deps, agentConfig: config });
        deps.pipeline = flow;
      }
      let settled = false;
      const observed = new SmartAgent(deps, config)
        .process('work', testCallOptions({ signal }))
        .then(
          (result) => {
            settled = true;
            assert.ok(pipeline);
            assert.equal(result.ok, false);
            if (!result.ok) assert.equal(result.error, failure);
          },
          (error: Error) => {
            settled = true;
            assert.equal(pipeline, false);
            assert.equal(error, failure);
          },
        );
      // The real components use promises only here. Drain a complete microtask
      // turn without a wall-clock deadline or releasing the hanging sibling.
      await setImmediate();
      assert.equal(settled, true);
      await observed;
      assert.deepEqual(executed, ['Fail', 'Hang']);
      assert.equal(llm.callCount, 1);
      assert.equal(signal.aborted, false, 'sibling calls are not aborted');
    });
  }
}

for (const pipeline of [false, true]) {
  for (const thrown of [false, true]) {
    test(`${pipeline ? 'pipeline' : 'direct'}: terminal MCP contract (thrown=${thrown})`, async () => {
      const failure = new McpError('UNAVAILABLE_SENTINEL', 'MCP_NOT_CONNECTED');
      const rounds: ToolRound[] = [];
      const strategy = new LegacyAccumulateContextStrategy();
      const record = strategy.record.bind(strategy);
      strategy.record = async (round) => {
        rounds.push(structuredClone(round));
        await record(round);
      };
      const { deps, llm } = makeDefaultDeps({
        assembler: new ContextAssembler(),
        llmResponses: [
          {
            content: 'REQUEST',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call', name: 'Work', arguments: {} }],
          },
          { content: 'INCORRECT_SUCCESS' },
        ],
        mcpClients: [
          {
            async listTools() {
              return { ok: true, value: [tool] };
            },
            async callTool() {
              if (thrown) throw failure;
              return { ok: false, error: failure };
            },
          },
        ],
      });
      deps.toolLoopContextStrategyFactory = () => strategy;
      const config = { refreshToolsPerIteration: false };
      if (pipeline) {
        const flow = new DefaultPipeline();
        flow.initialize({ ...deps, agentConfig: config });
        deps.pipeline = flow;
      }
      const run = () =>
        new SmartAgent(deps, config).process('work', testCallOptions());
      // Rejected call promises are not converted: throws retain their identity; returned availability errors are escalated.
      if (thrown && !pipeline) {
        await assert.rejects(run, (error) => error === failure);
      } else {
        const result = await run();
        assert.equal(result.ok, false);
        if (!result.ok) {
          if (thrown) assert.equal(result.error, failure);
          else assert.equal(result.error.code, 'MCP_UNAVAILABLE');
        }
      }
      assert.equal(failure.code, 'MCP_NOT_CONNECTED');
      assert.equal(
        llm.callCount,
        1,
        'terminal failures must never trigger another LLM call',
      );
      assert.equal(rounds.length, thrown ? 0 : 1);
      if (!thrown)
        assert.deepEqual(
          rounds[0].results.map((message) => message.tool_call_id),
          rounds[0].assistant.tool_calls?.map((call) => call.id),
        );
    });
  }
}

for (const failure of [
  new McpError('UNAVAILABLE_SENTINEL', 'MCP_NOT_CONNECTED'),
  new Error('UNEXPECTED_SENTINEL'),
]) {
  test(`cyclic: propagates ${failure.name} unchanged after one LLM call`, async () => {
    const inputs: Message[][] = [];
    const llm: ILlm = {
      async chat(messages) {
        inputs.push(structuredClone(messages));
        assert.ok(inputs.length <= 2);
        if (inputs.length === 2)
          return {
            ok: true,
            value: { content: 'INCORRECT_SUCCESS', finishReason: 'stop' },
          };
        assert.ok(
          messages.some((message) => String(message.content).includes('work')),
        );
        return {
          ok: true,
          value: {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'cyclic-call', name: 'Work', arguments: {} }],
          },
        };
      },
      async *streamChat() {},
    };
    const executor = new CyclicReActExecutor({
      llm,
      component: 'tool-loop',
      async callMcp() {
        throw failure;
      },
    });
    // Every thrown bridge failure leaves execute() with its type/code. Normal tool failures are text.
    await assert.rejects(
      () =>
        executor.execute({
          prompt: 'work',
          tools: [tool],
          toolsRag: { query: async () => [tool], lookup: () => tool },
          knowledgeRag: {
            query: async () => [],
            list: async () => [],
            write: async () => {},
            fingerprint: () => 'empty',
          },
          budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
          identity: {
            traceId: 't',
            turnId: 'u',
            sessionId: 's',
            stepperId: 'n1',
          },
        }),
      (error) => error === failure,
    );
    assert.equal(inputs.length, 1);
  });
}

for (const pipeline of [false, true]) {
  for (const thrown of [false, true]) {
    for (const aborted of [false, true]) {
      const mode = pipeline ? 'pipeline' : 'direct';
      test(`${mode} meters a ${thrown ? 'thrown' : 'returned'} classifier ${aborted ? 'abort' : 'error'} once`, async () => {
        const usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
        const cause = new Error('Classifier provider failed', {
          cause: aborted
            ? new LlmError('Prompt too long', MODEL_CONTEXT_EXCEEDED)
            : undefined,
        });
        if (aborted) cause.name = 'AbortError';
        Object.assign(cause, { usage, model: 'classifier-model' });
        const returned = Object.assign(new LlmError('Provider response'), {
          cause,
        });
        const logger = new DefaultRequestLogger();
        const { deps, llm } = makeDefaultDeps({
          classifier: new LlmClassifier(
            {
              async chat() {
                if (thrown) throw cause;
                return { ok: false, error: returned };
              },
              async *streamChat() {},
            },
            undefined,
            logger,
          ),
        });
        deps.requestLogger = logger;
        const config = { classificationEnabled: true };
        if (pipeline) {
          const flow = new DefaultPipeline();
          flow.initialize({ ...deps, agentConfig: config });
          deps.pipeline = flow;
        }
        const traceId = 'classifier-failure';
        const result = await new SmartAgent(deps, config).process(
          'Classify this request',
          testCallOptions({ trace: { traceId } }),
        );
        assert.ok(!result.ok);
        assert.equal(
          result.error.code,
          aborted ? 'ABORTED' : 'CLASSIFIER_ERROR',
        );
        assert.deepEqual(result.error.usage, usage);
        assert.deepEqual(logger.getSummary(traceId).totals, {
          ...usage,
          requests: 1,
        });
        assert.equal(llm.callCount, 0);
      });
    }
  }
}
