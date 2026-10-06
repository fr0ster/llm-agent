/**
 * Spec §14.2 "Retries count once": a circuit breaker records ONE result per
 * logical call. The builder's RetryLlm sits INSIDE the breaker
 * (`CircuitBreakerLlm → RetryLlm → adapter`), for its own breaker and for a
 * main LLM that already is a (shared) CircuitBreakerLlm.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CallOptions,
  CircuitBreaker,
  CircuitBreakerLlm,
  type ILlm,
  LlmError,
  type LlmResponse,
  type LlmStreamChunk,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../builder.js';

/** An adapter that answers every call with a retryable 429. */
function throttledLlm(onCall?: () => void): ILlm & { calls: number } {
  const llm = {
    calls: 0,
    model: 'throttled',
    async chat(): Promise<Result<LlmResponse, LlmError>> {
      llm.calls++;
      onCall?.();
      return {
        ok: false,
        error: new LlmError('HTTP 429 Too Many Requests'),
      };
    },
    async *streamChat(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
      llm.calls++;
      onCall?.();
      yield { ok: false, error: new LlmError('HTTP 429 Too Many Requests') };
    },
  };
  return llm;
}

const retry = {
  maxAttempts: 3,
  backoffMs: 1,
  retryOn: [429],
  retryOnMidStream: [],
};

function builder() {
  return new SmartAgentBuilder({
    skipModelValidation: true,
    agent: { retry },
  });
}

test('own breaker: one request with retries records ONE failure; two open it', async () => {
  const raw = throttledLlm();
  const h = await builder()
    .withMainLlm(raw)
    .withCircuitBreaker({ failureThreshold: 2, recoveryWindowMs: 60_000 })
    .build();
  try {
    const main = h.agent.currentMainLlm;
    assert.ok(main instanceof CircuitBreakerLlm, 'breaker is outermost');
    const breaker = main.breaker;
    assert.ok(h.circuitBreakers.includes(breaker));

    const r1 = await main.chat([{ role: 'user', content: 'x' }]);
    assert.equal(r1.ok, false);
    assert.equal(raw.calls, 4, 'retry ran inside: 1 + 3 attempts');
    assert.equal(breaker.state, 'closed', 'one logical call = one failure');

    await main.chat([{ role: 'user', content: 'x' }]);
    assert.equal(breaker.state, 'open');
  } finally {
    await h.close();
  }
});

test('own breaker, streaming: retries inside count once', async () => {
  const raw = throttledLlm();
  const h = await builder()
    .withMainLlm(raw)
    .withCircuitBreaker({ failureThreshold: 2, recoveryWindowMs: 60_000 })
    .build();
  try {
    const main = h.agent.currentMainLlm;
    assert.ok(main instanceof CircuitBreakerLlm);
    for await (const _ of main.streamChat([{ role: 'user', content: 'x' }])) {
      // drain
    }
    assert.equal(raw.calls, 4);
    assert.equal(main.breaker.state, 'closed');
  } finally {
    await h.close();
  }
});

test('pre-wrapped shared breaker: the same breaker guards, retry goes under it', async () => {
  const raw = throttledLlm();
  const shared = new CircuitBreaker({
    failureThreshold: 2,
    recoveryWindowMs: 60_000,
  });
  const given = new CircuitBreakerLlm(raw, shared);
  const h = await builder().withMainLlm(given).build();
  try {
    const main = h.agent.currentMainLlm;
    assert.ok(main instanceof CircuitBreakerLlm, 'breaker is outermost');
    assert.equal(main.breaker, shared, 'the caller’s breaker instance');

    await main.chat([{ role: 'user', content: 'x' }]);
    assert.equal(raw.calls, 4);
    assert.equal(shared.state, 'closed', 'one logical call = one failure');

    await main.chat([{ role: 'user', content: 'x' }]);
    assert.equal(shared.state, 'open');
  } finally {
    await h.close();
  }
});

test('a caller-cancelled call through retry records nothing and stops retrying', async () => {
  const ac = new AbortController();
  const raw = throttledLlm(() => ac.abort()); // the caller leaves mid-call
  const shared = new CircuitBreaker({
    failureThreshold: 1,
    recoveryWindowMs: 60_000,
  });
  const h = await builder()
    .withMainLlm(new CircuitBreakerLlm(raw, shared))
    .build();
  try {
    const main = h.agent.currentMainLlm;
    const opts: CallOptions = { signal: ac.signal };
    const r = await main.chat(
      [{ role: 'user', content: 'x' }],
      undefined,
      opts,
    );
    assert.equal(r.ok, false);
    assert.equal(raw.calls, 1, 'no retry after the caller aborted');
    assert.equal(shared.state, 'closed', 'a cancellation is not a failure');
  } finally {
    await h.close();
  }
});

test('a caller-cancelled stream through retry records nothing and stops retrying', async () => {
  const ac = new AbortController();
  const raw = throttledLlm(() => ac.abort());
  const h = await builder()
    .withMainLlm(raw)
    .withCircuitBreaker({ failureThreshold: 1, recoveryWindowMs: 60_000 })
    .build();
  try {
    const main = h.agent.currentMainLlm;
    assert.ok(main instanceof CircuitBreakerLlm);
    for await (const _ of main.streamChat(
      [{ role: 'user', content: 'x' }],
      undefined,
      { signal: ac.signal },
    )) {
      // drain
    }
    assert.equal(raw.calls, 1, 'no retry after the caller aborted');
    assert.equal(main.breaker.state, 'closed');
  } finally {
    await h.close();
  }
});

test('no breaker: retry alone, unchanged', async () => {
  const raw = throttledLlm();
  const h = await builder().withMainLlm(raw).build();
  try {
    const main = h.agent.currentMainLlm;
    assert.ok(!(main instanceof CircuitBreakerLlm));
    await main.chat([{ role: 'user', content: 'x' }]);
    assert.equal(raw.calls, 4);
  } finally {
    await h.close();
  }
});
