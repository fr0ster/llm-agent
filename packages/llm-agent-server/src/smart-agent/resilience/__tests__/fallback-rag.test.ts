import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TextOnlyEmbedding } from '@mcp-abap-adt/llm-agent';
import { makeRag } from '../../testing/index.js';
import { CircuitBreaker } from '../circuit-breaker.js';
import { FallbackRag } from '../fallback-rag.js';

describe('FallbackRag', () => {
  it('writer() upserts to both primary and fallback', async () => {
    const primary = makeRag();
    const fallback = makeRag();
    const breaker = new CircuitBreaker();
    const rag = new FallbackRag(primary, fallback, breaker);

    const w = rag.writer();
    assert.ok(w, 'writer() should return a writer');
    await w?.upsertRaw('x', 'test text', {});
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

    const result = await rag.query(new TextOnlyEmbedding('search'), 5);
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

    const result = await rag.query(new TextOnlyEmbedding('search'), 5);
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

  it('writer() upsertRaw returns primary result even if fallback fails', async () => {
    const primary = makeRag();
    // Fallback whose writer throws
    const fallback = {
      ...makeRag(),
      writer() {
        return {
          upsertRaw: async (): Promise<never> => {
            throw new Error('fallback down');
          },
          deleteByIdRaw: async (): Promise<{ ok: true; value: false }> => ({
            ok: true,
            value: false,
          }),
        };
      },
    };
    const breaker = new CircuitBreaker();
    const rag = new FallbackRag(primary, fallback, breaker);

    const w = rag.writer();
    assert.ok(w, 'writer() should return a writer');
    const result = w ? await w.upsertRaw('id1', 'text', {}) : undefined;
    assert.ok(result?.ok);
    assert.equal(primary.upsertCalls.length, 1);
  });

  it('writer() returns undefined when neither primary nor fallback has a writer', async () => {
    // makeRag returns a writer, so strip it to simulate no-writer RAGs
    const primary = makeRag();
    const fallback = makeRag();
    // Override writer to return undefined
    (primary as { writer?: () => undefined }).writer = () => undefined;
    (fallback as { writer?: () => undefined }).writer = () => undefined;
    const breaker = new CircuitBreaker();
    const rag = new FallbackRag(primary, fallback, breaker);
    assert.equal(rag.writer(), undefined);
  });
});
