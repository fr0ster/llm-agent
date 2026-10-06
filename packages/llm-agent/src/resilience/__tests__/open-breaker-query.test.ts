/**
 * Spec §10.4, D68: FallbackRag is removed. With the embedder breaker open a
 * store's query fails fast with the breaker's error — no in-memory copy
 * answers it, and the provider's embedder is not called.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as core from '../../index.js';
import { TextOnlyEmbedding } from '../../rag/query-embedding.js';
import { symmetricEmbedder } from '../../rag/retrieval-embedder.js';
import { VectorRag } from '../../rag/vector-rag.js';
import { CircuitBreaker } from '../circuit-breaker.js';
import { withCircuitBreaker } from '../circuit-breaker-embedder.js';

describe('an open embedder breaker fails a store query fast (D68)', () => {
  it('VectorRag over a breaker-wrapped embedder: CIRCUIT_OPEN, no embedding call', async () => {
    let embeds = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryWindowMs: 60_000,
    });
    const embedder = withCircuitBreaker(
      {
        embed: async () => {
          embeds++;
          return { vector: [1, 0] };
        },
      },
      breaker,
    );
    const rag = new VectorRag(symmetricEmbedder(embedder));
    const w = rag.writer();
    assert.ok(w);
    assert.ok(
      (await w.upsertRaw('a', 'alpha', { id: 'a' })).ok,
      'written while closed',
    );
    const written = embeds;
    breaker.recordFailure();
    assert.equal(breaker.state, 'open');
    const res = await rag.query(new TextOnlyEmbedding('alpha'), 1);
    assert.equal(res.ok, false, 'no answer from a copy');
    assert.ok(
      !res.ok && res.error.code === 'CIRCUIT_OPEN',
      'the breaker error reaches the caller',
    );
    assert.equal(embeds, written, 'the provider is not called while open');
  });

  it('FallbackRag is not exported any more', () => {
    assert.equal('FallbackRag' in core, false);
  });
});
