import type { IIdStrategy, IRag, IRagEditor, IRagProvider, RagCollectionScope } from '../../interfaces/rag.js';
import type { RagError, Result } from '../../interfaces/types.js';
export declare abstract class AbstractRagProvider implements IRagProvider {
    abstract readonly name: string;
    abstract readonly kind: string;
    abstract readonly editable: boolean;
    abstract readonly supportedScopes: readonly RagCollectionScope[];
    protected idStrategyFactory?: (opts: {
        scope: RagCollectionScope;
        sessionId?: string;
        userId?: string;
    }) => IIdStrategy;
    abstract createCollection(name: string, opts: {
        scope: RagCollectionScope;
        sessionId?: string;
        userId?: string;
    }): Promise<Result<{
        rag: IRag;
        editor: IRagEditor;
    }, RagError>>;
    protected checkScope(scope: RagCollectionScope): Result<void, RagError>;
    protected pickIdStrategy(opts: {
        scope: RagCollectionScope;
        sessionId?: string;
        userId?: string;
    }): IIdStrategy;
    protected buildEditor(rag: IRag, idStrategy: IIdStrategy): IRagEditor;
}
//# sourceMappingURL=base-provider.d.ts.map