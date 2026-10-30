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
  matchesRagIdentity,
  matchesScanFilter,
  prepareList,
  RagError,
  type RagListPage,
  type RagListParams,
  type RagScanFilter,
  type RagScanPage,
  ragIdentityFilter,
} from '@mcp-abap-adt/llm-agent';
import type { HanaVectorRagConfig } from './connection.js';
import { resolveHanaConnectArgs } from './connection.js';
import { SHARED_LAYOUT_NOT_DEPLOYED } from './error-codes.js';
import { resolveHanaModule } from './hana-module.js';
import { resolveLayout } from './layout.js';
import { decodeLob, withId } from './lob.js';
import { RecordCache, type StoreCache } from './record-cache.js';
import { deleteWhere, scanPage } from './scan-delete.js';
import { assertCollectionName, quoteIdent } from './schema.js';
import { checkSharedTables } from './shared-check.js';
import { SHARED_DOCUMENTS_TABLE } from './shared-ddl.js';
import {
  type HanaStoreSql,
  perCollectionStoreSql,
  sharedStoreSql,
} from './store-sql.js';
import { hanaVectorLiteral } from './vector-literal.js';

export type { HanaVectorRagConfig };

export interface HanaClient {
  exec(sql: string, params?: readonly unknown[]): Promise<{ rowCount: number }>;
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<Array<Record<string, unknown>>>;
  close(): Promise<void>;
}

/**
 * `loadModule` is a seam for tests only; production code leaves it to the
 * default, which imports `@sap/hana-client`.
 */
export async function createHanaClient(
  cfg: HanaVectorRagConfig,
  loadModule: () => Promise<unknown> = () => import('@sap/hana-client'),
): Promise<HanaClient> {
  const args = await resolveHanaConnectArgs(cfg);
  const mod = resolveHanaModule(await loadModule());
  const conn = mod.createConnection();
  await new Promise<void>((resolve, reject) =>
    conn.connect(args, (err) => (err ? reject(err) : resolve())),
  );
  return {
    exec: (sql, params = []) =>
      new Promise((resolve, reject) =>
        conn.exec(sql, params as unknown[], (err, result) =>
          err
            ? reject(err)
            : resolve({
                rowCount:
                  typeof result === 'number'
                    ? result
                    : Array.isArray(result)
                      ? result.length
                      : 0,
              }),
        ),
      ),
    query: (sql, params = []) =>
      new Promise((resolve, reject) =>
        conn.exec(sql, params as unknown[], (err, rows) =>
          err
            ? reject(err)
            : resolve((rows as Array<Record<string, unknown>>) ?? []),
        ),
      ),
    close: () =>
      new Promise((resolve, reject) =>
        conn.disconnect((err) => (err ? reject(err) : resolve())),
      ),
  };
}

export class HanaVectorRag implements IRag, IRagScanner, IRagFilteredDeleter {
  private readonly cache: StoreCache;
  private readonly listStore: string;
  private listIdentity?: Promise<string>;
  private readonly listTable: string;
  private readonly dimension: number;
  private readonly embedder: IRetrievalEmbedder;
  private readonly autoCreateSchema: boolean;
  private readonly connectConfig: HanaVectorRagConfig;
  private readonly injectedClient?: HanaClient;
  private clientPromise?: Promise<HanaClient>;
  private schemaReady = false;
  private schemaPromise?: Promise<void>;
  private readonly sql: HanaStoreSql;
  private readonly documentsTable: string;
  private sharedCheck?: Promise<void>;

