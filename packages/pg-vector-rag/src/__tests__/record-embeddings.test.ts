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
      legacyFragmentTable: shared ? undefined : table,
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
    const fragments = () => {
      const row = rows().find((row) => row.id === 'long');
      return row?.fragments;
    };

    const legacy = await rag.query(lookup, 1);
    assert.ok(legacy.ok);
    assert.equal(legacy.value[0]?.text, 'legacy');
    if (!shared)
      assert.ok(
        store.statements.some((sql) => sql.startsWith('ALTER TABLE "docs"')),
      );

    assert.ok((await rag.upsert(full, { id: 'long' })).ok);
    assert.deepEqual(embedded, ['early\n\n', 'middle\n\n', 'finish']);
    assert.deepEqual(fragments(), [
      [1, 0],
      [0, 1],
    ]);
    assert.equal(rows().length, 2);

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
    assert.equal(fragments(), undefined);
  });
}
