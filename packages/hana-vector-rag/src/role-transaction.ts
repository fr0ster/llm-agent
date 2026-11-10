import { RagError } from '@mcp-abap-adt/llm-agent';
import type { HanaClient } from './hana-vector-rag.js';

export function roleTransaction<T>(
  client: HanaClient,
  work: (connection: HanaClient) => Promise<T>,
): Promise<T> {
  if (!client.transaction)
    return Promise.reject(
      new RagError(
        'Access persistence requires a transaction-capable client',
        'RAG_ACCESS_STORE_ERROR',
      ),
    );
  return client.transaction(work);
}

/** Serialize all work on a driver connection; transaction callbacks use its pinned raw client. */
export function transactionalHanaClient(
  raw: HanaClient,
  setAutoCommit: (enabled: boolean) => void,
): HanaClient {
  let tail = Promise.resolve();
  let poisoned = false;
  async function poison(): Promise<void> {
    poisoned = true;
    await raw.close().catch(() => {});
  }
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(() => {
      if (poisoned)
        throw new RagError(
          'Transaction connection is unusable',
          'RAG_ACCESS_STORE_ERROR',
        );
      return work();
    });
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async function restoreAutoCommit(): Promise<void> {
    if (poisoned) return;
    try {
      setAutoCommit(true);
    } catch (error) {
      await poison();
      throw error;
    }
  }
  async function execute<T>(
    work: (connection: HanaClient) => Promise<T>,
  ): Promise<T> {
    try {
      setAutoCommit(false);
    } catch (error) {
      await poison();
      throw error;
    }
    let result: T;
    try {
      result = await work(raw);
      await raw.exec('COMMIT');
    } catch (error) {
      try {
        await raw.exec('ROLLBACK');
      } catch (rollbackError) {
        await poison();
        throw rollbackError;
      }
      await restoreAutoCommit();
      throw error;
    }
    await restoreAutoCommit();
    return result;
  }
  return {
    exec: (sql, params) => exclusive(() => raw.exec(sql, params)),
    query: (sql, params) => exclusive(() => raw.query(sql, params)),
    close: () => exclusive(() => raw.close()),
    transaction: (work) => exclusive(() => execute(work)),
  };
}
