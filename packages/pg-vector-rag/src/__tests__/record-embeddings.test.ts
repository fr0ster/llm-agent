import assert from 'node:assert/strict';
import { test } from 'node:test';
import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import { PgVectorRag } from '../pg-vector-rag.js';
import { storingPg } from './storing-pg.js';

for (const layout of ['shared', 'per-collection'] as const) {
  test(`fragment vectors stay on one ${layout} record through replacement and deletion`, async () => {
    const embedded: string[] = [];
    const full = 'early\n\nmiddle\n\nfinish';
    const embedder = symmetricEmbedder({
      async embed(text) {
        embedded.push(text);
        return { vector: text.includes('finish') ? [0, 1] : [1, 0] };
      },
    });
    const shared = layout === 'shared';
    const table = shared ? 'rag_documents' : 'docs';
    const store = storingPg({
      sharedDimension: 2,
      legacyTable: shared ? undefined : table,
    });
    store.insertSharedRow({
      table: `"${table}"`,
      ...(shared ? { collection: 'docs' } : {}),
      id: 'legacy',
      text: 'legacy',
      vector: [1, 1],
      metadata: {},
    });
    const rag = new PgVectorRag(
      {
        collectionName: 'docs',
        dimension: 2,
        layout,
        autoCreateSchema: false,
        embedder,
        fragmentSizeChars: 8,
      },
      store,
      undefined,
      !shared,
    );
    const lookup = { text: 'finish', toVector: async () => [0, 1] };
    const rows = () => store.storedRows();
    const fragments = () =>
      rows()
        .filter((row) => row.id === 'long' && (row.ordinal ?? 0) > 0)
        .map((row) => row.vector);

    const legacy = await rag.query(lookup, 1);
    assert.ok(legacy.ok);
    assert.equal(legacy.value[0]?.text, 'legacy');
    assert.equal(rows()[0].ordinal, 0);
    if (!shared)
      assert.ok(
        store.statements.some((sql) => sql.includes('LOCK TABLE "docs"')),
      );

    assert.ok((await rag.upsert(full, { id: 'long' })).ok);
    assert.ok(
      rows()
        .filter((row) => (row.ordinal ?? 0) > 0)
        .every((row) => row.text === null),
    );
    assert.deepEqual(embedded, ['early\n\n', 'middle\n\n', 'finish']);
    assert.deepEqual(fragments(), [
      [1, 0],
      [0, 1],
    ]);
    assert.equal(rows().length, 4);

    const best = await rag.query(lookup, 1);
    assert.ok(best.ok);
    assert.equal(best.value[0]?.text, full);

    const search = await rag.query(lookup, 2);
    assert.ok(search.ok);
    assert.deepEqual(
      search.value.map((hit) => hit.text),
      [full, 'legacy'],
    );
    assert.equal(search.value[0]?.score, 1);

    for (const [id, identity] of [
      ['session', { sessionId: 'private-session' }],
      ['user', { userId: 'private-user' }],
    ] as const) {
      assert.ok((await rag.upsert(full, { id, ...identity })).ok);
      const scoped = await rag.query(lookup, 5, { ragFilter: identity });
      assert.ok(scoped.ok);
      assert.deepEqual(
        scoped.value.map((hit) => hit.metadata.id),
        [id],
      );
      assert.equal(scoped.value[0].score, 1);
      const global = await rag.query(lookup, 5, {
        ragFilter: { owner: { scope: 'global' } },
      });
      assert.ok(global.ok);
      assert.ok(global.value.every((hit) => hit.metadata.id !== id));
      const deleted = await rag.deleteWhere(identity);
      assert.ok(deleted.ok);
      assert.equal(deleted.value.deleted, 1);
    }

    // The two closest fragments belong to the same record for this query.
    const withDuplicateCandidates = await rag.query(
      { text: 'early', toVector: async () => [1, 0] },
      2,
    );
    assert.ok(withDuplicateCandidates.ok);
    assert.deepEqual(
      withDuplicateCandidates.value.map((hit) => hit.text),
      [full, 'legacy'],
    );

    const byId = await rag.getById('long');
    const list = await rag.list({ includeText: true });
    const scan = await rag.scan();
    assert.ok(byId.ok && list.ok && scan.ok);
    assert.equal(byId.value?.text, full);
    assert.deepEqual(
      list.value.records.filter((r) => r.id === 'long').map((r) => r.text),
      [full],
    );
    assert.deepEqual(
      scan.value.records.filter((r) => r.id === 'long').map((r) => r.text),
      [full],
    );

    assert.ok((await rag.upsert('short', { id: 'long' })).ok);
    assert.equal(embedded.at(-1), 'short');
    assert.deepEqual(fragments(), []);
    const replaced = await rag.query(lookup, 1);
    assert.ok(replaced.ok);
    assert.equal(replaced.value[0]?.text, 'legacy');

    assert.ok((await rag.upsert(full, { id: 'long' })).ok);
    assert.ok((await rag.upsertPrecomputed(full, [1, 0], { id: 'long' })).ok);
    assert.deepEqual(fragments(), []);
    assert.ok((await rag.upsert(full, { id: 'long' })).ok);
    assert.ok((await rag.writer().deleteByIdRaw('long')).ok);
    assert.equal(rows().length, 1);
    assert.deepEqual(fragments(), []);
  });
}
