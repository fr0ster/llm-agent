import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BatchChunkingEmbedder,
  type CallOptions,
  type ICoordinatorContext,
  type IUsageRecorder,
  RetryBatchEmbedder,
  resetQuotaGates,
  staticApiKey,
  TextOnlyEmbedding,
  type UsageContext,
  UsageDeliveryError,
  type UsageInput,
  VectorRag,
  WaitAsTold,
} from '@mcp-abap-adt/llm-agent';
import { LlmQueryExpander } from '../../../llm-agent/src/rag/query-expander.js';
import { McpClientAdapter } from '../../../llm-agent-mcp/src/adapter.js';
import { MCPClientWrapper } from '../../../llm-agent-mcp/src/client.js';
import {
  combineSinks,
  createUsageRecorder,
  directTransport,
  httpTransport,
  memorySink,
} from '../../../llm-usage/src/index.js';
import { OpenAiEmbedder } from '../../../openai-embedder/src/openai-embedder.js';
import { OpenAIProvider } from '../../../openai-llm/src/openai-provider.js';
import { LlmAdapter } from '../adapters/llm-adapter.js';
import { LlmProviderBridge } from '../adapters/llm-provider-bridge.js';
import { toEnglishForRag } from '../agent/rag-helpers.js';
import { SmartAgentBuilder } from '../builder.js';
import { LlmClassifier } from '../classifier/llm-classifier.js';
import { LlmAdaptiveController } from '../coordinator/adaptive/llm-adaptive-controller.js';
import { LlmDagPlanner } from '../coordinator/dag/llm-dag-planner.js';
import { LlmFinalizer } from '../coordinator/dag/llm-finalizer.js';
import { LlmReviewStrategy } from '../coordinator/dag/llm-review-strategy.js';
import { TaskBoard } from '../coordinator/dialogue/task-board.js';
import { SelfDispatch } from '../coordinator/dispatch/self.js';
import { OneShotPlanning } from '../coordinator/planning/one-shot.js';
import { LlmEvaluator } from '../coordinator/stepper/llm-evaluator.js';
import { HistorySummarizer } from '../history/history-summarizer.js';
import { SessionRequestLogger } from '../logger/session-request-logger.js';
import { vectorizeMcpTools } from '../mcp/vectorize-mcp-tools.js';
import { NoopMetrics } from '../metrics/noop-metrics.js';
import { DefaultPipeline } from '../pipeline/default-pipeline.js';
import { executeToolBatchWithHeartbeat } from '../pipeline/handlers/tool-loop-core.js';
import { fireInternalToolsAsync } from '../policy/mixed-tool-call-handler.js';
import { PendingToolResultsRegistry } from '../policy/pending-tool-results-registry.js';
import { ToolAvailabilityRegistry } from '../policy/tool-availability-registry.js';
import { RetryLlm } from '../resilience/retry-llm.js';
import { DirectLlmSubAgent } from '../subagent/direct-llm-subagent.js';
import { SmartAgentSubAgent } from '../subagent/smart-agent-subagent.js';
import { NoopTracer } from '../tracer/noop-tracer.js';

const secrets = [
  'PROMPT_SENTINEL_731',
  'DOCUMENT_SENTINEL_732',
  'ARGUMENT_SENTINEL_733',
  'RESULT_SENTINEL_734',
];
const [prompt, document, argument, result] = secrets;
function collector() {
  const records: UsageInput[] = [];
  const scope = (context: UsageContext): IUsageRecorder => ({
    with: (extra) => scope({ ...context, ...extra }),
    record: (input) => {
      records.push({ ...input, context: { ...context, ...input.context } });
    },
  });
  return { records, usage: scope({ sessionId: 'completeness' }) };
}
function contentFree(records: UsageInput[]) {
  for (const secret of secrets)
    assert.ok(!JSON.stringify(records).includes(secret), secret);
}
type Mode =
  | 'ok'
  | 'returned'
  | 'throw'
  | 'abort'
  | 'stream-error'
  | 'early'
  | 'throttle';
