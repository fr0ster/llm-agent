import { describe, it } from 'node:test';
import { staticLogin, symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  CONFORMANCE_EMBEDDING_DIM,
  conformanceEmbedder,
} from '@mcp-abap-adt/llm-agent/testing/rag-filter-conformance';
import {
  type SharedTableSubject,
  sharedTableConformanceCases,
} from '@mcp-abap-adt/llm-agent/testing/shared-table-conformance';
import { HanaVectorRag } from '../hana-vector-rag.js';
import { HanaVectorRagProvider } from '../hana-vector-rag-provider.js';
import { storingHana } from './storing-hana.js';

function subject(): SharedTableSubject {
  const hana = storingHana({ dimension: CONFORMANCE_EMBEDDING_DIM });
  const embedder = symmetricEmbedder(conformanceEmbedder());
  const connection = {
    collectionName: '__unused',
    dimension: CONFORMANCE_EMBEDDING_DIM,
    credential: staticLogin('u', 'p'),
  };
  return {
    async openStore(collection) {
      return new HanaVectorRag(
        {
          ...connection,
          collectionName: collection,
          layout: 'shared',
          embedder,
        },
        hana.client,
      );
    },
    async provider() {
      return new HanaVectorRagProvider({
        name: 'hana',
        embedder,
        connection,
        layout: 'shared',
        clientFactory: () => hana.client,
      });
    },
    async rawInsert(collection, id, text) {
      const { vector } = await conformanceEmbedder().embed(text);
      hana.insertRow('RAG_DOCUMENTS', {
        COLLECTION: collection,
        ID: id,
        TEXT: text,
        VECTOR: vector,
        METADATA: '{}',
      });
    },
  };
}

// The shared-table kit over the shared layout, against a fake that stores the
// rows of both shared tables and evaluates the statements the way HANA does.
// The pg-vector package runs the same cases.
describe('HanaVectorRag — shared-table conformance (storing fake)', () => {
  for (const c of sharedTableConformanceCases) {
    it(c.name, () => c.run(async () => subject()));
  }
});
