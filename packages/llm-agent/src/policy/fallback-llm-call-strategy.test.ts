import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CallOptions,
  type ILlm,
  LlmError,
  type LlmResponse,
  type LlmStreamChunk,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import { FallbackLlmCallStrategy } from './fallback-llm-call-strategy.js';

type Mode = 'error-chunk' | 'throw';

/** streamChat fails (after aborting `ac` when given); chat answers 'ok'. */
function llm(mode: Mode, ac?: AbortController) {
  const counts = { stream: 0, chat: 0 };
  const impl: ILlm = {
    async chat(): Promise<Result<LlmResponse, LlmError>> {
      counts.chat++;
      return { ok: true, value: { content: 'ok', finishReason: 'stop' } };
    },
    async *streamChat(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
      counts.stream++;
      yield { ok: true, value: { content: 'par' } };
      ac?.abort();
      if (mode === 'throw') throw new Error('socket closed');
      yield { ok: false, error: new LlmError('Aborted', 'ABORTED') };
    },
  };
  return { impl, counts };
}

async function drain(
  s: FallbackLlmCallStrategy,
  l: ILlm,
  options?: CallOptions,
): Promise<Result<LlmStreamChunk, LlmError>[]> {
  const out: Result<LlmStreamChunk, LlmError>[] = [];
  for await (const c of s.call(
    l,
    [{ role: 'user', content: 'x' }],
    [],
    options,
  ))
    out.push(c);
  return out;
}

for (const mode of ['error-chunk', 'throw'] as const) {
  test(`${mode}: a caller's cancellation does not disable streaming`, async () => {
    const s = new FallbackLlmCallStrategy();
    const ac = new AbortController();
    const first = llm(mode, ac);
    const out = await drain(s, first.impl, { signal: ac.signal });
    assert.equal(first.counts.chat, 0, 'no non-streaming retry');
    const last = out.at(-1);
    assert.ok(last && !last.ok, 'the cancellation surfaces as an error');
    assert.ok(
      !out.some((c) => c.ok && c.value.reset),
      'no reset: nothing is replayed',
    );

    // The next call on the same instance still streams.
    const next = llm(mode);
    await drain(s, next.impl);
    assert.equal(next.counts.stream, 1, 'streaming is still enabled');
  });

  test(`${mode}: a real streaming failure still falls back and disables streaming`, async () => {
    const s = new FallbackLlmCallStrategy();
    const first = llm(mode);
    const out = await drain(s, first.impl);
    assert.equal(first.counts.chat, 1, 'fell back to non-streaming');
    assert.ok(out.some((c) => c.ok && c.value.reset));

    const next = llm(mode);
    await drain(s, next.impl);
    assert.equal(next.counts.stream, 0, 'streaming disabled');
    assert.equal(next.counts.chat, 1);
  });
}
