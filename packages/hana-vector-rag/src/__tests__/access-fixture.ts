import { staticLogin, symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import { HanaVectorRagProvider } from '../hana-vector-rag-provider.js';
import { storingHana } from './storing-hana.js';

export function accessFixture(
  layout: 'per-collection' | 'shared' = 'per-collection',
) {
  const db = storingHana({
    dimension: 3,
    catalogTable: 'rag_collection_catalog',
    legacyCatalog: true,
  });
  const provider = new HanaVectorRagProvider({
    name: 'hana',
    defaultDimension: 3,
    layout,
    catalogTable: 'rag_collection_catalog',
    connection: { collectionName: 'unused', credential: staticLogin('u', 'p') },
    embedder: symmetricEmbedder({ embed: async () => ({ vector: [1, 0, 0] }) }),
    clientFactory: () => db.client,
  });
  return { db, provider };
}
