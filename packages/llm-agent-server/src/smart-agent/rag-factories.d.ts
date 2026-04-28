import type { IEmbedder, IRag } from '@mcp-abap-adt/llm-agent';
export interface RagFactoryOpts {
    url?: string;
    apiKey?: string;
    collectionName?: string;
    embedder: IEmbedder;
    timeoutMs?: number;
    dimension?: number;
    autoCreateSchema?: boolean;
    connectionString?: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    schema?: string;
    poolMax?: number;
    connectTimeout?: number;
}
/**
 * Load peer packages for the RAG backend names given. Call once at server
 * startup before any synchronous resolveRag calls. Missing peer throws
 * MissingProviderError up front so startup fails fast.
 */
export declare function prefetchRagFactories(names: readonly string[]): Promise<void>;
/** Sync resolve. Caller MUST have awaited prefetchRagFactories(names) first. */
export declare function resolveRag(name: string, opts: RagFactoryOpts): IRag;
/** Test-only: reset the prefetched map. */
export declare function _resetPrefetchedRagForTests(): void;
export declare const ragBackendNames: readonly string[];
//# sourceMappingURL=rag-factories.d.ts.map