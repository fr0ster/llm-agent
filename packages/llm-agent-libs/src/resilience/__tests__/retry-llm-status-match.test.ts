import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ILlm, LlmResponse, Result } from '@mcp-abap-adt/llm-agent';
import { LlmError, RetryWithBackoff } from '@mcp-abap-adt/llm-agent';
import { RetryLlm } from '../retry-llm.js';

/** The statuses this suite is about, with the numbers named per test. */
const transient = (o: { attempts: number; firstWaitMs: number }) =>
  new RetryWithBackoff({ ...o, statuses: [429, 500, 502, 503] });

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
  it('retries a genuine 429 as a standalone token', async () => {
    const llm = makeFailingLlm(
      new LlmError('HTTP 429 Too Many Requests', 'LLM_ERROR'),
      1,
    );
    const r = await new RetryLlm(
      llm,
      transient({ attempts: 3, firstWaitMs: 1 }),
    ).chat([]);
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
    const r = await new RetryLlm(
      llm,
      transient({ attempts: 3, firstWaitMs: 1 }),
    ).chat([]);
    assert.equal(r.ok, false);
    assert.equal(llm.calls(), 1); // no retry
  });

  it('prefers a structured status on cause over the message text', async () => {
    const err = new LlmError('opaque provider failure', 'LLM_ERROR');
    (err as { cause?: unknown }).cause = { status: 503 };
    const llm = makeFailingLlm(err, 1);
    const r = await new RetryLlm(
      llm,
      transient({ attempts: 3, firstWaitMs: 1 }),
    ).chat([]);
    assert.equal(r.ok, true);
    assert.equal(llm.calls(), 2);
  });
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

  it('does not retry an error the provider already gave up on', async () => {
    let calls = 0;
    const inner: ILlm = {
      chat: async () => {
        calls += 1;
        const error = new LlmError('OpenAI API error: 429 Too Many Requests');
        error.cause = throttled();
        return { ok: false as const, error };
      },
      streamChat: async function* () {
        yield { ok: false as const, error: new LlmError('unused') };
      },
    };
    const llm = new RetryLlm(inner, transient({ attempts: 3, firstWaitMs: 1 }));
    const res = await llm.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(res.ok, false);
    assert.equal(
      calls,
      1,
      'the quota is closed; more attempts only lengthen it',
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
        return { ok: true as const, value: { content: 'ok' } };
      },
      streamChat: async function* () {
        yield { ok: false as const, error: new LlmError('unused') };
      },
    };
    const llm = new RetryLlm(inner, transient({ attempts: 3, firstWaitMs: 1 }));
    const res = await llm.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(res.ok, true);
    assert.equal(calls, 2);
  });
});

describe('RetryLlm — nothing configured', () => {
  it('does not retry when the consumer named no strategy', async () => {
    // The builder used to install three attempts and a doubling backoff on
    // everyone. Four requests per call, from a library that cannot see whose
    // provider it is spending. Silence now means silence.
    const llm = makeFailingLlm(new LlmError('HTTP 502 Bad Gateway'), 1);
    const r = await new RetryLlm(llm).chat([]);
    assert.equal(r.ok, false);
    assert.equal(llm.calls(), 1);
  });
});
