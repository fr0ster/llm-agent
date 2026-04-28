import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PgVectorRagProvider } from '../pg-vector-rag-provider.js';

function makeEmbedder() {
  return {
    async embed() {
      return { vector: [0, 0, 0] };
    },
  };
}
function makeFakeClient(rows = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length };
    },
    async end() {},
  };
}
describe('PgVectorRagProvider', () => {
  it('createCollection runs schema bootstrap when autoCreateSchema=true', async () => {
    const client = makeFakeClient();
    const provider = new PgVectorRagProvider({
      name: 'pg',
      embedder: makeEmbedder(),
      connection: {
        collectionName: '__ignored',
        host: 'h',
        user: 'u',
        password: 'p',
        database: 'd',
      },
      defaultDimension: 3,
      autoCreateSchema: true,
      clientFactory: () => client,
    });
    const r = await provider.createCollection('docs', { scope: 'global' });
    assert.equal(r.ok, true);
    assert.ok(
      client.calls.some(
        (c) => c.sql.includes('CREATE TABLE') && c.sql.includes('"docs"'),
      ),
    );
  });
  it('createCollection skips DDL when autoCreateSchema=false', async () => {
    const client = makeFakeClient();
    const provider = new PgVectorRagProvider({
      name: 'pg',
      embedder: makeEmbedder(),
      connection: {
        collectionName: '__ignored',
        host: 'h',
        user: 'u',
        password: 'p',
        database: 'd',
      },
      defaultDimension: 3,
      autoCreateSchema: false,
      clientFactory: () => client,
    });
    const r = await provider.createCollection('docs', { scope: 'global' });
    assert.equal(r.ok, true);
    assert.ok(!client.calls.some((c) => c.sql.includes('CREATE TABLE')));
  });
  it('deleteCollection emits DROP TABLE', async () => {
    const client = makeFakeClient();
    const provider = new PgVectorRagProvider({
      name: 'pg',
      embedder: makeEmbedder(),
      connection: {
        collectionName: '__ignored',
        host: 'h',
        user: 'u',
        password: 'p',
        database: 'd',
      },
      clientFactory: () => client,
    });
    const r = await provider.deleteCollection('docs');
    assert.equal(r.ok, true);
    assert.ok(client.calls.some((c) => c.sql.startsWith('DROP TABLE')));
  });
  it('listCollections queries information_schema.tables', async () => {
    const client = makeFakeClient([
      { table_name: 'docs' },
      { table_name: 'other' },
    ]);
    const provider = new PgVectorRagProvider({
      name: 'pg',
      embedder: makeEmbedder(),
      connection: {
        collectionName: '__ignored',
        host: 'h',
        user: 'u',
        password: 'p',
        database: 'd',
      },
      clientFactory: () => client,
    });
    const r = await provider.listCollections();
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error('unreachable');
    assert.deepEqual(r.value, ['docs', 'other']);
  });
  it('rejects unsupported scope', async () => {
    const client = makeFakeClient();
    const provider = new PgVectorRagProvider({
      name: 'pg',
      embedder: makeEmbedder(),
      connection: {
        collectionName: '__ignored',
        host: 'h',
        user: 'u',
        password: 'p',
        database: 'd',
      },
      clientFactory: () => client,
      supportedScopes: ['global'],
    });
    const r = await provider.createCollection('docs', { scope: 'session' });
    assert.equal(r.ok, false);
  });
});
//# sourceMappingURL=pg-vector-rag-provider.test.js.map
