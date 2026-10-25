import type { IUsageSink, UsageRecord } from '@mcp-abap-adt/llm-agent';
import {
  type IUsageReader,
  selectUsage,
  type UsageQuery,
} from '@mcp-abap-adt/llm-usage';
import { Pool, type PoolConfig } from 'pg';
import { USAGE_DDL } from './ddl.js';
import { COLUMNS, recordValues } from './records.js';

export interface PgUsageClient {
  query(
    sql: string,
    params?: (string | number | null)[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
  end(): Promise<void>;
}
export interface PgUsageSinkOptions extends PoolConfig {
  schema?: string;
  autoCreateSchema?: boolean;
  client?: PgUsageClient;
  onPoolError?: (error: Error) => void | Promise<void>;
}

export function createPgUsageSink(opts: PgUsageSinkOptions = {}): IUsageSink &
  IUsageReader & {
    deleteOlderThan(ms: number): Promise<number>;
    close(): Promise<void>;
  } {
  const {
    schema = 'public',
    autoCreateSchema = true,
    client: injected,
    onPoolError,
    ...config
  } = opts;
  const table = `"${schema.replaceAll('"', '""')}"."USAGE_RECORDS"`;
  const client = injected ?? new Pool(config);
  if (client instanceof Pool)
    client.on('error', (error) => {
      void Promise.resolve()
        .then(() => onPoolError?.(error))
        .catch(() => {});
    });
  let ready: Promise<void> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;
  let closing: Promise<void> | undefined;
  const ensure = () =>
    (ready ??= (async () => {
      if (autoCreateSchema) {
        for (const statement of USAGE_DDL.replaceAll(
          '"USAGE_RECORDS" (',
          `${table} (`,
        )
          .split(';')
          .filter((s) => s.trim()))
          await client.query(statement);
      }
      try {
        await client.query(`SELECT id FROM ${table} WHERE 1 = 0`);
      } catch (error) {
        throw new Error(
          'USAGE_RECORDS is unavailable; apply ddl/usage.sql or enable autoCreateSchema',
          { cause: error },
        );
      }
    })().catch((error) => {
      ready = undefined;
      throw error;
    }));
  const run = <T>(fn: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new Error('Usage sink is closed'));
    const next = tail.then(async () => {
      await ensure();
      return fn();
    });
    tail = next.catch(() => {});
    return next;
  };
  return {
    write(batch) {
      const values = batch.map(recordValues);
      return run(async () => {
        for (const row of values)
          await client.query(
            `INSERT INTO ${table} (${COLUMNS}) VALUES (${row.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT (id) DO NOTHING`,
            row,
          );
      });
    },
    async *read(query: UsageQuery) {
      const rows = await run(
        async () =>
          (
            await client.query(
              `SELECT record_json FROM ${table} WHERE (at >= $1 AND at < $2) OR kind = 'x.usage.lost' ORDER BY at, id`,
              [query.from, query.to],
            )
          ).rows,
      );
      yield* selectUsage(
        rows.map((row) => JSON.parse(String(row.record_json)) as UsageRecord),
        query,
      );
    },
    deleteOlderThan(ms) {
      return run(
        async () =>
          (await client.query(`DELETE FROM ${table} WHERE at < $1`, [ms]))
            .rowCount ?? 0,
      );
    },
    close() {
      closed = true;
      closing ??= tail.then(() => client.end());
      return closing;
    },
  };
}