  constructor(
    config: HanaVectorRagConfig & { embedder: IRetrievalEmbedder },
    injectedClient?: HanaClient,
    cache?: StoreCache,
  ) {
    assertCollectionName(config.collectionName);
    this.dimension = config.dimension ?? 1536;
    this.embedder = config.embedder;
    this.listStore = JSON.stringify([
      'hana-vector-rag',
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
    this.sql = shared
      ? sharedStoreSql(config.collectionName, this.documentsTable)
      : perCollectionStoreSql(config.collectionName, this.dimension);
    this.listTable = quoteIdent(
      shared ? this.documentsTable : config.collectionName,
    );
    this.connectConfig = config;
    this.injectedClient = injectedClient;
  }

  /**
   * The connection, opened on first use — never in the constructor. A provider
   * hands out one handle per catalog record, and per-session hydration opens
   * every record for every session: a handle that connected when built would
   * open a connection per record per session whether it is used or not. A
   * failed connect is not kept, so the next use tries again.
   */
  private client(): Promise<HanaClient> {
    if (this.injectedClient) return Promise.resolve(this.injectedClient);
    this.clientPromise ??= createHanaClient(this.connectConfig).catch(
      (err: unknown) => {
        this.clientPromise = undefined;
        throw err;
      },
    );
    return this.clientPromise;
  }

  /**
   * Idempotent schema bootstrap. Called by both direct makeRag() consumers
   * (when autoCreateSchema is true) and HanaVectorRagProvider.createCollection().
   */
  async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    this.schemaPromise ??= (async () => {
      const client = await this.client();
      const ddl = this.sql.createTable();
      if (ddl !== undefined) await client.exec(ddl);
      this.schemaReady = true;
    })().catch((err: unknown) => {
      // Not kept: like client(), the next use tries again.
      this.schemaPromise = undefined;
      throw err;
    });
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
      const checked = await checkSharedTables(await this.client(), {
        schema: this.connectConfig.schema,
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
    return hanaVectorLiteral(
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
      const client = await this.client();
      const literal = this.vectorLiteral(vector);
      const base = this.sql.search(literal);
      const identity = ragIdentityFilter(options);
      const rawNamespace = options?.ragFilter?.namespace;
      const targetNamespace =
        typeof rawNamespace === 'string' ? rawNamespace : undefined;
      const nowSecs = Date.now() / 1000;
      // Every filter — the session/user scope, `ragFilter.namespace`, and
      // expiry (a numeric `metadata.ttl` in epoch seconds that is in the past)
      // — is applied HERE, in the client, with the same semantics as
      // VectorRag / QdrantRag / PgVectorRag. None of it has been verified
      // against a live HANA instance (none was available to test HANA's JSON
      // functions against). To stay correct without that:
      // - a scoped query (identity or namespace) selects every candidate by
      //   score with NO LIMIT and filters on the parsed metadata before taking
      //   the top k — never a LIMIT-then-filter, which would return fewer than
      //   k of the caller's own records. Correct, but it reads the whole table
      //   per scoped query; moving the filters into SQL needs a live instance;
      // - an unscoped query keeps the LIMIT query, and drops expired rows from
      //   it; only when that dropped a row from a FULL page (so an unexpired
      //   record may sit just below the cut) is it re-run without LIMIT.
      const limit = Math.max(1, k);
      const keep = (metadata: RagMetadata): boolean =>
        !(typeof metadata.ttl === 'number' && metadata.ttl < nowSecs) &&
        !(
          targetNamespace !== undefined &&
          metadata.namespace !== targetNamespace
        ) &&
        matchesRagIdentity(metadata, identity);
      const pick = (rows: Array<Record<string, unknown>>) => {
        const picked: RagResult[] = [];
        let dropped = false;
        for (const row of rows) {
          if (picked.length >= limit) break;
          const metadata = withId(row);
          if (!keep(metadata)) {
            dropped = true;
            continue;
          }
          picked.push({
            text: decodeLob(row.text),
            metadata,
            score: Number(row.score ?? 0),
          });
        }
        return { picked, dropped };
      };
      const scoped = identity !== undefined || targetNamespace !== undefined;
      let results: RagResult[];
      if (scoped) {
        results = pick(await client.query(base.sql, base.params)).picked;
      } else {
        const paged = this.sql.search(literal, limit);
        const page = await client.query(paged.sql, paged.params);
        const first = pick(page);
        results =
          first.dropped && page.length >= limit
            ? pick(await client.query(base.sql, base.params)).picked
            : first.picked;
      }
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
      const client = await this.client();
      if (options?.signal?.aborted) throw new RagError('Aborted', 'ABORTED');
      const stmt = this.sql.byId(id);
      const rows = await client.query(stmt.sql, stmt.params);
      if (options?.signal?.aborted) throw new RagError('Aborted', 'ABORTED');
      const row = rows[0];
      if (!row) return { ok: true, value: null };
      admitted = { text: decodeLob(row.text), metadata: withId(row), score: 1 };
      return { ok: true, value: admitted };
    } catch (err) {
      return { ok: false, error: this.scanFailure(err, 'QUERY_ERROR') };
    } finally {
      this.cache.endRead(id, lease, options?.ragFilter ? undefined : admitted);
    }
  }

  /** HANA statements use unqualified table names in the connection's current schema. */
  private resolvedListStore(): Promise<string> {
    this.listIdentity ??= (async () => {
      await this.maybeEnsureSchema();
      const client = await this.client();
      const rows = await client.query(
        `SELECT DATABASE_NAME AS "listDatabase", HOST AS "listHost", CURRENT_SCHEMA AS "listSchema" FROM SYS.M_DATABASE`,
      );
      const row = rows[0];
      if (
        !row ||
        typeof row.listDatabase !== 'string' ||
        typeof row.listSchema !== 'string' ||
        typeof row.listHost !== 'string'
      )
        throw new Error('Cannot resolve listing store identity');
      return JSON.stringify([
        this.listStore,
        row.listDatabase,
        row.listSchema,
        row.listHost,
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
      const client = await this.client();
      if (options?.signal?.aborted) throw new RagError('Aborted', 'ABORTED');
      const stmt = this.sql.listPage(
        after,
        limit,
        params.includeText ?? false,
        filter,
      );
      const rows = await client.query(stmt.sql, stmt.params);
      if (options?.signal?.aborted) throw new RagError('Aborted', 'ABORTED');
      const records: RagListPage['records'] = [];
      for (const row of rows) {
        const metadata = withId(row);
        if (!matchesScanFilter(metadata, filter)) continue;
        records.push({
          id: String(row.id),
          metadata: listMetadata(metadata),
          ...(params.includeText ? { text: decodeLob(row.text) } : {}),
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
      const client = await this.client();
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
      const client = await this.client();
      const deleted = await deleteWhere(
        client,
        this.sql,
        filter,
        options?.signal,
        this.cache,
      );
      return { ok: true, value: { deleted } };
    } catch (err) {
      return { ok: false, error: this.scanFailure(err, 'DELETE_ERROR') };
    }
  }

  async healthCheck(): Promise<Result<void, RagError>> {
    try {
      await this.ensureSharedDeployed();
      const client = await this.client();
      await client.query('SELECT 1 FROM DUMMY');
      return { ok: true, value: undefined };
    } catch (err) {
      return { ok: false, error: this.failure(err, 'HEALTH_CHECK_ERROR') };
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
      const client = await this.client();
      const id = metadata?.id ?? crypto.randomUUID();
      const { id: _omit, ...rest } = metadata ?? {};
      const metaJson = JSON.stringify(rest);
      const stmt = this.sql.upsert(literal, id, text, metaJson);
      const settled = this.cache.beginWrite([id]);
      try {
        await client.exec(stmt.sql, stmt.params);
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
          const client = await this.client();
          const stmt = this.sql.deleteById(id);
          const settled = this.cache.beginWrite([id]);
          let r: { rowCount: number };
          try {
            r = await client.exec(stmt.sql, stmt.params);
          } finally {
            settled();
          }
          return { ok: true, value: r.rowCount > 0 };
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
          const client = await this.client();
          const stmt = this.sql.clear();
          const settled = this.cache.beginClear();
          try {
            await client.exec(stmt.sql, stmt.params);
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
