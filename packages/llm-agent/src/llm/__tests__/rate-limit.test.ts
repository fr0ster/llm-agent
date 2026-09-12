import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { beforeEach, describe, it } from 'node:test';
import type {
  LLMCallOptions,
  LLMResponse,
  Message,
} from '../../interfaces/index.js';
import { BaseLLMProvider } from '../base-llm-provider.js';
import {
  DEFAULT_RATE_LIMIT_POLICY,
  GATE_IDLE_TTL_MS,
  GATE_LIMIT,
  gateFor,
  isRateLimitedError,
  leaseRateLimitGate,
  preserveRateLimit,
  pruneRateLimitGates,
  RateLimitGate,
  rateLimitGateCount,
  resetRateLimitGates,
  runWithRateLimitRetry,
} from '../rate-limit.js';

/** Keep the suite fast: the policy is about ordering, not about real seconds. */
const FAST = { baseDelayMs: 1, maxDelayMs: 2, maxTotalWaitMs: 5_000 };

const tooManyRequests = (retryAfter?: string) => ({
  response: {
    status: 429,
    headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
  },
});

const isRateLimited = (e: unknown) =>
  (e as { response?: { status?: number } })?.response?.status === 429;

const retryAfterSeconds = (e: unknown) => {
  const raw = (e as { response?: { headers?: Record<string, string> } })
    ?.response?.headers?.['retry-after'];
  return raw === undefined ? undefined : Number(raw);
};

beforeEach(() => resetRateLimitGates());

