import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { LazyInitError, lazy } from '../lazy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeGreeter(prefix) {
  return {
    greet: async (name) => `${prefix}, ${name}!`,
  };
}
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('lazy<T>', () => {
  it('delegates to the real instance after successful init', async () => {
    const proxy = lazy(() => makeGreeter('Hello'));
    const result = await proxy.greet('World');
    assert.equal(result, 'Hello, World!');
  });
  it('calls factory only once for multiple invocations', async () => {
    const factory = mock.fn(() => makeGreeter('Hi'));
    const proxy = lazy(factory);
    await proxy.greet('A');
    await proxy.greet('B');
    await proxy.greet('C');
    assert.equal(factory.mock.callCount(), 1);
  });
  it('supports async factory', async () => {
    const proxy = lazy(async () => {
      await delay(5);
      return makeGreeter('Async');
    });
    const result = await proxy.greet('World');
    assert.equal(result, 'Async, World!');
  });
  // -------------------------------------------------------------------------
  // Mutex
  // -------------------------------------------------------------------------
  it('concurrent calls share a single init (mutex)', async () => {
    const factory = mock.fn(async () => {
      await delay(20);
      return makeGreeter('Shared');
    });
    const proxy = lazy(factory);
    const [r1, r2, r3] = await Promise.all([
      proxy.greet('A'),
      proxy.greet('B'),
      proxy.greet('C'),
    ]);
    assert.equal(r1, 'Shared, A!');
    assert.equal(r2, 'Shared, B!');
    assert.equal(r3, 'Shared, C!');
    assert.equal(factory.mock.callCount(), 1);
  });
  // -------------------------------------------------------------------------
  // Failure & retry
  // -------------------------------------------------------------------------
  it('throws LazyInitError when factory fails and no fallback', async () => {
    const proxy = lazy(
      () => {
        throw new Error('boom');
      },
      { retryIntervalMs: 10 },
    );
    await assert.rejects(() => proxy.greet('X'), LazyInitError);
  });
  it('retries after retryIntervalMs elapses', async () => {
    let attempt = 0;
    const proxy = lazy(
      () => {
        attempt++;
        if (attempt < 3) throw new Error(`fail #${attempt}`);
        return makeGreeter('Recovered');
      },
      { retryIntervalMs: 10 },
    );
    // First call fails
    await assert.rejects(() => proxy.greet('X'), LazyInitError);
    // Retry suppressed (within retryIntervalMs)
    await assert.rejects(() => proxy.greet('X'), LazyInitError);
    // Wait for retry gate to open
    await delay(15);
    // Second real attempt — still fails (attempt=2)
    await assert.rejects(() => proxy.greet('X'), LazyInitError);
    await delay(15);
    // Third real attempt — succeeds (attempt=3)
    const result = await proxy.greet('World');
    assert.equal(result, 'Recovered, World!');
  });
  it('calls onError callback on factory failure', async () => {
    const errors = [];
    const proxy = lazy(
      () => {
        throw new Error('oops');
      },
      {
        retryIntervalMs: 10,
        onError: (err) => errors.push(err),
      },
    );
    await assert.rejects(() => proxy.greet('X'));
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof Error);
    assert.equal(errors[0].message, 'oops');
  });
  // -------------------------------------------------------------------------
  // Fallback
  // -------------------------------------------------------------------------
  it('delegates to fallback when factory fails', async () => {
    const fallback = makeGreeter('Fallback');
    const proxy = lazy(
      () => {
        throw new Error('unavailable');
      },
      { fallback, retryIntervalMs: 10 },
    );
    const result = await proxy.greet('User');
    assert.equal(result, 'Fallback, User!');
  });
  it('switches from fallback to real instance once factory succeeds', async () => {
    let available = false;
    const fallback = makeGreeter('Fallback');
    const proxy = lazy(
      () => {
        if (!available) throw new Error('not yet');
        return makeGreeter('Real');
      },
      { fallback, retryIntervalMs: 10 },
    );
    // First call — factory fails, fallback used
    const r1 = await proxy.greet('A');
    assert.equal(r1, 'Fallback, A!');
    // Make factory succeed
    available = true;
    await delay(15);
    // Next call — factory succeeds, real instance used
    const r2 = await proxy.greet('B');
    assert.equal(r2, 'Real, B!');
    // Subsequent calls use cached real instance
    const r3 = await proxy.greet('C');
    assert.equal(r3, 'Real, C!');
  });
  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------
  it('handles sync factory returning object directly', async () => {
    const proxy = lazy(() => makeGreeter('Sync'));
    const result = await proxy.greet('Test');
    assert.equal(result, 'Sync, Test!');
  });
  it('retry suppression returns fallback instead of throwing', async () => {
    const fallback = makeGreeter('Safe');
    const proxy = lazy(
      () => {
        throw new Error('down');
      },
      { fallback, retryIntervalMs: 1000 },
    );
    // First call — real failure, delegates to fallback
    const r1 = await proxy.greet('A');
    assert.equal(r1, 'Safe, A!');
    // Second call — retry suppressed, still delegates to fallback
    const r2 = await proxy.greet('B');
    assert.equal(r2, 'Safe, B!');
  });
});
//# sourceMappingURL=lazy.test.js.map
