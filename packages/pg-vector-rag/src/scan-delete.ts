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

/** A driver transaction or a dedicated injected connection. */
export async function recordTransaction<T>(
  client: PgClient,
  work: (connection: PgClient) => Promise<T>,
): Promise<T> {
  if (client.transaction) return client.transaction(work);
  await client.query('BEGIN');
  try {
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

/** Lock only the matching record rows, then delete all their ordinals. */
export async function deleteWhere(
  client: PgClient,
  sql: PgStoreSql,
  filter: RagScanFilter,
  cache: StoreCache,
  signal?: AbortSignal,
): Promise<number> {
  const settled: Array<() => void> = [];
  try {
    return await recordTransaction(client, async (connection) => {
      const selection = sql.deleteWhere(filter);
      const { rows } = await connection.query(selection.sql, selection.params);
      signal?.throwIfAborted();
      const ids = rows.map((row) => String(row.id));
      if (!ids.length) return 0;
      settled.push(cache.beginWrite(ids));
      const deletion = sql.deleteByIds(ids);
      await connection.query(deletion.sql, deletion.params);
      signal?.throwIfAborted();
      return ids.length;
    });
  } finally {
    for (const done of settled) done();
  }
}

/** Clear the shared collection after all prior writes have committed. */
export async function clearRecords(
  client: PgClient,
  sql: PgStoreSql,
): Promise<void> {
  const statement = sql.clear();
  const lock = sql.lockForClear?.();
  if (lock === undefined) {
    await client.query(statement.sql, statement.params);
    return;
  }
  await recordTransaction(client, async (connection) => {
    await connection.query(lock);
    await connection.query(statement.sql, statement.params);
  });
}
