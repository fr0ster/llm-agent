import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { exportRecords, usageReaderConformance } from '@mcp-abap-adt/llm-usage';
import { USAGE_DDL } from './ddl.js';
import { collect, metric } from './fixtures.js';
import { createSqliteUsageSink } from './index.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'usage-sqlite-'));
  const path = join(dir, 'usage.sqlite');
  const sink = createSqliteUsageSink({ path });
  return {
    ...sink,
    path,
    async close() {
      try {
        await sink.close();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
await usageReaderConformance('SQLite temp file', fixture);
test('idempotence, exact records, persistence, export and retention', async () => {
  const sink = await fixture();
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
    const reopened = createSqliteUsageSink({
      path: sink.path,
      autoCreateSchema: false,
    });
    try {
      assert.deepEqual(await collect(reopened.read({ from: 15, to: 16 })), [
        record,
      ]);
    } finally {
      await reopened.close();
    }
    const csv = [];
    for await (const line of exportRecords(
      sink.read({ from: 0, to: 20 }),
      'csv',
    ))
      csv.push(line);
    assert.match(csv[0], /loss_evidence/);
    assert.equal(await sink.deleteOlderThan(15), 0);
    assert.equal(await sink.deleteOlderThan(16), 1);
    assert.equal(await sink.deleteOlderThan(16), 0);
  } finally {
    await sink.close();
  }
  await assert.rejects(sink.write([metric()]), /closed/);
});
test('missing table gives a clear error', async () => {
  const sink = createSqliteUsageSink({
    path: ':memory:',
    autoCreateSchema: false,
  });
  try {
    await assert.rejects(
      sink.write([metric()]),
      /USAGE_RECORDS.*ddl\/usage.sql/,
    );
  } finally {
    await sink.close();
  }
});
test('unsupported capability fails at construction', () => {
  assert.throws(
    () =>
      createSqliteUsageSink({ path: ':memory:', capabilityProbe: () => false }),
    { message: 'llm-usage-sqlite requires node:sqlite (Node >= 22.13)' },
  );
});
test('worker startup failures reject pending operations', async () => {
  const sink = createSqliteUsageSink({
    path: join(tmpdir(), 'nonexistent-usage-dir', 'db.sqlite'),
  });
  await assert.rejects(sink.write([metric()]));
  await assert.rejects(sink.close());
});
test('large writes allow the main thread to make progress before acknowledgement', async () => {
  const sink = await fixture();
  try {
    await sink.write([]);
    const batch = Array.from({ length: 40000 }, (_, i) => metric(String(i)));
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      await sink.write(batch);
      assert.ok(ticks > 1, `main-thread ticks during write: ${ticks}`);
    } finally {
      clearInterval(timer);
    }
    assert.equal(await sink.deleteOlderThan(16), batch.length);
  } finally {
    await sink.close();
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
