/**
 * CircuitBreakerEmbedder — IEmbedder decorator that wraps calls with a CircuitBreaker.
 *
 * When the circuit is open, calls throw an error rather than hitting the
 * underlying embedding service.
 *
 * Prefer the {@link withCircuitBreaker} factory: it selects a non-batch or
 * batch class by inspecting the inner embedder, so it preserves batch
 * capability rather than fabricating it. The exported classes are kept for
 * direct construction and backward compatibility.
 */

import type {
  CallOptions,
  IEmbedder,
  IEmbedderBatch,
  IEmbedResult,
} from '@mcp-abap-adt/llm-agent';
import { isBatchEmbedder, RagError } from '@mcp-abap-adt/llm-agent';
import type { CircuitBreaker } from './circuit-breaker.js';

/** Non-batch breaker decorator — exposes only `embed()`. */
export class CircuitBreakerEmbedderBase implements IEmbedder {
  constructor(
    protected readonly inner: IEmbedder,
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
}

/**
 * Batch breaker decorator. Unchanged public shape: it always exposes
 * `embedBatch`, so `new CircuitBreakerEmbedder(nonBatchInner, ...)` still
 * reports batch capability it lacks (and throws at call time). Construct via
 * {@link withCircuitBreaker} to avoid that.
 */
export class CircuitBreakerEmbedder
  extends CircuitBreakerEmbedderBase
  implements IEmbedderBatch
{
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

/**
 * Wrap an embedder with a circuit breaker, preserving batch capability: a
 * batch-capable inner gets the batch class, a non-batch inner the base class.
 * The same two-class-behind-a-factory shape as `wrapEmbedder` / `withRetry`.
 */
export function withCircuitBreaker(
  inner: IEmbedder,
  breaker: CircuitBreaker,
): IEmbedder {
  return isBatchEmbedder(inner)
    ? new CircuitBreakerEmbedder(inner, breaker)
    : new CircuitBreakerEmbedderBase(inner, breaker);
}
