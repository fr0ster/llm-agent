import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import type {
  IIdStrategy,
  IRag,
  IRagCatalogUpdater,
  IRagEditor,
  IRetrievalEmbedder,
  RagCatalogDescription,
  RagCatalogPatch,
  RagCatalogRow,
  RagCollectionOwner,
  RagCollectionRecord,
  RagCollectionScope,
  RagProviderCreateCollectionOptions,
} from '@mcp-abap-adt/llm-agent';
import {
  AbstractRagProvider as BaseRagProvider,
  CatalogRecordDeleteError,
  DuplicateCollectionError,
  describeRagCatalogRows,
  encodeRagAttributes,
  OrphanStoreError,
  RagError,
  type RagMetadata,
  type Result,
  ragCollectionNotFound,
  ragOwnerKeys,
  tagRagMetadata,
  validateRagCatalogPatch,
  validateRagOwner,
  validateRagStoreName,
} from '@mcp-abap-adt/llm-agent';
import {
  type AccessPayload,
  isAccessCollectionName,
  QdrantAccessPersistence,
} from './access-persistence.js';
import { deterministicUUID, QdrantRag } from './qdrant-rag.js';

/** The collection a QdrantRagProvider keeps one point per collection in, by default. */
export const DEFAULT_CATALOG_COLLECTION = 'rag_collection_catalog';
/** Embedded once per collection created, to learn the size Qdrant fixes at creation. */
const DIMENSION_PROBE = 'dimension probe';
const SCROLL_PAGE = 256;

type Handles = { rag: IRag; editor: IRagEditor };
type Refusal = { ok: false; error: RagError };

export interface QdrantRagProviderConfig {
  name: string;
  url: string;
  /**
   * Asked for fresh on every request — never cached — so a rotating key
   * rotates. Optional: an unauthenticated Qdrant deployment works today
   * without one.
   */
  credential?: IApiKeyCredential;
  embedder: IRetrievalEmbedder;
  editable?: boolean;
  timeoutMs?: number;
  supportedScopes?: readonly RagCollectionScope[];
  idStrategyFactory?: (owner: RagCollectionOwner) => IIdStrategy;
  /** The collection holding one record point per collection. Default `rag_collection_catalog`. */
  catalogCollection?: string;
}

