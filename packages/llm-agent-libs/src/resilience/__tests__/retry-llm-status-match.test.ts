import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ILlm, LlmResponse, Result } from '@mcp-abap-adt/llm-agent';
import { DefaultWaitStrategy, LlmError } from '@mcp-abap-adt/llm-agent';
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
  it('retries transient failures past the old default cap', async () => {
    const llm = makeFailingLlm(new LlmError('HTTP 503'), 6);
    assert.ok((await new RetryLlm(llm, { backoffMs: 0 }).chat([])).ok);
    assert.equal(llm.calls(), 7);
  });

  it('honors an explicit cap on non-429 retries', async () => {
    const llm = makeFailingLlm(new LlmError('HTTP 503'), 6);
    assert.equal(
      (await new RetryLlm(llm, { backoffMs: 0, maxAttempts: 1 }).chat([])).ok,
      false,
    );
    assert.equal(llm.calls(), 2);
  });

  it('retries a genuine 429 as a standalone token', async () => {
    const llm = makeFailingLlm(
      new LlmError('HTTP 429 Too Many Requests', 'LLM_ERROR'),
      1,
    );
    const r = await new RetryLlm(llm, { backoffMs: 1 }).chat([]);
    assert.equal(r.ok, true);
    assert.equal(llm.calls(), 2);
  });

  it('does NOT retry when a retryable code appears only as a substring', async () => {
    // "4290" contains "429"; the old includes() match retried this non-retryable
    // error up to maxAttempts times with backoff. A word-boundary match must not.
    const llm = makeFailingLlm(
      new LlmError('model context of 4290 tokens exceeded', 'LLM_ERROR'),
      1,
    );
    const r = await new RetryLlm(llm, { backoffMs: 1, maxAttempts: 3 }).chat(
      [],
    );
    assert.equal(r.ok, false);
    assert.equal(llm.calls(), 1); // no retry
  });

  it('prefers a structured status on cause over the message text', async () => {
    const err = new LlmError('opaque provider failure', 'LLM_ERROR');
    (err as { cause?: unknown }).cause = { status: 503 };
    const llm = makeFailingLlm(err, 1);
    const r = await new RetryLlm(llm, { backoffMs: 1 }).chat([]);
    assert.equal(r.ok, true);
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
