import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BaseLLMProvider } from '../base-llm-provider.js';

/**
 * A rate limit is per account, so two callers holding different credentials against
 * one endpoint must not share a 429 gate. That dimension used to be a fingerprint of
 * the configured `apiKey`; the config carries no secret now, so it comes from the
 * credential object's identity instead.
 *
 * These are behavioural assertions on purpose. A `@ts-expect-error` here would prove
 * nothing: this package's tsconfig excludes test files from its type check, and the
 * runner is tsx, which strips types without checking them.
 */
class Probe extends BaseLLMProvider<{ model?: string; quotaScope?: string }> {
  constructor(
    cfg: { model?: string; quotaScope?: string },
    private readonly credential?: object,
  ) {
    super(cfg as never);
  }
  protected override quotaCredential(): object | undefined {
    return this.credential;
  }
  protected override quotaEndpoint(): string {
    return 'https://api.example/v1';
  }
  keyFor(model?: string): string {
    return (this as unknown as { quotaKey(m?: string): string }).quotaKey(
      model,
    );
  }
}

describe('quota scope', () => {
  it('separates two credentials, so one account being limited does not gate another', () => {
    const a = new Probe(
      { model: 'm' },
      { kind: 'api-key', secret: async () => 'A' },
    );
    const b = new Probe(
      { model: 'm' },
      { kind: 'api-key', secret: async () => 'B' },
    );
    assert.notEqual(a.keyFor(), b.keyFor());
  });

  it('gives one credential one bucket, however often it is asked', () => {
    const credential = { kind: 'api-key' as const, secret: async () => 'A' };
    const a = new Probe({ model: 'm' }, credential);
    const b = new Probe({ model: 'm' }, credential);
    assert.equal(
      a.keyFor(),
      b.keyFor(),
      'the same credential object is the same account',
    );
  });

  it('never puts the secret in the key', async () => {
    const secret = 'sk-do-not-leak';
    const p = new Probe(
      { model: 'm' },
      { kind: 'api-key', secret: async () => secret },
    );
    assert.ok(
      !p.keyFor().includes(secret),
      'a cache key is not a place for a secret',
    );
  });

  it('lets a consumer merge buckets deliberately', () => {
    const a = new Probe(
      { model: 'm', quotaScope: 'shared' },
      { secret: async () => 'A' },
    );
    const b = new Probe(
      { model: 'm', quotaScope: 'shared' },
      { secret: async () => 'B' },
    );
    assert.equal(
      a.keyFor(),
      b.keyFor(),
      'an explicit scope wins over identity',
    );
  });

  it('keeps anonymous providers together, as they were', () => {
    const a = new Probe({ model: 'm' });
    const b = new Probe({ model: 'm' });
    assert.equal(a.keyFor(), b.keyFor());
  });
});