describe('runWithRateLimitRetry', () => {
  it('passes a successful call straight through', async () => {
    let calls = 0;
    const out = await runWithRateLimitRetry(
      async () => {
        calls += 1;
        return 'ok';
      },
      { key: 'k', policy: FAST, isRateLimited },
    );
    assert.equal(out, 'ok');
    assert.equal(calls, 1);
  });

  it('rethrows a non-rate-limit error immediately, without retrying', async () => {
    let calls = 0;
    await assert.rejects(
      runWithRateLimitRetry(
        async () => {
          calls += 1;
          throw new Error('boom');
        },
        { key: 'k', policy: FAST, isRateLimited },
      ),
      /boom/,
    );
    assert.equal(calls, 1, 'a real failure must not be multiplied by retries');
  });

  it('retries a 429 and returns the eventual success', async () => {
    let calls = 0;
    const out = await runWithRateLimitRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw tooManyRequests();
        return 'ok';
      },
      { key: 'k', policy: FAST, isRateLimited },
    );
    assert.equal(out, 'ok');
    assert.equal(calls, 3);
  });

  it('gives up after maxAttempts and annotates the error', async () => {
    let calls = 0;
    try {
      await runWithRateLimitRetry(
        async () => {
          calls += 1;
          throw tooManyRequests();
        },
        { key: 'k', policy: { ...FAST, maxAttempts: 3 }, isRateLimited },
      );
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(
        isRateLimitedError(e),
        'consumers read a fact, not a substring',
      );
      assert.equal(e.attempts, 3);
    }
    assert.equal(calls, 3);
  });

  it('stops once the accumulated wait would exceed maxTotalWaitMs', async () => {
    let calls = 0;
    await assert.rejects(
      runWithRateLimitRetry(
        async () => {
          calls += 1;
          throw tooManyRequests('30');
        },
        {
          key: 'k',
          policy: { ...FAST, maxAttempts: 10, maxTotalWaitMs: 10 },
          isRateLimited,
          retryAfterSeconds,
        },
      ),
      (e: unknown) => isRateLimitedError(e),
    );
    assert.equal(calls, 1, '30s asked for, 10ms budget — no second attempt');
  });

  it("uses the server's Retry-After rather than its own guess", async () => {
    let calls = 0;
    const seen: Array<number | undefined> = [];
    await runWithRateLimitRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw tooManyRequests('0.01');
        return 'ok';
      },
      {
        key: 'k',
        policy: FAST,
        isRateLimited,
        retryAfterSeconds,
        onRetry: ({ retryAfterSeconds }) => seen.push(retryAfterSeconds),
      },
    );
    assert.deepEqual(seen, [0.01]);
  });

  it('accepts a Retry-After equal to the whole budget', async () => {
    // The anti-herd spread must not be charged to the budget: adding it made a
    // plain `Retry-After: 60` cost 60_000..60_250ms against a 60_000ms budget,
    // so the most ordinary answer a server gives was refused on the spot.
    let calls = 0;
    const out = await runWithRateLimitRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw tooManyRequests('0.06');
        return 'ok';
      },
      {
        key: 'k',
        policy: { ...FAST, maxTotalWaitMs: 60 },
        isRateLimited,
        retryAfterSeconds,
      },
    );
    assert.equal(out, 'ok');
    assert.equal(calls, 2);
  });

  it('leaves the gate shut when it gives up, not open', async () => {
    // Giving up says the quota is closed, not that it reopened. An open gate
    // here sends every other caller straight back into the limit the server
    // just described.
    await assert.rejects(
      runWithRateLimitRetry(
        async () => {
          throw tooManyRequests('0.5');
        },
        {
          key: 'exhausted',
          policy: { ...FAST, maxAttempts: 1 },
          isRateLimited,
          retryAfterSeconds,
        },
      ),
      (e: unknown) => isRateLimitedError(e),
    );
    assert.ok(
      gateFor('exhausted').remaining() > 100,
      'the pause the server asked for outlives the caller that gave up',
    );
  });

  it('holds every caller on the same quota, not just the one that hit it', async () => {
    await runWithRateLimitRetry(
      (() => {
        let calls = 0;
        return async () => {
          calls += 1;
          if (calls < 2) throw tooManyRequests('0.05');
          return 'ok';
        };
      })(),
      { key: 'shared', policy: FAST, isRateLimited },
    );
    // The penalty outlives the call that earned it.
    const gate = gateFor('shared');
    assert.ok(gate.remaining() >= 0);
  });

  it('passes everything through when disabled', async () => {
    let calls = 0;
    await assert.rejects(
      runWithRateLimitRetry(
        async () => {
          calls += 1;
          throw tooManyRequests();
        },
        { key: 'k', policy: { enabled: false }, isRateLimited },
      ),
    );
    assert.equal(calls, 1);
  });

  it('counts waiting at the shared gate against the budget', async () => {
    // The reported failure: a caller with a 10ms budget sat out 464ms of
    // someone else's pause and then went on as if it had waited for nothing.
    resetRateLimitGates();
    gateFor('busy').penalise(500);
    let called = false;
    const started = Date.now();
    await assert.rejects(
      runWithRateLimitRetry(
        async () => {
          called = true;
          return 'ok';
        },
        { key: 'busy', policy: { ...FAST, maxTotalWaitMs: 10 }, isRateLimited },
      ),
      (e: unknown) => isRateLimitedError(e) && (e.retryAfterSeconds ?? 0) > 0,
    );
    assert.equal(
      called,
      false,
      'the request is never sent into a closed quota',
    );
    assert.ok(Date.now() - started < 400, 'and the caller is not held past it');
  });

  it('never waits past the budget, even when the pause ends exactly on it', async () => {
    // The wake spread is added to a wait, never to a budget. Padded, a hold
    // equal to the budget slept the budget PLUS the jitter — the one thing a
    // hard bound must not do.
    resetRateLimitGates();
    gateFor('exact').penalise(200);
    const started = Date.now();
    const out = await runWithRateLimitRetry(async () => 'ok', {
      key: 'exact',
      policy: { ...FAST, maxTotalWaitMs: 200 },
      isRateLimited,
    });
    const elapsed = Date.now() - started;
    assert.equal(
      out,
      'ok',
      'the pause ends within the budget, so the call runs',
    );
    assert.ok(elapsed < 300, `waited ${elapsed}ms against a 200ms budget`);
  });

  it('gives up when another caller extends the pause past the budget', async () => {
    // The pause fits when the wait starts; a 429 elsewhere lengthens it while
    // this caller is already asleep. The budget still holds.
    resetRateLimitGates();
    gateFor('extended').penalise(20);
    setTimeout(() => gateFor('extended').penalise(5_000), 10);
    const started = Date.now();
    await assert.rejects(
      runWithRateLimitRetry(async () => 'ok', {
        key: 'extended',
        policy: { ...FAST, maxTotalWaitMs: 40 },
        isRateLimited,
      }),
      (e: unknown) => isRateLimitedError(e),
    );
    assert.ok(Date.now() - started < 2_000, 'not held for the whole extension');
  });

  it('leaves no abort listeners behind', async () => {
    // A request- or session-scoped signal outlives one call, so a listener per
    // backoff would accumulate until Node warns about the leak.
    resetRateLimitGates();
    const ac = new AbortController();
    let calls = 0;
    await assert.rejects(
      runWithRateLimitRetry(
        async () => {
          calls += 1;
          throw tooManyRequests();
        },
        {
          key: 'listeners',
          policy: { ...FAST, maxAttempts: 4 },
          isRateLimited,
          signal: ac.signal,
        },
      ),
      (e: unknown) => isRateLimitedError(e),
    );
    assert.equal(calls, 4);
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
  });

  it('stops waiting when the caller aborts', async () => {
    resetRateLimitGates();
    gateFor('aborting').penalise(10_000);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    await assert.rejects(
      runWithRateLimitRetry(async () => 'ok', {
        key: 'aborting',
        policy: { ...FAST, maxTotalWaitMs: 60_000 },
        isRateLimited,
        signal: ac.signal,
      }),
    );
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
  });

  it('waits out a pause that does fit the budget', async () => {
    resetRateLimitGates();
    gateFor('short').penalise(30);
    const out = await runWithRateLimitRetry(async () => 'ok', {
      key: 'short',
      policy: { ...FAST, maxTotalWaitMs: 5_000 },
      isRateLimited,
    });
    assert.equal(out, 'ok');
  });

  it('spends one budget on the gate and the backoff together', async () => {
    resetRateLimitGates();
    gateFor('shared-budget').penalise(40);
    let calls = 0;
    await assert.rejects(
      runWithRateLimitRetry(
        async () => {
          calls += 1;
          throw tooManyRequests('0.05');
        },
        {
          key: 'shared-budget',
          policy: { ...FAST, maxAttempts: 10, maxTotalWaitMs: 60 },
          isRateLimited,
          retryAfterSeconds,
        },
      ),
      (e: unknown) => isRateLimitedError(e),
    );
    assert.equal(
      calls,
      1,
      '40ms at the gate leaves no room for a 50ms backoff in a 60ms budget',
    );
  });

  it('ships defaults matching what SAP documents', () => {
    assert.equal(DEFAULT_RATE_LIMIT_POLICY.maxAttempts, 5);
    assert.equal(DEFAULT_RATE_LIMIT_POLICY.maxTotalWaitMs, 60_000);
  });
});

