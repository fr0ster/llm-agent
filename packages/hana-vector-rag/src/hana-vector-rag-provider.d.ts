import type { IEmbedder, IIdStrategy, IRag, IRagEditor, RagCollectionScope, Result } from '@mcp-abap-adt/llm-agent';
import { AbstractRagProvider, RagError } from '@mcp-abap-adt/llm-agent';
import type { HanaVectorRagConfig } from './connection.js';
import { type HanaClient } from './hana-vector-rag.js';
export interface HanaVectorRagProviderConfig {
    name: string;
    embedder: IEmbedder;
    connection: HanaVectorRagConfig | string;
    defaultDimension?: number;
    autoCreateSchema?: boolean;
    editable?: boolean;
    supportedScopes?: readonly RagCollectionScope[];
    idStrategyFactory?: (opts: {
        scope: RagCollectionScope;
        sessionId?: string;
        userId?: string;
    }) => IIdStrategy;
    /**
     * Optional factory for driver clients used by deleteCollection / listCollections
     * and (in tests) by createCollection. When omitted, deleteCollection and
     * listCollections throw because schema-level operations require a shared client
     * outside the per-collection HanaVectorRag lifecycle.
     */
    clientFactory?: () => HanaClient;
}
export declare class HanaVectorRagProvider extends AbstractRagProvider {
    readonly name: string;
    readonly kind = "vector";
    readonly editable: boolean;
    readonly supportedScopes: readonly RagCollectionScope[];
    private readonly embedder;
    private readonly connection;
    private readonly defaultDimension;
    private readonly autoCreateSchema;
    private readonly clientFactory?;
    constructor(cfg: HanaVectorRagProviderConfig);
    createCollection(name: string, opts: {
        scope: RagCollectionScope;
        sessionId?: string;
        userId?: string;
    }): Promise<Result<{
        rag: IRag;
        editor: IRagEditor;
    }, RagError>>;
    deleteCollection(name: string): Promise<Result<void, RagError>>;
    listCollections(): Promise<Result<string[], RagError>>;
    private requireClient;
}
//# sourceMappingURL=hana-vector-rag-provider.d.ts.map