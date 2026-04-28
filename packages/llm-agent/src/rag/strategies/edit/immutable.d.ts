import type { IRagEditor } from '../../../interfaces/rag.js';
import type { RagError, Result } from '../../../interfaces/types.js';
export declare class ImmutableEditStrategy implements IRagEditor {
  private readonly collectionName;
  constructor(collectionName?: string);
  upsert(): Promise<
    Result<
      {
        id: string;
      },
      RagError
    >
  >;
  deleteById(): Promise<Result<boolean, RagError>>;
}
//# sourceMappingURL=immutable.d.ts.map
