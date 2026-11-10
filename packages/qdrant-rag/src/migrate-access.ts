import { RagError, type Result } from '@mcp-abap-adt/llm-agent';
import type { QdrantRagProvider } from './qdrant-rag-provider.js';

export async function migrateQdrantRagAccess(
  provider: QdrantRagProvider,
): Promise<
  Result<
    { reported: readonly { storeName: string; reason: string }[] },
    RagError
  >
> {
  try {
    await provider.accessPersistence();
    // Payload keys are schemaless: role_id is optional for existing non-role owners.
    const recordReports = await provider.migrateRecordOwners();
    const description = await provider.describeCollections();
    if (!description.ok) return description;
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
