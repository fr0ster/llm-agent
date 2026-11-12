import { randomUUID } from 'node:crypto';
import { staticLogin, symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import { createPgClient } from '../pg-vector-rag.js';
import { PgVectorRagProvider } from '../pg-vector-rag-provider.js';
import { sharedLayoutSql } from '../shared-ddl.js';

export async function accessFixture(
  layout: 'per-collection' | 'shared' = 'per-collection',
) {
  const url = new URL(process.env.PG_TEST_URL ?? '');
  const credential = staticLogin(
    decodeURIComponent(url.username),
    decodeURIComponent(url.password),
  );
  url.username = '';
  url.password = '';
  const connection = {
    collectionName: 'unused',
    connectionString: url.href,
    credential,
    poolMax: 1,
  };
  const client = await createPgClient(connection);
  const schema = `access_${randomUUID().replaceAll('-', '')}`;
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}", public`);
  if (layout === 'shared')
    await client.query(sharedLayoutSql({ dimension: 3 }));
  const embedder = symmetricEmbedder({
    embed: async () => ({ vector: [1, 0, 0] }),
  });
  const provider = new PgVectorRagProvider({
    name: 'pg',
    layout,
    connection: { collectionName: 'unused', schema, dimension: 3 },
    embedder,
    clientFactory: () => client,
  });
  return {
    client,
    provider,
    embedder,
    connection: { ...connection, schema, dimension: 3 },
    async close() {
      provider.close();
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await client.end();
    },
  };
}
