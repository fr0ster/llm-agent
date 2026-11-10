import { test } from 'node:test';
import { staticLogin, symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  CONFORMANCE_EMBEDDING_DIM,
  conformanceEmbedder,
  ragFilterConformanceCases,
  ragOwnerFilterConformanceCases,
} from '@mcp-abap-adt/llm-agent/testing/rag-filter-conformance';
import { HanaVectorRag } from '../hana-vector-rag.js';
import { storingHana } from './storing-hana.js';

for (const layout of ['per-collection', 'shared'] as const)
  for (const entry of [
    ...ragFilterConformanceCases,
    ...ragOwnerFilterConformanceCases,
  ])
    test(`HANA ${layout} ${entry.name}`, () =>
      entry.run(async () => {
        const db = storingHana({ dimension: CONFORMANCE_EMBEDDING_DIM });
        if (layout === 'per-collection') db.createCollectionTable('docs');
        return new HanaVectorRag(
          {
            collectionName: 'docs',
            layout,
            dimension: CONFORMANCE_EMBEDDING_DIM,
            autoCreateSchema: false,
            credential: staticLogin('u', 'p'),
            embedder: symmetricEmbedder(conformanceEmbedder()),
          },
          db.client,
        );
      }));
