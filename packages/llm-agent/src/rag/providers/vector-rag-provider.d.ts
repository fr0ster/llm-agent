import type {
  IEmbedder,
  IIdStrategy,
  IRag,
  IRagEditor,
  RagCollectionScope,
} from '../../interfaces/rag.js';
import type { RagError, Result } from '../../interfaces/types.js';
import { type VectorRagConfig } from '../vector-rag.js';
import { AbstractRagProvider } from './base-provider.js';
export interface VectorRagProviderConfig {
  name: string;
  embedder: IEmbedder;
  editable?: boolean;
  vectorRagConfig?: VectorRagConfig;
  idStrategyFactory?: (opts: {
    scope: RagCollectionScope;
    sessionId?: string;
    userId?: string;
  }) => IIdStrategy;
}
export declare class VectorRagProvider extends AbstractRagProvider {
  readonly name: string;
  readonly kind = 'vector';
  readonly editable: boolean;
  readonly supportedScopes: readonly ['session'];
  private readonly embedder;
  private readonly vectorRagConfig?;
  constructor(cfg: VectorRagProviderConfig);
  createCollection(
    _name: string,
    opts: {
      scope: RagCollectionScope;
      sessionId?: string;
      userId?: string;
    },
  ): Promise<
    Result<
      {
        rag: IRag;
        editor: IRagEditor;
      },
      RagError
    >
  >;
}
//# sourceMappingURL=vector-rag-provider.d.ts.map
