import type {
  IEmbedder,
  IIdStrategy,
  IRag,
  IRagEditor,
  RagCatalogDescription,
  RagCollectionOwner,
  RagCollectionRecord,
  RagCollectionScope,
  RagProviderCreateCollectionOptions,
  Result,
} from '@mcp-abap-adt/llm-agent';
import {
  AbstractRagProvider,
  CatalogRecordDeleteError,
  DuplicateCollectionError,
  describeRagCatalogRows,
  encodeRagAttributes,
  OrphanStoreError,
  RagError,
  ragOwnerKeys,
  storeEmbedders,
  validateRagOwner,
} from '@mcp-abap-adt/llm-agent';
import {
  createCatalogTableSql,
  DEFAULT_CATALOG_TABLE,
  deleteRecordSql,
  insertRecordSql,
  probeTableSql,
  recordExistsSql,
  selectRecordsSql,
  tableExistsSql,
} from './catalog.js';
import type { PgVectorRagConfig } from './connection.js';
import { createPgClient, type PgClient, PgVectorRag } from './pg-vector-rag.js';
import {
  assertCollectionName,
  createExtensionSql,
  createTableSql,
  dropTableSql,
  quoteIdent,
} from './schema.js';

type Handles = { rag: IRag; editor: IRagEditor };
type Refusal = { ok: false; error: RagError };

export interface PgVectorRagProviderConfig {
  name: string;
  embedder: IEmbedder;
  /** The query half of an asymmetric model, for the stores it builds. */
  queryEmbedder?: IEmbedder;
  connection: PgVectorRagConfig | string;
  defaultDimension?: number;
  /**
   * `true` (default): the provider creates its catalog table on first use and
   * each collection's table in `createCollection`. `false`: it issues no DDL at
   * all — the operator creates the catalog (`createCatalogTableSql`) and the
   * tables, and `createCollection` requires the table and records it.
   */
  autoCreateSchema?: boolean;
  editable?: boolean;
  supportedScopes?: readonly RagCollectionScope[];
  idStrategyFactory?: (opts: {
    scope: RagCollectionScope;
    sessionId?: string;
    userId?: string;
  }) => IIdStrategy;
  /**
   * Optional factory for the driver client the provider uses for catalog and
   * schema statements and hands each collection handle. Omitted, the provider
   * opens one pool of its own from `connection` for its statements, and each
   * handle opens its own.
   */
  clientFactory?: () => PgClient;
  /** The table holding one record per collection. Default `rag_collection_catalog`. */
  catalogTable?: string;
}

function normalizeConnection(c: PgVectorRagConfig | string): PgVectorRagConfig {
  return typeof c === 'string'
    ? { connectionString: c, collectionName: '__unused' }
    : c;
}

export class PgVectorRagProvider extends AbstractRagProvider {
  readonly name: string;
  readonly kind = 'vector';
  readonly editable: boolean;
  readonly supportedScopes: readonly RagCollectionScope[];

  private readonly embedder: IEmbedder;
  private readonly queryEmbedder?: IEmbedder;
  private readonly connection: PgVectorRagConfig;
  private readonly defaultDimension: number;
  private readonly autoCreateSchema: boolean;
  private readonly clientFactory?: () => PgClient;
  private readonly catalogTable: string;
  private ownClient?: Promise<PgClient>;
  private catalogReady?: Promise<void>;

  constructor(cfg: PgVectorRagProviderConfig) {
    super();
    this.name = cfg.name;
    this.embedder = cfg.embedder;
    this.queryEmbedder = cfg.queryEmbedder;
    this.connection = normalizeConnection(cfg.connection);
    this.defaultDimension = cfg.defaultDimension ?? 1536;
    this.autoCreateSchema = cfg.autoCreateSchema ?? true;
    this.editable = cfg.editable ?? true;
    this.supportedScopes = cfg.supportedScopes ?? ['session', 'user', 'global'];
    this.clientFactory = cfg.clientFactory;
    this.catalogTable = cfg.catalogTable ?? DEFAULT_CATALOG_TABLE;
    assertCollectionName(this.catalogTable);
    if (cfg.idStrategyFactory) this.idStrategyFactory = cfg.idStrategyFactory;
  }

