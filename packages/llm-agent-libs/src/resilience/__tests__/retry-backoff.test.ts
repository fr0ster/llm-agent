import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import {
  DefaultWaitStrategy,
  type ILlm,
  LlmError,
  withRetry,
} from '@mcp-abap-adt/llm-agent';
import { RetryLlm } from '../retry-llm.js';

for (const stream of [false, true]) {
  test(`RetryLlm preserves the reason when aborted during backoff, stream=${stream}`, async () => {
    const controller = new AbortController();
    const reason = { message: 'caller stopped during LLM backoff' };
    const error = new LlmError('service unavailable');
    error.cause = { status: 503 };
    let calls = 0;
    const llm = new RetryLlm({
      async chat() {
        calls++;
        return { ok: false, error };
      },
      async *streamChat() {
        calls++;
        yield { ok: false, error };
      },
    });
    const result = stream
      ? (async () => {
          for await (const _chunk of llm.streamChat([], undefined, {
            signal: controller.signal,
          })) {
            assert.fail('an aborted backoff must throw before another chunk');
          }
        })()
      : llm.chat([], undefined, { signal: controller.signal });
    const rejected = assert.rejects(result, (actual) => actual === reason);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(getEventListeners(controller.signal, 'abort').length > 0);
    } finally {
      controller.abort(reason);
    }
    await rejected;
    assert.equal(calls, 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
}

for (const backoffMs of [0, 17, 2000]) {
  test(`LLM chat, stream and embedder retries keep the same ${backoffMs}ms backoff sequence`, async (t) => {
    const waits: number[] = [];
    t.mock.method(DefaultWaitStrategy.prototype, 'wait', async (ms: number) => {
      waits.push(ms);
      return 'elapsed';
    });
    const error = new LlmError('opaque transport failure');
    error.cause = { response: { status: 503 } };
    const inner: ILlm = {
      chat: async () => ({ ok: false, error }),
      streamChat: async function* () {
        yield { ok: false, error };
      },
    };
    const llm = new RetryLlm(inner, { backoffMs });
    assert.equal((await llm.chat([])).ok, false);
    const expected = [backoffMs, backoffMs * 2, backoffMs * 4];
    assert.deepEqual(waits, expected);
    waits.length = 0;
    for await (const chunk of llm.streamChat([])) {
      assert.equal(chunk.ok, false);
    }
    assert.deepEqual(waits, expected);
    waits.length = 0;
    await assert.rejects(
      withRetry(
        {
          embed: async () => {
            throw error;
          },
        },
        { backoffMs },
      ).embed('q'),
      (actual) => actual === error,
    );
    assert.deepEqual(waits, expected);
  });
}
