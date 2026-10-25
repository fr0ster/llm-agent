import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import type { IUsageSink, UsageRecord } from '@mcp-abap-adt/llm-agent';
import {
  type IUsageReader,
  selectUsage,
  type UsageQuery,
} from '@mcp-abap-adt/llm-usage';
import { USAGE_DDL } from './ddl.js';
import { COLUMNS, recordValues } from './records.js';
import { sqliteWorker } from './worker.js';

export interface SqliteUsageSinkOptions {
  path: string;
  autoCreateSchema?: boolean;
  /** Test seam; the runtime version check always applies. */
  capabilityProbe?: () => boolean;
}
function hasSqlite(): boolean {
  try {
    return (
      typeof createRequire(import.meta.url)('node:sqlite').DatabaseSync ===
      'function'
    );
  } catch {
    return false;
  }
}

export function createSqliteUsageSink(
  opts: SqliteUsageSinkOptions,
): IUsageSink &
  IUsageReader & {
    deleteOlderThan(ms: number): Promise<number>;
    close(): Promise<void>;
  } {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (
    major < 22 ||
    (major === 22 && minor < 13) ||
    !(opts.capabilityProbe ?? hasSqlite)()
  )
    throw new Error('llm-usage-sqlite requires node:sqlite (Node >= 22.13)');
  const worker = new Worker(`(${sqliteWorker.toString()})()`, {
    eval: true,
    workerData: {
      path: opts.path,
      autoCreateSchema: opts.autoCreateSchema ?? true,
      ddl: USAGE_DDL,
      columns: COLUMNS,
    },
  });
  let sequence = 0;
  let failure: Error | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  const fail = (error: Error) => {
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  worker.on('error', fail);
  worker.on('exit', (code) =>
    fail(new Error(`SQLite worker exited (${code})`)),
  );
  worker.on(
    'message',
    (message: { id: number; result?: unknown; error?: string }) => {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(message.error));
      else request?.resolve(message.result);
    },
  );
  const send = (
    op: string,
    data: Record<string, unknown> = {},
  ): Promise<unknown> => {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = sequence++;
      pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, op, ...data });
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  };
  const run = (op: string, data: Record<string, unknown>) =>
    closed ? Promise.reject(new Error('Usage sink is closed')) : send(op, data);
  return {
    async write(batch) {
      await run('write', { values: batch.map(recordValues) });
    },
    async *read(query: UsageQuery) {
      const rows = (await run('read', { from: query.from, to: query.to })) as {
        record_json: string;
      }[];
      yield* selectUsage(
        rows.map((row) => JSON.parse(row.record_json) as UsageRecord),
        query,
      );
    },
    async deleteOlderThan(ms) {
      return (await run('delete', { cutoff: ms })) as number;
    },
    close() {
      closed = true;
      closing ??= (async () => {
        try {
          await send('close');
        } finally {
          await worker.terminate();
        }
      })();
      return closing;
    },
  };
}
