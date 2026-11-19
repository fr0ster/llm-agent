import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import { type PgClient, PgVectorRag } from '../pg-vector-rag.js';
import { PgVectorRagProvider } from '../pg-vector-rag-provider.js';
import { recordTransaction } from '../scan-delete.js';
import { serializePgClient } from '../single-connection.js';

const config = {
  collectionName: 'docs',
  dimension: 2,
  layout: 'per-collection' as const,
  autoCreateSchema: false,
  embedder: symmetricEmbedder({
    embed: async () => ({ vector: [1, 0] }),
  }),
};

function barrier() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function singleConnection() {
  const entered = barrier();
  const resume = barrier();
  const statements: string[] = [];
  let committed = new Map<string, string[]>([
    ['a', ['old text', 'old fragment 1', 'old fragment 2']],
  ]);
  let pending: typeof committed | undefined;
  const client: PgClient = {
    async query(sql, [id, text] = []) {
      const rows = pending ?? committed;
      if (sql === 'BEGIN') {
        statements.push(sql);
        pending ??= new Map(committed);
      } else if (sql === 'COMMIT') {
        statements.push(sql);
        committed = rows;
        pending = undefined;
      } else if (sql === 'ROLLBACK') {
        statements.push(sql);
        pending = undefined;
      } else if (sql.includes('WITH ORDINALITY')) {
        statements.push('insert fragments');
        entered.resolve();
        await resume.promise;
        throw new Error('fragment insert failed');
      } else if (sql.startsWith('INSERT INTO')) {
        statements.push(`upsert ${id}`);
        rows.set(String(id), [
          String(text),
          ...(rows.get(String(id)) ?? []).slice(1),
        ]);
      } else if (sql.startsWith('DELETE FROM')) {
        statements.push(`prune ${id}`);
        rows.set(String(id), (rows.get(String(id)) ?? []).slice(0, 1));
      } else {
        statements.push(sql);
      }
      return { rows: [], rowCount: 0 };
    },
    end: async () => {},
  };
  return { client, entered, resume, statements, committed: () => committed };
}

test('a failed fragment replacement rolls back before another handle commits', async () => {
  const db = singleConnection();
  const original = db.committed().get('a');
  const first = new PgVectorRag(config, db.client);
  const second = new PgVectorRag(config, db.client);
  const a = first.upsertPrecomputed(
    'new text',
    [
      [1, 0],
      [0, 1],
    ],
    { id: 'a' },
  );
  await db.entered.promise;
  const b = second.upsertPrecomputed('independent text', [1, 0], { id: 'b' });
  await setImmediate();
  db.resume.resolve();
  const [failed, succeeded] = await Promise.all([a, b]);
  assert.ok(!failed.ok);
  assert.match(failed.error.message, /fragment insert failed/);
  assert.ok(succeeded.ok);
  assert.deepEqual(db.committed().get('a'), original);
  assert.deepEqual(db.committed().get('b'), ['independent text']);
  assert.deepEqual(db.statements, [
    'BEGIN',
    'upsert a',
    'prune a',
    'insert fragments',
    'ROLLBACK',
    'BEGIN',
    'upsert b',
    'prune b',
    'COMMIT',
  ]);
});

test('a provider statement on the same connection waits for rollback', async () => {
  const db = singleConnection();
  const store = new PgVectorRag(config, db.client);
  const provider = new PgVectorRagProvider({
    ...config,
    connection: config,
    name: 'test',
    clientFactory: () => db.client,
  });
  const write = store.upsertPrecomputed(
    'new text',
    [
      [1, 0],
      [0, 1],
    ],
    { id: 'a' },
  );
  await db.entered.promise;
  const list = provider.listCollections();
  await setImmediate();
  db.resume.resolve();
  const [failed, listed] = await Promise.all([write, list]);
  assert.ok(!failed.ok);
  assert.ok(listed.ok);
  assert.equal(db.statements[4], 'ROLLBACK');
  assert.match(db.statements[5], /^SELECT table_name/);
});

test('aborted queries and transactions leave the queue before the current write finishes', async () => {
  const db = singleConnection();
  const store = new PgVectorRag(config, db.client);
  const write = store.upsertPrecomputed(
    'new text',
    [
      [1, 0],
      [0, 1],
    ],
    { id: 'a' },
  );
  await db.entered.promise;
  const control = new AbortController();
  const options = { signal: control.signal };
  const queued = Promise.all([
    store.upsertPrecomputed('cancelled', [1, 0], { id: 'b' }, options),
    store.scan(undefined, options),
    store.list(undefined, options),
    new PgVectorRag({ ...config, autoCreateSchema: true }, db.client).getById(
      'cold',
      options,
    ),
  ]);
  await setImmediate();
  control.abort();
  const completed = await Promise.race([
    queued,
    setImmediate().then(() => undefined),
  ]);
  db.resume.resolve();
  await Promise.all([write, queued]);
  assert.ok(completed);
  for (const result of completed) {
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'ABORTED');
  }
  assert.deepEqual(db.statements, [
    'BEGIN',
    'upsert a',
    'prune a',
    'insert fragments',
    'ROLLBACK',
  ]);
});

test('clients with a transaction runner keep their identity', () => {
  const { client: raw } = singleConnection();
  const client: PgClient = {
    ...raw,
    transaction: (work) => work(raw),
  };
  assert.equal(serializePgClient(client), client);
});

test('a rollback failure preserves the original error and releases the queue', async () => {
  const failure = new Error('transaction failed');
  const statements: string[] = [];
  const client = serializePgClient({
    async query(sql) {
      statements.push(sql);
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
      return { rows: [], rowCount: 0 };
    },
    end: async () => {},
  });
  const transaction = recordTransaction(client, async () => {
    throw failure;
  });
  const query = client.query('SELECT 1');
  await assert.rejects(transaction, (error) => error === failure);
  await query;
  assert.deepEqual(statements, ['BEGIN', 'ROLLBACK', 'SELECT 1']);
});
