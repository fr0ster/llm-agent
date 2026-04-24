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
import { type PgClient, PgVectorRag } from './pg-vector-rag.js';
import { dropTableSql } from './schema.js';

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

function normalizeConnection(c: PgVectorRagConfig | string): PgVectorRagConfig {
  return typeof c === 'string'
    ? { connectionString: c, collectionName: '__unused' }
    : c;
}

export class PgVectorRagProvider extends AbstractRagProvider {
  readonly name: string;
  readonly kind = 'vector';
  readonly editable: boolean;
  readonly supportedScopes: readonly RagCollectionScope[];

  private readonly embedder: IEmbedder;
  private readonly connection: PgVectorRagConfig;
  private readonly defaultDimension: number;
  private readonly autoCreateSchema: boolean;
  private readonly clientFactory?: () => PgClient;

  constructor(cfg: PgVectorRagProviderConfig) {
    super();
    this.name = cfg.name;
    this.embedder = cfg.embedder;
    this.connection = normalizeConnection(cfg.connection);
    this.defaultDimension = cfg.defaultDimension ?? 1536;
    this.autoCreateSchema = cfg.autoCreateSchema ?? true;
    this.editable = cfg.editable ?? true;
    this.supportedScopes = cfg.supportedScopes ?? ['session', 'user', 'global'];
    this.clientFactory = cfg.clientFactory;
    if (cfg.idStrategyFactory) this.idStrategyFactory = cfg.idStrategyFactory;
  }

  async createCollection(
    name: string,
    opts: { scope: RagCollectionScope; sessionId?: string; userId?: string },
  ): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>> {
    const scopeCheck = this.checkScope(opts.scope);
    if (!scopeCheck.ok) return scopeCheck;
    try {
      const rag = new PgVectorRag(
        {
          ...this.connection,
          collectionName: name,
          dimension: this.connection.dimension ?? this.defaultDimension,
          autoCreateSchema: this.autoCreateSchema,
          embedder: this.embedder,
        },
        this.clientFactory?.(),
      );
      if (this.autoCreateSchema) await rag.ensureSchema();
      const editor = this.buildEditor(rag, this.pickIdStrategy(opts));
      return { ok: true, value: { rag, editor } };
    } catch (err) {
      return {
        ok: false,
        error: new RagError(String(err), 'RAG_CREATE_ERROR'),
      };
    }
  }

  async deleteCollection(name: string): Promise<Result<void, RagError>> {
    try {
      const client = this.requireClient();
      await client.query(dropTableSql(name));
      return { ok: true, value: undefined };
    } catch (err) {
      return {
        ok: false,
        error: new RagError(String(err), 'RAG_DELETE_ERROR'),
      };
    }
  }

  async listCollections(): Promise<Result<string[], RagError>> {
    try {
      const client = this.requireClient();
      const schema = this.connection.schema ?? 'public';
      const { rows } = await client.query(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = $1',
        [schema],
      );
      return { ok: true, value: rows.map((r) => String(r.table_name)) };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'RAG_LIST_ERROR') };
    }
  }

  private requireClient(): PgClient {
    if (!this.clientFactory) {
      throw new Error(
        'PgVectorRagProvider deleteCollection/listCollections require clientFactory; provide one to enable schema-level operations',
      );
    }
    return this.clientFactory();
  }
}