function fixture() {
  resetQuotaGates();
  const collected = collector();
  const provider = new OpenAIProvider({
    model: 'test',
    credential: staticApiKey('test'),
    whenThrottled: new WaitAsTold(),
  });
  let mode: Mode = 'ok';
  let content = result;
  let requests = 0;
  let streamGate: Promise<void> | undefined;
  provider.client.defaults.adapter = async (config) => {
    requests++;
    if (mode === 'throttle') {
      mode = 'ok';
      throw { response: { status: 429, headers: { 'retry-after': '0.001' } } };
    }
    if (mode === 'throw' || mode === 'abort')
      throw mode === 'abort'
        ? new DOMException(prompt, 'AbortError')
        : Object.assign(new Error(`503 ${prompt}`), { code: 'E_FAILED' });
    const data =
      config.responseType === 'stream'
        ? (async function* () {
            yield Buffer.from(
              `data: ${JSON.stringify(mode === 'returned' ? { error: { message: prompt } } : { choices: [{ delta: { content } }], usage: { prompt_tokens: 7, completion_tokens: 3 } })}\n\n`,
            );
            await streamGate;
            if (mode === 'stream-error') throw new Error(document);
            if (mode === 'early') {
              await new Promise<void>((resolve) => {
                if (config.signal?.aborted) resolve();
                else
                  config.signal?.addEventListener?.('abort', () => resolve(), {
                    once: true,
                  });
              });
              throw new DOMException(prompt, 'AbortError');
            }
            yield Buffer.from('data: [DONE]\n\n');
          })()
        : mode === 'returned'
          ? { error: { message: prompt } }
          : {
              choices: [{ message: { content } }],
              usage: { prompt_tokens: 7, completion_tokens: 3 },
            };
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  };
  return {
    ...collected,
    provider,
    llm: new LlmAdapter(new LlmProviderBridge(provider)),
    requests: () => requests,
    pauseStream: () => {
      let release!: () => void;
      streamGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    mode: (next: Mode) => {
      mode = next;
    },
    content: (next: string) => {
      content = next;
    },
  };
}

for (const stream of [false, true]) {
  for (const mode of [
    'ok',
    'returned',
    'throw',
    'abort',
    ...(stream ? (['stream-error', 'early'] as const) : []),
  ] as const) {
    test(`physical HTTP completeness: ${stream ? 'stream' : 'chat'} ${mode}`, async () => {
      const f = fixture();
      f.mode(mode);
      const run = async () => {
        if (stream)
          for await (const _ of f.llm.streamChat(
            [{ role: 'user', content: prompt }],
            [],
            { usage: f.usage },
          )) {
            if (mode === 'early') break;
          }
        else
          await f.llm.chat([{ role: 'user', content: prompt }], [], {
            usage: f.usage,
          });
      };
      // The adapter represents provider failures as Result errors.
      await run();
      assert.equal(f.requests(), 1);
      assert.equal(f.records.length, 1);
      assert.equal(
        f.records[0].outcome,
        mode === 'ok'
          ? 'ok'
          : mode === 'early' || mode === 'abort'
            ? 'aborted'
            : 'error',
      );
      if (mode === 'early')
        assert.ok(f.records[0].kind === 'llm.call' && f.records[0].closedEarly);
      contentFree(f.records);
    });
  }
  test(`physical HTTP throttle then ${stream ? 'early stream close' : 'success'}`, async () => {
    const f = fixture();
    f.mode('throttle');
    if (stream)
      for await (const _ of f.llm.streamChat([], [], { usage: f.usage })) break;
    else await f.llm.chat([], [], { usage: f.usage });
    const records = f.records.filter((r) => r.kind === 'llm.call');
    assert.equal(f.requests(), 2);
    assert.equal(records.length, 2);
    assert.deepEqual(
      records.map((r) => [r.providerAttempt, r.outcome]),
      [
        [0, 'error'],
        [1, stream ? 'aborted' : 'ok'],
      ],
    );
    assert.equal(records[0].operationId, records[1].operationId);
    assert.deepEqual(
      records.map((r) => r.physicalSeq),
      [0, 1],
    );
    contentFree(records);
  });
}

test('three outer attempts use real HTTP and unique physical coordinates', async () => {
  const f = fixture();
  f.mode('throw');
  await new RetryLlm(f.llm, { maxAttempts: 2, backoffMs: 0 }).chat([], [], {
    usage: f.usage,
  });
  const records = f.records.filter((r) => r.kind === 'llm.call');
  assert.equal(f.requests(), 3);
  assert.deepEqual(
    records.map((r) => [r.outerAttempt, r.physicalSeq]),
    [
      [0, 0],
      [1, 1],
      [2, 2],
    ],
  );
  assert.equal(new Set(records.map((r) => r.operationId)).size, 1);
  contentFree(records);
});

test('library LLM call paths terminate at the real provider with no content', async () => {
  const f = fixture();
  const opts = { usage: f.usage };
  const ctx: ICoordinatorContext = {
    inputText: prompt,
    registry: new Map(),
    stepResults: {},
    sessionId: 's',
    usage: f.usage,
  };
  const paths: Array<[string, string, () => Promise<unknown>]> = [
    [
      'adaptive-planner',
      '{"steps":[{"id":"answer","kind":"answer","text":"done"}]}',
      () =>
        new LlmAdaptiveController(f.llm).plan({
          request: prompt,
          history: [],
          workers: [],
          usage: f.usage,
        }),
    ],
    [
      'adaptive-step-reviewer',
      '{"verdict":"pass","reason":"done"}',
      () =>
        new LlmAdaptiveController(f.llm).check({
          request: prompt,
          step: {
            id: 'check',
            kind: 'check',
            goal: document,
            worker: 'self',
            targets: [],
            onPass: 'next',
            onFail: 'end',
          },
          targets: [],
          usage: f.usage,
        }),
    ],
    ['classifier', '[]', () => new LlmClassifier(f.llm).classify(prompt, opts)],
    [
      'summarizer',
      result,
      () =>
        new HistorySummarizer(f.llm).summarize(
          {
            sessionId: 's',
            turnIndex: 0,
            userText: prompt,
            assistantText: result,
            toolCalls: [],
            toolResults: [],
            timestamp: 0,
          },
          opts,
        ),
    ],
    [
      'translator',
      result,
      () =>
        toEnglishForRag(
          { mainLlm: f.llm, helperLlm: f.llm },
          `${prompt} rÃƒÂ©sumÃƒÂ© sufficiently long`,
          opts,
        ),
    ],
    [
      'query-expander',
      result,
      () => new LlmQueryExpander(f.llm).expand(prompt, opts),
    ],
    [
      'planner',
      '{"steps":[]}',
      () => new OneShotPlanning(f.llm).buildInitialPlan(ctx),
    ],
    [
      'executor',
      result,
      () =>
        new SelfDispatch(f.llm).dispatch(
          { id: 's', goal: prompt, status: 'pending' },
          ctx,
        ),
    ],
    [
      'checker',
      '{"pass":true}',
      () =>
        new LlmReviewStrategy(f.llm).review({
          prompt,
          plan: { nodes: [], createdAt: 0 },
          agents: [],
          sessionId: 's',
          usage: f.usage,
        }),
    ],
    [
      'finalizer',
      result,
      () =>
        new LlmFinalizer(f.llm).finalize({
          prompt,
          objective: document,
          interpreterOutput: result,
          executionTrace: [],
          usage: f.usage,
        }),
    ],
    [
      'step-reviewer',
      '{"action":"abort"}',
      () =>
        new LlmReviewStrategy(f.llm).reviewExecutionFailure({
          plan: { nodes: [], createdAt: 0 },
          trace: [],
          failedNodeId: 's',
          error: result,
          agents: [],
          sessionId: 's',
          usage: f.usage,
        }),
    ],
    ...['planner', 'executor', 'checker'].map(
      (role): [string, string, () => Promise<unknown>] => [
        `${role} worker`,
        result,
        () =>
          new DirectLlmSubAgent(role, f.llm, {
            systemPrompt: document,
            contextPolicy: 'optional',
          }).run({ task: prompt, usage: f.usage }),
      ],
    ),
  ];
  for (const [name, response, run] of paths) {
    f.content(response);
    const before = f.requests();
    const count = f.records.length;
    await run();
    assert.equal(f.requests() - before, 1, name);
    assert.equal(f.records.length - count, 1, name);
    assert.equal(f.records.at(-1)?.outcome, 'ok', name);
    assert.ok(f.records.at(-1)?.context.sessionId, name);
    for (const mode of ['returned', 'throw', 'abort'] as const) {
      f.mode(mode);
      const beforeFailure = f.requests();
      const recordedBefore = f.records.length;
      // Components may surface a Result, throw, or fall back after a provider error.
      await Promise.allSettled([run()]);
      const failures = f.records.slice(recordedBefore);
      assert.ok(f.requests() > beforeFailure, `${name}: ${mode}`);
      assert.equal(
        failures.length,
        f.requests() - beforeFailure,
        `${name}: ${mode}`,
      );
      assert.ok(
        failures.every(
          (r) => r.outcome === (mode === 'abort' ? 'aborted' : 'error'),
        ),
        `${name}: ${mode}`,
      );
    }
    f.mode('ok');
  }
  f.content(result);
  const pipeline = new DefaultPipeline();
  const execute = pipeline.execute.bind(pipeline);
  let completion: ReturnType<typeof execute> | undefined;
  pipeline.execute = (...args) => {
    completion = execute(...args);
    return completion;
  };
  const handle = await new SmartAgentBuilder({ skipModelValidation: true })
    .withMainLlm(f.llm)
    .setPipeline(pipeline)
    .build();
  try {
    for (const mode of [
      'ok',
      'returned',
      'throw',
      'abort',
      'stream-error',
      'early',
    ] as const) {
      // Closing the pipeline consumer leaves the physical provider stream running.
      f.mode(mode === 'early' ? 'ok' : mode);
      const release = mode === 'early' ? f.pauseStream() : undefined;
      const before = f.requests();
      const count = f.records.length;
      await Promise.allSettled([
        (async () => {
          if (mode === 'early') {
            for await (const chunk of handle.agent.streamProcess(prompt, {
              usage: f.usage,
            })) {
              if (chunk) break;
            }
          } else {
            await new SmartAgentSubAgent('smart', handle.agent).run({
              task: prompt,
              usage: f.usage,
            });
          }
        })(),
      ]);
      if (mode === 'early') {
        assert.ok(f.requests() > before);
        assert.equal(f.records.length, count);
        release?.();
      }
      assert.ok(completion);
      await completion;
      const calls = f.records.slice(count);
      assert.ok(f.requests() > before, mode);
      assert.equal(calls.length, f.requests() - before, mode);
      assert.ok(
        calls.every(
          (r) =>
            r.kind === 'llm.call' &&
            r.context.role === 'tool-loop' &&
            r.outcome ===
              (mode === 'ok' || mode === 'early'
                ? 'ok'
                : mode === 'abort'
                  ? 'aborted'
                  : 'error'),
        ),
        mode,
      );
      assert.ok(calls.every((r) => r.kind === 'llm.call' && !r.closedEarly));
    }
  } finally {
    await handle.close();
  }
  contentFree(f.records);
});

test('real embedding HTTP covers RAG indexing, query and tool vectorization', async (t) => {
  const { usage, records } = collector();
  let requests = 0;
  let mode: Mode = 'ok';
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    if (mode === 'returned') return new Response(document, { status: 500 });
    if (mode === 'abort') throw new DOMException(prompt, 'AbortError');
    if (mode === 'throw') throw new Error(document);
    return Response.json({
      data: [{ embedding: [1, 0], index: 0 }],
      usage: { prompt_tokens: 11 },
    });
  });
  const embedder = new OpenAiEmbedder({
    credential: staticApiKey('test'),
    model: 'test',
  });
  const rag = new VectorRag({
    embedDocument: embedder.embed.bind(embedder),
    embedQuery: embedder.embed.bind(embedder),
  });
  const paths: Array<[string, () => Promise<unknown>]> = [
    ['indexing', () => rag.upsert(document, { id: 'doc' }, { usage })],
    ['query', () => rag.query(new TextOnlyEmbedding(prompt), 1, { usage })],
    [
      'tool vectorization',
      () =>
        vectorizeMcpTools(
          [
            {
              listTools: async () => ({
                ok: true,
                value: [
                  { name: 'read', description: document, inputSchema: {} },
                ],
              }),
              callTool: async () => ({ ok: true, value: { content: result } }),
            },
          ],
          rag,
          new SessionRequestLogger(),
          undefined,
          undefined,
          { usage },
        ),
    ],
  ];
  for (const [name, run] of paths) {
    for (const next of ['ok', 'returned', 'throw', 'abort'] as const) {
      mode = next;
      const before = requests;
      const count = records.length;
      await Promise.allSettled([run()]);
      const calls = records.slice(count);
      assert.equal(
        requests - before,
        next === 'ok' || next === 'abort' ? 1 : 3,
        `${name}: ${next}`,
      );
      assert.equal(calls.length, requests - before, `${name}: ${next}`);
      assert.ok(
        calls.every(
          (r) =>
            r.kind === 'embedding.call' &&
            r.context.role === 'embedding' &&
            r.outcome ===
              (next === 'ok' ? 'ok' : next === 'abort' ? 'aborted' : 'error'),
        ),
        `${name}: ${next}`,
      );
    }
  }
  assert.equal(records.length, requests);
  assert.ok(
    records.every(
      (r) =>
        r.kind === 'embedding.call' &&
        (r.outcome !== 'ok' ||
          (r.inputTokens === 11 && r.tokensSource === 'provider')),
    ),
  );
  contentFree(records);
});

