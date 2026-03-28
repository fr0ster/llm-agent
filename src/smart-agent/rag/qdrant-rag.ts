import type { IEmbedder, IRag } from '../interfaces/rag.js';
import {
  type CallOptions,
  RagError,
  type RagMetadata,
  type RagResult,
  type Result,
} from '../interfaces/types.js';

/**
 * Derive a deterministic UUID from a stable string key using SHA-256.
 * The first 16 bytes of the hash are formatted as a UUID v5-style string.
 */
async function deterministicUUID(key: string): Promise<string> {
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
  apiKey?: string;
  /** Per-request timeout in ms. Default: 30 000 */
  timeoutMs?: number;
}

export class QdrantRag implements IRag {
  private readonly url: string;
  private readonly collectionName: string;
  private readonly embedder: IEmbedder;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private collectionEnsured = false;

  constructor(config: QdrantRagConfig) {
    this.url = config.url.replace(/\/+$/, '');
    this.collectionName = config.collectionName;
    this.embedder = config.embedder;
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  private _headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['api-key'] = this.apiKey;
    return h;
  }

  private async _fetch(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
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
    } finally {
      clearTimeout(timer);
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

  async upsert(
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    if (options?.signal?.aborted) {
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    }
    try {
      const vector = await this.embedder.embed(text, options);
      await this._ensureCollection(vector.length, options?.signal);

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

  async query(
    text: string,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    if (options?.signal?.aborted) {
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    }
    try {
      const vector = await this.embedder.embed(text, options);

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
}