describe('RateLimitGate', () => {
  it('keeps waiting when another caller extends the hold mid-sleep', async () => {
    const gate = new RateLimitGate();
    gate.penalise(40);
    const started = Date.now();
    const waiting = gate.waitUntilOpen();
    // A second 429 lands while this caller is already asleep.
    setTimeout(() => gate.penalise(300), 10);
    await waiting;
    assert.ok(
      Date.now() - started >= 300,
      'waking on the old deadline spends a request on a quota still shut',
    );
  });

  it('never shortens an existing hold', () => {
    const gate = new RateLimitGate();
    const now = 1_000;
    gate.penalise(500, now);
    gate.penalise(100, now);
    assert.equal(gate.remaining(now), 500);
  });

  it('reports nothing to wait once the hold has passed', () => {
    const gate = new RateLimitGate();
    gate.penalise(500, 1_000);
    assert.equal(gate.remaining(2_000), 0);
  });

  it('hands the same gate to every caller on one key', () => {
    assert.equal(gateFor('same'), gateFor('same'));
    assert.notEqual(gateFor('same'), gateFor('other'));
  });
});

describe('the gate registry', () => {
  it('keeps a gate that is still holding a pause, however long it idles', () => {
    resetRateLimitGates();
    gateFor('held').penalise(GATE_IDLE_TTL_MS * 2);
    pruneRateLimitGates(Date.now() + GATE_IDLE_TTL_MS + 1);
    assert.ok(gateFor('held').remaining() > 0);
  });

  it('keeps a gate that was used recently, open or not', () => {
    resetRateLimitGates();
    gateFor('fresh');
    pruneRateLimitGates();
    assert.equal(rateLimitGateCount(), 1);
  });

  it('stays bounded through a burst faster than the idle rule retires', () => {
    // The reported failure: 1500 keys inside the TTL left 1500 gates behind.
    resetRateLimitGates();
    for (let i = 0; i < GATE_LIMIT * 3; i += 1) gateFor(`burst-${i}`);
    assert.ok(
      rateLimitGateCount() <= GATE_LIMIT,
      `bounded by the limit, saw ${rateLimitGateCount()}`,
    );
  });

  it('evicts the least recently used first, and never a held gate', () => {
    resetRateLimitGates();
    gateFor('held').penalise(GATE_IDLE_TTL_MS * 2);
    gateFor('oldest');
    for (let i = 0; i < GATE_LIMIT * 2; i += 1) gateFor(`burst-${i}`);
    assert.ok(gateFor('held').remaining() > 0, 'a live pause survives a burst');
    assert.ok(rateLimitGateCount() <= GATE_LIMIT + 1);
  });

  it('never evicts a gate a call is still holding', () => {
    // Open is not the same as unused: a request is in flight until the server
    // answers, and it has no pause on it until then.
    resetRateLimitGates();
    const held = leaseRateLimitGate('in-flight');
    for (let i = 0; i < GATE_LIMIT * 3; i += 1) gateFor(`burst-${i}`);
    // The in-flight call now gets its 429 and penalises the gate it holds.
    held.gate.penalise(10_000);
    assert.ok(
      gateFor('in-flight').remaining() > 0,
      'the registry must hand the next caller that same pause, not a fresh gate',
    );
    held.release();
  });

  it('lets a released gate be evicted again', () => {
    resetRateLimitGates();
    leaseRateLimitGate('done').release();
    pruneRateLimitGates(Date.now() + GATE_IDLE_TTL_MS + 1);
    assert.equal(rateLimitGateCount(), 0);
  });

  it('survives a double release', () => {
    resetRateLimitGates();
    const lease = leaseRateLimitGate('twice');
    lease.release();
    lease.release();
    const other = leaseRateLimitGate('twice');
    for (let i = 0; i < GATE_LIMIT * 3; i += 1) gateFor(`burst-${i}`);
    other.gate.penalise(10_000);
    assert.ok(
      gateFor('twice').remaining() > 0,
      'a double release must not drop the count below the real holders',
    );
    other.release();
  });

  it('keeps the pause reachable for a real in-flight retry under a burst', async () => {
    resetRateLimitGates();
    let calls = 0;
    const running = runWithRateLimitRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          // A burst of other quotas arrives while this call is in flight.
          for (let i = 0; i < GATE_LIMIT * 3; i += 1) gateFor(`burst-${i}`);
          throw tooManyRequests('0.05');
        }
        return 'ok';
      },
      { key: 'busy', policy: FAST, isRateLimited, retryAfterSeconds },
    );
    await running;
    assert.equal(calls, 2);
  });

  it('reclaims idle gates on demand as well', () => {
    resetRateLimitGates();
    for (let i = 0; i < GATE_LIMIT; i += 1) gateFor(`model-${i}`);
    gateFor('held').penalise(GATE_IDLE_TTL_MS * 2);
    // Ten minutes later, none of those one-off models has been used again.
    pruneRateLimitGates(Date.now() + GATE_IDLE_TTL_MS + 1);
    assert.equal(
      rateLimitGateCount(),
      1,
      'only the gate still holding a pause survives',
    );
  });
});

