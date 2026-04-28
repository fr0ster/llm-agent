import { AbstractRagProvider, RagError } from '@mcp-abap-adt/llm-agent';
import { PgVectorRag } from './pg-vector-rag.js';
import { dropTableSql } from './schema.js';

function normalizeConnection(c) {
  return typeof c === 'string'
    ? { connectionString: c, collectionName: '__unused' }
    : c;
}
export class PgVectorRagProvider extends AbstractRagProvider {
  name;
  kind = 'vector';
  editable;
  supportedScopes;
  embedder;
  connection;
  defaultDimension;
  autoCreateSchema;
  clientFactory;
  constructor(cfg) {
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
  async createCollection(name, opts) {
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
  async deleteCollection(name) {
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
  async listCollections() {
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
  requireClient() {
    if (!this.clientFactory) {
      throw new Error(
        'PgVectorRagProvider deleteCollection/listCollections require clientFactory; provide one to enable schema-level operations',
      );
    }
    return this.clientFactory();
  }
}
//# sourceMappingURL=pg-vector-rag-provider.js.map
