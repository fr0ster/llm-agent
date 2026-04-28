import type { IEmbedder, IQueryEmbedding, IRag, IRagBackendWriter } from '@mcp-abap-adt/llm-agent';
import { type CallOptions, RagError, type RagMetadata, type RagResult, type Result } from '@mcp-abap-adt/llm-agent';
export interface QdrantRagConfig {
    url: string;
    collectionName: string;
    embedder: IEmbedder;
    apiKey?: string;
    /** Per-request timeout in ms. Default: 30 000 */
    timeoutMs?: number;
}
export declare class QdrantRag implements IRag {
    private readonly url;
    private readonly collectionName;
    private readonly embedder;
    private readonly apiKey?;
    private readonly timeoutMs;
    private collectionEnsured;
    constructor(config: QdrantRagConfig);
    private _headers;
    private _fetch;
    private _ensureCollection;
    private upsertKnownVector;
    upsert(text: string, metadata: RagMetadata, options?: CallOptions): Promise<Result<void, RagError>>;
    upsertPrecomputed(text: string, vector: number[], metadata: RagMetadata, options?: CallOptions): Promise<Result<void, RagError>>;
    query(embedding: IQueryEmbedding, k: number, options?: CallOptions): Promise<Result<RagResult[], RagError>>;
    getById(id: string, options?: CallOptions): Promise<Result<RagResult | null, RagError>>;
    healthCheck(options?: CallOptions): Promise<Result<void, RagError>>;
    writer(): IRagBackendWriter;
}
//# sourceMappingURL=qdrant-rag.d.ts.map