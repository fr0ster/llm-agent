import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import {
  BaseLLMProvider,
  CircuitBreaker,
  CircuitBreakerLlm,
  DefaultWaitStrategy,
  findThrottled,
  gateFor,
  type ILlm,
  type LLMCallOptions,
  type LLMResponse,
  LlmError,
  type LlmStreamChunk,
  type Result,
  withRetry,
} from '@mcp-abap-adt/llm-agent';
import { LlmAdapter } from '../../adapters/llm-adapter.js';
import { RetryLlm } from '../retry-llm.js';

class ClosedQuotaProvider extends BaseLLMProvider {
  calls = 0;

  key() {
    return this.quotaKey();
  }

  async chat(
    _messages: Parameters<BaseLLMProvider['chat']>[0],
    _tools?: Parameters<BaseLLMProvider['chat']>[1],
    options?: LLMCallOptions,
  ): Promise<LLMResponse> {
    return this.withThrottleRetry(
      async () => {
        this.calls++;
        throw Object.assign(new Error('quota'), {
          response: { status: 429, headers: { 'Retry-After': '60' } },
        });
      },
      { signal: options?.signal },
    );
  }

  async *streamChat(
    messages: Parameters<BaseLLMProvider['chat']>[0],
    tools?: Parameters<BaseLLMProvider['chat']>[1],
    options?: LLMCallOptions,
  ): AsyncIterable<LLMResponse> {
    yield await this.chat(messages, tools, options);
  }
}

for (const stream of [false, true]) {
  for (const layer of ['adapter', 'retry', 'breaker']) {
    for (const reason of [
      new Error('already stopped'),
      { message: 'already stopped' },
      'already stopped',
    ]) {
      test(`closed provider quota returns ABORTED, stream=${stream}, layer=${layer}, reason=${typeof reason}`, async () => {
        const provider = new ClosedQuotaProvider({
          quotaScope: `${stream}-${layer}-${typeof reason}`,
        });
        const adapter = new LlmAdapter({
          callWithTools: (messages, tools, options) =>
            provider.chat(messages, tools, options),
          async *streamWithTools(messages, tools, options) {
            yield* provider.streamChat(messages, tools, options);
          },
        });
        const retry = new RetryLlm(adapter);
        const breaker = new CircuitBreaker({ failureThreshold: 2 });
        const llm =
          layer === 'adapter'
            ? adapter
            : layer === 'retry'
              ? retry
              : new CircuitBreakerLlm(retry, breaker);
        const call = async (signal?: AbortSignal) => {
          if (!stream) return llm.chat([], undefined, { signal });
          const chunks: Result<LlmStreamChunk, LlmError>[] = [];
          for await (const chunk of llm.streamChat([], undefined, { signal }))
            chunks.push(chunk);
          assert.equal(chunks.length, 1);
          return chunks[0];
        };
        try {
          const first = await call();
          assert.equal(first.ok, false);
          if (first.ok) assert.fail('the server must close the quota');
          assert.ok(findThrottled(first.error));
          assert.ok(gateFor(provider.key()).remaining() > 0);
          const controller = new AbortController();
          controller.abort(reason);
          // Exercise the shared provider loop before the Result adapters.
          await assert.rejects(
            provider.chat([], undefined, { signal: controller.signal }),
            (error) => error === reason,
          );
          const result = await call(controller.signal);
          assert.equal(result.ok, false);
          if (result.ok)
            assert.fail('cancellation must return an error Result');
          assert.equal(result.error.code, 'ABORTED');
          assert.equal(result.error.cause, reason);
          assert.equal(provider.calls, 1);
          assert.equal(breaker.state, 'closed');
        } finally {
          gateFor(provider.key()).clear();
        }
      });
    }
  }
}

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