test('DAG planner and stepper checker use real provider requests', async () => {
  const f = fixture();
  f.content('{"nodes":[{"id":"one","goal":"work"}]}');
  const plan = () =>
    new LlmDagPlanner(f.llm).plan({
      prompt,
      agents: [],
      sessionId: 's',
      usage: f.usage,
    });
  f.content('{"route":"executable","missing":[]}');
  const evaluate = () =>
    new LlmEvaluator(f.llm).evaluate({
      prompt,
      usage: f.usage,
      identity: {
        traceId: 'trace',
        turnId: 'turn',
        sessionId: 's',
        stepperId: 'stepper',
      },
      knowledgeRag: {
        query: async () => [],
        list: async () => [],
        write: async () => {},
        fingerprint: () => 'test',
      },
      toolsRag: { query: async () => [], lookup: () => undefined },
    });
  for (const [role, response, run] of [
    ['planner', '{"nodes":[{"id":"one","goal":"work"}]}', plan],
    ['evaluator', '{"route":"executable","missing":[]}', evaluate],
  ] as const) {
    f.content(response);
    for (const mode of ['ok', 'returned', 'throw', 'abort'] as const) {
      f.mode(mode);
      const before = f.requests();
      const count = f.records.length;
      await Promise.allSettled([run()]);
      const calls = f.records.slice(count);
      assert.equal(f.requests() - before, 1, `${role}: ${mode}`);
      assert.equal(calls.length, 1, `${role}: ${mode}`);
      assert.deepEqual(
        calls.map((r) => [r.kind, r.context.role, r.outcome]),
        [
          [
            'llm.call',
            role,
            mode === 'ok' ? 'ok' : mode === 'abort' ? 'aborted' : 'error',
          ],
        ],
      );
    }
  }
  contentFree(f.records);
});

