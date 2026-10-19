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
  matchesRagIdentity,
  RagError,
  ragIdentityFilter,
} from '@mcp-abap-adt/llm-agent';
import type { HanaVectorRagConfig } from './connection.js';
import { resolveHanaConnectArgs } from './connection.js';
import { decodeLob } from './lob.js';
import { assertCollectionName } from './schema.js';
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

export async function createHanaClient(
  cfg: HanaVectorRagConfig,
): Promise<HanaClient> {
  const args = await resolveHanaConnectArgs(cfg);
  const mod = (await import('@sap/hana-client')) as unknown as {
    createConnection: () => {
      connect: (opts: unknown, cb: (err: Error | null) => void) => void;
      exec: (
        sql: string,
        params: unknown[],
        cb: (err: Error | null, rows: unknown) => void,
      ) => void;
      disconnect: (cb: (err: Error | null) => void) => void;
    };
  };
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

export class HanaVectorRag implements IRag {
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
  ) {
    assertCollectionName(config.collectionName);
    this.dimension = config.dimension ?? 1536;
    this.embedder = config.embedder;
    const shared = config.layout === 'shared';
    if (shared && config.autoCreateSchema === true) {
      throw new RagError(
        "autoCreateSchema: true is not allowed with layout: 'shared' — the shared tables are deployed outside the app",
        'INVALID_CONFIG',
      );
    }
    this.autoCreateSchema = config.autoCreateSchema ?? !shared;
    this.documentsTable = config.documentsTable ?? SHARED_DOCUMENTS_TABLE;
    this.sql = shared
      ? sharedStoreSql(config.collectionName, this.documentsTable)
      : perCollectionStoreSql(config.collectionName, this.dimension);
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
      (err.code === 'SHARED_LAYOUT_NOT_DEPLOYED' ||
        err.code === 'HEALTH_CHECK_ERROR')
      ? err
      : new RagError(String(err), code);
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
    try {
      await this.maybeEnsureSchema();
      const client = await this.client();
      const stmt = this.sql.byId(id);
      const rows = await client.query(stmt.sql, stmt.params);
      const row = rows[0];
      if (!row) return { ok: true, value: null };
      const metadata = withId(row);
      return {
        ok: true,
        value: { text: decodeLob(row.text), metadata, score: 1 },
      };
    } catch (err) {
      return { ok: false, error: this.failure(err, 'QUERY_ERROR') };
    }
  }

  async healthCheck(): Promise<Result<void, RagError>> {
    try {
      await this.ensureSharedDeployed();
      const client = await this.client();
      await client.query('SELECT 1 FROM DUMMY');
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
      await client.exec(stmt.sql, stmt.params);
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
          const r = await client.exec(stmt.sql, stmt.params);
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
          await client.exec(stmt.sql, stmt.params);
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

/**
 * upsert keeps the id in its own column and out of the JSON, so a read puts it
 * back: readers find a record's id in its metadata, as every other store
 * returns it (tool selection's toolNameFromRecord keys on it).
 */
function withId(row: Record<string, unknown>): RagMetadata {
  const raw = decodeLob(row.metadata);
  const parsed = raw ? (JSON.parse(raw) as RagMetadata) : {};
  return { ...parsed, id: String(row.id) };
}
