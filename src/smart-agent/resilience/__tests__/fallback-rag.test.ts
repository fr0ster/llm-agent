import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeRag } from '../../testing/index.js';
import { CircuitBreaker } from '../circuit-breaker.js';
import { FallbackRag } from '../fallback-rag.js';

describe('FallbackRag', () => {
  it('upserts to both primary and fallback', async () => {
    const primary = makeRag();
    const fallback = makeRag();
    const breaker = new CircuitBreaker();
    const rag = new FallbackRag(primary, fallback, breaker);

    await rag.upsert('test text', { id: 'x' });
    assert.equal(primary.upsertCalls.length, 1);
    assert.equal(fallback.upsertCalls.length, 1);
  });

  it('queries primary when breaker is closed', async () => {
    const primaryResults = [
      { text: 'primary result', metadata: {}, score: 0.9 },
    ];
    const fallbackResults = [
      { text: 'fallback result', metadata: {}, score: 0.5 },
    ];
    const primary = makeRag(primaryResults);
    const fallback = makeRag(fallbackResults);
    const breaker = new CircuitBreaker();
    const rag = new FallbackRag(primary, fallback, breaker);

    const result = await rag.query('search', 5);
    assert.ok(result.ok);
    assert.equal(result.value[0].text, 'primary result');
  });

  it('queries fallback when breaker is open', async () => {
    const primaryResults = [
      { text: 'primary result', metadata: {}, score: 0.9 },
    ];
    const fallbackResults = [
      { text: 'fallback result', metadata: {}, score: 0.5 },
    ];
    const primary = makeRag(primaryResults);
    const fallback = makeRag(fallbackResults);
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    breaker.recordFailure(); // open the breaker
    const rag = new FallbackRag(primary, fallback, breaker);

    const result = await rag.query('search', 5);
    assert.ok(result.ok);
    assert.equal(result.value[0].text, 'fallback result');
  });

  it('healthCheck delegates to primary', async () => {
    const primary = makeRag();
    const fallback = makeRag();
    const breaker = new CircuitBreaker();
    const rag = new FallbackRag(primary, fallback, breaker);

    const result = await rag.healthCheck();
    assert.ok(result.ok);
  });

  it('upsert returns primary result even if fallback fails', async () => {
    const primary = makeRag();
    // Fallback that throws
    const fallback = {
      ...makeRag(),
      async upsert(): Promise<{ ok: true; value: undefined }> {
        throw new Error('fallback down');
      },
    };
    const breaker = new CircuitBreaker();
    const rag = new FallbackRag(primary, fallback, breaker);

    const result = await rag.upsert('text', {});
    assert.ok(result.ok);
    assert.equal(primary.upsertCalls.length, 1);
  });
});
