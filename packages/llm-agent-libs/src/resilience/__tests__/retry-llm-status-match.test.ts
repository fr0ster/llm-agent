import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ILlm, LlmResponse, Result } from '@mcp-abap-adt/llm-agent';
import {
  DefaultWaitStrategy,
  LlmError,
  MODEL_CONTEXT_EXCEEDED,
} from '@mcp-abap-adt/llm-agent';
import { RetryLlm } from '../retry-llm.js';

/**
 * A fake ILlm whose non-streaming chat() fails with a scripted error a fixed
 * number of times, then succeeds. `calls` counts attempts.
 */
function makeFailingLlm(error: LlmError, failTimes: number) {
  let calls = 0;
  const llm: ILlm & { calls: () => number } = {
    model: 'test',
    calls: () => calls,
    async chat(): Promise<Result<LlmResponse, LlmError>> {
      calls++;
      if (calls <= failTimes) return { ok: false, error };
      return { ok: true, value: { content: 'ok', finishReason: 'stop' } };
    },
    async *streamChat() {
      yield { ok: true, value: { content: 'ok', finishReason: 'stop' } };
    },
  };
  return llm;
}

describe('RetryLlm — status classification', () => {
  for (const code of [MODEL_CONTEXT_EXCEEDED, 'LLM_ERROR']) {
    it(`handles ${code} returned when chat and stream are aborted`, async () => {
      const chatAbort = new AbortController();
      const streamAbort = new AbortController();
      const reason = new Error('Caller stopped');
      const error = new LlmError('Model failed', code);
      const llm: ILlm = {
        async chat() {
          chatAbort.abort(reason);
          return { ok: false, error };
        },
        async *streamChat() {
          streamAbort.abort(reason);
          yield { ok: false, error };
        },
      };
      const retry = new RetryLlm(llm);
      const chat = await retry.chat([], undefined, {
        signal: chatAbort.signal,
      });
      const results: { ok: boolean; error?: LlmError }[] = [chat];
      for await (const chunk of retry.streamChat([], undefined, {
        signal: streamAbort.signal,
      })) {
        results.push(chunk);
      }
      assert.equal(results.length, 2);
      for (const result of results) {
        assert.ok(!result.ok && result.error);
        if (code === MODEL_CONTEXT_EXCEEDED) assert.equal(result.error, error);
        else {
          assert.equal(result.error.code, 'ABORTED');
          assert.equal(result.error.cause, reason);
        }
      }
    });
  }
  it('retries transient failures past the old default cap', async () => {
    const llm = makeFailingLlm(
      Object.assign(new LlmError('Unavailable'), { status: 503 }),
      6,
    );
    assert.ok((await new RetryLlm(llm, { backoffMs: 0 }).chat([])).ok);
    assert.equal(llm.calls(), 7);
  });

  it('honors an explicit cap on non-429 retries', async () => {
    const llm = makeFailingLlm(
      Object.assign(new LlmError('Unavailable'), { status: 503 }),
      6,
    );
    assert.equal(
      (await new RetryLlm(llm, { backoffMs: 0, maxAttempts: 1 }).chat([])).ok,
      false,
    );
    assert.equal(llm.calls(), 2);
  });

  it('retries structured HTTP 408 by default', async () => {
    const llm = makeFailingLlm(
      Object.assign(new LlmError('Request timed out'), { status: 408 }),
      1,
    );
    const r = await new RetryLlm(llm, { backoffMs: 1 }).chat([]);
    assert.equal(r.ok, true);
    assert.equal(llm.calls(), 2);
  });

  it('does not retry when retryable numbers appear only in message text', async () => {
    const llm = makeFailingLlm(
      new LlmError(
        'max_tokens must be at most 500 (currently 429)',
        'LLM_ERROR',
      ),
      1,
    );
    const r = await new RetryLlm(llm, { backoffMs: 0 }).chat([]);
    assert.equal(r.ok, false);
    assert.equal(llm.calls(), 1); // no retry
  });

  it('prefers a structured status on cause over the message text', async () => {
    const err = new LlmError('opaque provider failure', 'LLM_ERROR');
    err.cause = { status: 503 };
    const llm = makeFailingLlm(err, 1);
    const r = await new RetryLlm(llm, { backoffMs: 1 }).chat([]);
    assert.equal(r.ok, true);
    assert.equal(llm.calls(), 2);
  });

  for (const status of [403, 409]) {
    it(`does not retry HTTP ${status} even when listed in retryOn`, async () => {
      const error = Object.assign(new LlmError('Request rejected'), { status });
      const llm = makeFailingLlm(error, 1);
      assert.deepEqual(
        await new RetryLlm(llm, { backoffMs: 0, retryOn: [status] }).chat([]),
        { ok: false, error },
      );
      assert.equal(llm.calls(), 1);
    });
  }

  it('retries HTTP 425 when listed in retryOn', async () => {
    const error = Object.assign(new LlmError('Too Early'), { status: 425 });
    const llm = makeFailingLlm(error, 1);
    assert.ok(
      (await new RetryLlm(llm, { backoffMs: 0, retryOn: [425] }).chat([])).ok,
    );
    assert.equal(llm.calls(), 2);
  });
});

