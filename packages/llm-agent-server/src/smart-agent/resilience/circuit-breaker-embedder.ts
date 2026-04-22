/**
 * CircuitBreakerEmbedder — IEmbedder decorator that wraps calls with a CircuitBreaker.
 *
 * When the circuit is open, calls throw an error rather than hitting the
 * underlying embedding service.
 */

import type { IEmbedder, IEmbedResult } from '../interfaces/rag.js';
import { isBatchEmbedder } from '../interfaces/rag.js';
import type { CallOptions } from '../interfaces/types.js';
import { RagError } from '../interfaces/types.js';
import type { CircuitBreaker } from './circuit-breaker.js';

export class CircuitBreakerEmbedder implements IEmbedder {
  constructor(
    private readonly inner: IEmbedder,
    readonly breaker: CircuitBreaker,
  ) {}

  async embed(text: string, options?: CallOptions): Promise<IEmbedResult> {
    if (!this.breaker.isCallPermitted) {
      throw new RagError('Embedder circuit breaker is open', 'CIRCUIT_OPEN');
    }
    try {
      const result = await this.inner.embed(text, options);
      this.breaker.recordSuccess();
      return result;
    } catch (err) {
      this.breaker.recordFailure();
      throw err;
    }
  }

  async embedBatch(
    texts: string[],
    options?: CallOptions,
  ): Promise<IEmbedResult[]> {
    if (!this.breaker.isCallPermitted) {
      throw new RagError('Embedder circuit breaker is open', 'CIRCUIT_OPEN');
    }
    if (!isBatchEmbedder(this.inner)) {
      throw new RagError(
        'Inner embedder does not support batch embedding',
        'EMBED_ERROR',
      );
    }
    try {
      const result = await this.inner.embedBatch(texts, options);
      this.breaker.recordSuccess();
      return result;
    } catch (err) {
      this.breaker.recordFailure();
      throw err;
    }
  }
}
