import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  RagError,
  staticLogin,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import type { HanaClient } from '../hana-vector-rag.js';
import { HanaVectorRagProvider } from '../hana-vector-rag-provider.js';

function makeEmbedder(): IEmbedder {
  return {
    async embed() {
      return { vector: [0, 0, 0] };
    },
  };
}

interface ExecCall {
  sql: string;
  params: readonly unknown[];
}

function makeFakeClient(
  rows: Record<string, unknown>[] = [],
): HanaClient & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  return {
    calls,
    async exec(sql, params = []) {
      calls.push({ sql, params });
      return { rowCount: 1 };
    },
    async query(sql, params = []) {
      calls.push({ sql, params });
      return rows;
    },
    async close() {},
  };
}

describe('HanaVectorRagProvider', () => {
  for (const layout of ['per-collection', 'shared'] as const) {
    it(`rejects a mismatched dimension before SQL in ${layout} layout`, async () => {
      const client = makeFakeClient();
      const provider = new HanaVectorRagProvider({
        name: 'test',
        embedder: symmetricEmbedder(makeEmbedder()),
        connection: {
          collectionName: '__ignored',
          host: 'h',
          credential: staticLogin('u', 'p'),

          dimension: 3,
        },
        defaultDimension: 8,
        layout,
        clientFactory: () => client,
      });
      const result = await provider.createCollection('docs', {
        scope: 'global',
        dimension: 8,
      });
      assert.ok(!result.ok);
      assert.ok(result.error instanceof RagError);
      assert.match(result.error.message, /dimension 8.*configured dimension 3/);
      assert.equal(client.calls.length, 0);
    });
  }

  it('accepts a dimension equal to the configured dimension', async () => {
    const client = makeFakeClient();
    const provider = new HanaVectorRagProvider({
      name: 'test',
      embedder: symmetricEmbedder(makeEmbedder()),
      connection: {
        collectionName: '__ignored',
        host: 'h',
        credential: staticLogin('u', 'p'),

        dimension: 3,
      },
      defaultDimension: 8,
      autoCreateSchema: true,
      clientFactory: () => client,
    });
    const result = await provider.createCollection('docs', {
      scope: 'global',
      dimension: 3,
    });
    assert.ok(result.ok);
    assert.ok(
      client.calls.some(
        (call) =>
          call.sql.includes('CREATE TABLE') && call.sql.includes('"docs"'),
      ),
    );
  });

  it('createCollection returns rag + editor, runs schema bootstrap when autoCreateSchema=true', async () => {
    const client = makeFakeClient();
    const provider = new HanaVectorRagProvider({
      name: 'hana',
      embedder: symmetricEmbedder(makeEmbedder()),
      connection: {
        collectionName: '__ignored',
        host: 'h',
        credential: staticLogin('u', 'p'),
      },
      defaultDimension: 3,
      autoCreateSchema: true,
      clientFactory: () => client,
    });
    const r = await provider.createCollection('docs', {
      scope: 'session',
      sessionId: 's1',
    });
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error('unreachable');
    assert.ok(
      client.calls.some(
        (c) => c.sql.includes('CREATE TABLE') && c.sql.includes('"docs"'),
      ),
    );
  });

  it('createCollection skips DDL when autoCreateSchema=false', async () => {
    const client = makeFakeClient();
    const provider = new HanaVectorRagProvider({
      name: 'hana',
      embedder: symmetricEmbedder(makeEmbedder()),
      connection: {
        collectionName: '__ignored',
        host: 'h',
        credential: staticLogin('u', 'p'),
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
    const provider = new HanaVectorRagProvider({
      name: 'hana',
      embedder: symmetricEmbedder(makeEmbedder()),
      connection: {
        collectionName: '__ignored',
        host: 'h',
        credential: staticLogin('u', 'p'),
      },
      clientFactory: () => client,
    });
    const r = await provider.deleteCollection('docs');
    assert.equal(r.ok, true);
    assert.ok(client.calls.some((c) => c.sql.startsWith('DROP TABLE')));
  });

  it('listCollections queries SYS.TABLES and returns names', async () => {
    const client = makeFakeClient([
      { TABLE_NAME: 'docs' },
      { TABLE_NAME: 'other' },
    ]);
    const provider = new HanaVectorRagProvider({
      name: 'hana',
      embedder: symmetricEmbedder(makeEmbedder()),
      connection: {
        collectionName: '__ignored',
        host: 'h',
        credential: staticLogin('u', 'p'),
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
    const provider = new HanaVectorRagProvider({
      name: 'hana',
      embedder: symmetricEmbedder(makeEmbedder()),
      connection: {
        collectionName: '__ignored',
        host: 'h',
        credential: staticLogin('u', 'p'),
      },
      clientFactory: () => client,
      supportedScopes: ['global'],
    });
    const r = await provider.createCollection('docs', {
      scope: 'session',
      sessionId: 's1',
    });
    assert.equal(r.ok, false);
  });
});
