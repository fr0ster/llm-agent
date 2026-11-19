import { addAbortListener } from 'node:events';
import { RagError } from '@mcp-abap-adt/llm-agent';
import type { PgClient } from './pg-vector-rag.js';

class SingleConnectionClient implements PgClient {
  private readonly waiting = new Set<() => Promise<void>>();
  private running = false;

  constructor(private readonly raw: PgClient) {}

  query: PgClient['query'] = (sql, params) =>
    this.run((client) => client.query(sql, params));

  end(): Promise<void> {
    return this.run((client) => client.end());
  }

  run<T>(
    work: (connection: PgClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const abortSignal = signal instanceof AbortSignal ? signal : undefined;
    return new Promise<T>((resolve, reject) => {
      if (abortSignal?.aborted) {
        reject(new RagError('Aborted', 'ABORTED'));
        return;
      }
      const abort =
        abortSignal &&
        addAbortListener(abortSignal, () => {
          this.waiting.delete(start);
          reject(new RagError('Aborted', 'ABORTED'));
        });
      const start = async () => {
        abort?.[Symbol.dispose]();
        try {
          resolve(await work(this.raw));
        } catch (error) {
          reject(error);
        }
      };
      this.waiting.add(start);
      if (!this.running) void this.drain();
    });
  }

  private async drain(): Promise<void> {
    this.running = true;
    for (const start of this.waiting) {
      this.waiting.delete(start);
      await start();
    }
    this.running = false;
  }
}

const connections = new WeakMap<PgClient, SingleConnectionClient>();

/** Share the FIFO across all handles using the same injected connection. */
export function serializePgClient(client: PgClient): PgClient {
  if (client.transaction || client instanceof SingleConnectionClient)
    return client;
  let connection = connections.get(client);
  if (!connection) {
    connection = new SingleConnectionClient(client);
    connections.set(client, connection);
  }
  return connection;
}

/** The callback gets the raw connection while it owns the queue. */
export function withPgConnection<T>(
  client: PgClient,
  work: (connection: PgClient) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return client instanceof SingleConnectionClient
    ? client.run(work, signal)
    : work(client);
}

export function queryPg(
  client: PgClient,
  sql: string,
  params: Parameters<PgClient['query']>[1],
  signal?: AbortSignal,
): ReturnType<PgClient['query']> {
  return withPgConnection(
    client,
    (connection) => connection.query(sql, params),
    signal,
  );
}
