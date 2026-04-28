import { AbstractRagProvider, RagError } from '@mcp-abap-adt/llm-agent';
import { HanaVectorRag } from './hana-vector-rag.js';
import { dropTableSql } from './schema.js';

function normalizeConnection(c) {
  if (typeof c === 'string') {
    return { connectionString: c, collectionName: '__unused' };
  }
  return c;
}
export class HanaVectorRagProvider extends AbstractRagProvider {
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
  async deleteCollection(name) {
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
  async listCollections() {
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
  requireClient() {
    if (!this.clientFactory) {
      throw new Error(
        'HanaVectorRagProvider deleteCollection/listCollections require clientFactory; provide one to enable schema-level operations',
      );
    }
    return this.clientFactory();
  }
}
//# sourceMappingURL=hana-vector-rag-provider.js.map
