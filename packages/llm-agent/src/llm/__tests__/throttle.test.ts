import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { beforeEach, describe, it } from 'node:test';
import type {
  LLMCallOptions,
  LLMResponse,
  Message,
} from '../../interfaces/index.js';
import {
  type IThrottleStrategy,
  WaitAsTold,
} from '../../interfaces/throttle-strategy.js';
import { BaseLLMProvider } from '../base-llm-provider.js';
import {
  GATE_IDLE_TTL_MS,
  GATE_LIMIT,
  gateFor,
  isThrottledError,
  leaseQuotaGate,
  preserveThrottled,
  pruneQuotaGates,
  QuotaGate,
  quotaGateCount,
  resetQuotaGates,
  runWithThrottleRetry,
  setThrottleObserver,
  type ThrottleEvent,
} from '../throttle.js';

const tooManyRequests = (retryAfter?: string) => ({
  response: {
    status: 429,
    headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
  },
});

const isThrottled = (e: unknown) =>
  (e as { response?: { status?: number } })?.response?.status === 429;

const retryAfterSeconds = (e: unknown) => {
  const raw = (e as { response?: { headers?: Record<string, string> } })
    ?.response?.headers?.['retry-after'];
  return raw === undefined ? undefined : Number(raw);
};

beforeEach(() => resetQuotaGates());

