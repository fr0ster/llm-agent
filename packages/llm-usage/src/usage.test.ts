import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
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
        send() {
          throw error;
        },
        async close() {},
      },
      retryWindowMs: 0,
      reservedLossCapacity: 0,
    });
    assert.doesNotThrow(() => recorder.record(input()));
    const result = await recorder.close(30);
    assert.ok(result[expected] >= 1);
    assert.equal(result.delivered, 0);
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
  assert.equal(result.unconfirmed, 1);
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
  assert.ok((await recorder.close(100)).unconfirmed >= 1);
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
