import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EMBEDDING_CONTEXT_EXCEEDED,
  type ILlm,
  type IUsageRecorder,
  LlmError,
  MODEL_CONTEXT_EXCEEDED,
  reportLlmRequest,
  SKILL_RETRIEVAL_INVALID,
  type SkillRetrievalRequest,
  SmartAgentError,
  startOperation,
  type UsageContext,
  type UsageInput,
} from '@mcp-abap-adt/llm-agent';
import { DefaultRequestLogger } from '../../../logger/default-request-logger.js';
import { makeLlm } from '../../../testing/index.js';
import { LlmSkillRetriever } from '../llm-skill-retriever.js';

const request: SkillRetrievalRequest = {
  text: 'Review the change',
  candidates: [
    { name: 'review', description: 'Review a change' },
    { name: 'design', description: 'Design a change' },
  ],
};
const usage = { promptTokens: 21, completionTokens: 4, totalTokens: 25 };

function selector(chat: ILlm['chat']): LlmSkillRetriever {
  return new LlmSkillRetriever({ ...makeLlm([]), model: 'selector', chat });
}

test('selects from a stable, complete skill catalogue followed by the step', async (t) => {
  const chat = t.mock.fn<ILlm['chat']>(async () => ({
    ok: true,
    value: { content: '{"skills":["review"]}', finishReason: 'stop' },
  }));
  const retriever = selector(chat);
  const selection = { ok: true, value: { names: ['review'] } };
  assert.deepEqual(await retriever.retrieve(request), selection);
  assert.equal(chat.mock.callCount(), 1);
  const nextText = 'Review the next change';
  assert.deepEqual(
    await retriever.retrieve({
      text: nextText,
      candidates: [...request.candidates].reverse(),
    }),
    selection,
  );
  assert.equal(chat.mock.callCount(), 2);
  const [first, tools] = chat.mock.calls[0].arguments;
  const [second] = chat.mock.calls[1].arguments;
  assert.equal(tools, undefined);
  assert.deepEqual(first.slice(0, -1), second.slice(0, -1));
  assert.equal(
    first[1].content,
    `Skill catalogue:\n${JSON.stringify([...request.candidates].reverse())}`,
  );
  assert.equal(first.at(-1)?.content, request.text);
  assert.equal(second.at(-1)?.content, nextText);
});

test('rejects invalid JSON, response shapes and names while retaining call usage', async () => {
  for (const content of [
    '{"skills":["review","missing"]}',
    '{"skills":[3]}',
    '{"tools":["review"]}',
    '{"skills":[],"extra":true}',
    'bad JSON',
  ]) {
    const result = await selector(async () => ({
      ok: true,
      value: { content, finishReason: 'stop', usage },
    })).retrieve(request);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, SKILL_RETRIEVAL_INVALID);
    assert.equal(result.error.usageCalls?.length, 1);
    assert.equal(result.error.usageCalls?.[0].totalTokens, usage.totalTokens);
  }
});

test('keeps abort and context overflow codes and skips chat on an already aborted signal', async (t) => {
  for (const code of [
    'ABORTED',
    MODEL_CONTEXT_EXCEEDED,
    EMBEDDING_CONTEXT_EXCEEDED,
  ]) {
    const controller = new AbortController();
    const chat = t.mock.fn<ILlm['chat']>(async (_messages, _tools, options) => {
      assert.equal(options?.signal, controller.signal);
      controller.abort();
      return {
        ok: false,
        error: Object.assign(new LlmError('Selector failed'), {
          cause: new SmartAgentError('Terminal failure', code),
          usage,
        }),
      };
    });
    const retriever = selector(chat);
    const options = { signal: controller.signal };
    const result = await retriever.retrieve(request, options);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.equal(result.error.usageCalls?.length, 1);
    assert.equal(result.error.usageCalls?.[0].totalTokens, usage.totalTokens);
    const preAborted = await retriever.retrieve(request, options);
    assert.equal(preAborted.ok, false);
    assert.equal(preAborted.error.code, 'ABORTED');
    assert.equal(chat.mock.callCount(), 1);
  }
});

test('records usage once under the skill-retriever role and actual model', async () => {
  const requestLogger = new DefaultRequestLogger();
  const events: UsageInput[] = [];
  const model = 'actual-selector';
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
  const result = await selector(async (_messages, _tools, options) => {
    reportLlmRequest(options, startOperation(options), {
      provider: 'mock',
      model,
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
      value: { content: '{"skills":[]}', finishReason: 'stop', model, usage },
    };
  }).retrieve(request, { usage: recorder(), requestLogger });
  assert.deepEqual(result, { ok: true, value: { names: [], usage } });
  const summary = requestLogger.getSummary();
  assert.deepEqual(summary.byModel, { [model]: { ...usage, requests: 1 } });
  assert.deepEqual(summary.byComponent, {
    'skill-retriever': { ...usage, requests: 1 },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].context.role, 'skill-retriever');
});
