import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import {
  CircuitBreaker,
  CircuitBreakerLlm,
  DefaultWaitStrategy,
  type ILlm,
  LlmError,
  type LlmStreamChunk,
  type Result,
  withRetry,
} from '@mcp-abap-adt/llm-agent';
import { RetryLlm } from '../retry-llm.js';

for (const stream of [false, true]) {
  for (const throughBreaker of [false, true]) {
    for (const reason of [
      new Error('caller stopped during LLM backoff'),
      { message: 'caller stopped during LLM backoff' },
      'caller stopped during LLM backoff',
    ]) {
      test(`RetryLlm returns ABORTED with the original ${typeof reason} reason during backoff, stream=${stream}, breaker=${throughBreaker}, error=${reason instanceof Error}`, async (t) => {
        const controller = new AbortController();
        let backoffStarted = () => {};
        const started = new Promise<void>((resolve) => {
          backoffStarted = resolve;
        });
        const wait = t.mock.method(
          DefaultWaitStrategy.prototype,
          'wait',
          (_ms: number, signal?: AbortSignal) => {
            assert.equal(signal, controller.signal);
            assert.ok(signal);
            assert.equal(signal.aborted, false);
            return new Promise<'aborted'>((resolve) => {
              signal.addEventListener('abort', () => resolve('aborted'), {
                once: true,
              });
              backoffStarted();
            });
          },
        );
        const error = new LlmError('service unavailable');
        error.cause = { status: 503 };
        let calls = 0;
        const retry = new RetryLlm({
          async chat() {
            calls++;
            return { ok: false, error };
          },
          async *streamChat() {
            calls++;
            yield { ok: false, error };
          },
        });
        const breaker = new CircuitBreaker({ failureThreshold: 1 });
        const failures = t.mock.method(breaker, 'recordFailure');
        const successes = t.mock.method(breaker, 'recordSuccess');
        const llm = throughBreaker
          ? new CircuitBreakerLlm(retry, breaker)
          : retry;
        const options = { signal: controller.signal };
        const pending = stream
          ? (async () => {
              const chunks: Result<LlmStreamChunk, LlmError>[] = [];
              for await (const chunk of llm.streamChat(
                [],
                undefined,
                options,
              )) {
                chunks.push(chunk);
              }
              assert.equal(chunks.length, 1);
              return chunks[0];
            })()
          : llm.chat([], undefined, options);

        await started;
        assert.equal(calls, 1);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
        controller.abort(reason);

        const result = await pending;
        assert.equal(result.ok, false);
        if (result.ok) assert.fail('cancellation must return an error Result');
        assert.ok(result.error instanceof LlmError);
        assert.equal(result.error.code, 'ABORTED');
        assert.equal(result.error.message, 'Aborted');
        assert.equal(result.error.cause, reason);
        assert.equal(calls, 1);
        assert.equal(wait.mock.callCount(), 1);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
        assert.equal(failures.mock.callCount(), 0);
        assert.equal(successes.mock.callCount(), 0);
        assert.equal(breaker.state, 'closed');
      });
    }
  }
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
