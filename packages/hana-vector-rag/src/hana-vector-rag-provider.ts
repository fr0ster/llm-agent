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
  Result,
} from '@mcp-abap-adt/llm-agent';
import {
  AbstractRagProvider,
  CatalogRecordDeleteError,
  describeRagCatalogRows,
  OrphanStoreError,
  RagError,
  ragCollectionNotFound,
  validateRagCatalogPatch,
  validateRagOwner,
  validateRagStoreName,
} from '@mcp-abap-adt/llm-agent';
import {
  createCatalogTableSql,
  DEFAULT_CATALOG_TABLE,
  deleteRecordSql,
  probeTableSql,
  selectRecordsSql,
  tableExistsSql,
} from './catalog.js';
import {
  catalogRecordExists,
  duplicateRefusal,
  updateCatalogRecord,
  writeCatalogRecord,
} from './catalog-record.js';
import type { HanaVectorRagConfig } from './connection.js';
import {
  createHanaClient,
  type HanaClient,
  HanaVectorRag,
} from './hana-vector-rag.js';
import { resolveLayout } from './layout.js';
import { decodeLob } from './lob.js';
import {
  assertCollectionName,
  createTableSql,
  dropTableSql,
} from './schema.js';
import { SHARED_CATALOG_TABLE, SHARED_DOCUMENTS_TABLE } from './shared-ddl.js';
import { SharedProviderOps } from './shared-provider-ops.js';

type Handles = { rag: IRag; editor: IRagEditor };
type Refusal = { ok: false; error: RagError };

export interface HanaVectorRagProviderConfig {
  name: string;
  embedder: IRetrievalEmbedder;
  /**
   * No `string` shorthand here, unlike pg-vector: that shorthand is
   * address-only, HANA has no anonymous login, and a type arm that can only
   * throw is a lie in the type. `pg-vector` keeps its shorthand because a
   * credential is genuinely optional there (trust authentication,
   * `PGUSER`/`PGPASSWORD`); HANA's `credential` is required, so the compiler
   * refuses the shorthand rather than a connect-time throw reporting it.
   * `normalizeConnection` still rejects a string at runtime, for callers with
   * no types to check.
   */
  connection: HanaVectorRagConfig;
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
   * opens one connection of its own from `connection` for its statements, and
   * each handle opens its own on first use. Recommended — returning one shared
   * client — wherever collections are hydrated per session, which opens every
   * record's handle for every session.
   */
  clientFactory?: () => HanaClient;
  /**
   * The table holding one record per collection. Default
   * `rag_collection_catalog`; `RAG_COLLECTIONS` in the `shared` layout.
   */
  catalogTable?: string;
  /**
   * `per-collection` (default): one table per collection. `shared`: one
   * documents table for all collections, deployed outside the app — no DDL
   * ever runs, and `autoCreateSchema: true` is refused.
   */
  layout?: 'per-collection' | 'shared';
  /** Documents table of the `shared` layout. Default `RAG_DOCUMENTS`. */
  documentsTable?: string;
}

function normalizeConnection(
  c: HanaVectorRagConfig | string,
): HanaVectorRagConfig {
  if (typeof c === 'string') {
    throw new Error(
      'HanaVectorRagProviderConfig.connection as a bare string is not supported: ' +
        'it cannot carry a credential, and HANA requires one. Pass ' +
        '{ connectionString, credential: staticLogin(user, password) } instead.',
    );
  }
  return c;
}

/** HANA may hand an NCLOB back as a Buffer; the row check expects text. */
function decodeRow(row: Record<string, unknown>): RagCatalogRow {
  const json = row.attributesJson;
  return {
    ...row,
    attributesJson: Buffer.isBuffer(json) ? decodeLob(json) : json,
  };
}

