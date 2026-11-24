import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import type {
  IQueryEmbedding,
  IRag,
  IRagBackendWriter,
  IRetrievalEmbedder,
} from '@mcp-abap-adt/llm-agent';
import {
  assertNonEmptyFilter,
  assertScanOptions,
  type CallOptions,
  decodeListCursor,
  embedRecord,
  encodeListCursor,
  type IRagFilteredDeleter,
  type IRagScanner,
  listCursorScope,
  listMetadata,
  matchesRagIdentity,
  overflowError,
  prepareList,
  QueryEmbedding,
  type RagDocumentVectors,
  RagError,
  type RagListPage,
  type RagListParams,
  type RagMetadata,
  type RagResult,
  type RagScanFilter,
  type RagScanPage,
  type RecordEmbeddingConfig,
  type Result,
  ragIdentityFilter,
  recordVectors,
  TextOnlyEmbedding,
  validateRagMetadata,
} from '@mcp-abap-adt/llm-agent';
import {
  assertUserCollection,
  collectionVectors,
  denseVectorConfig,
  qdrantFetch,
  singleVectorWriteError,
} from './multivector.js';
import { splitPayload } from './payload-record.js';
import type { QdrantCondition, QdrantFilter } from './query-filter.js';
import { deleteWhere, scanPage } from './scan-delete.js';

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

type PointId = string | number;

export interface QdrantRagConfig extends RecordEmbeddingConfig {
  url: string;
  collectionName: string;
  embedder: IRetrievalEmbedder;
  /** @deprecated Query embedding failures always propagate. */
  fallbackOnQueryEmbeddingError?: boolean;
  /**
   * Asked for fresh on every request — never cached — so a rotating key
   * rotates and a resolved-once secret is never frozen for this object's
   * lifetime. Optional: an unauthenticated Qdrant deployment works today
   * without one.
   */
  credential?: IApiKeyCredential;
  /**
   * Create the collection on the first write when it is missing, sized from
   * that write's vector. Default `true` — a store configured directly relies on
   * it. `QdrantRagProvider` passes `false`: its collections are created by
   * `createCollection` only, so a handle whose collection is gone fails instead
   * of recreating it without a catalog record (§6.3).
   */
  autoCreateCollection?: boolean;
}

export class QdrantRag implements IRag, IRagScanner, IRagFilteredDeleter {
  private readonly url: string;
  private readonly collectionName: string;
  private readonly embedder: IRetrievalEmbedder;
  private readonly fragmentSizeChars?: number;
  private readonly credential?: IApiKeyCredential;
  private readonly autoCreateCollection: boolean;

  private static readonly writes = new Map<string, Promise<void>>();

  /** A batch has ordered operations. Serialize mutations across local handles. */
  private async write<T>(work: () => Promise<T>): Promise<T> {
    const key = `${this.url}/collections/${this.collectionName}`;
    const previous = QdrantRag.writes.get(key) ?? Promise.resolve();
    const pending = previous.then(work);
    const settled = pending.then(
      () => {},
      () => {},
    );
    QdrantRag.writes.set(key, settled);
    try {
      return await pending;
    } finally {
      if (QdrantRag.writes.get(key) === settled) QdrantRag.writes.delete(key);
    }
  }

  constructor(config: QdrantRagConfig) {
    this.url = config.url.replace(/\/+$/, '');
    assertUserCollection(config.collectionName);
    this.collectionName = config.collectionName;
    this.embedder = config.embedder;
    this.fragmentSizeChars = config.fragmentSizeChars;
    this.credential = config.credential;
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
    return qdrantFetch(`${this.url}${path}`, {
      ...init,
      signal: signal instanceof AbortSignal ? signal : undefined,
      headers: { ...(await this._headers()), ...(init.headers ?? {}) },
    });
  }

