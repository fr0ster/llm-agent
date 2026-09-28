import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import type {
  IDocumentEmbedder,
  IEmbedder,
  IQueryEmbedder,
  IQueryEmbedding,
  IRag,
  IRagBackendWriter,
  ISymmetricEmbedder,
  StoreEmbedders,
} from '@mcp-abap-adt/llm-agent';
import {
  type CallOptions,
  FallbackQueryEmbedding,
  RagError,
  type RagMetadata,
  type RagResult,
  type Result,
  ragIdentityFilter,
} from '@mcp-abap-adt/llm-agent';

/**
 * Derive a deterministic UUID from a stable string key using SHA-256.
 * The first 16 bytes of the hash are formatted as a UUID v5-style string.
 */
export async function deterministicUUID(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hashBuffer, 0, 16);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface QdrantRagConfig {
  url: string;
  collectionName: string;
  embedder: IEmbedder;
  /**
   * Asked for fresh on every request — never cached — so a rotating key
   * rotates and a resolved-once secret is never frozen for this object's
   * lifetime. Optional: an unauthenticated Qdrant deployment works today
   * without one.
   */
  credential?: IApiKeyCredential;
  /**
   * Per-request timeout in ms. **No default** — unset, a request is bounded
   * only by the caller's own signal.
   */
  timeoutMs?: number;
  /**
   * Create the collection on the first write when it is missing, sized from
   * that write's vector. Default `true` — a store configured directly relies on
   * it. `QdrantRagProvider` passes `false`: its collections are created by
   * `createCollection` only, so a handle whose collection is gone fails instead
   * of recreating it without a catalog record (§6.3).
   */
  autoCreateCollection?: boolean;
}

export class QdrantRag implements IRag {
  private readonly url: string;
  private readonly collectionName: string;
  private readonly embedder: IDocumentEmbedder;
  private readonly queryEmbedder: IQueryEmbedder;
  private readonly credential?: IApiKeyCredential;
  private readonly timeoutMs: number | undefined;
  private readonly autoCreateCollection: boolean;
  private collectionEnsured = false;

  /**
   * `embedder` alone must be symmetric; an asymmetric model passes its pair —
   * `embedder` (document half) + `queryEmbedder` (query half).
   */
  constructor(config: Omit<QdrantRagConfig, 'embedder'> & StoreEmbedders) {
    this.url = config.url.replace(/\/+$/, '');
    this.collectionName = config.collectionName;
    this.embedder = config.embedder;
    this.queryEmbedder =
      config.queryEmbedder ??
      // Without a query half StoreEmbedders admits only a symmetric embedder.
      (config.embedder as ISymmetricEmbedder);
    this.credential = config.credential;
    this.timeoutMs = config.timeoutMs;
    this.autoCreateCollection = config.autoCreateCollection ?? true;
  }

