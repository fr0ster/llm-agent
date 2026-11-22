import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ILlm } from '../../interfaces/llm.js';
import type {
  IRequestLogger,
  LlmCallEntry,
} from '../../interfaces/request-logger.js';
import { makeLlm } from '../../testing/index.js';
import { LlmQueryExpander, NoopQueryExpander } from '../query-expander.js';

describe('NoopQueryExpander', () => {
  it('returns query unchanged', async () => {
    const expander = new NoopQueryExpander();
    const result = await expander.expand('ABAP internal tables');
    assert.ok(result.ok);
    assert.equal(result.value, 'ABAP internal tables');
  });
});

describe('LlmQueryExpander', () => {
  it('records expansion usage in the request logger with its trace id', async () => {
    const configuredCalls: LlmCallEntry[] = [];
    const requestCalls: LlmCallEntry[] = [];
    const logger = (calls: LlmCallEntry[]): IRequestLogger => ({
      logLlmCall: (entry) => calls.push(entry),
      logRagQuery() {},
      logToolCall() {},
      startRequest() {},
      endRequest() {},
      dropRequest() {},
      getSummary: () => assert.fail('Unexpected summary'),
      reset() {},
    });
    const usage = {
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
      cachedInputTokens: 2,
    };
    const llm: ILlm = {
      ...makeLlm([]),
      model: 'expansion-model',
      async chat() {
        return {
          ok: true,
          value: { content: 'expanded', finishReason: 'stop', usage },
        };
      },
    };
    const expander = new LlmQueryExpander(llm, logger(configuredCalls));
    const result = await expander.expand('query', {
      requestLogger: logger(requestCalls),
      trace: { traceId: 'request' },
    });
    assert.deepEqual(result, { ok: true, value: 'query expanded' });
    assert.deepEqual(configuredCalls, []);
    assert.equal(requestCalls.length, 1);
    const { callId, durationMs, ...entry } = requestCalls[0];
    assert.ok(callId);
    assert.ok(durationMs >= 0);
    assert.deepEqual(entry, {
      ...usage,
      component: 'query-expander',
      requestId: 'request',
      model: 'expansion-model',
    });
  });

  it('concatenates original query with LLM expansion', async () => {
    const llm = makeLlm([
      { content: 'ABAP ITAB internal table LOOP AT READ TABLE' },
    ]);
    const expander = new LlmQueryExpander(llm);
    const result = await expander.expand('ABAP internal tables');
    assert.ok(result.ok);
    assert.equal(
      result.value,
      'ABAP internal tables ABAP ITAB internal table LOOP AT READ TABLE',
    );
  });

  it('returns original query when LLM returns empty', async () => {
    const llm = makeLlm([{ content: '' }]);
    const expander = new LlmQueryExpander(llm);
    const result = await expander.expand('test query');
    assert.ok(result.ok);
    assert.equal(result.value, 'test query');
  });

  it('returns error when LLM call fails', async () => {
    const llm = makeLlm([new Error('LLM unavailable')]);
    const expander = new LlmQueryExpander(llm);
    const result = await expander.expand('test');
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'QUERY_EXPAND_ERROR');
  });
});
