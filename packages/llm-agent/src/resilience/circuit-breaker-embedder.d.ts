/**
 * CircuitBreakerEmbedder — IEmbedder decorator that wraps calls with a CircuitBreaker.
 *
 * When the circuit is open, calls throw an error rather than hitting the
 * underlying embedding service.
 */
import type {
  CallOptions,
  IEmbedder,
  IEmbedResult,
} from '@mcp-abap-adt/llm-agent';
import type { CircuitBreaker } from './circuit-breaker.js';
export declare class CircuitBreakerEmbedder implements IEmbedder {
  private readonly inner;
  readonly breaker: CircuitBreaker;
  constructor(inner: IEmbedder, breaker: CircuitBreaker);
  embed(text: string, options?: CallOptions): Promise<IEmbedResult>;
  embedBatch(texts: string[], options?: CallOptions): Promise<IEmbedResult[]>;
}
//# sourceMappingURL=circuit-breaker-embedder.d.ts.map
