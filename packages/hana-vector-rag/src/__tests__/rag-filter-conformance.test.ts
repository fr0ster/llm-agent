import { test } from 'node:test';
import { staticLogin, symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  CONFORMANCE_EMBEDDING_DIM,
  conformanceEmbedder,
  ragFilterConformanceCases,
  ragOwnerFilterConformanceCases,
  ragRawOwnerConformanceCase,
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

for (const layout of ['shared', 'per-collection'] as const)
  test(`HANA ${layout} shared raw conflicting-owner records are excluded and writes refused`, async () => {
    const db = storingHana({ dimension: 64 });
    if (layout === 'per-collection') db.createCollectionTable('raw');
    const rag = new HanaVectorRag(
      {
        collectionName: 'raw',
        layout,
        dimension: 64,
        autoCreateSchema: false,
        credential: staticLogin('u', 'p'),
        embedder: symmetricEmbedder(conformanceEmbedder()),
      },
      db.client,
    );
    await ragRawOwnerConformanceCase({
      rag,
      async insertRaw(r) {
        db.insertRow(layout === 'shared' ? 'RAG_DOCUMENTS' : 'raw', {
          ...(layout === 'shared' ? { COLLECTION: 'raw' } : {}),
          ID: r.id,
          TEXT: r.text,
          VECTOR: (await conformanceEmbedder().embed(r.text)).vector,
          METADATA: JSON.stringify({ ...r.metadata, id: r.id }),
        });
      },
    });
  });
