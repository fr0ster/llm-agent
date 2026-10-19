import {
  DEFAULT_SCAN_PAGE_SIZE,
  decodeIdScanCursor,
  encodeIdScanCursor,
  INVALID_ARGUMENT,
  RagError,
  type RagScanFilter,
  type RagScanPage,
  type RagScanRecord,
} from '@mcp-abap-adt/llm-agent';
import type { PgClient } from './pg-vector-rag.js';
import type { PgStoreSql } from './store-sql.js';
import { withId } from './with-id.js';

function toRecord(row: Record<string, unknown>): RagScanRecord {
  return {
    id: String(row.id),
    text: String(row.text ?? ''),
    metadata: withId(row),
  };
}

/**
 * One page by key-set cursor on `"id"`, the filter applied in SQL. A full page
 * keeps the cursor, a short one ends the scan.
 */
export async function scanPage(
  client: PgClient,
  sql: PgStoreSql,
  opts?: { filter?: RagScanFilter; pageSize?: number; cursor?: string },
): Promise<RagScanPage> {
  const limit = opts?.pageSize ?? DEFAULT_SCAN_PAGE_SIZE;
  const after =
    opts?.cursor === undefined ? undefined : decodeIdScanCursor(opts.cursor);
  if (opts?.cursor !== undefined && after === undefined)
    throw new RagError('Invalid scan cursor', INVALID_ARGUMENT);
  const stmt = sql.scanPage(after, limit, opts?.filter);
  const { rows } = await client.query(stmt.sql, stmt.params);
  const records = rows.map(toRecord);
  const last = rows[rows.length - 1];
  return rows.length >= limit && last
    ? { records, cursor: encodeIdScanCursor(String(last.id)) }
    : { records };
}

/** One `DELETE ... RETURNING "id"`; the count is the rows it returned. */
export async function deleteWhere(
  client: PgClient,
  sql: PgStoreSql,
  filter: RagScanFilter,
): Promise<number> {
  const stmt = sql.deleteWhere(filter);
  const { rows } = await client.query(stmt.sql, stmt.params);
  return rows.length;
}
