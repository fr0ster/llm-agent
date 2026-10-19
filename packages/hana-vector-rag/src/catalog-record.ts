import type {
  RagCatalogPatch,
  RagCollectionRecord,
  RagProviderCreateCollectionOptions,
  Result,
} from '@mcp-abap-adt/llm-agent';
import {
  DuplicateCollectionError,
  encodeRagAttributes,
  INVALID_ARGUMENT,
  RAG_COLLECTION_NOT_FOUND,
  RagError,
  ragOwnerKeys,
} from '@mcp-abap-adt/llm-agent';
import {
  insertRecordSql,
  recordExistsSql,
  updateRecordSql,
} from './catalog.js';
import type { HanaClient } from './hana-vector-rag.js';

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
  client: HanaClient,
  table: string,
  storeName: string,
): Promise<boolean> {
  const rows = await client.query(recordExistsSql(table), [storeName]);
  return rows.length > 0;
}

/**
 * Inserts the collection's record. A failed insert that finds a record present
 * (a concurrent create) is a duplicate; any other failure goes to `onFailure`,
 * which says what it means for the layout.
 */
export async function writeCatalogRecord(
  client: HanaClient,
  table: string,
  record: RagCollectionRecord,
  opts: RagProviderCreateCollectionOptions,
  onFailure: (err: unknown) => { ok: false; error: RagError },
): Promise<Result<void, RagError>> {
  const { userId, sessionId } = ragOwnerKeys(record);
  try {
    await client.exec(insertRecordSql(table), [
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
      await catalogRecordExists(client, table, record.storeName).catch(
        () => false,
      )
    ) {
      return duplicateRefusal(record.storeName, opts);
    }
    return onFailure(err);
  }
}

/** A patch as the UPDATE binds it: NULL keeps the column. */
export interface PreparedCatalogPatch {
  collectionName: string | null;
  attributesJson: string | null;
}

/** Refuses an empty patch (no key, or only undefined values) before any call. */
export function prepareCatalogPatch(
  patch: RagCatalogPatch,
): Result<PreparedCatalogPatch, RagError> {
  if (patch.collectionName === undefined && patch.attributes === undefined) {
    return {
      ok: false,
      error: new RagError(
        'updateCollection needs collectionName or attributes',
        INVALID_ARGUMENT,
      ),
    };
  }
  return {
    ok: true,
    value: {
      collectionName: patch.collectionName ?? null,
      // The same encoding the create path writes.
      attributesJson: encodeRagAttributes(
        patch.attributes as Parameters<typeof encodeRagAttributes>[0],
      ),
    },
  };
}

export function collectionNotFound(storeName: string): {
  ok: false;
  error: RagError;
} {
  return {
    ok: false,
    error: new RagError(
      `no catalog record for store '${storeName}'`,
      RAG_COLLECTION_NOT_FOUND,
    ),
  };
}

/** One UPDATE; zero rows updated is a missing record, and nothing is created. */
export async function updateCatalogRecord(
  client: HanaClient,
  table: string,
  storeName: string,
  patch: PreparedCatalogPatch,
): Promise<Result<void, RagError>> {
  const { rowCount } = await client.exec(updateRecordSql(table), [
    patch.collectionName,
    patch.attributesJson,
    storeName,
  ]);
  if (rowCount === 0) return collectionNotFound(storeName);
  return { ok: true, value: undefined };
}
