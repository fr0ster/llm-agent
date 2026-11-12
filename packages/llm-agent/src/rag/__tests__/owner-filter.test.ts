import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ragIdentityFilter } from '../identity-filter.js';
import { InMemoryRag } from '../in-memory-rag.js';
import { TextOnlyEmbedding } from '../query-embedding.js';

test('in-memory rejects role identities and applies positive global predicates before top-k, including null ownership tags', async () => {
  const rag = new InMemoryRag({ dedupThreshold: 2 });
  for (const [text, metadata] of [
    ['query private session', { sessionId: 's' }],
    ['query private user', { userId: 'u' }],
    ['query private role', { roleId: 'r' }],
    ['query global first', {}],
    ['query global second', {}],
    ['query tagged null', { roleId: null }],
  ] as const) {
    assert.equal(
      (await rag.upsert(text, metadata)).ok,
      !('roleId' in metadata),
    );
  }
  const global = await rag.query(new TextOnlyEmbedding('query'), 2, {
    ragFilter: { owner: { scope: 'global' } },
  });
  assert.ok(global.ok);
  assert.deepEqual(global.value.map((row) => row.text).sort(), [
    'query global first',
    'query global second',
  ]);
  assert.throws(
    () => ragIdentityFilter({ ragFilter: { roleId: 'r' } }),
    /no longer/,
  );
});
