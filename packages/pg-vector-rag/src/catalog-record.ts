import type {
  RagCollectionRecord,
  RagProviderCreateCollectionOptions,
  Result,
  ValidatedRagCatalogPatch,
} from '@mcp-abap-adt/llm-agent';
import {
  DuplicateCollectionError,
  encodeRagAttributes,
  RagError,
  ragCollectionNotFound,
  ragOwnerKeys,
} from '@mcp-abap-adt/llm-agent';
import {
  deleteRecordSql,
  insertRecordSql,
  recordExistsSql,
  tableExistsSql,
  updateRecordSql,
} from './catalog.js';
import type { PgClient } from './pg-vector-rag.js';
import { roleTransaction } from './role-transaction.js';
import { qualifiedTable } from './schema.js';

/** The refusal for a collection that already has a record. */
export function duplicateRefusal(
  storeName: string,
  opts: RagProviderCreateCollectionOptions,
): { ok: false; error: RagError } {
  return {
    ok: false,
    error: new DuplicateCollectionError(
      opts.collectionName ?? storeName,
      `store '${storeName}' already has a record`,
    ),
  };
}

export async function catalogRecordExists(
  client: PgClient,
  table: string,
  storeName: string,
  schema?: string,
): Promise<boolean> {
  const { rows } = await client.query(recordExistsSql(table, schema), [
    storeName,
  ]);
  return rows.length > 0;
}

/**
 * Inserts the collection's record. A failed insert that finds a record present
 * (a concurrent create) is a duplicate; any other failure goes to `onFailure`,
 * which says what it means for the layout.
 */
export async function writeCatalogRecord(
  client: PgClient,
  table: string,
  record: RagCollectionRecord,
  opts: RagProviderCreateCollectionOptions,
  onFailure: (err: unknown) => { ok: false; error: RagError },
  schema?: string,
): Promise<Result<void, RagError>> {
  const { userId, sessionId } = ragOwnerKeys(record);
  try {
    const insert = async (connection: PgClient) => {
      await connection.query(insertRecordSql(table, schema), [
        record.storeName,
        record.name,
        record.scope,
        userId ?? null,
        sessionId ?? null,
        encodeRagAttributes(record.attributes),
        null,
      ]);
    };
    await insert(client);
    return { ok: true, value: undefined };
  } catch (err) {
    if (err instanceof RagError) return { ok: false, error: err };
    if (
      await catalogRecordExists(client, table, record.storeName, schema).catch(
        () => false,
      )
    ) {
      return duplicateRefusal(record.storeName, opts);
    }
    return onFailure(err);
  }
}

/** One UPDATE; zero rows updated is a missing record, and nothing is created. */
export async function updateCatalogRecord(
  client: PgClient,
  table: string,
  storeName: string,
  patch: ValidatedRagCatalogPatch,
  schema?: string,
): Promise<Result<void, RagError>> {
  const { rowCount } = await client.query(updateRecordSql(table, schema), [
    patch.collectionName ?? null,
    patch.attributesJson ?? null,
    storeName,
  ]);
  if (!rowCount) return ragCollectionNotFound(storeName);
  return { ok: true, value: undefined };
}

/** Lock the catalog identity before removing grants, fencing concurrent bindCollection. */
export async function deleteCatalogRecord(
  client: PgClient,
  table: string,
  name: string,
  schema?: string,
): Promise<void> {
  const present = await client.query(tableExistsSql(), [
    qualifiedTable('rag_collection_roles', schema),
  ]);
  if (!present.rows[0]?.present) {
    await client.query(deleteRecordSql(table, schema), [name]);
    return;
  }
  await roleTransaction(client, async (connection) => {
    const { rows } = await connection.query(
      `SELECT collection_name FROM ${qualifiedTable(table, schema)} WHERE store_name = $1 FOR UPDATE`,
      [name],
    );
    for (const row of rows) {
      if (typeof row.collection_name !== 'string')
        throw new RagError(
          'Invalid collection identity',
          'RAG_ACCESS_STORE_ERROR',
        );
      await connection.query(
        `DELETE FROM ${qualifiedTable('rag_collection_roles', schema)} WHERE collection_name = $1`,
        [row.collection_name],
      );
    }
    await connection.query(deleteRecordSql(table, schema), [name]);
  });
}
