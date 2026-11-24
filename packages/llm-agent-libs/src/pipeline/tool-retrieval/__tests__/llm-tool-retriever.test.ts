import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EMBEDDING_CONTEXT_EXCEEDED,
  type ILlm,
  type IUsageRecorder,
  LlmError,
  MODEL_CONTEXT_EXCEEDED,
  reportLlmRequest,
  SmartAgentError,
  startOperation,
  TOOL_RETRIEVAL_INVALID,
  type ToolCandidate,
  type UsageContext,
  type UsageInput,
} from '@mcp-abap-adt/llm-agent';
import { DefaultRequestLogger } from '../../../logger/default-request-logger.js';
import { makeLlm } from '../../../testing/index.js';
import { LlmToolRetriever } from '../llm-tool-retriever.js';

const candidates: ToolCandidate[] = [
  {
    name: 'write',
    description: 'Write a file',
    inputSchema: { type: 'object' },
  },
  {
    name: 'read',
    description: 'Read a file',
    inputSchema: {
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
];
const usage = {
  promptTokens: 42,
  cachedInputTokens: 30,
  completionTokens: 8,
  totalTokens: 50,
};
const model = 'selector-model';
const request = { text: 'Read the file', candidates };

function makeSelector(chat: ILlm['chat']) {
  return new LlmToolRetriever({ ...makeLlm([]), model, chat });
}

test('selects using one chat call and puts the stable full catalogue before the step', async (t) => {
  const chat = t.mock.fn<ILlm['chat']>(async () => ({
    ok: true,
    value: { content: '{"tools":["read","write"]}', finishReason: 'stop' },
  }));
  const retriever = makeSelector(chat);
  assert.deepEqual(await retriever.retrieve(request), {
    ok: true,
    value: { names: ['read', 'write'] },
  });
  assert.equal(chat.mock.callCount(), 1);
  const second = await retriever.retrieve({
    text: 'Another step',
    candidates: [...candidates].reverse(),
  });
  assert.equal(second.ok, true);
  assert.equal(chat.mock.callCount(), 2);
  const [firstMessages, firstTools] = chat.mock.calls[0].arguments;
  const [secondMessages] = chat.mock.calls[1].arguments;
  assert.equal(firstTools, undefined);
  assert.deepEqual(firstMessages.slice(0, -1), secondMessages.slice(0, -1));
  assert.equal(
    firstMessages[1].content,
    `Tool catalogue:\n${JSON.stringify([candidates[1], candidates[0]])}`,
  );
  assert.equal(firstMessages.at(-1)?.content, request.text);
  assert.equal(secondMessages.at(-1)?.content, 'Another step');
});

test('rejects invalid decisions and retains the single call usage', async () => {
  for (const content of [
    '{"tools":["read","missing"]}',
    '{"tools":[1]}',
    '{"tools":"read"}',
    '{"tools":["read"],"extra":true}',
    '{}',
    '[]',
    'null',
    'bad JSON',
  ]) {
    const requestLogger = new DefaultRequestLogger();
    const result = await makeSelector(async () => ({
      ok: true,
      value: { content, finishReason: 'stop', usage, model },
    })).retrieve(request, { requestLogger });
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.error.code, TOOL_RETRIEVAL_INVALID);
    assert.equal(result.error.usageCalls?.length, 1);
    assert.equal(result.error.usageCalls?.[0].totalTokens, 50);
    assert.equal(requestLogger.getSummary().byModel[model].requests, 1);
  }
});

test('short-circuits an already aborted signal and preserves usage on an in-flight abort', async (t) => {
  const controller = new AbortController();
  const chat = t.mock.fn<ILlm['chat']>(async (_messages, _tools, options) => {
    assert.equal(options?.signal, controller.signal);
    controller.abort();
    return {
      ok: false,
      error: Object.assign(new LlmError('Canceled', 'ABORTED'), { usage }),
    };
  });
  const retriever = makeSelector(chat);
  const result = await retriever.retrieve(request, {
    signal: controller.signal,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'ABORTED');
  assert.equal(result.error.usageCalls?.[0].model, model);
  assert.equal(result.error.usageCalls?.[0].totalTokens, 50);
  const alreadyAborted = await retriever.retrieve(request, {
    signal: controller.signal,
  });
  assert.equal(alreadyAborted.ok, false);
  if (!alreadyAborted.ok) assert.equal(alreadyAborted.error.code, 'ABORTED');
  assert.equal(chat.mock.callCount(), 1);
});

test('preserves typed provider errors and usage when chat throws or returns a failure', async () => {
  for (const code of [MODEL_CONTEXT_EXCEEDED, 'MODEL_NOT_ALLOWED']) {
    for (const throws of [true, false]) {
      const error = Object.assign(new LlmError('Selector failed', code), {
        usage,
        model,
      });
      const result = await makeSelector(async () => {
        if (throws) throw error;
        return { ok: false, error };
      }).retrieve(request);
      assert.equal(result.ok, false);
      if (result.ok) continue;
      assert.equal(result.error.code, code);
      assert.equal(result.error.usageCalls?.[0].totalTokens, 50);
    }
  }
});

for (const code of [
  'ABORTED',
  MODEL_CONTEXT_EXCEEDED,
  EMBEDDING_CONTEXT_EXCEEDED,
]) {
  test(`preserves nested ${code} and provider usage`, async () => {
    const terminal = new SmartAgentError('Terminal failure', code);
    const error = Object.assign(new LlmError('Adapter failed'), {
      cause: new Error('Upstream failure', { cause: terminal }),
      usage,
      model,
    });
    const result = await makeSelector(async () => ({
      ok: false,
      error,
    })).retrieve(request);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.equal(result.error.message, terminal.message);
    assert.equal(result.error.usageCalls?.length, 1);
    assert.equal(result.error.usageCalls?.[0].model, model);
    assert.equal(result.error.usageCalls?.[0].totalTokens, usage.totalTokens);
  });
}

test('records usage once with the selector role and the actual response model', async () => {
  const requestLogger = new DefaultRequestLogger();
  const sessionSteps: Array<{ name: string; data: object }> = [];
  const events: UsageInput[] = [];
  function recorder(context: UsageContext = {}): IUsageRecorder {
    return {
      with(extra) {
        return recorder({ ...context, ...extra });
      },
      record(event) {
        events.push({ ...event, context: { ...context, ...event.context } });
      },
    };
  }
  const actualModel = 'selector-model-actual';
  const retriever = makeSelector(async (_messages, _tools, options) => {
    reportLlmRequest(options, startOperation(options), {
      provider: 'mock',
      model: actualModel,
      durationMs: 1,
      stream: false,
      outcome: 'ok',
      granularity: 'request',
      retriesVisible: true,
      tokensSource: 'provider',
      inputTokens: usage.promptTokens,
    });
    return {
      ok: true,
      value: {
        content: '{"tools":["read"]}',
        finishReason: 'stop',
        usage,
        model: actualModel,
      },
    };
  });
  const result = await retriever.retrieve(request, {
    requestLogger,
    usage: recorder(),
    sessionLogger: {
      logStep(name, data, area) {
        assert.equal(area, 'llm');
        if (data && typeof data === 'object') sessionSteps.push({ name, data });
      },
    },
  });
  assert.deepEqual(result, { ok: true, value: { names: ['read'], usage } });
  const summary = requestLogger.getSummary();
  assert.deepEqual(summary.byComponent['tool-retriever'], {
    ...usage,
    requests: 1,
  });
  assert.deepEqual(summary.byModel, {
    [actualModel]: { ...usage, requests: 1 },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].context.role, 'tool-retriever');
  assert.deepEqual(sessionSteps, [
    {
      name: 'llm_tool_retrieval',
      data: {
        retriever: 'llm',
        selectedNames: ['read'],
        usageByModel: { [actualModel]: { ...usage, requests: 1 } },
      },
    },
  ]);
});
