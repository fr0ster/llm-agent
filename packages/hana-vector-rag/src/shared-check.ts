import type { Result } from '@mcp-abap-adt/llm-agent';
import { RagError } from '@mcp-abap-adt/llm-agent';
import { tableExistsSql } from './catalog.js';
import type { HanaClient } from './hana-vector-rag.js';

const HINT =
  'Deploy the shared layout first (the package ddl/ files, or sharedLayoutSql()).';

/**
 * Startup check of the `shared` layout: the tables exist and the documents
 * table's `"VECTOR"` column has the configured dimension. Sends only SELECTs;
 * never the embedder. Memoising a success is the caller's job.
 */
export async function checkSharedTables(
  client: HanaClient,
  opts: {
    schema?: string;
    tables: string[];
    documentsTable: string;
    dimension: number;
  },
): Promise<Result<void, RagError>> {
  const fail = (message: string): Result<void, RagError> => ({
    ok: false,
    error: new RagError(`${message} ${HINT}`, 'SHARED_LAYOUT_NOT_DEPLOYED'),
  });
  try {
    const explicit = opts.schema !== undefined;
    const scope = (table: string): unknown[] =>
      explicit ? [opts.schema, table] : [table];
    for (const table of opts.tables) {
      const rows = await client.query(tableExistsSql(explicit), scope(table));
      if (Number(rows[0]?.n ?? 0) === 0)
        return fail(`Shared layout table "${table}" does not exist.`);
    }
    const dims = await client.query(
      `SELECT LENGTH AS "dim" FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = ${explicit ? '?' : 'CURRENT_SCHEMA'} AND TABLE_NAME = ? AND COLUMN_NAME = 'VECTOR'`,
      scope(opts.documentsTable),
    );
    const found = dims[0]?.dim;
    if (found === undefined || found === null)
      return fail(
        `Shared layout table "${opts.documentsTable}" has no "VECTOR" column.`,
      );
    if (Number(found) !== opts.dimension)
      return fail(
        `Shared layout table "${opts.documentsTable}" has vector dimension ${Number(found)}, but ${opts.dimension} is configured.`,
      );
    return { ok: true, value: undefined };
  } catch (err) {
    return {
      ok: false,
      error: new RagError(String(err), 'HEALTH_CHECK_ERROR'),
    };
  }
}