  private async collectionLayout(signal?: AbortSignal, vectorSize?: number) {
    const path = `/collections/${this.collectionName}`;
    let response = await this._fetch(path, { method: 'GET' }, signal);
    if (
      response.status === 404 &&
      vectorSize !== undefined &&
      this.autoCreateCollection
    ) {
      const created = await this._fetch(
        path,
        {
          method: 'PUT',
          body: JSON.stringify({ vectors: denseVectorConfig(vectorSize) }),
        },
        signal,
      );
      if (created.ok) {
        const indexed = await this._fetch(
          `${path}/index?wait=true`,
          {
            method: 'PUT',
            body: JSON.stringify({
              field_name: 'ownerScope',
              field_schema: 'keyword',
            }),
          },
          signal,
        );
        if (!indexed.ok)
          throw new RagError(
            'Payload index failed: ownerScope',
            'UPSERT_ERROR',
          );
        return { name: undefined, size: vectorSize, multivector: true };
      }
      response = await this._fetch(path, { method: 'GET' }, signal);
      if (!response.ok)
        throw new RagError(
          `Failed to create collection: ${await created.text()}`,
          'UPSERT_ERROR',
        );
    }
    if (!response.ok)
      throw new RagError(
        `Qdrant collection lookup failed: ${await response.text()}`,
        vectorSize === undefined ? 'QUERY_ERROR' : 'UPSERT_ERROR',
      );
    const layout = await collectionVectors(response);
    if (vectorSize !== undefined && layout.size !== vectorSize)
      throw new RagError(
        `Qdrant collection "${this.collectionName}" has vectors.size=${layout.size} but the current embedder produces ${vectorSize}-dim vectors.`,
        'UPSERT_ERROR',
      );
    return layout;
  }

  private async writeRecords(
    records: ReadonlyArray<{
      id?: string;
      text: string;
      vector: RagDocumentVectors;
      metadata: RagMetadata;
    }>,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    if (records.length === 0) return { ok: true, value: undefined };
    try {
      options?.signal?.throwIfAborted();
      // An explicit id repeated in one batch takes its last value.
      const recordsById = new Map(
        records.map((record) => [record.id ?? crypto.randomUUID(), record]),
      );
      const points = await Promise.all(
        [...recordsById.values()].map(
          async ({ id, text, vector, metadata }) => ({
            id: id ? await deterministicUUID(id) : crypto.randomUUID(),
            vectors: recordVectors(vector),
            payload: { ...validateRagMetadata(metadata), text },
          }),
        ),
      );
      const dimension = points[0].vectors[0].length;
      if (
        points.some(({ vectors }) =>
          vectors.some((vector) => vector.length !== dimension),
        )
      )
        throw new RagError(
          'Incompatible dimensions in record batch',
          'UPSERT_ERROR',
        );
      const res = await this.write(async () => {
        const layout = await this.collectionLayout(options?.signal, dimension);
        if (
          !layout.multivector &&
          points.some(({ vectors }) => vectors.length > 1)
        )
          throw singleVectorWriteError(this.collectionName);
        return this._fetch(
          `/collections/${this.collectionName}/points?wait=true&ordering=strong`,
          {
            method: 'PUT',
            body: JSON.stringify({
              points: points.map(({ id, vectors, payload }) => {
                const dense = layout.multivector ? vectors : vectors[0];
                return {
                  id,
                  payload,
                  vector: layout.name ? { [layout.name]: dense } : dense,
                };
              }),
            }),
          },
          options?.signal,
        );
      });
      if (!res.ok)
        throw new RagError(
          `Qdrant upsert failed: ${await res.text()}`,
          'UPSERT_ERROR',
        );
      return { ok: true, value: undefined };
    } catch (err) {
      return {
        ok: false,
        error: this._scanFailure(err, 'UPSERT_ERROR', options),
      };
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
      const vectors = await embedRecord(
        this.embedder,
        text,
        this.fragmentSizeChars,
        options,
      );
      options?.signal?.throwIfAborted();
      return this.writeRecords(
        [{ id: metadata.id, text, vector: vectors, metadata }],
        options,
      );
    } catch (err) {
      const overflow = overflowError(err, options?.signal);
      if (overflow) return { ok: false, error: overflow };
      if (options?.signal?.aborted)
        return { ok: false, error: new RagError('Aborted', 'ABORTED') };
      if (err instanceof RagError) return { ok: false, error: err };
      return { ok: false, error: new RagError(String(err), 'UPSERT_ERROR') };
    }
  }