test('embedding returned errors, throws and aborts count every HTTP attempt', async (t) => {
  for (const mode of ['returned', 'throw', 'abort'] as const) {
    const { usage, records } = collector();
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      requests++;
      if (mode === 'returned') return new Response(document, { status: 500 });
      if (mode === 'abort') throw new DOMException(prompt, 'AbortError');
      throw Object.assign(new Error(document), { code: 'ECONNRESET' });
    });
    const provider = new OpenAiEmbedder({
      credential: staticApiKey('test'),
      model: 'test',
    });
    await assert.rejects(provider.embed(document, { usage }));
    assert.equal(requests, mode === 'abort' ? 1 : 3);
    assert.equal(records.length, requests);
    assert.ok(
      records.every(
        (r) =>
          r.kind === 'embedding.call' &&
          r.outcome === (mode === 'abort' ? 'aborted' : 'error'),
      ),
    );
    contentFree(records);
  }
});

test('omitting a recorder preserves provider, adapter and embedding results', async (t) => {
  const f = fixture();
  const messages = [{ role: 'user' as const, content: prompt }];
  assert.deepEqual(
    await f.llm.chat(messages),
    await f.llm.chat(messages, [], { usage: f.usage }),
  );
  const consume = async (options?: CallOptions) => {
    const chunks = [];
    for await (const chunk of f.llm.streamChat(messages, [], options))
      chunks.push(chunk);
    return chunks;
  };
  assert.deepEqual(await consume(), await consume({ usage: f.usage }));
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      data: [{ embedding: [1], index: 0 }],
      usage: { prompt_tokens: 5, total_tokens: 5 },
    }),
  );
  const embedder = new OpenAiEmbedder({
    credential: staticApiKey('test'),
    model: 'test',
  });
  assert.deepEqual(
    await embedder.embed(document),
    await embedder.embed(document, { usage: f.usage }),
  );
  assert.equal(f.records.length, 3);
  contentFree(f.records);
});

