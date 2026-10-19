import { describe, it } from 'node:test';
import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  CONFORMANCE_EMBEDDING_DIM,
  conformanceEmbedder,
} from '@mcp-abap-adt/llm-agent/testing/rag-filter-conformance';
import {
  type SharedTableSubject,
  sharedTableConformanceCases,
} from '@mcp-abap-adt/llm-agent/testing/shared-table-conformance';
import { PgVectorRag } from '../pg-vector-rag.js';
import { PgVectorRagProvider } from '../pg-vector-rag-provider.js';
import { storingPg } from './storing-pg.js';

function subject(): SharedTableSubject {
  const client = storingPg({ sharedDimension: CONFORMANCE_EMBEDDING_DIM });
  const embedder = symmetricEmbedder(conformanceEmbedder());
  return {
    async openStore(collection) {
      return new PgVectorRag(
        {
          collectionName: collection,
          dimension: CONFORMANCE_EMBEDDING_DIM,
          layout: 'shared',
          embedder,
        },
        client,
      );
    },
    async provider() {
      return new PgVectorRagProvider({
        name: 'pg',
        embedder,
        connection: {
          collectionName: '__unused',
          dimension: CONFORMANCE_EMBEDDING_DIM,
        },
        layout: 'shared',
        clientFactory: () => client,
      });
    },
    async rawInsert(collection, id, text) {
      const { vector } = await conformanceEmbedder().embed(text);
      client.insertSharedRow({ collection, id, text, vector, metadata: {} });
    },
  };
}

// The shared-table kit over the shared layout, against a fake that stores the
// rows of both shared tables and answers PgVectorRag's statements with
// Postgres semantics. The HANA package runs the same cases.
describe('PgVectorRag — shared-table conformance (storing fake)', () => {
  for (const c of sharedTableConformanceCases) {
    it(c.name, () => c.run(async () => subject()));
  }
});
