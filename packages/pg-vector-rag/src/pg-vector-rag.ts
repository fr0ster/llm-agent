import type {
  CallOptions,
  IEmbedder,
  IQueryEmbedding,
  IRag,
  IRagBackendWriter,
  RagMetadata,
  RagResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { FallbackQueryEmbedding, RagError } from '@mcp-abap-adt/llm-agent';
import type { PgVectorRagConfig } from './connection.js';
import { resolvePgConnectArgs } from './connection.js';
import {
  assertCollectionName,
  createExtensionSql,
  createTableSql,
  quoteIdent,
} from './schema.js';

export type { PgVectorRagConfig };

export interface PgClient {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }>;
  end(): Promise<void>;
}

function vectorLiteral(vec: number[]): string {
  return `'[${vec.join(',')}]'::vector`;
}

export class PgVectorRag implements IRag {
  private readonly collectionName: string;
  private readonly dimension: number;
  private readonly embedder: IEmbedder;
  private readonly autoCreateSchema: boolean;
  private readonly clientPromise: Promise<PgClient>;
  private schemaReady = false;
  private schemaPromise?: Promise<void>;

  constructor(
    config: PgVectorRagConfig & { embedder: IEmbedder },
    injectedClient?: PgClient,
  ) {
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

  private async createDriverClient(cfg: PgVectorRagConfig): Promise<PgClient> {
    const args = resolvePgConnectArgs(cfg);
    const mod = (await import('pg')) as unknown as {
      default?: {
        Pool: new (
          a: unknown,
        ) => { query: PgClient['query']; end: () => Promise<void> };
      };
      Pool?: new (
        a: unknown,
      ) => { query: PgClient['query']; end: () => Promise<void> };
    };
    const PoolCtor = mod.Pool ?? mod.default?.Pool;
    if (!PoolCtor) throw new Error('pg module did not expose Pool');
    const pool = new PoolCtor(args);
    return {
      query: (sql, params = []) => pool.query(sql, params as unknown[]),
      end: () => pool.end(),
    };
  }

  async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    this.schemaPromise ??= (async () => {
      const client = await this.clientPromise;
      await client.query(createExtensionSql());
      await client.query(createTableSql(this.collectionName, this.dimension));
      this.schemaReady = true;
    })();
    await this.schemaPromise;
  }

  private async maybeEnsureSchema(): Promise<void> {
    if (this.autoCreateSchema) await this.ensureSchema();
  }

  async query(
    embedding: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
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
      const results: RagResult[] = rows.map((row) => ({
        text: String(row.text ?? ''),
        metadata: (row.metadata as RagMetadata) ?? {},
        score: 1 - Number(row.score ?? 0),
      }));
      return { ok: true, value: results };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'QUERY_ERROR') };
    }
  }

  async getById(
    id: string,
    options?: CallOptions,
  ): Promise<Result<RagResult | null, RagError>> {
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
          metadata: (row.metadata as RagMetadata) ?? {},
          score: 1,
        },
      };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'QUERY_ERROR') };
    }
  }

  async healthCheck(): Promise<Result<void, RagError>> {
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

  async upsert(
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    if (options?.signal?.aborted)
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    try {
      const { vector } = await this.embedder.embed(text, options);
      return this.upsertKnown(text, vector, metadata);
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'UPSERT_ERROR') };
    }
  }

  async upsertPrecomputed(
    text: string,
    vector: number[],
    metadata: RagMetadata,
  ): Promise<Result<void, RagError>> {
    return this.upsertKnown(text, vector, metadata);
  }

  private async upsertKnown(
    text: string,
    vector: number[],
    metadata: RagMetadata,
  ): Promise<Result<void, RagError>> {
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

  writer(): IRagBackendWriter {
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