describe('runWithThrottleRetry', () => {
  it('passes a successful call straight through', async () => {
    let calls = 0;
    const out = await runWithThrottleRetry(
      async () => {
        calls += 1;
        return 'ok';
      },
      { key: 'k', isThrottled },
    );
    assert.equal(out, 'ok');
    assert.equal(calls, 1);
  });

  it('rethrows a non-throttling error immediately, without retrying', async () => {
    let calls = 0;
    await assert.rejects(
      runWithThrottleRetry(
        async () => {
          calls += 1;
          throw new Error('boom');
        },
        {
          key: 'k',
          strategy: new WaitAsTold(),
          isThrottled,
        },
      ),
      /boom/,
    );
    assert.equal(calls, 1, 'a real failure must not be multiplied by retries');
  });

  it('does not wait by default — it reports', async () => {
    // The library cannot see who is waiting at the other end, so it does not
    // decide to hold them. It says what the server said and lets them choose.
    resetQuotaGates();
    let calls = 0;
    try {
      await runWithThrottleRetry(
        async () => {
          calls += 1;
          throw tooManyRequests('30');
        },
        { key: 'reported', isThrottled, retryAfterSeconds },
      );
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(isThrottledError(e));
      assert.equal(e.reason, 'reported');
      assert.equal(e.retryAfterSeconds, 30, "the server's own number goes up");
    }
    assert.equal(calls, 1, 'one call, no waiting');
  });

  it('records the closed quota even when it does not wait', async () => {
    // Knowing is shared; waiting is not. A caller that leaves without writing
    // it down sends the next one to discover it again, at the price of another
    // refusal.
    resetQuotaGates();
    await assert.rejects(
      runWithThrottleRetry(
        async () => {
          throw tooManyRequests('30');
        },
        { key: 'shared', isThrottled, retryAfterSeconds },
      ),
    );
    assert.ok(gateFor('shared').remaining() > 25_000);
  });

  it('spends no request on a quota already known to be shut', async () => {
    resetQuotaGates();
    gateFor('known').penalise(30_000);
    let calls = 0;
    try {
      await runWithThrottleRetry(
        async () => {
          calls += 1;
          return 'ok';
        },
        { key: 'known', isThrottled },
      );
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(isThrottledError(e));
      assert.ok((e.retryAfterSeconds ?? 0) > 25);
    }
    assert.equal(calls, 0, 'a refusal we can predict is one we need not buy');
  });

  it('waits exactly as told when asked to', async () => {
    resetQuotaGates();
    let calls = 0;
    const started = Date.now();
    const out = await runWithThrottleRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw tooManyRequests('0.05');
        return 'ok';
      },
      {
        key: 'waiting',
        strategy: new WaitAsTold(),
        isThrottled,
        retryAfterSeconds,
      },
    );
    assert.equal(out, 'ok');
    assert.equal(calls, 2);
    assert.ok(
      Date.now() - started >= 50,
      'it served the interval it was given',
    );
  });

  it('reports instead of guessing when the server named no interval', async () => {
    // A missing Retry-After is itself a signal: the header is documented, so
    // its absence says something is not as expected. A number we invent would
    // be an estimate of a system we cannot see.
    resetQuotaGates();
    let calls = 0;
    try {
      await runWithThrottleRetry(
        async () => {
          calls += 1;
          throw tooManyRequests();
        },
        {
          key: 'silent',
          strategy: new WaitAsTold(),
          isThrottled,
          retryAfterSeconds,
        },
      );
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(isThrottledError(e));
      assert.equal(e.reason, 'no-interval');
    }
    assert.equal(calls, 1);
  });

  it('stops a waiting caller at maxAttempts', async () => {
    resetQuotaGates();
    let calls = 0;
    try {
      await runWithThrottleRetry(
        async () => {
          calls += 1;
          throw tooManyRequests('0.01');
        },
        {
          key: 'capped',
          strategy: new WaitAsTold({ maxAttempts: 3 }),
          isThrottled,
          retryAfterSeconds,
        },
      );
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(isThrottledError(e));
      assert.equal(e.reason, 'attempts');
      assert.equal(e.attempts, 3);
    }
    assert.equal(calls, 3);
  });

  it('lets a waiting caller sit out a pause another caller recorded', async () => {
    resetQuotaGates();
    gateFor('busy').penalise(40);
    const started = Date.now();
    const out = await runWithThrottleRetry(async () => 'ok', {
      key: 'busy',
      strategy: new WaitAsTold(),
      isThrottled,
    });
    assert.equal(out, 'ok');
    assert.ok(Date.now() - started >= 40);
  });

  it('stops waiting when the caller aborts', async () => {
    resetQuotaGates();
    gateFor('aborting').penalise(10_000);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    await assert.rejects(
      runWithThrottleRetry(async () => 'ok', {
        key: 'aborting',
        strategy: new WaitAsTold(),
        isThrottled,
        signal: ac.signal,
      }),
    );
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
  });

  it('leaves no abort listeners behind', async () => {
    // A request- or session-scoped signal outlives one call, so a listener per
    // wait would accumulate until Node warns about the leak.
    resetQuotaGates();
    const ac = new AbortController();
    await assert.rejects(
      runWithThrottleRetry(
        async () => {
          throw tooManyRequests('0.01');
        },
        {
          key: 'listeners',
          strategy: new WaitAsTold({ maxAttempts: 4 }),
          isThrottled,
          retryAfterSeconds,
          signal: ac.signal,
        },
      ),
      (e: unknown) => isThrottledError(e),
    );
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
  });

  it("takes a strategy of the consumer's own", async () => {
    resetQuotaGates();
    let asked = 0;
    const onceThenGiveUp: IThrottleStrategy = {
      name: 'once',
      decide: ({ attempt, retryAfterSeconds: s }) => {
        asked += 1;
        return {
          waitMs: (s ?? 0) * 1000,
          retry: attempt < 2,
          reason: attempt < 2 ? undefined : 'attempts',
        };
      },
    };
    let calls = 0;
    await assert.rejects(
      runWithThrottleRetry(
        async () => {
          calls += 1;
          throw tooManyRequests('0.01');
        },
        {
          key: 'own',
          strategy: onceThenGiveUp,
          isThrottled,
          retryAfterSeconds,
        },
      ),
      (e: unknown) => isThrottledError(e) && e.reason === 'attempts',
    );
    assert.equal(calls, 2);
    assert.ok(asked >= 2);
  });

  it('has no knobs of its own — the strategy is the whole configuration', () => {
    // A bound out here would silently overrule a strategy that had decided to
    // keep going. Whatever a strategy wants to limit, it limits itself.
    const call = runWithThrottleRetry(async () => 'ok', {
      key: 'bare',
      isThrottled,
    });
    return call.then((out) => assert.equal(out, 'ok'));
  });
});

