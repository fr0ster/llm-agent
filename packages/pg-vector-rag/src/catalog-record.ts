import type {
  RagCollectionRecord,
  RagProviderCreateCollectionOptions,
  Result,
} from '@mcp-abap-adt/llm-agent';
import {
  DuplicateCollectionError,
  encodeRagAttributes,
  type RagError,
  ragOwnerKeys,
} from '@mcp-abap-adt/llm-agent';
import { insertRecordSql, recordExistsSql } from './catalog.js';
import type { PgClient } from './pg-vector-rag.js';

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
    await client.query(insertRecordSql(table, schema), [
      record.storeName,
      record.name,
      record.scope,
      userId ?? null,
      sessionId ?? null,
      encodeRagAttributes(record.attributes),
    ]);
    return { ok: true, value: undefined };
  } catch (err) {
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