test('three chunks failing last; nested outer chunks, outer retries and provider retries', async (t) => {
  for (const nested of [false, true]) {
    const { usage, records } = collector();
    let requests = 0;
    t.mock.method(
      globalThis,
      'fetch',
      async (_url: unknown, init?: RequestInit) => {
        const n = requests++;
        if (nested ? n >= 4 && n <= 6 : n >= 2)
          return new Response(document, { status: 500 });
        if (nested && n === 7) return new Response(document, { status: 429 });
        const inputs = JSON.parse(String(init?.body)).input as string[];
        return Response.json({
          data: inputs.map((_, index) => ({ embedding: [1], index })),
          usage: { prompt_tokens: 11 },
        });
      },
    );
    const provider = new OpenAiEmbedder({
      credential: staticApiKey('test'),
      model: 'test',
    });
    const wrapped = new BatchChunkingEmbedder(
      nested
        ? new RetryBatchEmbedder(provider, { maxAttempts: 1, backoffMs: 0 })
        : provider,
      nested ? 200 : 1,
    );
    const run = () =>
      wrapped.embedBatch(
        Array.from({ length: nested ? 600 : 3 }, () => document),
        { usage },
      );
    if (nested) await run();
    else await assert.rejects(run());
    const calls = records.filter((r) => r.kind === 'embedding.call');
    assert.equal(calls.length, requests);
    assert.equal(new Set(calls.map((r) => r.operationId)).size, 1);
    assert.deepEqual(
      calls.map((r) => r.physicalSeq),
      calls.map((_, i) => i),
    );
    assert.deepEqual(
      calls.map((r) => [
        r.chunkPath,
        r.outerAttempt,
        r.providerAttempt,
        r.outcome,
      ]),
      nested
        ? [
            ['1/3>1/2', 0, 0, 'ok'],
            ['1/3>2/2', 0, 0, 'ok'],
            ['2/3>1/2', 0, 0, 'ok'],
            ['2/3>2/2', 0, 0, 'ok'],
            ['3/3>1/2', 0, 0, 'error'],
            ['3/3>1/2', 0, 1, 'error'],
            ['3/3>1/2', 0, 2, 'error'],
            ['3/3>1/2', 1, 0, 'error'],
            ['3/3>1/2', 1, 1, 'ok'],
            ['3/3>2/2', 1, 0, 'ok'],
          ]
        : [
            ['1/3>1/1', 0, 0, 'ok'],
            ['2/3>1/1', 0, 0, 'ok'],
            ['3/3>1/1', 0, 0, 'error'],
            ['3/3>1/1', 0, 1, 'error'],
            ['3/3>1/1', 0, 2, 'error'],
          ],
    );
    contentFree(records);
  }
});

