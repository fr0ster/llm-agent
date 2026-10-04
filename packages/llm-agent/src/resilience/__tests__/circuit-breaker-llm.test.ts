import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ILlm, LlmError } from '../../index.js';
import { makeLlm } from '../../testing/index.js';
import { CircuitBreaker } from '../circuit-breaker.js';
import { CircuitBreakerLlm } from '../circuit-breaker-llm.js';

describe('CircuitBreakerLlm', () => {
  it('passes through when circuit is closed', async () => {
    const inner = makeLlm([{ content: 'ok' }]);
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    const llm = new CircuitBreakerLlm(inner, breaker);

    const result = await llm.chat([{ role: 'user', content: 'hi' }]);
    assert.ok(result.ok);
    assert.equal(result.value.content, 'ok');
    assert.equal(breaker.state, 'closed');
  });

  it('returns CIRCUIT_OPEN error when circuit is open', async () => {
    const inner = makeLlm([{ content: 'ok' }]);
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    breaker.recordFailure(); // trip the breaker
    const llm = new CircuitBreakerLlm(inner, breaker);

    const result = await llm.chat([{ role: 'user', content: 'hi' }]);
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'CIRCUIT_OPEN');
    assert.equal(inner.callCount, 0); // inner LLM not called
  });

  it('records failure on inner LLM error', async () => {
    const inner = makeLlm([new Error('LLM down')]);
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    const llm = new CircuitBreakerLlm(inner, breaker);

    const result = await llm.chat([{ role: 'user', content: 'hi' }]);
    assert.ok(!result.ok);
    // Failure should have been recorded
    assert.equal(breaker.state, 'closed'); // still below threshold
  });

  it('streamChat returns CIRCUIT_OPEN when open', async () => {
    const inner = makeLlm([{ content: 'ok' }]);
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    breaker.recordFailure();
    const llm = new CircuitBreakerLlm(inner, breaker);

    const chunks: unknown[] = [];
    for await (const chunk of llm.streamChat([
      { role: 'user', content: 'hi' },
    ])) {
      chunks.push(chunk);
    }
    assert.equal(chunks.length, 1);
    const first = chunks[0] as { ok: false; error: { code: string } };
    assert.ok(!first.ok);
    assert.equal(first.error.code, 'CIRCUIT_OPEN');
  });

  it('streamChat passes through and records success when closed', async () => {
    const inner = makeLlm([{ content: 'streamed' }]);
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    const llm = new CircuitBreakerLlm(inner, breaker);

    const chunks: unknown[] = [];
    for await (const chunk of llm.streamChat([
      { role: 'user', content: 'hi' },
    ])) {
      chunks.push(chunk);
    }
    assert.ok(chunks.length >= 1);
    assert.equal(breaker.state, 'closed');
  });
});

describe('CircuitBreakerLlm — caller cancellation', () => {
  const callerAborted = (): AbortSignal => {
    const c = new AbortController();
    c.abort();
    return c.signal;
  };
  const timeoutAborted = (): AbortSignal => {
    const c = new AbortController();
    c.abort(new DOMException('Request timed out', 'TimeoutError'));
    return c.signal;
  };
  const failing = (code: 'ABORTED' | 'LLM_ERROR'): ILlm => ({
    async chat() {
      return { ok: false, error: new LlmError('x', code) };
    },
    async *streamChat() {
      yield { ok: false, error: new LlmError('x', code) };
    },
  });
  const msgs = [{ role: 'user' as const, content: 'hi' }];

  it('chat: caller-aborted ABORTED failures never trip the breaker', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2 });
    const llm = new CircuitBreakerLlm(failing('ABORTED'), breaker);
    for (let i = 0; i < 3; i++) {
      await llm.chat(msgs, undefined, { signal: callerAborted() });
    }
    assert.equal(breaker.state, 'closed');
  });

  it('chat: real failures open; TimeoutError-aborted failures open', async () => {
    const a = new CircuitBreaker({ failureThreshold: 2 });
    const la = new CircuitBreakerLlm(failing('LLM_ERROR'), a);
    await la.chat(msgs);
    await la.chat(msgs);
    assert.equal(a.state, 'open');
    const b = new CircuitBreaker({ failureThreshold: 2 });
    const lb = new CircuitBreakerLlm(failing('ABORTED'), b);
    await lb.chat(msgs, undefined, { signal: timeoutAborted() });
    await lb.chat(msgs, undefined, { signal: timeoutAborted() });
    assert.equal(b.state, 'open');
  });

  it('streamChat: records neither failure nor success after caller abort', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    let failures = 0;
    let successes = 0;
    const origF = breaker.recordFailure.bind(breaker);
    const origS = breaker.recordSuccess.bind(breaker);
    breaker.recordFailure = () => {
      failures++;
      origF();
    };
    breaker.recordSuccess = () => {
      successes++;
      origS();
    };
    const throwing: ILlm = {
      async chat() {
        throw new Error('unused');
      },
      // biome-ignore lint/correctness/useYield: throws before yielding
      async *streamChat() {
        throw new Error('boom');
      },
    };
    for (const inner of [failing('ABORTED'), throwing]) {
      const llm = new CircuitBreakerLlm(inner, breaker);
      for await (const _ of llm.streamChat(msgs, undefined, {
        signal: callerAborted(),
      })) {
        // drain
      }
    }
    assert.equal(breaker.state, 'closed');
    assert.equal(failures, 0);
    assert.equal(successes, 0);
  });

  it('a caller-cancelled probe leaves a half-open breaker half-open', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryWindowMs: 1000,
    });
    breaker.recordFailure();
    assert.equal(breaker.state, 'open');
    t.mock.timers.tick(1000);
    assert.equal(breaker.state, 'half-open');
    const llm = new CircuitBreakerLlm(failing('ABORTED'), breaker);
    await llm.chat(msgs, undefined, { signal: callerAborted() });
    assert.equal(breaker.state, 'half-open');
    const ok = new CircuitBreakerLlm(makeLlm([{ content: 'ok' }]), breaker);
    await ok.chat(msgs);
    assert.equal(breaker.state, 'closed');
  });
});
