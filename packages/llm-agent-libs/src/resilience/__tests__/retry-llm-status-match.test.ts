import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ILlm, LlmResponse, Result } from '@mcp-abap-adt/llm-agent';
import { LlmError } from '@mcp-abap-adt/llm-agent';
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
