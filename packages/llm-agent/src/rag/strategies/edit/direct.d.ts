import type { IIdStrategy, IRagBackendWriter, IRagEditor } from '../../../interfaces/rag.js';
import type { CallOptions, RagError, RagMetadata, Result } from '../../../interfaces/types.js';
export declare class DirectEditStrategy implements IRagEditor {
    protected readonly writer: IRagBackendWriter;
    protected readonly idStrategy: IIdStrategy;
    constructor(writer: IRagBackendWriter, idStrategy: IIdStrategy);
    upsert(text: string, metadata: RagMetadata, options?: CallOptions): Promise<Result<{
        id: string;
    }, RagError>>;
    deleteById(id: string, options?: CallOptions): Promise<Result<boolean, RagError>>;
    clear(): Promise<Result<void, RagError>>;
}
//# sourceMappingURL=direct.d.ts.map