  private async _headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.credential) h['api-key'] = await this.credential.secret();
    return h;
  }

  private async _fetch(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    // Thirty seconds used to be imposed here whether or not anyone asked. A
    // ceiling on every request fires instead of whatever decided above it, so
    // there is none unless the consumer set one; the caller's signal is the
    // bound otherwise.
    const ctrl = new AbortController();
    const timer =
      this.timeoutMs === undefined
        ? undefined
        : setTimeout(() => ctrl.abort(), this.timeoutMs);
    if (signal) {
      signal.addEventListener('abort', () => ctrl.abort(signal.reason), {
        once: true,
      });
    }
    try {
      return await fetch(`${this.url}${path}`, {
        ...init,
        signal: ctrl.signal,
        headers: { ...(await this._headers()), ...(init.headers ?? {}) },
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async _ensureCollection(
    vectorSize: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.collectionEnsured) return;
    const res = await this._fetch(
      `/collections/${this.collectionName}`,
      { method: 'GET' },
      signal,
    );
    if (res.ok) {
      // Collection exists — verify the embedder dimension matches.
      // Qdrant collections have a fixed vectors.size set at creation time;
      // upserts with a different vector length are silently dropped.
      // Fail fast so the operator can either delete the stale collection
      // or point this RAG store at a collection matching the current embedder.
      try {
        const body = (await res.json()) as {
          result?: {
            config?: { params?: { vectors?: { size?: number } } };
          };
        };
        const existingSize = body.result?.config?.params?.vectors?.size;
        if (typeof existingSize === 'number' && existingSize !== vectorSize) {
          throw new RagError(
            `Qdrant collection "${this.collectionName}" has vectors.size=${existingSize} but the current embedder produces ${vectorSize}-dim vectors. ` +
              'The collection was created for a different embedding model. ' +
              'Either drop and recreate the collection, or point this RAG store at a collection matching the current embedder.',
            'UPSERT_ERROR',
          );
        }
      } catch (err) {
        if (err instanceof RagError) throw err;
        // JSON parsing or transient read failures — let the next upsert surface them naturally.
      }
      this.collectionEnsured = true;
      return;
    }
    // Collection doesn't exist — create it
    const createRes = await this._fetch(
      `/collections/${this.collectionName}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          vectors: { size: vectorSize, distance: 'Cosine' },
        }),
      },
      signal,
    );
    if (!createRes.ok) {
      const text = await createRes.text();
      throw new RagError(
        `Failed to create collection: ${text}`,
        'UPSERT_ERROR',
      );
    }
    this.collectionEnsured = true;
  }

  private async upsertKnownVector(
    text: string,
    vector: number[],
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    try {
      if (this.autoCreateCollection) {
        await this._ensureCollection(vector.length, options?.signal);
      }

      const pointId = metadata?.id
        ? await deterministicUUID(metadata.id)
        : crypto.randomUUID();
      const payload: Record<string, unknown> = {
        text,
        ...metadata,
      };

      const res = await this._fetch(
        `/collections/${this.collectionName}/points`,
        {
          method: 'PUT',
          body: JSON.stringify({
            points: [{ id: pointId, vector, payload }],
          }),
        },
        options?.signal,
      );

      if (!res.ok) {
        const body = await res.text();
        return {
          ok: false,
          error: new RagError(`Qdrant upsert failed: ${body}`, 'UPSERT_ERROR'),
        };
      }
      return { ok: true, value: undefined };
    } catch (err) {
      if (err instanceof RagError) return { ok: false, error: err };
      return { ok: false, error: new RagError(String(err), 'UPSERT_ERROR') };
    }
  }

  async upsert(
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    if (options?.signal?.aborted) {
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    }
    try {
      const { vector } = await this.embedder.embed(text, options);
      return this.upsertKnownVector(text, vector, metadata, options);
    } catch (err) {
      if (err instanceof RagError) return { ok: false, error: err };
      return { ok: false, error: new RagError(String(err), 'UPSERT_ERROR') };
    }
  }

  async upsertPrecomputed(
    text: string,
    vector: number[],
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    if (options?.signal?.aborted) {
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    }
    return this.upsertKnownVector(text, vector, metadata, options);
  }

  async query(
    embedding: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    if (options?.signal?.aborted) {
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    }
    try {
      const safe = new FallbackQueryEmbedding(embedding, this.queryEmbedder);
      const vector = await safe.toVector();

      const must: unknown[] = [];
      const targetNamespace = options?.ragFilter?.namespace;
      if (targetNamespace !== undefined) {
        must.push({ key: 'namespace', match: { value: targetNamespace } });
      }
      const nowSecs = Math.floor(Date.now() / 1000);
      must.push({ key: 'ttl', range: { gt: nowSecs } });

      const body: Record<string, unknown> = {
        vector,
        limit: k,
        with_payload: true,
      };
      // The session/user scope. upsert spreads metadata flat into the
      // payload, so `sessionId` / `userId` are top-level payload keys. A point
      // without the key does not match a `match` condition, so an unowned
      // point is never returned to a scoped query. Qdrant applies the filter
      // inside the search, so `limit: k` counts only matching points.
      const identity = ragIdentityFilter(options);
      const identityMust: unknown[] = [];
      if (identity?.sessionId !== undefined) {
        identityMust.push({
          key: 'sessionId',
          match: { value: identity.sessionId },
        });
      }
      if (identity?.userId !== undefined) {
        identityMust.push({ key: 'userId', match: { value: identity.userId } });
      }
      if (must.length > 0) {
        body.filter = {
          // Top-level `must` is ANDed with the `should` below (at least one
          // of which must hold), so the identity scope applies to both the
          // TTL-bearing and the TTL-less branch.
          ...(identityMust.length > 0 ? { must: identityMust } : {}),
          should: [
            { must },
            // Points with NO ttl field. `is_empty`, not "no ttl >= 0": that
            // let a negative ttl — a time in the past, so expired — through
            // as if it had none (PR #308 review).
            {
              must: [
                { is_empty: { key: 'ttl' } },
                ...(targetNamespace !== undefined
                  ? [{ key: 'namespace', match: { value: targetNamespace } }]
                  : []),
              ],
            },
          ],
        };
      }

      const res = await this._fetch(
        `/collections/${this.collectionName}/points/search`,
        { method: 'POST', body: JSON.stringify(body) },
        options?.signal,
      );

      if (!res.ok) {
        const errBody = await res.text();
        return {
          ok: false,
          error: new RagError(`Qdrant query failed: ${errBody}`, 'QUERY_ERROR'),
        };
      }

      const json = (await res.json()) as {
        result: Array<{
          score: number;
          payload: Record<string, unknown>;
        }>;
      };

      const results: RagResult[] = (json.result ?? []).map((hit) => {
        const { text: hitText, ...rest } = hit.payload;
        return {
          text: String(hitText ?? ''),
          metadata: rest as RagMetadata,
          score: hit.score,
        };
      });

      return { ok: true, value: results };
    } catch (err) {
      if (err instanceof RagError) return { ok: false, error: err };
      return { ok: false, error: new RagError(String(err), 'QUERY_ERROR') };
    }
  }

  async getById(
    id: string,
    options?: CallOptions,
  ): Promise<Result<RagResult | null, RagError>> {
    if (options?.signal?.aborted) {
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    }
    try {
      const pointId = await deterministicUUID(id);
      const res = await this._fetch(
        `/collections/${this.collectionName}/points`,
        {
          method: 'POST',
          body: JSON.stringify({ ids: [pointId], with_payload: true }),
        },
        options?.signal,
      );
      if (!res.ok) {
        const body = await res.text();
        return {
          ok: false,
          error: new RagError(`Qdrant retrieve failed: ${body}`, 'QUERY_ERROR'),
        };
      }
      const json = (await res.json()) as {
        result: Array<{ id: string; payload: Record<string, unknown> }>;
      };
      const hit = json.result?.[0];
      if (!hit) return { ok: true, value: null };
      const { text: hitText, ...rest } = hit.payload;
      return {
        ok: true,
        value: {
          text: String(hitText ?? ''),
          metadata: rest as RagMetadata,
          score: 1,
        },
      };
    } catch (err) {
      if (err instanceof RagError) return { ok: false, error: err };
      return { ok: false, error: new RagError(String(err), 'QUERY_ERROR') };
    }
  }

  async healthCheck(options?: CallOptions): Promise<Result<void, RagError>> {
    try {
      const res = await this._fetch(
        `/collections/${this.collectionName}`,
        { method: 'GET' },
        options?.signal,
      );
      if (!res.ok) {
        return {
          ok: false,
          error: new RagError(
            `Qdrant collection not accessible: HTTP ${res.status}`,
            'HEALTH_CHECK_ERROR',
          ),
        };
      }
      return { ok: true, value: undefined };
    } catch (err) {
      return {
        ok: false,
        error: new RagError(
          `Qdrant health check failed: ${String(err)}`,
          'HEALTH_CHECK_ERROR',
        ),
      };
    }
  }

  writer(): IRagBackendWriter {
    return {
      upsertRaw: async (id, text, metadata, options) => {
        const res = await this.upsert(text, { ...metadata, id }, options);
        return res.ok ? { ok: true, value: undefined } : res;
      },
      deleteByIdRaw: async (id, options) => {
        try {
          const pointId = await deterministicUUID(id);
          const res = await this._fetch(
            `/collections/${this.collectionName}/points/delete`,
            {
              method: 'POST',
              body: JSON.stringify({ points: [pointId] }),
            },
            options?.signal,
          );
          if (!res.ok) {
            const body = await res.text();
            return {
              ok: false,
              error: new RagError(
                `Qdrant delete failed: ${body}`,
                'DELETE_ERROR',
              ),
            };
          }
          return { ok: true, value: true };
        } catch (err) {
          if (err instanceof RagError) return { ok: false, error: err };
          return {
            ok: false,
            error: new RagError(String(err), 'DELETE_ERROR'),
          };
        }
      },
      clearAll: async () => {
        try {
          const res = await this._fetch(
            `/collections/${this.collectionName}/points/delete`,
            {
              method: 'POST',
              body: JSON.stringify({ filter: {} }),
            },
          );
          if (!res.ok) {
            const body = await res.text();
            return {
              ok: false,
              error: new RagError(
                `Qdrant clear failed: ${body}`,
                'CLEAR_ERROR',
              ),
            };
          }
          return { ok: true, value: undefined };
        } catch (err) {
          if (err instanceof RagError) return { ok: false, error: err };
          return { ok: false, error: new RagError(String(err), 'CLEAR_ERROR') };
        }
      },
      upsertPrecomputedRaw: async (id, text, vector, metadata, options) => {
        return this.upsertPrecomputed(
          text,
          vector,
          { ...metadata, id },
          options,
        );
      },
      upsertManyPrecomputedRaw: async (items, options) => {
        if (items.length === 0) return { ok: true, value: undefined };
        try {
          if (this.autoCreateCollection) {
            await this._ensureCollection(
              items[0].vector.length,
              options?.signal,
            );
          }
          const points = await Promise.all(
            items.map(async ({ id, text, vector, metadata }) => ({
              id: await deterministicUUID(id),
              vector,
              payload: { text, ...metadata, id },
            })),
          );
          // One PUT for the whole batch — Qdrant accepts many points per
          // request, replacing N round trips with 1. Atomic: a single bad
          // vector rejects the batch, and the caller retries per-record to
          // find it.
          const res = await this._fetch(
            `/collections/${this.collectionName}/points`,
            { method: 'PUT', body: JSON.stringify({ points }) },
            options?.signal,
          );
          if (!res.ok) {
            const body = await res.text();
            return {
              ok: false,
              error: new RagError(
                `Qdrant bulk upsert failed: ${body}`,
                'UPSERT_ERROR',
              ),
            };
          }
          return { ok: true, value: undefined };
        } catch (err) {
          if (err instanceof RagError) return { ok: false, error: err };
          return {
            ok: false,
            error: new RagError(String(err), 'UPSERT_ERROR'),
          };
        }
      },
    };
  }
}
