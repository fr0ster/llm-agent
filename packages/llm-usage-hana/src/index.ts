import type { IUsageSink, UsageRecord } from '@mcp-abap-adt/llm-agent';
import {
  type IUsageReader,
  selectUsage,
  type UsageQuery,
} from '@mcp-abap-adt/llm-usage';
import { USAGE_DDL } from './ddl.js';
import { COLUMNS, recordValues } from './records.js';

export interface HanaUsageClient {
  exec(sql: string, params?: (string | number | null)[]): Promise<unknown>;
  close(): Promise<void>;
}
export interface HanaUsageSinkOptions {
  host?: string;
  port?: number;
  connectionString?: string;
  credential?: { principal: string; secret(): string | Promise<string> };
  schema?: string;
  connectTimeout?: number;
  autoCreateSchema?: boolean;
  client?: HanaUsageClient;
}
async function connect(opts: HanaUsageSinkOptions): Promise<HanaUsageClient> {
  const address = opts.connectionString
    ? new URL(opts.connectionString.replace(/^hdbsql:/, 'https:'))
    : undefined;
  if (address?.username || address?.password)
    throw new Error(
      'connectionString must carry the address only; use credential',
    );
  const host = opts.host ?? address?.hostname;
  if (!host)
    throw new Error('HANA host is required (host or connectionString)');
  if (!opts.credential?.principal)
    throw new Error('HANA credential is required');
  const password = await opts.credential.secret();
  if (!password) throw new Error('HANA password is required');
  const module = await import('@sap/hana-client');
  const connection = (module.default ?? module).createConnection();
  await new Promise<void>((resolve, reject) =>
    connection.connect(
      {
        serverNode: `${host}:${opts.port ?? (address?.port ? Number(address.port) : 443)}`,
        uid: opts.credential?.principal,
        pwd: password,
        encrypt: 'true',
        sslValidateCertificate: 'true',
        currentSchema: opts.schema,
        communicationTimeout: opts.connectTimeout ?? 30000,
      },
      (error: Error | null) => (error ? reject(error) : resolve()),
    ),
  );
  return {
    exec: (sql, params = []) =>
      new Promise((resolve, reject) =>
        connection.exec(sql, params, (error: Error | null, result: unknown) =>
          error ? reject(error) : resolve(result),
        ),
      ),
    close: () =>
      new Promise((resolve, reject) =>
        connection.disconnect((error: Error | null) =>
          error ? reject(error) : resolve(),
        ),
      ),
  };
}

export function createHanaUsageSink(opts: HanaUsageSinkOptions): IUsageSink &
  IUsageReader & {
    deleteOlderThan(ms: number): Promise<number>;
    close(): Promise<void>;
  } {
  const table = `${opts.schema ? `"${opts.schema.replaceAll('"', '""')}".` : ''}USAGE_RECORDS`;
  let client: Promise<HanaUsageClient> | undefined;
  let ready: Promise<HanaUsageClient> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;
  let closing: Promise<void> | undefined;
  const ensure = () =>
    (ready ??= (async () => {
      client ??= (
        opts.client ? Promise.resolve(opts.client) : connect(opts)
      ).catch((error) => {
        client = undefined;
        throw error;
      });
      const c = await client;
      if (opts.autoCreateSchema ?? false) {
        // HANA has no IF NOT EXISTS; ignore only its specific already-exists codes.
        for (const statement of USAGE_DDL.replaceAll(
          'USAGE_RECORDS (',
          `${table} (`,
        )
          .split(';')
          .filter((s) => s.trim())) {
          try {
            await c.exec(statement);
          } catch (error) {
            if (![288, 289].includes(Number((error as { code?: number }).code)))
              throw error;
          }
        }
      }
      try {
        await c.exec(`SELECT "id" FROM ${table} WHERE 1 = 0`);
      } catch (error) {
        throw new Error(
          'USAGE_RECORDS is unavailable; apply ddl/usage.sql or enable autoCreateSchema',
          { cause: error },
        );
      }
      return c;
    })().catch((error) => {
      ready = undefined;
      throw error;
    }));
  const run = <T>(fn: (c: HanaUsageClient) => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new Error('Usage sink is closed'));
    const next = tail.then(async () => fn(await ensure()));
    tail = next.catch(() => {});
    return next;
  };
  return {
    write(batch) {
      const values = batch.map(recordValues);
      return run(async (c) => {
        for (const row of values) {
          try {
            await c.exec(
              `INSERT INTO ${table} (${COLUMNS}) VALUES (${row.map(() => '?').join(', ')})`,
              row,
            );
          } catch (error) {
            if (Number((error as { code?: number }).code) !== 301) throw error;
          }
        }
      });
    },
    async *read(query: UsageQuery) {
      const rows = await run(
        async (c) =>
          (await c.exec(
            `SELECT "record_json" AS "record_json" FROM ${table} WHERE ("at" >= ? AND "at" < ?) OR "kind" = 'x.usage.lost' ORDER BY "at", "id"`,
            [query.from, query.to],
          )) as { record_json: string | Buffer }[],
      );
      yield* selectUsage(
        rows.map(
          (row) =>
            JSON.parse(
              Buffer.isBuffer(row.record_json)
                ? row.record_json.toString('utf8')
                : row.record_json,
            ) as UsageRecord,
        ),
        query,
      );
    },
    deleteOlderThan(ms) {
      return run(async (c) =>
        Number(await c.exec(`DELETE FROM ${table} WHERE "at" < ?`, [ms])),
      );
    },
    close() {
      closed = true;
      closing ??= tail.then(async () => {
        if (client) await (await client).close();
      });
      return closing;
    },
  };
}
