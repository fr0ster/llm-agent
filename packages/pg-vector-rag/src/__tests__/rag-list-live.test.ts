import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type RagError,
  type Result,
  staticLogin,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import { ragListConformanceCases } from '@mcp-abap-adt/llm-agent/testing/rag-list-conformance';
import { createPgClient, PgVectorRag } from '../pg-vector-rag.js';
import { PgVectorRagProvider } from '../pg-vector-rag-provider.js';
import { sharedLayoutSql } from '../shared-ddl.js';

function value<T>(result: Result<T, RagError>): T {
  if (!result.ok) throw result.error;
  return result.value;
}
const embedder = symmetricEmbedder({
  embed: async () => ({ vector: [1, 0, 0] }),
});
// Explicit opt-in: creates and removes only uniquely named test tables; requires DDL rights.
for (const layout of ['per-collection', 'shared'] as const)
  test(`Pg live listing/cache (${layout})`, {
    skip:
      process.env.RAG_SQL_LISTING_INTEGRATION !== '1' ||
      !process.env.PG_TEST_URL,
  }, async (t) => {
    const address = new URL(process.env.PG_TEST_URL ?? '');
    const user = decodeURIComponent(address.username);
    const password = decodeURIComponent(address.password);
    address.username = '';
    address.password = '';
    const connection = {
      collectionName: 'unused',
      connectionString: address.href,
      credential: user ? staticLogin(user, password) : undefined,
      dimension: 3,
    };
    const client = await createPgClient(connection);
    const suffix = `rl_${Date.now()}_${layout === 'shared' ? 's' : 'p'}`;
    const documentsTable = `${suffix}_docs`;
    const catalogTable = `${suffix}_catalog`;
    const tables: string[] = [];
    const stores: string[] = [];
    let sequence = 0;
    const providers: PgVectorRagProvider[] = [];
    try {
      if (layout === 'shared') {
        tables.push(documentsTable, catalogTable);
        for (const sql of sharedLayoutSql({
          dimension: 3,
          documentsTable,
          catalogTable,
        })
          .split(';')
          .map((part) => part.trim())
          .filter(Boolean))
          await client.query(sql);
      }
      const makeStore = async () => {
        const collectionName = `${suffix}_${sequence++}`;
        const store = new PgVectorRag(
          {
            ...connection,
            collectionName,
            layout,
            documentsTable,
            embedder,
            autoCreateSchema: false,
            recordCache: false,
          },
          client,
        );
        if (layout === 'per-collection') {
          await store.ensureSchema();
          tables.push(collectionName);
        }
        stores.push(collectionName);
        return store;
      };
      for (const item of ragListConformanceCases)
        await t.test(item.name, async () => item.run(makeStore));
      await makeStore();
      const name = stores[stores.length - 1];
      for (let i = 0; i < 2; i++)
        providers.push(
          new PgVectorRagProvider({
            name: `p${i}`,
            connection,
            embedder,
            layout,
            documentsTable,
            catalogTable,
            clientFactory: () => client,
            recordCache: { ttlMs: 100 },
          }),
        );
      const handles = [];
      for (const provider of providers)
        handles.push(
          value(
            await provider.openCollection({
              name,
              storeName: name,
              scope: 'global',
            }),
          ).rag,
        );
      const [first, second] = handles;
      const writer = second.writer?.();
      assert.ok(writer);
      value(await writer.upsertRaw('a', 'before', {}));
      assert.equal(value(await first.getById('a'))?.text, 'before');
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      value(await writer.upsertRaw('a', 'after', {}));
      assert.ok(first.list);
      assert.equal(
        value(await first.list({ includeText: true })).records[0].text,
        'after',
      );
      t.mock.timers.tick(100);
      assert.equal(value(await first.getById('a'))?.text, 'after');
    } finally {
      for (const provider of providers) provider.close();
      try {
        for (const table of tables.reverse())
          await client.query(`DROP TABLE IF EXISTS "${table}"`);
      } finally {
        await client.end();
      }
    }
  });
