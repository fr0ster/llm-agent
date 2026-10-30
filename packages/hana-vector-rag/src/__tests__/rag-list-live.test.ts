import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type RagError,
  type RagJsonValue,
  type Result,
  staticLogin,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import { ragListConformanceCases } from '@mcp-abap-adt/llm-agent/testing/rag-list-conformance';
import { createHanaClient, HanaVectorRag } from '../hana-vector-rag.js';
import { HanaVectorRagProvider } from '../hana-vector-rag-provider.js';
import { sharedLayoutSql } from '../shared-ddl.js';

function isJsonArray(value: RagJsonValue): value is readonly RagJsonValue[] {
  return Array.isArray(value);
}
function field(
  value: RagJsonValue | undefined,
  key: string,
): RagJsonValue | undefined {
  return value && typeof value === 'object' && !isJsonArray(value)
    ? value[key]
    : undefined;
}
function credentials() {
  const parsed: RagJsonValue = JSON.parse(process.env.VCAP_SERVICES ?? '{}');
  const hana = field(parsed, 'hana');
  assert.ok(hana && isJsonArray(hana));
  const binding = field(hana[0], 'credentials');
  const string = (key: string): string => {
    const result = field(binding, key);
    assert.equal(typeof result, 'string');
    assert.ok(typeof result === 'string');
    return result;
  };
  const port = field(binding, 'port');
  assert.ok(typeof port === 'string' || typeof port === 'number');
  return {
    host: string('host'),
    schema: string('schema'),
    user: string('user'),
    password: string('password'),
    port,
  };
}

function value<T>(result: Result<T, RagError>): T {
  if (!result.ok) throw result.error;
  return result.value;
}
const embedder = symmetricEmbedder({
  embed: async () => ({ vector: [1, 0, 0] }),
});
// Explicit opt-in: creates and removes only uniquely named test tables; requires DDL rights.
for (const layout of ['per-collection', 'shared'] as const)
  test(`Hana live listing/cache (${layout})`, {
    skip:
      process.env.RAG_SQL_LISTING_INTEGRATION !== '1' ||
      !process.env.VCAP_SERVICES,
  }, async (t) => {
    const binding = credentials();
    const connection = {
      collectionName: 'unused',
      host: binding.host,
      port: Number(binding.port),
      schema: binding.schema,
      credential: staticLogin(binding.user, binding.password),
      dimension: 3,
    };
    const client = await createHanaClient(connection);
    const suffix = `rl_${Date.now()}_${layout === 'shared' ? 's' : 'p'}`;
    const documentsTable = `${suffix}_docs`;
    const catalogTable = `${suffix}_catalog`;
    const tables: string[] = [];
    const stores: string[] = [];
    let sequence = 0;
    const providers: HanaVectorRagProvider[] = [];
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
          await client.exec(sql);
      }
      const makeStore = async () => {
        const collectionName = `${suffix}_${sequence++}`;
        const store = new HanaVectorRag(
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
          new HanaVectorRagProvider({
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
          await client.exec(`DROP TABLE IF EXISTS "${table}"`);
      } finally {
        await client.close();
      }
    }
  });
