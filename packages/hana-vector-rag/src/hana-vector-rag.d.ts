import type { CallOptions, IEmbedder, IQueryEmbedding, IRag, IRagBackendWriter, RagMetadata, RagResult, Result } from '@mcp-abap-adt/llm-agent';
import { RagError } from '@mcp-abap-adt/llm-agent';
import type { HanaVectorRagConfig } from './connection.js';
export type { HanaVectorRagConfig };
export interface HanaClient {
    exec(sql: string, params?: readonly unknown[]): Promise<{
        rowCount: number;
    }>;
    query(sql: string, params?: readonly unknown[]): Promise<Array<Record<string, unknown>>>;
    close(): Promise<void>;
}
export declare class HanaVectorRag implements IRag {
    private readonly collectionName;
    private readonly dimension;
    private readonly embedder;
    private readonly autoCreateSchema;
    private readonly clientPromise;
    private schemaReady;
    private schemaPromise?;
    constructor(config: HanaVectorRagConfig & {
        embedder: IEmbedder;
    }, injectedClient?: HanaClient);
    private createDriverClient;
    /**
     * Idempotent schema bootstrap. Called by both direct makeRag() consumers
     * (when autoCreateSchema is true) and HanaVectorRagProvider.createCollection().
     */
    ensureSchema(): Promise<void>;
    private maybeEnsureSchema;
    private vectorLiteral;
    query(embedding: IQueryEmbedding, k: number, options?: CallOptions): Promise<Result<RagResult[], RagError>>;
    getById(id: string, options?: CallOptions): Promise<Result<RagResult | null, RagError>>;
    healthCheck(): Promise<Result<void, RagError>>;
    upsert(text: string, metadata: RagMetadata, options?: CallOptions): Promise<Result<void, RagError>>;
    upsertPrecomputed(text: string, vector: number[], metadata: RagMetadata): Promise<Result<void, RagError>>;
    private upsertKnown;
    writer(): IRagBackendWriter;
}
//# sourceMappingURL=hana-vector-rag.d.ts.map