describe('the throttle observer', () => {
  const seen: ThrottleEvent[] = [];

  beforeEach(() => {
    seen.length = 0;
    setThrottleObserver((e) => seen.push(e));
  });

  it('reports every refusal, the last one included', async () => {
    // The giving-up event is the one an operator most needs, and it was the one
    // nothing was written for: the old hook fired only before a retry.
    resetQuotaGates();
    await assert.rejects(
      runWithThrottleRetry(
        async () => {
          throw tooManyRequests('0.01');
        },
        {
          key: 'watched',
          strategy: new WaitAsTold({ maxAttempts: 3 }),
          isThrottled,
          retryAfterSeconds,
        },
      ),
      (e: unknown) => isThrottledError(e),
    );
    assert.equal(seen.length, 3);
    assert.deepEqual(
      seen.map((e) => e.willRetry),
      [true, true, false],
    );
    assert.equal(seen.at(-1)?.reason, 'attempts');
  });

  it('names the strategy that made the call', () => {
    // Which strategy is in force is the one thing about the decision that is
    // not visible in the numbers, and it decides how to read them.
    resetQuotaGates();
    return runWithThrottleRetry(
      (() => {
        let calls = 0;
        return async () => {
          calls += 1;
          if (calls < 2) throw tooManyRequests('0.01');
          return 'ok';
        };
      })(),
      {
        key: 'watched',
        strategy: new WaitAsTold(),
        isThrottled,
        retryAfterSeconds,
      },
    ).then(() => {
      assert.equal(seen[0]?.strategy, 'wait-as-told');
      assert.equal(seen[0]?.attempt, 1);
      assert.equal(seen[0]?.key, 'watched');
    });
  });

  it('says whether the server named an interval', async () => {
    resetQuotaGates();
    await assert.rejects(
      runWithThrottleRetry(
        async () => {
          throw tooManyRequests();
        },
        {
          key: 'silent',
          strategy: new WaitAsTold({ maxAttempts: 1 }),
          isThrottled,
        },
      ),
      (e: unknown) => isThrottledError(e),
    );
    assert.equal(
      seen[0]?.retryAfterSeconds,
      undefined,
      'absent means the server said nothing, which is what decides whether backoff tuning matters at all',
    );
  });

  it('does not let a broken diagnostic break the request', async () => {
    resetQuotaGates();
    setThrottleObserver(() => {
      throw new Error('observer is broken');
    });
    const out = await runWithThrottleRetry(
      (() => {
        let calls = 0;
        return async () => {
          calls += 1;
          if (calls < 2) throw tooManyRequests('0.01');
          return 'ok';
        };
      })(),
      {
        key: 'watched',
        strategy: new WaitAsTold(),
        isThrottled,
        retryAfterSeconds,
      },
    );
    assert.equal(out, 'ok');
  });

  it('stops when the observer is cleared', async () => {
    resetQuotaGates();
    setThrottleObserver(undefined);
    await assert.rejects(
      runWithThrottleRetry(
        async () => {
          throw tooManyRequests();
        },
        { key: 'unwatched', isThrottled },
      ),
      (e: unknown) => isThrottledError(e),
    );
    assert.equal(seen.length, 0);
  });
});

