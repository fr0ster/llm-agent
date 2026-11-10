import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryRag } from '../in-memory-rag.js';
import { TextOnlyEmbedding } from '../query-embedding.js';

test('in-memory applies role and no-owner predicates before top-k, including null ownership tags', async () => {
  const rag = new InMemoryRag({ dedupThreshold: 2 });
  for (const [text, metadata] of [
    ['query private session', { sessionId: 's' }],
    ['query private user', { userId: 'u' }],
    ['query private role', { roleId: 'r' }],
    ['query global first', {}],
    ['query global second', {}],
    ['query tagged null', { roleId: null }],
  ] as const) {
    assert.ok((await rag.upsert(text, metadata)).ok);
  }
  const global = await rag.query(new TextOnlyEmbedding('query'), 2, {
    ragFilter: { owner: { scope: 'global' } },
  });
  assert.ok(global.ok);
  assert.deepEqual(global.value.map((row) => row.text).sort(), [
    'query global first',
    'query global second',
  ]);
  const role = await rag.query(new TextOnlyEmbedding('query'), 2, {
    ragFilter: { roleId: 'r' },
  });
  assert.ok(role.ok);
  assert.deepEqual(
    role.value.map((row) => row.text),
    ['query private role'],
  );
});
