import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  INVALID_ARGUMENT,
  RAG_COLLECTION_NOT_FOUND,
  staticLogin,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import {
  CONFORMANCE_EMBEDDING_DIM,
  conformanceEmbedder,
} from '@mcp-abap-adt/llm-agent/testing/scan-delete-conformance';
import { updateRecordSql } from '../catalog.js';
import { HanaVectorRagProvider } from '../hana-vector-rag-provider.js';
import { storingHana } from './storing-hana.js';

const DIM = CONFORMANCE_EMBEDDING_DIM;
const embedder = symmetricEmbedder(conformanceEmbedder());
const connection = {
  collectionName: '__unused',
  dimension: DIM,
  credential: staticLogin('u', 'p'),
};

const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;
const INVALID_ATTRIBUTES = [
  { x: Number.NaN },
  { x: undefined },
  { x: new Date() },
  { x: 10n },
  cyclic,
];

describe('updateRecordSql', () => {
  it('keeps a column whose parameter is NULL and never touches key, scope or owner', () => {
    assert.equal(
      updateRecordSql('RAG_COLLECTIONS'),
      'UPDATE "RAG_COLLECTIONS" SET collection_name = COALESCE(?, collection_name), attributes_json = COALESCE(?, attributes_json) WHERE store_name = ?',
    );
  });
});

describe('HanaVectorRagProvider.updateCollection', () => {
  const shared = () => {
    const hana = storingHana({ dimension: DIM });
    const provider = new HanaVectorRagProvider({
      name: 'hana',
      embedder,
      connection,
      layout: 'shared',
      clientFactory: () => hana.client,
    });
    return { hana, provider };
  };

  it('an empty patch is INVALID_ARGUMENT before any statement', async () => {
    const { hana, provider } = shared();
    for (const patch of [
      {},
      { collectionName: undefined, attributes: undefined },
    ]) {
      const r = await provider.updateCollection('a', patch);
      assert.ok(!r.ok);
      assert.equal(r.error.code, INVALID_ARGUMENT);
    }
    assert.deepEqual(hana.statements, []);
  });

  it('shared: runs the memoised check first and returns its failure unchanged', async () => {
    const hana = storingHana({ dimension: 8 });
    const provider = new HanaVectorRagProvider({
      name: 'hana',
      embedder,
      connection,
      layout: 'shared',
      clientFactory: () => hana.client,
    });
    const r = await provider.updateCollection('a', { attributes: { x: 1 } });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'SHARED_LAYOUT_NOT_DEPLOYED');
    assert.ok(hana.statements.every((q) => !q.startsWith('UPDATE')));
  });

  it('shared: one UPDATE, an absent record is RAG_COLLECTION_NOT_FOUND and nothing is created', async () => {
    const { hana, provider } = shared();
    const missing = await provider.updateCollection('nope', {
      collectionName: 'x',
    });
    assert.ok(!missing.ok);
    assert.equal(missing.error.code, RAG_COLLECTION_NOT_FOUND);
    const described = await provider.describeCollections();
    assert.ok(described.ok);
    assert.deepEqual(described.value.records, []);
    assert.equal(
      hana.statements.filter((q) => q.startsWith('UPDATE')).length,
      1,
    );
  });

  it('per-collection: a catalog table that was never created is RAG_COLLECTION_NOT_FOUND', async () => {
    const hana = storingHana({ dimension: DIM });
    const provider = new HanaVectorRagProvider({
      name: 'hana',
      embedder,
      connection,
      autoCreateSchema: false,
      clientFactory: () => hana.client,
    });
    const r = await provider.updateCollection('a', { attributes: { x: 1 } });
    assert.ok(!r.ok);
    assert.equal(r.error.code, RAG_COLLECTION_NOT_FOUND);
    assert.ok(hana.statements.every((q) => !q.startsWith('UPDATE')));
  });

  it('attributes that have no JSON form are RAG_INVALID_ATTRIBUTES with nothing sent', async () => {
    const { hana, provider } = shared();
    for (const attributes of INVALID_ATTRIBUTES) {
      const r = await provider.updateCollection('a', {
        attributes: attributes as Record<string, unknown>,
      });
      assert.ok(!r.ok);
      assert.equal(r.error.code, 'RAG_INVALID_ATTRIBUTES');
    }
    assert.deepEqual(hana.statements, []);
  });

  it('a name-only patch keeps the attributes, an attributes-only patch keeps the name', async () => {
    const { provider } = shared();
    const made = await provider.createCollection('a', {
      scope: 'global',
      collectionName: 'First',
      attributes: { k: 1 },
    });
    assert.ok(made.ok);
    const read = async () => {
      const d = await provider.describeCollections();
      assert.ok(d.ok);
      return d.value.records[0];
    };
    assert.ok(
      (await provider.updateCollection('a', { collectionName: 'Second' })).ok,
    );
    assert.deepEqual(
      [(await read()).name, (await read()).attributes],
      ['Second', { k: 1 }],
    );
    assert.ok(
      (await provider.updateCollection('a', { attributes: { z: 2 } })).ok,
    );
    assert.deepEqual(
      [(await read()).name, (await read()).attributes],
      ['Second', { z: 2 }],
    );
  });

  it('a failing UPDATE is RAG_UPDATE_ERROR', async () => {
    const hana = storingHana({ dimension: DIM });
    const failing = new HanaVectorRagProvider({
      name: 'hana',
      embedder,
      connection,
      layout: 'shared',
      clientFactory: () => ({
        ...hana.client,
        exec: async () => {
          throw new Error('down');
        },
      }),
    });
    const r = await failing.updateCollection('a', { attributes: { x: 1 } });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'RAG_UPDATE_ERROR');
  });
});
