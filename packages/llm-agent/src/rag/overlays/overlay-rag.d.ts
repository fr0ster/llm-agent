import type { IQueryEmbedding } from '../../interfaces/query-embedding.js';
import type { IRag } from '../../interfaces/rag.js';
import type { CallOptions, RagError, RagResult, Result } from '../../interfaces/types.js';
export declare class OverlayRag implements IRag {
    protected readonly base: IRag;
    protected readonly overlay: IRag;
    constructor(base: IRag, overlay: IRag);
    query(embedding: IQueryEmbedding, k: number, options?: CallOptions): Promise<Result<RagResult[], RagError>>;
    getById(id: string, options?: CallOptions): Promise<Result<RagResult | null, RagError>>;
    healthCheck(options?: CallOptions): Promise<Result<void, RagError>>;
    /** Hook for subclasses to drop overlay rows (e.g. by sessionId). */
    protected filterOverlay(results: RagResult[]): RagResult[];
    protected overlayAllows(_result: RagResult): boolean;
}
//# sourceMappingURL=overlay-rag.d.ts.map