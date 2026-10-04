import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CircuitBreaker,
  CircuitBreakerLlm,
  type ILlm,
} from '@mcp-abap-adt/llm-agent';
import { LlmCircuitBreakers } from '../llm/llm-circuit-breakers.js';

function llm(model: string, ok = true): ILlm {
  return {
    model,
    chat: async () =>
      ok
        ? { ok: true, value: { content: 'ok', toolCalls: [] } }
        : { ok: false, error: new Error('boom') },
    streamChat: async function* () {},
  } as unknown as ILlm;
}

function breakerOf(wrapped: ILlm): CircuitBreaker {
  assert.ok(wrapped instanceof CircuitBreakerLlm, 'wrapped in a breaker');
  return wrapped.breaker;
}

describe('LlmCircuitBreakers', () => {
  it('wraps the same inner under the same key once', () => {
    const b = new LlmCircuitBreakers({ failureThreshold: 2 });
    const a = llm('a');
    const w1 = b.wrap(a, 'main');
    const w2 = b.wrap(a, 'main');
    assert.equal(w1, w2);
    assert.equal(b.list().length, 1);
  });

  it('gives one object under two keys two wrappers with two breakers', () => {
    const b = new LlmCircuitBreakers({});
    const a = llm('a');
    const main = b.wrap(a, 'main');
    const helper = b.wrap(a, 'helper');
    assert.notEqual(main, helper);
    assert.notEqual(breakerOf(main), breakerOf(helper));
    assert.deepEqual(b.list(), [breakerOf(main), breakerOf(helper)]);
  });

  it('gives a new inner for a key a fresh breaker and drops the old one', () => {
    const b = new LlmCircuitBreakers({});
    const old = breakerOf(b.wrap(llm('a'), 'main'));
    const fresh = breakerOf(b.wrap(llm('b'), 'main'));
    assert.notEqual(old, fresh);
    assert.deepEqual(b.list(), [fresh]);
  });

  it('swap A → B → A gives A a fresh breaker, not its first one', () => {
    const b = new LlmCircuitBreakers({});
    const a = llm('a');
    const first = breakerOf(b.wrap(a, 'main'));
    b.wrap(llm('b'), 'main');
    const again = breakerOf(b.wrap(a, 'main'));
    assert.notEqual(first, again);
    assert.deepEqual(b.list(), [again]);
  });

  it("returns the key's current wrapper unchanged", () => {
    const b = new LlmCircuitBreakers({});
    const w = b.wrap(llm('a'), 'main');
    assert.equal(b.wrap(w, 'main'), w);
    assert.equal(b.list().length, 1);
  });

  it("does not wrap a consumer's own CircuitBreakerLlm and lists its breaker in the key's place", () => {
    const b = new LlmCircuitBreakers({});
    b.wrap(llm('x'), 'other');
    const old = breakerOf(b.wrap(llm('a'), 'main'));
    const own = new CircuitBreakerLlm(llm('b'), new CircuitBreaker());
    assert.equal(b.wrap(own, 'main'), own, 'returned unchanged');
    const listed = b.list();
    assert.equal(listed.length, 2);
    assert.equal(listed.includes(own.breaker), true);
    assert.equal(listed.includes(old), false);
    assert.equal(listed[1], own.breaker, 'the key keeps its place');
  });

  it('builds each breaker from the config and reports transitions by key', async () => {
    const seen: string[] = [];
    const b = new LlmCircuitBreakers({ failureThreshold: 2 }, (key, from, to) =>
      seen.push(`${key}:${from}->${to}`),
    );
    const w = b.wrap(llm('a', false), 'planner');
    await w.chat([{ role: 'user', content: 'x' }]);
    assert.equal(breakerOf(w).state, 'closed');
    await w.chat([{ role: 'user', content: 'x' }]);
    assert.equal(breakerOf(w).state, 'open');
    assert.deepEqual(seen, ['planner:closed->open']);
  });
});
