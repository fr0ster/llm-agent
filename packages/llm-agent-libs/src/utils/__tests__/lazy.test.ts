import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { LazyInitError, lazy } from '../lazy.js';

// ---------------------------------------------------------------------------
// Test interface
// ---------------------------------------------------------------------------

interface IGreeter {
  greet(name: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGreeter(prefix: string): IGreeter {
  return {
    greet: async (name: string) => `${prefix}, ${name}!`,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('lazy<T>', () => {
  it('delegates to the real instance after successful init', async () => {
    const proxy = lazy<IGreeter>(() => makeGreeter('Hello'));
    const result = await proxy.greet('World');
    assert.equal(result, 'Hello, World!');
  });

  it('calls factory only once for multiple invocations', async () => {
    const factory = mock.fn(() => makeGreeter('Hi'));
    const proxy = lazy<IGreeter>(factory);

    await proxy.greet('A');
    await proxy.greet('B');
    await proxy.greet('C');

    assert.equal(factory.mock.callCount(), 1);
  });

  it('supports async factory', async () => {
    const proxy = lazy<IGreeter>(async () => {
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
    const proxy = lazy<IGreeter>(factory);

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

  it('throws LazyInitError when the factory fails', async () => {
    const proxy = lazy<IGreeter>(
      () => {
        throw new Error('boom');
      },
      { retryIntervalMs: 10 },
    );

    await assert.rejects(() => proxy.greet('X'), LazyInitError);
  });

  it('retries after retryIntervalMs elapses', async () => {
    let attempt = 0;
    const proxy = lazy<IGreeter>(
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
    const errors: unknown[] = [];
    const proxy = lazy<IGreeter>(
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
    assert.equal((errors[0] as Error).message, 'oops');
  });

  // -------------------------------------------------------------------------
  // No fallback (U6): an init failure reaches the call with its cause
  // -------------------------------------------------------------------------

  it('an init failure rejects the call with the factory error as its cause (no fallback)', async () => {
    const proxy = lazy<IGreeter>(
      () => {
        throw new Error('unavailable');
      },
      { retryIntervalMs: 10 },
    );

    await assert.rejects(
      () => proxy.greet('User'),
      (err: unknown) => {
        assert.ok(err instanceof LazyInitError);
        assert.equal((err.cause as Error).message, 'unavailable');
        assert.match(err.message, /greet/);
        assert.match(err.message, /unavailable/);
        return true;
      },
    );
  });

  it('a later call after the retry interval reaches the real instance', async () => {
    let attempt = 0;
    const proxy = lazy<IGreeter>(
      () => {
        attempt++;
        if (attempt === 1) throw new Error('not yet');
        return makeGreeter('Real');
      },
      { retryIntervalMs: 10 },
    );

    await assert.rejects(() => proxy.greet('A'), LazyInitError);
    await delay(15);
    assert.equal(await proxy.greet('B'), 'Real, B!');
    assert.equal(await proxy.greet('C'), 'Real, C!');
    assert.equal(attempt, 2);
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it('handles sync factory returning object directly', async () => {
    const proxy = lazy<IGreeter>(() => makeGreeter('Sync'));
    const result = await proxy.greet('Test');
    assert.equal(result, 'Sync, Test!');
  });

  it('a call inside the retry window rejects with the factory error as its cause (no fallback)', async () => {
    const factory = mock.fn(() => {
      throw new Error('down');
    });
    const proxy = lazy<IGreeter>(factory, { retryIntervalMs: 1000 });

    // First call — the real failure.
    await assert.rejects(
      () => proxy.greet('A'),
      (err: unknown) => {
        assert.ok(err instanceof LazyInitError);
        assert.equal((err.cause as Error).message, 'down');
        return true;
      },
    );

    // Second call — inside the retry window: the factory's error, not the
    // gate's own "retry suppressed", is the cause.
    await assert.rejects(
      () => proxy.greet('B'),
      (err: unknown) => {
        assert.ok(err instanceof LazyInitError);
        assert.equal((err.cause as Error).message, 'down');
        assert.match(err.message, /greet/);
        return true;
      },
    );
    assert.equal(factory.mock.callCount(), 1);
  });
});
