import type { Result } from '@mcp-abap-adt/llm-agent';
import { RagError } from '@mcp-abap-adt/llm-agent';
import { tableExistsSql } from './catalog.js';
import type { PgClient } from './pg-vector-rag.js';
import { qualifiedTable } from './schema.js';

const HINT =
  'Deploy the shared layout first (the package ddl/ files, or sharedLayoutSql()).';

/**
 * Startup check of the `shared` layout: the tables exist and the documents
 * table's `"vector"` column has the configured dimension. Sends only SELECTs;
 * never the embedder. Memoising a success is the caller's job.
 */
export async function checkSharedTables(
  client: PgClient,
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
    const qualified = (table: string): string =>
      qualifiedTable(table, opts.schema);
    for (const table of opts.tables) {
      const { rows } = await client.query(tableExistsSql(), [qualified(table)]);
      if (rows[0]?.present !== true)
        return fail(`Shared layout table "${table}" does not exist.`);
    }
    const { rows } = await client.query(
      `SELECT a.atttypmod AS "dim" FROM pg_attribute a WHERE a.attrelid = to_regclass($1) AND a.attname = 'vector' AND NOT a.attisdropped`,
      [qualified(opts.documentsTable)],
    );
    const found = rows[0]?.dim;
    if (found === undefined || found === null)
      return fail(
        `Shared layout table "${opts.documentsTable}" has no "vector" column.`,
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
