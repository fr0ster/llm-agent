import { FallbackQueryEmbedding, RagError } from '@mcp-abap-adt/llm-agent';
import { resolvePgConnectArgs } from './connection.js';
import {
  assertCollectionName,
  createExtensionSql,
  createTableSql,
  quoteIdent,
} from './schema.js';

function vectorLiteral(vec) {
  return `'[${vec.join(',')}]'::vector`;
}
export class PgVectorRag {
  collectionName;
  dimension;
  embedder;
  autoCreateSchema;
  clientPromise;
  schemaReady = false;
  schemaPromise;
  constructor(config, injectedClient) {
    assertCollectionName(config.collectionName);
    this.collectionName = config.collectionName;
    this.dimension = config.dimension ?? 1536;
    this.embedder = config.embedder;
    this.autoCreateSchema = config.autoCreateSchema ?? true;
    // Attach a no-op catch so the eager import never becomes an unhandledRejection.
    // The rejection is re-thrown when clientPromise is actually awaited.
    const driverPromise = injectedClient
      ? Promise.resolve(injectedClient)
      : this.createDriverClient(config);
    driverPromise.catch(() => {});
    this.clientPromise = driverPromise;
  }
  async createDriverClient(cfg) {
    const args = resolvePgConnectArgs(cfg);
    const mod = await import('pg');
    const PoolCtor = mod.Pool ?? mod.default?.Pool;
    if (!PoolCtor) throw new Error('pg module did not expose Pool');
    const pool = new PoolCtor(args);
    return {
      query: (sql, params = []) => pool.query(sql, params),
      end: () => pool.end(),
    };
  }
  async ensureSchema() {
    if (this.schemaReady) return;
    this.schemaPromise ??= (async () => {
      const client = await this.clientPromise;
      await client.query(createExtensionSql());
      await client.query(createTableSql(this.collectionName, this.dimension));
      this.schemaReady = true;
    })();
    await this.schemaPromise;
  }
  async maybeEnsureSchema() {
    if (this.autoCreateSchema) await this.ensureSchema();
  }
  async query(embedding, k, options) {
    if (options?.signal?.aborted)
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    try {
      await this.maybeEnsureSchema();
      const safe = new FallbackQueryEmbedding(embedding, this.embedder);
      const vector = await safe.toVector();
      const client = await this.clientPromise;
      const table = quoteIdent(this.collectionName);
      const lit = vectorLiteral(vector);
      const sql = `SELECT id, text, metadata, vector <=> ${lit} AS score FROM ${table} ORDER BY vector <=> ${lit} LIMIT ${Math.max(1, k)}`;
      const { rows } = await client.query(sql);
      const results = rows.map((row) => ({
        text: String(row.text ?? ''),
        metadata: row.metadata ?? {},
        score: 1 - Number(row.score ?? 0),
      }));
      return { ok: true, value: results };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'QUERY_ERROR') };
    }
  }
  async getById(id, options) {
    if (options?.signal?.aborted)
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    try {
      await this.maybeEnsureSchema();
      const client = await this.clientPromise;
      const { rows } = await client.query(
        `SELECT id, text, metadata FROM ${quoteIdent(this.collectionName)} WHERE id = $1`,
        [id],
      );
      const row = rows[0];
      if (!row) return { ok: true, value: null };
      return {
        ok: true,
        value: {
          text: String(row.text ?? ''),
          metadata: row.metadata ?? {},
          score: 1,
        },
      };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'QUERY_ERROR') };
    }
  }
  async healthCheck() {
    try {
      const client = await this.clientPromise;
      await client.query('SELECT 1');
      return { ok: true, value: undefined };
    } catch (err) {
      return {
        ok: false,
        error: new RagError(String(err), 'HEALTH_CHECK_ERROR'),
      };
    }
  }
  async upsert(text, metadata, options) {
    if (options?.signal?.aborted)
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    try {
      const { vector } = await this.embedder.embed(text, options);
      return this.upsertKnown(text, vector, metadata);
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'UPSERT_ERROR') };
    }
  }
  async upsertPrecomputed(text, vector, metadata) {
    return this.upsertKnown(text, vector, metadata);
  }
  async upsertKnown(text, vector, metadata) {
    try {
      await this.maybeEnsureSchema();
      const client = await this.clientPromise;
      const id = metadata?.id ?? crypto.randomUUID();
      const { id: _omit, ...rest } = metadata ?? {};
      const table = quoteIdent(this.collectionName);
      const sql = `INSERT INTO ${table} (id, text, vector, metadata) VALUES ($1, $2, ${vectorLiteral(vector)}, $3::jsonb) ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text, vector = EXCLUDED.vector, metadata = EXCLUDED.metadata`;
      await client.query(sql, [id, text, JSON.stringify(rest)]);
      return { ok: true, value: undefined };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'UPSERT_ERROR') };
    }
  }
  writer() {
    return {
      upsertRaw: async (id, text, metadata, options) => {
        const r = await this.upsert(text, { ...metadata, id }, options);
        return r.ok ? { ok: true, value: undefined } : r;
      },
      deleteByIdRaw: async (id) => {
        try {
          await this.maybeEnsureSchema();
          const client = await this.clientPromise;
          const res = await client.query(
            `DELETE FROM ${quoteIdent(this.collectionName)} WHERE id = $1`,
            [id],
          );
          return { ok: true, value: res.rowCount > 0 };
        } catch (err) {
          return {
            ok: false,
            error: new RagError(String(err), 'DELETE_ERROR'),
          };
        }
      },
      clearAll: async () => {
        try {
          await this.maybeEnsureSchema();
          const client = await this.clientPromise;
          await client.query(`TRUNCATE ${quoteIdent(this.collectionName)}`);
          return { ok: true, value: undefined };
        } catch (err) {
          return { ok: false, error: new RagError(String(err), 'CLEAR_ERROR') };
        }
      },
      upsertPrecomputedRaw: async (id, text, vector, metadata) =>
        this.upsertPrecomputed(text, vector, { ...metadata, id }),
    };
  }
}
//# sourceMappingURL=pg-vector-rag.js.map
