import { FallbackQueryEmbedding, RagError, } from '@mcp-abap-adt/llm-agent';
/**
 * Derive a deterministic UUID from a stable string key using SHA-256.
 * The first 16 bytes of the hash are formatted as a UUID v5-style string.
 */
async function deterministicUUID(key) {
    const data = new TextEncoder().encode(key);
    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(hashBuffer, 0, 16);
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
export class QdrantRag {
    url;
    collectionName;
    embedder;
    apiKey;
    timeoutMs;
    collectionEnsured = false;
    constructor(config) {
        this.url = config.url.replace(/\/+$/, '');
        this.collectionName = config.collectionName;
        this.embedder = config.embedder;
        this.apiKey = config.apiKey;
        this.timeoutMs = config.timeoutMs ?? 30_000;
    }
    _headers() {
        const h = { 'Content-Type': 'application/json' };
        if (this.apiKey)
            h['api-key'] = this.apiKey;
        return h;
    }
    async _fetch(path, init, signal) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
        if (signal) {
            signal.addEventListener('abort', () => ctrl.abort(signal.reason), {
                once: true,
            });
        }
        try {
            return await fetch(`${this.url}${path}`, {
                ...init,
                signal: ctrl.signal,
                headers: { ...this._headers(), ...(init.headers ?? {}) },
            });
        }
        finally {
            clearTimeout(timer);
        }
    }
    async _ensureCollection(vectorSize, signal) {
        if (this.collectionEnsured)
            return;
        const res = await this._fetch(`/collections/${this.collectionName}`, { method: 'GET' }, signal);
        if (res.ok) {
            // Collection exists — verify the embedder dimension matches.
            // Qdrant collections have a fixed vectors.size set at creation time;
            // upserts with a different vector length are silently dropped.
            // Fail fast so the operator can either delete the stale collection
            // or point this RAG store at a collection matching the current embedder.
            try {
                const body = (await res.json());
                const existingSize = body.result?.config?.params?.vectors?.size;
                if (typeof existingSize === 'number' && existingSize !== vectorSize) {
                    throw new RagError(`Qdrant collection "${this.collectionName}" has vectors.size=${existingSize} but the current embedder produces ${vectorSize}-dim vectors. ` +
                        'The collection was created for a different embedding model. ' +
                        'Either drop and recreate the collection, or point this RAG store at a collection matching the current embedder.', 'UPSERT_ERROR');
                }
            }
            catch (err) {
                if (err instanceof RagError)
                    throw err;
                // JSON parsing or transient read failures — let the next upsert surface them naturally.
            }
            this.collectionEnsured = true;
            return;
        }
        // Collection doesn't exist — create it
        const createRes = await this._fetch(`/collections/${this.collectionName}`, {
            method: 'PUT',
            body: JSON.stringify({
                vectors: { size: vectorSize, distance: 'Cosine' },
            }),
        }, signal);
        if (!createRes.ok) {
            const text = await createRes.text();
            throw new RagError(`Failed to create collection: ${text}`, 'UPSERT_ERROR');
        }
        this.collectionEnsured = true;
    }
    async upsertKnownVector(text, vector, metadata, options) {
        try {
            await this._ensureCollection(vector.length, options?.signal);
            const pointId = metadata?.id
                ? await deterministicUUID(metadata.id)
                : crypto.randomUUID();
            const payload = {
                text,
                ...metadata,
            };
            const res = await this._fetch(`/collections/${this.collectionName}/points`, {
                method: 'PUT',
                body: JSON.stringify({
                    points: [{ id: pointId, vector, payload }],
                }),
            }, options?.signal);
            if (!res.ok) {
                const body = await res.text();
                return {
                    ok: false,
                    error: new RagError(`Qdrant upsert failed: ${body}`, 'UPSERT_ERROR'),
                };
            }
            return { ok: true, value: undefined };
        }
        catch (err) {
            if (err instanceof RagError)
                return { ok: false, error: err };
            return { ok: false, error: new RagError(String(err), 'UPSERT_ERROR') };
        }
    }
    async upsert(text, metadata, options) {
        if (options?.signal?.aborted) {
            return { ok: false, error: new RagError('Aborted', 'ABORTED') };
        }
        try {
            const { vector } = await this.embedder.embed(text, options);
            return this.upsertKnownVector(text, vector, metadata, options);
        }
        catch (err) {
            if (err instanceof RagError)
                return { ok: false, error: err };
            return { ok: false, error: new RagError(String(err), 'UPSERT_ERROR') };
        }
    }
    async upsertPrecomputed(text, vector, metadata, options) {
        if (options?.signal?.aborted) {
            return { ok: false, error: new RagError('Aborted', 'ABORTED') };
        }
        return this.upsertKnownVector(text, vector, metadata, options);
    }
    async query(embedding, k, options) {
        if (options?.signal?.aborted) {
            return { ok: false, error: new RagError('Aborted', 'ABORTED') };
        }
        try {
            const safe = new FallbackQueryEmbedding(embedding, this.embedder);
            const vector = await safe.toVector();
            const must = [];
            const targetNamespace = options?.ragFilter?.namespace;
            if (targetNamespace !== undefined) {
                must.push({ key: 'namespace', match: { value: targetNamespace } });
            }
            const nowSecs = Math.floor(Date.now() / 1000);
            must.push({ key: 'ttl', range: { gt: nowSecs } });
            const body = {
                vector,
                limit: k,
                with_payload: true,
            };
            if (must.length > 0) {
                body.filter = {
                    should: [
                        { must },
                        // Also match points without TTL set (no ttl field)
                        {
                            must_not: [{ key: 'ttl', range: { gte: 0 } }],
                            ...(targetNamespace !== undefined
                                ? {
                                    must: [
                                        { key: 'namespace', match: { value: targetNamespace } },
                                    ],
                                }
                                : {}),
                        },
                    ],
                };
            }
            const res = await this._fetch(`/collections/${this.collectionName}/points/search`, { method: 'POST', body: JSON.stringify(body) }, options?.signal);
            if (!res.ok) {
                const errBody = await res.text();
                return {
                    ok: false,
                    error: new RagError(`Qdrant query failed: ${errBody}`, 'QUERY_ERROR'),
                };
            }
            const json = (await res.json());
            const results = (json.result ?? []).map((hit) => {
                const { text: hitText, ...rest } = hit.payload;
                return {
                    text: String(hitText ?? ''),
                    metadata: rest,
                    score: hit.score,
                };
            });
            return { ok: true, value: results };
        }
        catch (err) {
            if (err instanceof RagError)
                return { ok: false, error: err };
            return { ok: false, error: new RagError(String(err), 'QUERY_ERROR') };
        }
    }
    async getById(id, options) {
        if (options?.signal?.aborted) {
            return { ok: false, error: new RagError('Aborted', 'ABORTED') };
        }
        try {
            const pointId = await deterministicUUID(id);
            const res = await this._fetch(`/collections/${this.collectionName}/points`, {
                method: 'POST',
                body: JSON.stringify({ ids: [pointId], with_payload: true }),
            }, options?.signal);
            if (!res.ok) {
                const body = await res.text();
                return {
                    ok: false,
                    error: new RagError(`Qdrant retrieve failed: ${body}`, 'QUERY_ERROR'),
                };
            }
            const json = (await res.json());
            const hit = json.result?.[0];
            if (!hit)
                return { ok: true, value: null };
            const { text: hitText, ...rest } = hit.payload;
            return {
                ok: true,
                value: {
                    text: String(hitText ?? ''),
                    metadata: rest,
                    score: 1,
                },
            };
        }
        catch (err) {
            if (err instanceof RagError)
                return { ok: false, error: err };
            return { ok: false, error: new RagError(String(err), 'QUERY_ERROR') };
        }
    }
    async healthCheck(options) {
        try {
            const res = await this._fetch(`/collections/${this.collectionName}`, { method: 'GET' }, options?.signal);
            if (!res.ok) {
                return {
                    ok: false,
                    error: new RagError(`Qdrant collection not accessible: HTTP ${res.status}`, 'HEALTH_CHECK_ERROR'),
                };
            }
            return { ok: true, value: undefined };
        }
        catch (err) {
            return {
                ok: false,
                error: new RagError(`Qdrant health check failed: ${String(err)}`, 'HEALTH_CHECK_ERROR'),
            };
        }
    }
    writer() {
        return {
            upsertRaw: async (id, text, metadata, options) => {
                const res = await this.upsert(text, { ...metadata, id }, options);
                return res.ok ? { ok: true, value: undefined } : res;
            },
            deleteByIdRaw: async (id, options) => {
                try {
                    const pointId = await deterministicUUID(id);
                    const res = await this._fetch(`/collections/${this.collectionName}/points/delete`, {
                        method: 'POST',
                        body: JSON.stringify({ points: [pointId] }),
                    }, options?.signal);
                    if (!res.ok) {
                        const body = await res.text();
                        return {
                            ok: false,
                            error: new RagError(`Qdrant delete failed: ${body}`, 'DELETE_ERROR'),
                        };
                    }
                    return { ok: true, value: true };
                }
                catch (err) {
                    if (err instanceof RagError)
                        return { ok: false, error: err };
                    return {
                        ok: false,
                        error: new RagError(String(err), 'DELETE_ERROR'),
                    };
                }
            },
            clearAll: async () => {
                try {
                    const res = await this._fetch(`/collections/${this.collectionName}/points/delete`, {
                        method: 'POST',
                        body: JSON.stringify({ filter: {} }),
                    });
                    if (!res.ok) {
                        const body = await res.text();
                        return {
                            ok: false,
                            error: new RagError(`Qdrant clear failed: ${body}`, 'CLEAR_ERROR'),
                        };
                    }
                    return { ok: true, value: undefined };
                }
                catch (err) {
                    if (err instanceof RagError)
                        return { ok: false, error: err };
                    return { ok: false, error: new RagError(String(err), 'CLEAR_ERROR') };
                }
            },
            upsertPrecomputedRaw: async (id, text, vector, metadata, options) => {
                return this.upsertPrecomputed(text, vector, { ...metadata, id }, options);
            },
        };
    }
}
//# sourceMappingURL=qdrant-rag.js.map