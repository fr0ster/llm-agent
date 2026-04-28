import type {
  IEmbedder,
  IIdStrategy,
  IRag,
  IRagEditor,
  RagCollectionScope,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { AbstractRagProvider, RagError } from '@mcp-abap-adt/llm-agent';
import type { PgVectorRagConfig } from './connection.js';
import { type PgClient } from './pg-vector-rag.js';
export interface PgVectorRagProviderConfig {
  name: string;
  embedder: IEmbedder;
  connection: PgVectorRagConfig | string;
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
   * outside the per-collection PgVectorRag lifecycle.
   */
  clientFactory?: () => PgClient;
}
export declare class PgVectorRagProvider extends AbstractRagProvider {
  readonly name: string;
  readonly kind = 'vector';
  readonly editable: boolean;
  readonly supportedScopes: readonly RagCollectionScope[];
  private readonly embedder;
  private readonly connection;
  private readonly defaultDimension;
  private readonly autoCreateSchema;
  private readonly clientFactory?;
  constructor(cfg: PgVectorRagProviderConfig);
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
  private requireClient;
}
//# sourceMappingURL=pg-vector-rag-provider.d.ts.map
