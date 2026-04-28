import type { IIdStrategy, IRag, IRagEditor, RagCollectionScope } from '../../interfaces/rag.js';
import type { RagError, Result } from '../../interfaces/types.js';
import { type InMemoryRagConfig } from '../in-memory-rag.js';
import { AbstractRagProvider } from './base-provider.js';
export interface InMemoryRagProviderConfig {
    name: string;
    editable?: boolean;
    inMemoryRagConfig?: InMemoryRagConfig;
    idStrategyFactory?: (opts: {
        scope: RagCollectionScope;
        sessionId?: string;
        userId?: string;
    }) => IIdStrategy;
}
export declare class InMemoryRagProvider extends AbstractRagProvider {
    readonly name: string;
    readonly kind = "vector";
    readonly editable: boolean;
    readonly supportedScopes: readonly ["session"];
    private readonly inMemoryCfg?;
    constructor(cfg: InMemoryRagProviderConfig);
    createCollection(_name: string, opts: {
        scope: RagCollectionScope;
        sessionId?: string;
        userId?: string;
    }): Promise<Result<{
        rag: IRag;
        editor: IRagEditor;
    }, RagError>>;
}
//# sourceMappingURL=in-memory-rag-provider.d.ts.map