it('aborts a streaming 429 wait with a Retry-After above the Node timer range', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  let attempts = 0;
  const inner: ILlm = {
    async chat() {
      assert.fail('stream expected');
    },
    streamChat() {
      attempts++;
      throw Object.assign(new Error('rate limited'), {
        status: 429,
        headers: { 'retry-after': '3000000' },
      });
    },
  };
  const retry = new RetryLlm(inner, { maxAttempts: 0, retryOn: [] });
  const result = (async () => {
    const chunks = [];
    for await (const chunk of retry.streamChat([], undefined, {
      signal: controller.signal,
    })) {
      chunks.push(chunk);
    }
    return chunks;
  })();
  await Promise.resolve();
  t.mock.timers.tick(100);
  controller.abort();
  const chunks = await result;
  assert.equal(attempts, 1);
  const chunk = chunks.at(-1);
  assert.ok(chunk && !chunk.ok);
  assert.equal(chunk.error.code, 'ABORTED');
});

// ---------------------------------------------------------------------------
// Rate limits the provider already handled (issue #282)
// ---------------------------------------------------------------------------

describe('RetryLlm — a spent provider rate-limit policy', () => {
  const throttled = () =>
    Object.assign(new Error('429 Too Many Requests'), {
      throttled: true as const,
      attempts: 5,
      retryAfterSeconds: 30,
    });

  it('honors a marked provider 429 beyond the configured transient retry count', async (t) => {
    const wait = t.mock.method(
      DefaultWaitStrategy.prototype,
      'wait',
      async () => 'elapsed' as const,
    );
    let calls = 0;
    const inner: ILlm = {
      chat: async () => {
        calls += 1;
        if (calls === 6)
          return { ok: true, value: { content: 'ok', finishReason: 'stop' } };
        const error = new LlmError('OpenAI API error: 429 Too Many Requests');
        error.cause = throttled();
        return { ok: false as const, error };
      },
      streamChat: async function* () {
        yield { ok: false as const, error: new LlmError('unused') };
      },
    };
    const llm = new RetryLlm(inner, { maxAttempts: 0, backoffMs: 1 });
    const res = await llm.chat([{ role: 'user', content: 'hi' }]);
    assert.ok(res.ok);
    assert.equal(calls, 6);
    assert.deepEqual(
      wait.mock.calls.map(({ arguments: args }) => args[0]),
      [30000, 30000, 30000, 30000, 30000],
    );
  });

  it('still retries a 429 from a provider with no policy of its own', async () => {
    let calls = 0;
    const inner: ILlm = {
      chat: async () => {
        calls += 1;
        if (calls < 2) {
          const error = new LlmError('rate limited');
          error.cause = { status: 429 };
          return { ok: false as const, error };
        }
        return { ok: true, value: { content: 'ok', finishReason: 'stop' } };
      },
      streamChat: async function* () {
        yield { ok: false as const, error: new LlmError('unused') };
      },
    };
    const llm = new RetryLlm(inner, { maxAttempts: 3, backoffMs: 1 });
    const res = await llm.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(res.ok, true);
    assert.equal(calls, 2);
  });
});