export class HanaVectorRagProvider
  extends AbstractRagProvider
  implements IRagCatalogUpdater
{
  readonly name: string;
  readonly kind = 'vector';
  readonly editable: boolean;
  readonly supportedScopes: readonly RagCollectionScope[];

  private readonly embedder: IRetrievalEmbedder;
  private readonly connection: HanaVectorRagConfig;
  private readonly defaultDimension: number;
  private readonly autoCreateSchema: boolean;
  private readonly clientFactory?: () => HanaClient;
  private readonly catalogTable: string;
  private readonly layout: 'per-collection' | 'shared';
  private readonly documentsTable: string;
  private readonly shared?: SharedProviderOps;
  private ownClient?: Promise<HanaClient>;
  private catalogReady?: Promise<void>;

  constructor(cfg: HanaVectorRagProviderConfig) {
    super();
    this.name = cfg.name;
    this.embedder = cfg.embedder;
    this.connection = normalizeConnection(cfg.connection);
    this.defaultDimension = cfg.defaultDimension ?? 1536;
    this.layout = resolveLayout(cfg.layout, cfg.autoCreateSchema);
    const shared = this.layout === 'shared';
    this.documentsTable = cfg.documentsTable ?? SHARED_DOCUMENTS_TABLE;
    this.autoCreateSchema = cfg.autoCreateSchema ?? !shared;
    this.editable = cfg.editable ?? true;
    this.supportedScopes = cfg.supportedScopes ?? ['session', 'user', 'global'];
    this.clientFactory = cfg.clientFactory;
    this.catalogTable =
      cfg.catalogTable ??
      (shared ? SHARED_CATALOG_TABLE : DEFAULT_CATALOG_TABLE);
    assertCollectionName(this.catalogTable);
    if (shared) {
      assertCollectionName(this.documentsTable);
      this.shared = new SharedProviderOps({
        catalogTable: this.catalogTable,
        documentsTable: this.documentsTable,
        schema: this.connection.schema,
        dimension: this.dimension(),
      });
    }
    if (cfg.idStrategyFactory) this.idStrategyFactory = cfg.idStrategyFactory;
  }

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
      if (this.shared) {
        const created = await this.shared.create(
          client,
          {
            ...checked.value,
            storeName: name,
            name: opts.collectionName ?? name,
            attributes: opts.attributes,
          },
          opts,
        );
        if (!created.ok) return created;
        return { ok: true, value: this.handles(name, checked.value) };
      }
      if (this.autoCreateSchema) await this.ensureCatalog(client);
      if (await this.recordExists(client, name))
        return this.duplicate(name, opts);
      if (opts.adoptExisting === true || !this.autoCreateSchema) {
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

  async describeCollections(): Promise<
    Result<RagCatalogDescription, RagError>
  > {
    try {
      const client = await this.adminClient();
      if (this.shared) return await this.shared.describe(client, decodeRow);
      if (!(await this.tableExists(client, this.catalogTable))) {
        return { ok: true, value: { records: [], rejected: [] } };
      }
      const rows = await client.query(selectRecordsSql(this.catalogTable));
      return { ok: true, value: describeRagCatalogRows(rows.map(decodeRow)) };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'RAG_LIST_ERROR') };
    }
  }

  /**
   * Updates the display name and/or replaces the attributes of one record.
   * An empty patch is refused before any statement; `shared` runs its memoised
   * table check first. A missing record is RAG_COLLECTION_NOT_FOUND.
   */
  async updateCollection(
    storeName: string,
    patch: RagCatalogPatch,
  ): Promise<Result<void, RagError>> {
    const name = validateRagStoreName(storeName);
    if (!name.ok) return name;
    const prepared = validateRagCatalogPatch(patch);
    if (!prepared.ok) return prepared;
    try {
      const client = await this.adminClient();
      if (this.shared)
        return await this.shared.update(client, storeName, prepared.value);
      if (!(await this.tableExists(client, this.catalogTable)))
        return ragCollectionNotFound(storeName);
      return await updateCatalogRecord(
        client,
        this.catalogTable,
        storeName,
        prepared.value,
      );
    } catch (err) {
      return {
        ok: false,
        error: new RagError(String(err), 'RAG_UPDATE_ERROR'),
      };
    }
  }

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

  async deleteCollection(name: string): Promise<Result<void, RagError>> {
    const refused = this.refuseCatalogName(name);
    if (refused) return refused;
    let client: HanaClient;
    try {
      client = await this.adminClient();
      if (this.shared) return await this.shared.delete(client, name);
      if (await this.tableExists(client, this.catalogTable)) {
        await client.exec(deleteRecordSql(this.catalogTable), [name]);
      }
    } catch (err) {
      return {
        ok: false,
        error: new CatalogRecordDeleteError(name, String(err)),
      };
    }
    try {
      await client.exec(dropTableSql(name));
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
      if (this.shared) return await this.shared.list(client);
      const rows = await client.query(
        this.connection.schema
          ? 'SELECT TABLE_NAME FROM SYS.TABLES WHERE SCHEMA_NAME = ?'
          : 'SELECT TABLE_NAME FROM SYS.TABLES WHERE SCHEMA_NAME = CURRENT_SCHEMA',
        this.connection.schema ? [this.connection.schema] : [],
      );
      return {
        ok: true,
        value: rows
          .map((r) => String(r.TABLE_NAME))
          .filter((t) => t !== this.catalogTable),
      };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'RAG_LIST_ERROR') };
    }
  }

  private async createStore(
    client: HanaClient,
    name: string,
    opts: RagProviderCreateCollectionOptions,
  ): Promise<Result<void, RagError>> {
    try {
      await client.exec(
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

  private writeRecord(
    client: HanaClient,
    record: RagCollectionRecord,
    opts: RagProviderCreateCollectionOptions,
  ): Promise<Result<void, RagError>> {
    return writeCatalogRecord(
      client,
      this.catalogTable,
      record,
      opts,
      (err) => ({
        ok: false,
        error: new OrphanStoreError(
          record.storeName,
          `its record could not be written (${String(err)}); the store is left in place until it is adopted with adoptExisting or removed`,
        ),
      }),
    );
  }

  private handles(storeName: string, owner: RagCollectionOwner): Handles {
    const rag = new HanaVectorRag(
      {
        ...this.connection,
        collectionName: storeName,
        dimension: this.dimension(),
        // No handle creates its store: createCollection does, and only it.
        autoCreateSchema: false,
        layout: this.layout,
        documentsTable: this.documentsTable,
        embedder: this.embedder,
      },
      this.clientFactory?.(),
    );
    return { rag, editor: this.buildEditor(rag, this.pickIdStrategy(owner)) };
  }

  private duplicate(
    storeName: string,
    opts: RagProviderCreateCollectionOptions,
  ): Refusal {
    return duplicateRefusal(storeName, opts);
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

  private async adminClient(): Promise<HanaClient> {
    if (this.clientFactory) return this.clientFactory();
    this.ownClient ??= createHanaClient(this.connection).catch(
      (err: unknown) => {
        this.ownClient = undefined;
        throw err;
      },
    );
    return this.ownClient;
  }

  private ensureCatalog(client: HanaClient): Promise<void> {
    this.catalogReady ??= (async () => {
      if (await this.tableExists(client, this.catalogTable)) return;
      try {
        await client.exec(createCatalogTableSql(this.catalogTable));
      } catch (err) {
        if (!(await this.tableExists(client, this.catalogTable))) throw err;
      }
    })().catch((err: unknown) => {
      this.catalogReady = undefined;
      throw err;
    });
    return this.catalogReady;
  }

  private async tableExists(
    client: HanaClient,
    table: string,
  ): Promise<boolean> {
    const schema = this.connection.schema;
    const rows = await client.query(
      tableExistsSql(Boolean(schema)),
      schema ? [schema, table] : [table],
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }

  private recordExists(
    client: HanaClient,
    storeName: string,
  ): Promise<boolean> {
    return catalogRecordExists(client, this.catalogTable, storeName);
  }
}
