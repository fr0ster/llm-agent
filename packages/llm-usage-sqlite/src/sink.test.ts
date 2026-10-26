import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { UsageDeliveryError } from '@mcp-abap-adt/llm-agent';
import { exportRecords, usageReaderConformance } from '@mcp-abap-adt/llm-usage';
import { USAGE_DDL } from './ddl.js';
import { collect, metric } from './fixtures.js';
import { createSqliteUsageSink } from './index.js';
import { snapshotStream } from './snapshot.js';

async function snapshotBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const result = await reader.read();
    if (result.done) return Buffer.concat(chunks);
    chunks.push(result.value);
  }
}

test('snapshot preserves exact records while later writes continue, including quoted paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage's-snapshot-"));
  const sink = createSqliteUsageSink({
    path: join(directory, "usage's.sqlite"),
  });
  const original = [metric('first'), metric('second')];
  try {
    await sink.write(original);
    const stream = await sink.snapshot();
    await sink.write([metric('during')]);
    assert.equal((await collect(sink.read({ from: 0, to: 20 }))).length, 3);
    const copy = join(directory, 'download.sqlite');
    await writeFile(copy, await snapshotBytes(stream));
    await sink.write([metric('after')]);
    const db = new DatabaseSync(copy);
    try {
      const rows = db
        .prepare('SELECT id, record_json FROM USAGE_RECORDS ORDER BY id')
        .all();
      assert.deepEqual(
        rows.map(
          (row: Record<string, import('node:sqlite').SQLOutputValue>) => ({
            ...row,
          }),
        ),
        original.map((record: ReturnType<typeof metric>) => ({
          id: record.id,
          record_json: JSON.stringify(record),
        })),
      );
    } finally {
      db.close();
    }
    assert.deepEqual(
      await collect(sink.read({ from: 0, to: 20 })),
      [...original, metric('during'), metric('after')].sort(
        (a: ReturnType<typeof metric>, b: ReturnType<typeof metric>) =>
          a.id.localeCompare(b.id),
      ),
    );
  } finally {
    await sink.close();
    await rm(directory, { recursive: true, force: true });
  }
  await assert.rejects(sink.snapshot(), /closed/);
});

test('snapshot temporary files are removed on full read, cancellation and read error', async () => {
  for (const mode of ['read', 'cancel', 'error']) {
    const directory = await mkdtemp(join(tmpdir(), "snapshot's-cleanup-"));
    const path = join(directory, 'snapshot.sqlite');
    await writeFile(path, Buffer.alloc(1024 * 1024));
    const source = await open(path, 'r');
    if (mode === 'error') await source.close();
    const stream = await snapshotStream(path, directory, source);
    try {
      if (mode === 'read') await snapshotBytes(stream);
      else if (mode === 'cancel') await stream.cancel();
      else {
        await assert.rejects(snapshotBytes(stream), /closed|EBADF/i);
      }
      await assert.rejects(access(directory), { code: 'ENOENT' });
    } finally {
      await source.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('snapshot stream creation failure removes its temporary directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-open-failure-'));
  try {
    await assert.rejects(
      snapshotStream(join(directory, 'missing.sqlite'), directory),
      { code: 'ENOENT' },
    );
    await assert.rejects(access(directory), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('snapshot VACUUM accepts a temporary directory containing a quote', async () => {
  const directory = await mkdtemp(join(tmpdir(), "vacuum's-temp-"));
  const previous = {
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
  };
  const sink = createSqliteUsageSink({ path: ':memory:' });
  try {
    process.env.TMPDIR = directory;
    process.env.TMP = directory;
    process.env.TEMP = directory;
    await sink.write([metric()]);
    const stream = await sink.snapshot();
    assert.equal((await readdir(directory)).length, 1);
    assert.ok((await snapshotBytes(stream)).length > 0);
    assert.deepEqual(await readdir(directory), []);
    const cancelled = await sink.snapshot();
    await cancelled.cancel();
    assert.deepEqual(await readdir(directory), []);
    const unavailable = createSqliteUsageSink({
      path: ':memory:',
      autoCreateSchema: false,
    });
    try {
      await assert.rejects(unavailable.snapshot(), /USAGE_RECORDS/);
      assert.deepEqual(await readdir(directory), []);
    } finally {
      await unavailable.close();
    }
  } finally {
    const keys: ('TMPDIR' | 'TMP' | 'TEMP')[] = ['TMPDIR', 'TMP', 'TEMP'];
    for (const key of keys) {
      const value = previous[key];
      if (typeof value === 'string') process.env[key] = value;
      else delete process.env[key];
    }
    await sink.close();
    await rm(directory, { recursive: true, force: true });
  }
});

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
      (error: unknown) =>
        error instanceof UsageDeliveryError &&
        !error.possiblyDelivered &&
        /USAGE_RECORDS.*ddl\/usage.sql/.test(error.message),
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

test('worker loads when parent uses --input-type=module', async () => {
  const entry = new URL('../dist/index.js', import.meta.url).href;
  await promisify(execFile)(process.execPath, [
    '--input-type=module',
    '--eval',
    `
    import { createSqliteUsageSink } from ${JSON.stringify(entry)};
    const sink = createSqliteUsageSink({ path: ':memory:' });
    await sink.write([]);
    await sink.close();
  `,
  ]);
});
test('validation failures are definitely not delivered', async () => {
  const sink = createSqliteUsageSink({ path: ':memory:' });
  try {
    const record = metric();
    Object.defineProperty(record, 'context', {
      get() {
        throw new Error('invalid record');
      },
    });
    await assert.rejects(
      sink.write([record]),
      (error: unknown) =>
        error instanceof UsageDeliveryError &&
        !error.possiblyDelivered &&
        error.code === 'VALIDATION_FAILED',
    );
  } finally {
    await sink.close();
  }
});

test('a rolled back partial batch preserves definite failure and code across the worker', async () => {
  const sink = await fixture();
  try {
    await sink.write([]);
    const db = new DatabaseSync(sink.path);
    try {
      db.exec(`CREATE TRIGGER reject_second BEFORE INSERT ON USAGE_RECORDS
        WHEN NEW.id = 'second' BEGIN SELECT RAISE(ABORT, 'rejected record'); END`);
    } finally {
      db.close();
    }
    await assert.rejects(
      sink.write([metric('first'), metric('second')]),
      (error: unknown) =>
        error instanceof UsageDeliveryError &&
        !error.possiblyDelivered &&
        error.code === 'ERR_SQLITE_ERROR',
    );
    assert.deepEqual(await collect(sink.read({ from: 0, to: 20 })), []);
  } finally {
    await sink.close();
  }
});
