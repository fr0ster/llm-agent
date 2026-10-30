import assert from 'node:assert/strict';
import { it } from 'node:test';
import { openPgClient, type PgClient } from '../pg-vector-rag.js';

it('transactions use a checked-out connection and release it after success or uncertain commit', async () => {
  const statements: string[] = [];
  let releases = 0;
  let failCommit = false;
  class Pool {
    on(_event: 'error', _listener: (error: Error) => void): void {}
    query: PgClient['query'] = async () => {
      throw new Error('Transaction escaped to the pool');
    };
    async end(): Promise<void> {}
    async connect() {
      const query: PgClient['query'] = async (sql) => {
        statements.push(sql);
        if (failCommit && sql === 'COMMIT')
          throw new Error('Lost commit reply');
        return { rows: [], rowCount: 0 };
      };
      return { query, release: () => releases++ };
    }
  }
  const client = openPgClient(Pool, {});
  assert.ok(client.transaction);
  await client.transaction(async (connection) => {
    await connection.query('SELECT 1');
  });
  assert.deepEqual(statements, ['BEGIN', 'SELECT 1', 'COMMIT']);
  assert.equal(releases, 1);
  statements.length = 0;
  failCommit = true;
  await assert.rejects(
    client.transaction(async (connection) => {
      await connection.query('DELETE FROM docs');
    }),
    /Lost commit reply/,
  );
  assert.deepEqual(statements, [
    'BEGIN',
    'DELETE FROM docs',
    'COMMIT',
    'ROLLBACK',
  ]);
  assert.equal(releases, 2);
});