  /**
   * Creates the store with a statement that fails if it exists, then commits
   * the creation by writing the record last, create-if-absent (§6.3).
   */
  async createCollection(
    name: string,
    opts: RagProviderCreateCollectionOptions,
  ): Promise<Result<Handles, RagError>> {
    const checked = this.checkCreateOptions(opts);
    if (!checked.ok) return checked;
    const refused = this.refuseCatalogName(name);
    if (refused) return refused;
    try {
      assertCollectionName(name);
      const client = await this.adminClient();
      if (this.autoCreateSchema) await this.ensureCatalog(client);
      if (await this.recordExists(client, name))
        return this.duplicate(name, opts);
      if (opts.adoptExisting === true || !this.autoCreateSchema) {
        // Adoption takes over a store that is there and creates nothing: the
        // probe fails with the backend's own error when it is not.
        await client.query(probeTableSql(name));
      } else {
        const created = await this.createStore(client, name, opts);
        if (!created.ok) return created;
      }
      const recorded = await this.writeRecord(
        client,
        {
          ...checked.value,
          storeName: name,
          name: opts.collectionName ?? name,
          attributes: opts.attributes,
        },
        opts,
      );
      if (!recorded.ok) return recorded;
      return { ok: true, value: this.handles(name, checked.value) };
    } catch (err) {
      return {
        ok: false,
        error: new RagError(String(err), 'RAG_CREATE_ERROR'),
      };
    }
  }

