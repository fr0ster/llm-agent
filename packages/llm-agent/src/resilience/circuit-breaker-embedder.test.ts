import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedResult } from '../interfaces/rag.js';
import { isBatchEmbedder } from '../interfaces/rag.js';
import { CircuitBreaker } from './circuit-breaker.js';
import {
  CircuitBreakerEmbedder,
  withCircuitBreaker,
} from './circuit-breaker-embedder.js';

class BatchEmbedder {
  async embed(): Promise<IEmbedResult> {
    return { vector: [1] };
  }
  async embedBatch(texts: string[]): Promise<IEmbedResult[]> {
    return texts.map(() => ({ vector: [1] }));
  }
}

class EmbedOnly {
  async embed(): Promise<IEmbedResult> {
    return { vector: [1] };
  }
}

const breaker = () => new CircuitBreaker({ failureThreshold: 1 });

describe('withCircuitBreaker', () => {
  it('preserves batch capability — does not fabricate it', () => {
    assert.equal(
      isBatchEmbedder(withCircuitBreaker(new BatchEmbedder(), breaker())),
      true,
    );
    assert.equal(
      isBatchEmbedder(withCircuitBreaker(new EmbedOnly(), breaker())),
      false,
    );
  });

  it('batch call works through the breaker for a batch inner', async () => {
    const e = withCircuitBreaker(new BatchEmbedder(), breaker());
    const out = await (
      e as { embedBatch(t: string[]): Promise<IEmbedResult[]> }
    ).embedBatch(['a', 'b']);
    assert.equal(out.length, 2);
  });

  it('embed works through the breaker for a non-batch inner', async () => {
    const e = withCircuitBreaker(new EmbedOnly(), breaker());
    assert.deepEqual((await e.embed('x')).vector, [1]);
  });

  it('the direct constructor stays batch-shaped (backward compatibility)', () => {
    // The exported class is unchanged for consumers who construct it directly;
    // only the factory is the capability-preserving entry point.
    assert.equal(
      isBatchEmbedder(
        new CircuitBreakerEmbedder(new BatchEmbedder(), breaker()),
      ),
      true,
    );
  });
});
