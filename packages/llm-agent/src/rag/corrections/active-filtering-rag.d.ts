import type { IQueryEmbedding } from '../../interfaces/query-embedding.js';
import type { IRag } from '../../interfaces/rag.js';
import type { CallOptions, RagError, RagResult, Result } from '../../interfaces/types.js';
export declare class ActiveFilteringRag implements IRag {
    private readonly inner;
    constructor(inner: IRag);
    query(embedding: IQueryEmbedding, k: number, options?: CallOptions): Promise<Result<RagResult[], RagError>>;
    getById(id: string, options?: CallOptions): Promise<Result<RagResult | null, RagError>>;
    healthCheck(options?: CallOptions): Promise<Result<void, RagError>>;
}
//# sourceMappingURL=active-filtering-rag.d.ts.map