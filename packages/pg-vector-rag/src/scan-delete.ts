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
import type { StoreCache } from './record-cache.js';
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

/** Lock the selected ids, invalidate precisely those ids, and delete only that selection. */
export async function deleteWhere(
  client: PgClient,
  sql: PgStoreSql,
  filter: RagScanFilter,
  cache: StoreCache,
  signal?: AbortSignal,
): Promise<number> {
  const settled: Array<() => void> = [];
  const work = async (connection: PgClient): Promise<number> => {
    const stmt = sql.deleteWhere(filter);
    const selection = stmt.sql
      .replace(/^DELETE FROM /, 'SELECT "id" FROM ')
      .replace(/ RETURNING "id"$/, ' FOR UPDATE');
    const { rows } = await connection.query(selection, stmt.params);
    if (signal?.aborted) throw new RagError('Aborted', 'ABORTED');
    const ids = rows.map((row) => String(row.id));
    if (!ids.length) return 0;
    settled.push(cache.beginWrite(ids));
    const params = [...stmt.params, ids];
    // One array parameter avoids PostgreSQL's bind-parameter ceiling for large selections.
    const deletion = stmt.sql.replace(
      ' RETURNING "id"',
      ` AND "id" = ANY($${stmt.params.length + 1}::varchar[]) RETURNING "id"`,
    );
    return (await connection.query(deletion, params)).rows.length;
  };
  try {
    if (client.transaction) return await client.transaction(work);
    // Injected clients are dedicated connections when they do not supply a transaction runner.
    await client.query('BEGIN');
    try {
      const count = await work(client);
      await client.query('COMMIT');
      return count;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* Keep the original error. */
      }
      throw error;
    }
  } finally {
    for (const done of settled) done();
  }
}
