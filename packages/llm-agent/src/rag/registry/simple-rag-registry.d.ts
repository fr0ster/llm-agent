import type { IRag, IRagEditor, IRagProviderRegistry, IRagRegistry, RagCollectionMeta, RagCollectionScope } from '../../interfaces/rag.js';
import { RagError, type Result } from '../../interfaces/types.js';
interface Entry {
    rag: IRag;
    editor?: IRagEditor;
    meta: RagCollectionMeta;
}
export declare class SimpleRagRegistry implements IRagRegistry {
    protected readonly entries: Map<string, Entry>;
    protected providerRegistry?: IRagProviderRegistry;
    protected mutationListener?: () => void;
    setProviderRegistry(providerRegistry: IRagProviderRegistry): void;
    setMutationListener(listener: () => void): void;
    private fireMutation;
    register(name: string, rag: IRag, editor?: IRagEditor, meta?: Omit<RagCollectionMeta, 'name' | 'editable'>): void;
    unregister(name: string): boolean;
    get(name: string): IRag | undefined;
    getEditor(name: string): IRagEditor | undefined;
    list(): readonly RagCollectionMeta[];
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
    deleteCollection(name: string): Promise<Result<void, RagError>>;
    closeSession(sessionId: string): Promise<Result<void, RagError>>;
}
export {};
//# sourceMappingURL=simple-rag-registry.d.ts.map