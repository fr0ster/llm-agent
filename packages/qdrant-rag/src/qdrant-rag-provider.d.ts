import type {
  IEmbedder,
  IIdStrategy,
  IRag,
  IRagEditor,
  RagCollectionScope,
} from '@mcp-abap-adt/llm-agent';
import {
  AbstractRagProvider as BaseRagProvider,
  RagError,
  type Result,
} from '@mcp-abap-adt/llm-agent';
export interface QdrantRagProviderConfig {
  name: string;
  url: string;
  apiKey?: string;
  embedder: IEmbedder;
  editable?: boolean;
  timeoutMs?: number;
  supportedScopes?: readonly RagCollectionScope[];
  idStrategyFactory?: (opts: {
    scope: RagCollectionScope;
    sessionId?: string;
    userId?: string;
  }) => IIdStrategy;
}
export declare class QdrantRagProvider extends BaseRagProvider {
  readonly name: string;
  readonly kind = 'vector';
  readonly editable: boolean;
  readonly supportedScopes: readonly RagCollectionScope[];
  private readonly url;
  private readonly apiKey?;
  private readonly embedder;
  private readonly timeoutMs?;
  constructor(cfg: QdrantRagProviderConfig);
  createCollection(
    name: string,
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
  deleteCollection(name: string): Promise<Result<void, RagError>>;
  listCollections(): Promise<Result<string[], RagError>>;
}
//# sourceMappingURL=qdrant-rag-provider.d.ts.map
