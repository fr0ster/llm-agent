import {
  DEFAULT_SCAN_PAGE_SIZE,
  decodeIdScanCursor,
  encodeIdScanCursor,
  INVALID_ARGUMENT,
  matchesScanFilter,
  RagError,
  type RagScanFilter,
  type RagScanPage,
  type RagScanRecord,
} from '@mcp-abap-adt/llm-agent';
import type { HanaClient } from './hana-vector-rag.js';
import { decodeLob, withId } from './lob.js';
import type { StoreCache } from './record-cache.js';
import type { HanaStoreSql } from './store-sql.js';

/** Ids per `DELETE ... IN (...)`. */
export const DELETE_BATCH_SIZE = 1000;

function toRecord(row: Record<string, unknown>): RagScanRecord {
  return {
    id: String(row.id),
    text: decodeLob(row.text),
    metadata: withId(row),
  };
}

/**
 * One page by key-set cursor on `"ID"`. The filter is applied to the page in
 * the client, so a page may come back short or empty; a full SQL page keeps
 * the cursor, a short one ends the scan.
 */
export async function scanPage(
  client: HanaClient,
  sql: HanaStoreSql,
  opts?: { filter?: RagScanFilter; pageSize?: number; cursor?: string },
): Promise<RagScanPage> {
  const limit = Math.max(
    1,
    Math.floor(opts?.pageSize ?? DEFAULT_SCAN_PAGE_SIZE),
  );
  const after =
    opts?.cursor === undefined ? undefined : decodeIdScanCursor(opts.cursor);
  if (opts?.cursor !== undefined && after === undefined)
    throw new RagError('Invalid scan cursor', INVALID_ARGUMENT);
  const stmt = sql.scanPage(after, limit);
  const rows = await client.query(stmt.sql, stmt.params);
  const records = rows
    .map(toRecord)
    .filter((r) => matchesScanFilter(r.metadata, opts?.filter));
  const last = rows[rows.length - 1];
  return rows.length >= limit && last
    ? { records, cursor: encodeIdScanCursor(String(last.id)) }
    : { records };
}

/** Scans everything, then deletes the matching ids in batches; returns the count. */
export async function deleteWhere(
  client: HanaClient,
  sql: HanaStoreSql,
  filter: RagScanFilter,
  signal?: AbortSignal,
  cache?: StoreCache,
): Promise<number> {
  const ids: string[] = [];
  let deleted = 0;
  const checkAbort = (): void => {
    if (signal?.aborted)
      throw new RagError(
        `Aborted after deleting ${deleted} record(s)`,
        'ABORTED',
      );
  };
  let cursor: string | undefined;
  do {
    checkAbort();
    const page = await scanPage(client, sql, { filter, cursor });
    for (const r of page.records) ids.push(r.id);
    cursor = page.cursor;
  } while (cursor !== undefined);
  for (let i = 0; i < ids.length; i += DELETE_BATCH_SIZE) {
    checkAbort();
    const batch = ids.slice(i, i + DELETE_BATCH_SIZE);
    const stmt = sql.deleteByIds(batch);
    const settled = cache?.beginWrite(batch);
    try {
      deleted += (await client.exec(stmt.sql, stmt.params)).rowCount;
    } finally {
      settled?.();
    }
  }
  return deleted;
}
