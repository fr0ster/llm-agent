import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staticLogin, symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import { type HanaClient, HanaVectorRag } from '../hana-vector-rag.js';
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
    const fragments = () =>
      rows()
        .filter((row) => row.ID === 'long' && Number(row.FRAGMENT_ORDINAL) > 0)
        .map((row) => row.VECTOR);

    const legacy = await rag.query(lookup, 1);
    assert.ok(legacy.ok);
    assert.equal(legacy.value[0]?.text, 'legacy');
    assert.equal(rows()[0].FRAGMENT_ORDINAL, 0);
    if (!shared)
      assert.ok(
        store.statements.some((sql) => sql.includes('ALTER TABLE "docs" ADD')),
      );
    assert.ok((await rag.upsert(full, { id: 'long' })).ok);
    assert.ok(
      rows()
        .filter((row) => Number(row.FRAGMENT_ORDINAL) > 0)
        .every((row) => row.TEXT === null),
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
    assert.ok(
      (
        await rag.upsertPrecomputed(
          full,
          [
            [1, 0],
            [0, 1],
          ],
          { id: 'long' },
        )
      ).ok,
    );
    assert.deepEqual(fragments(), [[0, 1]]);
    assert.ok((await rag.upsertPrecomputed(full, [1, 0], { id: 'long' })).ok);
    assert.deepEqual(fragments(), []);
    assert.ok((await rag.upsert(full, { id: 'long' })).ok);
    assert.ok((await rag.writer().deleteByIdRaw('long')).ok);
    assert.equal(rows().length, 1);
    assert.deepEqual(fragments(), []);
  });
}

test('fragment insert failure rolls back the document and its previous vectors', async () => {
  const db = storingHana({ dimension: 2 });
  const transaction = db.client.transaction?.bind(db.client);
  assert.ok(transaction);
  let fail = false;
  const client: HanaClient = {
    ...db.client,
    transaction(work) {
      return transaction((connection) =>
        work({
          ...connection,
          async exec(sql, params) {
            if (fail && sql.startsWith('INSERT INTO "RAG_DOCUMENTS"'))
              throw new Error('fragment insert failed');
            return connection.exec(sql, params);
          },
        }),
      );
    },
  };
  const rag = new HanaVectorRag(
    {
      collectionName: 'docs',
      dimension: 2,
      layout: 'shared',
      credential: staticLogin('u', 'p'),
      embedder: symmetricEmbedder({
        async embed() {
          return { vector: [0, 1] };
        },
      }),
    },
    client,
  );
  assert.ok(
    (
      await rag.upsertPrecomputed(
        'previous',
        [
          [1, 0],
          [0, 1],
        ],
        { id: 'r' },
      )
    ).ok,
  );
  fail = true;
  assert.equal(
    (
      await rag.upsertPrecomputed(
        'replacement',
        [
          [1, 0],
          [1, 1],
        ],
        { id: 'r' },
      )
    ).ok,
    false,
  );
  const result = await rag.query(
    { text: 'q', toVector: async () => [0, 1] },
    1,
  );
  assert.ok(result.ok);
  assert.equal(result.value[0]?.text, 'previous');
  assert.equal(result.value[0]?.score, 1);
  assert.equal(db.storedRows('RAG_DOCUMENTS').length, 2);
});
