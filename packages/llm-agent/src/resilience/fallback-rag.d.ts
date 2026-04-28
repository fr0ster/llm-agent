/**
 * FallbackRag — IRag decorator wrapping a primary and fallback store.
 *
 * - **write** — writes go through writer(); fans out to both stores (best-effort for fallback).
 * - **query** — uses primary when the embedder breaker is closed/half-open;
 *   routes to fallback when the breaker is open.
 * - **healthCheck** — delegates to primary.
 */
import type { CallOptions, IQueryEmbedding, IRag, IRagBackendWriter, RagError, RagResult, Result } from '@mcp-abap-adt/llm-agent';
import type { CircuitBreaker } from './circuit-breaker.js';
export declare class FallbackRag implements IRag {
    private readonly primary;
    private readonly fallback;
    private readonly embedderBreaker;
    constructor(primary: IRag, fallback: IRag, embedderBreaker: CircuitBreaker);
    getById(id: string, options?: CallOptions): Promise<Result<RagResult | null, RagError>>;
    query(embedding: IQueryEmbedding, k: number, options?: CallOptions): Promise<Result<RagResult[], RagError>>;
    healthCheck(options?: CallOptions): Promise<Result<void, RagError>>;
    writer(): IRagBackendWriter | undefined;
}
//# sourceMappingURL=fallback-rag.d.ts.map