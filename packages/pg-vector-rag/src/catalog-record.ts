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
  validateRagAttributes,
} from '@mcp-abap-adt/llm-agent';
import {
  insertRecordSql,
  recordExistsSql,
  updateRecordSql,
} from './catalog.js';
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
  // The create path's check, before anything is encoded or sent: an
  // un-encodable value (NaN, undefined, Date, BigInt, a cycle) is refused
  // here rather than rewritten or thrown out of the Result.
  const attributes = validateRagAttributes(patch.attributes);
  if (!attributes.ok) return attributes;
  return {
    ok: true,
    value: {
      collectionName: patch.collectionName ?? null,
      // The same encoding the create path writes.
      attributesJson: encodeRagAttributes(attributes.value),
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
  client: PgClient,
  table: string,
  storeName: string,
  patch: PreparedCatalogPatch,
  schema?: string,
): Promise<Result<void, RagError>> {
  const { rowCount } = await client.query(updateRecordSql(table, schema), [
    patch.collectionName,
    patch.attributesJson,
    storeName,
  ]);
  if (!rowCount) return collectionNotFound(storeName);
  return { ok: true, value: undefined };
}
