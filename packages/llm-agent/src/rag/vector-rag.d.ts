import type { IQueryEmbedding } from '../interfaces/query-embedding.js';
import type { IEmbedder, IRag, IRagBackendWriter } from '../interfaces/rag.js';
import { type CallOptions, RagError, type RagMetadata, type RagResult, type Result } from '../interfaces/types.js';
import type { IDocumentEnricher, IQueryPreprocessor } from './preprocessor.js';
import type { ISearchStrategy } from './search-strategy.js';
export interface VectorRagConfig {
    /** Cosine similarity threshold for dedup. Default: 0.92 */
    dedupThreshold?: number;
    /** Namespace for this store. */
    namespace?: string;
    /** Weight for vector search (0..1). Default: 0.7 */
    vectorWeight?: number;
    /** Weight for keyword search (0..1). Default: 0.3 */
    keywordWeight?: number;
    /** Search scoring strategy. Default: WeightedFusionStrategy with the configured weights. */
    strategy?: ISearchStrategy;
    /** Query preprocessors (translate, expand, etc.). Applied in order before embedding. */
    queryPreprocessors?: IQueryPreprocessor[];
    /** Document enrichers. Applied in order before embedding on upsert. */
    documentEnrichers?: IDocumentEnricher[];
}
export declare class VectorRag implements IRag {
    private readonly embedder;
    private records;
    private readonly index;
    private readonly dedupThreshold;
    private readonly namespace?;
    private vectorWeight;
    private keywordWeight;
    private strategy;
    private readonly queryPreprocessors;
    private readonly documentEnrichers;
    constructor(embedder: IEmbedder, config?: VectorRagConfig);
    /** Update hybrid search weights at runtime (hot-reload). */
    updateWeights(config: {
        vectorWeight?: number;
        keywordWeight?: number;
    }): void;
    private tokenize;
    private cosine;
    private upsertKnownVector;
    upsert(text: string, metadata: RagMetadata, options?: CallOptions): Promise<Result<void, RagError>>;
    upsertPrecomputed(text: string, vector: number[], metadata: RagMetadata, _options?: CallOptions): Promise<Result<void, RagError>>;
    query(embedding: IQueryEmbedding, k: number, options?: CallOptions): Promise<Result<RagResult[], RagError>>;
    healthCheck(options?: CallOptions): Promise<Result<void, RagError>>;
    getById(id: string, _options?: CallOptions): Promise<Result<RagResult | null, RagError>>;
    writer(): IRagBackendWriter;
    clear(): void;
}
//# sourceMappingURL=vector-rag.d.ts.map