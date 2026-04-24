import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
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
  it('createCollection returns rag + editor, runs schema bootstrap when autoCreateSchema=true', async () => {
    const client = makeFakeClient();
    const provider = new HanaVectorRagProvider({
      name: 'hana',
      embedder: makeEmbedder(),
      connection: {
        collectionName: '__ignored',
        host: 'h',
        user: 'u',
        password: 'p',
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
      embedder: makeEmbedder(),
      connection: {
        collectionName: '__ignored',
        host: 'h',
        user: 'u',
        password: 'p',
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
      embedder: makeEmbedder(),
      connection: {
        collectionName: '__ignored',
        host: 'h',
        user: 'u',
        password: 'p',
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
      embedder: makeEmbedder(),
      connection: {
        collectionName: '__ignored',
        host: 'h',
        user: 'u',
        password: 'p',
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
      embedder: makeEmbedder(),
      connection: {
        collectionName: '__ignored',
        host: 'h',
        user: 'u',
        password: 'p',
      },
      clientFactory: () => client,
      supportedScopes: ['global'],
    });
    const r = await provider.createCollection('docs', { scope: 'session' });
    assert.equal(r.ok, false);
  });
});
