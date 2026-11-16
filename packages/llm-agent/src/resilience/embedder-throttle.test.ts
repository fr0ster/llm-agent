import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { isBatchEmbedder } from '../interfaces/rag.js';
import { WaitAsTold } from '../interfaces/throttle-strategy.js';
import type { CallOptions } from '../interfaces/types.js';
import { resetQuotaGates, setThrottleObserver } from '../llm/throttle.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { withCircuitBreaker } from './circuit-breaker-embedder.js';
import { composeResilientEmbedder } from './embedder-resilience.js';

const quotaError = (seconds = 0) =>
  Object.assign(new Error('quota'), {
    status: 429,
    retryAfterSeconds: seconds,
  });
const policy = (key: string, fallbackBackoffMs = 2000) =>
  ({
    retry: false,
    throttle: { key, strategy: new WaitAsTold({ fallbackBackoffMs }) },
  }) satisfies Parameters<typeof composeResilientEmbedder>[1];

afterEach(() => {
  resetQuotaGates();
  setThrottleObserver(undefined);
});

for (const error of [
  Object.assign(new Error('HTTP 500 with 429 in body'), { status: 500 }),
  Object.assign(new Error('HTTP 400'), { status: 400 }),
  new TypeError('network 429 failure'),
  new SyntaxError('invalid JSON'),
]) {
  test(`non-429 escapes on first call: ${error.message}`, async () => {
    let calls = 0;
    const embedder = composeResilientEmbedder(
      {
        async embed() {
          calls++;
          throw error;
        },
      },
      policy('first-failure'),
    );
    await assert.rejects(embedder.embed('query'), (actual) => actual === error);
    assert.equal(calls, 1);
    assert.equal(isBatchEmbedder(embedder), false);
  });
}

test('many 429s keep input cap, usage operation and attempts, with no breaker failures', async (t) => {
  const attempts: number[] = [];
  const operations = new Set<string>();
  const breaker = new CircuitBreaker({ failureThreshold: 1 });
  const failures = t.mock.method(breaker, 'recordFailure');
  const embedder = withCircuitBreaker(
    composeResilientEmbedder(
      {
        async embed(text: string, options?: CallOptions) {
          assert.equal(text.length, 24000);
          assert.ok(options?.usageOp);
          attempts.push(options.usageOp.outerAttempt ?? 0);
          operations.add(options.usageOp.operationId);
          if (attempts.length <= 40) throw quotaError();
          return { vector: [1] };
        },
      },
      policy('unlimited'),
    ),
    breaker,
  );
  assert.deepEqual(await embedder.embed('x'.repeat(25000)), { vector: [1] });
  assert.deepEqual(
    attempts,
    Array.from({ length: 41 }, (_, i) => i),
  );
  assert.equal(operations.size, 1);
  assert.equal(failures.mock.callCount(), 0);
  assert.equal(breaker.state, 'closed');
});

test('429 waits at least Retry-After, then retries', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const times: number[] = [];
  const embedder = composeResilientEmbedder(
    {
      async embed() {
        times.push(Date.now());
        if (times.length === 1) throw quotaError(0.02);
        return { vector: [1] };
      },
    },
    policy('server-interval'),
  );
  await embedder.embed('query');
  assert.equal(times.length, 2);
  assert.ok(times[1] - times[0] >= 20);
});

test('missing Retry-After uses fallback; abort cancels the wait without breaker failure', async (t) => {
  const controller = new AbortController();
  const reason = new Error('caller stopped');
  const breaker = new CircuitBreaker({ failureThreshold: 1 });
  const failures = t.mock.method(breaker, 'recordFailure');
  const waits: number[] = [];
  setThrottleObserver((event) => {
    waits.push(event.waitMs);
    queueMicrotask(() => controller.abort(reason));
  });
  let calls = 0;
  const embedder = withCircuitBreaker(
    composeResilientEmbedder(
      {
        async embed() {
          calls++;
          throw Object.assign(new Error('quota'), { status: 429 });
        },
      },
      policy('fallback'),
    ),
    breaker,
  );
  await assert.rejects(
    embedder.embed('query', { signal: controller.signal }),
    (e) => e === reason,
  );
  assert.deepEqual(waits, [2000]);
  assert.equal(calls, 1);
  assert.equal(failures.mock.callCount(), 0);
  assert.equal(breaker.state, 'closed');
});

