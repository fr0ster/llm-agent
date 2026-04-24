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

export class HanaVectorRag implements IRag {
  private readonly collectionName: string;
  private readonly dimension: number;
  private readonly embedder: IEmbedder;
  private readonly autoCreateSchema: boolean;
  private readonly clientPromise: Promise<HanaClient>;
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
    // Attach a no-op catch so the eager import never becomes an unhandledRejection.
    // The rejection is re-thrown when clientPromise is actually awaited.
    const driverPromise = injectedClient
      ? Promise.resolve(injectedClient)
      : this.createDriverClient(config);
    driverPromise.catch(() => {});
    this.clientPromise = driverPromise;
  }

  private async createDriverClient(
    cfg: HanaVectorRagConfig,
  ): Promise<HanaClient> {
    const args = resolveHanaConnectArgs(cfg);
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

  /**
   * Idempotent schema bootstrap. Called by both direct makeRag() consumers
   * (when autoCreateSchema is true) and HanaVectorRagProvider.createCollection().
   */
  async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    this.schemaPromise ??= (async () => {
      const client = await this.clientPromise;
      await client.exec(createTableSql(this.collectionName, this.dimension));
      this.schemaReady = true;
    })();
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
      const client = await this.clientPromise;
      const table = quoteIdent(this.collectionName);
      const sql = `SELECT id, text, metadata, COSINE_SIMILARITY(vector, ${this.vectorLiteral(vector)}) AS score FROM ${table} ORDER BY score DESC LIMIT ${Math.max(1, k)}`;
      const rows = await client.query(sql);
      const results: RagResult[] = rows.map((row) => {
        const metaRaw = row.metadata as string | null | undefined;
        const metadata = metaRaw ? (JSON.parse(metaRaw) as RagMetadata) : {};
        return {
          text: String(row.text ?? ''),
          metadata,
          score: Number(row.score ?? 0),
        };
      });
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
      const rows = await client.query(
        `SELECT id, text, metadata FROM ${quoteIdent(this.collectionName)} WHERE id = ?`,
        [id],
      );
      const row = rows[0];
      if (!row) return { ok: true, value: null };
      const metaRaw = row.metadata as string | null | undefined;
      const metadata = metaRaw ? (JSON.parse(metaRaw) as RagMetadata) : {};
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
      const client = await this.clientPromise;
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
      const client = await this.clientPromise;
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
          const client = await this.clientPromise;
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
          const client = await this.clientPromise;
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