test('embedded handler outcomes and network reconnect count physical MCP dispatches', async () => {
  for (const mode of ['ok', 'returned', 'throw', 'abort', 'reconnect']) {
    const { usage, records } = collector();
    const controller = new AbortController();
    let requests = 0;
    const call = async () => {
      requests++;
      if (mode === 'abort') controller.abort();
      if (
        mode === 'throw' ||
        mode === 'abort' ||
        (mode === 'reconnect' && requests === 1)
      )
        throw Object.assign(new Error(argument), { status: 503 });
      return { content: result, isError: mode === 'returned' };
    };
    const wrapper = new MCPClientWrapper({
      transport: mode === 'reconnect' ? 'stream-http' : 'embedded',
      url: 'http://localhost:9',
      callToolHandler: call,
    });
    if (mode === 'reconnect') {
      const state = wrapper as unknown as {
        client: unknown;
        sessionId: string;
      };
      state.client = { callTool: call };
      state.sessionId = 's';
      wrapper.disconnect = async () => {
        state.client = null;
      };
      wrapper.connect = async () => {
        state.client = { callTool: call };
      };
    }
    await wrapper.callTool(
      { id: 'id', name: 'read', arguments: { text: argument } },
      controller.signal,
      { usage },
    );
    assert.equal(requests, mode === 'reconnect' ? 2 : 1);
    assert.equal(records.length, requests);
    assert.deepEqual(
      records.map((r) => r.outcome),
      mode === 'reconnect'
        ? ['error', 'ok']
        : [mode === 'abort' ? 'aborted' : mode === 'ok' ? 'ok' : 'error'],
    );
    contentFree(records);
  }
});

