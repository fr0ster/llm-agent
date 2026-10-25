import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { exportRecords, usageReaderConformance } from '@mcp-abap-adt/llm-usage';
import { USAGE_DDL } from './ddl.js';
import { collect, metric } from './fixtures.js';
import { createPgUsageSink, type PgUsageClient } from './index.js';

function fixture(autoCreateSchema = true) {
  const db = new PGlite();
  const client: PgUsageClient = {
    async query(sql, params) {
      const result = await db.query<Record<string, unknown>>(sql, params);
      return { rows: result.rows, rowCount: result.affectedRows };
    },
    end: () => db.close(),
  };
  return { db, sink: createPgUsageSink({ client, autoCreateSchema }) };
}
await usageReaderConformance('PGlite', () => fixture().sink);
test('idempotence, exact round trip, indexed columns, export and retention', async () => {
  const { db, sink } = fixture();
  try {
    const record = metric();
    await Promise.all([
      sink.write([record, record]),
      sink.write([{ ...record, values: { count: 99 } }]),
    ]);
    assert.deepEqual(
      await collect(
        sink.read({ from: 15, to: 16, kinds: ['x.metric'], sessionId: 's' }),
      ),
      [record],
    );
    assert.deepEqual(await collect(sink.read({ from: 0, to: 15 })), []);
    assert.deepEqual(
      await collect(sink.read({ from: 0, to: 20, sessionId: 'other' })),
      [],
    );
    const stored = await db.query(
      'SELECT schema_version, user_id, turn_id, task_id, role, destination, outcome FROM "USAGE_RECORDS"',
    );
    assert.deepEqual(stored.rows, [
      {
        schema_version: 1,
        user_id: 'u',
        turn_id: 'turn',
        task_id: 'task',
        role: 'executor',
        destination: 'test',
        outcome: 'ok',
      },
    ]);
    const csv = [];
    for await (const line of exportRecords(
      sink.read({ from: 0, to: 20 }),
      'csv',
    ))
      csv.push(line);
    assert.match(csv[0], /values.count|values,/);
    assert.match(csv[0], /loss_evidence/);
    assert.equal(await sink.deleteOlderThan(15), 0);
    assert.equal(await sink.deleteOlderThan(16), 1);
    assert.equal(await sink.deleteOlderThan(16), 0);
  } finally {
    await sink.close();
  }
  await assert.rejects(sink.write([metric()]), /closed/);
});
test('operator DDL works with automatic creation disabled', async () => {
  const { db, sink } = fixture(false);
  try {
    const ddl = await readFile(
      new URL('../ddl/usage.sql', import.meta.url),
      'utf8',
    );
    assert.equal(ddl.replaceAll('\r\n', '\n'), USAGE_DDL);
    await db.exec(ddl);
    await sink.write([metric()]);
    assert.equal((await collect(sink.read({ from: 0, to: 20 }))).length, 1);
  } finally {
    await sink.close();
  }
});
test('missing table gives a clear error and can recover after deployment', async () => {
  const { db, sink } = fixture(false);
  try {
    await assert.rejects(
      sink.write([metric()]),
      /USAGE_RECORDS.*ddl\/usage.sql/,
    );
    await db.exec(USAGE_DDL);
    await sink.write([metric()]);
  } finally {
    await sink.close();
  }
});
test('schema names are quoted safely', async () => {
  const { db, sink } = fixture();
  try {
    await db.exec('CREATE SCHEMA "usage-test"');
    const scoped = createPgUsageSink({
      schema: 'usage-test',
      client: {
        query: async (sql, params) => ({
          rows: (await db.query<Record<string, unknown>>(sql, params)).rows,
        }),
        async end() {},
      },
    });
    await scoped.write([metric()]);
    assert.equal((await collect(scoped.read({ from: 0, to: 20 }))).length, 1);
    await scoped.close();
  } finally {
    await sink.close();
  }
});
