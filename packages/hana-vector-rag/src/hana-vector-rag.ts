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
import {
  FallbackQueryEmbedding,
  matchesRagIdentity,
  RagError,
  ragIdentityFilter,
} from '@mcp-abap-adt/llm-agent';
import type { HanaVectorRagConfig } from './connection.js';
import { resolveHanaConnectArgs } from './connection.js';
import { assertCollectionName, createTableSql, quoteIdent } from './schema.js';

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
  private readonly collectionName: string;
  private readonly dimension: number;
  private readonly embedder: IEmbedder;
  private readonly autoCreateSchema: boolean;
  private readonly connectConfig: HanaVectorRagConfig;
  private readonly injectedClient?: HanaClient;
  private clientPromise?: Promise<HanaClient>;
  private schemaReady = false;
  private schemaPromise?: Promise<void>;

  constructor(
    config: HanaVectorRagConfig & { embedder: IEmbedder },
    injectedClient?: HanaClient,
  ) {
    assertCollectionName(config.collectionName);
    this.collectionName = config.collectionName;
    this.dimension = config.dimension ?? 1536;
    this.embedder = config.embedder;
    this.autoCreateSchema = config.autoCreateSchema ?? true;
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
      await client.exec(createTableSql(this.collectionName, this.dimension));
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
  }

  private vectorLiteral(vec: number[]): string {
    return `TO_REAL_VECTOR('[${vec.join(',')}]')`;
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
      const table = quoteIdent(this.collectionName);
      const base = `SELECT id, text, metadata, COSINE_SIMILARITY(vector, ${this.vectorLiteral(vector)}) AS score FROM ${table} ORDER BY score DESC`;
      const identity = ragIdentityFilter(options);
      // The session/user scope is applied HERE, in the client, and has NOT
      // been verified against a live HANA instance (none was available to
      // test HANA's JSON functions against). To stay correct without that,
      // a scoped query selects every candidate by score with NO LIMIT and
      // filters on the parsed metadata before taking the top k — never a
      // LIMIT-then-filter, which would return fewer than k of the caller's
      // own records. Correct, but it reads the whole table per scoped query;
      // moving the filter into SQL needs a live instance to verify on. An
      // unscoped query keeps the LIMIT query.
      const limit = Math.max(1, k);
      const sql = identity ? base : `${base} LIMIT ${limit}`;
      const rows = await client.query(sql);
      const results: RagResult[] = [];
      for (const row of rows) {
        if (results.length >= limit) break;
        const metadata = withId(row);
        if (!matchesRagIdentity(metadata, identity)) continue;
        results.push({
          text: String(row.text ?? ''),
          metadata,
          score: Number(row.score ?? 0),
        });
      }
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
      const client = await this.client();
      const rows = await client.query(
        `SELECT id, text, metadata FROM ${quoteIdent(this.collectionName)} WHERE id = ?`,
        [id],
      );
      const row = rows[0];
      if (!row) return { ok: true, value: null };
      const metadata = withId(row);
      return {
        ok: true,
        value: { text: String(row.text ?? ''), metadata, score: 1 },
      };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'QUERY_ERROR') };
    }
  }

  async healthCheck(): Promise<Result<void, RagError>> {
    try {
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
      const client = await this.client();
      const id = metadata?.id ?? crypto.randomUUID();
      const { id: _omit, ...rest } = metadata ?? {};
      const metaJson = JSON.stringify(rest);
      const sql = `UPSERT ${quoteIdent(this.collectionName)} (id, text, vector, metadata) VALUES (?, ?, ${this.vectorLiteral(vector)}, ?) WITH PRIMARY KEY`;
      await client.exec(sql, [id, text, metaJson]);
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
          const client = await this.client();
          const r = await client.exec(
            `DELETE FROM ${quoteIdent(this.collectionName)} WHERE id = ?`,
            [id],
          );
          return { ok: true, value: r.rowCount > 0 };
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
          const client = await this.client();
          await client.exec(
            `TRUNCATE TABLE ${quoteIdent(this.collectionName)}`,
          );
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
 * upsert keeps the id in its own column and out of the JSON, so a read puts it
 * back: readers find a record's id in its metadata, as every other store
 * returns it (tool selection's toolNameFromRecord keys on it).
 */
function withId(row: Record<string, unknown>): RagMetadata {
  const raw = row.metadata as string | null | undefined;
  const parsed = raw ? (JSON.parse(raw) as RagMetadata) : {};
  return { ...parsed, id: String(row.id) };
}