for (const mode of ['ok', 'returned', 'throw', 'abort'] as const) {
  test(`tool-loop, coordinator tool callback and mixed handler reach MCP boundaries: ${mode}`, async () => {
    const { usage, records } = collector();
    let requests = 0;
    let controller = new AbortController();
    const client = new McpClientAdapter(
      new MCPClientWrapper({
        transport: 'embedded',
        callToolHandler: async () => {
          requests++;
          if (mode === 'abort') controller.abort();
          if (mode === 'throw' || mode === 'abort') throw new Error(argument);
          return { content: result, isError: mode === 'returned' };
        },
      }),
    );
    const tc = { id: 'id', name: 'read', arguments: { text: argument } };
    const options: CallOptions = { usage, signal: controller.signal };
    const tracer = new NoopTracer();
    const metrics = new NoopMetrics();
    const { ToolCache } = await import('@mcp-abap-adt/llm-agent');
    const cache = new ToolCache();
    const runBatch = async () => {
      for await (const _ of executeToolBatchWithHeartbeat({
        batch: [tc],
        toolClientMap: new Map([['read', client]]),
        toolCache: cache,
        tracer,
        metrics,
        parentSpan: tracer.startSpan('test'),
        toolAvailabilityRegistry: new ToolAvailabilityRegistry(),
        sessionId: 's',
        externalToolNames: new Set(),
        currentTools: [],
        toolCallCount: 0,
        timingLog: [],
        heartbeatMs: null,
        options,
      })) {
      }
    };
    await runBatch();
    assert.equal(requests, 1);
    assert.equal(records.length, 1);
    if (mode === 'ok') {
      const beforeHit = records.length;
      const beforeRequests = requests;
      await runBatch();
      assert.equal(requests, beforeRequests);
      assert.equal(records.length - beforeHit, 1);
      const hit = records.at(-1);
      assert.ok(hit?.kind === 'tool.call');
      assert.equal(hit.dispatched, false);
      assert.equal(hit.outcome, 'ok');
      assert.equal(hit.context.role, 'tool-loop');
      contentFree(records);
    }
    controller = new AbortController();
    options.signal = controller.signal;
    const beforeMixed = records.length;
    const registry = new PendingToolResultsRegistry();
    fireInternalToolsAsync('', [tc], registry, 's', {
      toolClientMap: new Map([['read', client]]),
      toolCache: new ToolCache(),
      metrics,
      options,
    });
    await registry.consume('s');
    assert.equal(requests, 2);
    assert.equal(records.length - beforeMixed, 1);
    controller = new AbortController();
    const beforeCoordinator = records.length;
    const f = fixture();
    let llmCalls = 0;
    f.provider.client.defaults.adapter = async (config) => ({
      config,
      status: 200,
      statusText: 'OK',
      headers: {},
      data: {
        choices: [
          {
            message:
              llmCalls++ === 0
                ? {
                    content: '',
                    tool_calls: [
                      {
                        id: 'id',
                        type: 'function',
                        function: {
                          name: 'read',
                          arguments: JSON.stringify({ text: argument }),
                        },
                      },
                    ],
                  }
                : { content: result },
          },
        ],
      },
    });
    await new SelfDispatch(f.llm).dispatch(
      { id: 's', goal: prompt, status: 'pending' },
      {
        inputText: prompt,
        registry: new Map(),
        stepResults: {},
        sessionId: 's',
        usage,
        selectedTools: [
          {
            name: 'read',
            description: document,
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        callTool: async (name, args, _signal, opts) => {
          const r = await client.callTool(
            name,
            args as Record<string, unknown>,
            { ...opts, signal: controller.signal },
          );
          return r.ok ? JSON.stringify(r.value.content) : '';
        },
      },
    );
    assert.equal(requests, 3);
    assert.equal(
      records.slice(beforeCoordinator).filter((r) => r.kind === 'tool.call')
        .length,
      1,
    );
    assert.ok(
      records
        .filter((r) => r.kind === 'llm.call')
        .every((r) => r.context.role === 'executor' && r.outcome === 'ok'),
    );
    assert.equal(
      records.filter((r) => r.kind === 'tool.call').length,
      requests + (mode === 'ok' ? 1 : 0),
    );
    assert.equal(records.filter((r) => r.kind === 'llm.call').length, llmCalls);
    const dispatched = records.filter(
      (r) => r.kind === 'tool.call' && r.dispatched,
    );
    assert.equal(dispatched.length, requests);
    assert.deepEqual(
      dispatched.map((r) => [r.context.role, r.outcome]),
      [
        [
          'tool-loop',
          mode === 'ok' ? 'ok' : mode === 'abort' ? 'aborted' : 'error',
        ],
        [
          'tool-loop',
          mode === 'ok' ? 'ok' : mode === 'abort' ? 'aborted' : 'error',
        ],
        [
          'executor',
          mode === 'ok' ? 'ok' : mode === 'abort' ? 'aborted' : 'error',
        ],
      ],
    );
    contentFree(records);
  });
}

test('concurrent TaskBoard workers retain their task context through real HTTP', async () => {
  const f = fixture();
  const releases: (() => void)[] = [];
  const worker = new DirectLlmSubAgent('worker', f.llm, {
    systemPrompt: document,
    contextPolicy: 'optional',
  });
  const board = new TaskBoard({
    usage: f.usage,
    maxConcurrent: 2,
    onEvent() {},
    workers: new Map([
      [
        'worker',
        {
          ...worker,
          name: worker.name,
          capabilities: worker.capabilities,
          async run(input) {
            await new Promise<void>((resolve) => releases.push(resolve));
            return worker.run(input);
          },
        },
      ],
    ]),
  });
  for (let i = 0; i < 2; i++)
    assert.ok(board.start({ worker: 'worker', goal: prompt }).ok);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 2);
  for (const release of releases.reverse()) release();
  for (
    let i = 0;
    i < 20 && board.list().some((task) => task.state !== 'done');
    i++
  )
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.requests(), 2);
  assert.deepEqual(
    f.records
      .filter((r) => r.kind === 'llm.call')
      .map((r) => r.context.taskId)
      .sort(),
    ['t1', 't2'],
  );
  assert.deepEqual(
    f.records
      .filter((r) => r.kind === 'task')
      .map((r) => r.context.taskId)
      .sort(),
    ['t1', 't2'],
  );
  await board.stopAll();
  contentFree(f.records);
});

