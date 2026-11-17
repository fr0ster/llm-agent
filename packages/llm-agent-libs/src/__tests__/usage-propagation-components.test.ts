import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CallOptions,
  type ILlm,
  type IUsageRecorder,
  startOperation,
  type UsageContext,
} from '@mcp-abap-adt/llm-agent';
import { wrapEmbedder } from '../adapters/usage-logging-embedder.js';
import { summarizeHistory, toEnglishForRag } from '../agent/rag-helpers.js';
import { LlmClassifier } from '../classifier/llm-classifier.js';
import { ContextAssembler } from '../context/context-assembler.js';
import { HistorySummarizer } from '../history/history-summarizer.js';
import { SessionRequestLogger } from '../logger/session-request-logger.js';
import { LlmReranker } from '../reranker/llm-reranker.js';

function recorder(
  context: UsageContext = {},
): IUsageRecorder & { context: UsageContext } {
  return {
    context,
    record() {},
    with(extra) {
      return recorder({ ...context, ...extra });
    },
  };
}

test('component LLM calls preserve caller coordinates and narrow recorder roles without mutation', async () => {
  const usage = recorder({ sessionId: 'session', taskId: 'task' });
  const usageOp = startOperation();
  const options = { usage, usageOp };
  const seen: CallOptions[] = [];
  const llm: ILlm = {
    async chat(_messages, _tools, opts) {
      assert.ok(opts);
      seen.push(opts);
      return { ok: true, value: { content: '[]', finishReason: 'stop' } };
    },
    async *streamChat() {},
  };
  await new LlmClassifier(llm).classify('request', options);
  await new HistorySummarizer(llm).summarize(
    {
      sessionId: 'session',
      turnIndex: 0,
      userText: 'question',
      assistantText: 'answer',
      toolCalls: [],
      toolResults: [],
      timestamp: 0,
    },
    options,
  );
  await new LlmReranker(llm).rerank(
    'query',
    [
      { text: 'a', metadata: {}, score: 1 },
      { text: 'b', metadata: {}, score: 0 },
    ],
    options,
  );
  await toEnglishForRag(
    { mainLlm: llm, helperLlm: llm },
    'A sufficiently long resum\u00e9 request',
    options,
  );
  await summarizeHistory(
    { helperLlm: llm, requestLogger: new SessionRequestLogger() },
    Array.from({ length: 7 }, () => ({
      role: 'user' as const,
      content: 'message',
    })),
    options,
  );
  assert.deepEqual(
    seen.map((opts) => (opts.usage as ReturnType<typeof recorder>).context),
    ['classifier', 'helper', 'rerank', 'translate'].map((role) => ({
      sessionId: 'session',
      taskId: 'task',
      role,
    })),
  );
  for (const opts of seen) assert.equal(opts.usageOp, usageOp);
  assert.deepEqual(usage.context, { sessionId: 'session', taskId: 'task' });
});

test('embedding logging wrapper preserves operation and narrows recorder', async () => {
  const usage = recorder({ taskId: 'task' });
  const usageOp = startOperation();
  let captured: CallOptions | undefined;
  await wrapEmbedder({
    async embed(_text, opts) {
      captured = opts;
      return { vector: [1] };
    },
  }).embed('document', { usage, usageOp });
  assert.deepEqual(captured?.usageOp, usageOp);
  assert.ok(captured);
  assert.deepEqual((captured.usage as ReturnType<typeof recorder>).context, {
    taskId: 'task',
    role: 'embedding',
  });
});

import type { IMcpClient, IMetrics, IToolCache } from '@mcp-abap-adt/llm-agent';
import type { PipelineContext } from '../pipeline/context.js';
import { runPassThrough } from '../pipeline/handlers/pass-through.js';
import { SummarizeHandler } from '../pipeline/handlers/summarize.js';
import { TranslateHandler } from '../pipeline/handlers/translate.js';
import { fireInternalToolsAsync } from '../policy/mixed-tool-call-handler.js';
import { PendingToolResultsRegistry } from '../policy/pending-tool-results-registry.js';
import { NoopTracer } from '../tracer/noop-tracer.js';

test('pipeline translator and pass-through forward usage; summarize is inert', async () => {
  const usage = recorder({ taskId: 'task' });
  const usageOp = startOperation();
  const seen: CallOptions[] = [];
  const capture = (opts?: CallOptions) => {
    assert.ok(opts);
    seen.push(opts);
  };
  const llm: ILlm = {
    async chat(_messages, _tools, opts) {
      capture(opts);
      return {
        ok: true,
        value: { content: 'English response', finishReason: 'stop' },
      };
    },
    async *streamChat(_messages, _tools, opts) {
      capture(opts);
      yield { ok: true, value: { content: 'answer' } };
    },
  };
  const logger = new SessionRequestLogger();
  const options = { usage, usageOp };
  const ctx = {
    options,
    helperLlm: llm,
    mainLlm: llm,
    requestLogger: logger,
    ragText: 'A sufficiently long resum\u00e9 request',
    config: {},
    history: Array.from({ length: 12 }, () => ({
      role: 'user',
      content: 'message',
    })),
  } as unknown as PipelineContext;
  const span = new NoopTracer().startSpan('test');
  await new TranslateHandler().execute(ctx, {}, span);
  await new SummarizeHandler().execute(ctx, {}, span);
  const assembled = await new ContextAssembler().assemble(
    { type: 'action', text: 'Continue' },
    { ragResults: {}, tools: [] },
    ctx.history,
  );
  assert.ok(assembled.ok);
  assert.equal(
    assembled.value.filter((message) => message.content === 'message').length,
    12,
  );
  assert.equal(seen.length, 1, 'summarize makes no helper call');
  assert.ok(
    !assembled.value.some((message) =>
      message.content?.startsWith('Summary of previous conversation:'),
    ),
  );
  for await (const _ of runPassThrough(llm, logger, [], [], options)) {
  }
  assert.deepEqual(
    seen.map(
      (opts) => (opts.usage as ReturnType<typeof recorder>).context.role,
    ),
    ['translate', undefined],
  );
  for (const opts of seen) assert.equal(opts.usageOp, usageOp);
});

