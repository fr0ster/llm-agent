import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HanaClient } from '../hana-vector-rag.js';
import {
  roleTransaction,
  transactionalHanaClient,
} from '../role-transaction.js';

function barrier() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('HANA transaction pins its connection and queues other work until commit', async () => {
  const statements: string[] = [];
  const raw: HanaClient = {
    exec: async (sql) => {
      statements.push(sql);
      return { rowCount: 1 };
    },
    query: async () => [],
    close: async () => {},
  };
  const client = transactionalHanaClient(raw, (enabled) => {
    statements.push(`autocommit:${enabled}`);
  });
  const entered = barrier();
  const resume = barrier();
  const transaction = roleTransaction(client, async (connection) => {
    assert.equal(connection, raw);
    await connection.exec('locked');
    entered.resolve();
    await resume.promise;
    await connection.exec('write');
  });
  await entered.promise;
  const outside = client.exec('outside');
  assert.deepEqual(statements, ['autocommit:false', 'locked']);
  resume.resolve();
  await Promise.all([transaction, outside]);
  assert.deepEqual(statements, [
    'autocommit:false',
    'locked',
    'write',
    'COMMIT',
    'autocommit:true',
    'outside',
  ]);
});

test('HANA fails closed without transaction support', async () => {
  const raw: HanaClient = {
    exec: async () => {
      throw new Error('must not write');
    },
    query: async () => [],
    close: async () => {},
  };
  await assert.rejects(
    roleTransaction(raw, async () => {}),
    /transaction-capable/,
  );
});

test('HANA rollback failure poisons the connection without enabling autocommit', async () => {
  const statements: string[] = [];
  const raw: HanaClient = {
    exec: async (sql) => {
      statements.push(sql);
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
      return { rowCount: 1 };
    },
    query: async () => [],
    close: async () => {
      statements.push('close');
    },
  };
  const client = transactionalHanaClient(raw, (enabled) => {
    statements.push(`autocommit:${enabled}`);
  });
  await assert.rejects(
    roleTransaction(client, async () => {
      throw new Error('write failed');
    }),
  );
  assert.equal(statements.includes('autocommit:true'), false);
  await assert.rejects(client.exec('must not write'));
  assert.equal(statements.includes('must not write'), false);
  assert.ok(statements.includes('close'));
});