  async upsertPrecomputed(
    text: string,
    vector: RagDocumentVectors,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    if (options?.signal?.aborted) {
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    }
    return this.writeRecords(
      [{ id: metadata.id, text, vector, metadata }],
      options,
    );
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
      const safe =
        embedding instanceof TextOnlyEmbedding
          ? new QueryEmbedding(embedding.text, this.embedder, options)
          : embedding;
      const vector = await safe.toVector();

      const must: QdrantCondition[] = [];
      const targetNamespace = options?.ragFilter?.namespace;
      if (targetNamespace !== undefined) {
        must.push({ key: 'namespace', match: { value: targetNamespace } });
      }
      const nowSecs = Math.floor(Date.now() / 1000);
      must.push({ key: 'ttl', range: { gt: nowSecs } });

      // The session/user scope. upsert spreads metadata flat into the
      // payload, so `sessionId` / `userId` are top-level payload keys. A point
      // without the key does not match a `match` condition, so an unowned
      // point is never returned to a scoped query. Qdrant applies the filter
      // inside the search, so `limit: k` counts only matching points.
      const identity = ragIdentityFilter(options);
      const identityMust: QdrantCondition[] = [];
      if (identity?.ownerScope !== undefined)
        identityMust.push({
          key: 'ownerScope',
          match: { value: identity.ownerScope },
        });
      if (identity?.sessionId !== undefined) {
        identityMust.push({
          key: 'sessionId',
          match: { value: identity.sessionId },
        });
      }
      if (identity?.userId !== undefined) {
        identityMust.push({ key: 'userId', match: { value: identity.userId } });
      }
      if (k <= 0) return { ok: true, value: [] };
      const filter: QdrantFilter = {
        must: identityMust,
        should: [
          { must },
          { must: [{ is_empty: { key: 'ttl' } }, ...must.slice(0, -1)] },
        ],
      };
      const layout = await this.collectionLayout(options?.signal);
      const { points } = await this.queryPoints<{
        points: { id: PointId; score: number; payload: RagMetadata }[];
      }>(
        'query',
        {
          query: layout.multivector ? [vector] : vector,
          using: layout.name,
          limit: k,
          with_payload: true,
          filter,
        },
        options?.signal,
      );
      return {
        ok: true,
        value: points.flatMap(({ payload, score }) => {
          const record = splitPayload(payload);
          return matchesRagIdentity(record.metadata, identity) &&
            (targetNamespace === undefined ||
              record.metadata.namespace === targetNamespace) &&
            !(
              typeof record.metadata.ttl === 'number' &&
              record.metadata.ttl <= nowSecs
            )
            ? [{ ...record, score }]
            : [];
        }),
      };
    } catch (err) {
      return {
        ok: false,
        error:
          overflowError(err, options?.signal) ??
          (err instanceof RagError
            ? err
            : this._scanFailure(err, 'QUERY_ERROR', options)),
      };
    }
  }

  private async queryPoints<T>(
    path: string,
    body: object,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this._fetch(
      `/collections/${this.collectionName}/points${path ? `/${path}` : ''}`,
      { method: 'POST', body: JSON.stringify(body) },
      signal,
    );
    if (!response.ok)
      throw new RagError(
        `Qdrant query failed: ${await response.text()}`,
        'QUERY_ERROR',
      );
    const json = (await response.json()) as { result: T };
    return json.result;
  }

  async getById(
    id: string,
    options?: CallOptions,
  ): Promise<Result<RagResult | null, RagError>> {
    if (options?.signal?.aborted) {
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    }
    try {
      const identity = ragIdentityFilter(options);
      const namespace = options?.ragFilter?.namespace;
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
        result: Array<{ id: string; payload: RagMetadata }>;
      };
      const hit = json.result?.[0];
      if (!hit) return { ok: true, value: null };
      const record = splitPayload(hit.payload);
      if (
        !matchesRagIdentity(record.metadata, identity) ||
        (namespace !== undefined && record.metadata.namespace !== namespace)
      ) {
        return { ok: true, value: null };
      }
      return {
        ok: true,
        value: { ...record, score: 1 },
      };
    } catch (err) {
      if (err instanceof RagError) return { ok: false, error: err };
      return { ok: false, error: new RagError(String(err), 'QUERY_ERROR') };
    }
  }

  async list(
    params: RagListParams = {},
    options?: CallOptions,
  ): Promise<Result<RagListPage, RagError>> {
    try {
      const { filter, conflict, limit } = prepareList(params, options);
      const scope = listCursorScope(
        `qdrant:${this.url}:${this.collectionName}`,
        filter,
        conflict,
      );
      const cursor =
        params.cursor === undefined
          ? undefined
          : decodeListCursor(scope, params.cursor);
      if (conflict) return { ok: true, value: { records: [] } };
      const page = await scanPage(
        this._fetch.bind(this),
        this.collectionName,
        { filter, pageSize: limit, cursor },
        options?.signal,
        true,
      );
      const records = page.records.map((record) => ({
        id: record.id,
        metadata: listMetadata(record.metadata),
        ...(params.includeText ? { text: record.text } : {}),
      }));
      if (options?.signal?.aborted) throw new RagError('Aborted', 'ABORTED');
      return {
        ok: true,
        value: {
          records,
          ...(page.cursor === undefined
            ? {}
            : { cursor: encodeListCursor(scope, page.cursor) }),
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: options?.signal?.aborted
          ? new RagError('Aborted', 'ABORTED')
          : error instanceof RagError
            ? error
            : new RagError(String(error), 'QUERY_ERROR'),
      };
    }
  }

  async scan(
    opts?: { filter?: RagScanFilter; pageSize?: number; cursor?: string },
    options?: CallOptions,
  ): Promise<Result<RagScanPage, RagError>> {
    if (options?.signal?.aborted) {
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    }
    const valid = assertScanOptions(opts);
    if (!valid.ok) return valid;
    try {
      const page = await scanPage(
        this._fetch.bind(this),
        this.collectionName,
        opts,
        options?.signal,
      );
      return { ok: true, value: page };
    } catch (err) {
      return {
        ok: false,
        error: this._scanFailure(err, 'QUERY_ERROR', options),
      };
    }
  }

  async deleteWhere(
    filter: RagScanFilter,
    options?: CallOptions,
  ): Promise<Result<{ deleted: number }, RagError>> {
    if (options?.signal?.aborted) {
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    }
    const valid = assertNonEmptyFilter(filter);
    if (!valid.ok) return valid;
    try {
      const deleted = await this.write(() =>
        deleteWhere(
          this._fetch.bind(this),
          this.collectionName,
          filter,
          options?.signal,
        ),
      );
      return { ok: true, value: { deleted } };
    } catch (err) {
      return {
        ok: false,
        error: this._scanFailure(err, 'DELETE_ERROR', options),
      };
    }
  }

  /** A RagError passes through; an abort is ABORTED; anything else gets `code`. */
  private _scanFailure(
    err: unknown,
    code: string,
    options?: CallOptions,
  ): RagError {
    if (err instanceof RagError) return err;
    if (options?.signal?.aborted) return new RagError('Aborted', 'ABORTED');
    return new RagError(String(err), code);
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
          const res = await this.write(() =>
            this._fetch(
              `/collections/${this.collectionName}/points/delete?wait=true&ordering=strong`,
              {
                method: 'POST',
                body: JSON.stringify({ points: [pointId] }),
              },
              options?.signal,
            ),
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
          const res = await this.write(() =>
            this._fetch(`/collections/${this.collectionName}/points/delete`, {
              method: 'POST',
              body: JSON.stringify({ filter: {} }),
            }),
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
      upsertManyPrecomputedRaw: (items, options) =>
        this.writeRecords(
          items.map((item) => ({
            ...item,
            metadata: { ...item.metadata, id: item.id },
          })),
          options,
        ),
    };
  }
}
