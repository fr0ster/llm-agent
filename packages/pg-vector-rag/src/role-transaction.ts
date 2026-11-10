import { RagError } from '@mcp-abap-adt/llm-agent';
import type { PgClient } from './pg-vector-rag.js';

/** Role ownership requires a transaction pinned to a single database connection. */
export function roleTransaction<T>(
  client: PgClient,
  work: (connection: PgClient) => Promise<T>,
): Promise<T> {
  if (!client.transaction) {
    return Promise.reject(
      new RagError(
        'Role persistence requires a transaction-capable client',
        'RAG_ACCESS_STORE_ERROR',
      ),
    );
  }
  return client.transaction(work);
}
