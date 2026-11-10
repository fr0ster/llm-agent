import { describe, it } from 'node:test';
import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  CONFORMANCE_EMBEDDING_DIM,
  conformanceEmbedder,
  ragFilterConformanceCases,
  ragOwnerFilterConformanceCases,
} from '@mcp-abap-adt/llm-agent/testing/rag-filter-conformance';
import { PgVectorRag } from '../pg-vector-rag.js';
import { sharedLayoutSql } from '../shared-ddl.js';
import { accessFixture } from './access-fixture.js';
import { storingPg } from './storing-pg.js';

// The shared conformance kit over PgVectorRag, against a fake that evaluates
// the emitted WHERE with Postgres semantics. The same cases run live against
// pgvector in the release check.
describe('PgVectorRag — filter conformance (storing fake)', () => {
  for (const c of [
    ...ragFilterConformanceCases,
    ...ragOwnerFilterConformanceCases,
  ]) {
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

describe('PgVectorRag — filter conformance, shared layout (storing fake)', () => {
  for (const c of [
    ...ragFilterConformanceCases,
    ...ragOwnerFilterConformanceCases,
  ]) {
    it(c.name, () =>
      c.run(
        async () =>
          new PgVectorRag(
            {
              collectionName: 'docs',
              dimension: CONFORMANCE_EMBEDDING_DIM,
              layout: 'shared',
              embedder: symmetricEmbedder(conformanceEmbedder()),
            },
            storingPg({ sharedDimension: CONFORMANCE_EMBEDDING_DIM }),
          ),
      ),
    );
  }
});

for (const layout of ['shared', 'per-collection'] as const)
  for (const entry of ragOwnerFilterConformanceCases)
    it(`PG live ${layout} ${entry.name}`, {
      skip: !process.env.PG_TEST_URL,
    }, async () => {
      const f = await accessFixture();
      try {
        await f.client.query('CREATE EXTENSION IF NOT EXISTS vector');
        for (const statement of sharedLayoutSql({
          dimension: CONFORMANCE_EMBEDDING_DIM,
        })
          .split(';')
          .filter((sql) => sql.trim()))
          await f.client.query(statement);
        await entry.run(async () => {
          const rag = new PgVectorRag(
            {
              collectionName: 'docs',
              layout,
              dimension: CONFORMANCE_EMBEDDING_DIM,
              embedder: symmetricEmbedder(conformanceEmbedder()),
            },
            f.client,
          );
          if (layout === 'per-collection') await rag.ensureSchema();
          return rag;
        });
      } finally {
        await f.close();
      }
    });
