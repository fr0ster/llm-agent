/**
 * CircuitBreakerEmbedder — IEmbedder decorator that wraps calls with a CircuitBreaker.
 *
 * When the circuit is open, calls throw an error rather than hitting the
 * underlying embedding service.
 */
import { isBatchEmbedder, RagError } from '@mcp-abap-adt/llm-agent';
export class CircuitBreakerEmbedder {
    inner;
    breaker;
    constructor(inner, breaker) {
        this.inner = inner;
        this.breaker = breaker;
    }
    async embed(text, options) {
        if (!this.breaker.isCallPermitted) {
            throw new RagError('Embedder circuit breaker is open', 'CIRCUIT_OPEN');
        }
        try {
            const result = await this.inner.embed(text, options);
            this.breaker.recordSuccess();
            return result;
        }
        catch (err) {
            this.breaker.recordFailure();
            throw err;
        }
    }
    async embedBatch(texts, options) {
        if (!this.breaker.isCallPermitted) {
            throw new RagError('Embedder circuit breaker is open', 'CIRCUIT_OPEN');
        }
        if (!isBatchEmbedder(this.inner)) {
            throw new RagError('Inner embedder does not support batch embedding', 'EMBED_ERROR');
        }
        try {
            const result = await this.inner.embedBatch(texts, options);
            this.breaker.recordSuccess();
            return result;
        }
        catch (err) {
            this.breaker.recordFailure();
            throw err;
        }
    }
}
//# sourceMappingURL=circuit-breaker-embedder.js.map