import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  INVALID_ARGUMENT,
  RAG_COLLECTION_NOT_FOUND,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import {
  CONFORMANCE_EMBEDDING_DIM,
  conformanceEmbedder,
} from '@mcp-abap-adt/llm-agent/testing/scan-delete-conformance';
import { updateRecordSql } from '../catalog.js';
import { PgVectorRagProvider } from '../pg-vector-rag-provider.js';
import { storingPg } from './storing-pg.js';

const DIM = CONFORMANCE_EMBEDDING_DIM;
const embedder = symmetricEmbedder(conformanceEmbedder());
const connection = { collectionName: '__unused', dimension: DIM };

describe('updateRecordSql', () => {
  it('keeps a column whose parameter is NULL and never touches key, scope or owner', () => {
    assert.equal(
      updateRecordSql('rag_collections'),
      'UPDATE "rag_collections" SET collection_name = COALESCE($1, collection_name), attributes_json = COALESCE($2, attributes_json) WHERE store_name = $3',
    );
  });

  it('qualifies the table with the schema of the shared layout', () => {
    assert.equal(
      updateRecordSql('rag_collections', 'rag'),
      'UPDATE "rag"."rag_collections" SET collection_name = COALESCE($1, collection_name), attributes_json = COALESCE($2, attributes_json) WHERE store_name = $3',
    );
  });
});

describe('PgVectorRagProvider.updateCollection', () => {
  const provider = (
    pg: ReturnType<typeof storingPg>,
    layout: 'shared' | 'per-collection',
    schema?: string,
  ) =>
    new PgVectorRagProvider({
      name: 'pg',
      embedder,
      connection: { ...connection, ...(schema ? { schema } : {}) },
      layout,
      clientFactory: () => pg,
    });

  it('an empty patch is INVALID_ARGUMENT before any statement', async () => {
    const pg = storingPg({ sharedDimension: DIM });
    const p = provider(pg, 'shared');
    for (const patch of [
      {},
      { collectionName: undefined, attributes: undefined },
    ]) {
      const r = await p.updateCollection('a', patch);
      assert.ok(!r.ok);
      assert.equal(r.error.code, INVALID_ARGUMENT);
    }
    assert.deepEqual(pg.statements, []);
  });

  it('shared: runs the memoised check first and returns its failure unchanged', async () => {
    const pg = storingPg({ sharedDimension: 8 });
    const r = await provider(pg, 'shared').updateCollection('a', {
      attributes: { x: 1 },
    });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'SHARED_LAYOUT_NOT_DEPLOYED');
    assert.ok(pg.statements.every((q) => !q.startsWith('UPDATE')));
  });

  it('shared: updates through the schema-qualified catalog; an absent record is RAG_COLLECTION_NOT_FOUND and nothing is created', async () => {
    const pg = storingPg({ sharedDimension: DIM });
    const p = provider(pg, 'shared', 'rag');
    const created = await p.createCollection('a', { scope: 'global' });
    assert.ok(created.ok);
    const ok = await p.updateCollection('a', { collectionName: 'Display' });
    assert.ok(ok.ok);
    const missing = await p.updateCollection('nope', { collectionName: 'x' });
    assert.ok(!missing.ok);
    assert.equal(missing.error.code, RAG_COLLECTION_NOT_FOUND);
    const described = await p.describeCollections();
    assert.ok(described.ok);
    assert.deepEqual(
      described.value.records.map((r) => [r.storeName, r.name]),
      [['a', 'Display']],
    );
    assert.ok(
      pg.statements.some((q) => q.startsWith('UPDATE "rag"."rag_collections"')),
    );
  });

  it('per-collection: a catalog table that does not exist is RAG_COLLECTION_NOT_FOUND', async () => {
    const pg = storingPg();
    const custom = Object.assign(Object.create(pg), {
      query: async (sql: string, params?: readonly unknown[]) =>
        sql.startsWith('SELECT to_regclass')
          ? { rows: [{ present: false }], rowCount: 1 }
          : pg.query(sql, params),
    });
    const p = new PgVectorRagProvider({
      name: 'pg',
      embedder,
      connection,
      clientFactory: () => custom,
    });
    const r = await p.updateCollection('a', { attributes: { x: 1 } });
    assert.ok(!r.ok);
    assert.equal(r.error.code, RAG_COLLECTION_NOT_FOUND);
    assert.ok(pg.statements.every((q) => !q.startsWith('UPDATE')));
  });

  it('a failing UPDATE is RAG_UPDATE_ERROR', async () => {
    const pg = storingPg({ sharedDimension: DIM });
    const failing = {
      ...pg,
      query: async (sql: string, params?: readonly unknown[]) => {
        if (sql.startsWith('UPDATE')) throw new Error('down');
        return pg.query(sql, params);
      },
    };
    const p = new PgVectorRagProvider({
      name: 'pg',
      embedder,
      connection,
      layout: 'shared',
      clientFactory: () => failing,
    });
    const r = await p.updateCollection('a', { attributes: { x: 1 } });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'RAG_UPDATE_ERROR');
  });
});
