import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CallOptions,
  QueryEmbedding,
  staticLogin,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import { HanaVectorRag } from '../hana-vector-rag.js';
import { storingHana } from './storing-hana.js';

for (const layout of ['shared', 'per-collection'] as const)
  test(`HANA ${layout} owner filters run before top-k`, async () => {
    const db = storingHana({ dimension: 3 });
    if (layout === 'per-collection') db.createCollectionTable('docs');
    const embedder = symmetricEmbedder({
      embed: async () => ({ vector: [1, 0, 0] }),
    });
    const rag = new HanaVectorRag(
      {
        collectionName: 'docs',
        credential: staticLogin('u', 'p'),
        dimension: 3,
        autoCreateSchema: false,
        layout,
        embedder,
      },
      db.client,
    );
    for (const [id, metadata] of [
      ['session', { sessionId: 's' }],
      ['user', { userId: 'u' }],
      ['role', { roleId: 'r' }],
      [
        'foreign',
        { sessionId: 'foreign', userId: 'foreign', roleId: 'foreign' },
      ],
      ['global', {}],
      ['null', { roleId: null }],
      ['numeric', { userId: 123 }],
    ] as const)
      db.insertRow(layout === 'shared' ? 'RAG_DOCUMENTS' : 'docs', {
        ...(layout === 'shared' ? { COLLECTION: 'docs' } : {}),
        ID: id,
        TEXT: id,
        VECTOR: id === 'foreign' || id === 'null' ? [1, 0, 0] : [0, 1, 0],
        METADATA: JSON.stringify(metadata),
      });
    for (const [ragFilter, expected] of [
      [{ sessionId: 's' }, ['session']],
      [{ userId: 'u' }, ['user']],
      [{ roleId: 'r' }, ['role']],
      [{ owner: { scope: 'global' } }, ['global']],
      [{ userId: '123' }, []],
    ] satisfies [CallOptions['ragFilter'], string[]][]) {
      const result = await rag.query(new QueryEmbedding('query', embedder), 1, {
        ragFilter,
      });
      assert.ok(result.ok);
      assert.deepEqual(
        result.value.map((r) => r.metadata.id),
        expected,
      );
      const search = db.statements
        .filter((s) => s.includes('COSINE_SIMILARITY'))
        .at(-1);
      assert.ok(search);
      assert.ok(
        search.includes('JSON_'),
        'owner predicate must execute in HANA SQL',
      );
      assert.ok(search.indexOf('JSON_') < search.indexOf('ORDER BY'));
    }
  });
