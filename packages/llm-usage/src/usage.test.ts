import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  ISignalEmitter,
  ISignalSubscriber,
  Signal,
} from '@mcp-abap-adt/llm-agent';
import {
  UsageDeliveryError,
  type UsageInput,
  type UsageRecord,
} from '@mcp-abap-adt/llm-agent';
import {
  combineSinks,
  createUsageRecorder,
  directTransport,
  exportRecords,
  httpTransport,
  jsonlFileSink,
  memorySink,
  signalSource,
  signalTransport,
  type UsageSignals,
  usageReaderConformance,
} from './index.js';

const input = (id = 'a', at = 10): UsageInput => ({
  id,
  at,
  kind: 'x.metric',
  outcome: 'ok',
  context: { sessionId: 's' },
  values: { n: 1 },
});
const record = (id = 'a', at = 10): UsageRecord =>
  ({ ...input(id, at), schema: 1 }) as UsageRecord;
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of source) out.push(value);
  return out;
}
const query = { from: -Infinity, to: Infinity };
const hang = () => new Promise<void>(() => {});

test('loss counters merge into global evidence and retries preserve evidence ids', async () => {
  let clock = 10;
  const sink = memorySink({ limit: 100 });
  let evidenceAttempts = 0;
  const evidenceIds: string[] = [];
  const recorder = createUsageRecorder({
    queueLimit: 1,
    batchSize: 100,
    maxLossCounters: 1,
    lossWindowMs: 100,
    now: () => clock,
    transport: {
      async send(batch) {
        for (const r of batch)
          if (r.kind === 'x.usage.lost') {
            evidenceIds.push(r.id);
            if (++evidenceAttempts === 1) {
              await sink.write(batch);
              throw new UsageDeliveryError('Acknowledgement lost', true);
            }
          }
        await sink.write(batch);
      },
      async close() {},
    },
  });
  recorder.record(input('accepted'));
  recorder.record(input('lost-s'));
  recorder.record({ ...input('lost-t'), context: { sessionId: 't' } });
  clock = 110;
  await recorder.flush(500);
  const evidence = (await collect(sink.read(query))).filter(
    (r) => r.kind === 'x.usage.lost',
  );
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].context.sessionId, '');
  assert.ok('values' in evidence[0]);
  assert.equal(evidence[0].values['x.metric'], 2);
  assert.equal(evidenceIds.length, 2);
  assert.equal(evidenceIds[0], evidenceIds[1]);
  await recorder.close(100);
});

test('rejected snapshots cannot throw through record', async () => {
  const recorder = createUsageRecorder({
    transport: directTransport(memorySink({ limit: 10 })),
  });
  const invalid = {
    ...input(),
    values: { bad: new Date() },
  } as unknown as UsageInput;
  assert.doesNotThrow(() => recorder.record(invalid));
  assert.equal(recorder.stats().lost.invalid, 1);
  await recorder.close(100);
});

await usageReaderConformance('memory', () => memorySink({ limit: 100 }));
const temp = await mkdtemp(join(tmpdir(), 'llm-usage-'));
await usageReaderConformance('JSONL', () =>
  jsonlFileSink({ path: join(temp, 'conformance.jsonl'), rotateBytes: 100 }),
);
test.after(async () => {
  await rm(temp, { recursive: true, force: true });
});

test('snapshot, context copy, stable retry ids, producer safety', async () => {
  const sink = memorySink({ limit: 100 });
  let calls = 0;
  const batches: string[][] = [];
  const recorder = createUsageRecorder({
    transport: {
      async send(batch) {
        batches.push(batch.map((r) => r.id));
        if (++calls === 1) throw Error('unknown');
        await sink.write(batch);
      },
      async close() {},
    },
    flushMs: 1,
  });
  const context = { role: 'worker' };
  const scoped = recorder.with(context);
  context.role = 'changed';
  const original = input();
  scoped.record(original);
  original.context.sessionId = 'changed';
  if ('values' in original) original.values.n = 99;
  const result = await recorder.close(500);
  assert.deepEqual(result, { delivered: 1, lost: 0, unconfirmed: 0 });
  const [stored] = await collect(sink.read(query));
  assert.equal(stored.context.role, 'worker');
  assert.equal(stored.context.sessionId, 's');
  assert.equal('values' in stored && stored.values.n, 1);
  assert.deepEqual(batches, [['a'], ['a']]);
});

