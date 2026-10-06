/**
 * Spec §10.5.9 V6, V10, §10.5.10 (D80, D82): the server's one config queue
 * runs transactions one at a time and holds the "config not applied" state —
 * set when a transaction rejects, cleared when a later whole one resolves; a
 * partial one is refused while it is set (D82 (8)).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ConfigChangeRefusedError,
  ConfigTransactionQueue,
} from '../config-transaction-queue.js';

test('empty at construction — the server starts ready from its config (D82)', () => {
  assert.equal(new ConfigTransactionQueue().notApplied, undefined);
});

test("a rejected transaction sets notApplied with its message and source; the rejection is the caller's", async () => {
  const q = new ConfigTransactionQueue();
  await assert.rejects(
    q.run('reload', 'full', async () => {
      throw new Error(
        'config reload failed — worker drain: Error: close failed',
      );
    }),
    /worker drain/,
  );
  assert.equal(q.notApplied?.source, 'reload');
  assert.match(
    q.notApplied?.reason ?? '',
    /^config reload failed — worker drain: Error: close failed$/,
  );
  assert.ok(
    !Number.isNaN(Date.parse(q.notApplied?.at ?? '')),
    'at is an ISO timestamp',
  );
});

test('a later transaction that resolves clears it; one that rejects replaces it', async () => {
  const q = new ConfigTransactionQueue();
  await assert.rejects(
    q.run('put', 'full', async () => {
      throw new Error('a');
    }),
  );
  await assert.rejects(
    q.run('reload', 'full', async () => {
      throw new Error('b');
    }),
  );
  assert.deepEqual(
    [q.notApplied?.source, q.notApplied?.reason],
    ['reload', 'b'],
  );
  assert.equal(await q.run('put', 'full', async () => 42), 42);
  assert.equal(q.notApplied, undefined);
});

test('D82 (8): while not ready a partial change is refused — never run, the state untouched; a whole one clears it', async () => {
  const q = new ConfigTransactionQueue();
  await assert.rejects(
    q.run('reload', 'full', async () => {
      throw new Error('b');
    }),
  );
  const before = q.notApplied;
  let ran = false;
  await assert.rejects(
    q.run('put', 'partial', async () => {
      ran = true;
    }),
    (err: unknown) =>
      err instanceof ConfigChangeRefusedError && err.notApplied === before,
  );
  assert.equal(ran, false, 'the refused transaction never runs');
  assert.equal(q.notApplied, before, 'the state is untouched');
  assert.equal(await q.run('put', 'full', async () => 1), 1);
  assert.equal(q.notApplied, undefined, 'a whole config clears it');
  assert.equal(
    await q.run('put', 'partial', async () => 2),
    2,
    'while ready a partial change runs as before',
  );
});

test('D82 (8): the scope is checked when the transaction starts — a partial change queued while ready is refused when a transaction ahead of it fails', async () => {
  const q = new ConfigTransactionQueue();
  let releaseA!: () => void;
  const a = q.run(
    'reload',
    'full',
    () =>
      new Promise<void>((_, reject) => {
        releaseA = () => reject(new Error('a failed'));
      }),
  );
  let ran = false;
  const b = q.run('put', 'partial', async () => {
    ran = true;
  });
  await new Promise((r) => setImmediate(r)); // a has started
  releaseA();
  await assert.rejects(a, /a failed/);
  await assert.rejects(b, ConfigChangeRefusedError);
  assert.equal(ran, false);
  assert.deepEqual(
    [q.notApplied?.source, q.notApplied?.reason],
    ['reload', 'a failed'],
  );
});

test('one at a time, in order; a failure never blocks the next; the state is the last settled one', async () => {
  const q = new ConfigTransactionQueue();
  const order: string[] = [];
  let releaseA!: () => void;
  const a = q.run(
    'reload',
    'full',
    () =>
      new Promise<void>((_, reject) => {
        releaseA = () => reject(new Error('a failed'));
      }),
  );
  const b = q.run('put', 'full', async () => {
    order.push('b');
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, [], 'b waits for a');
  assert.equal(
    q.notApplied,
    undefined,
    'a transaction in flight changes nothing',
  );
  releaseA();
  await assert.rejects(a, /a failed/);
  await b;
  assert.deepEqual(order, ['b']);
  assert.equal(
    q.notApplied,
    undefined,
    "b applied after a failed — b's state is the last",
  );
});
