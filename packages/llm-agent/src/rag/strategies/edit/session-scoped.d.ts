import type { IIdStrategy, IRagBackendWriter, IRagEditor } from '../../../interfaces/rag.js';
import type { CallOptions, RagError, RagMetadata, Result } from '../../../interfaces/types.js';
/**
 * Stamps sessionId (and createdAt if missing) on every write before delegating
 * to the overlay writer. Pairs with SessionScopedRag on the read side.
 */
export declare class SessionScopedEditStrategy implements IRagEditor {
    private readonly writer;
    private readonly sessionId;
    private readonly idStrategy;
    readonly _ttlMs?: number | undefined;
    constructor(writer: IRagBackendWriter, sessionId: string, idStrategy: IIdStrategy, _ttlMs?: number | undefined);
    upsert(text: string, metadata: RagMetadata, options?: CallOptions): Promise<Result<{
        id: string;
    }, RagError>>;
    deleteById(id: string, options?: CallOptions): Promise<Result<boolean, RagError>>;
    clear(): Promise<Result<void, RagError>>;
}
//# sourceMappingURL=session-scoped.d.ts.map