test('long Retry-After has no library deadline and abort preserves the caller reason', async () => {
  const controller = new AbortController();
  const reason = new Error('stop long wait');
  const waits: number[] = [];
  setThrottleObserver((event) => {
    waits.push(event.waitMs);
    queueMicrotask(() => controller.abort(reason));
  });
  const embedder = composeResilientEmbedder(
    {
      async embed() {
        throw quotaError(40 * 24 * 3600);
      },
    },
    policy('long-wait'),
  );
  await assert.rejects(
    embedder.embed('query', { signal: controller.signal }),
    (e) => e === reason,
  );
  assert.deepEqual(waits, [40 * 24 * 3600 * 1000]);
});

test('aborted caller never invokes provider', async () => {
  const controller = new AbortController();
  const reason = new Error('already stopped');
  controller.abort(reason);
  let calls = 0;
  const embedder = composeResilientEmbedder(
    {
      async embed() {
        calls++;
        return { vector: [1] };
      },
    },
    policy('preabort'),
  );
  await assert.rejects(
    embedder.embed('q', { signal: controller.signal }),
    (e) => e === reason,
  );
  assert.equal(calls, 0);
});

test('429 followed by a 503 surfaces immediately and counts only the 503', async (t) => {
  let calls = 0;
  const failure = Object.assign(new Error('service unavailable'), {
    status: 503,
  });
  const breaker = new CircuitBreaker({ failureThreshold: 1 });
  const failures = t.mock.method(breaker, 'recordFailure');
  const embedder = withCircuitBreaker(
    composeResilientEmbedder(
      {
        async embed() {
          if (++calls <= 20) throw quotaError();
          throw failure;
        },
      },
      policy('then-failure'),
    ),
    breaker,
  );
  await assert.rejects(embedder.embed('q'), (e) => e === failure);
  assert.equal(calls, 21);
  assert.equal(failures.mock.callCount(), 1);
  assert.equal(breaker.state, 'open');
});

test('batch chunks retry independently on SDK response/cause metadata', async () => {
  const chunks: string[][] = [];
  const provider = {
    async embed() {
      return { vector: [1] };
    },
    async embedBatch(texts: string[]) {
      chunks.push(texts);
      if (chunks.length === 2)
        throw new Error('SDK wrapper', {
          cause: {
            response: {
              status: 429,
              headers: new Headers({ 'Retry-After': '0' }),
            },
          },
        });
      return texts.map(() => ({ vector: [1] }));
    },
  };
  const embedder = composeResilientEmbedder(provider, {
    ...policy('batch'),
    explicitMaxBatchSize: 2,
  });
  assert.ok(isBatchEmbedder(embedder));
  assert.equal(
    (await embedder.embedBatch(['a', 'b', 'c', 'd', 'e'])).length,
    5,
  );
  assert.deepEqual(chunks, [['a', 'b'], ['c', 'd'], ['c', 'd'], ['e']]);
});

test('absent Retry-After waits exponential fallback intervals before success', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const waits: number[] = [];
  setThrottleObserver((event) => waits.push(event.waitMs));
  const times: number[] = [];
  const embedder = composeResilientEmbedder(
    {
      async embed() {
        times.push(Date.now());
        if (times.length <= 2)
          throw Object.assign(new Error('quota'), { status: 429 });
        return { vector: [1] };
      },
    },
    policy('missing-header-success', 10),
  );
  assert.deepEqual(await embedder.embed('q'), { vector: [1] });
  assert.deepEqual(waits, [10, 20]);
  assert.ok(times[1] - times[0] >= 10);
  assert.ok(times[2] - times[1] >= 20);
});