test('bounded queue and loss windows preserve the affected range', async () => {
  let clock = 10;
  const sink = memorySink({ limit: 100 });
  const recorder = createUsageRecorder({
    transport: directTransport(sink),
    queueLimit: 1,
    batchSize: 100,
    lossWindowMs: 100,
    now: () => clock,
    instanceId: 'instance',
  });
  recorder.record(input('accepted', 5));
  recorder.record(input('lost', 7));
  assert.equal(recorder.stats().buffered, 1);
  clock = 110;
  await recorder.flush(100);
  const records = await collect(sink.read(query));
  const evidence = records.find((r) => r.kind === 'x.usage.lost');
  assert.ok(evidence && 'values' in evidence);
  assert.equal(evidence.id, 'lost:instance:s:0');
  assert.deepEqual(evidence.values, {
    'x.metric': 1,
    affectedFrom: 7,
    affectedTo: 7,
  });
  await recorder.close(100);
});

for (const [name, error, expected] of [
  ['unknown', Error('failure'), 'unconfirmed'],
  ['refused', new UsageDeliveryError('refused', false), 'lost'],
  ['ambiguous', new UsageDeliveryError('ack lost', true), 'unconfirmed'],
] as const) {
  test(`delivery classification: ${name}`, async () => {
    const recorder = createUsageRecorder({
      transport: {
        async send(batch) {
          if (batch[0].kind === 'x.usage.lost') return;
          throw error;
        },
        async close() {},
      },
      retryWindowMs: 0,
      reservedLossCapacity: 0,
    });
    assert.doesNotThrow(() => recorder.record(input()));
    const result = await recorder.close(500);
    assert.deepEqual(result, {
      delivered: 1,
      lost: expected === 'lost' ? 1 : 0,
      unconfirmed: expected === 'unconfirmed' ? 1 : 0,
    });
  });
}

test('hanging sends and close share a deadline; late acknowledgement ignored', async () => {
  let resolve: (() => void) | undefined;
  const recorder = createUsageRecorder({
    transport: {
      send: () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
      close: hang,
    },
    batchSize: 1,
  });
  recorder.record(input());
  const start = Date.now();
  const result = await recorder.close(40);
  assert.ok(Date.now() - start < 250);
  assert.deepEqual(result, { delivered: 0, lost: 1, unconfirmed: 1 });
  resolve?.();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(recorder.stats().delivered, 0);
  const closeOnly = createUsageRecorder({
    transport: directTransport({ async write() {}, close: hang }),
  });
  const before = Date.now();
  await closeOnly.close(20);
  assert.ok(Date.now() - before < 200);
});

test('retry expiry in a later window retains earlier operation time and one evidence id', async () => {
  let clock = 10;
  const sink = memorySink({ limit: 100 });
  let first = true;
  const recorder = createUsageRecorder({
    now: () => clock,
    lossWindowMs: 100,
    retryWindowMs: 50,
    transport: {
      async send(batch) {
        if (first) {
          first = false;
          clock = 110;
          throw new UsageDeliveryError('refused', false);
        }
        await sink.write(batch);
      },
      async close() {},
    },
  });
  recorder.record(input());
  await recorder.flush(100);
  await recorder.close(100);
  const evidence = (await collect(sink.read(query))).filter(
    (r) => r.kind === 'x.usage.lost',
  );
  assert.equal(evidence.length, 1);
  assert.ok('values' in evidence[0]);
  assert.equal(evidence[0].values.affectedFrom, 10);
  assert.ok(evidence[0].id.endsWith(':100'));
});

test('memory rejection is atomic; combineSinks classifies partial writes', async () => {
  const sink = memorySink({ limit: 1, evict: false });
  await sink.write([record()]);
  await assert.rejects(
    sink.write([record('b')]),
    (e) => e instanceof UsageDeliveryError && !e.possiblyDelivered,
  );
  const combined = combineSinks(memorySink({ limit: 10 }), sink);
  await assert.rejects(
    combined.write([record('b')]),
    (e) => e instanceof UsageDeliveryError && e.possiblyDelivered,
  );
  const recorder = createUsageRecorder({
    transport: directTransport(combined),
    retryWindowMs: 0,
  });
  recorder.record(input('b'));
  assert.deepEqual(await recorder.close(100), {
    delivered: 0,
    lost: 0,
    unconfirmed: 2,
  });
});

test('JSONL rotation, reopening, idempotence and exports', async () => {
  const path = join(temp, 'rotation.jsonl');
  const sink = jsonlFileSink({ path, rotateBytes: 1 });
  await Promise.all([
    sink.write([record()]),
    sink.write([record(), record('b')]),
  ]);
  await sink.close?.();
  assert.ok(
    (await readdir(temp)).filter((f) => f.startsWith('rotation.jsonl'))
      .length >= 2,
  );
  const reopened = jsonlFileSink({ path, rotateBytes: 1 });
  await reopened.write([record()]);
  assert.equal((await collect(reopened.read(query))).length, 2);
  const csv = (await collect(exportRecords(reopened.read(query), 'csv'))).join(
    '',
  );
  assert.ok(csv.includes('values.affectedFrom'));
  assert.ok(csv.includes('loss_evidence'));
  const jsonl = (
    await collect(exportRecords(reopened.read(query), 'jsonl'))
  ).join('');
  assert.equal(jsonl.trim().split('\n').length, 2);
});

