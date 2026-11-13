import { RagError, type Result } from '@mcp-abap-adt/llm-agent';
import { accessTableRuntimeDefinition, accessTables } from './access-ddl.js';
import { createCatalogTableSql, tableExistsSql } from './catalog.js';
import type { HanaVectorRagProvider } from './hana-vector-rag-provider.js';
import { quoteIdent } from './schema.js';

export async function migrateHanaVectorRagAccess(
  provider: HanaVectorRagProvider,
): Promise<
  Result<
    { reported: readonly { storeName: string; reason: string }[] },
    RagError
  >
> {
  try {
    const { client, catalogTable, schema } = await provider.accessPersistence();
    const exists = async (table: string) =>
      Number(
        (
          await client.query(
            tableExistsSql(Boolean(schema)),
            schema ? [schema, table] : [table],
          )
        )[0]?.n ?? 0,
      ) > 0;
    const create = async (table: string, ddl: string) => {
      if (await exists(table)) return;
      try {
        await client.exec(ddl);
      } catch (error) {
        if (!(await exists(table))) throw error;
      }
    };
    await create(catalogTable, createCatalogTableSql(catalogTable));
    const hasRole = async () =>
      (
        await client.query(
          `SELECT COLUMN_NAME FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = ${schema ? '?' : 'CURRENT_SCHEMA'} AND TABLE_NAME = ? AND COLUMN_NAME = 'ROLE_ID'`,
          schema ? [schema, catalogTable] : [catalogTable],
        )
      ).length > 0;
    if (!(await hasRole())) {
      try {
        await client.exec(
          `ALTER TABLE ${quoteIdent(catalogTable)} ADD (role_id NVARCHAR(5000))`,
        );
      } catch (error) {
        if (!(await hasRole())) throw error;
      }
    }
    for (const table of accessTables) {
      await create(
        table.name,
        `CREATE TABLE ${quoteIdent(table.name)} (${accessTableRuntimeDefinition(table)})`,
      );
    }
    const description = await provider.describeCollections();
    if (!description.ok) throw description.error;
    const recordReports = await provider.migrateRecordOwners();
    return {
      ok: true,
      value: {
        reported: [
          ...recordReports,
          ...description.value.rejected.map((row) => {
            if (row.storeName === undefined)
              throw new RagError(
                'Catalog row has no store name',
                'RAG_MIGRATION_ERROR',
              );
            return { storeName: row.storeName, reason: row.reason };
          }),
        ],
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: new RagError(String(error), 'RAG_MIGRATION_ERROR'),
    };
  }
}
