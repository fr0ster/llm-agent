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
  assertNonEmptyFilter,
  assertScanOptions,
  decodeIdScanCursor,
  FallbackQueryEmbedding,
  INVALID_ARGUMENT,
  type IRagFilteredDeleter,
  type IRagScanner,
  RagError,
  type RagScanFilter,
  type RagScanPage,
  ragIdentityFilter,
} from '@mcp-abap-adt/llm-agent';
import type { PgVectorRagConfig } from './connection.js';
import { resolvePgConnectArgs } from './connection.js';
import { SHARED_LAYOUT_NOT_DEPLOYED } from './error-codes.js';
import { resolveLayout } from './layout.js';
import { deleteWhere, scanPage } from './scan-delete.js';
import { assertCollectionName, createExtensionSql } from './schema.js';
import { checkSharedTables } from './shared-check.js';
import { SHARED_DOCUMENTS_TABLE } from './shared-ddl.js';
import {
  type PgStoreSql,
  perCollectionStoreSql,
  sharedStoreSql,
} from './store-sql.js';
import { pgVectorLiteral } from './vector-literal.js';
import { withId } from './with-id.js';

export type { PgVectorRagConfig };

export interface PgClient {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }>;
  end(): Promise<void>;
}

interface PgPool {
  query: PgClient['query'];
  end: () => Promise<void>;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/**
 * Wraps a `pg` Pool as a `PgClient`. `pg` emits `'error'` on the pool when an
 * idle client fails (database restart, cut connection); an `EventEmitter`
 * without a listener turns that into an uncaught exception that kills the
 * process. The listener never throws: pg drops the broken idle client itself,
 * and the next query goes through the normal Result path (it may reconnect and
 * succeed, or fail; it does not necessarily report the earlier error).
 */
export function openPgClient(
  PoolCtor: new (a: unknown) => PgPool,
  args: unknown,
  onPoolError?: (err: Error) => void | Promise<void>,
): PgClient {
  const pool = new PoolCtor(args);
  pool.on('error', (err) => {
    try {
      const out: unknown = onPoolError?.(err);
      // an async reporter may reject; a discarded rejection would end the process
      if (out && typeof (out as PromiseLike<void>).then === 'function') {
        Promise.resolve(out).catch(() => {});
      }
    } catch {
      // a reporter must never take the process down
    }
  });
  return {
    query: (sql, params = []) => pool.query(sql, params as unknown[]),
    end: () => pool.end(),
  };
}

/** Opens the pool a handle, or a provider's catalog work, talks through. */
export async function createPgClient(
  cfg: PgVectorRagConfig,
): Promise<PgClient> {
  const args = await resolvePgConnectArgs(cfg);
  const mod = (await import('pg')) as unknown as {
    default?: { Pool: new (a: unknown) => PgPool };
    Pool?: new (a: unknown) => PgPool;
  };
  const PoolCtor = mod.Pool ?? mod.default?.Pool;
  if (!PoolCtor) throw new Error('pg module did not expose Pool');
  return openPgClient(PoolCtor, args, cfg.onPoolError);
}

export class PgVectorRag implements IRag, IRagScanner, IRagFilteredDeleter {
  private readonly dimension: number;
  private readonly embedder: IRetrievalEmbedder;
  private readonly autoCreateSchema: boolean;
  private readonly clientPromise: Promise<PgClient>;
  private schemaReady = false;
  private schemaPromise?: Promise<void>;
  private readonly sql: PgStoreSql;
  private readonly documentsTable: string;
  private readonly schema?: string;
  private sharedCheck?: Promise<void>;

