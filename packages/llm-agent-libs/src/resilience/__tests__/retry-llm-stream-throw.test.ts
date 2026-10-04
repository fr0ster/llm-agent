import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { describe, it } from 'node:test';
import {
  CircuitBreaker,
  CircuitBreakerLlm,
  type ILlm,
  type LlmError,
  type LlmStreamChunk,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import { RetryLlm, retryInsideBreakers } from '../retry-llm.js';

type Chunk = Result<LlmStreamChunk, LlmError>;
type Attempt = (n: number) => AsyncGenerator<Chunk>;

function fake(attempt: Attempt): { llm: ILlm; calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    llm: {
      model: 'test',
      chat: async () => ({
        ok: true,
        value: { content: '', finishReason: 'stop' },
      }),
      streamChat: (): AsyncIterable<Chunk> => attempt(++n),
    },
  };
}

const ok = (content: string): Chunk => ({ ok: true, value: { content } });

async function collect(llm: ILlm, signal?: AbortSignal): Promise<Chunk[]> {
  const out: Chunk[] = [];
  for await (const c of llm.streamChat([], [], signal ? { signal } : undefined))
    out.push(c);
  return out;
}

const FAST = { backoffMs: 1, retryOn: [429, 500, 502, 503] };

describe('RetryLlm — a stream that throws', () => {
  it('retries a thrown retryable error; breaker outside stays closed', async () => {
    const f = fake(async function* (n) {
      if (n === 1) throw new Error('HTTP 503 Service Unavailable');
      yield ok('hello');
    });
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    const llm = retryInsideBreakers(
      new CircuitBreakerLlm(f.llm, breaker),
      FAST,
    );
    const chunks = await collect(llm);
    assert.equal(f.calls(), 2);
    assert.deepEqual(chunks, [ok('hello')]);
    assert.equal(breaker.state, 'closed');
  });

  it('non-retryable throw: one call, one error chunk, one breaker failure', async () => {
    const f = fake(async function* () {
      yield* [];
      throw new Error('bad request');
    });
    const breaker = new CircuitBreaker({ failureThreshold: 2 });
    const llm = retryInsideBreakers(
      new CircuitBreakerLlm(f.llm, breaker),
      FAST,
    );
    const chunks = await collect(llm);
    assert.equal(f.calls(), 1);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].ok, false);
    assert.equal(breaker.state, 'closed');
    await collect(llm);
    assert.equal(breaker.state, 'open'); // exactly one failure per call
  });

  it('mid-stream throw with a retryOnMidStream match: reset chunk + retry', async () => {
    const f = fake(async function* (n) {
      if (n === 1) {
        yield ok('partial');
        throw new Error('Error while iterating over SSE stream');
      }
      yield ok('full');
    });
    const llm = new RetryLlm(f.llm, {
      ...FAST,
      retryOn: [],
      retryOnMidStream: ['SSE stream'],
    });
    const chunks = await collect(llm);
    assert.equal(f.calls(), 2);
    assert.deepEqual(chunks, [
      ok('partial'),
      { ok: true, value: { content: '', reset: true } },
      ok('full'),
    ]);
  });

  it('caller abort during the throwing attempt: no retry, breaker records nothing', async () => {
    const ac = new AbortController();
    const f = fake(async function* () {
      yield* [];
      ac.abort();
      throw new Error('HTTP 503 Service Unavailable');
    });
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    const llm = retryInsideBreakers(
      new CircuitBreakerLlm(f.llm, breaker),
      FAST,
    );
    const chunks = await collect(llm, ac.signal);
    assert.equal(f.calls(), 1);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].ok, false);
    assert.equal(breaker.state, 'closed');
  });

  it('backoff leaves no abort listener on a long-lived signal', async () => {
    const ac = new AbortController();
    const f = fake(async function* (n) {
      if (n <= 12) throw new Error('HTTP 503 Service Unavailable');
      yield ok('done');
    });
    const llm = new RetryLlm(f.llm, {
      ...FAST,
      maxAttempts: 15,
      backoffMs: 0.001,
    });
    const chunks = await collect(llm, ac.signal);
    assert.equal(f.calls(), 13);
    assert.deepEqual(chunks, [ok('done')]);
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
  });
});