  /** The catalog, read back through the shared row check. Creates nothing. */
  async describeCollections(): Promise<
    Result<RagCatalogDescription, RagError>
  > {
    try {
      const client = await this.adminClient();
      if (!(await this.tableExists(client, this.catalogTable))) {
        return { ok: true, value: { records: [], rejected: [] } };
      }
      const { rows } = await client.query(selectRecordsSql(this.catalogTable));
      return { ok: true, value: describeRagCatalogRows(rows) };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'RAG_LIST_ERROR') };
    }
  }

  /**
   * Handles for a store that exists. Issues no statement, and the handles run
   * with lazy schema creation off, so a store that is gone fails rather than
   * coming back without a record.
   */
  async openCollection(
    record: RagCollectionRecord,
  ): Promise<Result<Handles, RagError>> {
    const owner = validateRagOwner(record);
    if (!owner.ok) return owner;
    try {
      return { ok: true, value: this.handles(record.storeName, owner.value) };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'RAG_OPEN_ERROR') };
    }
  }

  /** The record first, then the data (§6.3). */
  async deleteCollection(name: string): Promise<Result<void, RagError>> {
    const refused = this.refuseCatalogName(name);
    if (refused) return refused;
    let client: PgClient;
    try {
      client = await this.adminClient();
      if (await this.tableExists(client, this.catalogTable)) {
        await client.query(deleteRecordSql(this.catalogTable), [name]);
      }
    } catch (err) {
      // Stop: record and data both survive, so nothing was deleted — retry it.
      return {
        ok: false,
        error: new CatalogRecordDeleteError(name, String(err)),
      };
    }
    try {
      await client.query(dropTableSql(name));
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
      const client = await this.adminClient();
      const schema = this.connection.schema ?? 'public';
      const { rows } = await client.query(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = $1',
        [schema],
      );
      return {
        ok: true,
        value: rows
          .map((r) => String(r.table_name))
          .filter((t) => t !== this.catalogTable),
      };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'RAG_LIST_ERROR') };
    }
  }

  private async createStore(
    client: PgClient,
    name: string,
    opts: RagProviderCreateCollectionOptions,
  ): Promise<Result<void, RagError>> {
    try {
      await client.query(createExtensionSql());
      await client.query(
        createTableSql(name, this.dimension(), { ifNotExists: false }),
      );
      return { ok: true, value: undefined };
    } catch (err) {
      if (!(await this.tableExists(client, name))) throw err;
      if (await this.recordExists(client, name))
        return this.duplicate(name, opts);
      return {
        ok: false,
        error: new OrphanStoreError(
          name,
          'it exists without a record; another session may be creating or deleting this collection, so retry later, or take it over with adoptExisting, or remove it',
        ),
      };
    }
  }

  private async writeRecord(
    client: PgClient,
    record: RagCollectionRecord,
    opts: RagProviderCreateCollectionOptions,
  ): Promise<Result<void, RagError>> {
    const { userId, sessionId } = ragOwnerKeys(record);
    try {
      await client.query(insertRecordSql(this.catalogTable), [
        record.storeName,
        record.name,
        record.scope,
        userId ?? null,
        sessionId ?? null,
        encodeRagAttributes(record.attributes),
      ]);
      return { ok: true, value: undefined };
    } catch (err) {
      // Lost to another registry's write: its record points at this store, which stays.
      if (
        await this.recordExists(client, record.storeName).catch(() => false)
      ) {
        return this.duplicate(record.storeName, opts);
      }
      // Never removed: between this failure and a removal another registry may
      // adopt the store and record it, and a removal would leave that record
      // without data (§6.3).
      return {
        ok: false,
        error: new OrphanStoreError(
          record.storeName,
          `its record could not be written (${String(err)}); the store is left in place until it is adopted with adoptExisting or removed`,
        ),
      };
    }
  }

  private handles(storeName: string, owner: RagCollectionOwner): Handles {
    const rag = new PgVectorRag(
      {
        ...this.connection,
        collectionName: storeName,
        dimension: this.dimension(),
        // No handle creates its store: createCollection does, and only it.
        autoCreateSchema: false,
        ...storeEmbedders(this.embedder, this.queryEmbedder),
      },
      this.clientFactory?.(),
    );
    return { rag, editor: this.buildEditor(rag, this.pickIdStrategy(owner)) };
  }

  private duplicate(
    storeName: string,
    opts: RagProviderCreateCollectionOptions,
  ): Refusal {
    return {
      ok: false,
      error: new DuplicateCollectionError(
        opts.collectionName ?? storeName,
        `store '${storeName}' already has a record`,
      ),
    };
  }

  private refuseCatalogName(name: string): Refusal | undefined {
    if (name !== this.catalogTable) return undefined;
    return {
      ok: false,
      error: new RagError(
        `'${name}' is this provider's catalog table, not a collection`,
        'INVALID_COLLECTION_NAME',
      ),
    };
  }

  private dimension(): number {
    return this.connection.dimension ?? this.defaultDimension;
  }

  private async adminClient(): Promise<PgClient> {
    if (this.clientFactory) return this.clientFactory();
    this.ownClient ??= createPgClient(this.connection).catch((err: unknown) => {
      this.ownClient = undefined;
      throw err;
    });
    return this.ownClient;
  }

  private ensureCatalog(client: PgClient): Promise<void> {
    this.catalogReady ??= (async () => {
      if (await this.tableExists(client, this.catalogTable)) return;
      try {
        await client.query(createCatalogTableSql(this.catalogTable));
      } catch (err) {
        // Another process may have created it between the check and here.
        if (!(await this.tableExists(client, this.catalogTable))) throw err;
      }
    })().catch((err: unknown) => {
      this.catalogReady = undefined;
      throw err;
    });
    return this.catalogReady;
  }

  private async tableExists(client: PgClient, table: string): Promise<boolean> {
    const { rows } = await client.query(tableExistsSql(), [quoteIdent(table)]);
    return rows[0]?.present === true;
  }

  private async recordExists(
    client: PgClient,
    storeName: string,
  ): Promise<boolean> {
    const { rows } = await client.query(recordExistsSql(this.catalogTable), [
      storeName,
    ]);
    return rows.length > 0;
  }
}