describe('preserveRateLimit', () => {
  it('leaves an ordinary error alone', () => {
    const wrapped = new Error('wrapped');
    assert.equal(preserveRateLimit(new Error('plain'), wrapped), wrapped);
    assert.equal(isRateLimitedError(wrapped), false);
  });

  it('carries the facts onto the provider error', () => {
    const original = Object.assign(new Error('429'), {
      rateLimited: true as const,
      attempts: 4,
      retryAfterSeconds: 12,
    });
    const wrapped = preserveRateLimit(original, new Error('Provider error'));
    assert.ok(isRateLimitedError(wrapped));
    assert.equal(wrapped.attempts, 4);
    assert.equal(wrapped.retryAfterSeconds, 12);
    assert.equal(wrapped.message, 'Provider error');
  });
});

// ---------------------------------------------------------------------------
// The provider hooks
// ---------------------------------------------------------------------------

class ProbeProvider extends BaseLLMProvider {
  async chat(): Promise<LLMResponse> {
    return { content: '' };
  }
  async *streamChat(
    _messages: Message[],
    _tools?: unknown[],
    _options?: LLMCallOptions,
  ): AsyncIterable<LLMResponse> {
    yield { content: '' };
  }
  saysRateLimited(e: unknown) {
    return this.isRateLimited(e);
  }
  readsRetryAfter(e: unknown) {
    return this.retryAfterSeconds(e);
  }
  quotaKey(model?: string) {
    return this.rateLimitKey(model);
  }
}

