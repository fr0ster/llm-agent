import {
  describeRagCatalogRows,
  RagError,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import { catalogColumnsSql, selectRecordsSql } from './catalog.js';
import type { PgVectorRagProvider } from './pg-vector-rag-provider.js';
import { qualifiedTable } from './schema.js';

export async function migratePgVectorRagAccess(
  provider: PgVectorRagProvider,
): Promise<
  Result<
    { reported: readonly { storeName: string; reason: string }[] },
    RagError
  >
> {
  try {
    const { client, catalogTable, schema } = await provider.accessPersistence();
    const catalog = qualifiedTable(catalogTable, schema);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${catalog} (${catalogColumnsSql()})`,
    );
    await client.query(
      `ALTER TABLE ${catalog} ADD COLUMN IF NOT EXISTS role_id TEXT`,
    );
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable('rag_roles', schema)} (role_id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT)`,
    );
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable('rag_role_assignments', schema)} (user_id TEXT NOT NULL, role_id TEXT NOT NULL REFERENCES ${qualifiedTable('rag_roles', schema)}(role_id) ON DELETE CASCADE, PRIMARY KEY (user_id, role_id))`,
    );
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable('rag_session_bindings', schema)} (session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL)`,
    );
    const { rows } = await client.query(selectRecordsSql(catalogTable, schema));
    const description = describeRagCatalogRows(rows);
    return {
      ok: true,
      value: {
        reported: description.rejected.map((row) => {
          if (row.storeName === undefined)
            throw new RagError(
              'Catalog row has no store name',
              'RAG_MIGRATION_ERROR',
            );
          return { storeName: row.storeName, reason: row.reason };
        }),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: new RagError(String(error), 'RAG_MIGRATION_ERROR'),
    };
  }
}
