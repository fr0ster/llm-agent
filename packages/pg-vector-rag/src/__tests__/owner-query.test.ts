import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CallOptions,
  QueryEmbedding,
  tagRagMetadata,
} from '@mcp-abap-adt/llm-agent';
import { PgVectorRag } from '../pg-vector-rag.js';
import { sharedLayoutSql } from '../shared-ddl.js';
import { accessFixture } from './access-fixture.js';

for (const layout of ['shared', 'per-collection'] as const)
  test(`PG ${layout} applies session/user/global owner predicates before top-k`, {
    skip: !process.env.PG_TEST_URL,
  }, async () => {
    const f = await accessFixture();
    try {
      await f.client.query('CREATE EXTENSION IF NOT EXISTS vector');
      for (const statement of sharedLayoutSql({ dimension: 3 })
        .split(';')
        .filter((s) => s.trim()))
        await f.client.query(statement);
      const rag = new PgVectorRag(
        {
          collectionName: 'shared',
          dimension: 3,
          layout,
          embedder: f.embedder,
        },
        f.client,
      );
      if (layout === 'per-collection') await rag.ensureSchema();
      for (const [id, metadata] of [
        ['legacy', { sessionId: 's' }],
        ['mismatch', { ownerScope: 'user', sessionId: 's' }],
        ['session', { sessionId: 's' }],
        ['session2', { sessionId: 's' }],
        ['user', { userId: 'u' }],
        ['user2', { userId: 'u' }],
        ['role', { roleId: 'r' }],
        ['role2', { roleId: 'r' }],
        ['foreign', { sessionId: 'other', userId: 'other', roleId: 'other' }],
        ['global1', {}],
        ['global2', {}],
        ['null-owner', { roleId: null }],
      ] as const) {
        await f.client.query(
          layout === 'shared'
            ? `INSERT INTO rag_documents (collection, id, text, vector, metadata) VALUES ('shared', $1::varchar, $1::text, $2::vector, $3::jsonb)`
            : `INSERT INTO shared (id, text, vector, metadata) VALUES ($1::varchar, $1::text, $2::vector, $3::jsonb)`,
          [
            id,
            id === 'foreign' || id === 'null-owner' ? '[1,0,0]' : '[0,1,0]',
            JSON.stringify(
              id === 'legacy' || id === 'mismatch'
                ? metadata
                : tagRagMetadata(metadata),
            ),
          ],
        );
      }
      for (const [ragFilter, expected] of [
        [{ sessionId: 's' }, ['session', 'session2']],
        [{ userId: 'u' }, ['user', 'user2']],

        [{ owner: { scope: 'global' } }, ['global1', 'global2']],
      ] satisfies [CallOptions['ragFilter'], string[]][]) {
        const result = await rag.query(
          new QueryEmbedding('query', f.embedder),
          2,
          { ragFilter },
        );
        assert.ok(result.ok);
        assert.deepEqual(
          result.value.map((r) => r.metadata.id).sort(),
          expected,
        );
      }
    } finally {
      await f.close();
    }
  });