test('JSONL initialization failures are handled immediately and retained', async () => {
  const path = join(temp, 'unreadable.jsonl');
  // A directory cannot be read as a file, even when running with elevated access.
  await mkdir(path);
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const sink = jsonlFileSink({ path, rotateBytes: 1000 });
    // Allow initialization to fail before attaching any operation handlers.
    await delay(100);
    let original: unknown;
    await assert.rejects(collect(sink.read(query)), (error) => {
      original = error;
      return error instanceof Error;
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(
        sink.write([record()]),
        (error) =>
          error instanceof UsageDeliveryError &&
          error.possiblyDelivered === false &&
          error.cause === original,
      );
      await assert.rejects(sink.close(), (error) => error === original);
    }
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('JSONL skips malformed lines and recovers an unterminated final line', async () => {
  const path = join(temp, 'truncated.jsonl');
  await writeFile(
    path,
    `${JSON.stringify(record('existing'))}\nnot json\n\n{"id":"truncated`,
  );
  const sink = jsonlFileSink({ path, rotateBytes: 10000 });
  await sink.write([record('existing'), record('new')]);
  assert.deepEqual(
    (await collect(sink.read(query))).map((r) => r.id),
    ['existing', 'new'],
  );
  assert.deepEqual(sink.stats(), { skippedLines: 2 });
  await sink.close();
  const reopened = jsonlFileSink({ path, rotateBytes: 10000 });
  await reopened.write([record('new'), record('later')]);
  assert.deepEqual(
    (await collect(reopened.read(query))).map((r) => r.id),
    ['existing', 'new', 'later'],
  );
  assert.deepEqual(reopened.stats(), { skippedLines: 2 });
  await reopened.close();
});

test('HTTP body and failure classification', async () => {
  let body = '';
  const transport = httpTransport({
    url: 'http://collector',
    fetch: async (_url, init) => {
      body = String(init?.body);
      return new Response('', { status: 200 });
    },
  });
  await transport.send([record()]);
  assert.deepEqual(JSON.parse(body), { schema: 1, records: [record()] });
  for (const [error, possible] of [
    [new Error('refused', { cause: { code: 'ECONNREFUSED' } }), false],
    [Error('lost ack'), true],
  ] as const) {
    await assert.rejects(
      httpTransport({
        url: 'http://collector',
        fetch: async () => {
          throw error;
        },
      }).send([record()]),
      (e) =>
        e instanceof UsageDeliveryError && e.possiblyDelivered === possible,
    );
  }
});

test('signals use a fixed key and live-only delivery', async () => {
  let handler:
    | ((s: Signal<UsageSignals, 'usage.batch'>) => void | Promise<void>)
    | undefined;
  let latest: Signal<UsageSignals, 'usage.batch'> | undefined;
  const emitter: ISignalEmitter<UsageSignals> = {
    emit(name, payload, source, key = '') {
      latest = { name, payload, source, key, at: 1 };
      void handler?.(latest);
    },
    retire() {},
  };
  const subscriber = {
    on(_name: string, next: typeof handler) {
      handler = next;
      return () => {
        handler = undefined;
      };
    },
  } as ISignalSubscriber<UsageSignals>;
  const sink = memorySink({ limit: 10 });
  const transport = signalTransport(emitter, 'source');
  await transport.send([record('missed')]);
  const unsubscribe = signalSource(subscriber, 'source', sink);
  await transport.send([record('live')]);
  assert.equal(latest?.key, '');
  assert.deepEqual(
    (await collect(sink.read(query))).map((r) => r.id),
    ['live'],
  );
  unsubscribe();
});

async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

for (const ambiguous of [false, true]) {
  test(`scheduled retries expire before resending (ambiguous=${ambiguous})`, async (t) => {
    t.mock.timers.enable({
      apis: ['Date', 'setTimeout', 'setInterval'],
      now: 0,
    });
    const attempts: number[] = [];
    const recorder = createUsageRecorder({
      batchSize: 1,
      flushMs: 200,
      retryWindowMs: 30,
      lossWindowMs: 100,
      transport: {
        async send(batch) {
          if (batch[0].kind === 'x.usage.lost') return;
          attempts.push(Date.now());
          throw new UsageDeliveryError(
            'failed',
            ambiguous && attempts.length === 1,
          );
        },
        async close() {},
      },
    });
    recorder.record(input());
    await settle();
    t.mock.timers.tick(20);
    await settle();
    assert.deepEqual(attempts, [0, 20]);
    t.mock.timers.tick(10);
    await settle();
    assert.equal(recorder.stats().lost.retryWindow, 1);
    t.mock.timers.tick(200);
    await settle();
    assert.deepEqual(attempts, [0, 20]);
    assert.deepEqual(await recorder.close(0), {
      delivered: 1,
      lost: ambiguous ? 0 : 1,
      unconfirmed: ambiguous ? 1 : 0,
    });
  });
}

test('HTTP partial chunk delivery preserves ambiguity', async () => {
  let calls = 0;
  const transport = httpTransport({
    url: 'http://collector',
    batchSize: 1,
    fetch: async () => {
      if (++calls === 2)
        throw new UsageDeliveryError('refused', false, 'REFUSED');
      return new Response('', { status: 200 });
    },
  });
  await assert.rejects(
    transport.send([record('a'), record('b')]),
    (error) =>
      error instanceof UsageDeliveryError &&
      error.possiblyDelivered &&
      error.code === 'REFUSED',
  );
  assert.equal(calls, 2);
});

test('HTTP acknowledgement loss retries by timer and stores each id once', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
  const sink = memorySink({ limit: 10 });
  const bodies: string[] = [];
  const recorder = createUsageRecorder({
    batchSize: 1,
    flushMs: 1000,
    transport: httpTransport({
      url: 'http://collector',
      fetch: async (_url, init) => {
        bodies.push(String(init?.body));
        await sink.write(JSON.parse(String(init?.body)).records);
        if (bodies.length === 1) throw Error('acknowledgement lost');
        return new Response('', { status: 200 });
      },
    }),
  });
  recorder.record(input());
  await settle();
  assert.equal((await collect(sink.read(query))).length, 1);
  t.mock.timers.tick(20);
  await settle();
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(
    (await collect(sink.read(query))).map((r) => r.id),
    ['a'],
  );
  assert.deepEqual(await recorder.close(0), {
    delivered: 1,
    lost: 0,
    unconfirmed: 0,
  });
});

test('reserved loss capacity exhaustion does not recursively generate evidence', async () => {
  let clock = 0;
  const batches: UsageRecord[][] = [];
  const recorder = createUsageRecorder({
    queueLimit: 1,
    reservedLossCapacity: 1,
    batchSize: 100,
    lossWindowMs: 10,
    now: () => clock,
    instanceId: 'bounded',
    transport: {
      async send(batch) {
        batches.push([...batch]);
      },
      async close() {},
    },
  });
  recorder.record(input('accepted'));
  recorder.record(input('lost-s'));
  recorder.record({ ...input('lost-t'), context: { sessionId: 't' } });
  clock = 10;
  await recorder.flush(100);
  assert.deepEqual(recorder.stats().lost, { overflow: 3 });
  const records = batches.flat();
  assert.deepEqual(
    records.map((r) => r.id),
    ['accepted', 'lost:bounded:s:0'],
  );
  assert.ok('values' in records[1]);
  assert.equal(records[1].values['x.metric'], 1);
  clock = 100;
  await recorder.flush(100);
  assert.equal(batches.flat().length, 2);
  assert.deepEqual(await recorder.close(100), {
    delivered: 2,
    lost: 3,
    unconfirmed: 0,
  });
});

test('memory eviction removes oldest records while retries retain existing ids', async () => {
  const sink = memorySink({ limit: 2 });
  await sink.write([record('a'), record('b')]);
  await sink.write([record('a'), record('c')]);
  assert.deepEqual(
    (await collect(sink.read(query))).map((r) => r.id),
    ['b', 'c'],
  );
  await sink.write([record('d'), record('e'), record('f')]);
  assert.deepEqual(
    (await collect(sink.read(query))).map((r) => r.id),
    ['e', 'f'],
  );
});

test('shutdown counters partition delivered, definite loss and pending delivery', async () => {
  const recorder = createUsageRecorder({
    batchSize: 1,
    transport: {
      async send(batch) {
        if (batch[0].id === 'delivered') return;
        await hang();
      },
      async close() {},
    },
  });
  recorder.record(input('delivered'));
  await settle();
  recorder.record({
    ...input('invalid'),
    values: { invalid: new Date() },
  } as unknown as UsageInput);
  recorder.record(input('pending'));
  await settle();
  assert.deepEqual(await recorder.close(0), {
    delivered: 1,
    lost: 2,
    unconfirmed: 1,
  });
  assert.deepEqual(recorder.stats().lost, { invalid: 1, closeTimeout: 2 });
  assert.equal(recorder.stats().buffered, 0);
});
