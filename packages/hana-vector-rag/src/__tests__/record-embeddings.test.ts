import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staticLogin, symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import { HanaVectorRag } from '../hana-vector-rag.js';
import { storingHana } from './storing-hana.js';

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
    const table = shared ? 'RAG_DOCUMENTS' : 'docs';
    const store = storingHana({ dimension: 2 });
    if (!shared) store.createCollectionTable(table, true);
    store.insertRow(table, {
      ...(shared ? { COLLECTION: 'docs' } : {}),
      ID: 'legacy',
      TEXT: 'legacy',
      VECTOR: [1, 1],
      METADATA: '{}',
    });
    const rag = new HanaVectorRag(
      {
        collectionName: 'docs',
        dimension: 2,
        layout,
        autoCreateSchema: false,
        credential: staticLogin('user', 'password'),
        embedder,
        fragmentSizeChars: 8,
      },
      store.client,
      undefined,
      !shared,
    );
    const lookup = { text: 'finish', toVector: async () => [0, 1] };
    const rows = () => store.storedRows(table);
    const fragments = () => {
      const row = rows().find((row) => row.ID === 'long');
      return typeof row?.FRAGMENT_VECTORS === 'string'
        ? JSON.parse(row.FRAGMENT_VECTORS)
        : row?.FRAGMENT_VECTORS;
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
    assert.deepEqual(fragments(), null);
    const replaced = await rag.query(lookup, 1);
    assert.ok(replaced.ok);
    assert.equal(replaced.value[0]?.text, 'legacy');

    assert.ok((await rag.upsert(full, { id: 'long' })).ok);
    assert.ok((await rag.upsertPrecomputed(full, [1, 0], { id: 'long' })).ok);
    assert.deepEqual(fragments(), null);
    assert.ok((await rag.upsert(full, { id: 'long' })).ok);
    assert.ok((await rag.writer().deleteByIdRaw('long')).ok);
    assert.equal(rows().length, 1);
    assert.equal(fragments(), undefined);
  });
}
