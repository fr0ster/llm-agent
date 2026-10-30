import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { staticLogin, symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import { ragListConformanceCases } from '@mcp-abap-adt/llm-agent/testing/rag-list-conformance';
import { PgVectorRag } from '../pg-vector-rag.js';
import { storingPg } from './storing-pg.js';

for (const layout of ['per-collection', 'shared'] as const) {
  describe(`Pg listing conformance (${layout})`, () => {
    for (const test of ragListConformanceCases)
      it(test.name, async () => {
        const db = storingPg({ sharedDimension: 3 });
        let sequence = 0;
        await test.run(async () => {
          const collectionName = `collection_${sequence++}`;

          return new PgVectorRag(
            {
              collectionName,
              layout,
              dimension: 3,
              autoCreateSchema: false,
              embedder: symmetricEmbedder({
                embed: async () => ({ vector: [1, 0, 0] }),
              }),
            },
            db,
          );
        });
      });
  });
}

for (const layout of ['per-collection', 'shared'] as const) {
  function handle(
    schema = 'tenant_a',
    database = 'catalog_a',
    user = 'u',
    password = 'p',
  ) {
    const db = storingPg({ sharedDimension: 3, schema, database });
    const client = db;
    const rag = new PgVectorRag(
      {
        collectionName: 'cursor_scope',
        layout,
        dimension: 3,
        autoCreateSchema: false,
        credential: staticLogin(user, password),
        embedder: symmetricEmbedder({
          embed: async () => ({ vector: [1, 0, 0] }),
        }),
      },
      client,
    );
    return { rag, db };
  }

  it(`returns ABORTED when identity lookup aborts with conflicting filters (${layout})`, async () => {
    const { rag, db } = handle();
    const controller = new AbortController();
    const client = db;
    const query = client.query.bind(client);
    let identityLookups = 0;
    client.query = async (sql, params) => {
      const result = await query(sql, params);
      if (sql.includes('AS "listDatabase"')) {
        identityLookups++;
        controller.abort();
      }
      return result;
    };

    const result = await rag.list(
      { filter: { userId: 'requested-user' } },
      { ragFilter: { userId: 'scoped-user' }, signal: controller.signal },
    );
    assert.equal(identityLookups, 1);
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'ABORTED');
  });

  it(`retries failed identity lookups and memoises success (${layout})`, async () => {
    const { rag, db } = handle();
    const client = db;
    const query = client.query.bind(client);
    let attempts = 0;
    client.query = async (sql, params) => {
      if (sql.includes('AS "listDatabase"') && ++attempts === 1)
        throw new Error('Transient identity lookup failure');
      return query(sql, params);
    };
    const failed = await rag.list();
    assert.ok(!failed.ok);
    assert.ok((await rag.list()).ok);
    assert.ok((await rag.list()).ok);
    assert.equal(attempts, 2);
  });

  it(`traverses an empty record ID (${layout})`, async () => {
    const { rag } = handle();
    for (const id of ['', 'a'])
      assert.ok((await rag.writer().upsertRaw(id, id, {})).ok);
    const first = await rag.list({ limit: 1 });
    assert.ok(first.ok);
    assert.deepEqual(
      first.value.records.map((record) => record.id),
      [''],
    );
    assert.ok(first.value.cursor);
    const second = await rag.list({ limit: 1, cursor: first.value.cursor });
    assert.ok(second.ok);
    assert.deepEqual(
      second.value.records.map((record) => record.id),
      ['a'],
    );
  });

  it(`binds cursors to resolved defaults and memoises identity (${layout})`, async () => {
    const { rag, db } = handle();
    for (const id of ['a', 'b'])
      assert.ok((await rag.writer().upsertRaw(id, id, {})).ok);
    const first = await rag.list({ limit: 1 });
    assert.ok(first.ok);
    assert.ok(first.value.cursor);
    assert.ok((await rag.list({ cursor: first.value.cursor })).ok);
    assert.ok(
      (
        await handle(
          'tenant_a',
          'catalog_a',
          'another-user',
          'another-secret',
        ).rag.list({ cursor: first.value.cursor })
      ).ok,
    );
    for (const target of [
      handle('tenant_b'),
      handle('tenant_a', 'catalog_b'),
    ]) {
      const result = await target.rag.list({ cursor: first.value.cursor });
      assert.ok(!result.ok);
      assert.equal(result.error.code, 'INVALID_ARGUMENT');
      for (const id of ['a', 'b'])
        assert.ok((await target.rag.writer().upsertRaw(id, id, {})).ok);
      const targetPage = await target.rag.list({ limit: 1 });
      assert.ok(targetPage.ok);
      assert.ok(targetPage.value.cursor);
      const reverse = await rag.list({ cursor: targetPage.value.cursor });
      assert.ok(!reverse.ok);
      assert.equal(reverse.error.code, 'INVALID_ARGUMENT');
    }
    assert.equal(
      db.statements.filter((sql) => sql.includes('AS "listDatabase"')).length,
      1,
    );
    const decoded = Buffer.from(first.value.cursor, 'base64url').toString();
    assert.ok(!decoded.includes('another-secret'));
    assert.ok(!decoded.includes('another-user'));
  });
}