describe('QuotaGate', () => {
  it('keeps waiting when another caller extends the hold mid-sleep', async () => {
    const gate = new QuotaGate();
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
    const gate = new QuotaGate();
    const now = 1_000;
    gate.penalise(500, now);
    gate.penalise(100, now);
    assert.equal(gate.remaining(now), 500);
  });

  it('reports nothing to wait once the hold has passed', () => {
    const gate = new QuotaGate();
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
    resetQuotaGates();
    gateFor('held').penalise(GATE_IDLE_TTL_MS * 2);
    pruneQuotaGates(Date.now() + GATE_IDLE_TTL_MS + 1);
    assert.ok(gateFor('held').remaining() > 0);
  });

  it('keeps a gate that was used recently, open or not', () => {
    resetQuotaGates();
    gateFor('fresh');
    pruneQuotaGates();
    assert.equal(quotaGateCount(), 1);
  });

  it('stays bounded through a burst faster than the idle rule retires', () => {
    // The reported failure: 1500 keys inside the TTL left 1500 gates behind.
    resetQuotaGates();
    for (let i = 0; i < GATE_LIMIT * 3; i += 1) gateFor(`burst-${i}`);
    assert.ok(
      quotaGateCount() <= GATE_LIMIT,
      `bounded by the limit, saw ${quotaGateCount()}`,
    );
  });

  it('evicts the least recently used first, and never a held gate', () => {
    resetQuotaGates();
    gateFor('held').penalise(GATE_IDLE_TTL_MS * 2);
    gateFor('oldest');
    for (let i = 0; i < GATE_LIMIT * 2; i += 1) gateFor(`burst-${i}`);
    assert.ok(gateFor('held').remaining() > 0, 'a live pause survives a burst');
    assert.ok(quotaGateCount() <= GATE_LIMIT + 1);
  });

  it('never evicts a gate a call is still holding', () => {
    // Open is not the same as unused: a request is in flight until the server
    // answers, and it has no pause on it until then.
    resetQuotaGates();
    const held = leaseQuotaGate('in-flight');
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
    resetQuotaGates();
    leaseQuotaGate('done').release();
    pruneQuotaGates(Date.now() + GATE_IDLE_TTL_MS + 1);
    assert.equal(quotaGateCount(), 0);
  });

  it('survives a double release', () => {
    resetQuotaGates();
    const lease = leaseQuotaGate('twice');
    lease.release();
    lease.release();
    const other = leaseQuotaGate('twice');
    for (let i = 0; i < GATE_LIMIT * 3; i += 1) gateFor(`burst-${i}`);
    other.gate.penalise(10_000);
    assert.ok(
      gateFor('twice').remaining() > 0,
      'a double release must not drop the count below the real holders',
    );
    other.release();
  });

  it('keeps the pause reachable for a real in-flight retry under a burst', async () => {
    resetQuotaGates();
    let calls = 0;
    const running = runWithThrottleRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          // A burst of other quotas arrives while this call is in flight.
          for (let i = 0; i < GATE_LIMIT * 3; i += 1) gateFor(`burst-${i}`);
          throw tooManyRequests('0.05');
        }
        return 'ok';
      },
      {
        key: 'busy',
        strategy: new WaitAsTold(),
        isThrottled,
        retryAfterSeconds,
      },
    );
    await running;
    assert.equal(calls, 2);
  });

  it('reclaims idle gates on demand as well', () => {
    resetQuotaGates();
    for (let i = 0; i < GATE_LIMIT; i += 1) gateFor(`model-${i}`);
    gateFor('held').penalise(GATE_IDLE_TTL_MS * 2);
    // Ten minutes later, none of those one-off models has been used again.
    pruneQuotaGates(Date.now() + GATE_IDLE_TTL_MS + 1);
    assert.equal(
      quotaGateCount(),
      1,
      'only the gate still holding a pause survives',
    );
  });
});

describe('preserveThrottled', () => {
  it('leaves an ordinary error alone', () => {
    const wrapped = new Error('wrapped');
    assert.equal(preserveThrottled(new Error('plain'), wrapped), wrapped);
    assert.equal(isThrottledError(wrapped), false);
  });

  it('carries the facts onto the provider error', () => {
    const original = Object.assign(new Error('429'), {
      throttled: true as const,
      attempts: 4,
      retryAfterSeconds: 12,
    });
    const wrapped = preserveThrottled(original, new Error('Provider error'));
    assert.ok(isThrottledError(wrapped));
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
    return this.isThrottled(e);
  }
  readsRetryAfter(e: unknown) {
    return this.retryAfterSeconds(e);
  }
  keyFor(model?: string) {
    return this.quotaKey(model);
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
    assert.match(provider.keyFor(), /some-model/);
  });

  it('keys a per-request override by the model the call actually uses', () => {
    assert.match(provider.keyFor('other-model'), /other-model/);
    assert.notEqual(provider.keyFor('other-model'), provider.keyFor());
  });
});