  constructor(
    config: PgVectorRagConfig & { embedder: IRetrievalEmbedder },
    injectedClient?: PgClient,
  ) {
    assertCollectionName(config.collectionName);
    this.dimension = config.dimension ?? 1536;
    this.embedder = config.embedder;
    const shared =
      resolveLayout(config.layout, config.autoCreateSchema) === 'shared';
    this.autoCreateSchema = config.autoCreateSchema ?? !shared;
    this.documentsTable = config.documentsTable ?? SHARED_DOCUMENTS_TABLE;
    this.schema = config.schema;
    this.sql = shared
      ? sharedStoreSql(
          config.collectionName,
          this.documentsTable,
          config.schema,
        )
      : perCollectionStoreSql(config.collectionName, this.dimension);
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
      const ddl = this.sql.createTable();
      if (ddl !== undefined) {
        await client.query(createExtensionSql());
        await client.query(ddl);
      }
      this.schemaReady = true;
    })();
    await this.schemaPromise;
  }

  private async maybeEnsureSchema(): Promise<void> {
    if (this.autoCreateSchema) await this.ensureSchema();
    await this.ensureSharedDeployed();
  }

  /** `shared` only: the tables are deployed with the right dimension. A success is kept, a failure is not. */
  private async ensureSharedDeployed(): Promise<void> {
    if (this.sql.layout !== 'shared') return;
    this.sharedCheck ??= (async () => {
      const checked = await checkSharedTables(await this.clientPromise, {
        schema: this.schema,
        tables: [this.documentsTable],
        documentsTable: this.documentsTable,
        dimension: this.dimension,
      });
      if (!checked.ok) throw checked.error;
    })().catch((err: unknown) => {
      this.sharedCheck = undefined;
      throw err;
    });
    await this.sharedCheck;
  }

  /** The shared check's own error reaches the caller as is; anything else is wrapped in `code`. */
  private failure(err: unknown, code: string): RagError {
    return err instanceof RagError &&
      (err.code === SHARED_LAYOUT_NOT_DEPLOYED ||
        err.code === 'HEALTH_CHECK_ERROR')
      ? err
      : new RagError(String(err), code);
  }

  /** `failure` for `scan` / `deleteWhere`, which also pass `ABORTED` through. */
  private scanFailure(err: unknown, code: string): RagError {
    return err instanceof RagError && err.code === 'ABORTED'
      ? err
      : this.failure(err, code);
  }

  private vectorLiteral(vec: number[]): string {
    return pgVectorLiteral(
      vec,
      this.sql.layout === 'shared' ? this.dimension : undefined,
    );
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
      const lit = this.vectorLiteral(vector);
      const rawNamespace = options?.ragFilter?.namespace;
      // Session/user scope, `ragFilter.namespace` and expiry are conditions of
      // the SQL itself (see store-sql.ts), evaluated before ORDER BY … LIMIT:
      // the table has no ANN index, so the scan is exact and LIMIT counts only
      // matching rows.
      const { sql, params } = this.sql.search(lit, Math.max(1, k), {
        identity: ragIdentityFilter(options),
        namespace: typeof rawNamespace === 'string' ? rawNamespace : undefined,
        nowSecs: Date.now() / 1000,
      });
      const { rows } = await client.query(sql, params);
      const results: RagResult[] = rows.map((row) => ({
        text: String(row.text ?? ''),
        metadata: withId(row),
        score: 1 - Number(row.score ?? 0),
      }));
      return { ok: true, value: results };
    } catch (err) {
      return { ok: false, error: this.failure(err, 'QUERY_ERROR') };
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
      const stmt = this.sql.byId(id);
      const { rows } = await client.query(stmt.sql, stmt.params);
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
      return { ok: false, error: this.failure(err, 'QUERY_ERROR') };
    }
  }

  async scan(
    opts?: { filter?: RagScanFilter; pageSize?: number; cursor?: string },
    options?: CallOptions,
  ): Promise<Result<RagScanPage, RagError>> {
    if (options?.signal?.aborted)
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    const valid = assertScanOptions(opts);
    if (!valid.ok) return valid;
    if (
      opts?.cursor !== undefined &&
      decodeIdScanCursor(opts.cursor) === undefined
    )
      return {
        ok: false,
        error: new RagError('Invalid scan cursor', INVALID_ARGUMENT),
      };
    try {
      await this.maybeEnsureSchema();
      const client = await this.clientPromise;
      return { ok: true, value: await scanPage(client, this.sql, opts) };
    } catch (err) {
      return { ok: false, error: this.scanFailure(err, 'QUERY_ERROR') };
    }
  }

  async deleteWhere(
    filter: RagScanFilter,
    options?: CallOptions,
  ): Promise<Result<{ deleted: number }, RagError>> {
    if (options?.signal?.aborted)
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    const valid = assertNonEmptyFilter(filter);
    if (!valid.ok) return valid;
    try {
      await this.maybeEnsureSchema();
      const client = await this.clientPromise;
      // One statement: an abort cannot land inside it, so it is checked here.
      if (options?.signal?.aborted)
        return {
          ok: false,
          error: new RagError('Aborted after deleting 0 record(s)', 'ABORTED'),
        };
      const deleted = await deleteWhere(client, this.sql, filter);
      return { ok: true, value: { deleted } };
    } catch (err) {
      return { ok: false, error: this.scanFailure(err, 'DELETE_ERROR') };
    }
  }

  async healthCheck(): Promise<Result<void, RagError>> {
    try {
      await this.ensureSharedDeployed();
      const client = await this.clientPromise;
      await client.query('SELECT 1');
      return { ok: true, value: undefined };
    } catch (err) {
      return {
        ok: false,
        error: this.failure(err, 'HEALTH_CHECK_ERROR'),
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
      return { ok: false, error: this.failure(err, 'UPSERT_ERROR') };
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
      const literal = this.vectorLiteral(vector);
      await this.maybeEnsureSchema();
      const client = await this.clientPromise;
      const id = metadata?.id ?? crypto.randomUUID();
      const { id: _omit, ...rest } = metadata ?? {};
      const stmt = this.sql.upsert(literal, id, text, JSON.stringify(rest));
      await client.query(stmt.sql, stmt.params);
      return { ok: true, value: undefined };
    } catch (err) {
      return { ok: false, error: this.failure(err, 'UPSERT_ERROR') };
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
          const stmt = this.sql.deleteById(id);
          const res = await client.query(stmt.sql, stmt.params);
          return { ok: true, value: res.rowCount > 0 };
        } catch (err) {
          return {
            ok: false,
            error: this.failure(err, 'DELETE_ERROR'),
          };
        }
      },
      clearAll: async () => {
        try {
          await this.maybeEnsureSchema();
          const client = await this.clientPromise;
          const stmt = this.sql.clear();
          await client.query(stmt.sql, stmt.params);
          return { ok: true, value: undefined };
        } catch (err) {
          return { ok: false, error: this.failure(err, 'CLEAR_ERROR') };
        }
      },
      upsertPrecomputedRaw: async (id, text, vector, metadata) =>
        this.upsertPrecomputed(text, vector, { ...metadata, id }),
    };
  }
}
