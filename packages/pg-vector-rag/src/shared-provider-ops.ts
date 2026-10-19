import type {
  RagCatalogDescription,
  RagCollectionRecord,
  RagProviderCreateCollectionOptions,
  Result,
} from '@mcp-abap-adt/llm-agent';
import {
  CatalogRecordDeleteError,
  describeRagCatalogRows,
  OrphanStoreError,
  RagError,
} from '@mcp-abap-adt/llm-agent';
import { deleteRecordSql, selectRecordsSql } from './catalog.js';
import {
  catalogRecordExists,
  duplicateRefusal,
  type PreparedCatalogPatch,
  updateCatalogRecord,
  writeCatalogRecord,
} from './catalog-record.js';
import type { PgClient } from './pg-vector-rag.js';
import { qualifiedTable } from './schema.js';
import { checkSharedTables } from './shared-check.js';
import { sharedStoreSql } from './store-sql.js';

export interface SharedProviderOpsConfig {
  catalogTable: string;
  documentsTable: string;
  schema?: string;
  dimension: number;
}

/**
 * The provider's operations on the `shared` layout: collection records live in
 * the catalog table, documents in the one shared documents table. Sends no DDL.
 * The first successful table check is memoised; a failed one is retried.
 */
export class SharedProviderOps {
  private checked = false;

  constructor(private readonly cfg: SharedProviderOpsConfig) {}

  /** Tables exist and the vector dimension matches; memoised on success. */
  async check(client: PgClient): Promise<Result<void, RagError>> {
    if (this.checked) return { ok: true, value: undefined };
    const result = await checkSharedTables(client, {
      schema: this.cfg.schema,
      tables: [this.cfg.catalogTable, this.cfg.documentsTable],
      documentsTable: this.cfg.documentsTable,
      dimension: this.cfg.dimension,
    });
    if (result.ok) this.checked = true;
    return result;
  }

  async describe(
    client: PgClient,
  ): Promise<Result<RagCatalogDescription, RagError>> {
    const ready = await this.check(client);
    if (!ready.ok) return ready;
    try {
      const { rows } = await client.query(
        selectRecordsSql(this.cfg.catalogTable, this.cfg.schema),
      );
      return { ok: true, value: describeRagCatalogRows(rows) };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'RAG_LIST_ERROR') };
    }
  }

  async create(
    client: PgClient,
    record: RagCollectionRecord,
    opts: RagProviderCreateCollectionOptions,
  ): Promise<Result<void, RagError>> {
    const ready = await this.check(client);
    if (!ready.ok) return ready;
    const name = record.storeName;
    try {
      if (await this.recordExists(client, name))
        return duplicateRefusal(name, opts);
      if (opts.adoptExisting !== true) {
        const count = this.store(name).countRows();
        const { rows } = await client.query(count.sql, count.params);
        if (Number(rows[0]?.n ?? 0) > 0) {
          return {
            ok: false,
            error: new OrphanStoreError(
              name,
              'documents exist for it without a record; take it over with adoptExisting, or remove them',
            ),
          };
        }
      }
      return await writeCatalogRecord(
        client,
        this.cfg.catalogTable,
        record,
        opts,
        (err) => ({
          ok: false,
          error: new RagError(String(err), 'RAG_CREATE_ERROR'),
        }),
        this.cfg.schema,
      );
    } catch (err) {
      return {
        ok: false,
        error: new RagError(String(err), 'RAG_CREATE_ERROR'),
      };
    }
  }

  /** Documents first, then the record: a failed delete leaves the record to retry. */
  async delete(
    client: PgClient,
    name: string,
  ): Promise<Result<void, RagError>> {
    const ready = await this.check(client);
    if (!ready.ok) return ready;
    try {
      const clear = this.store(name).clear();
      await client.query(clear.sql, clear.params);
    } catch (err) {
      return {
        ok: false,
        error: new RagError(String(err), 'RAG_DELETE_ERROR'),
      };
    }
    try {
      await client.query(
        deleteRecordSql(this.cfg.catalogTable, this.cfg.schema),
        [name],
      );
      return { ok: true, value: undefined };
    } catch (err) {
      return {
        ok: false,
        error: new CatalogRecordDeleteError(name, String(err)),
      };
    }
  }

  /** The memoised check first (its failure is returned unchanged), then one UPDATE. */
  async update(
    client: PgClient,
    storeName: string,
    patch: PreparedCatalogPatch,
  ): Promise<Result<void, RagError>> {
    const ready = await this.check(client);
    if (!ready.ok) return ready;
    try {
      return await updateCatalogRecord(
        client,
        this.cfg.catalogTable,
        storeName,
        patch,
        this.cfg.schema,
      );
    } catch (err) {
      return {
        ok: false,
        error: new RagError(String(err), 'RAG_UPDATE_ERROR'),
      };
    }
  }

  /** Sorted union of the catalog's stores and the collections holding documents. */
  async list(client: PgClient): Promise<Result<string[], RagError>> {
    const ready = await this.check(client);
    if (!ready.ok) return ready;
    try {
      const catalog = qualifiedTable(this.cfg.catalogTable, this.cfg.schema);
      const documents = qualifiedTable(
        this.cfg.documentsTable,
        this.cfg.schema,
      );
      const recorded = await client.query(
        `SELECT store_name AS "s" FROM ${catalog}`,
      );
      const stored = await client.query(
        `SELECT DISTINCT "collection" AS "c" FROM ${documents}`,
      );
      const names = new Set<string>([
        ...recorded.rows.map((r) => String(r.s)),
        ...stored.rows.map((r) => String(r.c)),
      ]);
      return { ok: true, value: [...names].sort() };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'RAG_LIST_ERROR') };
    }
  }

  private store(name: string) {
    return sharedStoreSql(name, this.cfg.documentsTable, this.cfg.schema);
  }

  private recordExists(client: PgClient, name: string): Promise<boolean> {
    return catalogRecordExists(
      client,
      this.cfg.catalogTable,
      name,
      this.cfg.schema,
    );
  }
}
