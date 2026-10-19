import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { openPgClient } from '../pg-vector-rag.js';

class FakePool extends EventEmitter {
  queries = 0;
  async query(): Promise<{ rows: never[]; rowCount: number }> {
    this.queries++;
    return { rows: [], rowCount: 0 };
  }
  async end(): Promise<void> {}
}

function open(onPoolError?: (e: Error) => void | Promise<void>) {
  const pool = new FakePool();
  // biome-ignore lint/complexity/useArrowFunction: a constructor must be new-able
  const Ctor = function () {
    return pool;
  } as never;
  const client = openPgClient(Ctor, {}, onPoolError);
  return { pool, client };
}

describe('pool error listener', () => {
  it('an idle-client error on the pool does not throw, and a query still returns', async () => {
    const { pool, client } = open();
    assert.doesNotThrow(() => pool.emit('error', new Error('terminated')));
    const r = await client.query('select 1');
    assert.equal(r.rowCount, 0);
    assert.equal(pool.queries, 1);
  });

  it('reports the error to onPoolError, and a throwing onPoolError does not escape', () => {
    const seen: Error[] = [];
    const a = open((e) => {
      seen.push(e);
    });
    a.pool.emit('error', new Error('x'));
    assert.equal(seen.length, 1);
    const b = open(() => {
      throw new Error('boom');
    });
    assert.doesNotThrow(() => b.pool.emit('error', new Error('y')));
  });

  it('a rejecting async onPoolError causes no unhandled rejection', async () => {
    const seen: unknown[] = [];
    const h = (r: unknown) => seen.push(r);
    process.on('unhandledRejection', h);
    try {
      const { pool } = open(async () => {
        throw new Error('async boom');
      });
      assert.doesNotThrow(() => pool.emit('error', new Error('z')));
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off('unhandledRejection', h);
    }
    assert.deepEqual(seen, []);
  });
});
