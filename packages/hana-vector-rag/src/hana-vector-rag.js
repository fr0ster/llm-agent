import { FallbackQueryEmbedding, RagError } from '@mcp-abap-adt/llm-agent';
import { resolveHanaConnectArgs } from './connection.js';
import { assertCollectionName, createTableSql, quoteIdent } from './schema.js';
export class HanaVectorRag {
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
        driverPromise.catch(() => { });
        this.clientPromise = driverPromise;
    }
    async createDriverClient(cfg) {
        const args = resolveHanaConnectArgs(cfg);
        const mod = (await import('@sap/hana-client'));
        const conn = mod.createConnection();
        await new Promise((resolve, reject) => conn.connect(args, (err) => (err ? reject(err) : resolve())));
        return {
            exec: (sql, params = []) => new Promise((resolve, reject) => conn.exec(sql, params, (err, result) => err
                ? reject(err)
                : resolve({
                    rowCount: typeof result === 'number'
                        ? result
                        : Array.isArray(result)
                            ? result.length
                            : 0,
                }))),
            query: (sql, params = []) => new Promise((resolve, reject) => conn.exec(sql, params, (err, rows) => err
                ? reject(err)
                : resolve(rows ?? []))),
            close: () => new Promise((resolve, reject) => conn.disconnect((err) => (err ? reject(err) : resolve()))),
        };
    }
    /**
     * Idempotent schema bootstrap. Called by both direct makeRag() consumers
     * (when autoCreateSchema is true) and HanaVectorRagProvider.createCollection().
     */
    async ensureSchema() {
        if (this.schemaReady)
            return;
        this.schemaPromise ??= (async () => {
            const client = await this.clientPromise;
            await client.exec(createTableSql(this.collectionName, this.dimension));
            this.schemaReady = true;
        })();
        await this.schemaPromise;
    }
    async maybeEnsureSchema() {
        if (this.autoCreateSchema)
            await this.ensureSchema();
    }
    vectorLiteral(vec) {
        return `TO_REAL_VECTOR('[${vec.join(',')}]')`;
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
            const sql = `SELECT id, text, metadata, COSINE_SIMILARITY(vector, ${this.vectorLiteral(vector)}) AS score FROM ${table} ORDER BY score DESC LIMIT ${Math.max(1, k)}`;
            const rows = await client.query(sql);
            const results = rows.map((row) => {
                const metaRaw = row.metadata;
                const metadata = metaRaw ? JSON.parse(metaRaw) : {};
                return {
                    text: String(row.text ?? ''),
                    metadata,
                    score: Number(row.score ?? 0),
                };
            });
            return { ok: true, value: results };
        }
        catch (err) {
            return { ok: false, error: new RagError(String(err), 'QUERY_ERROR') };
        }
    }
    async getById(id, options) {
        if (options?.signal?.aborted)
            return { ok: false, error: new RagError('Aborted', 'ABORTED') };
        try {
            await this.maybeEnsureSchema();
            const client = await this.clientPromise;
            const rows = await client.query(`SELECT id, text, metadata FROM ${quoteIdent(this.collectionName)} WHERE id = ?`, [id]);
            const row = rows[0];
            if (!row)
                return { ok: true, value: null };
            const metaRaw = row.metadata;
            const metadata = metaRaw ? JSON.parse(metaRaw) : {};
            return {
                ok: true,
                value: { text: String(row.text ?? ''), metadata, score: 1 },
            };
        }
        catch (err) {
            return { ok: false, error: new RagError(String(err), 'QUERY_ERROR') };
        }
    }
    async healthCheck() {
        try {
            const client = await this.clientPromise;
            await client.query('SELECT 1 FROM DUMMY');
            return { ok: true, value: undefined };
        }
        catch (err) {
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
        }
        catch (err) {
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
            const metaJson = JSON.stringify(rest);
            const sql = `UPSERT ${quoteIdent(this.collectionName)} (id, text, vector, metadata) VALUES (?, ?, ${this.vectorLiteral(vector)}, ?) WITH PRIMARY KEY`;
            await client.exec(sql, [id, text, metaJson]);
            return { ok: true, value: undefined };
        }
        catch (err) {
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
                    const r = await client.exec(`DELETE FROM ${quoteIdent(this.collectionName)} WHERE id = ?`, [id]);
                    return { ok: true, value: r.rowCount > 0 };
                }
                catch (err) {
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
                    await client.exec(`TRUNCATE TABLE ${quoteIdent(this.collectionName)}`);
                    return { ok: true, value: undefined };
                }
                catch (err) {
                    return { ok: false, error: new RagError(String(err), 'CLEAR_ERROR') };
                }
            },
            upsertPrecomputedRaw: async (id, text, vector, metadata) => this.upsertPrecomputed(text, vector, { ...metadata, id }),
        };
    }
}
//# sourceMappingURL=hana-vector-rag.js.map