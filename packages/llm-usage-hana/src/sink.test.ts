import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { exportRecords, usageReaderConformance } from '@mcp-abap-adt/llm-usage';
import { USAGE_DDL } from './ddl.js';
import { collect, metric } from './fixtures.js';
import { createHanaUsageSink, type HanaUsageClient } from './index.js';

test('HANA defaults to operator-deployed schema, diagnoses missing table and retries', async () => {
  const statements: string[] = [];
  let deployed = false;
  const client: HanaUsageClient = {
    async exec(sql) {
      statements.push(sql);
      if (!deployed) throw new Error('invalid table name');
      return [];
    },
    async close() {},
  };
  const sink = createHanaUsageSink({ client });
  try {
    await assert.rejects(
      sink.write([metric()]),
      /USAGE_RECORDS.*ddl\/usage.sql/,
    );
    assert.ok(statements.every((sql) => !sql.includes('CREATE')));
    deployed = true;
    await sink.write([metric()]);
    assert.match(statements.at(-1) ?? '', /^INSERT INTO USAGE_RECORDS/);
  } finally {
    await sink.close();
  }
});
test('duplicate inserts are ignored; other write errors propagate; LOBs decode', async () => {
  const record = metric();
  let code = 301;
  const sink = createHanaUsageSink({
    client: {
      async exec(sql) {
        if (sql.startsWith('INSERT'))
          throw Object.assign(new Error('write failed'), { code });
        if (sql.startsWith('SELECT "record_json"'))
          return [{ record_json: Buffer.from(JSON.stringify(record)) }];
        if (sql.startsWith('DELETE')) return 1;
        return [];
      },
      async close() {},
    },
  });
  try {
    await sink.write([record]);
    code = 999;
    await assert.rejects(sink.write([record]), /write failed/);
    assert.deepEqual(await collect(sink.read({ from: 0, to: 20 })), [record]);
    assert.equal(await sink.deleteOlderThan(20), 1);
  } finally {
    await sink.close();
  }
});
test('explicit automatic DDL ignores only table/index already-exists errors', async () => {
  let code = 288;
  const sink = createHanaUsageSink({
    autoCreateSchema: true,
    client: {
      async exec(sql) {
        if (sql.trim().startsWith('CREATE'))
          throw Object.assign(new Error('ddl failed'), { code });
        return [];
      },
      async close() {},
    },
  });
  try {
    await sink.write([]);
  } finally {
    await sink.close();
  }
  code = 258;
  const failed = createHanaUsageSink({
    autoCreateSchema: true,
    client: {
      async exec() {
        throw Object.assign(new Error('insufficient privilege'), { code });
      },
      async close() {},
    },
  });
  try {
    await assert.rejects(failed.write([]), /insufficient privilege/);
  } finally {
    await failed.close();
  }
});
test('shipped DDL matches automatic schema', async () => {
  assert.equal(
    (
      await readFile(new URL('../ddl/usage.sql', import.meta.url), 'utf8')
    ).replaceAll('\r\n', '\n'),
    USAGE_DDL,
  );
});

// The SQL shared-table HANA runner uses the hana[0] VCAP_SERVICES binding.
// Use a fresh schema so conformance fixtures and retention cannot touch app data.
async function liveFixture() {
  const credentials = JSON.parse(process.env.VCAP_SERVICES ?? '{}').hana?.[0]
    ?.credentials;
  assert.ok(credentials, 'VCAP_SERVICES must contain a hana[0] binding');
  const module = await import('@sap/hana-client');
  const connection = (module.default ?? module).createConnection();
  await new Promise<void>((resolve, reject) =>
    connection.connect(
      {
        serverNode: `${credentials.host}:${credentials.port}`,
        uid: credentials.user,
        pwd: credentials.password,
        encrypt: 'true',
        sslValidateCertificate: 'true',
      },
      (error: Error | null) => (error ? reject(error) : resolve()),
    ),
  );
  const exec = (sql: string) =>
    new Promise<void>((resolve, reject) =>
      connection.exec(sql, (error: Error | null) =>
        error ? reject(error) : resolve(),
      ),
    );
  const disconnect = () =>
    new Promise<void>((resolve, reject) =>
      connection.disconnect((error: Error | null) =>
        error ? reject(error) : resolve(),
      ),
    );
  const schema = `USAGE_TEST_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  try {
    await exec(`CREATE SCHEMA "${schema}"`);
  } catch (error) {
    await disconnect();
    throw error;
  }
  const sink = createHanaUsageSink({
    host: credentials.host,
    port: Number(credentials.port),
    schema,
    credential: {
      principal: credentials.user,
      secret: () => credentials.password,
    },
    autoCreateSchema: true,
  });
  return {
    ...sink,
    async close() {
      try {
        await sink.close();
      } finally {
        try {
          await exec(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          await disconnect();
        }
      }
    },
  };
}
if (process.env.VCAP_SERVICES)
  await usageReaderConformance('HANA live', liveFixture);
else
  test('HANA live reader conformance', {
    skip: 'VCAP_SERVICES is not set',
  }, () => {});
test('HANA live idempotence, export and retention', {
  skip: !process.env.VCAP_SERVICES,
}, async () => {
  const sink = await liveFixture();
  try {
    const record = metric('live', 200);
    await sink.write([record, record]);
    assert.deepEqual(await collect(sink.read({ from: 200, to: 201 })), [
      record,
    ]);
    const csv = [];
    for await (const line of exportRecords(
      sink.read({ from: 200, to: 201 }),
      'csv',
    ))
      csv.push(line);
    assert.match(csv[0], /loss_evidence/);
    assert.equal(await sink.deleteOlderThan(200), 0);
    assert.equal(await sink.deleteOlderThan(201), 1);
  } finally {
    await sink.close();
  }
});