export class QdrantRagProvider
  extends BaseRagProvider
  implements IRagCatalogUpdater
{
  readonly name: string;
  readonly kind = 'vector';
  readonly editable: boolean;
  readonly supportedScopes: readonly RagCollectionScope[];

  private readonly url: string;
  private readonly credential?: IApiKeyCredential;
  private readonly embedder: IRetrievalEmbedder;
  private readonly timeoutMs?: number;
  private readonly catalog: string;
  private catalogReady?: Promise<void>;
  private accessReady?: Promise<QdrantAccessPersistence>;
  private readonly ownerIdStrategyFactory?: (
    owner: RagCollectionOwner,
  ) => IIdStrategy;

  accessPersistence(): Promise<QdrantAccessPersistence> {
    this.accessReady ??= (async () => {
      const persistence = new QdrantAccessPersistence(
        this.request.bind(this),
        this.catalog,
      );
      await persistence.initialize();
      return persistence;
    })().catch((error: Error) => {
      this.accessReady = undefined;
      throw error;
    });
    return this.accessReady;
  }

  constructor(cfg: QdrantRagProviderConfig) {
    super();
    this.name = cfg.name;
    this.url = cfg.url.replace(/\/+$/, '');
    this.credential = cfg.credential;
    this.embedder = cfg.embedder;
    this.timeoutMs = cfg.timeoutMs;
    this.editable = cfg.editable ?? true;
    this.supportedScopes = cfg.supportedScopes ?? [
      'session',
      'user',
      'role',
      'global',
    ];
    this.catalog = cfg.catalogCollection ?? DEFAULT_CATALOG_COLLECTION;
    this.ownerIdStrategyFactory = cfg.idStrategyFactory;
  }

  /**
   * Creates the collection — sized explicitly or by one probe embedding — with a request that
   * fails if it exists, then commits the creation by writing the record last,
   * create-if-absent (§6.3).
   */
  async createCollection(
    name: string,
    opts: RagProviderCreateCollectionOptions,
  ): Promise<Result<Handles, RagError>> {
    if (
      opts.dimension !== undefined &&
      (!Number.isInteger(opts.dimension) || opts.dimension <= 0)
    ) {
      return {
        ok: false,
        error: new RagError(
          'Collection dimension must be a positive integer',
          'RAG_CREATE_ERROR',
        ),
      };
    }
    const checked = this.checkCreateOptions(opts);
    if (!checked.ok) return checked;
    const refused = this.refuseCatalogName(name);
    if (refused) return refused;
    return this.createOwnedCollection(name, opts, checked.value);
  }

  private async createOwnedCollection(
    name: string,
    opts: RagProviderCreateCollectionOptions,
    owner: RagCollectionOwner,
  ): Promise<Result<Handles, RagError>> {
    try {
      await this.ensureCatalog();
      if (await this.readRecord(name)) return this.duplicate(name, opts);
      if (opts.adoptExisting === true) {
        if (!(await this.collectionExists(name))) {
          return {
            ok: false,
            error: new RagError(
              `Qdrant collection '${name}' does not exist; adoptExisting takes over an existing store and creates nothing`,
              'RAG_CREATE_ERROR',
            ),
          };
        }
      } else {
        const created = await this.createStore(name, opts);
        if (!created.ok) return created;
      }
      const indexed = await this.request(
        `/collections/${name}/index?wait=true`,
        {
          method: 'PUT',
          body: JSON.stringify({
            field_name: 'ownerScope',
            field_schema: 'keyword',
          }),
        },
      );
      if (!indexed.ok)
        throw new RagError('Owner scope index failed', 'RAG_CREATE_ERROR');
      const recorded = await this.writeRecord(
        {
          ...owner,
          storeName: name,
          name: opts.collectionName ?? name,
          attributes: opts.attributes,
        },
        opts,
      );
      if (!recorded.ok) return recorded;
      if (owner.scope === 'role') {
        try {
          await (await this.accessPersistence()).requireRole(owner.roleId);
        } catch (error) {
          const response = await this.request(
            `/collections/${this.catalog}/points/delete?wait=true&ordering=strong`,
            {
              method: 'POST',
              body: JSON.stringify({
                filter: {
                  must: [
                    { key: 'store_name', match: { value: name } },
                    { key: 'write_id', match: { value: recorded.value } },
                  ],
                },
              }),
            },
          );
          if (!response.ok)
            throw new RagError(
              'Catalog compensation failed',
              'RAG_CREATE_ERROR',
            );
          throw error;
        }
      }
      return { ok: true, value: this.handles(name, owner) };
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof RagError
            ? err
            : new RagError(String(err), 'RAG_CREATE_ERROR'),
      };
    }
  }

  async migrateRecordOwners(): Promise<
    { storeName: string; reason: string }[]
  > {
    const listed = await this.listCollections();
    if (!listed.ok) throw listed.error;
    const reported: { storeName: string; reason: string }[] = [];
    for (const storeName of listed.value) {
      const indexed = await this.request(
        `/collections/${storeName}/index?wait=true`,
        {
          method: 'PUT',
          body: JSON.stringify({
            field_name: 'ownerScope',
            field_schema: 'keyword',
          }),
        },
      );
      if (!indexed.ok)
        throw new RagError('Owner scope index failed', 'RAG_MIGRATION_ERROR');
      let offset: string | number | null = null;
      do {
        const response = await this.request(
          `/collections/${storeName}/points/scroll?consistency=all`,
          {
            method: 'POST',
            body: JSON.stringify({
              limit: 256,
              with_payload: true,
              with_vector: false,
              ...(offset === null ? {} : { offset }),
            }),
          },
        );
        if (!response.ok)
          throw new RagError(
            'Record migration scroll failed',
            'RAG_MIGRATION_ERROR',
          );
        const body = (await response.json()) as {
          result: {
            points: { id: string | number; payload?: RagMetadata }[];
            next_page_offset?: string | number | null;
          };
        };
        for (const point of body.result.points) {
          const metadata = point.payload ?? {};
          const tagged = tagRagMetadata(metadata);
          if (tagged.ownerScope === 'invalid')
            reported.push({
              storeName,
              reason: `Conflicting owner keys on record ${point.id}`,
            });
          if (metadata.ownerScope === tagged.ownerScope) continue;
          const written = await this.request(
            `/collections/${storeName}/points/payload?wait=true&ordering=strong`,
            {
              method: 'POST',
              body: JSON.stringify({
                points: [point.id],
                payload: { ownerScope: tagged.ownerScope ?? null },
              }),
            },
          );
          if (!written.ok)
            throw new RagError(
              'Record migration update failed',
              'RAG_MIGRATION_ERROR',
            );
        }
        offset = body.result.next_page_offset ?? null;
      } while (offset !== null);
    }
    return reported;
  }

  /** The catalog, paged and read back through the shared row check. Creates nothing. */
  async describeCollections(): Promise<
    Result<RagCatalogDescription, RagError>
  > {
    try {
      if (!(await this.collectionExists(this.catalog))) {
        return { ok: true, value: { records: [], rejected: [] } };
      }
      const rows: RagCatalogRow[] = [];
      let offset: string | number | null = null;
      do {
        const res = await this.request(
          `/collections/${this.catalog}/points/scroll?consistency=all`,
          {
            method: 'POST',
            body: JSON.stringify({
              limit: SCROLL_PAGE,
              with_payload: true,
              with_vector: false,
              ...(offset === null ? {} : { offset }),
            }),
          },
        );
        if (!res.ok) {
          throw new RagError(
            `Qdrant catalog scroll failed: HTTP ${res.status} ${await res.text()}`,
            'RAG_LIST_ERROR',
          );
        }
        const json = (await res.json()) as {
          result?: {
            points?: Array<{ payload?: AccessPayload }>;
            next_page_offset?: string | number | null;
          };
        };
        if (!Array.isArray(json.result?.points)) {
          throw new RagError('Invalid Qdrant catalog scroll', 'RAG_LIST_ERROR');
        }
        for (const point of json.result.points) {
          const p = point.payload ?? {};
          rows.push({
            storeName: p.store_name,
            name: p.collection_name,
            scope: p.scope,
            userId: p.user_id,
            sessionId: p.session_id,
            roleId: typeof p.role_id === 'string' ? p.role_id : undefined,
            attributesJson: p.attributes_json,
          });
        }
        offset = json.result?.next_page_offset ?? null;
      } while (offset !== null);
      const description = describeRagCatalogRows(rows);
      const records: RagCollectionRecord[] = [];
      const rejected = [...description.rejected];
      for (const record of description.records) {
        if (record.scope === 'role') {
          try {
            await (await this.accessPersistence()).requireRole(record.roleId);
          } catch {
            rejected.push({
              storeName: record.storeName,
              reason: 'Role is missing or tombstoned',
            });
            continue;
          }
        }
        records.push(record);
      }
      return { ok: true, value: { records, rejected } };
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof RagError
            ? err
            : new RagError(String(err), 'RAG_LIST_ERROR'),
      };
    }
  }

  /**
   * Updates the display name and/or replaces the attributes of one record.
   * An empty patch is refused before any request.
   *
   * The record is read first and, when absent, RAG_COLLECTION_NOT_FOUND is
   * returned without a write. Set-payload addresses the point by id and never
   * creates one: Qdrant answers 404 when a listed point does not exist, and
   * that 404 is RAG_COLLECTION_NOT_FOUND too, so a delete landing between the
   * read and the write is reported correctly. The record is read once more
   * after the write (kept as a belt-and-braces check); a delete after that is
   * an update followed by a delete, which is a valid order.
   */
  async updateCollection(
    storeName: string,
    patch: RagCatalogPatch,
  ): Promise<Result<void, RagError>> {
    const name = validateRagStoreName(storeName);
    if (!name.ok) return name;
    const valid = validateRagCatalogPatch(patch);
    if (!valid.ok) return valid;
    const { collectionName, attributesJson } = valid.value;
    const notFound: Refusal = ragCollectionNotFound(storeName);
    try {
      if (!(await this.readRecord(storeName))) return notFound;
      const payload: AccessPayload = {
        ...(collectionName === undefined
          ? {}
          : { collection_name: collectionName }),
        ...(attributesJson === undefined
          ? {}
          : { attributes_json: attributesJson }),
      };
      const res = await this.request(
        `/collections/${this.catalog}/points/payload?wait=true`,
        {
          method: 'POST',
          body: JSON.stringify({
            payload,
            points: [await deterministicUUID(storeName)],
          }),
        },
      );
      if (res.status === 404) return notFound;
      if (!res.ok) {
        throw new RagError(
          `Qdrant catalog update failed: HTTP ${res.status} ${await res.text()}`,
          'RAG_UPDATE_ERROR',
        );
      }
      if (!(await this.readRecord(storeName))) return notFound;
      return { ok: true, value: undefined };
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof RagError
            ? err
            : new RagError(String(err), 'RAG_UPDATE_ERROR'),
      };
    }
  }

  /** Handles for a collection that exists. Issues no request, and the handles never create. */
  async openCollection(
    record: RagCollectionRecord,
  ): Promise<Result<Handles, RagError>> {
    const owner = validateRagOwner(record);
    if (!owner.ok) return owner;
    const refused = this.refuseCatalogName(record.storeName);
    if (refused) return refused;
    try {
      if (owner.value.scope === 'role') {
        await (await this.accessPersistence()).requireRole(owner.value.roleId);
      }
      return { ok: true, value: this.handles(record.storeName, owner.value) };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'RAG_OPEN_ERROR') };
    }
  }

  /** The record first, then the collection (§6.3). */
  async deleteCollection(name: string): Promise<Result<void, RagError>> {
    const refused = this.refuseCatalogName(name);
    if (refused) return refused;
    try {
      if (await this.collectionExists(this.catalog)) {
        const res = await this.request(
          `/collections/${this.catalog}/points/delete?wait=true`,
          {
            method: 'POST',
            body: JSON.stringify({ points: [await deterministicUUID(name)] }),
          },
        );
        if (!res.ok) {
          return {
            ok: false,
            error: new CatalogRecordDeleteError(
              name,
              `HTTP ${res.status} ${await res.text()}`,
            ),
          };
        }
      }
    } catch (err) {
      return {
        ok: false,
        error: new CatalogRecordDeleteError(name, String(err)),
      };
    }
    try {
      const res = await this.request(`/collections/${name}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = await res.text();
        return {
          ok: false,
          error: new RagError(
            `Qdrant delete collection failed: ${body}`,
            'RAG_DELETE_ERROR',
          ),
        };
      }
      return { ok: true, value: undefined };
    } catch (err) {
      return {
        ok: false,
        error: new RagError(String(err), 'RAG_DELETE_ERROR'),
      };
    }
  }

  async listCollections(): Promise<Result<string[], RagError>> {
    try {
      const res = await this.request('/collections');
      if (!res.ok) {
        const body = await res.text();
        return {
          ok: false,
          error: new RagError(
            `Qdrant list collections failed: ${body}`,
            'RAG_LIST_ERROR',
          ),
        };
      }
      const json = (await res.json()) as {
        result?: { collections?: Array<{ name: string }> };
      };
      const names = json.result?.collections?.map((c) => c.name) ?? [];
      return {
        ok: true,
        value: names.filter(
          (n) => n !== this.catalog && !isAccessCollectionName(n),
        ),
      };
    } catch (err) {
      return {
        ok: false,
        error: new RagError(String(err), 'RAG_LIST_ERROR'),
      };
    }
  }

  private async createStore(
    name: string,
    opts: RagProviderCreateCollectionOptions,
  ): Promise<Result<void, RagError>> {
    const dimension =
      opts.dimension ??
      (await this.embedder.embedDocument(DIMENSION_PROBE)).vector.length;
    const res = await this.request(`/collections/${name}`, {
      method: 'PUT',
      body: JSON.stringify({
        vectors: { size: dimension, distance: 'Cosine' },
      }),
    });
    if (res.ok) return { ok: true, value: undefined };
    const body = await res.text();
    if (!(await this.collectionExists(name))) {
      return {
        ok: false,
        error: new RagError(
          `Qdrant create collection failed: ${body}`,
          'RAG_CREATE_ERROR',
        ),
      };
    }
    if (await this.readRecord(name)) return this.duplicate(name, opts);
    return {
      ok: false,
      error: new OrphanStoreError(
        name,
        'it exists without a record; another session may be creating or deleting this collection, so retry later, or take it over with adoptExisting, or remove it',
      ),
    };
  }

  private async writeRecord(
    record: RagCollectionRecord,
    opts: RagProviderCreateCollectionOptions,
  ): Promise<Result<string, RagError>> {
    const { userId, sessionId, roleId } = ragOwnerKeys(record);
    const writeId = crypto.randomUUID();
    const payload: AccessPayload = {
      store_name: record.storeName,
      collection_name: record.name,
      scope: record.scope,
      ...(userId === undefined ? {} : { user_id: userId }),
      ...(sessionId === undefined ? {} : { session_id: sessionId }),
      ...(roleId === undefined ? {} : { role_id: roleId }),
      attributes_json: encodeRagAttributes(record.attributes),
      write_id: writeId,
    };
    let failure: string | undefined;
    try {
      const res = await this.request(
        `/collections/${this.catalog}/points?wait=true&ordering=strong`,
        {
          method: 'PUT',
          body: JSON.stringify({
            points: [
              {
                id: await deterministicUUID(record.storeName),
                vector: [1],
                payload,
              },
            ],
            update_mode: 'insert_only',
          }),
        },
      );
      if (!res.ok) failure = `HTTP ${res.status} ${await res.text()}`;
    } catch (err) {
      failure = String(err);
    }
    // insert_only IGNORES a write whose point exists (Qdrant ≥ 1.17), so the
    // outcome is read back: the record is this call's only if it carries this
    // call's write id.
    const stored = await this.readRecord(record.storeName).catch(
      () => undefined,
    );
    if (stored?.write_id === writeId) return { ok: true, value: writeId };
    if (stored) return this.duplicate(record.storeName, opts);
    // Never removed: another registry may adopt the collection and record it
    // before a removal could run (§6.3).
    return {
      ok: false,
      error: new OrphanStoreError(
        record.storeName,
        `its record could not be written (${failure ?? 'the write was accepted, but no record was found'}); the collection is left in place until it is adopted with adoptExisting or removed`,
      ),
    };
  }

  private handles(storeName: string, owner: RagCollectionOwner): Handles {
    const rag = new QdrantRag({
      url: this.url,
      credential: this.credential,
      embedder: this.embedder,
      collectionName: storeName,
      timeoutMs: this.timeoutMs,
      autoCreateCollection: false,
    });
    return {
      rag,
      editor: this.buildEditor(
        rag,
        this.ownerIdStrategyFactory
          ? this.ownerIdStrategyFactory(owner)
          : this.pickIdStrategy(owner),
      ),
    };
  }

  private duplicate(
    storeName: string,
    opts: RagProviderCreateCollectionOptions,
  ): Refusal {
    return {
      ok: false,
      error: new DuplicateCollectionError(
        opts.collectionName ?? storeName,
        `collection '${storeName}' already has a record`,
      ),
    };
  }

  private refuseCatalogName(name: string): Refusal | undefined {
    if (name !== this.catalog && !isAccessCollectionName(name))
      return undefined;
    return {
      ok: false,
      error: new RagError(
        `'${name}' is this provider's catalog collection, not a collection`,
        'INVALID_COLLECTION_NAME',
      ),
    };
  }

  private ensureCatalog(): Promise<void> {
    this.catalogReady ??= (async () => {
      if (await this.collectionExists(this.catalog)) return;
      const res = await this.request(`/collections/${this.catalog}`, {
        method: 'PUT',
        body: JSON.stringify({ vectors: { size: 1, distance: 'Dot' } }),
      });
      if (res.ok) return;
      const body = await res.text();
      // Another process may have created it between the check and here.
      if (!(await this.collectionExists(this.catalog))) {
        throw new RagError(
          `Qdrant could not create the catalog collection '${this.catalog}': ${body}`,
          'RAG_CREATE_ERROR',
        );
      }
    })().catch((err: unknown) => {
      this.catalogReady = undefined;
      throw err;
    });
    return this.catalogReady;
  }

  private async collectionExists(name: string): Promise<boolean> {
    const res = await this.request(`/collections/${name}`);
    if (res.ok) return true;
    if (res.status === 404) return false;
    throw new RagError(
      `Qdrant could not say whether collection '${name}' exists: HTTP ${res.status} ${await res.text()}`,
      'RAG_BACKEND_ERROR',
    );
  }

  /** The catalog point's payload, or undefined when there is none (or no catalog yet). */
  private async readRecord(
    storeName: string,
  ): Promise<AccessPayload | undefined> {
    const res = await this.request(
      `/collections/${this.catalog}/points?consistency=all`,
      {
        method: 'POST',
        body: JSON.stringify({
          ids: [await deterministicUUID(storeName)],
          with_payload: true,
        }),
      },
    );
    if (res.status === 404) return undefined;
    if (!res.ok) {
      throw new RagError(
        `Qdrant catalog read failed: HTTP ${res.status} ${await res.text()}`,
        'RAG_BACKEND_ERROR',
      );
    }
    const json = (await res.json()) as {
      result?: Array<{ payload?: AccessPayload }>;
    };
    return json.result?.[0]?.payload;
  }

  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.credential) headers['api-key'] = await this.credential.secret();
    return fetch(`${this.url}${path}`, { ...init, headers });
  }
}
