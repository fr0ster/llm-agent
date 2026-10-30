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
  decodeListCursor,
  encodeListCursor,
  FallbackQueryEmbedding,
  INVALID_ARGUMENT,
  type IRagFilteredDeleter,
  type IRagScanner,
  listCursorScope,
  listMetadata,
  matchesScanFilter,
  prepareList,
  RagError,
  type RagListPage,
  type RagListParams,
  type RagScanFilter,
  type RagScanPage,
  ragIdentityFilter,
} from '@mcp-abap-adt/llm-agent';
import type { PgVectorRagConfig } from './connection.js';
import { resolvePgConnectArgs } from './connection.js';
import { SHARED_LAYOUT_NOT_DEPLOYED } from './error-codes.js';
import { resolveLayout } from './layout.js';
import { RecordCache, type StoreCache } from './record-cache.js';
import { deleteWhere, scanPage } from './scan-delete.js';
import {
  assertCollectionName,
  createExtensionSql,
  qualifiedTable,
} from './schema.js';
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
  transaction?<T>(work: (client: PgClient) => Promise<T>): Promise<T>;
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }>;
  end(): Promise<void>;
}

interface PgPool {
  connect(): Promise<{ query: PgClient['query']; release(): void }>;
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
    transaction: async (work) => {
      const connection = await pool.connect();
      const client: PgClient = {
        query: (sql, params) => connection.query(sql, params),
        end: async () => {},
      };
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* Preserve the original failure. */
        }
        throw error;
      } finally {
        connection.release();
      }
    },
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
  private readonly cache: StoreCache;
  private readonly listStore: string;
  private listIdentity?: Promise<string>;
  private readonly listTable: string;
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
    cache?: StoreCache,
  ) {
    assertCollectionName(config.collectionName);
    this.dimension = config.dimension ?? 1536;
    this.embedder = config.embedder;
    this.listStore = JSON.stringify([
      'pg-vector-rag',
      config.layout ?? 'per-collection',
      config.documentsTable ?? null,
      config.collectionName,
    ]);
    this.cache =
      cache ?? new RecordCache(config.recordCache).store(this.listStore);
    const shared =
      resolveLayout(config.layout, config.autoCreateSchema) === 'shared';
    this.autoCreateSchema = config.autoCreateSchema ?? !shared;
    this.documentsTable = config.documentsTable ?? SHARED_DOCUMENTS_TABLE;
    this.schema = config.schema;
    this.listTable = shared
      ? qualifiedTable(this.documentsTable, config.schema)
      : qualifiedTable(config.collectionName);
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
    const cached = options?.ragFilter ? undefined : this.cache.get(id);
    if (cached) return { ok: true, value: cached };
    const lease = this.cache.beginRead(id);
    let admitted: RagResult | undefined;
    try {
      await this.maybeEnsureSchema();
      const client = await this.clientPromise;
      if (options?.signal?.aborted) throw new RagError('Aborted', 'ABORTED');
      const stmt = this.sql.byId(id);
      const { rows } = await client.query(stmt.sql, stmt.params);
      if (options?.signal?.aborted) throw new RagError('Aborted', 'ABORTED');
      const row = rows[0];
      if (!row) return { ok: true, value: null };
      admitted = {
        text: String(row.text ?? ''),
        metadata: withId(row),
        score: 1,
      };
      return { ok: true, value: admitted };
    } catch (err) {
      return { ok: false, error: this.scanFailure(err, 'QUERY_ERROR') };
    } finally {
      this.cache.endRead(id, lease, options?.ragFilter ? undefined : admitted);
    }
  }

  /** Resolve search_path and connection defaults once per handle. */
  private resolvedListStore(): Promise<string> {
    this.listIdentity ??= (async () => {
      await this.maybeEnsureSchema();
      const client = await this.clientPromise;
      const { rows } = await client.query(
        `SELECT current_database() AS "listDatabase", n.nspname AS "listSchema",
          inet_server_addr()::text AS "listHost", inet_server_port() AS "listPort"
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.oid = to_regclass($1)`,
        [this.listTable],
      );
      const row = rows[0];
      if (
        !row ||
        typeof row.listDatabase !== 'string' ||
        typeof row.listSchema !== 'string' ||
        (row.listHost !== null && typeof row.listHost !== 'string') ||
        (row.listPort !== null && typeof row.listPort !== 'number')
      )
        throw new Error('Cannot resolve listing store identity');
      return JSON.stringify([
        this.listStore,
        row.listDatabase,
        row.listSchema,
        row.listHost,
        row.listPort,
        this.listTable,
      ]);
    })().catch((error: unknown) => {
      this.listIdentity = undefined;
      throw error instanceof Error ? error : new Error(String(error));
    });
    return this.listIdentity;
  }

  async list(
    params: RagListParams = {},
    options?: CallOptions,
  ): Promise<Result<RagListPage, RagError>> {
    try {
      const { filter, conflict, limit } = prepareList(params, options);
      if (options?.signal?.aborted) throw new RagError('Aborted', 'ABORTED');
      const store = await this.resolvedListStore();
      if (options?.signal?.aborted) throw new RagError('Aborted', 'ABORTED');
      const scope = listCursorScope(store, filter, conflict);
      const after =
        params.cursor === undefined
          ? undefined
          : decodeListCursor(scope, params.cursor);
      if (conflict) return { ok: true, value: { records: [] } };
      await this.maybeEnsureSchema();
      const client = await this.clientPromise;
      if (options?.signal?.aborted) throw new RagError('Aborted', 'ABORTED');
      const stmt = this.sql.listPage(
        after,
        limit,
        params.includeText ?? false,
        filter,
      );
      const { rows } = await client.query(stmt.sql, stmt.params);
      if (options?.signal?.aborted) throw new RagError('Aborted', 'ABORTED');
      const records: RagListPage['records'] = [];
      for (const row of rows) {
        const metadata = withId(row);
        if (!matchesScanFilter(metadata, filter)) continue;
        records.push({
          id: String(row.id),
          metadata: listMetadata(metadata),
          ...(params.includeText ? { text: String(row.text ?? '') } : {}),
        });
      }
      const last = rows[rows.length - 1];
      return {
        ok: true,
        value: {
          records,
          ...(last && rows.length === limit
            ? { cursor: encodeListCursor(scope, String(last.id)) }
            : {}),
        },
      };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof RagError
            ? error
            : this.failure(error, 'QUERY_ERROR'),
      };
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
      const deleted = await deleteWhere(
        client,
        this.sql,
        filter,
        this.cache,
        options?.signal,
      );
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
      const settled = this.cache.beginWrite([id]);
      try {
        await client.query(stmt.sql, stmt.params);
      } finally {
        settled();
      }
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
          const settled = this.cache.beginWrite([id]);
          let res: { rowCount: number };
          try {
            res = await client.query(stmt.sql, stmt.params);
          } finally {
            settled();
          }
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
          const settled = this.cache.beginClear();
          try {
            await client.query(stmt.sql, stmt.params);
          } finally {
            settled();
          }
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