test('mixed tool-call handler forwards task recorder and operation to MCP', async () => {
  const usage = recorder({ taskId: 'task' });
  const usageOp = startOperation();
  let captured: CallOptions | undefined;
  const client = {
    async callTool(_name: string, _args: unknown, opts?: CallOptions) {
      captured = opts;
      return { ok: true, value: { content: 'result' } };
    },
  } as unknown as IMcpClient;
  const registry = new PendingToolResultsRegistry();
  fireInternalToolsAsync(
    '',
    [{ id: 'id', name: 'tool', arguments: {} }],
    registry,
    {
      kind: 'caller',
      caller: { userId: 'test-user', sessionId: 'session', isAdmin: false },
    },
    {
      toolClientMap: new Map([['tool', client]]),
      toolCache: { set() {} } as unknown as IToolCache,
      metrics: { toolCallCount: { add() {} } } as unknown as IMetrics,
      options: { userId: 'test-user', sessionId: 'session', usage, usageOp },
    },
  );
  await registry.consume({ userId: 'test-user', sessionId: 'session' });
  assert.equal(captured?.usageOp, usageOp);
  assert.ok(captured);
  assert.deepEqual((captured.usage as ReturnType<typeof recorder>).context, {
    taskId: 'task',
    component: 'tool-loop',
  });
});

import type { IRag } from '@mcp-abap-adt/llm-agent';
import {
  vectorizeMcpTools,
  vectorizeSkills,
} from '../mcp/vectorize-mcp-tools.js';

test('tool and skill vectorization forward recorder and operation on sequential writes', async () => {
  const usage = recorder({ sessionId: 'session' });
  const usageOp = startOperation();
  const options = { usage, usageOp };
  const seen: CallOptions[] = [];
  const rag = {
    writer: () => ({
      async upsertRaw(
        _id: string,
        _text: string,
        _metadata: unknown,
        opts: CallOptions,
      ) {
        seen.push(opts);
        return { ok: true, value: undefined };
      },
    }),
  } as unknown as IRag;
  const client = {
    async listTools(opts?: CallOptions) {
      assert.equal(opts?.usage, usage);
      return {
        ok: true,
        value: [{ name: 'tool', description: 'description', inputSchema: {} }],
      };
    },
  } as unknown as IMcpClient;
  await vectorizeMcpTools(
    [client],
    rag,
    new SessionRequestLogger(),
    undefined,
    undefined,
    options,
  );
  await vectorizeSkills(
    {
      async listSkills(opts?: CallOptions) {
        assert.equal(opts?.usage, usage);
        return {
          ok: true,
          value: [{ name: 'skill', description: 'description' }],
        };
      },
    } as Parameters<typeof vectorizeSkills>[0],
    rag,
    new SessionRequestLogger(),
    undefined,
    options,
  );
  assert.equal(seen.length, 2);
  for (const opts of seen) {
    assert.equal(opts.usageOp, usageOp);
    assert.deepEqual((opts.usage as ReturnType<typeof recorder>).context, {
      sessionId: 'session',
      role: 'embedding',
    });
  }
});

test('deprecated summarizeHistory returns the same complete history without a helper call', async () => {
  const history = Array.from({ length: 25 }, (_, i) => ({
    role: 'user' as const,
    content: `${i}:${'x'.repeat(200_000)}`,
  }));
  const llm: ILlm = {
    async chat() {
      assert.fail('history summarization must not call the helper');
    },
    async *streamChat() {},
  };
  const result = await summarizeHistory(
    { helperLlm: llm, requestLogger: new SessionRequestLogger() },
    history,
  );
  assert.ok(result.ok);
  assert.equal(result.value, history);
  assert.equal(result.value.length, history.length);
});

test('summarizeHistory is inert and ContextAssembler excludes client system messages', async () => {
  const history = [
    { role: 'system' as const, content: 'Original system sentinel' },
    { role: 'user' as const, content: 'Original request sentinel' },
    { role: 'assistant' as const, content: 'Original reply sentinel' },
    { role: 'user' as const, content: 'Continue the task' },
  ];
  let helperCalls = 0;
  const helperLlm: ILlm = {
    async chat(messages) {
      helperCalls++;
      assert.deepEqual(messages.slice(0, -1), history);
      return {
        ok: true,
        value: { content: 'Summary sentinel', finishReason: 'stop' },
      };
    },
    async *streamChat() {},
  };
  const summarized = await summarizeHistory(
    { helperLlm, requestLogger: new SessionRequestLogger() },
    history,
  );
  assert.ok(summarized.ok);
  const assembled = await new ContextAssembler().assemble(
    { type: 'action', text: 'Continue the task' },
    { ragResults: {}, tools: [] },
    summarized.value,
  );
  assert.ok(assembled.ok);
  assert.equal(helperCalls, 0);
  for (const original of history.filter(
    (message) => message.role !== 'system',
  )) {
    assert.ok(
      assembled.value.some(
        (message) =>
          message.role === original.role &&
          message.content?.includes(original.content),
      ),
    );
  }
  assert.ok(
    !assembled.value.some((message) =>
      message.content?.includes('Original system sentinel'),
    ),
  );
  assert.ok(
    !assembled.value.some((message) =>
      message.content?.includes('Summary sentinel'),
    ),
  );
});
