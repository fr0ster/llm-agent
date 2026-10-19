import {
  DEFAULT_SCAN_PAGE_SIZE,
  matchesScanFilter,
  type RagMetadata,
  type RagScanFilter,
  type RagScanPage,
  type RagScanRecord,
} from '@mcp-abap-adt/llm-agent';
import type { HanaClient } from './hana-vector-rag.js';
import { decodeLob } from './lob.js';
import type { HanaStoreSql } from './store-sql.js';

/** Ids per `DELETE ... IN (...)`. */
export const DELETE_BATCH_SIZE = 1000;

/** The id is the `ID` column's, as `withId` puts it back for reads. */
function toRecord(row: Record<string, unknown>): RagScanRecord {
  const raw = decodeLob(row.metadata);
  const parsed = raw ? (JSON.parse(raw) as RagMetadata) : {};
  const id = String(row.id);
  return { id, text: decodeLob(row.text), metadata: { ...parsed, id } };
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
  const stmt = sql.scanPage(opts?.cursor, limit);
  const rows = await client.query(stmt.sql, stmt.params);
  const records = rows
    .map(toRecord)
    .filter((r) => matchesScanFilter(r.metadata, opts?.filter));
  const last = rows[rows.length - 1];
  return rows.length >= limit && last
    ? { records, cursor: String(last.id) }
    : { records };
}

/** Scans everything, then deletes the matching ids in batches; returns the count. */
export async function deleteWhere(
  client: HanaClient,
  sql: HanaStoreSql,
  filter: RagScanFilter,
  signal?: AbortSignal,
): Promise<number> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = await scanPage(client, sql, { filter, cursor });
    for (const r of page.records) ids.push(r.id);
    cursor = page.cursor;
  } while (cursor !== undefined);
  let deleted = 0;
  for (let i = 0; i < ids.length; i += DELETE_BATCH_SIZE) {
    signal?.throwIfAborted();
    const stmt = sql.deleteByIds(ids.slice(i, i + DELETE_BATCH_SIZE));
    deleted += (await client.exec(stmt.sql, stmt.params)).rowCount;
  }
  return deleted;
}
