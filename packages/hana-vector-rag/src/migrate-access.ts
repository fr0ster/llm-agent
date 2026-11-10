import {
  describeRagCatalogRows,
  RagError,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import {
  createCatalogTableSql,
  selectRecordsSql,
  tableExistsSql,
} from './catalog.js';
import type { HanaVectorRagProvider } from './hana-vector-rag-provider.js';
import { decodeLob } from './lob.js';
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
    await create(
      'rag_roles',
      'CREATE TABLE "rag_roles" (role_id NVARCHAR(500) PRIMARY KEY, name NVARCHAR(5000) NOT NULL, description NVARCHAR(5000))',
    );
    await create(
      'rag_role_assignments',
      'CREATE TABLE "rag_role_assignments" (user_id NVARCHAR(500) NOT NULL, role_id NVARCHAR(500) NOT NULL, PRIMARY KEY (user_id, role_id), FOREIGN KEY (role_id) REFERENCES "rag_roles" (role_id))',
    );
    await create(
      'rag_session_bindings',
      'CREATE TABLE "rag_session_bindings" (session_id NVARCHAR(500) PRIMARY KEY, user_id NVARCHAR(500) NOT NULL)',
    );
    const description = describeRagCatalogRows(
      (await client.query(selectRecordsSql(catalogTable))).map((row) => ({
        ...row,
        attributesJson: Buffer.isBuffer(row.attributesJson)
          ? decodeLob(row.attributesJson)
          : row.attributesJson,
      })),
    );
    const recordReports = await provider.migrateRecordOwners();
    return {
      ok: true,
      value: {
        reported: [
          ...recordReports,
          ...description.rejected.map((row) => {
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
