import type { IQueryEmbedding } from './query-embedding.js';
import type { CallOptions, RagError, RagMetadata, RagResult, Result } from './types.js';
export interface IEmbedResult {
    vector: number[];
    usage?: {
        promptTokens: number;
        totalTokens: number;
    };
}
export interface IEmbedder {
    embed(text: string, options?: CallOptions): Promise<IEmbedResult>;
}
/** Config subset passed to EmbedderFactory so it can configure the embedder. */
export interface EmbedderFactoryConfig {
    /** Base URL for the embedding service (Ollama URL, OpenAI base, etc.) */
    url?: string;
    /** API key when required by the embedding provider */
    apiKey?: string;
    /** Embedding model name */
    model?: string;
    /** Per-request timeout in milliseconds */
    timeoutMs?: number;
}
/**
 * Factory function that creates an IEmbedder from declarative config.
 * Consumers register custom factories to support YAML-driven embedder selection.
 */
export type EmbedderFactory = (cfg: EmbedderFactoryConfig) => IEmbedder;
export interface IRag {
    query(embedding: IQueryEmbedding, k: number, options?: CallOptions): Promise<Result<RagResult[], RagError>>;
    healthCheck(options?: CallOptions): Promise<Result<void, RagError>>;
    /** Fetch a single document by its metadata id. Returns null if not found. */
    getById(id: string, options?: CallOptions): Promise<Result<RagResult | null, RagError>>;
    /** Returns a backend writer if this implementation supports writes. */
    writer?(): IRagBackendWriter | undefined;
}
export interface IEmbedderBatch extends IEmbedder {
    embedBatch(texts: string[], options?: CallOptions): Promise<IEmbedResult[]>;
}
export declare function isBatchEmbedder(e: IEmbedder): e is IEmbedderBatch;
export interface IRagEditor {
    upsert(text: string, metadata: RagMetadata, options?: CallOptions): Promise<Result<{
        id: string;
    }, RagError>>;
    deleteById(id: string, options?: CallOptions): Promise<Result<boolean, RagError>>;
    clear?(): Promise<Result<void, RagError>>;
}
export interface IIdStrategy {
    /** Always returns a valid id; throws MissingIdError when required input is missing. */
    resolve(metadata: RagMetadata, text: string): string;
}
export interface IRagBackendWriter {
    upsertRaw(id: string, text: string, metadata: RagMetadata, options?: CallOptions): Promise<Result<void, RagError>>;
    deleteByIdRaw(id: string, options?: CallOptions): Promise<Result<boolean, RagError>>;
    clearAll?(): Promise<Result<void, RagError>>;
    upsertPrecomputedRaw?(id: string, text: string, vector: number[], metadata: RagMetadata, options?: CallOptions): Promise<Result<void, RagError>>;
}
export type RagCollectionScope = 'session' | 'user' | 'global';
export interface RagCollectionMeta {
    readonly name: string;
    readonly displayName: string;
    readonly description?: string;
    readonly editable: boolean;
    readonly scope?: RagCollectionScope;
    readonly sessionId?: string;
    readonly userId?: string;
    readonly providerName?: string;
    readonly tags?: readonly string[];
}
export interface IRagRegistry {
    register(name: string, rag: IRag, editor?: IRagEditor, meta?: Omit<RagCollectionMeta, 'name' | 'editable'>): void;
    unregister(name: string): boolean;
    get(name: string): IRag | undefined;
    getEditor(name: string): IRagEditor | undefined;
    list(): readonly RagCollectionMeta[];
    /** Create a collection via a provider and register it atomically. */
    createCollection(params: {
        providerName: string;
        collectionName: string;
        scope: RagCollectionScope;
        sessionId?: string;
        userId?: string;
        displayName?: string;
        description?: string;
        tags?: readonly string[];
    }): Promise<Result<RagCollectionMeta, RagError>>;
    /** Delete a collection; delegate to provider (if set in meta) then unregister. */
    deleteCollection(name: string): Promise<Result<void, RagError>>;
    /** Unregister + delete all session-scoped collections with the given sessionId. */
    closeSession(sessionId: string): Promise<Result<void, RagError>>;
}
export interface IRagProvider {
    readonly name: string;
    readonly kind: string;
    readonly editable: boolean;
    readonly supportedScopes: readonly RagCollectionScope[];
    createCollection(name: string, opts: {
        scope: RagCollectionScope;
        sessionId?: string;
        userId?: string;
    }): Promise<Result<{
        rag: IRag;
        editor: IRagEditor;
    }, RagError>>;
    deleteCollection?(name: string): Promise<Result<void, RagError>>;
    listCollections?(): Promise<Result<string[], RagError>>;
}
export interface IRagProviderRegistry {
    registerProvider(provider: IRagProvider): void;
    getProvider(name: string): IRagProvider | undefined;
    listProviders(): readonly string[];
}
//# sourceMappingURL=rag.d.ts.map