import type {
  IEmbedder,
  IIdStrategy,
  IRag,
  IRagEditor,
  RagCollectionScope,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { AbstractRagProvider, RagError } from '@mcp-abap-adt/llm-agent';
import type { HanaVectorRagConfig } from './connection.js';
import { type HanaClient, HanaVectorRag } from './hana-vector-rag.js';
import { dropTableSql } from './schema.js';

export interface HanaVectorRagProviderConfig {
  name: string;
  embedder: IEmbedder;
  /**
   * No `string` shorthand here, unlike pg-vector: that shorthand is
   * address-only, HANA has no anonymous login, and a type arm that can only
   * throw is a lie in the type. `pg-vector` keeps its shorthand because a
   * credential is genuinely optional there (trust authentication,
   * `PGUSER`/`PGPASSWORD`); HANA's `credential` is required, so the compiler
   * refuses the shorthand rather than a connect-time throw reporting it.
   * `normalizeConnection` still rejects a string at runtime, for callers with
   * no types to check.
   */
  connection: HanaVectorRagConfig;
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
   * outside the per-collection HanaVectorRag lifecycle.
   */
  clientFactory?: () => HanaClient;
}

function normalizeConnection(
  c: HanaVectorRagConfig | string,
): HanaVectorRagConfig {
  if (typeof c === 'string') {
    // A bare string cannot carry a credential, and HANA's credential is
    // required (no anonymous login) — refuse loudly rather than build a
    // config that would only fail later, deeper in the stack, with a less
    // specific message.
    throw new Error(
      'HanaVectorRagProviderConfig.connection as a bare string is not supported: ' +
        'it cannot carry a credential, and HANA requires one. Pass ' +
        '{ connectionString, credential: staticLogin(user, password) } instead.',
    );
  }
  return c;
}

export class HanaVectorRagProvider extends AbstractRagProvider {
  readonly name: string;
  readonly kind = 'vector';
  readonly editable: boolean;
  readonly supportedScopes: readonly RagCollectionScope[];

  private readonly embedder: IEmbedder;
  private readonly connection: HanaVectorRagConfig;
  private readonly defaultDimension: number;
  private readonly autoCreateSchema: boolean;
  private readonly clientFactory?: () => HanaClient;

  constructor(cfg: HanaVectorRagProviderConfig) {
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
      const rag = new HanaVectorRag(
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
      await client.exec(dropTableSql(name));
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
      const rows = await client.query(
        this.connection.schema
          ? 'SELECT TABLE_NAME FROM SYS.TABLES WHERE SCHEMA_NAME = ?'
          : 'SELECT TABLE_NAME FROM SYS.TABLES WHERE SCHEMA_NAME = CURRENT_SCHEMA',
        this.connection.schema ? [this.connection.schema] : [],
      );
      return { ok: true, value: rows.map((r) => String(r.TABLE_NAME)) };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'RAG_LIST_ERROR') };
    }
  }

  private requireClient(): HanaClient {
    if (!this.clientFactory) {
      throw new Error(
        'HanaVectorRagProvider deleteCollection/listCollections require clientFactory; provide one to enable schema-level operations',
      );
    }
    return this.clientFactory();
  }
}
