import { describe, it } from 'node:test';
import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  CONFORMANCE_EMBEDDING_DIM,
  conformanceEmbedder,
  ragFilterConformanceCases,
} from '@mcp-abap-adt/llm-agent/testing/rag-filter-conformance';
import { PgVectorRag } from '../pg-vector-rag.js';
import { storingPg } from './storing-pg.js';

// The shared conformance kit over PgVectorRag, against a fake that evaluates
// the emitted WHERE with Postgres semantics. The same cases run live against
// pgvector in the release check.
describe('PgVectorRag — filter conformance (storing fake)', () => {
  for (const c of ragFilterConformanceCases) {
    it(c.name, () =>
      c.run(
        async () =>
          new PgVectorRag(
            {
              collectionName: 'docs',
              dimension: CONFORMANCE_EMBEDDING_DIM,
              embedder: symmetricEmbedder(conformanceEmbedder()),
            },
            storingPg(),
          ),
      ),
    );
  }
});
