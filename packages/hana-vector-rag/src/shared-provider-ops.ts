import type {
  RagCatalogDescription,
  RagCatalogRow,
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
import type { HanaClient } from './hana-vector-rag.js';
import { quoteIdent } from './schema.js';
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
  async check(client: HanaClient): Promise<Result<void, RagError>> {
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
    client: HanaClient,
    decode: (row: Record<string, unknown>) => RagCatalogRow,
  ): Promise<Result<RagCatalogDescription, RagError>> {
    const ready = await this.check(client);
    if (!ready.ok) return ready;
    try {
      const rows = await client.query(selectRecordsSql(this.cfg.catalogTable));
      return { ok: true, value: describeRagCatalogRows(rows.map(decode)) };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'RAG_LIST_ERROR') };
    }
  }

  async create(
    client: HanaClient,
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
        const count = sharedStoreSql(name, this.cfg.documentsTable).countRows();
        const rows = await client.query(count.sql, count.params);
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
    client: HanaClient,
    name: string,
  ): Promise<Result<void, RagError>> {
    const ready = await this.check(client);
    if (!ready.ok) return ready;
    try {
      const clear = sharedStoreSql(name, this.cfg.documentsTable).clear();
      await client.exec(clear.sql, clear.params);
    } catch (err) {
      return {
        ok: false,
        error: new RagError(String(err), 'RAG_DELETE_ERROR'),
      };
    }
    try {
      await client.exec(deleteRecordSql(this.cfg.catalogTable), [name]);
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
    client: HanaClient,
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
      );
    } catch (err) {
      return {
        ok: false,
        error: new RagError(String(err), 'RAG_UPDATE_ERROR'),
      };
    }
  }

  /** Sorted union of the catalog's stores and the collections holding documents. */
  async list(client: HanaClient): Promise<Result<string[], RagError>> {
    const ready = await this.check(client);
    if (!ready.ok) return ready;
    try {
      const recorded = await client.query(
        `SELECT store_name AS "s" FROM ${quoteIdent(this.cfg.catalogTable)}`,
      );
      const stored = await client.query(
        `SELECT DISTINCT "COLLECTION" AS "c" FROM ${quoteIdent(this.cfg.documentsTable)}`,
      );
      const names = new Set<string>([
        ...recorded.map((r) => String(r.s)),
        ...stored.map((r) => String(r.c)),
      ]);
      return { ok: true, value: [...names].sort() };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'RAG_LIST_ERROR') };
    }
  }

  private recordExists(client: HanaClient, name: string): Promise<boolean> {
    return catalogRecordExists(client, this.cfg.catalogTable, name);
  }
}
