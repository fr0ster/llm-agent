import type {
  CallOptions,
  IQueryEmbedding,
  IRag,
  IRagBackendWriter,
  IRetrievalEmbedder,
  RagMetadata,
  RagResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import {
  FallbackQueryEmbedding,
  RagError,
  ragIdentityFilter,
} from '@mcp-abap-adt/llm-agent';
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

/** Opens the pool a handle, or a provider's catalog work, talks through. */
export async function createPgClient(
  cfg: PgVectorRagConfig,
): Promise<PgClient> {
  const args = await resolvePgConnectArgs(cfg);
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

export class PgVectorRag implements IRag {
  private readonly collectionName: string;
  private readonly dimension: number;
  private readonly embedder: IRetrievalEmbedder;
  private readonly autoCreateSchema: boolean;
  private readonly clientPromise: Promise<PgClient>;
  private schemaReady = false;
  private schemaPromise?: Promise<void>;

  constructor(
    config: PgVectorRagConfig & { embedder: IRetrievalEmbedder },
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
      : createPgClient(config);
    driverPromise.catch(() => {});
    this.clientPromise = driverPromise;
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
      // The filters, as parameterised conditions on the jsonb metadata (never
      // interpolated) — the same contract VectorRag / QdrantRag apply:
      // - session/user scope: `->>` yields NULL for a missing key, and
      //   NULL = $n is not true, so an unowned row is excluded;
      // - `ragFilter.namespace`: the same, on `metadata.namespace`;
      // - expiry: a numeric `metadata.ttl` (epoch seconds) in the past drops
      //   the row; a missing or non-numeric ttl never expires. The CASE keeps
      //   the float8 cast away from a non-numeric value, which would fail the
      //   whole query.
      // The WHERE runs before ORDER BY … LIMIT: the table has no ANN index, so
      // the scan is exact and LIMIT counts only matching rows.
      const identity = ragIdentityFilter(options);
      const targetNamespace = options?.ragFilter?.namespace;
      const conditions: string[] = [];
      const params: Array<string | number> = [];
      if (identity?.sessionId !== undefined) {
        params.push(identity.sessionId);
        conditions.push(`metadata->>'sessionId' = $${params.length}`);
      }
      if (identity?.userId !== undefined) {
        params.push(identity.userId);
        conditions.push(`metadata->>'userId' = $${params.length}`);
      }
      if (typeof targetNamespace === 'string') {
        params.push(targetNamespace);
        conditions.push(`metadata->>'namespace' = $${params.length}`);
      }
      params.push(Date.now() / 1000);
      conditions.push(
        `COALESCE(CASE WHEN jsonb_typeof(metadata->'ttl') = 'number' THEN (metadata->>'ttl')::float8 END, 'infinity'::float8) >= $${params.length}`,
      );
      const where = ` WHERE ${conditions.join(' AND ')}`;
      const sql = `SELECT id, text, metadata, vector <=> ${lit} AS score FROM ${table}${where} ORDER BY vector <=> ${lit} LIMIT ${Math.max(1, k)}`;
      const { rows } = await client.query(sql, params);
      const results: RagResult[] = rows.map((row) => ({
        text: String(row.text ?? ''),
        metadata: withId(row),
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
          metadata: withId(row),
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
      const { vector } = await this.embedder.embedDocument(text, options);
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

/**
 * upsert keeps the id in its own column and out of the jsonb, so a read puts
 * it back: readers find a record's id in its metadata, as every other store
 * returns it (tool selection's toolNameFromRecord keys on it).
 */
function withId(row: Record<string, unknown>): RagMetadata {
  return { ...((row.metadata as RagMetadata) ?? {}), id: String(row.id) };
}