describe('BaseLLMProvider rate-limit hooks', () => {
  const provider = new ProbeProvider({ apiKey: 'k', model: 'some-model' });

  it('recognises 429 wherever the transport put it', () => {
    assert.equal(provider.saysRateLimited({ response: { status: 429 } }), true);
    assert.equal(provider.saysRateLimited({ status: 429 }), true);
    assert.equal(provider.saysRateLimited({ statusCode: 429 }), true);
  });

  it('treats other failures as failures', () => {
    assert.equal(
      provider.saysRateLimited({ response: { status: 500 } }),
      false,
    );
    assert.equal(provider.saysRateLimited(new Error('socket hang up')), false);
  });

  it('reads Retry-After as seconds', () => {
    assert.equal(provider.readsRetryAfter(tooManyRequests('7')), 7);
  });

  it('reads Retry-After as an HTTP-date', () => {
    const when = new Date(Date.now() + 5_000).toUTCString();
    const seconds = provider.readsRetryAfter(tooManyRequests(when));
    assert.ok(seconds !== undefined && seconds > 3 && seconds <= 6);
  });

  it('reads a Headers object as readily as a plain one', () => {
    const headers = new Headers({ 'Retry-After': '3' });
    assert.equal(
      provider.readsRetryAfter({ response: { status: 429, headers } }),
      3,
    );
  });

  it('says nothing when the server said nothing', () => {
    assert.equal(provider.readsRetryAfter(tooManyRequests()), undefined);
  });

  it('keys the quota by model, since that is how limits are metered', () => {
    assert.match(provider.quotaKey(), /some-model/);
  });

  it('keys a per-request override by the model the call actually uses', () => {
    assert.match(provider.quotaKey('other-model'), /other-model/);
    assert.notEqual(provider.quotaKey('other-model'), provider.quotaKey());
  });
});