test('shutdown deadlines and public delivery classification', async () => {
  const hang = () => new Promise<void>(() => {});
  for (const mode of [
    'send-hangs',
    'close-hangs',
    'http-ack',
    'partial',
    'plain',
    'definite',
    'custom-sink',
  ] as const) {
    const sink = memorySink({ limit: 10 });
    const error =
      mode === 'definite' || mode === 'custom-sink'
        ? new UsageDeliveryError('unwritten', false)
        : new Error('unknown');
    const transport =
      mode === 'http-ack'
        ? httpTransport({
            url: 'http://collector',
            fetch: async (_url, init) => {
              await sink.write(JSON.parse(String(init?.body)).records);
              throw new Error('acknowledgement lost');
            },
          })
        : mode === 'partial' || mode === 'custom-sink'
          ? directTransport(
              combineSinks(
                ...(mode === 'partial'
                  ? [
                      sink,
                      {
                        write: async () => {
                          throw error;
                        },
                      },
                    ]
                  : [
                      {
                        write: async () => {
                          throw error;
                        },
                      },
                    ]),
              ),
            )
          : mode === 'close-hangs'
            ? directTransport({ write: sink.write, close: hang })
            : {
                send:
                  mode === 'send-hangs'
                    ? hang
                    : async () => {
                        throw error;
                      },
                close: mode === 'send-hangs' ? hang : async () => {},
              };
    const recorder = createUsageRecorder({
      transport,
      flushMs: 1,
      retryWindowMs: 0,
    });
    recorder.record({
      kind: 'x.test',
      context: { sessionId: 's' },
      outcome: 'ok',
      values: {},
    });
    const start = Date.now();
    const totals = await recorder.close(40);
    assert.ok(Date.now() - start < 500, mode);
    // Failed evidence delivery is included once, without recursively creating evidence.
    assert.deepEqual(
      totals,
      mode === 'close-hangs'
        ? { delivered: 1, lost: 0, unconfirmed: 0 }
        : mode === 'send-hangs'
          ? { delivered: 0, lost: 1, unconfirmed: 1 }
          : mode === 'definite' || mode === 'custom-sink'
            ? { delivered: 0, lost: 2, unconfirmed: 0 }
            : { delivered: 0, lost: 0, unconfirmed: 2 },
      mode,
    );
    if (mode === 'http-ack' || mode === 'partial') {
      const stored = [];
      for await (const record of sink.read({ from: 0, to: Infinity }))
        stored.push(record);
      assert.equal(stored.filter((r) => r.kind === 'x.test').length, 1, mode);
    }
  }
});
